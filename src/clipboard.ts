import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, parseCommand } from './config.js';
import { log } from './log.js';

/**
 * Copying a secret to the OS clipboard.
 *
 * This is the preferred way to get a password out of the vault and into wherever the user
 * needs it: unlike revealing it in the card, the value never crosses the MCP boundary at
 * all — the server writes it straight into the clipboard, and the model is told only that a
 * copy happened.
 *
 * The value is cleared afterwards, but only if the clipboard still holds it. Wiping
 * whatever the user copied in the meantime would be its own small betrayal.
 */

const timers = new Map<string, NodeJS.Timeout>();

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

type HelperResult = { code: number; stdout: string; stderr: string };

function runHelper(args: string[], stdin?: string): Promise<HelperResult> {
  let cmd: string;
  let argv: string[];

  const override = CONFIG.clipboardCmd ? parseCommand(CONFIG.clipboardCmd) : null;
  if (override) {
    cmd = override.cmd;
    argv = [...override.args, ...args];
  } else if (process.platform === 'win32') {
    cmd = CONFIG.powershell;
    argv = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(CONFIG.scriptsDir, 'clip.ps1'), ...args];
  } else if (process.platform === 'darwin') {
    cmd = process.execPath;
    argv = [path.join(CONFIG.scriptsDir, 'clip-mac.mjs'), ...args];
  } else {
    cmd = process.execPath;
    argv = [path.join(CONFIG.scriptsDir, 'clip-linux.mjs'), ...args];
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (child.stdin) {
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export function clipboardAvailable(): boolean {
  if (CONFIG.clipboardCmd) return true;
  const script =
    process.platform === 'win32' ? 'clip.ps1' : process.platform === 'darwin' ? 'clip-mac.mjs' : 'clip-linux.mjs';
  return fs.existsSync(path.join(CONFIG.scriptsDir, script));
}

/**
 * Puts `secret` on the clipboard and schedules its removal. `label` identifies the copy for
 * logging and is never the secret itself.
 */
export async function copySecret(secret: string, label: string): Promise<{ ok: boolean; clearsInSeconds: number }> {
  const seconds = CONFIG.clipboardClearSeconds;
  const r = await runHelper(['-Set'], secret);
  if (r.code !== 0) {
    log.warn('clipboard copy failed', { code: r.code, stderr: r.stderr.slice(0, 200) });
    return { ok: false, clearsInSeconds: 0 };
  }
  const digest = (r.stdout.trim() || sha256(secret)).toLowerCase();

  const existing = timers.get(digest);
  if (existing) clearTimeout(existing);
  if (seconds > 0) {
    const t = setTimeout(() => {
      timers.delete(digest);
      void runHelper(['-Clear', digest]).then((res) => {
        log.info('clipboard clear', { result: res.stdout.trim() || res.code });
      });
    }, seconds * 1000);
    t.unref?.();
    timers.set(digest, t);
  }
  log.audit('secret_copied', { what: label, clearsInSeconds: seconds });
  return { ok: true, clearsInSeconds: seconds };
}

/** Runs every pending clear immediately. Called on shutdown. */
export async function flushClipboardClears(): Promise<void> {
  const pending = [...timers.keys()];
  for (const digest of pending) {
    const t = timers.get(digest);
    if (t) clearTimeout(t);
    timers.delete(digest);
    await runHelper(['-Clear', digest]).catch(() => undefined);
  }
}
