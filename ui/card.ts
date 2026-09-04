// The inline vault card: an MCP App that talks to the vaultwarden server through the host.
//
// Two rules shape all of it. Every piece of vault text is written with textContent, never
// markup, because item names and notes are attacker-influenceable. And no secret is ever
// held in this document until the person watching asks for it: the card is handed item
// metadata, and it fetches a password only on a click, through an app-only tool the model
// cannot call.

import { App } from '@modelcontextprotocol/ext-apps';

type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string };

type Item = {
  id: string;
  name?: string;
  type?: string;
  username?: string;
  uris?: string[];
  sites?: string[];
  folder?: string;
  favorite?: boolean;
  reprompt?: boolean;
  inTrash?: boolean;
  updated?: string;
  hasPassword?: boolean;
  hasTotp?: boolean;
  hasNotes?: boolean;
  fieldNames?: string[];
};

type StatusInfo = {
  state: 'no_cli' | 'unconfigured' | 'unauthenticated' | 'locked' | 'unlocked';
  server?: string;
  email?: string;
  lastSync?: string;
  autoLockMinutes?: number;
  locksInSeconds?: number;
};

type Payload = {
  view?: string;
  status?: StatusInfo;
  canPrompt?: boolean;
  canCopy?: boolean;
  item?: Item;
  itemId?: string;
  items?: Item[];
  count?: number;
  truncated?: boolean;
  query?: string;
  includeTrash?: boolean;
  draftId?: string;
  actionId?: string;
  kind?: string;
  mode?: string;
  fields?: Record<string, unknown>;
  secret?: string;
  strength?: Strength;
  folders?: { id: string | null; name: string }[];
  rows?: { label: string; before?: string; after?: string }[];
  title?: string;
  itemName?: string;
  note?: string;
  message?: string;
  meta?: Record<string, unknown>;
  options?: Record<string, unknown>;
  iconBase?: string;
  total?: number;
  unlocked?: boolean;
  saved?: boolean;
  error?: string;
  hint?: string;
};

const app = new App({ name: 'vaultwarden-card', version: '0.1.0' }, {}, { autoResize: false });

const card = document.getElementById('card') as HTMLDivElement;
const body = document.getElementById('body') as HTMLDivElement;

let current: Payload = {};
let toolPending = false;
let busy = 0;

// ---------------------------------------------------------------------------
// DOM helpers. Everything user-visible goes through `text`, which only ever sets
// textContent, so no vault string is ever parsed as markup.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function frag(...nodes: (Node | null | undefined | false)[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const n of nodes) if (n) f.append(n);
  return f;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Builds an inline icon. The path data are constants in this file, never vault content. */
function icon(paths: string[], opts: { fill?: boolean; size?: number } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (opts.fill) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const ICONS = {
  eye: ['M2.2 12S5.7 5.5 12 5.5 21.8 12 21.8 12 18.3 18.5 12 18.5 2.2 12 2.2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  eyeOff: ['M3 3l18 18', 'M10.6 10.6a3 3 0 0 0 4.2 4.2', 'M9.4 5.8A9.6 9.6 0 0 1 12 5.5c6.3 0 9.8 6.5 9.8 6.5a17 17 0 0 1-3 3.9', 'M6.2 7.3A17 17 0 0 0 2.2 12S5.7 18.5 12 18.5c1 0 1.9-.1 2.7-.4'],
  copy: ['M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2Z', 'M15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5'],
  check: ['M4.5 12.8 9.3 17.5 19.5 7'],
  refresh: ['M20 11.5A8 8 0 1 0 18.4 17', 'M20.5 6.5V12h-5.5'],
  chevron: ['M9 5.5 15.5 12 9 18.5'],
  back: ['M15 5.5 8.5 12 15 18.5'],
  link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3'],
  lock: ['M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', 'M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7'],
  unlock: ['M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', 'M8.5 10.5V7.8a3.5 3.5 0 0 1 6.6-1.6'],
  sync: ['M3.5 12a8.5 8.5 0 0 1 14.6-5.9L20.5 8.5', 'M20.5 3.5v5h-5', 'M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3.5 15.5', 'M3.5 20.5v-5h5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 7.8h.01'],
  shield: ['M12 3 20 6v6c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6l8-3Z'],
  trash: ['M4.5 7h15', 'M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7', 'M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L17.5 7'],
  star: ['M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.9l5.4-.8L12 4.2Z'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
};

/**
 * A button that shows it is working.
 *
 * Every one of these ends in a call to the Bitwarden CLI, which spawns a process and can take
 * a few seconds. Without a spinner the card sits there looking identical to before the click,
 * so the button reads as broken and gets pressed again — and the log fills with the same
 * reveal three times over. `onClick` may return a promise; the spinner lasts as long as it
 * does.
 */
function iconButton(kind: keyof typeof ICONS, label: string, onClick: () => void | Promise<unknown>): HTMLButtonElement {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(ICONS[kind]));
  b.addEventListener('click', () => {
    if (b.classList.contains('working')) return;
    const done = onClick();
    if (!done || typeof (done as Promise<unknown>).finally !== 'function') return;
    const restore = b.firstChild;
    b.classList.add('working');
    b.replaceChildren(spinner());
    void (done as Promise<unknown>).finally(() => {
      b.classList.remove('working');
      // A handler that repainted the card left this button detached; there is nothing to
      // restore it to, and doing so would resurrect a node nobody can see.
      if (b.isConnected && restore) b.replaceChildren(restore);
    });
  });
  return b;
}

/** A small indeterminate ring, sized like the icon it replaces. */
function spinner(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-label', 'Working');
  svg.classList.add('spin');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', '12');
  track.setAttribute('cy', '12');
  track.setAttribute('r', '8.5');
  track.setAttribute('stroke', 'currentColor');
  track.setAttribute('stroke-width', '2.2');
  track.setAttribute('opacity', '0.25');
  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', 'M12 3.5a8.5 8.5 0 0 1 8.5 8.5');
  arc.setAttribute('stroke', 'currentColor');
  arc.setAttribute('stroke-width', '2.2');
  arc.setAttribute('stroke-linecap', 'round');
  svg.append(track, arc);
  return svg;
}

function button(
  label: string,
  cls: string,
  onClick: () => void | Promise<unknown>,
  iconKind?: keyof typeof ICONS,
  busyLabel?: string,
): HTMLButtonElement {
  const b = el('button', `btn ${cls}`);
  b.type = 'button';
  const paint = (text: string, glyph?: Node): void => {
    b.replaceChildren();
    if (glyph) b.append(glyph);
    b.append(document.createTextNode(text));
  };
  paint(label, iconKind ? icon(ICONS[iconKind]) : undefined);
  b.addEventListener('click', () => {
    if (b.hasAttribute('disabled')) return;
    const done = onClick();
    if (!done || typeof (done as Promise<unknown>).finally !== 'function') return;
    b.setAttribute('disabled', 'true');
    paint(busyLabel ?? label, spinner());
    void (done as Promise<unknown>).finally(() => {
      if (!b.isConnected) return;
      b.removeAttribute('disabled');
      paint(label, iconKind ? icon(ICONS[iconKind]) : undefined);
    });
  });
  return b;
}

/** Momentary "done" feedback on an icon button, so a copy is visibly acknowledged. */
function flash(btn: HTMLButtonElement, label: string): void {
  const original = btn.firstChild;
  btn.replaceChildren(icon(ICONS.check));
  btn.classList.add('on');
  btn.title = label;
  setTimeout(() => {
    if (original) btn.replaceChildren(original);
    btn.classList.remove('on');
  }, 1400);
}

// ---------------------------------------------------------------------------
// Host plumbing
// ---------------------------------------------------------------------------

type HostCtx = { theme?: string; styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } } };

