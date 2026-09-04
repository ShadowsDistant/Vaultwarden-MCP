import { bw, BwError } from './bw.js';
import { log } from './log.js';
import { isUuid, Sanitizer } from './sanitize.js';
import { onLock, requireUnlocked, sessionEnv, touch } from './session.js';

/**
 * Vault operations, and the two projections that decide who may see what.
 *
 * Everything `bw` returns is a full cipher: name, username, password, TOTP seed, notes, the
 * lot. Nothing in this file hands one of those objects onward untouched. A caller asks for
 * either the model's view or the card's view, and secrets come out only through
 * `getSecret`, which every caller must justify.
 */

export type BwUri = { uri?: string | null; match?: number | null };

export type BwItem = {
  object?: string;
  id: string;
  organizationId?: string | null;
  folderId?: string | null;
  type: number;
  name: string;
  notes?: string | null;
  favorite?: boolean;
  reprompt?: number;
  revisionDate?: string;
  deletedDate?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: BwUri[] | null;
  } | null;
  fields?: { name?: string | null; value?: string | null; type?: number }[] | null;
};

export type BwFolder = { id: string | null; name: string };

export const ITEM_TYPE = { login: 1, note: 2, card: 3, identity: 4, sshKey: 5 } as const;

export function typeName(t: number): string {
  return (['', 'login', 'note', 'card', 'identity', 'ssh key'][t] ?? 'item') || 'item';
}

/** What the model is allowed to know about an item. */
export type ModelItem = {
  id: string;
  name?: string;
  type: string;
  username?: string;
  /** Scheme and host only; never a full URL. */
  sites?: string[];
  folder?: string;
  favorite?: boolean;
  reprompt?: boolean;
  inTrash?: boolean;
  updated?: string;
  hasPassword: boolean;
  hasTotp: boolean;
  hasNotes: boolean;
  customFields?: number;
};

/** What the card is allowed to render. Still no secrets: those arrive separately. */
export type CardItem = ModelItem & {
  uris?: string[];
  fieldNames?: string[];
};

let folderCache: { at: number; folders: BwFolder[] } | null = null;

export async function listFolders(force = false): Promise<BwFolder[]> {
  requireUnlocked();
  if (!force && folderCache && Date.now() - folderCache.at < 60_000) return folderCache.folders;
  const raw = await bw<BwFolder[]>(['list', 'folders'], { env: sessionEnv() });
  const folders = Array.isArray(raw) ? raw : [];
  folderCache = { at: Date.now(), folders };
  return folders;
}

function folderName(id: string | null | undefined, folders: BwFolder[]): string | undefined {
  if (!id) return undefined;
  return folders.find((f) => f.id === id)?.name ?? undefined;
}

/**
 * The model's view. Note what is missing: the password, the TOTP seed, the notes body, the
 * values of custom fields, and the path and query of every URL. Only their existence is
 * reported, which is enough for the model to talk about an item without holding it.
 */
export function toModelItem(item: BwItem, folders: BwFolder[], s: Sanitizer, opts: { includeUsername?: boolean } = {}): ModelItem {
  const login = item.login ?? undefined;
  const sites = (login?.uris ?? [])
    .map((u, i) => s.cleanUriHost(u?.uri, `sites[${i}]`))
    .filter((v): v is string => Boolean(v))
    .slice(0, 5);
  const out: ModelItem = {
    id: item.id,
    name: s.clean(item.name, 'name'),
    type: typeName(item.type),
    folder: s.clean(folderName(item.folderId, folders), 'folder'),
    favorite: item.favorite || undefined,
    reprompt: item.reprompt === 1 || undefined,
    inTrash: item.deletedDate ? true : undefined,
    updated: item.revisionDate ?? undefined,
    hasPassword: Boolean(login?.password),
    hasTotp: Boolean(login?.totp),
    hasNotes: Boolean(item.notes),
  };
  if (sites.length) out.sites = sites;
  if (opts.includeUsername) out.username = s.clean(login?.username, 'username');
  const fieldCount = (item.fields ?? []).length;
  if (fieldCount) out.customFields = fieldCount;
  return out;
}

/** The card's view: the same facts plus whole URLs and field labels, for a human to read. */
export function toCardItem(item: BwItem, folders: BwFolder[]): CardItem {
  const s = new Sanitizer();
  const base = toModelItem(item, folders, s, { includeUsername: true });
  const login = item.login ?? undefined;
  const uris = (login?.uris ?? []).map((u) => String(u?.uri ?? '')).filter(Boolean);
  const fieldNames = (item.fields ?? []).map((f) => String(f?.name ?? '')).filter(Boolean);
  return {
    ...base,
    // The card renders into textContent, so it gets the real name rather than a redaction.
    name: item.name,
    username: login?.username ?? undefined,
    uris: uris.length ? uris : undefined,
    fieldNames: fieldNames.length ? fieldNames : undefined,
  };
}

