import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

// stdout is the MCP transport. Everything here goes to stderr and, optionally, a file.
//
// Claude Desktop persists a server's stderr to %APPDATA%\Claude\logs\mcp-server-<name>.log,
// so this file is a plaintext artifact on disk that outlives the session. Nothing secret and
// nothing derived from vault content (item names, usernames, notes, URLs) may be logged —
// identify items by id only.

let fileReady = false;

function fileWrite(line: string): void {
  if (!CONFIG.logFile) return;
  try {
    if (!fileReady) {
      fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
      fileReady = true;
    }
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch {
    /* logging must never throw */
  }
}

/** Names whose values are never printed, whatever a caller passes. */
const SECRET_KEYS = /^(password|master_?password|totp|notes|session|bw_?session|raw|client_?secret|code|value|secret)$/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(val, depth + 1);
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ error: v.message, stack: v.stack });
    return JSON.stringify(scrub(v));
  } catch {
    return String(v);
  }
}

// When the host goes away, stderr is a dead pipe or socket. An unhandled EPIPE from it would
// reach uncaughtException, which logs, which writes to stderr again: a busy loop that pins a
// core and fills the log file. Once stderr has failed, stop writing to it.
let stderrDead = false;
process.stderr.on('error', () => {
  stderrDead = true;
});

function emit(level: string, msg: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  const line = `${stamp} [${level}] ${msg}${tail}`;
  if (!stderrDead) {
    try {
      process.stderr.write(line + '\n');
    } catch {
      stderrDead = true;
    }
  }
  fileWrite(line);
}

export const log = {
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
  /**
   * A security-relevant event: an unlock, a reveal, a write. Item ids only, never names.
   */
  audit: (event: string, extra?: Record<string, unknown>) => emit('audit', event, extra),
};
