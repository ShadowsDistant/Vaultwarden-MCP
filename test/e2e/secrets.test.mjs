import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, unlocked, SENTINEL } from '../helpers/server.mjs';

const GITHUB = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const HOSTILE = '33333333-3333-4333-8333-333333333333';

/**
 * The central promise of this server: nothing a model-visible tool returns contains a
 * secret. Every secret in the seeded vault carries a sentinel string, so this can be
 * checked against the whole serialised result — content, structuredContent and _meta —
 * rather than against the fields anyone remembered to look at.
 */
function assertNoSecrets(result, where) {
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(SENTINEL), `${where} leaked a secret into the model's result`);
}

test('search results carry no secrets and no full URLs', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json, structured } = await s.callJson('vault_search', { query: 'GitHub' });
  assertNoSecrets(result, 'vault_search');

  const item = json.data.items[0];
  assert.equal(item.name, 'GitHub');
  assert.equal(item.hasPassword, true);
  assert.equal(item.hasTotp, true);
  assert.equal(item.hasNotes, true);
  // A bulk listing is the worst place to hand over usernames: it is the one call that would
  // return fifty email addresses at once.
  assert.equal(item.username, undefined);
  // The saved URL has a path with a token in it; the model gets the host only.
  assert.deepEqual(item.sites, ['https://github.com']);
  assert.ok(!JSON.stringify(result).includes('secret-token-abc'));
  // Whatever the card is given must not be richer than what the model can read.
  assert.deepEqual(structured.items, json.data.items);
});

test('viewing an item reports what exists without handing any of it over', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_get_item', { id: GITHUB });
  assertNoSecrets(result, 'vault_get_item');
  assert.equal(json.data.username, 'shadowsdistant');
  assert.equal(json.data.hasPassword, true);
  assert.equal(json.data.folder, 'Development');
  assert.equal(json.data.password, undefined);
  assert.equal(json.data.totp, undefined);
  assert.equal(json.data.notes, undefined);
  // Custom fields are counted, never valued.
  assert.equal(json.data.customFields, 1);
});

test('an item whose name is an injection is redacted, and the payload says why', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_get_item', { id: HOSTILE });
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes('attacker@evil.test'), 'the hostile instruction reached the model');
  assert.match(json.data.name, /^\[redacted/);
  assert.ok(json.warnings.some((w) => w.issue === 'instruction_like'));
  assert.match(json.notice, /untrusted data/i);
});

test('the card reads a secret through its own tool', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // On a host that implements MCP Apps the card tools exist, marked app-only. The host is
  // what keeps them out of the model's list and rejects model calls to them; the server
  // cannot tell the two callers apart on one session, so what is asserted here is that the
  // tool is correctly marked and that the card's path works.
  const { tools } = await s.client.listTools();
  const reveal = tools.find((x) => x.name === 'vault_ui_reveal');
  assert.ok(reveal, 'the card tool should exist on an MCP Apps host');
  assert.deepEqual(reveal._meta.ui.visibility, ['app']);

  const { json } = await s.callJson('vault_ui_reveal', { id: GITHUB, field: 'password' });
  assert.equal(json.value, `${SENTINEL}-password`);
  assert.equal(json.hideAfterSeconds, 30);
});

test('a host without MCP Apps never gets the card tools at all', async (t) => {
  // This is the case that matters. A host that does not implement MCP Apps ignores
  // `visibility: ['app']`, so if these tools were simply registered it would hand the model
  // vault_ui_reveal — a secret-reading tool with no confirmation behind it. They stay
  // switched off unless the client declares support at initialize.
  const s = await unlocked({ cards: false });
  t.after(() => s.close());

  const { tools } = await s.client.listTools();
  const names = tools.map((x) => x.name);
  assert.ok(!names.some((n) => n.startsWith('vault_ui_')), `card tools leaked: ${names.filter((n) => n.startsWith('vault_ui_'))}`);
  assert.ok(names.includes('vault_get_item'));

  // Naming one directly is refused too, so this is not merely hidden from the listing.
  const called = await s.client.callTool({ name: 'vault_ui_reveal', arguments: { id: GITHUB, field: 'password' } });
  assert.equal(called.isError, true);
  assertNoSecrets(called, 'a disabled card tool');
  assert.match(JSON.stringify(called), /disabled/i);
});

test('every tool the model can see is annotated and described', async (t) => {
  const s = await unlocked({ cards: false });
  t.after(() => s.close());

  const { tools } = await s.client.listTools();
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} should not be open-world`);
    assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a real description`);
  }
  const destructive = tools.find((x) => x.name === 'vault_trash_item');
  assert.equal(destructive.annotations.destructiveHint, true);
  const read = tools.find((x) => x.name === 'vault_search');
  assert.equal(read.annotations.readOnlyHint, true);
});

test('revealing to the model needs a yes in the dialog, every time', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_reveal_secret', {
    id: GITHUB,
    field: 'password',
    reason: 'the user asked me to read it out',
  });
  assert.equal(result.isError, undefined);
  assert.equal(json.data.value, `${SENTINEL}-password`);

  // The dialog named the item and the reason, so the person answering knew what they were
  // agreeing to.
  const asked = s.prompts().at(-1);
  assert.equal(asked.kind, 'confirm');
  assert.equal(asked.danger, true);
  assert.match(asked.message, /GitHub/);
  assert.match(asked.message, /read it out/);
});