/**
 * A very short-lived cache of decrypted items.
 *
 * Every CLI invocation is a fresh Node process booting a webpack bundle, so `bw get item`
 * costs the better part of four seconds. Without this, opening an item and then revealing its
 * password pays that twice, and the second click looks like a button that does nothing.
 *
 * The entries hold real secrets, so: a short life, and emptied the moment the vault locks or
 * anything is written. That is the same memory that already holds the session key, so it adds
 * no new exposure — but it is worth keeping small and brief regardless.
 */
const ITEM_CACHE_MS = 20_000;
const itemCache = new Map<string, { at: number; item: BwItem }>();

export function invalidateCache(): void {
  itemCache.clear();
  folderCache = null;
}

// Decrypted items must not survive the session that decrypted them.
onLock(invalidateCache);

export async function getRawItem(id: string, opts: { fresh?: boolean } = {}): Promise<BwItem> {
  requireUnlocked();
  if (!isUuid(id)) {
    throw new BwError('not_found', 'That is not an item id.', 'Search first and use the id from the result.');
  }
  const hit = itemCache.get(id);
  if (!opts.fresh && hit && Date.now() - hit.at < ITEM_CACHE_MS) return hit.item;

  const item = await bw<BwItem>(['get', 'item', id], { env: sessionEnv() });
  if (!item || typeof item !== 'object' || !item.id) throw new BwError('not_found', 'No such item.');
  itemCache.set(id, { at: Date.now(), item });
  return item;
}

export type SearchQuery = {
  search?: string;
  url?: string;
  folderId?: string;
  trash?: boolean;
  limit: number;
};

export async function searchItems(q: SearchQuery): Promise<{ items: BwItem[]; truncated: boolean }> {
  requireUnlocked();
  const args = ['list', 'items'];
  if (q.search) args.push('--search', q.search);
  if (q.url) args.push('--url', q.url);
  if (q.folderId) args.push('--folderid', q.folderId);
  if (q.trash) args.push('--trash');
  const raw = await bw<BwItem[]>(args, { env: sessionEnv(), timeoutMs: 60_000 });
  const all = Array.isArray(raw) ? raw : [];
  return { items: all.slice(0, q.limit), truncated: all.length > q.limit };
}

export type SecretField = 'password' | 'totp' | 'notes';

/**
 * Reads one secret. Every call site must have a human authorisation behind it: a click in
 * the card, or a native dialog. Nothing here checks that — the callers do, and they are the
 * only place that decision belongs.
 *
 * The password and the notes are already inside the item the caller had to fetch to check its
 * re-prompt flag, so pass it in and no second CLI invocation happens at all. A one-time code
 * is different: what is stored is the seed, and only the CLI turns that into the six digits
 * that are valid right now.
 */
export async function getSecret(id: string, field: SecretField, known?: BwItem): Promise<string> {
  requireUnlocked();
  if (!isUuid(id)) throw new BwError('not_found', 'That is not an item id.');

  if (known && known.id === id && field !== 'totp') {
    const local = field === 'password' ? known.login?.password : known.notes;
    const text = String(local ?? '');
    if (!text) throw new BwError('not_found', `This item has no ${field}.`);
    log.audit('secret_read', { itemId: id, field, cached: true });
    return text;
  }

  const value = await bw<string>(['get', field, id], { env: sessionEnv(), raw: true, timeoutMs: 45_000 });
  const text = String(value ?? '').replace(/\r?\n$/, '');
  if (!text) throw new BwError('not_found', `This item has no ${field}.`);
  log.audit('secret_read', { itemId: id, field });
  return text;
}

export type GenerateOptions = {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  special?: boolean;
  passphrase?: boolean;
  words?: number;
  separator?: string;
  capitalize?: boolean;
  includeNumber?: boolean;
};

export async function generate(opts: GenerateOptions): Promise<string> {
  const args = ['generate'];
  if (opts.passphrase) {
    args.push('--passphrase');
    if (opts.words) args.push('--words', String(Math.min(20, Math.max(3, opts.words))));
    if (opts.separator) args.push('--separator', opts.separator.slice(0, 3));
    if (opts.capitalize) args.push('--capitalize');
    if (opts.includeNumber) args.push('--includeNumber');
  } else {
    if (opts.uppercase !== false) args.push('-u');
    if (opts.lowercase !== false) args.push('-l');
    if (opts.numbers !== false) args.push('-n');
    if (opts.special) args.push('-s');
    args.push('--length', String(Math.min(128, Math.max(8, opts.length ?? 20))));
  }
  const value = await bw<string>(args, { raw: true, timeoutMs: 30_000 });
  const text = String(value ?? '').trim();
  if (!text) throw new BwError('unknown', 'The generator returned nothing.');
  return text;
}

