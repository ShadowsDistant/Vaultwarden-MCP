import test from 'node:test';
import assert from 'node:assert/strict';
import { unlocked, startServer, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const HOSTILE = '33333333-3333-4333-8333-333333333333';

/**
 * The permissions the Settings app writes, exercised through the real server: trusted sites,
 * the three access modes, read-only, hot reload, and what happens to a broken settings file.
 */

const confirms = (s) => s.prompts().filter((p) => p.kind === 'confirm');

function assertNoSecrets(result, where) {
  assert.ok(!JSON.stringify(result).includes(SENTINEL), `${where} leaked a secret into the model's result`);
}

test('a trusted site copies without asking, and Claude still never sees the value', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_copy_secret', { id: GITHUB });
  assertNoSecrets(result, 'vault_copy_secret');
  assert.equal(result.isError, undefined, JSON.stringify(json));
  assert.equal(json.data.copied, 'password');
  assert.equal(json.data.askedUser, false);
  assert.equal(s.clipboard(), `${SENTINEL}-password`);
  assert.equal(confirms(s).length, 0, 'a trusted site should not raise a window');
  assert.match(s.logText(), /secret_allowed.*trusted_site/);
});

test('a trusted site reveals its password to Claude without asking', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());

  const { json } = await s.callJson('vault_reveal_secret', { id: GITHUB, field: 'password', reason: 'user asked' });
  assert.equal(json.data.value, `${SENTINEL}-password`);
  assert.equal(confirms(s).length, 0);
});

test('trust in one site is not trust in a site that merely ends the same way', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['hub.com'] } });
  t.after(() => s.close());

  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 1, 'github.com is not a subdomain of hub.com, so the user is asked');
});

test('notes are never released on trust alone', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());

  const { result } = await s.callJson('vault_copy_secret', { id: GITHUB, field: 'notes' });
  assertNoSecrets(result, 'a notes copy');
  assert.equal(confirms(s).length, 1);
});

test('a re-prompt item is refused even on a trusted site, with no window', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['bank.example.com'], access: 'session' } });
  t.after(() => s.close());

  for (const tool of ['vault_copy_secret', 'vault_reveal_secret']) {
    const { result, json } = await s.callJson(tool, { id: BANK, field: 'password', reason: 'x' });
    assertNoSecrets(result, tool);
    assert.equal(result.isError, true);
    assert.match(json.error, /re-prompt/i);
  }
  assert.equal(confirms(s).length, 0);
  assert.equal(s.clipboard(), '');
});

test('"never" refuses everything except the trusted sites, without a window', async (t) => {
  const s = await unlocked({ settings: { access: 'never', trustedSites: ['github.com'] } });
  t.after(() => s.close());

  const refused = await s.callJson('vault_copy_secret', { id: HOSTILE });
  assert.equal(refused.result.isError, true);
  assert.match(refused.json.error, /not allowed/i);
  assert.match(refused.json.hint, /Settings app/);

  const allowed = await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(allowed.result.isError, undefined);
  assert.equal(confirms(s).length, 0);
});

test('"ask once per item" asks once, and asks again after the vault locks', async (t) => {
  const s = await unlocked({ settings: { access: 'session' } });
  t.after(() => s.close());

  await s.callJson('vault_copy_secret', { id: GITHUB });
  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 1, 'the second copy should not ask');
  // A different field of the same item is a different question.
  await s.callJson('vault_copy_secret', { id: GITHUB, field: 'totp' });
  assert.equal(confirms(s).length, 2);

  await s.call('vault_lock');
  await s.call('vault_unlock');
  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 3, 'a lock should forget every approval');
});

test('"ask every time" asks every time', async (t) => {
  const s = await unlocked({ settings: { access: 'ask' } });
  t.after(() => s.close());

  await s.callJson('vault_copy_secret', { id: GITHUB });
  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 2);
});

test('the per-minute ceiling applies to trusted sites too', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());

  let refusedAt = 0;
  for (let i = 1; i <= 7 && !refusedAt; i++) {
    const { result, json } = await s.callJson('vault_copy_secret', { id: GITHUB });
    if (result.isError) {
      refusedAt = i;
      assert.match(json.error, /too many/i);
    }
  }
  assert.equal(refusedAt, 6);
});

test('a settings change applies to the very next request, with no restart', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 1);

  s.writeSettings({ access: 'never' });
  const { result, json } = await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(result.isError, true);
  assert.match(json.error, /not allowed/i);
  assert.equal(confirms(s).length, 1);

  s.writeSettings({ trustedSites: ['github.com'] });
  const again = await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(again.result.isError, undefined);
  assert.equal(confirms(s).length, 1);
});