test('a no in the dialog means no secret', async (t) => {
  // The unlock prompt is answered, the reveal prompt is refused: the point is that a
  // declined reveal fails on its own, not because the vault happened to be locked.
  const s = await unlocked({ env: { FAKE_PROMPT_CONFIRM_ANSWER: 'cancel' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_reveal_secret', { id: GITHUB, field: 'password', reason: 'curiosity' });
  assertNoSecrets(result, 'a declined reveal');
  assert.equal(result.isError, true);
  assert.match(json.error, /declined/i);
});

test('an item marked re-prompt is never released to the model', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_reveal_secret', { id: BANK, field: 'password', reason: 'the user asked' });
  assertNoSecrets(result, 'a re-prompt item');
  assert.equal(result.isError, true);
  assert.match(json.error, /re-prompt/i);
  // And no dialog was raised: the answer is no before anyone is asked.
  assert.equal(s.prompts().filter((p) => p.kind === 'confirm').length, 0);
});

test('repeated reveals are cut off before they can drain the vault', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  // Two independent limits apply: at most five reveals a minute, and at most five desktop
  // dialogs in ten minutes counting the unlock. Which one bites first does not matter; what
  // matters is that a model looping on this hits a wall quickly and gets no secret when it
  // does.
  let refusedAt = 0;
  for (let i = 1; i <= 8 && !refusedAt; i++) {
    const { result, json } = await s.callJson('vault_reveal_secret', { id: GITHUB, field: 'password', reason: 'test' });
    if (result.isError) {
      refusedAt = i;
      assertNoSecrets(result, 'a rate-limited reveal');
      assert.match(json.error, /too many/i);
    }
  }
  assert.ok(refusedAt > 0 && refusedAt <= 6, `expected a refusal within six attempts, got ${refusedAt || 'none'}`);
});

test('reveal can be switched off entirely at install time', async (t) => {
  const s = await unlocked({ env: { VW_MCP_MODEL_REVEAL: 'off' } });
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_reveal_secret', { id: GITHUB, field: 'password', reason: 'test' });
  assertNoSecrets(result, 'reveal with reveal disabled');
  assert.equal(result.isError, true);
  assert.match(json.error, /switched off/i);
  assert.equal(s.prompts().filter((p) => p.kind === 'confirm').length, 0);
});

test('a generated password goes to the card, not the transcript', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { json, structured } = await s.callJson('vault_generate_password', { length: 24, special: true });
  // The model learns the shape of what was made, and nothing else.
  assert.equal(json.data.length, 24);
  assert.equal(json.data.kind, 'password');
  assert.ok(json.data.strength);
  assert.equal(json.data.secret, undefined);
  assert.ok(!JSON.stringify(json).includes(structured.secret), 'the generated password reached the model');
  assert.equal(structured.secret.length, 24);
});

test('the card copies a secret to the clipboard without it crossing the transcript', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const { result, json } = await s.callJson('vault_ui_copy', { id: GITHUB, field: 'password' });
  assert.equal(json.copied, 'password');
  assert.equal(json.clearsInSeconds, 30);
  // The tool result says only that a copy happened.
  assertNoSecrets(result, 'vault_ui_copy');
  // But the clipboard really holds the value.
  assert.equal(s.clipboard(), `${SENTINEL}-password`);
});

test('copying a re-prompt item asks for the master password again', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  const before = s.prompts().length;
  const { json } = await s.callJson('vault_ui_copy', { id: BANK, field: 'password' });
  assert.equal(json.copied, 'password');
  const asked = s.prompts().slice(before);
  assert.ok(
    asked.some((p) => p.fields?.some((f) => f.secret)),
    'a re-prompt item should have demanded the master password',
  );
});

test('nothing secret is ever written to the log', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());

  await s.call('vault_search', { query: 'GitHub' });
  await s.call('vault_get_item', { id: GITHUB });
  await s.call('vault_ui_reveal', { id: GITHUB, field: 'password' });
  await s.call('vault_ui_copy', { id: GITHUB, field: 'password' });

  const log = s.logText() + s.stderrText();
  assert.ok(!log.includes(SENTINEL), 'a secret reached the log file');
  // Items are identified by id, never by name: the log is a plaintext file that outlives
  // the session.
  assert.ok(!log.includes('shadowsdistant'), 'a username reached the log file');
  assert.ok(log.includes(GITHUB), 'the audit trail should still identify the item by id');
});

test('a locked vault refuses everything, with an actionable reason', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  for (const [name, args] of [
    ['vault_search', { query: 'a' }],
    ['vault_get_item', { id: GITHUB }],
    ['vault_ui_reveal', { id: GITHUB, field: 'password' }],
    ['vault_ui_copy', { id: GITHUB, field: 'password' }],
  ]) {
    const { result, json } = await s.callJson(name, args);
    assert.equal(result.isError, true, `${name} should refuse while locked`);
    assertNoSecrets(result, `${name} while locked`);
    assert.match(JSON.stringify(json), /lock/i);
  }
});
