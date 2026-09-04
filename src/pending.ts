import { randomUUID } from 'node:crypto';
import { CONFIG } from './config.js';

/**
 * Nothing writes to the vault directly. A tool that would change something parks the
 * intended change here and hands back an id; the change happens only when a human confirms
 * it, either by clicking Save in the card or by answering a native dialog.
 *
 * Two properties matter: ids are unguessable (so a model cannot confirm an action it never
 * saw), and each is single-use with a deadline (so a card left in an old transcript cannot
 * be replayed days later).
 */

export type PendingKind = 'create' | 'edit' | 'delete' | 'restore';

export type Pending = {
  id: string;
  kind: PendingKind;
  /** Target item id, absent for a create. */
  itemId?: string;
  /** What the user is shown, and what gets written on confirm. */
  payload: Record<string, unknown>;
  /** Human-readable summary lines for the confirm view, already sanitised. */
  summary: { label: string; before?: string; after?: string }[];
  createdAt: number;
  expiresAt: number;
};

const store = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [id, p] of store) if (p.expiresAt <= now) store.delete(id);
}

export function create(
  kind: PendingKind,
  payload: Record<string, unknown>,
  summary: Pending['summary'],
  itemId?: string,
  now = Date.now(),
): Pending {
  sweep(now);
  const p: Pending = {
    id: randomUUID(),
    kind,
    itemId,
    payload,
    summary,
    createdAt: now,
    expiresAt: now + CONFIG.pendingTtlMs,
  };
  store.set(p.id, p);
  return p;
}

export function peek(id: string, now = Date.now()): Pending | undefined {
  sweep(now);
  return store.get(id);
}

/** Claims an action: returns it once, then it is gone. A second confirm finds nothing. */
export function claim(id: string, now = Date.now()): Pending | undefined {
  sweep(now);
  const p = store.get(id);
  if (!p) return undefined;
  store.delete(id);
  return p;
}

export function cancel(id: string): boolean {
  return store.delete(id);
}

export function clearAll(): void {
  store.clear();
}

export function size(now = Date.now()): number {
  sweep(now);
  return store.size;
}
