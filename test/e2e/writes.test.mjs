import test from 'node:test';
import assert from 'node:assert/strict';
import { unlocked, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';
const DEV_FOLDER = 'ffffffff-1111-4111-8111-111111111111';

/**
 * The other half of the design: a model can propose a change but cannot make one. Each of
 * these checks the vault on disk, not just what the tool said.
 */

test('creating a login writes nothing until the card saves it', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const before = s.vault().items.length;
  const { json, structured } = await s.callJson('vault_create_login', {
    name: 'Fastmail',
    username: 'shado@fastmail.com',
    uri: 'https://app.fastmail.com',
    folder_id: DEV_FOLDER,
  });

  assert.equal(json.data.saved, false);
  assert.ok(json.data.draftId);
  assert.equal(json.data.passwordGenerated, true);
  assert.match(json.hint, /Nothing has been saved/i);
  // The model never receives the generated password, only the card does.
  assert.equal(json.data.password, undefined);
  assert.ok(structured.secret.length >= 20);
  assert.equal(s.vault().items.length, before, 'the vault changed before anyone confirmed');

  // Now the card presses Save.
  const saved = await s.callJson('vault_ui_save_draft', {
    draft_id: json.data.draftId,
    name: 'Fastmail',
    username: 'shado@fastmail.com',
    uri: 'https://app.fastmail.com',
    password: structured.secret,
    folder_id: DEV_FOLDER,
  });
  assert.equal(saved.json.saved, true);

  const items = s.vault().items;
  assert.equal(items.length, before + 1);
  const created = items.find((i) => i.name === 'Fastmail');
  assert.equal(created.login.username, 'shado@fastmail.com');
  assert.equal(created.login.password, structured.secret);
  assert.equal(created.folderId, DEV_FOLDER);
  assert.equal(created.login.uris[0].uri, 'https://app.fastmail.com');
});

test('a draft can only be saved once', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_create_login', { name: 'Once' });
  const args = { draft_id: json.data.draftId, name: 'Once', password: structured.secret };
  const first = await s.callJson('vault_ui_save_draft', args);
  assert.equal(first.json.saved, true);

  const second = await s.callJson('vault_ui_save_draft', args);
  assert.equal(second.result.isError, true);
  assert.match(second.json.error, /expired/i);
  assert.equal(s.vault().items.filter((i) => i.name === 'Once').length, 1, 'a replayed save created a duplicate');
});

test('a draft expires', async (t) => {
  const s = await unlocked({ env: { VW_MCP_PENDING_TTL_MS: '400' } });
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_create_login', { name: 'Slow' });
  await new Promise((r) => setTimeout(r, 700));
  const late = await s.callJson('vault_ui_save_draft', {
    draft_id: json.data.draftId,
    name: 'Slow',
    password: structured.secret,
  });
  assert.equal(late.result.isError, true);
  assert.match(late.json.error, /expired/i);
  assert.equal(s.vault().items.some((i) => i.name === 'Slow'), false);
});

test('an edit is staged, shown as a diff, and only applied on confirm', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_edit_item', { id: GITHUB, username: 'newname' });
  assert.equal(json.data.applied, false);
  assert.ok(json.data.actionId);
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).login.username, 'shadowsdistant');

  // The card is given a before-and-after so the person can see what they are agreeing to.
  const row = structured.rows.find((r) => r.label === 'Username');
  assert.equal(row.before, 'shadowsdistant');
  assert.equal(row.after, 'newname');

  const done = await s.callJson('vault_ui_confirm', { action_id: json.data.actionId });
  assert.equal(done.json.saved, true);
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).login.username, 'newname');
});

