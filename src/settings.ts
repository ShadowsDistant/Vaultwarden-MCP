import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDomain } from 'tldts';
import { CONFIG } from './config.js';
import { log } from './log.js';

/**
 * Behaviour and permissions, as the user set them.
 *
 * These live in `settings.json` beside the vault data, written by the Settings app, and are
 * re-read whenever the file changes, so a change applies to the assistant's next request without a
 * restart. The one exception is whether cards are shown at all: that decides how the tools are
 * registered with the host, which only happens when the server starts.
 *
 * Nothing here can be set from a conversation. There is no tool that writes this file, for the
 * same reason there is no tool that sets the vault address: a setting that loosens access is
 * only meaningful if the model cannot reach it.
 */

export type AccessMode = 'never' | 'ask' | 'session';

/**
 * When the vault locks by itself.
 *  - idle: after `idleLockMinutes` with no vault activity in any server process.
 *  - exit: when the AI app stops the extension (and on an explicit lock).
 *  - never: stays unlocked across restarts. On Windows the session key is kept, encrypted for
 *    this Windows user only, so the next start picks it up. Only an explicit lock ends it.
 */
export type LockMode = 'idle' | 'exit' | 'never';

export type Settings = {
  /** Show inline cards in chats. Read once at startup. */
  cards: boolean;
  /** Let the assistant prepare new logins and edits. Every one still needs a human yes. */
  allowChanges: boolean;
  /** Let the assistant prepare moving items to the trash. Needs allowChanges as well. */
  allowTrash: boolean;
  /** What happens when the assistant asks for a secret from a site that is not trusted. */
  access: AccessMode;
  /** Sites whose password and one-time code the assistant may read or copy without asking. */
  trustedSites: string[];
  lockMode: LockMode;
  /** Minutes of inactivity before an idle lock. Used only when lockMode is idle. */
  idleLockMinutes: number;
  /** How long a revealed secret stays on screen in the card. */
  revealSeconds: number;
  /** How long a copied secret stays on the clipboard. */
  clipboardClearSeconds: number;
  /** Ask GitHub, now and then, whether a newer release exists. Sends nothing about the user. */
  updateCheck: boolean;
  /**
   * Motion in the cards and the Settings app. "system" follows the operating system's
   * reduce-motion setting; "on" shows it regardless, for people who switched Windows
   * animations off for other reasons and still want them here.
   */
  animations: 'on' | 'off' | 'system';
  /**
   * Keep a local record of what was done with the vault: which items were searched for, viewed
   * or copied, by whom and when. Item names and sites only, never a secret. Not a permission,
   * so a broken settings file leaves it as written.
   */
  activityLog: boolean;
};

export type SettingsState = {
  settings: Settings;
  /** Set when the file could not be read; the server is then running locked down. */
  error?: string;
  /** Trusted-site entries that were refused, with the reason. */
  rejectedSites: { entry: string; reason: string }[];
  /** Field-level problems that fell back to the default. */
  warnings: string[];
  loadedAt: number;
};

export const DEFAULTS: Settings = {
  cards: true,
  allowChanges: true,
  allowTrash: true,
  access: 'ask',
  trustedSites: [],
  lockMode: 'exit',
  idleLockMinutes: 15,
  revealSeconds: 30,
  clipboardClearSeconds: 30,
  updateCheck: true,
  animations: 'on',
  activityLog: true,
};

/**
 * What a settings file that cannot be parsed turns into: nothing released without asking,
 * nothing at all released when the user has said never, and no changes. A torn or tampered
 * file must never leave the server looser than the user configured it, and the only way to
 * guarantee that without knowing what they configured is to assume the strictest choice.
 */
