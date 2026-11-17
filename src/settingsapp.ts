import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { log } from './log.js';

/**
 * The Windows Settings app: where it is, keeping a stable copy of it, and opening it.
 *
 * The copy that ships inside the extension moves whenever the extension updates, so shortcuts to
 * it would break. The server keeps a copy at <home>\app instead, refreshed whenever the shipped
 * one changes, and that is what shortcuts point at.
 */

export const SETTINGS_EXE = 'Bitwarden-MCP-Settings.exe';

export type SettingsPage = 'welcome' | 'account' | 'permissions' | 'security' | 'general' | 'updates' | 'activity' | 'about';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The copy shipped with this build, if any. */
export function bundledExe(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (process.env.VW_MCP_SETTINGS_EXE !== undefined) {
    const p = process.env.VW_MCP_SETTINGS_EXE.trim();
    return p && fs.existsSync(p) ? p : undefined;
  }
  return [path.join(here, 'settings', SETTINGS_EXE), path.resolve(here, '..', 'dist', 'settings', SETTINGS_EXE)].find((p) => fs.existsSync(p));
}

export function stableExe(): string {
  return path.join(CONFIG.appDir, SETTINGS_EXE);
}

export function settingsAppAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  if (process.env.VW_MCP_SETTINGS_EXE !== undefined) return Boolean(bundledExe());
  return Boolean(bundledExe()) || fs.existsSync(stableExe());
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Brings the stable copy up to date with the shipped one. A running exe cannot be overwritten on
 * Windows, but it can be renamed, so the old one is moved aside and removed once nothing holds
 * it. Best effort throughout: the worst case is that the copy updates next time.
 */
export function syncStableCopy(): void {
  if (process.platform !== 'win32' || process.env.VW_MCP_SETTINGS_EXE !== undefined) return;
  const from = bundledExe();
  if (!from) return;
  const to = stableExe();
  try {
    fs.mkdirSync(CONFIG.appDir, { recursive: true });
    for (const f of fs.readdirSync(CONFIG.appDir)) {
      if (f.startsWith(`${SETTINGS_EXE}.old-`)) fs.rmSync(path.join(CONFIG.appDir, f), { force: true });
    }
  } catch {
    /* an old copy still running; it goes next time */
  }
  try {
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size && sha256(to) === sha256(from)) return;
    const tmp = `${to}.new`;
    fs.copyFileSync(from, tmp);
    if (fs.existsSync(to)) fs.renameSync(to, `${to}.old-${Date.now()}`);
    fs.renameSync(tmp, to);
    log.info('settings app copy updated', { path: to });
  } catch (e) {
    log.warn('could not update the settings app copy', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Opens the Settings app at a page.
 *
 * It is started through Explorer rather than as a child. Claude Desktop is an MSIX package, and
 * a child of it inherits the package's file-system redirection, which would hide the Start-menu
 * shortcut the app offers to create. Explorer cannot pass arguments, so the page travels in a
 * small request file the app reads (and watches, if it is already open).
 */
export function launchSettingsApp(page: SettingsPage): boolean {
  if (!settingsAppAvailable()) return false;
  const exe = fs.existsSync(stableExe()) && process.env.VW_MCP_SETTINGS_EXE === undefined ? stableExe() : bundledExe();
  if (!exe) return false;
  try {
    fs.mkdirSync(CONFIG.home, { recursive: true });
    fs.writeFileSync(CONFIG.launchRequestFile, JSON.stringify({ page, at: new Date().toISOString() }) + '\n', 'utf8');
  } catch (e) {
    log.warn('could not write the launch request', e);
  }
  const defaultHome = path.join(os.homedir(), '.vaultwarden-mcp');
  // spawn() can fail synchronously (a file that is not an executable) as well as through its
  // error event; both mean the app did not open, and neither may fail the calling tool.
  const start = (cmd: string, args: string[], onError: () => void): boolean => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => {
        log.warn('settings app failed to start', { error: e.message });
        onError();
      });
      child.unref();
      return true;
    } catch (e) {
      log.warn('settings app failed to start', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  const direct = (): boolean => start(exe, ['--home', CONFIG.home], () => undefined);
  let started: boolean;
  // A non-default home has to be passed on the command line, which Explorer cannot do.
  if (path.resolve(CONFIG.home) !== path.resolve(defaultHome)) started = direct();
  else {
    const explorer = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    started = start(explorer, [exe], () => void direct()) || direct();
  }
  if (started) log.audit('settings_app_opened', { page });
  return started;
}

/**
 * First run: if nobody has signed in yet, open the Settings app's welcome page once, so the
 * person who just installed the extension lands on setup rather than on nothing. "Once" is a
 * marker file created exclusively, so several server processes starting together open it once.
 */
export function welcomeOnce(state: string): void {
  if (process.platform !== 'win32') return;
  if ((process.env.VW_MCP_NO_AUTOLAUNCH ?? '').trim() === '1') return;
  if (state !== 'unconfigured' && state !== 'unauthenticated') return;
  if (!settingsAppAvailable()) return;
  const marker = path.join(CONFIG.home, 'welcome-shown');
  try {
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' });
  } catch {
    return;
  }
  launchSettingsApp('welcome');
}
