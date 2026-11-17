import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as activity from './activity.js';
import { log } from './log.js';
import * as session from './session.js';

/**
 * The Settings app's way into a running server, for the account operations that need the
 * Bitwarden CLI: signing in, unlocking, locking, signing out.
 *
 * Why not let the app run the CLI itself: inside Claude Desktop there is no Node executable on
 * the machine to run it with (see noderun.ts), and the server already owns the CLI, its data
 * directory and its lock.
 *
 * The channel is a named pipe (a Unix socket elsewhere) with a random name, answering only
 * requests that carry a random token. Both are written to status.json in the user's own profile,
 * which is exactly the set of people who could already drive the vault. A browser cannot reach a
 * named pipe, and the model has no tool that touches any of this.
 *
 * One JSON line in, one JSON line out, then the connection closes. Passwords arrive here and go
 * straight into one CLI call's environment, as they do from the unlock dialog. They are never
 * logged, and no reply ever contains one.
 */

export type IpcInfo = { pipe: string; token: string };

const MAX_REQUEST = 64 * 1024;

let busy = false;
const attempts: number[] = [];

function rateLimited(): boolean {
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 5 * 60_000) attempts.shift();
  if (attempts.length >= 10) return true;
  attempts.push(now);
  return false;
}

function tokenMatches(expected: Buffer, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length * 2) return false;
  const buf = Buffer.from(given, 'hex');
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

type Request = Record<string, unknown> & { op?: unknown; token?: unknown };

async function handle(req: Request, onChange: () => void): Promise<Record<string, unknown>> {
  const op = String(req.op ?? '');
  switch (op) {
    case 'status': {
      const st = await session.status();
      return {
        ok: true,
        state: st.state,
        email: st.email,
        serverUrl: st.serverUrl,
        serverHost: st.serverHost,
        lastSync: st.lastSync,
        lockMode: st.lockMode,
      };
    }
    case 'login':
    case 'login_apikey':
    case 'unlock': {
      if (busy) return { ok: false, error: 'busy', message: 'Another sign-in is still running.' };
      if (rateLimited()) return { ok: false, error: 'rate_limited', message: 'Too many attempts. Wait a few minutes and try again.' };
      busy = true;
      try {
        const r =
          op === 'login'
            ? await session.signIn({
                serverUrl: String(req.serverUrl ?? ''),
                email: String(req.email ?? ''),
                password: String(req.password ?? ''),
                method: typeof req.method === 'number' ? req.method : undefined,
                code: typeof req.code === 'string' && req.code.trim() ? req.code : undefined,
              })
            : op === 'login_apikey'
              ? await session.signInWithApiKey({
                  serverUrl: String(req.serverUrl ?? ''),
                  clientId: String(req.clientId ?? ''),
                  clientSecret: String(req.clientSecret ?? ''),
                  password: String(req.password ?? ''),
                })
              : await session.unlockWithPassword(String(req.password ?? ''));
        log.audit('settings_app_account', { op, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
        // Asking for the two-step code is a step of signing in, not a failure of it. Messages
        // that name the account's email are replaced, since the log holds no account names.
        if (r.ok || r.error !== 'code_required') {
          activity.record({
            actor: 'settings_app',
            action: op === 'unlock' ? 'unlock' : 'sign_in',
            ok: r.ok,
            ...(op === 'login_apikey' ? { via: 'api_key' } : {}),
            ...(r.ok ? {} : { outcome: r.error, error: r.error === 'signed_in_elsewhere' ? 'Already signed in to another account or server.' : r.message }),
          });
        }
        return r.ok ? { ok: true, state: 'unlocked' } : r;
      } finally {
        busy = false;
        onChange();
      }
    }
    case 'lock':
      await session.lock();
      log.audit('settings_app_account', { op, ok: true });
      activity.record({ actor: 'settings_app', action: 'lock', ok: true });
      onChange();
      return { ok: true };
    case 'logout':
      await session.logout();
      log.audit('settings_app_account', { op, ok: true });
      activity.record({ actor: 'settings_app', action: 'sign_out', ok: true });
      onChange();
      return { ok: true };
    default:
      return { ok: false, error: 'unknown', message: 'Unknown request.' };
  }
}

/**
 * Starts listening. Resolves with what the Settings app needs to connect, or null if the pipe
 * could not be opened (the app then explains that sign-in has to wait).
 */
export function startIpc(onChange: () => void): Promise<IpcInfo | null> {
  const token = randomBytes(32);
  const name = `bitwarden-mcp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    let buf = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(15_000, () => {
      if (!handled) socket.destroy();
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      // The CLI can take a while; the reply timeout is the app's to keep, not ours.
      socket.setTimeout(0);
      const line = buf.slice(0, nl);
      buf = '';
      void (async () => {
        let reply: Record<string, unknown>;
        try {
          const req = JSON.parse(line) as Request;
          if (!req || typeof req !== 'object' || !tokenMatches(token, req.token)) {
            log.warn('settings app request refused: bad token');
            reply = { ok: false, error: 'unauthorized', message: 'Refused.' };
          } else {
            reply = await handle(req, onChange);
          }
        } catch (e) {
          log.warn('settings app request failed', { error: e instanceof Error ? e.message : String(e) });
          reply = { ok: false, error: 'unknown', message: 'The request could not be handled.' };
        }
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
      })();
    });
  });
  server.maxConnections = 4;

  return new Promise((resolve) => {
    server.once('error', (e) => {
      log.warn('could not open the Settings app channel', { error: e.message });
      resolve(null);
    });
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(address, { force: true });
      } catch {
        /* nothing there */
      }
    }
    server.listen(address, () => {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(address, 0o600);
        } catch {
          /* best effort */
        }
      }
      server.unref();
      log.info('settings app channel open');
      resolve({ pipe: process.platform === 'win32' ? name : address, token: token.toString('hex') });
    });
    const cleanup = (): void => {
      try {
        server.close();
        if (process.platform !== 'win32') fs.rmSync(address, { force: true });
      } catch {
        /* exiting anyway */
      }
    };
    process.once('exit', cleanup);
  });
}