const LOCKDOWN: Pick<Settings, 'access' | 'trustedSites' | 'allowChanges' | 'allowTrash' | 'lockMode'> = {
  access: 'never',
  trustedSites: [],
  allowChanges: false,
  allowTrash: false,
  // "never" is the one lock setting that loosens anything, so a broken file cannot keep it.
  lockMode: 'exit',
};

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** The host of a stored URI, normalised the same way trusted entries are. */
export function hostOfUri(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  try {
    const u = new URL(text.includes('://') ? text : `https://${text}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    // URL has already turned any internationalised name into punycode, so a lookalike written
    // in another script can never compare equal to the ASCII name it imitates.
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** A byte-order mark, which an editor may prepend and which JSON.parse rejects outright. */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Turns what a person typed into a trusted-site entry, or explains why it cannot be one.
 *
 * Accepts `github.com`, `https://github.com/login` and `*.github.com` alike. Refuses anything
 * that would trust more than one owner's sites: a bare suffix such as `com` or `co.uk`, and the
 * shared hosting suffixes such as `github.io`, where every subdomain belongs to a different
 * person. Trusting `github.io` would trust every GitHub Pages site on the internet.
 */
export function normaliseSite(entry: string): { host: string } | { reason: string } {
  let text = String(entry ?? '').trim().toLowerCase();
  if (!text) return { reason: 'empty' };
  text = text.replace(/^\*\./, '');
  const host = hostOfUri(text);
  if (!host) return { reason: 'not a web address' };
  if (host === 'localhost') return { host };
  if (IPV4.test(host)) return { host };
  if (host.includes(':')) return { reason: 'IPv6 addresses are not supported' };
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..')) {
    return { reason: 'not a valid host name' };
  }
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (!parsed.domain) {
    return { reason: `"${host}" is shared by many unrelated sites, so it cannot be trusted as a whole` };
  }
  return { host };
}

/** Minutes before an idle lock, or 0 when this lock mode has none. */
export function idleMinutes(s: Settings): number {
  return s.lockMode === 'idle' ? s.idleLockMinutes : 0;
}

/** Whether trashing is allowed: both switches must be on. */
export function trashAllowed(s: Settings): boolean {
  return s.allowChanges && s.allowTrash;
}

/** True when `host` is the entry itself or one of its subdomains. IPs match exactly only. */
export function hostMatches(host: string, entry: string): boolean {
  if (host === entry) return true;
  if (IPV4.test(entry) || entry === 'localhost') return false;
  return host.endsWith(`.${entry}`);
}

type LoginLike = {
  type?: number;
  login?: { uris?: { uri?: string | null }[] | null } | null;
};

/**
 * Whether every address on an item belongs to a trusted site.
 *
 * Every one, not any one. An item that lists a trusted site beside an untrusted one is not
 * trusted: the trust is meant to cover the account at that site, and an extra address is
 * either a mistake or someone hoping to borrow it.
 */
export function itemOnTrustedSite(item: LoginLike, trusted: string[]): boolean {
  if (!trusted.length) return false;
  if (item.type !== undefined && item.type !== 1) return false;
  const uris = (item.login?.uris ?? []).map((u) => u?.uri).filter((u): u is string => Boolean(u && String(u).trim()));
  if (!uris.length) return false;
  return uris.every((uri) => {
    const host = hostOfUri(uri);
    return Boolean(host) && trusted.some((entry) => hostMatches(host as string, entry));
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function accessFrom(raw: unknown): AccessMode | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'never' || v === 'off') return 'never';
  if (v === 'ask') return 'ask';
  if (v === 'session') return 'session';
  return undefined;
}

function lockModeFrom(raw: unknown): LockMode | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'idle' || v === 'exit' || v === 'never' ? v : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Environment values are bounded but not rounded, and may go lower than the Settings app
 * offers: a one-second clipboard or a minute-fraction idle lock is stricter, never looser,
 * and it is what lets the tests watch a timer fire without waiting minutes for it.
 */
function bound(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Environment variables are the older way to configure this, and still the only way on a
 * machine with no settings file. The file wins over them, key by key.
 */
function fromEnv(): Settings {
  const s: Settings = { ...DEFAULTS, trustedSites: [] };
  const cards = envBool('VW_MCP_CARDS');
  if (cards !== undefined) s.cards = cards;
  const readOnly = envBool('VW_MCP_READ_ONLY');
  if (readOnly !== undefined) s.allowChanges = !readOnly;
  const access = accessFrom(process.env.VW_MCP_MODEL_REVEAL);
  if (access) s.access = access;
  const idle = envNum('VW_MCP_IDLE_LOCK_MIN');
  if (idle !== undefined) {
    if (idle > 0) {
      s.lockMode = 'idle';
      s.idleLockMinutes = bound(idle, 0.01, 1440);
    } else s.lockMode = 'exit';
  }
  const updates = envBool('VW_MCP_UPDATE_CHECK');
  if (updates !== undefined) s.updateCheck = updates;
  const reveal = envNum('VW_MCP_REVEAL_SECONDS');
  if (reveal !== undefined) s.revealSeconds = bound(reveal, 1, 300);
  const clip = envNum('VW_MCP_CLIPBOARD_CLEAR_SECONDS');
  if (clip !== undefined) s.clipboardClearSeconds = bound(clip, 1, 300);
  if (process.env.VW_MCP_TRUSTED_SITES) s.trustedSites = process.env.VW_MCP_TRUSTED_SITES.split(',');
  return s;
}

function readState(): SettingsState {
  const base = fromEnv();
  const warnings: string[] = [];
  let error: string | undefined;
  let file: Record<string, unknown> | undefined;

  if (fs.existsSync(CONFIG.settingsFile)) {
    try {
      const raw = fs.readFileSync(CONFIG.settingsFile, 'utf8').replace(BOM, '');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      file = parsed as Record<string, unknown>;
    } catch (e) {
      error = `settings.json could not be read (${e instanceof Error ? e.message : String(e)})`;
    }
  }

  const s: Settings = { ...base, trustedSites: [...base.trustedSites] };
  if (file) {
    const take = <K extends keyof Settings>(key: K, valid: (v: unknown) => Settings[K] | undefined): void => {
      if (!(key in file!)) return;
      const v = valid(file![key]);
      if (v === undefined) warnings.push(`"${key}" was not understood; using ${JSON.stringify(s[key])}`);
      else s[key] = v;
    };
    take('cards', (v) => (typeof v === 'boolean' ? v : undefined));
    take('allowChanges', (v) => (typeof v === 'boolean' ? v : undefined));
    take('allowTrash', (v) => (typeof v === 'boolean' ? v : undefined));
    take('updateCheck', (v) => (typeof v === 'boolean' ? v : undefined));
    take('animations', (v) => (v === 'on' || v === 'off' || v === 'system' ? v : undefined));
    take('activityLog', (v) => (typeof v === 'boolean' ? v : undefined));
    take('access', (v) => accessFrom(v));
    take('trustedSites', (v) => (Array.isArray(v) ? v.map((x) => String(x)) : undefined));
    take('idleLockMinutes', (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1440) : undefined));
    if ('lockMode' in file) take('lockMode', (v) => lockModeFrom(v));
    else if ('idleLockMinutes' in file) {
      // Written before lock modes existed: a positive number meant an idle lock, zero meant
      // "only when the app closes".
      s.lockMode = s.idleLockMinutes > 0 ? 'idle' : 'exit';
    }
    if (s.lockMode === 'idle' && s.idleLockMinutes <= 0) s.idleLockMinutes = DEFAULTS.idleLockMinutes;
    take('revealSeconds', (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 5, 300) : undefined));
    take('clipboardClearSeconds', (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 5, 300) : undefined));
  }

  if (error) Object.assign(s, LOCKDOWN);

  const rejectedSites: { entry: string; reason: string }[] = [];
  const accepted: string[] = [];
  for (const entry of s.trustedSites) {
    const r = normaliseSite(entry);
    if ('host' in r) {
      if (!accepted.includes(r.host)) accepted.push(r.host);
    } else {
      rejectedSites.push({ entry: String(entry), reason: r.reason });
    }
  }
  s.trustedSites = accepted;

  return { settings: s, error, rejectedSites, warnings, loadedAt: Date.now() };
}

let state: SettingsState | null = null;
let stamp = '';

function fileStamp(): string {
  try {
    const st = fs.statSync(CONFIG.settingsFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

function summarise(s: Settings): string {
  return `access=${s.access} trusted=${s.trustedSites.length} changes=${s.allowChanges} trash=${s.allowTrash} cards=${s.cards} lock=${s.lockMode}${s.lockMode === 'idle' ? `:${s.idleLockMinutes}m` : ''} updates=${s.updateCheck}`;
}

const listeners: ((s: SettingsState) => void)[] = [];

/** Called whenever the settings in force change. */
export function onSettingsChange(listener: (s: SettingsState) => void): void {
  listeners.push(listener);
}

/**
 * The settings in force right now. A stat per call is cheap, and it means the Settings app's
 * Save takes effect on the very next request rather than whenever a watcher fires.
 */
export function current(): SettingsState {
  const now = fileStamp();
  if (state && now === stamp) return state;
  const previous = state;
  state = readState();
  stamp = now;
  if (state.error) log.error('settings unreadable; running locked down', { error: state.error });
  if (state.rejectedSites.length) log.warn('trusted sites refused', { count: state.rejectedSites.length });
  for (const w of state.warnings) log.warn('settings', { warning: w });
  if (!previous || JSON.stringify(previous.settings) !== JSON.stringify(state.settings) || previous.error !== state.error) {
    log.audit('settings_in_force', { summary: summarise(state.settings), locked_down: Boolean(state.error) });
    for (const l of listeners) {
      try {
        l(state);
      } catch {
        /* a listener must not stop settings loading */
      }
    }
  }
  return state;
}

export function settings(): Settings {
  return current().settings;
}

// ---------------------------------------------------------------------------
// The status file the Settings app reads
// ---------------------------------------------------------------------------

export type ServerStatus = {
  version: string;
  pid: number;
  updatedAt: string;
  serverHost?: string;
  cardsEnabled: boolean;
  cardsSupported?: boolean;
  settingsError?: string;
  rejectedSites: { entry: string; reason: string }[];
  warnings: string[];
  /** The settings in force, so the app can start from them when there is no file yet. */
  effective: Settings;
  /** How this copy was installed: decides how the Settings app offers an update. */
  install?: 'claude-desktop' | 'other';
  /** The vault as this process last saw it. No secrets: a state, an email, an address. */
  vault?: { state: string; email?: string; serverUrl?: string; lastSync?: string };
  /** The Settings app's way in: a named pipe and the token it must present. */
  ipc?: { pipe: string; token: string };
  update?: { current: string; latest: string; url: string; checkedAt: string } | null;
};

/**
 * Written for the Settings app, so it can show which vault the server is using, whether it has
 * been seen lately, and which trusted-site entries it refused. Nothing secret is in it.
 */
export function writeStatus(status: Omit<ServerStatus, 'pid' | 'updatedAt' | 'rejectedSites' | 'warnings' | 'settingsError' | 'effective'>): void {
  const st = current();
  const body: ServerStatus = {
    ...status,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    settingsError: st.error,
    rejectedSites: st.rejectedSites,
    warnings: st.warnings,
    effective: st.settings,
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG.statusFile), { recursive: true });
    const tmp = `${CONFIG.statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG.statusFile);
  } catch (e) {
    log.warn('could not write status file', e);
  }
}
