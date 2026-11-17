import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PRODUCT } from './config.js';
import { log } from './log.js';
import { settings } from './settings.js';

/**
 * Knowing when a newer release exists, so nobody stays on an old copy of something that guards
 * their passwords.
 *
 * The server asks GitHub's public releases API every few hours (only when the user leaves
 * update checks on) and shares what it learns with the Settings app through update.json, which
 * the app also refreshes. Nothing is downloaded here and nothing about the user is sent: a plain
 * GET with a generic user agent.
 *
 * The only thing that reaches the model is a version number that has been checked against a
 * strict pattern, so a release title or body can never become text in a conversation.
 */

const REPO = 'ShadowsDistant/Vaultwarden-MCP';
const API = process.env.VW_MCP_UPDATE_URL?.trim() || `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const FRESH_MS = 6 * 60 * 60_000;
const NOTICE_EVERY_MS = 24 * 60 * 60_000;

type Cache = { checkedAt: string; latest: string; url: string; mcpbUrl?: string; mcpbName?: string; sumsUrl?: string };

const VERSION = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function newer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let currentVersion = '0.0.0';

function readCache(): Cache | null {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG.updateFile, 'utf8')) as Cache;
    if (!c || typeof c.latest !== 'string' || !parseVersion(c.latest)) return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(c: Cache): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG.updateFile), { recursive: true });
    const tmp = `${CONFIG.updateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG.updateFile);
  } catch (e) {
    log.warn('could not save the update check', e);
  }
}

type Release = { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };

/** Asks GitHub, unless a check from any process is recent enough. */
export async function checkNow(force = false): Promise<void> {
  if (!settings().updateCheck) return;
  const cached = readCache();
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < FRESH_MS) return;
  try {
    const res = await fetch(API, {
      headers: { 'User-Agent': `${PRODUCT.replace(/\s+/g, '-')}/${currentVersion}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.info('update check: no answer', { status: res.status });
      return;
    }
    const r = (await res.json()) as Release;
    if (r.draft || r.prerelease) return;
    const tag = String(r.tag_name ?? '');
    const parsed = parseVersion(tag);
    if (!parsed) {
      log.info('update check: unexpected tag');
      return;
    }
    const latest = parsed.join('.');
    const html = typeof r.html_url === 'string' && r.html_url.startsWith(`${RELEASES}/`) ? r.html_url : RELEASES;
    const asset = (suffix: string) =>
      (r.assets ?? []).find((a) => typeof a.name === 'string' && a.name.endsWith(suffix) && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX));
    const mcpb = asset('.mcpb');
    const sums = (r.assets ?? []).find((a) => a.name === 'SHA256SUMS.txt' && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX));
    writeCache({
      checkedAt: new Date().toISOString(),
      latest,
      url: html,
      ...(mcpb ? { mcpbUrl: String(mcpb.browser_download_url), mcpbName: String(mcpb.name) } : {}),
      ...(sums ? { sumsUrl: String(sums.browser_download_url) } : {}),
    });
    log.info('update check', { latest, current: currentVersion, newer: newer(latest, currentVersion) });
  } catch (e) {
    log.info('update check failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

export type UpdateInfo = { current: string; latest: string; url: string; checkedAt: string };

/** A newer release, if the user has update checks on and one is known. */
export function updateAvailable(): UpdateInfo | null {
  if (!settings().updateCheck) return null;
  const c = readCache();
  if (!c || !newer(c.latest, currentVersion)) return null;
  return { current: currentVersion, latest: c.latest, url: c.url.startsWith(RELEASES) ? c.url : RELEASES, checkedAt: c.checkedAt };
}

/** The sentence the model is given, so it can tell the user. */
export function noticeText(u: UpdateInfo): string {
  return `Update available: ${PRODUCT} ${u.latest} is out (this is ${u.current}). Updates can include security fixes. Tell the user, and suggest they open ${PRODUCT} Settings > Updates to install it (vault_open_settings opens it on Windows), or see ${u.url}.`;
}

let lastNotice = 0;

/**
 * The notice for an ordinary tool result: once, then again a day later, per process. vault_status
 * always carries it; repeating it on every search would bury the answer the user asked for.
 */
export function takeNotice(): string | undefined {
  const u = updateAvailable();
  if (!u) return undefined;
  if (Date.now() - lastNotice < NOTICE_EVERY_MS) return undefined;
  lastNotice = Date.now();
  return noticeText(u);
}

export function startUpdateChecks(version: string, onChange: () => void): void {
  currentVersion = version;
  const tick = (): void => {
    const before = updateAvailable()?.latest;
    void checkNow().then(() => {
      if (updateAvailable()?.latest !== before) onChange();
    });
  };
  const first = setTimeout(tick, 10_000);
  first.unref?.();
  const every = setInterval(tick, FRESH_MS);
  every.unref?.();
}
