import fs from 'node:fs';
import { bw, BwError, withBwLock } from './bw.js';
import { CONFIG, readConfig, serverUrlFixedByEnv, validateServerUrl, writeConfig } from './config.js';
import { log } from './log.js';
import { prompt, PromptError } from './prompt.js';
import { clearAll as clearPending } from './pending.js';
import { idleMinutes, onSettingsChange, settings } from './settings.js';
import * as shared from './shared-session.js';

/**
 * Ownership of the unlocked vault.
 *
 * The session key lives here, in memory. It is handed to `bw` one call at a time through that
 * call's environment, never through an argv and never in any MCP message, and it is dropped when
 * the vault locks: on request, after a stretch of inactivity, or when the process ends.
 *
 * On Windows it is also shared with the other server processes on this machine through a file
 * encrypted for this Windows user (see shared-session.ts), so that one unlock serves every chat,
 * and so that "never lock" can survive a restart.
 */

export type VaultState = 'no_cli' | 'unconfigured' | 'unauthenticated' | 'locked' | 'unlocked';

export type Status = {
  state: VaultState;
  /** Host only. The full URL is configuration, not something the model needs. */
  serverHost?: string;
  /** The full address, for the Settings app. Never put in a model-visible result. */
  serverUrl?: string;
  email?: string;
  lastSync?: string;
  idleLockMinutes: number;
  lockMode: string;
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

/**
 * Run when the vault closes, for whatever reason. The item cache holds decrypted secrets and
 * must not outlive the session that decrypted them; it lives in vault.ts, which already
 * imports this module, so it registers here rather than being reached for from a lock path.
 */
const lockListeners: (() => void)[] = [];
const changeListeners: (() => void)[] = [];

export function onLock(listener: () => void): void {
  lockListeners.push(listener);
}

/** Called after the vault opens, closes, or the account changes. For the status file. */
export function onStateChange(listener: () => void): void {
  changeListeners.push(listener);
}

function fire(list: (() => void)[]): void {
  for (const listener of list) {
    try {
      listener();
    } catch {
      /* a listener must never keep the vault open */
    }
  }
}

export function isUnlocked(): boolean {
  return sessionKey !== null;
}

/** Takes a key that has been proven to decrypt, and tells everyone who needs to know. */
async function adopt(key: string, opts: { share: boolean }): Promise<void> {
  sessionKey = key;
  lastActivity = Date.now();
  armIdleTimer();
  // Awaited, so another chat asking a moment later finds the shared copy already there.
  if (opts.share) await shared.publish(key, settings().lockMode);
  fire(changeListeners);
}

function drop(): void {
  sessionKey = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  clearPending();
  fire(lockListeners);
  fire(changeListeners);
}

/**
 * Drops the session because the CLI just refused to use it.
 *
 * A key can stop working without this process doing anything: `bw unlock` mints a new key and
 * retires the previous one, and more than one server instance can share a machine. Believing it
 * still works is the bug; this is how that belief gets corrected. The shared copy is removed
 * only if it is this same dead key, never a newer one another process wrote.
 */
export function forgetSession(): void {
  if (!sessionKey) return;
  const dead = sessionKey;
  drop();
  shared.remove(dead);
  log.audit('session_rejected_by_cli');
}

// ---------------------------------------------------------------------------
// Inactivity
// ---------------------------------------------------------------------------

let lastActivityWrite = 0;

export function touch(): void {
  if (!sessionKey) return;
  lastActivity = Date.now();
  // Other server processes read this, so activity in one chat keeps the vault open for all.
  if (lastActivity - lastActivityWrite > 15_000 && idleMinutes(settings()) > 0) {
    lastActivityWrite = lastActivity;
    try {
      fs.writeFileSync(CONFIG.activityFile, String(lastActivity));
    } catch {
      /* best effort */
    }
  }
  armIdleTimer();
}

function sharedActivity(): number {
  try {
    return fs.statSync(CONFIG.activityFile).mtimeMs;
  } catch {
    return 0;
  }
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const minutes = idleMinutes(settings());
  if (!sessionKey || minutes <= 0) return;
  const ms = minutes * 60_000;
  const due = lastActivity + ms - Date.now();
  idleTimer = setTimeout(() => {
    void (async () => {
      if (!sessionKey) return;
      const latest = Math.max(lastActivity, sharedActivity());
      // Re-check: activity here or in another process pushes the deadline out.
      if (Date.now() - latest < ms - 500) {
        lastActivity = latest;
        armIdleTimer();
        return;
      }
      log.audit('idle_lock', { afterMinutes: minutes });
      await lock().catch(() => undefined);
    })();
  }, Math.max(1000, due));
  idleTimer.unref?.();
}

export function locksInSeconds(): number | undefined {
  const minutes = idleMinutes(settings());
  if (!sessionKey || minutes <= 0) return undefined;
  const left = lastActivity + minutes * 60_000 - Date.now();
  return Math.max(0, Math.round(left / 1000));
}

// A change of lock mode applies to the session already open: re-arm (or disarm) the idle timer,
// and re-save the shared key so it carries the mode that now decides whether it outlives us.
onSettingsChange(() => {
  armIdleTimer();
  if (sessionKey) void shared.publish(sessionKey, settings().lockMode);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

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

/** Facts only the CLI can supply, kept so an unlocked status card need not go and ask again. */
let knownLastSync: string | undefined;
let knownEmail: string | undefined;
let knownServerUrl: string | undefined;

/** Proves the session key really decrypts. Cheap, and the only reliable unlock test. */
async function verifyKey(key: string): Promise<boolean> {
  try {
    await bw<unknown[]>(['list', 'folders'], { env: { BW_SESSION: key }, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

let sharedTried = '';

/**
 * Picks up a vault another process (or an earlier run, in "never lock" mode) already unlocked.
 * Cheap when there is nothing new: one stat. Returns true if this process is now unlocked.
 */
export async function adoptShared(): Promise<boolean> {
  if (sessionKey) return true;
  if (!shared.sharingSupported()) return false;
  const now = shared.stamp();
  if (now === 'none' || now === sharedTried) return false;
  sharedTried = now;
  return withBwLock(async () => {
    if (sessionKey) return true;
    const key = await shared.take();
    if (!key) return false;
    if (!(await verifyKey(key))) {
      shared.remove(key);
      return false;
    }
    await adopt(key, { share: false });
    log.info('picked up the shared vault session');
    return true;
  });
}

/**
 * The state of the vault as this server understands it.
 *
 * `bw status` is not trusted for "unlocked": it has reported an unlocked vault that then
 * refuses to decrypt (bitwarden/clients#20703). This server's own session key is the
 * authority, and `verifyKey` proves it with a real decrypt.
 */
export async function status(): Promise<Status> {
  const s0 = settings();
  const lockInfo = { idleLockMinutes: idleMinutes(s0), lockMode: s0.lockMode };
  if (!CONFIG.bwJs) return { state: 'no_cli', ...lockInfo };
  const cfg = readConfig();

  if (!sessionKey) await adoptShared().catch(() => false);

  // While this server holds a working session there is nothing `bw status` can tell us that we
  // do not already know, and asking costs a two-second process spawn on every status card.
  if (sessionKey) {
    const url = knownServerUrl ?? cfg.serverUrl;
    return {
      state: 'unlocked',
      serverHost: hostOf(url),
      serverUrl: url,
      email: knownEmail ?? cfg.email,
      lastSync: knownLastSync,
      ...lockInfo,
      locksInSeconds: locksInSeconds(),
    };
  }

  let s: BwStatus;
  try {
    s = await rawStatus();
  } catch (e) {
    if (e instanceof BwError && e.code === 'no_cli') return { state: 'no_cli', ...lockInfo };
    throw e;
  }
  if (s.lastSync) knownLastSync = s.lastSync;
  if (s.userEmail) knownEmail = s.userEmail;
  if (s.serverUrl) knownServerUrl = s.serverUrl;
  const url = s.status && s.status !== 'unauthenticated' ? (s.serverUrl ?? cfg.serverUrl) : (cfg.serverUrl ?? s.serverUrl ?? undefined);
  const base = {
    serverHost: hostOf(url),
    serverUrl: url ?? undefined,
    email: s.userEmail ?? cfg.email ?? undefined,
    lastSync: s.lastSync ?? undefined,
    ...lockInfo,
  };
  if (!url) return { state: 'unconfigured', ...base };
  if (s.status === 'unauthenticated' || !s.userId) return { state: 'unauthenticated', ...base };
  return { state: 'locked', ...base };
}

/**
 * Pushes the configured server URL into the CLI, when no account is signed in. A signed-in
 * account keeps its server: changing it under the account would be the start of a
 * credential-relay attack, so moving to another server means signing out first.
 */
export async function applyServerUrl(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.serverUrl) return;
  const checked = validateServerUrl(cfg.serverUrl);
  if ('error' in checked) throw new BwError('unknown', `Configured server URL is not usable: ${checked.error}`);
  const s = await rawStatus();
  if (sameUrl(s.serverUrl, checked.url)) return;
  if (s.status && s.status !== 'unauthenticated') {
    log.warn('the configured server differs from the signed-in account; leaving the account alone');
    return;
  }
  await bw(['config', 'server', checked.url], { timeoutMs: 60_000 });
  knownServerUrl = checked.url;
  log.audit('server_configured', { host: hostOf(checked.url) });
}

function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (u: string | null | undefined) => (u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/**
 * One unlock attempt, plus the retry that works around a CLI bug where the first unlock
 * after a fresh login returns an empty session key (bitwarden/clients#18455). Locking and
 * asking again clears it. Returns a key that has been proven to decrypt, or null.
 */
async function unlockWith(password: string): Promise<string | null> {
  const attempt = async (): Promise<string | 'wrong' | null> => {
    try {
      const data = await bw<{ raw?: string }>(['unlock', '--passwordenv', 'VW_MCP_PW'], {
        env: { VW_MCP_PW: password },
        timeoutMs: 90_000,
      });
      const key = typeof data?.raw === 'string' ? data.raw.trim() : '';
      return key || null;
    } catch (e) {
      if (e instanceof BwError && e.code === 'invalid_password') return 'wrong';
      throw e;
    }
  };

  let key = await attempt();
  // A wrong password ends it here. The lock-and-retry below is only for the empty-key bug, and
  // running `bw lock` after a mistyped password would close a vault that was open and working.
  if (key === 'wrong') return null;
  if (!key) {
    await bw(['lock'], { timeoutMs: 30_000 }).catch(() => undefined);
    key = await attempt();
  }
  if (!key || key === 'wrong') return null;
  return (await verifyKey(key)) ? key : null;
}

type UnlockOutcome = { ok: true } | { ok: false; reason: 'cancelled' | 'timeout' | 'bad_password' | 'unavailable' };

const ASSISTANT_NEVER_SEES = 'Your AI assistant never sees what you type here.';

/**
 * Asks for the master password in a native window and unlocks.
 *
 * The dialog is opened outside the bw lock on purpose: it can sit on screen for minutes, and
 * holding the lock would freeze every other vault operation behind it.
 */
export async function unlock(): Promise<UnlockOutcome> {
  const st = await status();
  if (st.state === 'unlocked') return { ok: true };
  if (st.state === 'unauthenticated' || st.state === 'unconfigured') {
    throw new BwError('not_logged_in', 'Not signed in.', 'Sign in first.');
  }

  const answer = await prompt({
    kind: 'form',
    title: 'Unlock your vault',
    message: `Enter the master password for ${st.email ?? 'your account'}${st.serverHost ? ` at ${st.serverHost}` : ''}. ${ASSISTANT_NEVER_SEES}`,
    fields: [{ name: 'password', label: 'Master password', secret: true }],
    confirmLabel: 'Unlock',
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  const password = answer.values.password ?? '';
  if (!password) return { ok: false, reason: 'cancelled' };

  return withBwLock(async () => {
    const key = await unlockWith(password);
    if (!key) return { ok: false, reason: 'bad_password' as const };
    knownLastSync = st.lastSync ?? knownLastSync;
    knownEmail = st.email ?? knownEmail;
    await adopt(key, { share: true });
    log.audit('unlocked', { host: st.serverHost });
    return { ok: true as const };
  });
}

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'bad_password' | 'two_factor' | 'unavailable'; message?: string };

/**
 * Signs in through a native dialog, for systems without the Settings app (macOS, Linux). On
 * Windows the Settings app does this, with the full set of two-step options. A password login
 * returns a session key directly, so a second master-password prompt would be pure friction.
 */
export async function login(): Promise<LoginOutcome> {
  const cfg = readConfig();
  const st = await status();
  if (st.state === 'locked' || st.state === 'unlocked') {
    const r = await unlock();
    return r.ok ? { ok: true } : { ok: false, reason: r.reason === 'bad_password' ? 'bad_password' : r.reason };
  }

  // With no vault chosen yet, the person picks it here, in a window the model cannot touch.
  const askServer = st.state === 'unconfigured';
  const answer = await prompt({
    kind: 'form',
    title: 'Sign in to your vault',
    message: askServer
      ? `Enter your vault's address: https://vault.bitwarden.com for Bitwarden (US), https://vault.bitwarden.eu (EU), or your own server's address. ${ASSISTANT_NEVER_SEES} Leave the code blank unless you use an authenticator app for two-step login.`
      : `Signing in to ${st.serverHost ?? 'your vault'}. ${ASSISTANT_NEVER_SEES} Leave the code blank unless you use an authenticator app for two-step login.`,
    fields: [
      ...(askServer ? [{ name: 'server', label: 'Vault address', value: 'https://vault.bitwarden.com' }] : []),
      { name: 'email', label: 'Email', value: cfg.email ?? st.email ?? '' },
      { name: 'password', label: 'Master password', secret: true },
      { name: 'code', label: 'Two-step code (optional)', optional: true },
    ],
    confirmLabel: 'Sign in',
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };

  const serverUrl = askServer ? (answer.values.server ?? '').trim() : (st.serverUrl ?? cfg.serverUrl ?? '');
  const email = (answer.values.email ?? '').trim();
  const password = answer.values.password ?? '';
  const code = (answer.values.code ?? '').trim();
  if (!email || !password || !serverUrl) return { ok: false, reason: 'cancelled' };

  const r = await signIn({ serverUrl, email, password, method: code ? 0 : undefined, code: code || undefined });
  if (r.ok) return { ok: true };
  if (r.error === 'code_required' || r.error === 'bad_code') return { ok: false, reason: 'two_factor', message: r.message };
  if (r.error === 'bad_password') return { ok: false, reason: 'bad_password', message: r.message };
  throw new BwError(r.error === 'network' ? 'network' : 'unknown', r.message);
}

// ---------------------------------------------------------------------------
// Account operations for the Settings app
// ---------------------------------------------------------------------------

export type AccountError =
  | 'code_required'
  | 'bad_password'
  | 'bad_code'
  | 'network'
  | 'invalid_url'
  | 'fixed_url'
  | 'signed_in_elsewhere'
  | 'not_signed_in'
  | 'unavailable'
  | 'unknown';

export type AccountResult = { ok: true } | { ok: false; error: AccountError; message: string };

const fail = (error: AccountError, message: string): AccountResult => ({ ok: false, error, message });

/** Turns a CLI failure during sign-in into something a person can act on. */
function explain(e: unknown, ctx: { method?: number; code?: string; email?: string }): AccountResult {
  if (!(e instanceof BwError)) return fail('unknown', e instanceof Error ? e.message.slice(0, 200) : 'Something went wrong.');
  const raw = (e.raw ?? e.message).toLowerCase();
  if (/code is required/.test(raw)) {
    if (ctx.method === 1 && !ctx.code) {
      return fail('code_required', `Bitwarden has emailed a code to ${ctx.email ?? 'your account email'}. Enter it to finish signing in.`);
    }
    return fail(
      'code_required',
      'Bitwarden wants a two-step login code. Choose how you get your codes and enter the current one. If Bitwarden emailed you a "new device" verification code instead, the Bitwarden CLI cannot accept it: sign in with your personal API key.',
    );
  }
  if (/two-step|two factor|token is invalid|invalid.*(code|token)/.test(raw)) return fail('bad_code', 'That two-step code was not accepted. Check it and try again.');
  if (e.code === 'invalid_password' || /username or password is incorrect|invalid master password/.test(raw)) {
    return fail('bad_password', 'That email and master password were not accepted.');
  }
  if (/client_id|client_secret|invalid_client/.test(raw)) return fail('bad_password', 'That API key was not accepted.');
  if (e.code === 'network') return fail('network', 'Could not reach the vault server. Check the address and your connection.');
  if (e.code === 'no_cli' || e.code === 'timeout') return fail('unavailable', e.message);
  return fail('unknown', (e.raw ?? e.message).split('\n')[0].slice(0, 200));
}

/**
 * Gets the CLI pointed at `serverUrl` with no account in the way. Refuses to move a signed-in
 * account to another server: the user signs out first, in the Settings app, on purpose.
 */
async function prepareServer(serverUrl: string, email: string | undefined): Promise<{ ok: false; result: AccountResult } | { ok: true; url: string; signedInAs?: string }> {
  const checked = validateServerUrl(serverUrl);
  if ('error' in checked) return { ok: false, result: fail('invalid_url', checked.error) };
  const url = checked.url;
  const fixed = process.env.VW_MCP_SERVER_URL?.trim();
  if (serverUrlFixedByEnv() && !sameUrl(fixed, url)) {
    return { ok: false, result: fail('fixed_url', `This install is set to use ${hostOf(fixed) ?? fixed}. Change VW_MCP_SERVER_URL in its configuration to use another server.`) };
  }
  const s = await rawStatus();
  if (s.status && s.status !== 'unauthenticated') {
    if (!sameUrl(s.serverUrl, url)) {
      return { ok: false, result: fail('signed_in_elsewhere', `Already signed in at ${hostOf(s.serverUrl) ?? 'another server'}. Sign out first to use a different server.`) };
    }
    return { ok: true, url, signedInAs: s.userEmail ?? undefined };
  }
  if (!sameUrl(s.serverUrl, url)) {
    await bw(['config', 'server', url], { timeoutMs: 60_000 });
    log.audit('server_configured', { host: hostOf(url) });
  }
  knownServerUrl = url;
  writeConfig({ serverUrl: serverUrlFixedByEnv() ? undefined : url, ...(email ? { email } : {}) });
  return { ok: true, url };
}

async function passwordLogin(email: string, password: string, method: number | undefined, code: string | undefined, host: string | undefined): Promise<AccountResult> {
  const args = ['login', email, '--passwordenv', 'VW_MCP_PW'];
  if (method !== undefined) args.push('--method', String(method));
  if (code) args.push('--code', code);
  return withBwLock(async () => {
    try {
      const data = await bw<{ raw?: string }>(args, { env: { VW_MCP_PW: password }, timeoutMs: 120_000 });
      let key = typeof data?.raw === 'string' ? data.raw.trim() : '';
      if (!key || !(await verifyKey(key))) key = (await unlockWith(password)) ?? '';
      if (!key) return fail('bad_password', 'Signed in, but the vault would not unlock with that password.');
      knownEmail = email;
      knownLastSync = new Date().toISOString();
      await adopt(key, { share: true });
      log.audit('signed_in', { host });
      return { ok: true } as AccountResult;
    } catch (e) {
      return explain(e, { method, code, email });
    }
  });
}

const METHODS = new Set([0, 1, 3]);

/** Email and master password, with an optional two-step method and code. */
export async function signIn(req: { serverUrl: string; email: string; password: string; method?: number; code?: string }): Promise<AccountResult> {
  const email = String(req.email ?? '').trim();
  const password = String(req.password ?? '');
  if (!email || !password) return fail('bad_password', 'Enter your email and master password.');
  const method = req.method === undefined || req.method === null ? undefined : Number(req.method);
  if (method !== undefined && !METHODS.has(method)) return fail('unknown', 'That two-step method is not supported by the Bitwarden CLI.');
  const code = req.code ? String(req.code).replace(/\s+/g, '') : undefined;
  if (code && !/^[A-Za-z0-9-]{4,64}$/.test(code)) return fail('bad_code', 'That does not look like a two-step code.');

  try {
    const prep = await prepareServer(String(req.serverUrl ?? ''), email);
    if (!prep.ok) return prep.result;
    if (prep.signedInAs !== undefined) {
      if (prep.signedInAs.toLowerCase() !== email.toLowerCase()) {
        return fail('signed_in_elsewhere', `Already signed in as ${prep.signedInAs}. Sign out first to use another account.`);
      }
      return unlockWithPassword(password);
    }
    return passwordLogin(email, password, method, code, hostOf(prep.url));
  } catch (e) {
    return explain(e, { method, code, email });
  }
}

/**
 * A personal API key signs in without a two-step code or a new-device check, which is the way
 * through for accounts whose second step the CLI cannot do. The vault still needs the master
 * password to unlock.
 */
export async function signInWithApiKey(req: { serverUrl: string; clientId: string; clientSecret: string; password: string }): Promise<AccountResult> {
  const clientId = String(req.clientId ?? '').trim();
  const clientSecret = String(req.clientSecret ?? '').trim();
  const password = String(req.password ?? '');
  if (!/^user\.[0-9a-f-]{36}$/i.test(clientId) || !clientSecret || !password) {
    return fail('bad_password', 'Enter the client_id (it starts with "user."), the client_secret and your master password.');
  }
  try {
    const prep = await prepareServer(String(req.serverUrl ?? ''), undefined);
    if (!prep.ok) return prep.result;
    if (prep.signedInAs === undefined) {
      await withBwLock(() => bw(['login', '--apikey'], { env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }, timeoutMs: 120_000 }));
      log.audit('signed_in', { host: hostOf(prep.url), via: 'api_key' });
    }
    return unlockWithPassword(password);
  } catch (e) {
    return explain(e, {});
  }
}

/** Unlocks a signed-in account with its master password, without a dialog. */
export async function unlockWithPassword(password: string): Promise<AccountResult> {
  if (!password) return fail('bad_password', 'Enter your master password.');
  if (sessionKey) return { ok: true };
  try {
    const s = await rawStatus();
    if (!s.status || s.status === 'unauthenticated') return fail('not_signed_in', 'Not signed in. Sign in first.');
    return await withBwLock(async () => {
      const key = await unlockWith(password);
      if (!key) return fail('bad_password', 'That master password was not accepted.');
      if (s.userEmail) knownEmail = s.userEmail;
      if (s.lastSync) knownLastSync = s.lastSync;
      await adopt(key, { share: true });
      log.audit('unlocked', { host: hostOf(s.serverUrl) });
      return { ok: true } as AccountResult;
    });
  } catch (e) {
    return explain(e, {});
  }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/** Locks the vault everywhere: this process, the shared copy, and the CLI's own state. */
export async function lock(): Promise<void> {
  const had = sessionKey !== null;
  drop();
  shared.remove();
  await bw(['lock'], { timeoutMs: 30_000 }).catch(() => undefined);
  if (had) log.audit('locked');
}

export async function logout(): Promise<void> {
  drop();
  shared.remove();
  await bw(['logout'], { timeoutMs: 60_000 }).catch(() => undefined);
  knownEmail = undefined;
  knownLastSync = undefined;
  log.audit('signed_out');
  fire(changeListeners);
}

/**
 * What happens when the process ends. In "never lock" mode nothing does: the shared key and the
 * CLI's state stay, so the next start picks the vault up still open. Otherwise it locks.
 */
export async function shutdown(): Promise<void> {
  if (settings().lockMode === 'never' && shared.sharingSupported()) {
    sessionKey = null;
    return;
  }
  await lock();
}

export async function sync(): Promise<string | undefined> {
  requireUnlocked();
  await bw(['sync'], { env: sessionEnv(), timeoutMs: 120_000 });
  touch();
  // The sync just happened, so its time is now. Asking the CLI to confirm that would be a
  // second process spawn to learn something already known.
  knownLastSync = new Date().toISOString();
  return knownLastSync;
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
  if (await verifyKey(key)) {
    await adopt(key, { share: false });
    log.info('adopted BW_SESSION from the environment');
    return true;
  }
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
    const key = await unlockWith(password).catch(() => null);
    if (!key) return false;
    await adopt(key, { share: true });
    log.audit('reauthenticated', { host: st.serverHost });
    return true;
  });
}

export { PromptError };
