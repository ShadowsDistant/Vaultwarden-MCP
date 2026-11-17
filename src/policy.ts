import { itemOnTrustedSite, onSettingsChange, type Settings } from './settings.js';
import { onLock } from './session.js';

/**
 * When the assistant may have a secret.
 *
 * This governs only what the assistant asks for. A person clicking Reveal or Copy in a card is not
 * subject to any of it; that is the owner of the vault looking at their own vault.
 *
 * The order of the checks is the policy:
 *
 *  1. An item the user marked "master password re-prompt" is never released to the assistant at all.
 *     That flag is the user's own instruction about that item, and no setting overrides it.
 *  2. A password or one-time code for a trusted site is released without asking. Notes are
 *     not: they are where recovery codes and the like end up, and they are not tied to a site.
 *  3. If the user has said never, it is never.
 *  4. In "once per item" mode, a yes given earlier in this unlocked session still stands.
 *  5. Otherwise, a window asks.
 */

export type SecretField = 'password' | 'totp' | 'notes';

export type Decision =
  | { kind: 'allow'; via: 'trusted_site' | 'session' }
  | { kind: 'ask' }
  | { kind: 'deny'; code: 'reprompt' | 'never'; message: string; hint: string };

type ItemLike = Parameters<typeof itemOnTrustedSite>[0] & { id: string; reprompt?: number };

export function decide(item: ItemLike, field: SecretField, s: Settings, approved: (key: string) => boolean): Decision {
  if (item.reprompt === 1) {
    return {
      kind: 'deny',
      code: 'reprompt',
      message: 'This item is marked "master password re-prompt", so it is never released to your AI assistant.',
      hint: 'The user can reveal or copy it in the card after re-entering their master password.',
    };
  }
  if ((field === 'password' || field === 'totp') && itemOnTrustedSite(item, s.trustedSites)) {
    return { kind: 'allow', via: 'trusted_site' };
  }
  if (s.access === 'never') {
    return {
      kind: 'deny',
      code: 'never',
      message: 'The assistant is not allowed to read or copy secrets on this install.',
      hint: 'The user can change this in the Bitwarden MCP Settings app, or reveal and copy values in the card themselves.',
    };
  }
  if (s.access === 'session' && approved(approvalKey(item.id, field))) {
    return { kind: 'allow', via: 'session' };
  }
  return { kind: 'ask' };
}

export function approvalKey(id: string, field: SecretField): string {
  return `${id}:${field}`;
}

/**
 * Yeses given in "once per item" mode. They last exactly as long as the unlocked session that
 * they were given in: locking, signing out, or the CLI rejecting the session clears them.
 */
const approvals = new Set<string>();

export function remember(id: string, field: SecretField): void {
  approvals.add(approvalKey(id, field));
}

export function approved(key: string): boolean {
  return approvals.has(key);
}

export function forgetApprovals(): void {
  approvals.clear();
}

onLock(forgetApprovals);
// A change of settings starts the count again. Someone who moves from "ask once" to "ask every
// time" and back must not find yeses from before the change still standing.
onSettingsChange(() => forgetApprovals());
