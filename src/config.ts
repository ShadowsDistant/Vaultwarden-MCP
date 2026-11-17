import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// NOT under AppData: Claude Desktop is an MSIX package, so anything it (or a child process)
// writes under AppData\Local is silently redirected into the package's LocalCache. The
// user-profile root is shared and stable. It is also outside OneDrive, which must never
// sync a vault database.
const home = process.env.VW_MCP_HOME ?? path.join(os.homedir(), '.vaultwarden-mcp');
const here = path.dirname(fileURLToPath(import.meta.url));

/** Where `bw` keeps data.json (auth tokens, the encrypted vault cache). */
const bwDataDir = path.join(home, 'bw');

/**
 * The bundled Bitwarden CLI. It is a webpack CJS bundle, so it is run as
 * `<node> <bw.js>` — never through the `bw.cmd` shim, because this machine's system PATH
 * contains an unbalanced quote that breaks any cmd.exe batch file.
 */
function findBwJs(): string {
  if (process.env.VW_MCP_BW_PATH) return process.env.VW_MCP_BW_PATH;
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@bitwarden/cli/build/bw.js');
  } catch {
    // Packed layouts keep node_modules a level above dist/.
    const guess = path.resolve(here, '..', 'node_modules', '@bitwarden', 'cli', 'build', 'bw.js');
    return fs.existsSync(guess) ? guess : '';
  }
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function flag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Variables that `VW_MCP_BW_ENV` may never set on the CLI child.
 *
 * The child's environment is built from scratch precisely so that `NODE_OPTIONS` cannot slip a
 * preload script into the process holding the vault key. An escape hatch that could put it
 * straight back would undo that, so these are refused whatever the hatch says. So are the
 * variables this server owns: the session key and where the CLI keeps its data.
 */
const BW_ENV_DENY = /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|ELECTRON_RUN_AS_NODE|BW_SESSION|BITWARDENCLI_APPDATA_DIR|BW_NOINTERACTION|PATH|PATHEXT|COMSPEC)$/i;

/** What the product is called wherever a person reads it. */
export const PRODUCT = 'Bitwarden MCP';

export const CONFIG = {
  home,
  bwDataDir,
  bwJs: findBwJs(),
  /** Node used to run bw in process mode. Inside Claude Desktop there is none; see noderun.ts. */
  nodeExe: process.env.VW_MCP_NODE_PATH ?? process.execPath,
  configFile: path.join(home, 'config.json'),
  /** Behaviour and permissions, written by the Settings app. See settings.ts. */
  settingsFile: path.join(home, 'settings.json'),
  /** What the server last reported about itself, for the Settings app to show. */
  statusFile: path.join(home, 'status.json'),
  logFile: process.env.VW_MCP_LOG_FILE ?? path.join(home, 'logs', 'server.log'),
  /** Allow a plain-http server URL for hosts other than localhost. */
  allowHttp: flag('VW_MCP_ALLOW_HTTP'),
  /** Extra CA bundle for a self-hosted instance behind a private CA. */
  caFile: process.env.VW_MCP_CA_FILE ?? '',
  /**
   * Extra environment for the CLI child only, as a JSON object. The child's environment is
   * built from scratch rather than inherited, which is deliberate, but a self-hosted setup
   * sometimes needs one more variable reaching the CLI and nothing else. Names in
   * `BW_ENV_DENY` are dropped.
   */
  bwEnv: ((): Record<string, string> => {
    const raw = process.env.VW_MCP_BW_ENV;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && !BW_ENV_DENY.test(k)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  })(),
  /** Override the native dialog command (tests point this at a scripted stand-in). */
  promptCmd: process.env.VW_MCP_PROMPT_CMD ?? '',
  /** Override the clipboard helper (tests point this at a stand-in). */
  clipboardCmd: process.env.VW_MCP_CLIPBOARD_CMD ?? '',
  /** Lifetime of a pending create/edit/delete action or draft. */
  pendingTtlMs: num('VW_MCP_PENDING_TTL_MS', 10 * 60_000),
  /**
   * Where the dialog and clipboard helpers live. A packed extension ships only dist/, so the
   * build copies them to dist/scripts; a source checkout has them one level up. Whichever
   * exists wins, and the first is checked first so a packed build never reaches outside
   * itself.
   */
  scriptsDir: [path.join(here, 'scripts'), path.resolve(here, '..', 'scripts')].find((p) => fs.existsSync(p)) ?? path.resolve(here, '..', 'scripts'),
  powershell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  uiUri: 'ui://vaultwarden/card.html',
  /** Shared, DPAPI-protected copy of the session key, so every server process shares one unlock. */
  sessionFile: path.join(home, 'session.json'),
  /** Touched on vault activity, so an idle lock in one process sees activity in another. */
  activityFile: path.join(home, 'activity'),
  /** The activity log the Settings app shows: one JSON object per line, never a secret. */
  activityLogFile: path.join(home, 'activity.jsonl'),
  /** A request from the server to the Settings app: which page to open. */
  launchRequestFile: path.join(home, 'launch-request.json'),
  /** Update check results, shared with the Settings app. */
  updateFile: path.join(home, 'update.json'),
  /** Where the server keeps a stable copy of the Settings app, so shortcuts survive updates. */
  appDir: path.join(home, 'app'),
};

