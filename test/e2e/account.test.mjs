// The Settings app's channel into the server: signing in, two-step codes, API keys, unlocking,
// locking and signing out. The app is a separate program, so these tests talk to the pipe the
// way it does: one JSON line in, one JSON line out, with the token from status.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_PASSWORD, ROOT, SENTINEL, startServer } from '../helpers/server.mjs';

const URL_ = 'https://vault.example.com';

async function signedOut(env = {}) {
  const s = await startServer({ env });
  await s.ipc({ op: 'logout' });
  return s;
}

test('the channel refuses a request without the right token', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const r = await s.ipc({ op: 'status' }, { token: '00'.repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unauthorized');
  const bad = await s.ipc({ op: 'status' }, { token: 'not-hex' });
  assert.equal(bad.ok, false);
});

test('status over the channel says where the vault is and what state it is in', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const r = await s.ipc({ op: 'status' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'locked');
  assert.equal(r.serverHost, 'vault.example.com');
  // The status file learns the vault state in the background, a moment after start.
  for (let i = 0; i < 80 && !s.statusFile()?.vault; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(s.statusFile().vault.state, 'locked');
  assert.ok(!JSON.stringify(s.statusFile()).includes('shado@example.com'), 'the status file still carries no email');
});

test('signing in from the Settings app unlocks the vault for the chat, with no dialog', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  const before = s.prompts().length;
  const r = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.deepEqual(r, { ok: true, state: 'unlocked' });
  const st = await s.callJson('vault_status');
  assert.equal(st.json.data.state, 'unlocked');
  assert.equal(s.prompts().length, before, 'no desktop dialog was needed');
  assert.ok(!s.logText().includes(MASTER_PASSWORD), 'the password is not logged');
  assert.equal(s.statusFile().vault.state, 'unlocked');
});

test('a wrong password is reported, and nothing is unlocked', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  const r = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_password');
  assert.ok(!JSON.stringify(r).includes('nope'), 'the reply never echoes the password');
});

test('a two-step account is asked for a code, and an emailed code is sent on request', async (t) => {
  const s = await signedOut({ FAKE_BW_REQUIRE_2FA: '1' });
  t.after(() => s.close());
  const first = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.equal(first.error, 'code_required');
  assert.match(first.message, /API key/, 'mentions the way through for a new-device check');

  const send = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 1 });
  assert.equal(send.error, 'code_required');
  assert.match(send.message, /emailed/);

  const wrong = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 1, code: '000000' });
  assert.equal(wrong.error, 'bad_code');

  const right = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 1, code: '123 456' });
  assert.deepEqual(right, { ok: true, state: 'unlocked' });
  assert.ok(!s.logText().includes('123456'), 'two-step codes are not logged');
});

test('an authenticator-app code signs in with one request', async (t) => {
  const s = await signedOut({ FAKE_BW_REQUIRE_2FA: '1', FAKE_BW_2FA_PROVIDERS: '0' });
  t.after(() => s.close());
  const r = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 0, code: '123456' });
  assert.deepEqual(r, { ok: true, state: 'unlocked' });
  assert.equal((await s.callJson('vault_status')).json.data.state, 'unlocked');
});

test('an account with several two-step methods is asked to choose, and a wrong code is named as such', async (t) => {
  const s = await signedOut({ FAKE_BW_REQUIRE_2FA: '1', FAKE_BW_2FA_PROVIDERS: '0,1' });
  t.after(() => s.close());
  // The real CLI says "Login failed. No provider selected." here; that is a question, not a failure.
  const first = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.equal(first.error, 'code_required');
  assert.match(first.message, /Choose how you get your codes/);

  const wrong = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 0, code: '654321' });
  assert.equal(wrong.error, 'bad_code');

  const notSetUp = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 3, code: 'cccccc' });
  assert.equal(notSetUp.error, 'bad_code');
  assert.match(notSetUp.message, /isn't set up/);

  const right = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 0, code: '123456' });
  assert.deepEqual(right, { ok: true, state: 'unlocked' });
});

test('a wrong master password on unlock is named as one, not as an unknown error', async (t) => {
  // CLI 2026.8 says "Cryptography error, The decryption operation failed" for this.
  const s = await startServer();
  t.after(() => s.close());
  const r = await s.ipc({ op: 'unlock', password: 'not it' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_password');
  assert.match(r.message, /sign out and sign in again/);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');
  const ok = await s.ipc({ op: 'unlock', password: MASTER_PASSWORD });
  assert.deepEqual(ok, { ok: true, state: 'unlocked' });
});

test('an unsupported two-step method is refused before the CLI is asked', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  s.resetBwCalls();
  const r = await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD, method: 7 });
  assert.equal(r.ok, false);
  assert.equal(s.bwCalls().filter((c) => c.startsWith('login')).length, 0);
});

