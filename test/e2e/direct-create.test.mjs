import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unlocked } from '../helpers/server.mjs';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const COL = '00000000-0000-4000-8000-0000000000bb';
const DIRECT = { VW_MCP_DIRECT_CREATE: '1', VW_MCP_DEFAULT_ORG: ORG, VW_MCP_DEFAULT_COLLECTIONS: COL };
const PW = 'Hx7-kq2!Vp9zR4mW_test';

function pwFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.vw-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'creds.env');
  fs.writeFileSync(f, content, { mode: 0o600 });
  return f;
}

test('direct mode saves a new login with the password from a file, into the org collection', async (t) => {
  const s = await unlocked({ env: DIRECT });
  t.after(() => s.close());
  const f = pwFile(t, `USER=svc\nSVC_PASSWORD=${PW}\n`);
  const before = s.vault().items.length;
  const { json, text, structured } = await s.callJson('vault_create_login', {
    name: 'Service X', username: 'svc', uri: 'https://service.example.com', password_file: f, password_key: 'SVC_PASSWORD',
  });
  assert.equal(json.data.saved, true);
  assert.equal(json.data.passwordSource, 'file');
  assert.ok(!text.includes(PW), 'the password leaked into what the model reads');
  assert.ok(!JSON.stringify(structured ?? {}).includes(PW), 'the password leaked into structuredContent');
  const items = s.vault().items;
  assert.equal(items.length, before + 1);
  const it = items.find((i) => i.name === 'Service X');
  assert.equal(it.login.password, PW);
  assert.equal(it.organizationId, ORG);
  assert.deepEqual(it.collectionIds, [COL]);
});

test('direct mode never overwrites: an existing name is refused', async (t) => {
  const s = await unlocked({ env: DIRECT });
  t.after(() => s.close());
  await s.callJson('vault_create_login', { name: 'Dup' });
  const before = s.vault().items.length;
  const { result } = await s.callJson('vault_create_login', { name: 'dup' });
  assert.equal(result.isError, true);
  assert.equal(s.vault().items.length, before);
});

test('direct mode generates a password when no file is given, and does not return it', async (t) => {
  const s = await unlocked({ env: DIRECT });
  t.after(() => s.close());
  const { json, text } = await s.callJson('vault_create_login', { name: 'Gen' });
  assert.equal(json.data.passwordSource, 'generated');
  const it = s.vault().items.find((i) => i.name === 'Gen');
  assert.ok(it.login.password.length >= 20);
  assert.ok(!text.includes(it.login.password));
});

test('a password file outside the home directory is refused', async (t) => {
  const s = await unlocked({ env: DIRECT });
  t.after(() => s.close());
  const outside = path.join(os.tmpdir(), `vw-outside-${process.pid}`);
  fs.writeFileSync(outside, PW);
  t.after(() => fs.rmSync(outside, { force: true }));
  const before = s.vault().items.length;
  const { result } = await s.callJson('vault_create_login', { name: 'Out', password_file: outside });
  assert.equal(result.isError, true);
  assert.equal(s.vault().items.length, before);
});

test('without direct mode a password file only fills the draft; nothing is saved', async (t) => {
  const s = await unlocked();
  t.after(() => s.close());
  const f = pwFile(t, PW);
  const before = s.vault().items.length;
  const { json, structured, text } = await s.callJson('vault_create_login', { name: 'Draft', password_file: f });
  assert.equal(json.data.saved, false);
  assert.equal(json.data.passwordGenerated, false);
  assert.equal(structured.secret, PW);
  assert.ok(!text.includes(PW));
  assert.equal(s.vault().items.length, before);
});
