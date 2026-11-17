// How the server runs, rather than what it says: the CLI inside a worker thread (the only way it
// can run inside Claude Desktop), lock modes, the trash switch, and the shared unlock between
// server processes on Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_PASSWORD, SENTINEL, startServer, unlocked, writeSettingsFile } from '../helpers/server.mjs';

test('the CLI runs in a worker thread when there is no Node to start it with', async (t) => {
  const s = await unlocked({ env: { VW_MCP_RUNNER: 'worker' } });
  t.after(() => s.close());
  const st = await s.callJson('vault_status');
  assert.equal(st.json.data.state, 'unlocked');
  const found = await s.callJson('vault_search', { query: 'GitHub' });
  assert.equal(found.json.data.items[0].name, 'GitHub');
  // stdin reaches the worker too: a create sends its item over stdin.
  const copied = await s.callJson('vault_copy_secret', { id: found.json.data.items[0].id });
  assert.equal(copied.json.data.copied, 'password');
  assert.equal(s.clipboard(), `${SENTINEL}-password`);
  assert.ok(!JSON.stringify(st.result).includes(SENTINEL));
});

test('lock mode "exit" keeps the vault open with no idle timer', async (t) => {
  const s = await unlocked({ settings: { lockMode: 'exit' } });
  t.after(() => s.close());
  const st = await s.callJson('vault_status');
  assert.equal(st.json.data.state, 'unlocked');
  assert.equal(st.json.data.locksInSeconds, undefined);
  assert.match(st.json.data.permissions.lock, /closes/);
});

test('an old settings file with only idleLockMinutes still means what it meant', async (t) => {
  const s = await unlocked({ settings: { idleLockMinutes: 5 } });
  t.after(() => s.close());
  const st = await s.callJson('vault_status');
  assert.ok(st.json.data.locksInSeconds > 200 && st.json.data.locksInSeconds <= 300);
});

test('a broken settings file cannot keep "never lock" in force', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());
  s.writeSettings('{ "lockMode": "never", ');
  const st = await s.callJson('vault_status');
  assert.match(st.json.data.permissions.lock, /closes/);
});

test('with trashing switched off, nothing can be moved to the trash, even from a card', async (t) => {
  const s = await unlocked({ settings: { allowTrash: false } });
  t.after(() => s.close());
  const id = '11111111-1111-4111-8111-111111111111';
  const r = await s.callJson('vault_trash_item', { id });
  assert.equal(r.result.isError, true);
  assert.match(r.json.error, /trash is switched off/);
  // Edits are still allowed.
  const e = await s.callJson('vault_edit_item', { id, name: 'GitHub (work)' });
  assert.notEqual(e.result.isError, true);

  // A trash staged while it was allowed cannot be confirmed after it is switched off.
  s.writeSettings({ allowTrash: true });
  const staged = await s.callJson('vault_trash_item', { id });
  s.writeSettings({ allowTrash: false });
  const c = await s.call('vault_ui_confirm', { action_id: staged.structured.actionId });
  assert.equal(c.isError, true);
  assert.equal(s.vault().items.find((i) => i.id === id).deletedDate, null);
});

const windows = process.platform === 'win32';

test('one unlock serves every server process, and one lock locks them all', { skip: !windows && 'DPAPI is Windows only' }, async (t) => {
  const env = { VW_MCP_SHARED_SESSION: '1' };
  const a = await startServer({ env });
  t.after(() => a.close());
  // The second server shares the first one's home: the same machine, a second chat.
  const b = await startServer({ env: { ...env, VW_MCP_HOME: a.home, VW_MCP_LOG_FILE: path.join(a.home, 'server-b.log') }, seed: false });
  t.after(() => b.close());

  assert.equal((await a.callJson('vault_unlock')).json.data.state, 'unlocked');
  assert.ok(fs.existsSync(path.join(a.home, 'session.json')), 'the shared copy is written');
  const raw = fs.readFileSync(path.join(a.home, 'session.json'), 'utf8');
  assert.ok(!raw.includes(a.vault().session), 'the key is not stored in the clear');

  const prompts = b.prompts().length;
  assert.equal((await b.callJson('vault_status')).json.data.state, 'unlocked', 'the second process picks it up');
  assert.equal(b.prompts().length, prompts, 'without asking for the password again');
  assert.equal((await b.callJson('vault_search', { query: 'GitHub' })).json.data.count, 1);

  await b.call('vault_lock');
  assert.ok(!fs.existsSync(path.join(a.home, 'session.json')));
  const after = await a.callJson('vault_search', { query: 'GitHub' });
  assert.equal(after.result.isError, true, 'the lock reached the first process too');
});

test('"never lock" survives a restart; any other mode does not', { skip: !windows && 'DPAPI is Windows only' }, async (t) => {
  const env = { VW_MCP_SHARED_SESSION: '1' };
  const a = await startServer({ env, settings: { lockMode: 'never' } });
  await a.call('vault_unlock');
  const home = a.home;
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Close without deleting the home, as an app restart would.
  await a.client.close();
  await new Promise((r) => setTimeout(r, 1500));

  const b = await startServer({ env: { ...env, VW_MCP_HOME: home, VW_MCP_LOG_FILE: path.join(home, 'server-b.log') }, seed: false });
  t.after(() => b.close());
  const prompts = b.prompts().length;
  assert.equal((await b.callJson('vault_status')).json.data.state, 'unlocked');
  assert.equal(b.prompts().length, prompts);

  // Switch to "exit" and restart again: now the vault is locked when the process goes.
  writeSettingsFile(home, { lockMode: 'exit' });
  const later = new Date(Date.now() + 3000);
  fs.utimesSync(path.join(home, 'settings.json'), later, later);
  await b.callJson('vault_status');
  await b.client.close();
  await new Promise((r) => setTimeout(r, 1500));
  const c = await startServer({ env: { ...env, VW_MCP_HOME: home, VW_MCP_LOG_FILE: path.join(home, 'server-c.log') }, seed: false });
  t.after(() => c.close());
  assert.equal((await c.callJson('vault_status')).json.data.state, 'locked');
  assert.ok(!fs.readFileSync(path.join(home, 'server-c.log'), 'utf8').includes(MASTER_PASSWORD));
});
