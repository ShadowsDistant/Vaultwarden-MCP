// A stand-in for the Bitwarden CLI, good enough to drive the whole server end to end.
//
// It speaks the same argument grammar and, importantly, the same `--response` envelopes as
// @bitwarden/cli 2026.8.0 — `{object:'list', data:[…]}`, `{object:'template', template:{…}}`,
// `{object:'string', data:'…'}` — because those shapes were where the real integration bugs
// were. Vault state lives in a JSON file under BITWARDENCLI_APPDATA_DIR.
//
// Knobs, all via the environment:
//   FAKE_BW_PASSWORD          the master password that is accepted (default "correct horse")
//   FAKE_BW_EMPTY_UNLOCK_ONCE the first unlock returns an empty session key, as the real CLI
//                             sometimes does right after a login (bitwarden/clients#18455)
//   FAKE_BW_STATUS_EXIT1      `status` prints valid JSON and exits 1, as the real CLI does
//                             when the server is unreachable (bitwarden/clients#18373)
//   FAKE_BW_FAIL=<command>    make one command fail with a network error

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const dir = process.env.BITWARDENCLI_APPDATA_DIR ?? process.cwd();
const store = path.join(dir, 'fake-vault.json');
const PASSWORD = process.env.FAKE_BW_PASSWORD ?? 'correct horse';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('-'));
const wantsResponse = flags.has('--response');
const wantsRaw = flags.has('--raw');

function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(store, 'utf8'));
  } catch {
    return { serverUrl: null, status: 'unauthenticated', userEmail: null, userId: null, lastSync: null, session: null, items: [], folders: [] };
  }
}

function save(s) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store, JSON.stringify(s, null, 2));
}

function okOut(data) {
  if (wantsResponse) process.stdout.write(JSON.stringify({ success: true, data }));
  else process.stdout.write(typeof data === 'string' ? data : JSON.stringify(data));
  process.exit(0);
}

function rawOut(text) {
  // The real CLI writes the raw value with no trailing newline.
  process.stdout.write(String(text));
  process.exit(0);
}

function errOut(message, code = 1) {
  if (wantsResponse) process.stdout.write(JSON.stringify({ success: false, message }));
  else process.stderr.write(message);
  process.exit(code);
}

const list = (data) => okOut({ object: 'list', data });
const template = (t) => okOut({ object: 'template', template: t });
const str = (s) => (wantsRaw ? rawOut(s) : okOut({ object: 'string', data: s }));

function sessionValid(state) {
  const given = process.env.BW_SESSION ?? opt('--session');
  return Boolean(state.session && given === state.session);
}

