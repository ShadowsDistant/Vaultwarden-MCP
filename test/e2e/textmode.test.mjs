import test from 'node:test';
import assert from 'node:assert/strict';
import { unlocked, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';

/**
 * Text-only mode: cards switched off in the Settings app, or a host that cannot draw them.
 * Everything must still work, with desktop windows doing the confirming, and nothing secret
 * may ride along in a structured result that no card is going to consume.
 */

const modes = [
  ['cards switched off in settings', { settings: { cards: false } }],
  ['a host that cannot draw cards', { cards: false }],
];

for (const [label, opts] of modes) {
  test(`${label}: no card tools, no card resource, no structured payloads`, async (t) => {
    const s = await unlocked(opts);
    t.after(() => s.close());

    const { tools } = await s.client.listTools();
    assert.ok(!tools.some((x) => x.name.startsWith('vault_ui_')), 'card-only tools must not be offered');
    const { result } = await s.callJson('vault_get_item', { id: GITHUB });
    assert.equal(result.structuredContent, undefined);
    const { json } = await s.callJson('vault_get_item', { id: GITHUB });
    assert.match(json.hint, /vault_copy_secret/);
  });

  test(`${label}: a new login is confirmed in a window, saved, and its password copied`, async (t) => {
    const s = await unlocked(opts);
    t.after(() => s.close());

    const before = s.vault().items.length;
    const { result, json } = await s.callJson('vault_create_login', { name: 'Fastmail', username: 'me', uri: 'https://fastmail.com' });
    assert.equal(result.isError, undefined, JSON.stringify(json));
    assert.equal(json.data.saved, true);
    assert.equal(json.data.passwordCopied, true);

    const asked = s.prompts().filter((p) => p.kind === 'confirm').at(-1);
    assert.match(asked.title, /new login/i);
    assert.match(asked.message, /Fastmail/);

    const created = s.vault().items.find((i) => i.name === 'Fastmail');
    assert.equal(s.vault().items.length, before + 1);
    assert.equal(s.clipboard(), created.login.password, 'the new password should be on the clipboard');
    assert.ok(!JSON.stringify(result).includes(created.login.password), 'the new password reached the model');
  });

  test(`${label}: a declined window saves nothing`, async (t) => {
    const s = await unlocked({ ...opts, env: { FAKE_PROMPT_CONFIRM_ANSWER: 'cancel' } });
    t.after(() => s.close());

    const before = s.vault().items.length;
    const create = await s.callJson('vault_create_login', { name: 'Nope' });
    assert.equal(create.json.data.saved, false);
    const trash = await s.callJson('vault_trash_item', { id: GITHUB });
    assert.equal(trash.json.data.applied, false);
    const edit = await s.callJson('vault_edit_item', { id: GITHUB, name: 'Renamed' });
    assert.equal(edit.json.data.applied, false);

    const v = s.vault();
    assert.equal(v.items.length, before);
    const gh = v.items.find((i) => i.id === GITHUB);
    assert.equal(gh.name, 'GitHub');
    assert.equal(gh.deletedDate, null);
  });

  test(`${label}: edits and trash go through a window and then happen`, async (t) => {
    const s = await unlocked(opts);
    t.after(() => s.close());

    const edit = await s.callJson('vault_edit_item', { id: GITHUB, username: 'newname' });
    assert.equal(edit.json.data.applied, true);
    const editPrompt = s.prompts().filter((p) => p.kind === 'confirm').at(-1);
    assert.match(editPrompt.message, /shadowsdistant\s+->\s+newname/);
    assert.equal(s.vault().items.find((i) => i.id === GITHUB).login.username, 'newname');

    const trash = await s.callJson('vault_trash_item', { id: GITHUB });
    assert.equal(trash.json.data.applied, true);
    assert.equal(s.prompts().filter((p) => p.kind === 'confirm').at(-1).danger, true);
    assert.ok(s.vault().items.find((i) => i.id === GITHUB).deletedDate);
  });

  test(`${label}: a generated password goes to the clipboard, not the transcript`, async (t) => {
    const s = await unlocked(opts);
    t.after(() => s.close());

    const { result, json } = await s.callJson('vault_generate_password', { length: 30 });
    assert.equal(json.data.copiedToClipboard, true);
    const value = s.clipboard();
    assert.equal(value.length, 30);
    assert.ok(!JSON.stringify(result).includes(value));
    assert.equal(result.structuredContent, undefined);
  });
}

test('text mode never puts a secret in any result', async (t) => {
  const s = await unlocked({ settings: { cards: false } });
  t.after(() => s.close());

  for (const [tool, args] of [
    ['vault_status', {}],
    ['vault_search', { query: 'git' }],
    ['vault_get_item', { id: GITHUB }],
    ['vault_copy_secret', { id: GITHUB }],
  ]) {
    const { result } = await s.callJson(tool, args);
    assert.ok(!JSON.stringify(result).includes(SENTINEL), `${tool} leaked a secret`);
  }
});
