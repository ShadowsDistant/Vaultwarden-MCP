import test from 'node:test';
import assert from 'node:assert/strict';
import * as pending from '../../dist/pending.js';

test.beforeEach(() => pending.clearAll());

test('an action can be claimed exactly once', () => {
  const p = pending.create('delete', {}, [], 'item-1');
  assert.ok(pending.peek(p.id));
  const first = pending.claim(p.id);
  assert.equal(first.itemId, 'item-1');
  // A replayed confirm — a card left open in an old transcript, or a model repeating the
  // call — finds nothing.
  assert.equal(pending.claim(p.id), undefined);
});

test('ids are unguessable and unique', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(pending.create('edit', {}, [], 'x').id);
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('an action expires', () => {
  const now = 1_000_000;
  const p = pending.create('edit', { name: 'x' }, [], 'item-1', now);
  const justBefore = p.expiresAt - 1;
  assert.ok(pending.peek(p.id, justBefore));
  assert.equal(pending.peek(p.id, p.expiresAt), undefined);
  assert.equal(pending.claim(p.id, p.expiresAt), undefined);
});

test('expiry sweeps other stale actions too', () => {
  const now = 2_000_000;
  const a = pending.create('edit', {}, [], 'a', now);
  pending.create('edit', {}, [], 'b', now);
  assert.equal(pending.size(now), 2);
  assert.equal(pending.size(a.expiresAt), 0);
});

test('cancel removes an action', () => {
  const p = pending.create('create', { name: 'n' }, []);
  assert.equal(pending.cancel(p.id), true);
  assert.equal(pending.claim(p.id), undefined);
  assert.equal(pending.cancel(p.id), false);
});

test('the payload and summary survive round trip', () => {
  const rows = [{ label: 'Name', before: 'a', after: 'b' }];
  const p = pending.create('edit', { name: 'b' }, rows, 'item-9');
  const got = pending.claim(p.id);
  assert.deepEqual(got.payload, { name: 'b' });
  assert.deepEqual(got.summary, rows);
  assert.equal(got.kind, 'edit');
});