function requireUnlocked(state) {
  if (state.status === 'unauthenticated') errOut('You are not logged in.');
  if (!sessionValid(state)) errOut('Vault is locked.');
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The encoded JSON sits at a different argument index per command — `create item [json]`
 * puts it third, `edit item <id> [json]` fourth — and is read from stdin when absent, which
 * is how this server always sends it.
 */
function decodePayload(index) {
  const inline = positional[index];
  const raw = inline && !inline.startsWith('-') ? inline : readStdin();
  if (!raw.trim()) errOut('No item JSON was provided.');
  try {
    return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  } catch {
    errOut('Could not parse the item JSON.');
  }
}

const state = load();
const cmd = positional[0];

if (process.env.FAKE_BW_FAIL && process.env.FAKE_BW_FAIL === cmd) {
  errOut('ENOTFOUND: could not reach the server.');
}

if (flags.has('--version')) rawOut('2026.8.0-fake');

switch (cmd) {
  case undefined:
    rawOut('2026.8.0-fake');
    break;

  case 'status': {
    const out = {
      serverUrl: state.serverUrl,
      lastSync: state.lastSync,
      userEmail: state.userEmail,
      userId: state.userId,
      status: state.status === 'unauthenticated' ? 'unauthenticated' : sessionValid(state) ? 'unlocked' : 'locked',
    };
    if (process.env.FAKE_BW_STATUS_EXIT1) {
      process.stdout.write(JSON.stringify({ success: true, data: { object: 'template', template: out } }));
      process.exit(1);
    }
    template(out);
    break;
  }

  case 'config': {
    if (positional[1] !== 'server') errOut('Unknown config setting.');
    if (state.status !== 'unauthenticated') errOut('You are already logged in. Log out before changing the server.');
    state.serverUrl = positional[2] ?? null;
    save(state);
    okOut({ object: 'message', title: 'Saved setting `config`.', message: '', raw: state.serverUrl });
    break;
  }

  case 'login': {
    if (state.status !== 'unauthenticated') errOut('You are already logged in.');
    const email = positional[1];
    const envName = opt('--passwordenv');
    const password = envName ? process.env[envName] : undefined;
    if (!password) errOut('Master password is required. Try again in interactive mode or provide a password file or environment variable.');
    if (password !== PASSWORD) errOut('Username or password is incorrect. Try again.');
    if (process.env.FAKE_BW_REQUIRE_2FA && !opt('--code')) errOut('Code is required. Two-step login is enabled on this account.');
    state.status = 'locked';
    state.userEmail = email;
    state.userId = createHash('sha256').update(String(email)).digest('hex').slice(0, 32);
    state.lastSync = new Date().toISOString();
    if (process.env.FAKE_BW_EMPTY_UNLOCK_ONCE && !state.usedEmptyUnlock) {
      // The real CLI has shipped versions where the first unlock after a login yields no
      // session key until the vault is locked once.
      state.session = null;
      save(state);
      okOut({ object: 'message', title: 'You are logged in!', message: 'To unlock your vault, use the `bw unlock` command.', raw: '' });
    }
    state.session = randomUUID().replace(/-/g, '') + '==';
    save(state);
    okOut({ object: 'message', title: 'You are logged in!', message: '', raw: state.session });
    break;
  }

  case 'unlock': {
    if (state.status === 'unauthenticated') errOut('You are not logged in.');
    const envName = opt('--passwordenv');
    const password = envName ? process.env[envName] : positional[1];
    if (!password) errOut('Master password is required. Try again in interactive mode or provide a password file or environment variable.');
    if (password !== PASSWORD) errOut('Invalid master password.');
    if (process.env.FAKE_BW_EMPTY_UNLOCK_ONCE && !state.usedEmptyUnlock) {
      state.usedEmptyUnlock = true;
      state.session = null;
      save(state);
      okOut({ object: 'message', title: 'Your vault is now unlocked!', message: '', raw: '' });
    }
    state.session = randomUUID().replace(/-/g, '') + '==';
    save(state);
    if (wantsRaw) rawOut(state.session);
    okOut({ object: 'message', title: 'Your vault is now unlocked!', message: '', raw: state.session });
    break;
  }

  case 'lock':
    state.session = null;
    save(state);
    okOut({ object: 'message', title: 'Your vault is locked.', message: '', raw: '' });
    break;

  case 'logout':
    Object.assign(state, { status: 'unauthenticated', session: null, userEmail: null, userId: null });
    save(state);
    okOut({ object: 'message', title: 'You have logged out.', message: '', raw: '' });
    break;

  case 'sync':
    requireUnlocked(state);
    state.lastSync = new Date().toISOString();
    save(state);
    okOut({ object: 'message', title: 'Syncing complete.', message: '', raw: '' });
    break;

  case 'list': {
    requireUnlocked(state);
    const what = positional[1];
    if (what === 'folders') {
      list([{ object: 'folder', id: null, name: 'No Folder' }, ...state.folders]);
    }
    if (what !== 'items') errOut('Unknown list object.');
    const search = (opt('--search') ?? '').toLowerCase();
    const url = opt('--url');
    const folderId = opt('--folderid');
    const trash = flags.has('--trash');
    let items = state.items.filter((i) => Boolean(i.deletedDate) === trash);
    if (search) {
      items = items.filter(
        (i) => i.name.toLowerCase().includes(search) || (i.login?.username ?? '').toLowerCase().includes(search),
      );
    }
    if (url) items = items.filter((i) => (i.login?.uris ?? []).some((u) => String(u.uri).includes(url)));
    if (folderId) items = items.filter((i) => i.folderId === folderId);
    list(items);
    break;
  }

  case 'get': {
    const what = positional[1];
    const id = positional[2];
    if (what === 'template') {
      requireUnlocked(state);
      template({
        object: 'item',
        type: 1,
        name: 'Item name',
        notes: 'Some notes about this item.',
        favorite: false,
        fields: [],
        login: null,
        reprompt: 0,
      });
    }
    requireUnlocked(state);
    const item = state.items.find((i) => i.id === id);
    if (!item) errOut('Not found.');
    switch (what) {
      case 'item':
        okOut(item);
        break;
      case 'password':
        if (!item.login?.password) errOut('Not found.');
        str(item.login.password);
        break;
      case 'username':
        if (!item.login?.username) errOut('Not found.');
        str(item.login.username);
        break;
      case 'totp':
        if (!item.login?.totp) errOut('Not found.');
        // A stable stand-in: the real CLI derives a live code from the seed.
        str('418205');
        break;
      case 'notes':
        if (!item.notes) errOut('Not found.');
        str(item.notes);
        break;
      default:
        errOut('Unknown get object.');
    }
    break;
  }

  case 'create': {
    requireUnlocked(state);
    const what = positional[1];
    const payload = decodePayload(2);
    if (what === 'folder') {
      const folder = { object: 'folder', id: randomUUID(), name: payload.name };
      state.folders.push(folder);
      save(state);
      okOut(folder);
    }
    if (what !== 'item') errOut('Unknown create object.');
    const item = {
      object: 'item',
      id: randomUUID(),
      organizationId: null,
      folderId: payload.folderId ?? null,
      type: payload.type ?? 1,
      name: payload.name,
      notes: payload.notes ?? null,
      favorite: Boolean(payload.favorite),
      reprompt: payload.reprompt ?? 0,
      revisionDate: new Date().toISOString(),
      deletedDate: null,
      fields: payload.fields ?? [],
      login: payload.login ?? null,
    };
    state.items.push(item);
    save(state);
    okOut(item);
    break;
  }

  case 'edit': {
    requireUnlocked(state);
    if (positional[1] !== 'item') errOut('Unknown edit object.');
    const id = positional[2];
    const idx = state.items.findIndex((i) => i.id === id);
    if (idx < 0) errOut('Not found.');
    const payload = decodePayload(3);
    const merged = { ...state.items[idx], ...payload, id, revisionDate: new Date().toISOString() };
    state.items[idx] = merged;
    save(state);
    okOut(merged);
    break;
  }

  case 'delete': {
    requireUnlocked(state);
    if (positional[1] !== 'item') errOut('Unknown delete object.');
    const id = positional[2];
    const item = state.items.find((i) => i.id === id);
    if (!item) errOut('Not found.');
    if (flags.has('--permanent') || argv.includes('-p')) {
      state.items = state.items.filter((i) => i.id !== id);
    } else {
      item.deletedDate = new Date().toISOString();
    }
    save(state);
    okOut({ object: 'message', title: '', message: '', raw: '' });
    break;
  }

  case 'restore': {
    requireUnlocked(state);
    if (positional[1] !== 'item') errOut('Unknown restore object.');
    const item = state.items.find((i) => i.id === positional[2]);
    if (!item) errOut('Not found.');
    item.deletedDate = null;
    save(state);
    okOut({ object: 'message', title: '', message: '', raw: '' });
    break;
  }

  case 'generate': {
    const passphrase = flags.has('--passphrase');
    if (passphrase) {
      const words = Number(opt('--words') ?? 3);
      const sep = opt('--separator') ?? '-';
      const bank = ['correct', 'horse', 'battery', 'staple', 'anchor', 'meadow', 'lantern', 'quartz'];
      const picked = Array.from({ length: words }, (_, i) => bank[(i * 3 + words) % bank.length]);
      str(picked.join(sep));
    }
    const length = Number(opt('--length') ?? 14);
    let alphabet = '';
    if (argv.includes('-l')) alphabet += 'abcdefghijkmnopqrstuvwxyz';
    if (argv.includes('-u')) alphabet += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (argv.includes('-n')) alphabet += '23456789';
    if (argv.includes('-s')) alphabet += '!@#$%^&*';
    if (!alphabet) alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
    // Deterministic but varied: tests assert on shape, never on a specific value.
    let out = '';
    const seed = createHash('sha256').update(String(Date.now()) + String(Math.random())).digest();
    for (let i = 0; i < length; i++) out += alphabet[seed[i % seed.length] % alphabet.length];
    str(out);
    break;
  }

  default:
    errOut(`Unknown command: ${cmd}`);
}
