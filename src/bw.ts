import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { CONFIG } from './config.js';
import { log } from './log.js';

/**
 * The Bitwarden CLI, wrapped.
 *
 * Three rules hold everywhere in this file:
 *  - No secret is ever an argv element. Passwords go in via `--passwordenv` (the child's own
 *    environment), item JSON goes in over stdin. argv is visible to every process on the
 *    machine and lands in command-line audit logs; environment blocks and pipes do not.
 *  - Every call is serialised. `bw` rewrites data.json on each invocation, including reads,
 *    and two concurrent writers corrupt it.
 *  - stdout is parsed whatever the exit code is. `bw status` exits 1 while printing valid
 *    JSON when the server is unreachable (bitwarden/clients#18373).
 */

export type BwErrorCode =
  | 'no_cli'
  | 'not_logged_in'
  | 'locked'
  | 'invalid_password'
  | 'two_factor_required'
  | 'not_found'
  | 'ambiguous'
  | 'already_logged_in'
  | 'network'
  | 'timeout'
  | 'unknown';

export class BwError extends Error {
  constructor(
    public code: BwErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'BwError';
  }
}

export type BwResult<T = unknown> = { success: boolean; data?: T; message?: string };

type RunOptions = {
  /** Extra environment for this one child only (BW_SESSION, VW_MCP_PW, BW_CLIENTID…). */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. Used for base64 item JSON. */
  stdin?: string;
  timeoutMs?: number;
  /** Ask for `--response`, the JSON envelope. Off for `--raw` reads. */
  response?: boolean;
  /** Ask for `--raw`: the bare value on stdout, no envelope and no trailing newline. */
  raw?: boolean;
};

/**
 * Serialises every invocation: `bw` rewrites data.json on each call, including reads, and
 * two at once corrupt it.
 *
 * The lock is re-entrant by way of an async-local flag rather than a plain queue. A
 * multi-step operation such as sign-in — status, then unlock, then a decrypt to prove the
 * unlock took — wants to hold the CLI for its whole sequence, and each of those steps calls
 * `bw()`, which takes the lock itself. A non-re-entrant queue deadlocks the moment the outer
 * hold meets the inner one.
 */
let chain: Promise<unknown> = Promise.resolve();
const held = new AsyncLocalStorage<true>();

export function withBwLock<T>(body: () => Promise<T>): Promise<T> {
  if (held.getStore()) return body();
  const run = () => held.run(true, body);
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The child's environment, built from scratch rather than inherited. Anything not listed
 * here (NODE_OPTIONS above all, which can inject a --require preload into the process that
 * holds the vault key) does not reach the CLI.
 */
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const pass = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of pass) if (process.env[k]) env[k] = process.env[k];
  // The machine PATH here carries an unbalanced quote; strip quotes and empties so nothing
  // downstream chokes on it.
  env.PATH = (process.env.PATH ?? '')
    .split(';')
    .map((p) => p.replace(/"/g, '').trim())
    .filter(Boolean)
    .join(';');
  env.BITWARDENCLI_APPDATA_DIR = CONFIG.bwDataDir;
  env.BW_NOINTERACTION = 'true';
  if (CONFIG.caFile) env.NODE_EXTRA_CA_CERTS = CONFIG.caFile;
  // Per-install additions come after the defaults so they can override one, and before the
  // per-call secrets so they can never displace a session key or a password.
  return { ...env, ...CONFIG.bwEnv, ...extra };
}

function classify(text: string, exitCode: number | null): BwError {
  const t = text.toLowerCase();
  if (/you are not logged in|not logged in/.test(t)) {
    return new BwError('not_logged_in', 'Not signed in to the vault.', 'Use vault_login.');
  }
  if (/vault is locked|master password is required|session key is invalid|invalid session/.test(t)) {
    return new BwError('locked', 'The vault is locked.', 'Use vault_unlock.');
  }
  if (/invalid master password|username or password is incorrect/.test(t)) {
    return new BwError('invalid_password', 'That master password was not accepted.');
  }
  if (/two-step|two factor|code is required|totp/.test(t) && /required|invalid/.test(t)) {
    return new BwError('two_factor_required', 'This account needs a two-step login code.');
  }
  if (/not found|could not find/.test(t)) return new BwError('not_found', 'No such item.');
  if (/more than one result|multiple/.test(t)) {
    return new BwError('ambiguous', 'That matched more than one item.', 'Search first and pass an item id.');
  }
  if (/you are already logged in/.test(t)) return new BwError('already_logged_in', 'Already signed in.');
  if (/enotfound|econnrefused|etimedout|certificate|self.signed|unable to fetch|fetch failed|network/.test(t)) {
    return new BwError('network', 'Could not reach the vault server.', 'Check the server URL and that the instance is up.');
  }
  return new BwError('unknown', text.trim().split('\n')[0]?.slice(0, 300) || `bw exited with code ${exitCode}`);
}

/**
 * Unwraps the CLI's typed response objects. `--response` does not hand back the value
 * directly: a list arrives as `{object:'list', data:[…]}`, a status as
 * `{object:'template', template:{…}}`, a generated password as `{object:'string', data:'…'}`.
 * Verified against @bitwarden/cli 2026.8.0 rather than assumed.
 */
function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  switch (v.object) {
    case 'list':
      return Array.isArray(v.data) ? v.data : value;
    case 'template':
      return 'template' in v ? v.template : value;
    case 'string':
      return v.data;
    default:
      return value;
  }
}

function firstJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const start = trimmed.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return undefined;
  }
}

/** Runs bw once. Callers must already hold the lock (use `bw()` unless composing). */
function runOnce(args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (!CONFIG.bwJs) {
    return Promise.reject(new BwError('no_cli', 'The Bitwarden CLI is not installed.', 'Reinstall the server, or set VW_MCP_BW_PATH to a bw executable.'));
  }
  const argv = [CONFIG.bwJs, ...args, '--nointeraction'];
  // Exactly one output mode. `--raw` gives the bare value with no trailing newline, which is
  // what a password read needs; `--response` gives the JSON envelope for everything else.
  if (opts.raw) argv.push('--raw');
  else if (opts.response) argv.push('--response');
  return new Promise((resolve, reject) => {
    const child = execFile(
      CONFIG.nodeExe,
      argv,
      {
        env: childEnv(opts.env),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean })?.killed;
        const code = (err as NodeJS.ErrnoException & { code?: number })?.code ?? 0;
        if (killed) {
          reject(new BwError('timeout', 'The Bitwarden CLI did not respond in time.'));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : err ? 1 : 0 });
      },
    );
    if (child.stdin) {
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      // readStdin() in the CLI waits for `end`; without this the process hangs forever.
      child.stdin.end();
    }
  });
}

/**
 * Runs bw and returns parsed JSON (`--response` envelope unwrapped), or throws BwError.
 * `raw: true` returns stdout verbatim instead — used for the session key, which must not
 * pass through a JSON round trip.
 */
export async function bw<T = unknown>(args: string[], opts: RunOptions = {}): Promise<T> {
  return withBwLock(async () => {
    const t0 = Date.now();
    const { stdout, stderr, code } = await runOnce(args, { ...opts, response: opts.response ?? !opts.raw });
    // `exit` rather than `code`: the log scrubs any field called `code`, since that is what a
    // two-step login code would be called, and an exit status redacted to nothing is useless.
    log.info(`bw ${args[0]}${args[1] && !args[1].startsWith('-') ? ' ' + args[1] : ''}`, { ms: Date.now() - t0, exit: code });

    if (opts.raw) {
      if (code !== 0) throw classify(stderr || stdout, code);
      return stdout as unknown as T;
    }

    // Parse first, judge second: `bw status` prints good JSON and exits 1 when offline.
    const parsed = firstJson(stdout) as BwResult<T> | undefined;
    if (parsed && typeof parsed === 'object' && 'success' in parsed) {
      if (parsed.success) return unwrap(parsed.data) as T;
      throw classify(parsed.message ?? stderr ?? '', code);
    }
    if (parsed !== undefined && code === 0) return unwrap(parsed) as T;
    throw classify(stderr || stdout, code);
  });
}

/** `bw <args>` with a pre-checked CLI. Returns the version string. */
export async function bwVersion(): Promise<string> {
  if (!CONFIG.bwJs || !fs.existsSync(CONFIG.bwJs)) {
    throw new BwError('no_cli', 'The Bitwarden CLI is not installed.', 'Reinstall the server, or set VW_MCP_BW_PATH.');
  }
  const out = await bw<string>(['--version'], { raw: true, timeoutMs: 30_000 });
  return String(out).trim();
}
