import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { log } from './log.js';
import type { LockMode } from './settings.js';

/**
 * One unlock, shared by every server process on this machine.
 *
 * An AI app can run several copies of this server at once (Claude Desktop starts one per kind of
 * chat), and `bw unlock` retires the previous session key whenever it mints a new one. Without
 * sharing, unlocking in one chat silently locked the others, and signing in from the Settings app
 * unlocked a process no chat was talking to.
 *
 * So the key is written to one file, encrypted with Windows DPAPI for the current Windows user
 * only, and a process that finds itself locked looks there before asking for a password. The
 * file goes when the vault locks. It outlives the process only when the user chose "never lock",
 * or while the process that wrote it is still running.
 *
 * Windows only. Elsewhere each process keeps its own key, as before.
 */

type SessionFile = {
  v: 1;
  /** The session key, DPAPI-protected, base64. */
  blob: string;
  /** First 16 hex digits of the key's SHA-256, so a process can tell whether it is its own key. */
  fp: string;
  pid: number;
  mode: LockMode;
  at: string;
};

export function fingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

function script(): string {
  return path.join(CONFIG.scriptsDir, 'dpapi.ps1');
}

export function sharingSupported(): boolean {
  if (process.platform !== 'win32') return false;
  if ((process.env.VW_MCP_SHARED_SESSION ?? '').trim() === '0') return false;
  return fs.existsSync(script());
}

function dpapi(mode: 'protect' | 'unprotect', input: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      CONFIG.powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script(), '-Mode', mode],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(null);
    }, 20_000);
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out ? out : null);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else, which is still "alive".
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readFile(): SessionFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.sessionFile, 'utf8')) as SessionFile;
    if (parsed?.v !== 1 || typeof parsed.blob !== 'string' || typeof parsed.fp !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function stamp(): string {
  try {
    const st = fs.statSync(CONFIG.sessionFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/** Saves the key for the other processes. Best effort: failing only means they ask again. */
export async function publish(key: string, mode: LockMode): Promise<void> {
  if (!sharingSupported()) return;
  const blob = await dpapi('protect', key);
  if (!blob) {
    log.warn('could not protect the session for sharing');
    return;
  }
  const body: SessionFile = { v: 1, blob: blob.trim(), fp: fingerprint(key), pid: process.pid, mode, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(CONFIG.sessionFile), { recursive: true });
    const tmp = `${CONFIG.sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG.sessionFile);
  } catch (e) {
    log.warn('could not write the shared session', e);
  }
}

/**
 * Removes the shared key. With `onlyIf`, only when the file holds that key: a process whose key
 * was refused must not delete a newer key another process has just written.
 */
export function remove(onlyIf?: string): void {
  if (onlyIf) {
    const f = readFile();
    if (!f || f.fp !== fingerprint(onlyIf)) return;
  }
  try {
    fs.rmSync(CONFIG.sessionFile, { force: true });
  } catch {
    /* gone already */
  }
}

/**
 * The shared key, if there is one this process may use. A key from a process that has since
 * died is only good in "never lock" mode; otherwise it is left over from a crash and is removed,
 * because the user expected closing the app to lock the vault.
 */
export async function take(): Promise<string | null> {
  if (!sharingSupported()) return null;
  const f = readFile();
  if (!f) return null;
  if (f.mode !== 'never' && !pidAlive(f.pid)) {
    log.info('discarding a shared session left by a process that is no longer running');
    remove();
    return null;
  }
  const key = await dpapi('unprotect', f.blob);
  if (!key || fingerprint(key.trim()) !== f.fp) {
    log.warn('the shared session could not be read; discarding it');
    remove();
    return null;
  }
  return key.trim();
}