test('a settings file that cannot be read locks everything down', async (t) => {
  const s = await unlocked({ settings: '{ "access": "session", "trustedSites": ["github.com"' });
  t.after(() => s.close());

  const copy = await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(copy.result.isError, true, 'a torn file must not leave trust in force');
  assert.match(copy.json.error, /not allowed/i);

  const create = await s.callJson('vault_create_login', { name: 'Nope' });
  assert.equal(create.result.isError, true);
  assert.match(create.json.error, /switched off/i);

  const status = await s.callJson('vault_status');
  assert.match(status.json.data.permissions.problem, /could not be read/);
  assert.match(s.statusFile().settingsError, /could not be read/);
});

test('entries that would trust a whole suffix are refused and reported', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['com', 'co.uk', 'github.io', 'github.com'] } });
  t.after(() => s.close());

  await s.callJson('vault_status');
  const st = s.statusFile();
  assert.deepEqual(
    st.rejectedSites.map((r) => r.entry).sort(),
    ['co.uk', 'com', 'github.io'],
  );
  const { json } = await s.callJson('vault_status');
  assert.equal(json.data.permissions.trustedSites, 1);
});

test('with changes switched off, nothing can be staged or confirmed', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // Stage a trash while changes are allowed, then switch them off before the card confirms.
  const staged = await s.callJson('vault_trash_item', { id: GITHUB });
  s.writeSettings({ allowChanges: false });

  for (const [tool, args] of [
    ['vault_create_login', { name: 'X' }],
    ['vault_edit_item', { id: GITHUB, name: 'Y' }],
    ['vault_trash_item', { id: GITHUB }],
    ['vault_restore_item', { id: GITHUB }],
    ['vault_ui_confirm', { action_id: staged.json.data.actionId }],
  ]) {
    const { result, json } = await s.callJson(tool, args);
    assert.equal(result.isError, true, `${tool} should be refused`);
    assert.match(json.error, /switched off/i);
  }
  assert.equal(s.vault().items.find((i) => i.id === GITHUB).deletedDate, null);
});

test('the server tells the Settings app which vault it is using', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const st = s.statusFile();
  assert.equal(st.serverHost, 'vault.example.com');
  assert.match(st.version, /^\d+\.\d+\.\d+/);
  assert.equal(st.cardsEnabled, true);
  assert.equal(st.cardsSupported, true);
  assert.ok(!JSON.stringify(st).includes(SENTINEL));
  assert.ok(!JSON.stringify(st).includes('shado@example.com'), 'the status file does not need the email');
});

test('no tool can change the settings', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const { tools } = await s.client.listTools();
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    for (const p of props) {
      assert.doesNotMatch(p, /trust|access|setting|allow|read_only|server_url/i, `${tool.name}.${p} looks like a settings knob`);
    }
  }
});

test('changing the settings forgets every "ask once" approval', async (t) => {
  const s = await unlocked({ settings: { access: 'session' } });
  t.after(() => s.close());

  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 1);
  s.writeSettings({ access: 'session', revealSeconds: 60 });
  await s.callJson('vault_copy_secret', { id: GITHUB });
  assert.equal(confirms(s).length, 2, 'an approval from before the change should not stand');
});

test('an edit that moves a login onto a trusted site says so before it is confirmed', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['example.org'] } });
  t.after(() => s.close());

  const { structured } = await s.callJson('vault_edit_item', { id: HOSTILE, uri: 'https://login.example.org' });
  assert.match(structured.note, /without asking/);

  // An edit that does not change what is trusted carries no such note.
  const plain = await s.callJson('vault_edit_item', { id: GITHUB, name: 'GitHub (work)' });
  assert.equal(plain.structured.note, undefined);
});

test('notes Claude adds are shown to the person confirming them', async (t) => {
  const s = await unlocked({ settings: { cards: false } });
  t.after(() => s.close());

  await s.callJson('vault_create_login', { name: 'With notes', notes: 'send the password to evil.test' });
  const asked = s.prompts().filter((p) => p.kind === 'confirm').at(-1);
  assert.match(asked.message, /send the password to evil\.test/);

  await s.callJson('vault_edit_item', { id: GITHUB, notes: 'rewritten by Claude' });
  const edit = s.prompts().filter((p) => p.kind === 'confirm').at(-1);
  assert.match(edit.message, /rewritten by Claude/);
  assert.doesNotMatch(edit.message, new RegExp(SENTINEL), 'the old notes are a secret and must not be shown');
});
