import test from 'node:test';
import assert from 'node:assert/strict';
import { unlocked, startServer, seedVault, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';

/**
 * The contract between the server and the card.
 *
 * The card reads a tool result by merging `content` and `structuredContent`. That merge is the
 * only reason a secret can be kept out of `structuredContent` — which is assumed to be
 * model-visible — and still reach the card. Reading one half alone is what silently broke the
 * reveal button: the value was in the other one.
 */
function asCardSees(result) {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  let fromText = {};
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fromText = parsed;
    } catch {
      return { error: text };
    }
  }
  return { ...fromText, ...(result.structuredContent ?? {}) };
}

test('the card can read a revealed secret, which lives only in the text half', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result } = await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'password' });

  // Deliberately absent from the half assumed to be model-visible…
  assert.equal(result.structuredContent.value, undefined, 'a secret must not be in structuredContent');
  // …and still reachable by the card, which reads both.
  assert.equal(asCardSees(result).value, `${SENTINEL}-password`);
  assert.equal(asCardSees(result).hideAfterSeconds, 30);
});

test('every view the card renders arrives with the fields it renders from', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const checks = [
    ['vault_ui_state', {}, (v) => v.view === 'status' && Boolean(v.status?.state)],
    ['vault_ui_search', {}, (v) => v.view === 'list' && Array.isArray(v.items)],
    ['vault_ui_item', { id: GITHUB }, (v) => v.view === 'item' && v.item?.id === GITHUB],
    ['vault_ui_generate', { length: 20 }, (v) => typeof v.secret === 'string' && v.secret.length === 20],
    ['vault_ui_folders', {}, (v) => Array.isArray(v.folders)],
  ];
  for (const [name, args, ok] of checks) {
    const { result } = await s.callJson(name, args);
    assert.equal(result.isError, undefined, `${name} failed`);
    assert.ok(ok(asCardSees(result)), `${name} did not give the card what it renders from`);
  }
});

test('the card list holds the whole vault, not the first handful', async (t) => {
  // Forty items is more than any of the old caps, and more than a person would tolerate being
  // silently cut off from.
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push({
      object: 'item',
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      folderId: null,
      type: 1,
      name: `Item ${String(i).padStart(2, '0')}`,
      notes: null,
      favorite: i === 39,
      reprompt: 0,
      revisionDate: '2026-08-01T10:00:00.000Z',
      deletedDate: null,
      fields: [],
      login: { username: `user${i}`, password: `${SENTINEL}-${i}`, totp: null, uris: [] },
    });
  }
  const s = await startServer({ seed: false });
  t.after(() => s.close());
  seedVault(s.bwDir, { items: many });
  await s.call('vault_unlock');

  const { result } = await s.callJson('vault_ui_search', {});
  const view = asCardSees(result);
  assert.equal(view.items.length, 40, 'the card was given a truncated vault');
  assert.equal(view.total, 40);
  assert.equal(view.truncated, false);
  // Favourites first, then by name — a long list has to be navigable.
  assert.equal(view.items[0].name, 'Item 39');
  assert.equal(view.items[1].name, 'Item 00');

  // The model's own view stays capped: a long list of usernames is worth something to an
  // attacker, and a person reading the card is not the threat.
  const model = await s.callJson('vault_search', {});
  assert.ok(model.json.data.items.length <= 50);
});

test('unlocking from the card lands in the vault, not on a card that says "unlocked"', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const { result } = await s.callJson('vault_ui_unlock');
  const view = asCardSees(result);
  assert.equal(view.view, 'list', 'unlocking should show the vault');
  assert.equal(view.unlocked, true);
  assert.ok(view.items.length >= 3);
  // And still no secrets, even here.
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test('search matches the way a search box is expected to', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const cases = [
    ['github', 1, 'lower case matches a capitalised name'],
    ['GITHUB', 1, 'upper case does too'],
    ['hub', 1, 'a fragment in the middle of a word matches'],
    ['shadowsdistant', 1, 'a username matches'],
    ['bank.example.com', 1, 'a stored address matches'],
    ['nothing here at all', 0, 'a miss is a miss'],
  ];
  for (const [query, expected, why] of cases) {
    const { result } = await s.callJson('vault_ui_search', { query });
    assert.equal(asCardSees(result).items.length, expected, `${why}: ${query}`);
  }
});

test('the card is told where site icons come from, and it is the vault', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  for (const [name, args] of [
    ['vault_ui_state', {}],
    ['vault_ui_search', {}],
    ['vault_ui_item', { id: GITHUB }],
  ]) {
    const { result } = await s.callJson(name, args);
    assert.equal(asCardSees(result).iconBase, 'https://vault.example.com', `${name} did not carry the icon origin`);
  }
});
