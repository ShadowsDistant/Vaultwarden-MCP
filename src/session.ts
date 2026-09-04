import { bw, BwError, withBwLock } from './bw.js';
import { CONFIG, readConfig, validateServerUrl } from './config.js';
import { log } from './log.js';
import { prompt, PromptError } from './prompt.js';
import { clearAll as clearPending } from './pending.js';

/**
 * Ownership of the unlocked vault.
 *
 * The session key lives here, in memory, and nowhere else: not on disk, not in an argv, not
 * in any MCP message. It is handed to `bw` one child process at a time through that child's
 * environment, and it is dropped when the vault locks — on request, after a stretch of
 * inactivity, or when the process ends.
 */

export type VaultState = 'no_cli' | 'unconfigured' | 'unauthenticated' | 'locked' | 'unlocked';

export type Status = {
  state: VaultState;
  /** Host only. The full URL is configuration, not something the model needs. */
  serverHost?: string;
  email?: string;
  lastSync?: string;
  idleLockMinutes: number;
  /** Seconds until the idle lock fires, when one is armed. */
  locksInSeconds?: number;
};

type BwStatus = {
  serverUrl?: string | null;
  lastSync?: string | null;
  userEmail?: string | null;
  userId?: string | null;
  status?: 'unauthenticated' | 'locked' | 'unlocked';
};

let sessionKey: string | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lastActivity = 0;

/** The env fragment every vault operation needs. Empty when locked. */
export function sessionEnv(): Record<string, string> {
  return sessionKey ? { BW_SESSION: sessionKey } : {};
}

export function isUnlocked(): boolean {
  return sessionKey !== null;
}

export function touch(): void {
  if (!sessionKey) return;
  lastActivity = Date.now();
  armIdleTimer();
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!sessionKey || CONFIG.idleLockMinutes <= 0) return;
  const ms = CONFIG.idleLockMinutes * 60_000;
  const due = lastActivity + ms - Date.now();
  idleTimer = setTimeout(() => {
    void (async () => {
      // Re-check: a call that landed while the timer was pending pushes the deadline out.
      if (!sessionKey) return;
      if (Date.now() - lastActivity < ms - 500) {
        armIdleTimer();
        return;
      }
      log.audit('idle_lock', { afterMinutes: CONFIG.idleLockMinutes });
      await lock().catch(() => undefined);
    })();
  }, Math.max(1000, due));
  idleTimer.unref?.();
}

export function locksInSeconds(): number | undefined {
  if (!sessionKey || CONFIG.idleLockMinutes <= 0) return undefined;
  const left = lastActivity + CONFIG.idleLockMinutes * 60_000 - Date.now();
  return Math.max(0, Math.round(left / 1000));
}

function hostOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Raw `bw status`. Tolerates the CLI exiting 1 while printing valid JSON when offline. */
async function rawStatus(): Promise<BwStatus> {
  try {
    return await bw<BwStatus>(['status'], { env: sessionEnv(), timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof BwError && e.code === 'network') return {};
    throw e;
  }
}

/**
 * The state of the vault as this server understands it.
 *
 * `bw status` is not trusted for "unlocked": it has reported an unlocked vault that then
 * refuses to decrypt (bitwarden/clients#20703). This server's own session key is the
 * authority, and `verifyUnlocked` proves it with a real decrypt.
 */
export async function status(): Promise<Status> {
  if (!CONFIG.bwJs) return { state: 'no_cli', idleLockMinutes: CONFIG.idleLockMinutes };
  const cfg = readConfig();
  const s = await rawStatus();
  const configured = Boolean(cfg.serverUrl ?? s.serverUrl);
  const serverHost = hostOf(cfg.serverUrl ?? s.serverUrl);
  const email = s.userEmail ?? cfg.email ?? undefined;
  const base = {
    serverHost,
    email: email ?? undefined,
    lastSync: s.lastSync ?? undefined,
    idleLockMinutes: CONFIG.idleLockMinutes,
    locksInSeconds: locksInSeconds(),
  };
  if (!configured) return { state: 'unconfigured', ...base };
  if (s.status === 'unauthenticated' || !s.userId) return { state: 'unauthenticated', ...base };
  if (sessionKey) return { state: 'unlocked', ...base };
  return { state: 'locked', ...base };
}

/** Proves the session key really decrypts. Cheap, and the only reliable unlock test. */
async function verifyUnlocked(): Promise<boolean> {
  try {
    await bw<unknown[]>(['list', 'folders'], { env: sessionEnv(), timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Pushes the configured server URL into the CLI. Only ever called with install-time config. */
export async function applyServerUrl(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.serverUrl) return;
  const checked = validateServerUrl(cfg.serverUrl);
  if ('error' in checked) throw new BwError('unknown', `Configured server URL is not usable: ${checked.error}`);
  const s = await rawStatus();
  if (s.serverUrl === checked.url) return;
  if (s.status && s.status !== 'unauthenticated') {
    // bw refuses a server change while signed in, and silently changing it under a signed-in
    // account would be the start of a credential-relay attack anyway.
    log.warn('server URL differs from the CLI but an account is signed in; leaving it alone');
    return;
  }
  await bw(['config', 'server', checked.url], { timeoutMs: 60_000 });
  log.audit('server_configured', { host: hostOf(checked.url) });
}

type UnlockOutcome = { ok: true } | { ok: false; reason: 'cancelled' | 'timeout' | 'bad_password' | 'unavailable' };

/**
 * Asks for the master password in a native window and unlocks.
 *
 * The dialog is opened outside the bw lock on purpose: it can sit on screen for minutes, and
 * holding the lock would freeze every other vault operation behind it.
 */
export async function unlock(): Promise<UnlockOutcome> {
  const st = await status();
  if (st.state === 'unlocked') return { ok: true };
  if (st.state === 'unauthenticated') throw new BwError('not_logged_in', 'Not signed in.', 'Use vault_login first.');

  const answer = await prompt({
    kind: 'form',
    title: 'Unlock your vault',
    message: `Enter the master password for ${st.email ?? 'your account'}${st.serverHost ? ` at ${st.serverHost}` : ''}. Claude never sees what you type here.`,
    fields: [{ name: 'password', label: 'Master password', secret: true }],
    confirmLabel: 'Unlock',
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  const password = answer.values.password ?? '';
  if (!password) return { ok: false, reason: 'cancelled' };

  return withBwLock(async () => {
    const key = await unlockWith(password);
    if (!key) return { ok: false, reason: 'bad_password' as const };
    sessionKey = key;
    lastActivity = Date.now();
    armIdleTimer();
    log.audit('unlocked', { host: st.serverHost });
    return { ok: true as const };
  });
}

/**
 * One unlock attempt, plus the retry that works around a CLI bug where the first unlock
 * after a fresh login returns an empty session key (bitwarden/clients#18455). Locking and
 * asking again clears it.
 */
async function unlockWith(password: string): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const data = await bw<{ raw?: string }>(['unlock', '--passwordenv', 'VW_MCP_PW'], {
        env: { VW_MCP_PW: password },
        timeoutMs: 90_000,
      });
      const key = typeof data?.raw === 'string' ? data.raw.trim() : '';
      return key || null;
    } catch (e) {
      if (e instanceof BwError && e.code === 'invalid_password') return null;
      throw e;
    }
  };

  let key = await attempt();
  if (!key) {
    await bw(['lock'], { timeoutMs: 30_000 }).catch(() => undefined);
    key = await attempt();
  }
  if (!key) return null;
  sessionKey = key;
  const good = await verifyUnlocked();
  sessionKey = null;
  return good ? key : null;
}

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'bad_password' | 'two_factor' | 'unavailable'; message?: string };

/**
 * Signs in, then unlocks, using one dialog for both. A password login returns a session key
 * directly, so a second master-password prompt would be pure friction.
 */
export async function login(): Promise<LoginOutcome> {
  const cfg = readConfig();
  const st = await status();
  if (st.state === 'unconfigured') {
    throw new BwError('unknown', 'No vault server is configured.', 'Set VW_MCP_SERVER_URL (or run the installer) and restart.');
  }
  if (st.state === 'locked' || st.state === 'unlocked') {
    const r = await unlock();
    return r.ok ? { ok: true } : { ok: false, reason: r.reason === 'bad_password' ? 'bad_password' : r.reason };
  }

  await applyServerUrl();

  const answer = await prompt({
    kind: 'form',
    title: 'Sign in to your vault',
    message: `Signing in to ${st.serverHost ?? 'your vault'}. Claude never sees what you type here. Leave the code blank unless you use two-step login.`,
    fields: [
      { name: 'email', label: 'Email', value: cfg.email ?? st.email ?? '' },
      { name: 'password', label: 'Master password', secret: true },
      { name: 'code', label: 'Two-step code (optional)', optional: true },
    ],
    confirmLabel: 'Sign in',
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };

  const email = (answer.values.email ?? '').trim();
  const password = answer.values.password ?? '';
  const code = (answer.values.code ?? '').trim();
  if (!email || !password) return { ok: false, reason: 'cancelled' };

  const args = ['login', email, '--passwordenv', 'VW_MCP_PW'];
  if (code) args.push('--method', '0', '--code', code);

  return withBwLock(async () => {
    try {
      const data = await bw<{ raw?: string }>(args, { env: { VW_MCP_PW: password }, timeoutMs: 120_000 });
      const key = typeof data?.raw === 'string' ? data.raw.trim() : '';
      if (key) {
        sessionKey = key;
        if (!(await verifyUnlocked())) {
          sessionKey = null;
          const retry = await unlockWith(password);
          if (!retry) return { ok: false, reason: 'bad_password' };
          sessionKey = retry;
        }
      } else {
        const retry = await unlockWith(password);
        if (!retry) return { ok: false, reason: 'bad_password' };
        sessionKey = retry;
      }
      lastActivity = Date.now();
      armIdleTimer();
      log.audit('signed_in', { host: st.serverHost });
      return { ok: true };
    } catch (e) {
      if (e instanceof BwError) {
        if (e.code === 'two_factor_required') return { ok: false, reason: 'two_factor', message: e.message };
        if (e.code === 'invalid_password') return { ok: false, reason: 'bad_password', message: e.message };
      }
      throw e;
    }
  });
}

export async function lock(): Promise<void> {
  const had = sessionKey !== null;
  sessionKey = null;
  clearPending();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  await bw(['lock'], { timeoutMs: 30_000 }).catch(() => undefined);
  if (had) log.audit('locked');
}

export async function logout(): Promise<void> {
  sessionKey = null;
  clearPending();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  await bw(['logout'], { timeoutMs: 60_000 }).catch(() => undefined);
  log.audit('signed_out');
}

export async function sync(): Promise<string | undefined> {
  requireUnlocked();
  await bw(['sync'], { env: sessionEnv(), timeoutMs: 120_000 });
  touch();
  const s = await rawStatus();
  return s.lastSync ?? undefined;
}

/** Throws the error the tools turn into a "sign in first" reply. */
export function requireUnlocked(): void {
  if (!sessionKey) {
    throw new BwError('locked', 'The vault is locked.', 'Ask to unlock the vault; a password window will open on the desktop.');
  }
  touch();
}

/** Adopts a session key supplied at launch, for hosts with no desktop to show a dialog on. */
export async function adoptEnvSession(): Promise<boolean> {
  const key = process.env.BW_SESSION?.trim();
  if (!key) return false;
  sessionKey = key;
  if (await verifyUnlocked()) {
    lastActivity = Date.now();
    armIdleTimer();
    log.info('adopted BW_SESSION from the environment');
    return true;
  }
  sessionKey = null;
  log.warn('BW_SESSION was set but does not unlock the vault; ignoring it');
  return false;
}

/**
 * Asks for the master password again, for an item the user flagged "master password
 * re-prompt". Returns true only if the password was right.
 *
 * The new session key replaces the old one rather than being discarded. `bw unlock` mints a
 * fresh key and invalidates its predecessor, so holding on to the one captured beforehand
 * would leave this server carrying a key the CLI has already retired — and every call after
 * a successful re-prompt would fail as "locked".
 */
export async function reauthenticate(purpose: string): Promise<boolean> {
  const st = await status();
  const answer = await prompt({
    kind: 'form',
    title: 'Confirm it is you',
    message: `${purpose} This item is marked "master password re-prompt", so it needs your password again.`,
    fields: [{ name: 'password', label: 'Master password', secret: true }],
    confirmLabel: 'Confirm',
  });
  if (!answer.ok) return false;
  const password = answer.values.password ?? '';
  if (!password) return false;
  return withBwLock(async () => {
    const previous = sessionKey;
    const key = await unlockWith(password).catch(() => null);
    sessionKey = key ?? previous;
    if (key) {
      lastActivity = Date.now();
      armIdleTimer();
      log.audit('reauthenticated', { host: st.serverHost });
    }
    return Boolean(key);
  });
}

export { PromptError };
