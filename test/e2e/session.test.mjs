import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, unlocked, MASTER_PASSWORD, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';

test('signing in happens in a desktop window, never in the conversation', async (t) => {
  const s = await startServer({ seedState: { status: 'unauthenticated', userEmail: null, userId: null } });
  t.after(() => s.close());

  const before = await s.callJson('vault_status');
  assert.equal(before.json.data.state, 'unauthenticated');
  assert.match(before.json.hint, /vault_login/);

  const { result, json } = await s.callJson('vault_login');
  assert.equal(result.isError, undefined);
  assert.equal(json.data.state, 'unlocked');

  // The dialog asked for the password; the tool's own schema has no field for one, so there
  // is no way for a model to supply or capture it.
  const asked = s.prompts().find((p) => p.kind === 'form');
  assert.ok(asked.fields.some((f) => f.name === 'password' && f.secret));
  const { tools } = await s.client.listTools();
  const login = tools.find((x) => x.name === 'vault_login');
  assert.deepEqual(login.inputSchema.properties ?? {}, {});

  // And the master password is nowhere in the transcript or the log.
  assert.ok(!JSON.stringify(result).includes(MASTER_PASSWORD));
  assert.ok(!(s.logText() + s.stderrText()).includes(MASTER_PASSWORD));
});