test('an edit preserves everything it was not asked to change', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // `bw edit` replaces the whole cipher, so a careless patch silently destroys the password.
  const { json } = await s.callJson('vault_edit_item', { id: GITHUB, name: 'GitHub (work)' });
  await s.call('vault_ui_confirm', { action_id: json.data.actionId });

  const after = s.vault().items.find((i) => i.id === GITHUB);
  assert.equal(after.name, 'GitHub (work)');
  assert.equal(after.login.password, `${SENTINEL}-password`, 'the password was lost in an edit');
  assert.equal(after.login.totp, 'JBSWY3DPEHPK3PXP', 'the one-time seed was lost in an edit');
  assert.equal(after.notes, `${SENTINEL}-notes recovery codes`, 'the notes were lost in an edit');
  assert.equal(after.login.username, 'shadowsdistant');
  assert.equal(after.fields.length, 1, 'a custom field was lost in an edit');
});

test('a confirmation cannot be replayed', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json } = await s.callJson('vault_edit_item', { id: GITHUB, favorite: false });
  await s.call('vault_ui_confirm', { action_id: json.data.actionId });
  const again = await s.callJson('vault_ui_confirm', { action_id: json.data.actionId });
  assert.equal(again.result.isError, true);
  assert.match(again.json.error, /expired/i);
});

test('an invented action id does nothing', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const before = JSON.stringify(s.vault().items);
  const r = await s.callJson('vault_ui_confirm', { action_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(r.result.isError, true);
  assert.equal(JSON.stringify(s.vault().items), before);
});

test('trashing is staged, and only the trash is ever used', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_trash_item', { id: GITHUB });
  assert.equal(json.data.applied, false);
  assert.equal(structured.kind, 'delete');
  assert.match(structured.note, /30 days/);
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).deletedDate, null);

  await s.call('vault_ui_confirm', { action_id: json.data.actionId });
  const trashed = s.vault().items.find((i) => i.id === GITHUB);
  // Trashed, never destroyed: the item is still there with its secrets intact.
  assert.ok(trashed, 'the item was deleted outright instead of trashed');
  assert.ok(trashed.deletedDate);
  assert.equal(trashed.login.password, `${SENTINEL}-password`);

  const restored = await s.callJson('vault_restore_item', { id: GITHUB });
  assert.equal(restored.json.restored, true);
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).deletedDate, null);
});

test('cancelling leaves the vault untouched', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const before = JSON.stringify(s.vault().items);
  const { json } = await s.callJson('vault_trash_item', { id: GITHUB });
  await s.call('vault_ui_cancel', { action_id: json.data.actionId });
  assert.equal(JSON.stringify(s.vault().items), before);

  const late = await s.callJson('vault_ui_confirm', { action_id: json.data.actionId });
  assert.equal(late.result.isError, true);
  assert.equal(JSON.stringify(s.vault().items), before);
});

test('there is no way to ask for a permanent delete', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { tools } = await s.client.listTools();
  const trash = tools.find((x) => x.name === 'vault_trash_item');
  assert.deepEqual(Object.keys(trash.inputSchema.properties), ['id'], 'the trash tool grew an option it should not have');
  assert.ok(!tools.some((x) => /destroy|purge|permanent/i.test(x.name)));
});

test('a bad item id is refused before any CLI call', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  for (const id of ['GitHub', '', 'not-a-uuid', '../../etc/passwd']) {
    const { result } = await s.callJson('vault_get_item', { id });
    assert.equal(result.isError, true, `id ${JSON.stringify(id)} should be refused`);
  }
});

test('an edit with nothing in it is refused rather than staged', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_edit_item', { id: GITHUB });
  assert.equal(result.isError, true);
  assert.match(json.error, /nothing to change/i);
});

test('search caps its results and says when it did', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json } = await s.callJson('vault_search', { limit: 1 });
  assert.equal(json.data.items.length, 1);
  assert.equal(json.data.truncated, true);
});

test('a generated passphrase is words, not characters', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_generate_password', { passphrase: true, words: 4, separator: '.' });
  assert.equal(json.data.kind, 'passphrase');
  assert.equal(structured.secret.split('.').length, 4);
});