export type StoredConfig = {
  /**
   * Vault server URL, e.g. https://vault.bitwarden.com. Set in the Settings app or at install
   * time, never by the model.
   */
  serverUrl?: string;
  /** Account email, used to pre-fill sign-in. */
  email?: string;
};

/** A byte-order mark, which an editor may prepend and which JSON.parse rejects. */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

let cached: StoredConfig | null = null;
let cachedStamp = '';

function configStamp(): string {
  try {
    const st = fs.statSync(CONFIG.configFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/**
 * The vault address and account, re-read whenever the file changes: the Settings app writes it
 * while the server is running, during first-time setup.
 */
export function readConfig(): StoredConfig {
  const stamp = configStamp();
  if (cached && stamp === cachedStamp) return cached;
  cachedStamp = stamp;
  try {
    const raw = fs.readFileSync(CONFIG.configFile, 'utf8').replace(BOM, '');
    const parsed = JSON.parse(raw) as StoredConfig;
    cached = {
      serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl.trim() ? parsed.serverUrl.trim() : undefined,
      email: typeof parsed.email === 'string' && parsed.email.trim() ? parsed.email.trim() : undefined,
    };
  } catch {
    cached = {};
  }
  // Environment wins: it is how a hand-written MCP config pins the instance, and neither the
  // model nor vault content can reach it.
  if (process.env.VW_MCP_SERVER_URL?.trim()) cached.serverUrl = process.env.VW_MCP_SERVER_URL.trim();
  if (process.env.VW_MCP_EMAIL?.trim()) cached.email = process.env.VW_MCP_EMAIL.trim();
  return cached;
}

/** True when the install's environment fixes the vault address, so it cannot be changed here. */
export function serverUrlFixedByEnv(): boolean {
  return Boolean(process.env.VW_MCP_SERVER_URL?.trim());
}

/** Writes config.json atomically, keeping keys this version does not know about. */
export function writeConfig(next: StoredConfig): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8').replace(BOM, '')) as Record<string, unknown>;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
  } catch {
    existing = {};
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) merged[k] = v;
  fs.mkdirSync(path.dirname(CONFIG.configFile), { recursive: true });
  const tmp = `${CONFIG.configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG.configFile);
  cached = null;
}

/**
 * A vault URL is only acceptable over TLS. Loopback is exempted because a server on
 * the same machine over plain http never crosses a network.
 */
export function validateServerUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'Not a valid URL. Use the full address, e.g. https://vault.example.com' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https URLs are supported.' };
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback && !CONFIG.allowHttp) {
    return { error: 'Refusing a plain-http server URL. Use https, or set VW_MCP_ALLOW_HTTP=1 if this is a trusted local network.' };
  }
  if (u.username || u.password) return { error: 'The URL must not contain credentials.' };
  return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')) };
}

/**
 * Splits a command override into program plus arguments. A JSON array is accepted so a path
 * containing spaces survives; otherwise the string is split on spaces, with double-quoted
 * runs kept together.
 */
export function parseCommand(spec: string): { cmd: string; args: string[] } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    try {
      const parts = JSON.parse(trimmed) as unknown[];
      const strings = parts.map(String).filter(Boolean);
      if (!strings.length) return null;
      return { cmd: strings[0], args: strings.slice(1) };
    } catch {
      return null;
    }
  }
  const parts = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const cleaned = parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p)).filter(Boolean);
  if (!cleaned.length) return null;
  return { cmd: cleaned[0], args: cleaned.slice(1) };
}

export function ensureHome(): void {
  fs.mkdirSync(bwDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
}