test('a personal API key signs in, and the master password unlocks', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  const id = 'user.12345678-1234-4234-8234-123456789abc';
  const bad = await s.ipc({ op: 'login_apikey', serverUrl: URL_, clientId: id, clientSecret: 'wrong', password: MASTER_PASSWORD });
  assert.equal(bad.ok, false);
  const r = await s.ipc({ op: 'login_apikey', serverUrl: URL_, clientId: id, clientSecret: 'api-secret', password: MASTER_PASSWORD });
  assert.deepEqual(r, { ok: true, state: 'unlocked' });
  assert.ok(!s.logText().includes('api-secret'));
});

test('a signed-in account is never moved to another server', async (t) => {
  const s = await startServer({ env: { VW_MCP_SERVER_URL: '' } });
  t.after(() => s.close());
  const r = await s.ipc({ op: 'login', serverUrl: 'https://evil.example.net', email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'signed_in_elsewhere');
});

test('an address pinned by the install cannot be changed from the app', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  const r = await s.ipc({ op: 'login', serverUrl: 'https://other.example.org', email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.equal(r.error, 'fixed_url');
});

test('plain http to a remote host is refused', async (t) => {
  const s = await signedOut({ VW_MCP_SERVER_URL: '' });
  t.after(() => s.close());
  const r = await s.ipc({ op: 'login', serverUrl: 'http://vault.example.com', email: 'shado@example.com', password: MASTER_PASSWORD });
  assert.equal(r.error, 'invalid_url');
});

test('lock and sign out from the app take effect in the chat', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  assert.equal((await s.ipc({ op: 'unlock', password: MASTER_PASSWORD })).ok, true);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'unlocked');
  assert.equal((await s.ipc({ op: 'lock' })).ok, true);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');
  assert.equal((await s.ipc({ op: 'logout' })).ok, true);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'unauthenticated');
});

test('repeated sign-in attempts are cut off', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await s.ipc({ op: 'unlock', password: 'nope' });
    if (r.error === 'rate_limited') limited = true;
  }
  assert.ok(limited);
});

test('nothing on the channel ever carries a vault secret', async (t) => {
  const s = await signedOut();
  t.after(() => s.close());
  const replies = [
    await s.ipc({ op: 'login', serverUrl: URL_, email: 'shado@example.com', password: MASTER_PASSWORD }),
    await s.ipc({ op: 'status' }),
  ];
  assert.ok(!JSON.stringify(replies).includes(SENTINEL));
  assert.ok(!JSON.stringify(s.statusFile()).includes(SENTINEL));
});

test('without the Settings app, a first sign-in window asks for the vault address too', async (t) => {
  const s = await startServer({
    env: { VW_MCP_SERVER_URL: '', FAKE_PROMPT_SERVER: 'https://vault.bitwarden.eu' },
    seedState: { status: 'unauthenticated', userEmail: null, userId: null, serverUrl: null },
  });
  t.after(() => s.close());
  assert.equal((await s.callJson('vault_status')).json.data.state, 'unconfigured');
  const r = await s.callJson('vault_login');
  assert.equal(r.json.data.state, 'unlocked');
  const asked = s.prompts().find((p) => p.kind === 'form');
  assert.equal(asked.fields[0].name, 'server');
  assert.equal(s.vault().serverUrl, 'https://vault.bitwarden.eu');
});

test('on Windows with the Settings app, signing in opens the app instead of a window', { skip: process.platform !== 'win32' }, async (t) => {
  // A stand-in that starts and exits at once (node rejects the --home flag), so nothing stays
  // on screen: the server checks that the app is there, writes the page request, and starts it.
  const exe = process.execPath;
  const s = await startServer({
    env: { VW_MCP_SETTINGS_EXE: exe },
    seedState: { status: 'unauthenticated', userEmail: null, userId: null },
  });
  t.after(() => s.close());
  const r = await s.callJson('vault_login');
  assert.match(r.json.hint, /Settings is open/);
  assert.equal(s.prompts().length, 0, 'no password window');
  const req = JSON.parse(fs.readFileSync(path.join(s.home, 'launch-request.json'), 'utf8'));
  assert.equal(req.page, 'account');
});

test('if the Settings app will not start, signing in falls back to the window', { skip: process.platform !== 'win32' }, async (t) => {
  const s = await startServer({
    env: { VW_MCP_SETTINGS_EXE: path.join(ROOT, 'package.json') },
    seedState: { status: 'unauthenticated', userEmail: null, userId: null },
  });
  t.after(() => s.close());
  const r = await s.callJson('vault_login');
  assert.equal(r.json.data.state, 'unlocked');
  assert.ok(s.prompts().some((p) => p.kind === 'form'));
});
