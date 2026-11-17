import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSite, hostMatches, hostOfUri, itemOnTrustedSite, DEFAULTS } from '../../dist/settings.js';
import { decide } from '../../dist/policy.js';

const login = (...uris) => ({ id: 'i-1', type: 1, reprompt: 0, login: { uris: uris.map((uri) => ({ uri })) } });
const host = (entry) => {
  const r = normaliseSite(entry);
  return 'host' in r ? r.host : `REFUSED: ${r.reason}`;
};

test('a trusted-site entry is reduced to a host however it was typed', () => {
  assert.equal(host('github.com'), 'github.com');
  assert.equal(host('  GitHub.COM  '), 'github.com');
  assert.equal(host('https://github.com/login?next=/'), 'github.com');
  assert.equal(host('*.github.com'), 'github.com');
  assert.equal(host('github.com.'), 'github.com');
  assert.equal(host('localhost'), 'localhost');
  assert.equal(host('192.168.1.20'), '192.168.1.20');
});

test('entries that would trust many owners at once are refused', () => {
  for (const e of ['com', 'co.uk', '*.com', 'github.io', 'herokuapp.com', 'blogspot.com', 'pages.dev']) {
    assert.match(host(e), /^REFUSED/, `${e} should be refused`);
  }
  // A site on a shared suffix is fine on its own: it has one owner.
  assert.equal(host('someone.github.io'), 'someone.github.io');
});

test('entries that are not web addresses are refused', () => {
  for (const e of ['', '   ', 'ftp://example.com', 'javascript:alert(1)', '[::1]', 'exa mple.com', 'a..b.com']) {
    assert.match(host(e), /^REFUSED/, `${JSON.stringify(e)} should be refused`);
  }
});

test('a host matches its entry and the entry’s subdomains, and nothing that merely ends the same way', () => {
  assert.equal(hostMatches('github.com', 'github.com'), true);
  assert.equal(hostMatches('gist.github.com', 'github.com'), true);
  assert.equal(hostMatches('notgithub.com', 'github.com'), false);
  assert.equal(hostMatches('github.com.evil.test', 'github.com'), false);
  assert.equal(hostMatches('github.com', 'gist.github.com'), false);
  // Addresses match exactly or not at all.
  assert.equal(hostMatches('10.0.0.5', '10.0.0.5'), true);
  assert.equal(hostMatches('x.localhost', 'localhost'), false);
});

test('lookalike hosts written in other scripts never equal the ASCII name', () => {
  // Cyrillic "а" in place of the Latin one.
  const spoof = hostOfUri('https://gіthub.com/');
  assert.notEqual(spoof, 'github.com');
  assert.equal(itemOnTrustedSite(login('https://gіthub.com/'), ['github.com']), false);
});

test('an item is on a trusted site only when every one of its addresses is', () => {
  assert.equal(itemOnTrustedSite(login('https://github.com/login'), ['github.com']), true);
  assert.equal(itemOnTrustedSite(login('https://github.com', 'https://gist.github.com'), ['github.com']), true);
  assert.equal(itemOnTrustedSite(login('https://github.com', 'https://evil.test'), ['github.com']), false);
  assert.equal(itemOnTrustedSite(login(), ['github.com']), false, 'an item with no address trusts nothing');
  assert.equal(itemOnTrustedSite(login('androidapp://com.github.android'), ['github.com']), false);
  assert.equal(itemOnTrustedSite({ ...login('https://github.com'), type: 2 }, ['github.com']), false, 'only logins');
  assert.equal(itemOnTrustedSite(login('https://github.com'), []), false);
});

const S = (over = {}) => ({ ...DEFAULTS, ...over });
const never = () => false;

test('re-prompt items are refused before any other rule, trusted or not', () => {
  const item = { ...login('https://bank.example.com'), reprompt: 1 };
  const d = decide(item, 'password', S({ trustedSites: ['bank.example.com'], access: 'session' }), () => true);
  assert.equal(d.kind, 'deny');
  assert.equal(d.code, 'reprompt');
});

test('a trusted site releases passwords and codes, never notes', () => {
  const s = S({ trustedSites: ['github.com'] });
  assert.deepEqual(decide(login('https://github.com'), 'password', s, never), { kind: 'allow', via: 'trusted_site' });
  assert.deepEqual(decide(login('https://github.com'), 'totp', s, never), { kind: 'allow', via: 'trusted_site' });
  assert.equal(decide(login('https://github.com'), 'notes', s, never).kind, 'ask');
});

test('a trusted site is an exception to "never", and only for that site', () => {
  const s = S({ access: 'never', trustedSites: ['github.com'] });
  assert.equal(decide(login('https://github.com'), 'password', s, never).kind, 'allow');
  const other = decide(login('https://example.org'), 'password', s, never);
  assert.equal(other.kind, 'deny');
  assert.equal(other.code, 'never');
});

test('"ask once" remembers only what was approved, and "ask every time" remembers nothing', () => {
  const item = login('https://example.org');
  const approved = (key) => key === 'i-1:password';
  assert.deepEqual(decide(item, 'password', S({ access: 'session' }), approved), { kind: 'allow', via: 'session' });
  assert.equal(decide(item, 'totp', S({ access: 'session' }), approved).kind, 'ask');
  assert.equal(decide(item, 'password', S({ access: 'ask' }), approved).kind, 'ask');
});