let fontsApplied = false;
function applyHost(ctx: HostCtx | undefined): void {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme;
  const vars = ctx.styles?.variables;
  if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !fontsApplied) {
    fontsApplied = true;
    const s = document.createElement('style');
    s.textContent = fonts;
    document.head.append(s);
  }
}

const SHADOW_SLACK = 10;
let sizeQueued = false;
let sentHeight = -1;

/**
 * `card.offsetHeight` rather than `documentElement.scrollHeight`: the latter is
 * max(content, viewport), so once the host has grown the frame the card can never ask for
 * less and a collapsed section leaves a hole underneath it.
 */
function notifySize(): void {
  if (sizeQueued) return;
  sizeQueued = true;
  setTimeout(() => {
    sizeQueued = false;
    const height = card.offsetHeight + SHADOW_SLACK;
    if (height === sentHeight) return;
    sentHeight = height;
    void app.sendSizeChanged({ height }).catch(() => undefined);
  }, 50);
}

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Both halves of a tool result, merged.
 *
 * Reading only `structuredContent` silently broke the reveal button: a secret is deliberately
 * kept out of `structuredContent` — that field is assumed to be model-visible — so the value
 * lives in `content` alone, and the card found nothing there to show. Anything the server
 * puts in either half is now visible to the card, with the structured half winning where they
 * overlap, since that is the one shaped for rendering.
 */
function parse(result: ToolResult): Payload & Record<string, unknown> {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  let fromText: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fromText = parsed as Record<string, unknown>;
    } catch {
      // A tool that failed before it could produce JSON: the text is the message.
      return { error: text };
    }
  }
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (!text && !Object.keys(structured).length) return { error: 'empty result' };
  return { ...fromText, ...structured } as Payload & Record<string, unknown>;
}

/** One call at a time, queued rather than dropped: a dropped click looks like a bug. */
let chain: Promise<unknown> = Promise.resolve();

/** Set only by the standalone preview server; inside a host this stays false. */
let demoMode = false;