/**
 * A rough strength read for the card's meter. Deliberately not a security control: it never
 * blocks anything, it just tells a human whether what they are about to save looks weak.
 */
export function strength(secret: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const len = secret.length;
  let classes = 0;
  if (/[a-z]/.test(secret)) classes++;
  if (/[A-Z]/.test(secret)) classes++;
  if (/[0-9]/.test(secret)) classes++;
  if (/[^A-Za-z0-9]/.test(secret)) classes++;
  const bitsPerChar = [0, 3.3, 4.7, 5.5, 6.5][classes] ?? 4;
  const bits = len * bitsPerChar;
  let score: 0 | 1 | 2 | 3 | 4 = 0;
  if (bits >= 40) score = 1;
  if (bits >= 60) score = 2;
  if (bits >= 80) score = 3;
  if (bits >= 110) score = 4;
  if (len < 8) score = 0;
  return { score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] };
}

export type NewLogin = {
  name: string;
  username?: string;
  password?: string;
  uri?: string;
  folderId?: string | null;
  notes?: string;
  favorite?: boolean;
};

function buildLoginPayload(input: NewLogin): Record<string, unknown> {
  const uris = input.uri ? [{ match: null, uri: input.uri }] : [];
  return {
    object: 'item',
    type: ITEM_TYPE.login,
    name: input.name,
    notes: input.notes ?? null,
    favorite: Boolean(input.favorite),
    folderId: input.folderId ?? null,
    reprompt: 0,
    fields: [],
    login: {
      username: input.username ?? null,
      password: input.password ?? null,
      totp: null,
      uris,
    },
  };
}

/**
 * Item JSON reaches the CLI as base64 on stdin, never as an argument. A password in an argv
 * is readable by every process on the machine and is captured by command-line auditing.
 */
async function writeItem(args: string[], payload: Record<string, unknown>): Promise<BwItem> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return bw<BwItem>(args, { env: sessionEnv(), stdin: encoded, timeoutMs: 60_000 });
}

export async function createLogin(input: NewLogin): Promise<BwItem> {
  requireUnlocked();
  const created = await writeItem(['create', 'item'], buildLoginPayload(input));
  invalidateCache();
  log.audit('item_created', { itemId: created?.id });
  touch();
  return created;
}

export type ItemPatch = {
  name?: string;
  username?: string;
  password?: string;
  uri?: string;
  folderId?: string | null;
  notes?: string;
  favorite?: boolean;
};

/**
 * Applies a patch on top of the item as it currently stands. Read-modify-write is the only
 * option the CLI offers: `edit item` replaces the whole cipher, so anything not carried
 * over is destroyed.
 */
export async function editItem(id: string, patch: ItemPatch): Promise<BwItem> {
  requireUnlocked();
  const current = await getRawItem(id);
  const next: Record<string, unknown> = {
    ...current,
    name: patch.name ?? current.name,
    notes: patch.notes !== undefined ? patch.notes : (current.notes ?? null),
    favorite: patch.favorite !== undefined ? patch.favorite : Boolean(current.favorite),
    folderId: patch.folderId !== undefined ? patch.folderId : (current.folderId ?? null),
  };
  if (current.type === ITEM_TYPE.login) {
    const login = current.login ?? {};
    const uris = patch.uri !== undefined ? [{ match: null, uri: patch.uri }] : (login.uris ?? []);
    next.login = {
      ...login,
      username: patch.username !== undefined ? patch.username : (login.username ?? null),
      password: patch.password !== undefined ? patch.password : (login.password ?? null),
      uris,
    };
  }
  const saved = await writeItem(['edit', 'item', id], next);
  invalidateCache();
  log.audit('item_edited', { itemId: id, fields: Object.keys(patch) });
  touch();
  return saved;
}

/**
 * Sends an item to the trash, where Vaultwarden keeps it for 30 days. There is no permanent
 * delete in this server: an irreversible action taken on a model's say-so has no acceptable
 * failure mode, and the web vault is two clicks away for the rare time it is wanted.
 */
export async function trashItem(id: string): Promise<void> {
  requireUnlocked();
  if (!isUuid(id)) throw new BwError('not_found', 'That is not an item id.');
  await bw(['delete', 'item', id], { env: sessionEnv(), timeoutMs: 60_000 });
  invalidateCache();
  log.audit('item_trashed', { itemId: id });
  touch();
}

export async function restoreItem(id: string): Promise<void> {
  requireUnlocked();
  if (!isUuid(id)) throw new BwError('not_found', 'That is not an item id.');
  await bw(['restore', 'item', id], { env: sessionEnv(), timeoutMs: 60_000 });
  invalidateCache();
  log.audit('item_restored', { itemId: id });
  touch();
}

