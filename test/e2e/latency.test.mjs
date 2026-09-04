import test from 'node:test';
import assert from 'node:assert/strict';
import { unlocked, startServer, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';

/**
 * How many times the CLI is spawned, which is the only thing card latency is made of.
 *
 * Each invocation boots a fresh Node process and a webpack bundle, and costs two to four
 * seconds against a real vault. A reveal used to be three of them — check the session, fetch
 * the item, fetch the password — so pressing the eye did nothing visible for the better part
 * of ten seconds and got pressed again. These tests count spawns rather than measure time,
 * because the count is what the wall clock is made of and it does not vary by machine.
 */

test('reading an item does not ask the CLI what the session state is', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());
  s.resetBwCalls();

  await s.callJson('vault_get_item', { id: GITHUB });

  const calls = s.bwCalls();
  assert.deepEqual(
    calls.filter((c) => c.startsWith('status')),
    [],
    `the session state was re-checked against the CLI: ${calls.join(', ')}`,
  );
  assert.ok(calls.includes('get item'), `the item should have been fetched: ${calls.join(', ')}`);
});

test('revealing a password costs nothing beyond the item already in hand', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // Open the item, as the card does when it renders.
  await s.callJson('vault_ui_item', { id: GITHUB });
  s.resetBwCalls();

  const { json } = await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'password' });
  assert.equal(json.value, `${SENTINEL}-password`);

  const calls = s.bwCalls();
  assert.deepEqual(calls, [], `a reveal spawned the CLI ${calls.length} times: ${calls.join(', ')}`);
});

test('copying straight after revealing costs nothing either', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_ui_item', { id: GITHUB });
  await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'password' });
  s.resetBwCalls();

  const { json } = await s.callJson('vault_ui_copy', { id: GITHUB, field: 'password' });
  assert.equal(json.copied, 'password');
  assert.equal(s.clipboard(), `${SENTINEL}-password`);
  assert.deepEqual(s.bwCalls(), []);
});

test('a one-time code is still generated fresh, because the stored value is only a seed', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_ui_item', { id: GITHUB });
  s.resetBwCalls();

  await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'totp' });
  assert.deepEqual(s.bwCalls(), ['get totp'], 'a one-time code must not be served from a cache');
});

test('a write is visible immediately afterwards, not the version from before it', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_ui_item', { id: GITHUB });
  const staged = await s.callJson('vault_edit_item', { id: GITHUB, username: 'changed' });
  await s.call('vault_ui_confirm', { action_id: staged.json.data.actionId });

  const after = await s.callJson('vault_ui_item', { id: GITHUB });
  assert.equal(after.json.item.username, 'changed', 'a cached copy from before the edit was served');
});

test('a re-prompt item still asks, and is not waved through by a cached copy', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_ui_item', { id: BANK });
  const before = s.prompts().length;
  await s.callJson('vault_ui_reveal', { id: BANK, field: 'password' });
  assert.ok(s.prompts().length > before, 'the master password was not asked for again');
});

test('a session the CLI has stopped accepting is dropped rather than kept', async (t) => {
  // Two server processes can share one machine — Claude Desktop and a terminal session each
  // run their own — and `bw unlock` retires the previous key when the second one unlocks.
  // The first then holds a key the CLI will refuse, and must notice rather than keep failing.
  const s = await unlocked();
  t.after(() => s.close());

  assert.equal((await s.callJson('vault_status')).json.data.state, 'unlocked');

  // Something else unlocked: the stored session no longer matches the one this server holds.
  const vault = s.vault();
  vault.session = 'a-key-this-server-does-not-have==';
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(s.bwDir, 'fake-vault.json'), JSON.stringify(vault, null, 2));

  const refused = await s.callJson('vault_get_item', { id: GITHUB });
  assert.equal(refused.result.isError, true);
  assert.match(JSON.stringify(refused.json), /lock/i);

  // And now it reports honestly, instead of insisting it is open.
  assert.equal((await s.callJson('vault_status')).json.data.state, 'locked');
});

test('locking discards the decrypted items it was holding', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_ui_item', { id: GITHUB });
  await s.call('vault_lock');
  s.resetBwCalls();

  // Nothing may be served out of a cache that outlived the session that decrypted it.
  const after = await s.callJson('vault_ui_item', { id: GITHUB });
  assert.equal(after.result.isError, true);
  assert.ok(!JSON.stringify(after.result).includes(SENTINEL));
});

test('a locked vault is still explained properly, at the cost of one lookup', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.resetBwCalls();

  const { result, json } = await s.callJson('vault_get_item', { id: GITHUB });
  assert.equal(result.isError, true);
  assert.match(json.error, /locked/i);
  assert.match(json.hint, /unlock/i);
  // The slow path is only taken when the answer is already no.
  assert.ok(s.bwCalls().some((c) => c.startsWith('status')));
});