function call(name: string, args: Record<string, unknown> = {}): Promise<Payload & Record<string, unknown>> {
  if (demoMode) return Promise.resolve(demoCall(name, args));
  const runIt = async (): Promise<Payload & Record<string, unknown>> => {
    busy++;
    card.classList.add('busy');
    try {
      const res = (await app.callServerTool({ name, arguments: args })) as ToolResult;
      return parse(res);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy--;
      if (busy === 0) card.classList.remove('busy');
    }
  };
  const next = chain.then(runIt, runIt);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Tells the model, in one non-secret line, what the person just did in the card. Without
 * this it would carry on believing an item was never saved.
 */
function tellModel(text: string): void {
  void app.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function initial(name: string | undefined): string {
  const s = (name ?? '?').trim();
  const ch = [...s][0];
  return (ch ?? '?').toUpperCase();
}

/** Where site icons come from, as the server most recently reported it. */
let iconBase: string | undefined;

/**
 * The site icon for an item, or nothing.
 *
 * The URL is built from the vault's own instance plus a host taken from the item, so the only
 * place a request can go is the server that already holds every one of these items. The host
 * is checked against a strict pattern first — vault content decides this path, and a value
 * shaped like anything other than a hostname simply does not get one.
 */
function iconUrl(it: Item): string | undefined {
  if (!iconBase) return undefined;
  const first = (it.uris ?? it.sites ?? [])[0];
  if (!first) return undefined;
  let host: string;
  try {
    host = new URL(first.includes('://') ? first : `https://${first}`).hostname;
  } catch {
    return undefined;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return undefined;
  return `${iconBase}/icons/${encodeURIComponent(host)}/icon.png`;
}

/**
 * An item's avatar: its site icon where there is one, its initial where there is not.
 *
 * The icon is layered over the letter rather than replacing it, so a request that fails —
 * offline, no icon for that domain, icons disabled on the instance — leaves the letter
 * showing instead of a broken-image mark.
 */
function avatar(it: Item, cls: string): HTMLElement {
  const wrap = el('div', cls, initial(it.name));
  const src = iconUrl(it);
  if (!src) return wrap;
  const img = el('img', 'favicon');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('load', () => img.classList.add('shown'));
  img.addEventListener('error', () => img.remove());
  img.src = src;
  wrap.append(img);
  return wrap;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri.includes('://') ? uri : `https://${uri}`).host;
  } catch {
    return uri;
  }
}

function ago(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const METER_COLOURS = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--success)', 'var(--success)'];

function meter(strength: Strength | undefined): HTMLElement {
  const wrap = el('div', 'meter');
  const track = el('div', 'meter-track');
  const fill = el('div', 'meter-fill');
  const score = strength?.score ?? 0;
  fill.style.width = `${((score + 1) / 5) * 100}%`;
  fill.style.background = METER_COLOURS[score];
  track.append(fill);
  const label = el('span', 'meter-label', strength?.label ?? '');
  label.style.color = METER_COLOURS[score];
  wrap.append(track, label);
  return wrap;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function header(title: string, subtitle?: string, pill?: { text: string; cls: string }): HTMLElement {
  const head = el('div', 'head');
  const mark = icon(ICONS.shield, { size: 22 });
  mark.classList.add('mark');
  mark.setAttribute('stroke', 'currentColor');
  mark.style.color = 'var(--accent)';
  head.append(mark);
  const col = el('div', 'col grow');
  col.append(el('div', 'head-title truncate', title));
  if (subtitle) col.append(el('div', 'head-sub truncate', subtitle));
  head.append(col);
  if (pill) head.append(el('span', `pill ${pill.cls}`, pill.text));
  return head;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function renderStatus(p: Payload): Node {
  const st = p.status ?? { state: 'unconfigured' as const };
  const map: Record<string, { pill: string; cls: string; line: string }> = {
    no_cli: { pill: 'Unavailable', cls: 'off', line: 'The Bitwarden CLI is missing from this install.' },
    unconfigured: { pill: 'Not set up', cls: 'off', line: 'No vault server is configured yet.' },
    unauthenticated: { pill: 'Signed out', cls: 'warn', line: 'Sign in to reach your vault.' },
    locked: { pill: 'Locked', cls: 'warn', line: 'Your vault is locked.' },
    unlocked: { pill: 'Unlocked', cls: 'ok', line: 'Your vault is open.' },
  };
  const info = map[st.state] ?? map.unconfigured;

  const out = frag();
  const head = header('Vault', st.server ?? 'No server set', { text: info.pill, cls: info.cls });
  const pill = head.querySelector('.pill') as HTMLElement | null;
  out.append(head);

  const main = el('div', 'pad row');
  const glyph = el('div', 'avatar');
  glyph.append(icon(st.state === 'unlocked' ? ICONS.unlock : ICONS.lock));
  main.append(glyph);
  const col = el('div', 'col grow');
  const headline = el('div', 'name', info.line);
  col.append(headline);
  const sub = el('div', 'sub truncate');
  col.append(sub);

  // The countdown is arithmetic on the number this card was handed, not a question asked
  // again. When it runs out the card says so on its own — which is the truth, since the
  // server locks on the same clock — and still nothing was polled to find out.
  const paintSub = (): void => {
    const bits: string[] = [];
    if (st.email) bits.push(st.email);
    if (st.state === 'unlocked' && st.lastSync) bits.push(`synced ${ago(st.lastSync)}`);
    if (st.state === 'unlocked' && st.autoLockMinutes && st.locksInSeconds !== undefined) {
      const left = st.locksInSeconds - Math.floor((Date.now() - shownAt) / 1000);
      if (left > 0) {
        bits.push(left >= 60 ? `locks in ${Math.ceil(left / 60)} min` : `locks in under a minute`);
      } else {
        headline.textContent = 'Your vault has locked itself.';
        glyph.replaceChildren(icon(ICONS.lock));
        if (pill) {
          pill.textContent = 'Locked';
          pill.className = 'pill warn';
        }
        clearInterval(countdown);
      }
    }
    sub.textContent = bits.join(' · ');
    sub.hidden = bits.length === 0;
  };
  const shownAt = Date.now();
  const countdown = setInterval(paintSub, 15_000) as unknown as number;
  statusTimers.push(countdown);
  paintSub();

  main.append(col);
  out.append(main);

  if (p.error === 'cancelled') {
    out.append(el('div', 'note', 'The password window was dismissed. Nothing was changed.'));
  } else if (p.error === 'bad_password') {
    out.append(el('div', 'note warn', 'That master password was not accepted. Try again.'));
  }

  if (st.state === 'unconfigured') {
    out.append(
      el(
        'div',
        'note',
        'The vault address is set when the server is installed, not from chat. See the README for the one-line setting, then restart Claude.',
      ),
    );
  }

  const actions = el('div', 'actions');
  if (st.state === 'unauthenticated' || st.state === 'locked') {
    actions.append(
      button(
        st.state === 'locked' ? 'Unlock' : 'Sign in',
        'primary',
        () => act('vault_ui_unlock'),
        'unlock',
        'Waiting for the window',
      ),
    );
    const hintLine = el('span', 'head-sub', 'Opens a window on your desktop');
    hintLine.style.alignSelf = 'center';
    actions.append(hintLine);
  } else if (st.state === 'unlocked') {
    actions.append(button('Open vault', 'primary', () => act('vault_ui_search'), 'unlock', 'Loading'));
    actions.append(button('Lock now', 'ghost', () => act('vault_ui_lock'), 'lock', 'Locking'));
    actions.append(button('Sync', 'ghost', () => act('vault_ui_sync'), 'sync', 'Syncing'));
  }
  if (actions.childElementCount) out.append(actions);
  return out;
}

function renderList(p: Payload): Node {
  const items = p.items ?? [];
  const out = frag();
  const total = typeof p.total === 'number' ? p.total : items.length;
  out.append(
    header(
      total === 1 ? '1 item' : `${total} items`,
      p.truncated ? `showing the first ${items.length}` : p.unlocked ? 'vault unlocked' : undefined,
      p.unlocked ? { text: 'Unlocked', cls: 'ok' } : undefined,
    ),
  );
  if (!items.length) {
    out.append(el('div', 'empty', 'No items matched.'));
    return out;
  }
  const list = el('div', 'list');
  for (const it of items) {
    const row = el('button', 'list-row');
    row.type = 'button';
    row.append(avatar(it, 'list-avatar'));
    const col = el('div', 'col grow');
    col.append(el('div', 'list-name truncate', it.name ?? 'Untitled'));
    const sub = [it.username, (it.uris ?? it.sites ?? []).map(hostOf)[0]].filter(Boolean).join(' · ');
    if (sub) col.append(el('div', 'list-sub truncate', sub));
    row.append(col);
    if (it.inTrash) row.append(el('span', 'pill', 'Trash'));
    const chev = el('span', 'chev');
    chev.append(icon(ICONS.chevron));
    row.append(chev);
    row.addEventListener('click', () => void openItem(it.id));
    list.append(row);
  }
  out.append(list);
  return out;
}

/** Reveal state is per-render and never persisted; a re-render always starts hidden. */
type RevealState = { value: string; timer: number };
const revealed = new Map<string, RevealState>();

function clearReveals(): void {
  for (const r of revealed.values()) clearTimeout(r.timer);
  revealed.clear();
}

let totpTimer: number | undefined;

/** Intervals owned by whatever is currently on screen. Cleared before each repaint. */
const statusTimers: number[] = [];

function clearRenderTimers(): void {
  for (const t of statusTimers.splice(0)) clearInterval(t);
  if (totpTimer !== undefined) {
    clearInterval(totpTimer);
    totpTimer = undefined;
  }
}

function renderItem(p: Payload): Node {
  const it = p.item;
  const out = frag();
  if (!it) {
    out.append(header('Vault item'));
    out.append(el('div', 'empty', 'That item could not be loaded.'));
    return out;
  }

  out.append(header(it.inTrash ? 'In the trash' : 'Vault item', it.folder ?? undefined, p.saved ? { text: 'Saved', cls: 'ok' } : undefined));

  const ident = el('div', 'pad row');
  ident.append(avatar(it, 'avatar'));
  const col = el('div', 'col grow');
  col.append(el('div', 'name truncate', it.name ?? 'Untitled'));
  const metaBits: string[] = [];
  if (it.updated) metaBits.push(`updated ${ago(it.updated)}`);
  if (it.reprompt) metaBits.push('re-prompt');
  if (metaBits.length) col.append(el('div', 'sub truncate', metaBits.join(' · ')));
  ident.append(col);
  if (it.favorite) {
    const star = el('span', 'chev');
    star.append(icon(ICONS.star));
    star.style.color = 'var(--warn)';
    star.title = 'Favourite';
    ident.append(star);
  }
  out.append(ident);

  const fields = el('div', 'fields');

  if (it.username) fields.append(plainField('User', it.username, () => void copyField(it.id, 'username'), p.canCopy !== false));
  if (it.hasPassword) fields.append(secretField(it, 'password', 'Password', p.canCopy !== false));
  if (it.hasTotp) fields.append(totpField(it, p.canCopy !== false));

  const uris = it.uris ?? it.sites ?? [];
  if (uris.length) {
    const f = el('div', 'field');
    f.append(el('div', 'field-label', 'Site'));
    const link = el('button', 'field-value grow truncate');
    link.type = 'button';
    link.textContent = hostOf(uris[0]);
    link.style.background = 'none';
    link.style.border = 'none';
    link.style.padding = '0';
    link.style.textAlign = 'left';
    link.style.color = 'var(--accent)';
    link.style.cursor = 'pointer';
    link.title = uris[0];
    link.addEventListener('click', () => {
      void app.openLink({ url: uris[0] }).catch(() => showError('This host would not open the link.'));
    });
    f.append(link);
    const actions = el('div', 'field-actions');
    actions.append(
      iconButton('link', 'Open site', async () => {
        const r = await app.openLink({ url: uris[0] }).catch(() => ({ isError: true }));
        if (r?.isError) showError('This host would not open the link. The address is above; copy it if you need it.');
      }),
    );
    f.append(actions);
    fields.append(f);
  }

  if (it.hasNotes) fields.append(secretField(it, 'notes', 'Notes', p.canCopy !== false));

  out.append(fields);

  const actions = el('div', 'actions');
  if (it.inTrash) {
    actions.append(el('span', 'head-sub', 'Ask Claude to restore this item.'));
  } else {
    actions.append(button('Back to results', 'ghost', () => backToList(), 'back', 'Loading'));
  }
  if (actions.childElementCount) out.append(actions);
  return out;
}

function plainField(label: string, value: string, onCopy: () => Promise<void>, canCopy: boolean): HTMLElement {
  const f = el('div', 'field');
  f.append(el('div', 'field-label', label));
  f.append(el('div', 'field-value grow truncate', value));
  if (canCopy) {
    const actions = el('div', 'field-actions');
    const b = iconButton('copy', `Copy ${label.toLowerCase()}`, async () => {
      await onCopy();
      flash(b, 'Copied');
    });
    actions.append(b);
    f.append(actions);
  }
  return f;
}

function secretField(it: Item, field: 'password' | 'notes', label: string, canCopy: boolean): HTMLElement {
  const key = `${it.id}:${field}`;
  const f = el('div', 'field');
  f.append(el('div', 'field-label', label));
  const value = el('div', 'field-value grow truncate' + (field === 'password' ? ' mono' : ''));
  const shown = revealed.get(key);
  if (shown) {
    value.textContent = shown.value;
  } else {
    value.className = 'field-value grow dots';
    value.textContent = '••••••••••••';
  }
  f.append(value);

  const actions = el('div', 'field-actions');
  const eye = iconButton(shown ? 'eyeOff' : 'eye', shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`, () => {
    if (revealed.has(key)) {
      const r = revealed.get(key)!;
      clearTimeout(r.timer);
      revealed.delete(key);
      render(current);
      return;
    }
    return reveal(it.id, field, key);
  });
  actions.append(eye);
  if (canCopy) {
    const cp = iconButton('copy', `Copy ${label.toLowerCase()}`, async () => {
      await copyField(it.id, field);
      flash(cp, 'Copied');
    });
    actions.append(cp);
  }
  f.append(actions);
  return f;
}

function totpField(it: Item, canCopy: boolean): HTMLElement {
  const key = `${it.id}:totp`;
  const f = el('div', 'field');
  f.append(el('div', 'field-label', 'One-time'));
  const wrap = el('div', 'totp grow');
  const shown = revealed.get(key);
  if (shown) {
    const code = el('span', 'totp-code', shown.value.replace(/(\d{3})(?=\d)/, '$1 '));
    wrap.append(code);
    // A TOTP is valid for the remainder of its 30-second step; the ring shows that, and the
    // code is dropped when it expires rather than being left on screen looking valid.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.classList.add('ring');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '12');
    track.setAttribute('cy', '12');
    track.setAttribute('r', '9');
    track.classList.add('track');
    const head = document.createElementNS(SVG_NS, 'circle');
    head.setAttribute('cx', '12');
    head.setAttribute('cy', '12');
    head.setAttribute('r', '9');
    head.classList.add('head');
    const circumference = 2 * Math.PI * 9;
    head.setAttribute('stroke-dasharray', String(circumference));
    svg.append(track, head);
    wrap.append(svg);
    const tick = (): void => {
      const left = 30 - (Math.floor(Date.now() / 1000) % 30);
      head.setAttribute('stroke-dashoffset', String(circumference * (1 - left / 30)));
      if (left <= 1) {
        clearTimeout(revealed.get(key)?.timer ?? 0);
        revealed.delete(key);
        render(current);
      }
    };
    tick();
    clearInterval(totpTimer);
    totpTimer = setInterval(tick, 1000) as unknown as number;
  } else {
    wrap.append(el('span', 'dots', '••• •••'));
  }
  f.append(wrap);

  const actions = el('div', 'field-actions');
  const eye = iconButton(shown ? 'eyeOff' : 'eye', shown ? 'Hide code' : 'Show code', () => {
    if (revealed.has(key)) {
      clearTimeout(revealed.get(key)!.timer);
      revealed.delete(key);
      render(current);
      return;
    }
    return reveal(it.id, 'totp', key);
  });
  actions.append(eye);
  if (canCopy) {
    const cp = iconButton('copy', 'Copy code', async () => {
      await copyField(it.id, 'totp');
      flash(cp, 'Copied');
    });
    actions.append(cp);
  }
  f.append(actions);
  return f;
}

function renderDraft(p: Payload): Node {
  const f = (p.fields ?? {}) as Record<string, string | boolean | null>;
  const out = frag();
  out.append(header('New login', 'Nothing is saved until you press Save'));

  const form = el('div', 'form');

  const nameInput = textField(form, 'Name', String(f.name ?? ''), 'The site or service');
  const userInput = textField(form, 'Username', String(f.username ?? ''), 'you@example.com');
  const uriInput = textField(form, 'Site', String(f.uri ?? ''), 'https://example.com');

  // Password row: generated server-side, editable, with a live strength read.
  const pwWrap = el('div', 'form-field');
  pwWrap.append(el('div', 'form-label', 'Password'));
  const pwRow = el('div', 'secret-input');
  const pwInput = el('input');
  pwInput.type = 'text';
  pwInput.value = String(p.secret ?? '');
  pwInput.spellcheck = false;
  pwInput.autocapitalize = 'off';
  pwInput.setAttribute('autocomplete', 'off');
  pwRow.append(pwInput);
  const regen = iconButton('refresh', 'Generate another', async () => {
    const r = await call('vault_ui_generate', { length: 20, special: true });
    if (typeof r.secret === 'string') {
      pwInput.value = r.secret;
      updateMeter();
    }
  });
  pwRow.append(regen);
  const copyBtn = iconButton('copy', 'Copy password', async () => {
    await call('vault_ui_copy_value', { value: pwInput.value, label: 'new password' });
    flash(copyBtn, 'Copied');
  });
  pwRow.append(copyBtn);
  pwWrap.append(pwRow);
  const meterWrap = el('div');
  pwWrap.append(meterWrap);
  form.append(pwWrap);

  const updateMeter = (): void => {
    meterWrap.replaceChildren(meter(localStrength(pwInput.value)));
  };
  updateMeter();
  pwInput.addEventListener('input', updateMeter);

  // Folder picker, when the vault has folders.
  let folderSelect: HTMLSelectElement | undefined;
  if (p.folders?.length) {
    const wrap = el('div', 'form-field');
    wrap.append(el('div', 'form-label', 'Folder'));
    folderSelect = el('select');
    const none = el('option', undefined, 'No folder');
    none.value = '';
    folderSelect.append(none);
    for (const fo of p.folders) {
      if (!fo.id) continue;
      const opt = el('option', undefined, fo.name);
      opt.value = fo.id;
      if (fo.id === f.folderId) opt.selected = true;
      folderSelect.append(opt);
    }
    wrap.append(folderSelect);
    form.append(wrap);
  }

  out.append(form);

  const actions = el('div', 'actions');
  const save = button(
    'Save to vault',
    'primary',
    async () => {
      const r = await call('vault_ui_save_draft', {
        draft_id: p.draftId,
        name: nameInput.value.trim() || 'Untitled',
        username: userInput.value.trim(),
        uri: uriInput.value.trim(),
        password: pwInput.value,
        folder_id: folderSelect?.value || null,
        notes: String(f.notes ?? ''),
        favorite: Boolean(f.favorite),
      });
      if (r.error) {
        showError(String(r.error));
        return;
      }
      tellModel(`The user saved the new login "${nameInput.value.trim()}" to the vault.`);
      render(r);
    },
    'check',
    'Saving',
  );
  actions.append(save);
  actions.append(
    button('Cancel', 'ghost', () => {
      tellModel('The user cancelled the new login. Nothing was saved.');
      render({ view: 'done', message: 'Cancelled. Nothing was saved.' });
    }),
  );
  out.append(actions);
  return out;
}

function textField(parent: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
  const wrap = el('div', 'form-field');
  wrap.append(el('div', 'form-label', label));
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  wrap.append(input);
  parent.append(wrap);
  return input;
}

/** The same estimate the server uses, so the meter does not need a round trip per keystroke. */
function localStrength(secret: string): Strength {
  const len = secret.length;
  let classes = 0;
  if (/[a-z]/.test(secret)) classes++;
  if (/[A-Z]/.test(secret)) classes++;
  if (/[0-9]/.test(secret)) classes++;
  if (/[^A-Za-z0-9]/.test(secret)) classes++;
  const bits = len * ([0, 3.3, 4.7, 5.5, 6.5][classes] ?? 4);
  let score: 0 | 1 | 2 | 3 | 4 = 0;
  if (bits >= 40) score = 1;
  if (bits >= 60) score = 2;
  if (bits >= 80) score = 3;
  if (bits >= 110) score = 4;
  if (len < 8) score = 0;
  return { score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] };
}

function renderConfirm(p: Payload): Node {
  const destructive = p.kind === 'delete';
  const out = frag();
  out.append(header(destructive ? 'Move to trash' : 'Review changes', p.itemName ?? undefined));

  const ident = el('div', 'pad row');
  const av = el('div', 'avatar');
  if (destructive) {
    av.append(icon(ICONS.trash));
    av.style.background = 'var(--danger-bg)';
    av.style.color = 'var(--danger)';
    av.style.borderColor = 'transparent';
  } else {
    av.textContent = initial(p.itemName);
  }
  ident.append(av);
  const col = el('div', 'col grow');
  col.append(el('div', 'name truncate', p.itemName ?? 'This item'));
  col.append(el('div', 'sub', p.title ?? (destructive ? 'Move this item to the trash?' : 'Save these changes?')));
  ident.append(col);
  out.append(ident);

  const rows = p.rows ?? [];
  if (rows.length) {
    const diff = el('div', 'diff');
    for (const r of rows) {
      const row = el('div', 'diff-row');
      row.append(el('div', 'diff-label', r.label));
      const vals = el('div', 'diff-vals grow');
      if (r.before !== undefined && r.before !== r.after) {
        vals.append(el('span', 'diff-before', r.before || '—'));
        vals.append(el('span', 'diff-arrow', '→'));
      }
      vals.append(el('span', 'diff-after', r.after ?? '—'));
      row.append(vals);
      diff.append(row);
    }
    out.append(diff);
  }

  if (p.note) out.append(el('div', 'note', p.note));

  const actions = el('div', 'actions');
  const go = button(
    destructive ? 'Move to trash' : 'Save changes',
    destructive ? 'danger' : 'primary',
    async () => {
      const r = await call('vault_ui_confirm', { action_id: p.actionId });
      if (r.error) {
        showError(String(r.error));
        return;
      }
      tellModel(
        destructive
          ? `The user confirmed moving "${p.itemName ?? 'the item'}" to the trash. It is done.`
          : `The user confirmed the changes to "${p.itemName ?? 'the item'}". They are saved.`,
      );
      render(r);
    },
    destructive ? 'trash' : 'check',
    destructive ? 'Moving' : 'Saving',
  );
  actions.append(go);
  actions.append(
    button('Cancel', 'ghost', () => {
      void call('vault_ui_cancel', { action_id: p.actionId });
      tellModel('The user cancelled that change. Nothing was modified.');
      render({ view: 'done', message: 'Cancelled. Nothing was changed.' });
    }),
  );
  out.append(actions);
  return out;
}

function renderGenerator(p: Payload): Node {
  const out = frag();
  const meta = (p.meta ?? {}) as { kind?: string };
  out.append(header(meta.kind === 'passphrase' ? 'Generated passphrase' : 'Generated password'));

  const wrap = el('div', 'pad');
  const row = el('div', 'secret-input');
  const input = el('input');
  input.type = 'text';
  input.value = String(p.secret ?? '');
  input.readOnly = true;
  input.spellcheck = false;
  row.append(input);
  const regen = iconButton('refresh', 'Generate another', async () => {
    const r = await call('vault_ui_generate', (p.options ?? { length: 20, special: true }) as Record<string, unknown>);
    if (typeof r.secret === 'string') {
      input.value = r.secret;
      m.replaceChildren(meter(localStrength(r.secret)));
    }
  });
  row.append(regen);
  const cp = iconButton('copy', 'Copy', async () => {
    await call('vault_ui_copy_value', { value: input.value, label: 'generated password' });
    flash(cp, 'Copied');
  });
  row.append(cp);
  wrap.append(row);
  const m = el('div');
  m.style.marginTop = '10px';
  m.append(meter(localStrength(String(p.secret ?? ''))));
  wrap.append(m);
  out.append(wrap);

  const banner = el('div', 'banner');
  banner.append(icon(ICONS.info));
  banner.append(document.createTextNode('This password is shown only here. Claude cannot read it.'));
  out.append(banner);
  return out;
}

function renderDone(p: Payload): Node {
  const out = frag();
  out.append(header('Vault'));
  const wrap = el('div', 'pad row');
  const av = el('div', 'avatar');
  av.append(icon(ICONS.check));
  av.style.background = 'var(--bg3)';
  av.style.color = 'var(--muted)';
  av.style.borderColor = 'transparent';
  wrap.append(av);
  wrap.append(el('div', 'name grow', p.message ?? 'Done.'));
  out.append(wrap);
  return out;
}

function renderError(message: string, hint?: string): Node {
  const out = frag();
  out.append(header('Vault', undefined, { text: 'Problem', cls: 'off' }));
  const wrap = el('div', 'pad col');
  wrap.append(el('div', 'name', message));
  if (hint) wrap.append(el('div', 'sub', hint));
  out.append(wrap);
  return out;
}

function renderSkeleton(): Node {
  const out = frag();
  const head = el('div', 'head');
  const mark = el('div', 'sk');
  mark.style.width = '22px';
  mark.style.height = '22px';
  mark.style.borderRadius = '6px';
  head.append(mark);
  const t = el('div', 'sk');
  t.style.width = '90px';
  head.append(t);
  out.append(head);
  const pad = el('div', 'pad row');
  const av = el('div', 'sk');
  av.style.width = '40px';
  av.style.height = '40px';
  av.style.borderRadius = '11px';
  pad.append(av);
  const col = el('div', 'col grow');
  const a = el('div', 'sk');
  a.style.width = '55%';
  a.style.height = '12px';
  const b = el('div', 'sk');
  b.style.width = '35%';
  b.style.marginTop = '6px';
  col.append(a, b);
  pad.append(col);
  out.append(pad);
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(tool: string): Promise<void> {
  const r = await call(tool);
  render(r);
}

async function openItem(id: string): Promise<void> {
  lastList = current.view === 'list' ? current : lastList;
  const r = await call('vault_ui_item', { id });
  render(r);
}

let lastList: Payload | null = null;

async function backToList(): Promise<void> {
  if (lastList) {
    render(lastList);
    return;
  }
  const r = await call('vault_ui_search', { limit: 25 });
  render(r);
}

async function reveal(id: string, field: 'password' | 'totp' | 'notes', key: string): Promise<void> {
  const r = await call('vault_ui_reveal', { id, field });
  if (r.error || typeof r.value !== 'string') {
    showError(String(r.error ?? 'Could not read that value.'));
    return;
  }
  const seconds = typeof r.hideAfterSeconds === 'number' ? r.hideAfterSeconds : 30;
  const timer = setTimeout(() => {
    revealed.delete(key);
    render(current);
  }, seconds * 1000) as unknown as number;
  revealed.set(key, { value: r.value as string, timer });
  render(current);
}

async function copyField(id: string, field: 'password' | 'totp' | 'notes' | 'username'): Promise<void> {
  const r = await call('vault_ui_copy', { id, field });
  if (r.error) showError(String(r.error));
}

let errorTimer: number | undefined;
function showError(message: string): void {
  const existing = card.querySelector('.note.warn.transient');
  existing?.remove();
  const note = el('div', 'note warn transient', message);
  card.append(note);
  notifySize();
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    note.remove();
    notifySize();
  }, 6000) as unknown as number;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(p: Payload): void {
  clearRenderTimers();
  if (typeof p.iconBase === 'string') iconBase = p.iconBase;
  current = p;
  let node: Node;
  if (p.error && !p.view) {
    node = renderError(String(p.error), p.hint);
  } else {
    switch (p.view) {
      case 'list':
        node = renderList(p);
        break;
      case 'item':
        node = renderItem(p);
        break;
      case 'draft':
        node = renderDraft(p);
        break;
      case 'confirm':
        node = renderConfirm(p);
        break;
      case 'generator':
        node = renderGenerator(p);
        break;
      case 'done':
        node = renderDone(p);
        break;
      case 'status':
        node = renderStatus(p);
        break;
      default:
        node = p.status ? renderStatus(p) : renderError(String(p.error ?? 'Nothing to show.'), p.hint);
    }
  }
  body.replaceChildren(node);
  body.classList.add('fade-in');
  notifySize();
}

// ---------------------------------------------------------------------------
// Host events. Registered before connect(), which the SDK requires.
// ---------------------------------------------------------------------------

/**
 * Whether this card has taken its content yet.
 *
 * A card is created by exactly one tool call, which produces exactly one result — but
 * `ui/notifications/tool-result` carries only the result itself, with no invocation id, so a
 * card cannot tell from the protocol whose result it is being handed. In practice a later
 * call's result reaches every live card of this server, and every card in the transcript
 * silently repaints itself to show the newest thing. From the outside that looks like older
 * messages rewriting themselves.
 *
 * So the first result a card sees is its own, and it keeps it. After that the only thing that
 * changes what a card shows is someone pressing a button on that card.
 */
let claimed = false;

function onToolInput(): void {
  if (claimed) return;
  toolPending = true;
  clearReveals();
  body.replaceChildren(renderSkeleton());
  notifySize();
}

function onToolResult(params: unknown): void {
  // Someone else's invocation. This card already shows what it was made to show.
  if (claimed) return;
  claimed = true;
  toolPending = false;
  const payload = parse(params as ToolResult);
  render(payload);

  // What arrived is the model's view of the item: names screened for instruction-like text,
  // URLs cut back to their host, usernames withheld from a bulk search. That is right for the
  // model and wrong for a person, who should see the item as they wrote it. So the card
  // paints that immediately and then asks for its own fuller version.
  if (payload.view === 'item' && payload.itemId) {
    void (async () => {
      const full = await call('vault_ui_item', { id: payload.itemId });
      if (!full.error && current.itemId === payload.itemId) render(full);
    })();
  } else if (payload.view === 'list' && payload.query !== undefined) {
    void (async () => {
      const full = await call('vault_ui_search', {
        query: payload.query,
        include_trash: payload.includeTrash,
        limit: payload.items?.length ?? 25,
      });
      if (!full.error && current.view === 'list') render(full);
    })();
  }
}

function onToolCancelled(): void {
  if (claimed) return;
  claimed = true;
  toolPending = false;
  void act('vault_ui_state');
}

app.ontoolinput = onToolInput;
app.ontoolresult = onToolResult;
app.ontoolcancelled = onToolCancelled;
app.onhostcontextchanged = (ctx) => applyHost(ctx as HostCtx);

// There is deliberately no background poll here. A status card that re-queried the server
// every fifteen seconds meant every such card still sitting in the transcript quietly changed
// what it said, long after the moment it described — and each one cost a CLI process spawn to
// do it. A card now describes the moment it was made, and the countdown below is arithmetic on
// the number it was given rather than a question asked again.

void (async () => {
  // Demo modes for scripts/serve-ui.mjs; they never run inside a host.
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  if (demo) {
    demoMode = true;
    (window as unknown as Record<string, unknown>).__cardTestHooks = {
      onToolInput,
      onToolResult,
      onToolCancelled,
      claimed: () => claimed,
      current: () => current,
    };
    const theme = params.get('theme') ?? undefined;
    applyHost({ theme });
    // `shot` paints the surface a host would paint behind the card, and pads it, so a
    // screenshot for the README does not sit on a bare transparent page.
    if (params.has('shot')) {
      document.body.style.background = theme === 'dark' ? '#1f1e1d' : '#faf9f5';
      document.body.style.padding = '20px';
      card.style.maxWidth = '460px';
    }
    render(demoPayload(demo));
    return;
  }
  try {
    body.replaceChildren(renderSkeleton());
    await app.connect();
    applyHost(app.getHostContext() as HostCtx | undefined);
    new ResizeObserver(() => notifySize()).observe(card);
    // A card created by a tool call gets its content from that call's result. Only a card
    // that somehow rendered without one has to ask.
    setTimeout(() => {
      if (toolPending || current.view) return;
      // Asking for this counts as taking the card's content, so a result meant for some other
      // invocation cannot arrive afterwards and replace it.
      claimed = true;
      void act('vault_ui_state');
    }, 400);
  } catch (e) {
    render({ error: `Could not connect to the host: ${e instanceof Error ? e.message : String(e)}` });
  }
})();

/** Canned answers so every control in the preview does something. Never used in a host. */
function demoCall(name: string, args: Record<string, unknown>): Payload & Record<string, unknown> {
  switch (name) {
    case 'vault_ui_reveal': {
      const field = String(args.field);
      const value = field === 'totp' ? '418205' : field === 'notes' ? 'Recovery codes are in the safe.' : 'K7#mQp2vLx9!Zr4Tn8Wd';
      return { value, field, hideAfterSeconds: 30 };
    }
    case 'vault_ui_copy':
    case 'vault_ui_copy_value':
      return { copied: 'value', clearsInSeconds: 30 };
    case 'vault_ui_generate': {
      const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
      const bytes = crypto.getRandomValues(new Uint32Array(20));
      const secret = [...bytes].map((n) => alphabet[n % alphabet.length]).join('');
      return { secret, strength: localStrength(secret) };
    }
    case 'vault_ui_item': {
      // Answer for the id that was asked for. Returning a fixed item regardless made the
      // preview lie about the one thing this call exists to do.
      const base = demoPayload('item') as Payload & Record<string, unknown>;
      const id = String(args.id ?? base.itemId);
      const known = current.item && current.item.id === id ? current.item : undefined;
      return { ...base, itemId: id, item: { ...(known ?? base.item), id } } as Payload & Record<string, unknown>;
    }
    case 'vault_ui_search':
      return demoPayload('list') as Payload & Record<string, unknown>;
    case 'vault_ui_save_draft':
      return { ...(demoPayload('item') as Payload), saved: true } as Payload & Record<string, unknown>;
    case 'vault_ui_confirm':
      return { view: 'done', message: 'Done.' };
    case 'vault_ui_lock':
      return demoPayload('locked') as Payload & Record<string, unknown>;
    default:
      return demoPayload('status') as Payload & Record<string, unknown>;
  }
}

function demoPayload(kind: string): Payload {
  const item: Item = {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'GitHub',
    username: 'shadowsdistant',
    uris: ['https://github.com/login'],
    folder: 'Development',
    favorite: true,
    updated: new Date(Date.now() - 86400_000 * 3).toISOString(),
    hasPassword: true,
    hasTotp: true,
    hasNotes: true,
  };
  switch (kind) {
    case 'item':
      return { view: 'item', itemId: item.id, item, canCopy: true, iconBase: 'https://bitwarden.pikapod.net' };
    case 'list':
      return {
        view: 'list',
        iconBase: 'https://bitwarden.pikapod.net',
        count: 4,
        total: 4,
        items: [
          item,
          { id: 'a', name: 'Proton Mail', username: 'shado@proton.me', uris: ['https://account.proton.me'], hasPassword: true },
          { id: 'b', name: 'Steam', username: 'shado', uris: ['https://store.steampowered.com'], hasPassword: true, hasTotp: true },
          { id: 'c', name: 'Old router', username: 'admin', hasPassword: true, inTrash: true },
        ],
      };
    case 'draft':
      return {
        view: 'draft',
        draftId: 'demo',
        mode: 'create',
        fields: { name: 'Fastmail', username: 'shado@fastmail.com', uri: 'https://app.fastmail.com', folderId: null },
        secret: 'K7#mQp2vLx9!Zr4Tn8Wd',
        folders: [
          { id: '1', name: 'Development' },
          { id: '2', name: 'Personal' },
        ],
      };
    case 'confirm':
      return {
        view: 'confirm',
        actionId: 'demo',
        kind: 'edit',
        itemName: 'GitHub',
        title: 'Save these changes?',
        rows: [
          { label: 'Username', before: 'shadowsdistant', after: 'shado@github' },
          { label: 'Folder', before: 'No folder', after: 'Development' },
        ],
      };
    case 'delete':
      return {
        view: 'confirm',
        actionId: 'demo',
        kind: 'delete',
        itemName: 'Old router',
        title: 'Move this item to the trash?',
        rows: [
          { label: 'Username', after: 'admin' },
          { label: 'Folder', after: 'No folder' },
        ],
        note: 'The server keeps trashed items for 30 days.',
      };
    case 'generator':
      return { view: 'generator', meta: { kind: 'password' }, secret: 'q4$Vn8ZmTd2!Lw7Kx3Rb', options: { length: 20, special: true } };
    case 'locked':
      return { view: 'status', status: { state: 'locked', server: 'bitwarden.pikapod.net', email: 'shado@example.com' }, canPrompt: true };
    case 'unconfigured':
      return { view: 'status', status: { state: 'unconfigured' } };
    default:
      return {
        iconBase: 'https://bitwarden.pikapod.net',
        view: 'status',
        status: {
          state: 'unlocked',
          server: 'bitwarden.pikapod.net',
          email: 'shado@example.com',
          lastSync: new Date(Date.now() - 240_000).toISOString(),
          autoLockMinutes: 15,
          locksInSeconds: 720,
        },
        canPrompt: true,
        canCopy: true,
      };
  }
}
