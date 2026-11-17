// The activity log the Settings app shows: who did what with which item, and when. It names
// items and sites, and must never hold a secret, a username or a full web address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_PASSWORD, SENTINEL, startServer, unlocked } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';

function assertClean(s) {
  const text = s.activityText();
  assert.ok(text.length > 0, 'something was logged');
  assert.ok(!text.includes(SENTINEL), 'no secret in the activity log');
  assert.ok(!text.includes(MASTER_PASSWORD), 'no master password in the activity log');
  assert.ok(!text.includes('shadowsdistant'), 'no username in the activity log');
  assert.ok(!text.includes('secret-token-abc'), 'no full web address in the activity log');
}

test('search, an assistant copy and a card reveal are each logged, with who and which item', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());

  await s.callJson('vault_search', { query: 'GitHub' });
  const copied = await s.callJson('vault_copy_secret', { id: GITHUB, field: 'password' });
  assert.equal(copied.json.data.copied, 'password');
  const revealed = await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'totp' });
  assert.ok(revealed.json.value);

  const lines = s.activity();
  for (const l of lines) {
    assert.equal(l.v, 1);
    assert.ok(!Number.isNaN(Date.parse(l.at)));
  }

  const unlock = lines.find((l) => l.action === 'unlock');
  assert.equal(unlock.actor, 'assistant');
  assert.equal(unlock.ok, true);

  const search = lines.find((l) => l.action === 'search');
  assert.equal(search.actor, 'assistant');
  assert.equal(search.app, 'vault-test');
  assert.equal(search.query, 'GitHub');
  assert.equal(search.count, 1);
  assert.equal(search.ok, true);

  const copy = lines.find((l) => l.action === 'copy_secret');
  assert.equal(copy.actor, 'assistant');
  assert.deepEqual(copy.item, { id: GITHUB, name: 'GitHub', host: 'github.com' });
  assert.equal(copy.field, 'password');
  assert.equal(copy.outcome, 'allowed');
  assert.equal(copy.via, 'trusted_site');

  const reveal = lines.find((l) => l.action === 'reveal');
  assert.equal(reveal.actor, 'you');
  assert.equal(reveal.app, 'vault-test');
  assert.equal(reveal.field, 'totp');
  assert.equal(reveal.item.name, 'GitHub');

  // Status checks and the card refreshing itself are not activity.
  assert.ok(!lines.some((l) => l.action === 'status'));
  assertClean(s);
});

test('a secret the assistant read into the chat is logged as read', async (t) => {
  const s = await unlocked({ settings: { trustedSites: ['github.com'] } });
  t.after(() => s.close());
  const read = await s.callJson('vault_reveal_secret', { id: GITHUB, field: 'password', reason: 'the user asked' });
  assert.equal(read.json.data.value, `${SENTINEL}-password`);
  const r = s.activity().find((l) => l.action === 'read_secret');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'allowed');
  assert.equal(r.via, 'trusted_site');
  assert.equal(r.item.name, 'GitHub');
  assertClean(s);
});

test('a request the user declined, and one the rules refused, are logged as such', async (t) => {
  const s = await unlocked({ env: { FAKE_PROMPT_CONFIRM_ANSWER: 'cancel' } });
  t.after(() => s.close());
  assert.equal((await s.callJson('vault_copy_secret', { id: GITHUB })).result.isError, true);
  // The bank login asks for the master password again, so the assistant may never have it.
  assert.equal((await s.callJson('vault_copy_secret', { id: BANK })).result.isError, true);

  const [d, r] = s.activity().filter((l) => l.action === 'copy_secret');
  assert.equal(d.ok, false);
  assert.equal(d.outcome, 'declined');
  assert.equal(d.via, 'dialog');
  assert.equal(d.item.name, 'GitHub');
  assert.match(d.error, /declined/);

  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.item.name, 'Bank');
  assert.equal(r.item.host, 'bank.example.com');
  assertClean(s);
});

test('a proposed change and the click that applies it are both logged', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());
  const staged = await s.callJson('vault_edit_item', { id: GITHUB, name: 'GitHub (work)' });
  await s.call('vault_ui_confirm', { action_id: staged.structured.actionId });

  const lines = s.activity();
  const p = lines.find((l) => l.action === 'propose_edit');
  assert.equal(p.actor, 'assistant');
  assert.equal(p.outcome, 'staged');
  assert.deepEqual(p.fields, ['name']);
  assert.equal(p.item.name, 'GitHub');

  const a = lines.find((l) => l.action === 'apply_change');
  assert.equal(a.actor, 'you');
  assert.equal(a.outcome, 'edit');
  assert.equal(a.item.id, GITHUB);
  assertClean(s);
});

test('sign-in and lock from the Settings app are logged as the app', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.ipc({ op: 'unlock', password: 'not it' });
  await s.ipc({ op: 'unlock', password: MASTER_PASSWORD });
  await s.ipc({ op: 'lock' });
  const lines = s.activity().filter((l) => l.actor === 'settings_app');
  assert.deepEqual(
    lines.map((l) => [l.action, l.ok]),
    [
      ['unlock', false],
      ['unlock', true],
      ['lock', true],
    ],
  );
  assert.equal(lines[0].outcome, 'bad_password');
  assert.equal(lines[0].app, undefined, 'the app name is only for the assistant and the card');
  assert.ok(!s.activityText().includes('not it'));
});

test('with the activity log switched off, nothing is written', async (t) => {
  const s = await unlocked({ settings: { activityLog: false } });
  t.after(() => s.close());
  await s.callJson('vault_search', { query: 'GitHub' });
  assert.equal(s.activityText(), '');
  assert.equal(s.statusFile().effective.activityLog, false);
});