test('a wrong master password is reported without unlocking', async (t) => {
  const s = await startServer({ env: { FAKE_PROMPT_PASSWORD: 'wrong' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_unlock');
  assert.equal(result.isError, true);
  assert.match(json.error, /not accepted/i);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');
});

test('dismissing the window leaves the vault alone', async (t) => {
  const s = await startServer({ env: { FAKE_PROMPT_ANSWER: 'cancel' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_unlock');
  assert.equal(result.isError, true);
  assert.match(json.error, /dismissed/i);
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');
});

test('a two-step account is told what it needs, not left guessing', async (t) => {
  const s = await startServer({
    seedState: { status: 'unauthenticated', userEmail: null, userId: null },
    env: { FAKE_BW_REQUIRE_2FA: '1' },
  });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_login');
  assert.equal(result.isError, true);
  assert.match(json.error, /two-step/i);

  // The sign-in window offered a code field all along, so the retry needs no new plumbing.
  const form = s.prompts().find((p) => p.kind === 'form');
  assert.ok(form.fields.some((f) => f.name === 'code'));
});

test('the empty-session-key bug in the CLI is worked around, not passed on', async (t) => {
  // Some released versions of the CLI return an empty session key on the first unlock after
  // a login, and only recover once the vault is locked again.
  const s = await startServer({ env: { FAKE_BW_EMPTY_UNLOCK_ONCE: '1' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_unlock');
  assert.equal(result.isError, undefined, 'the retry should have recovered the session');
  assert.equal(json.data.state, 'unlocked');

  const read = await s.callJson('vault_get_item', { id: GITHUB });
  assert.equal(read.json.data.name, 'GitHub');
});

test('status is read from stdout even when the CLI exits non-zero', async (t) => {
  // The CLI prints valid JSON and exits 1 when it cannot reach the server. Treating the exit
  // code as authoritative would report a broken install instead of an offline server.
  const s = await startServer({ env: { FAKE_BW_STATUS_EXIT1: '1' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_status');
  assert.equal(result.isError, undefined);
  assert.equal(json.data.state, 'locked');
  assert.equal(json.data.server, 'vault.example.com');
});

test('a server that cannot be reached says so plainly', async (t) => {
  const s = await unlocked({ env: { FAKE_BW_FAIL: 'sync' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_sync');
  assert.equal(result.isError, true);
  assert.match(json.error, /could not reach/i);
  assert.match(json.hint, /server URL/i);
});

test('locking forgets the session and everything staged with it', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const staged = await s.callJson('vault_trash_item', { id: GITHUB });
  await s.call('vault_lock');
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');

  // A pending action does not survive a lock: confirming after one would be acting on an
  // intention formed under a session that has since ended.
  const late = await s.callJson('vault_ui_confirm', { action_id: staged.json.data.actionId });
  assert.equal(late.result.isError, true);
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).deletedDate, null);
});

test('the vault locks itself after a spell of inactivity', async (t) => {
  const s = await unlocked({ env: { VW_MCP_IDLE_LOCK_MIN: '0.02' } }); // ~1.2 seconds
  t.after(() => s.close());

  assert.equal((await s.callJson('vault_status')).json.data.state, 'unlocked');
  await new Promise((r) => setTimeout(r, 2200));
  const after = await s.callJson('vault_status');
  assert.equal(after.json.data.state, 'locked');

  const blocked = await s.callJson('vault_get_item', { id: GITHUB });
  assert.equal(blocked.result.isError, true);
});

test('activity postpones the idle lock', async (t) => {
  const s = await unlocked({ env: { VW_MCP_IDLE_LOCK_MIN: '0.05' } }); // ~3 seconds
  t.after(() => s.close());

  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 900));
    await s.call('vault_search', { query: 'GitHub' });
  }
  assert.equal((await s.callJson('vault_status')).json.data.state, 'unlocked');
});

test('by default the vault stays open until the process ends', async (t) => {
  // No idle timer: the session dies with this process, which is when Claude Desktop closes.
  // An idle lock that fires mid-conversation is a password prompt in the middle of something.
  const s = await unlocked();
  t.after(() => s.close());

  const { json } = await s.callJson('vault_status');
  assert.equal(json.data.state, 'unlocked');
  assert.equal(json.data.autoLockMinutes, undefined);
  assert.equal(json.data.locksInSeconds, undefined);
});

test('an idle lock is still available for anyone who wants one', async (t) => {
  const s = await unlocked({ env: { VW_MCP_IDLE_LOCK_MIN: '15' } });
  t.after(() => s.close());

  const { json } = await s.callJson('vault_status');
  assert.equal(json.data.autoLockMinutes, 15);
  assert.ok(json.data.locksInSeconds > 800 && json.data.locksInSeconds <= 900);
});

test('a session key supplied at launch is adopted for headless use', async (t) => {
  // A host with no desktop to draw a window on can still be given an already-unlocked vault.
  const home = path.join(process.env.TEMP ?? '/tmp', `vw-seed-${Date.now()}`);
  fs.mkdirSync(path.join(home, 'bw'), { recursive: true });
  const { seedVault } = await import('../helpers/server.mjs');
  const state = seedVault(path.join(home, 'bw'));
  state.session = 'preloaded-session-key==';
  fs.writeFileSync(path.join(home, 'bw', 'fake-vault.json'), JSON.stringify(state, null, 2));

  const s = await startServer({ seed: false, env: { VW_MCP_HOME: home, BW_SESSION: 'preloaded-session-key==' } });
  t.after(async () => {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const { json } = await s.callJson('vault_status');
  assert.equal(json.data.state, 'unlocked');
  const read = await s.callJson('vault_get_item', { id: GITHUB });
  assert.equal(read.json.data.name, 'GitHub');
  assert.equal(s.prompts().length, 0, 'no window should have been raised');
});

test('a bogus session key from the environment is ignored, not trusted', async (t) => {
  const s = await startServer({ env: { BW_SESSION: 'not-a-real-session' } });
  t.after(() => s.close());

  const { json } = await s.callJson('vault_status');
  assert.equal(json.data.state, 'locked');
});

test('the server URL is never taken from the model', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // Repointing the CLI at another host, then asking for a sign-in, is how a master password
  // gets phished. There is no tool for it: the instance is set at install time.
  const { tools } = await s.client.listTools();
  const names = tools.map((x) => x.name);
  assert.ok(!names.some((n) => /configure|server|instance|url/i.test(n)), `a server-setting tool exists: ${names}`);
  for (const t2 of tools) {
    const props = Object.keys(t2.inputSchema?.properties ?? {});
    assert.ok(!props.some((p) => /server|host|instance|endpoint/i.test(p)), `${t2.name} accepts a server address`);
  }
});

test('the clipboard clears itself, and only if it still holds the secret', async (t) => {
  const s = await unlocked({ env: { VW_MCP_CLIPBOARD_CLEAR_SECONDS: '1' } });
  t.after(() => s.close());

  await s.call('vault_ui_copy', { id: GITHUB, field: 'password' });
  assert.equal(s.clipboard(), `${SENTINEL}-password`);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(s.clipboard(), '', 'the password was left on the clipboard');

  // Something the user copied afterwards must survive.
  await s.call('vault_ui_copy', { id: GITHUB, field: 'password' });
  fs.writeFileSync(s.clipFile, 'something the user copied');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(s.clipboard(), 'something the user copied', 'the user’s own clipboard was wiped');
});

test('the server reports what it is and what it is for', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const info = s.client.getServerVersion();
  assert.equal(info.name, 'vaultwarden');
  assert.match(info.version, /^\d+\.\d+\.\d+/);

  const instructions = s.client.getInstructions();
  assert.match(instructions, /untrusted content/i);
  assert.match(instructions, /never ask the user to type a master password into the chat/i);
  assert.match(instructions, /until they press Save or Confirm, nothing has happened/i);
});

test('the card may reach exactly one origin, and it is the vault itself', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { resources } = await s.client.listResources();
  const card = resources.find((r) => r.uri === 'ui://vaultwarden/card.html');
  assert.ok(card, 'the card resource should be advertised');
  assert.equal(card.mimeType, 'text/html;profile=mcp-app');

  const read = await s.client.readResource({ uri: 'ui://vaultwarden/card.html' });
  const body = read.contents[0];
  assert.equal(body.mimeType, 'text/html;profile=mcp-app');

  // Site icons come from the user's own instance, which already holds every one of these
  // items. No other origin may serve this card anything.
  assert.deepEqual(body._meta.ui.csp.resourceDomains, ['https://vault.example.com']);
  // And it still cannot make a request of its own, to anywhere.
  assert.deepEqual(body._meta.ui.csp.connectDomains, []);

  assert.ok(body.text.includes('<style>'), 'the card should be a complete document');
  assert.ok(!/\bsrc\s*=\s*["']https?:/i.test(body.text), 'the card must not hard-code a remote source');
});

test('with no instance configured the card gets no origins at all', async (t) => {
  const s = await unlocked({ env: { VW_MCP_SERVER_URL: '' } });
  t.after(() => s.close());

  const read = await s.client.readResource({ uri: 'ui://vaultwarden/card.html' });
  assert.deepEqual(read.contents[0]._meta.ui.csp.resourceDomains, []);
});
