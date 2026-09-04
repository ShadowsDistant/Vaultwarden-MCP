import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, parseCommand } from './config.js';
import { log } from './log.js';

/**
 * Native dialogs, owned by the server process.
 *
 * The master password is asked for in a real OS window, not in the chat. That is the whole
 * point: what the user types goes down a pipe into this process and straight into the
 * environment of one `bw` child. It never enters an MCP message, so it is never in the
 * transcript, never in the model's context, and never in a host log.
 *
 * A dialog is also the only way an action gets confirmed on a host with no card support,
 * and the only way a password is ever released to the model.
 */

export type PromptField = {
  name: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  value?: string;
};

export type PromptSpec = {
  kind: 'form' | 'confirm';
  title: string;
  message: string;
  fields?: PromptField[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive and makes Cancel the default. */
  danger?: boolean;
};

export type PromptResult = { ok: true; values: Record<string, string> } | { ok: false; reason: 'cancelled' | 'timeout' | 'unavailable' };

const DIALOG_TIMEOUT_MS = 3 * 60_000;

/**
 * One dialog at a time, and not many in a row. A model that keeps calling `vault_unlock`
 * would otherwise stack windows on the user's screen until one is clicked out of fatigue.
 */
let open = false;
const recent: number[] = [];
const MAX_DIALOGS = 5;
const WINDOW_MS = 10 * 60_000;

export class PromptError extends Error {
  constructor(
    public code: 'dialog_busy' | 'dialog_rate_limited' | 'no_dialog' | 'cancelled' | 'timeout',
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'PromptError';
  }
}

export function dialogsAvailable(): boolean {
  if (CONFIG.promptCmd) return true;
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
}

function commandFor(): { cmd: string; args: string[] } | null {
  if (CONFIG.promptCmd) return parseCommand(CONFIG.promptCmd);
  const script = (name: string) => path.join(CONFIG.scriptsDir, name);
  if (process.platform === 'win32') {
    const ps1 = script('secure-prompt.ps1');
    if (!fs.existsSync(ps1)) return null;
    // -STA is required for WPF. -ExecutionPolicy Bypass is required because the client
    // default policy is Restricted, under which -File fails with no useful message.
    return {
      cmd: CONFIG.powershell,
      args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    };
  }
  if (process.platform === 'darwin') {
    const js = script('secure-prompt-mac.mjs');
    if (!fs.existsSync(js)) return null;
    return { cmd: process.execPath, args: [js] };
  }
  const js = script('secure-prompt-linux.mjs');
  if (!fs.existsSync(js)) return null;
  return { cmd: process.execPath, args: [js] };
}

/**
 * Shows a dialog and resolves with what the user typed. Never call this while holding the
 * bw lock: the window can sit on screen for minutes, and every other vault operation would
 * queue behind it.
 */
export async function prompt(spec: PromptSpec): Promise<PromptResult> {
  if (open) {
    throw new PromptError('dialog_busy', 'A vault dialog is already open on screen.', 'Answer or dismiss it, then try again.');
  }
  const now = Date.now();
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_DIALOGS) {
    throw new PromptError(
      'dialog_rate_limited',
      'Too many vault dialogs in a short time.',
      'This limit exists so repeated prompts cannot wear down a yes. Wait a few minutes.',
    );
  }

  const target = commandFor();
  if (!target) {
    throw new PromptError(
      'no_dialog',
      'No native dialog is available on this system.',
      'Unlock the vault outside Claude and start the server with BW_SESSION set.',
    );
  }

  open = true;
  recent.push(now);
  try {
    return await new Promise<PromptResult>((resolve) => {
      const child = spawn(target.cmd, target.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, VW_PROMPT: '1' },
      });
      let out = '';
      let err = '';
      let settled = false;
      const done = (r: PromptResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done({ ok: false, reason: 'timeout' });
      }, DIALOG_TIMEOUT_MS);

      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (err += String(d)));
      child.on('error', (e) => {
        log.error('dialog failed to start', e);
        done({ ok: false, reason: 'unavailable' });
      });
      child.on('close', () => {
        const trimmed = out.trim();
        if (!trimmed) {
          if (err.trim()) log.warn('dialog exited with no answer', { stderr: err.trim().slice(0, 200) });
          done({ ok: false, reason: 'cancelled' });
          return;
        }
        try {
          const parsed = JSON.parse(trimmed.slice(trimmed.search(/[[{]/))) as { ok?: boolean; values?: Record<string, string> };
          if (parsed.ok) done({ ok: true, values: parsed.values ?? {} });
          else done({ ok: false, reason: 'cancelled' });
        } catch {
          log.warn('dialog produced unparseable output');
          done({ ok: false, reason: 'cancelled' });
        }
      });

      child.stdin.write(JSON.stringify(spec));
      child.stdin.end();
    });
  } finally {
    open = false;
  }
}

/** A yes/no dialog. Returns true only on an explicit confirmation. */
export async function confirm(title: string, message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  const r = await prompt({
    kind: 'confirm',
    title,
    message,
    confirmLabel: opts.confirmLabel ?? 'Confirm',
    cancelLabel: 'Cancel',
    danger: opts.danger,
  });
  return r.ok;
}

/** Resets the rate limiter. Tests only. */
export function resetPromptLimits(): void {
  recent.length = 0;
  open = false;
}
