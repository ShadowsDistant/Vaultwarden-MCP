import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { log } from './log.js';
import { hostOfUri, settings as settingsNow } from './settings.js';

/**
 * The activity log the Settings app shows: what was done with the vault, by whom and when.
 *
 * One JSON object per line in `<home>/activity.jsonl`. It names items and sites, because "which
 * passwords did the assistant get at" is the whole point of it, and it never holds a secret:
 * no password, one-time code or seed, notes, username, session key, API key or full web address.
 * An item is its id, its name and the host of its first saved site, nothing more.
 *
 * Writing is best effort. A log that cannot be written must never stop a vault operation.
 */

export type Actor = 'assistant' | 'you' | 'settings_app' | 'system';

export type ActivityItem = { id: string; name?: string; host?: string };

export type ActivityEvent = {
  actor: Actor;
  action: string;
  ok?: boolean;
  item?: ActivityItem;
  field?: string;
  outcome?: string;
  via?: string;
  query?: string;
  count?: number;
  fields?: string[];
  error?: string;
};

/** The line as written. Field order is fixed so the file reads well by eye too. */
export type ActivityLine = { v: 1; at: string; actor: Actor; app?: string } & Omit<ActivityEvent, 'actor'> & { ok: boolean };

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 3000;

let appName: string | undefined;

/** The AI app's own name for itself, made readable. Set once, when the client introduces itself. */
export function friendlyApp(raw: string | undefined): string | undefined {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return undefined;
  if (/claude/i.test(name)) return 'Claude';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/windsurf/i.test(name)) return 'Windsurf';
  if (/vscode|code/i.test(name)) return 'VS Code';
  return name.length > 40 ? name.slice(0, 40) : name;
}

export function setClient(raw: string | undefined): void {
  appName = friendlyApp(raw);
}

function clip(text: unknown, max: number): string | undefined {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type ItemLike = { id?: string | null; name?: string | null; login?: { uris?: { uri?: string | null }[] | null } | null };

/** An item as the log may hold it: id, name, and the host of the first saved site only. */
export function itemOf(raw: ItemLike): ActivityItem {
  const first = raw.login?.uris?.find((u) => u?.uri && String(u.uri).trim())?.uri;
  const out: ActivityItem = { id: String(raw.id ?? '') };
  const name = clip(raw.name, 80);
  if (name) out.name = name;
  const host = hostOfUri(first ?? undefined);
  if (host) out.host = host;
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function enabled(): boolean {
  try {
    return settingsNow().activityLog !== false;
  } catch {
    return true;
  }
}

function trim(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-KEEP_LINES).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn('could not trim the activity log', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Writes one event. Never throws. */
export function record(e: ActivityEvent): void {
  if (!enabled()) return;
  try {
    const line: ActivityLine = {
      v: 1,
      at: new Date().toISOString(),
      actor: e.actor,
      ...(appName && (e.actor === 'assistant' || e.actor === 'you') ? { app: appName } : {}),
      action: e.action,
      ok: e.ok !== false,
      ...(e.item ? { item: e.item } : {}),
      ...(e.field ? { field: e.field } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
      ...(e.via ? { via: e.via } : {}),
      ...(e.query ? { query: clip(e.query, 60) } : {}),
      ...(typeof e.count === 'number' ? { count: e.count } : {}),
      ...(e.fields?.length ? { fields: e.fields } : {}),
      ...(e.error ? { error: clip(e.error, 160) } : {}),
    };
    const file = CONFIG.activityLogFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
    trim(file);
  } catch (err) {
    log.warn('could not write the activity log', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// One event per tool call
// ---------------------------------------------------------------------------

type Ctx = { event: ActivityEvent; skip: boolean; failed?: string };
const current = new AsyncLocalStorage<Ctx>();

/**
 * Runs `body` with an event open. Whatever the body notes along the way (the item it touched,
 * the decision on a secret) lands in that one event, written when `finish` is called.
 */
export function track<T>(start: ActivityEvent, body: (finish: (ok: boolean, error?: string) => void) => Promise<T>): Promise<T> {
  const ctx: Ctx = { event: { ...start }, skip: false };
  let done = false;
  const finish = (ok: boolean, error?: string): void => {
    if (done || ctx.skip) return;
    done = true;
    const good = ok && ctx.failed === undefined;
    record({ ...ctx.event, ok: good, ...(good ? {} : { error: error ?? ctx.failed ?? ctx.event.error }) });
  };
  return current.run(ctx, () => body(finish));
}

/** Adds to the open event, if there is one. Later notes win, except that the first item stays. */
export function note(fields: Partial<Omit<ActivityEvent, 'actor' | 'item'>>): void {
  const ctx = current.getStore();
  if (!ctx) return;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (ctx.event as Record<string, unknown>)[k] = v;
}

/** Records which item the open event is about. The first item noted is the one it is about. */
export function noteItem(raw: ItemLike): void {
  const ctx = current.getStore();
  if (!ctx) return;
  const it = itemOf(raw);
  // An item with no id yet is a new login being proposed; it is named, not identified.
  if (!it.id && !it.name) return;
  const had = ctx.event.item;
  if (had && had.id && it.id && had.id !== it.id) return;
  ctx.event.item = { ...it, ...(had?.name && !it.name ? { name: had.name } : {}), ...(had?.host && !it.host ? { host: had.host } : {}) };
}

/** The call returned normally but did not do what was asked (a window was closed, say). */
export function failed(error: string): void {
  const ctx = current.getStore();
  if (ctx) ctx.failed = error;
}

/** An item known only by id so far; a later noteItem with the same id fills in the name. */
export function noteId(id: string): void {
  const ctx = current.getStore();
  if (!ctx || ctx.event.item) return;
  ctx.event.item = { id };
}

/** The open event should not be written after all (nothing worth showing happened). */
export function skip(): void {
  const ctx = current.getStore();
  if (ctx) ctx.skip = true;
}

/** Changes what the open event is called, for a tool whose action depends on the state. */
export function rename(action: string): void {
  const ctx = current.getStore();
  if (ctx) ctx.event.action = action;
}
