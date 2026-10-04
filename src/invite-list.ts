// ClaudeBWAI — logic behind the bulk "Generate N invite links" control (einh, 4 Oct). Pure, so tests read it from dist.
/** The most invitations one host can have active at once; the main process enforces the real limit. */
export const MAX_INVITES = 7;

/** The counts the select offers: 1..slots, never more than the server will accept; always at least [1]. */
export function inviteCountOptions(slots: number | undefined | null): number[] {
  const cap = Number.isInteger(slots) ? Math.min(Math.max(slots as number, 0), MAX_INVITES) : MAX_INVITES;
  return Array.from({ length: Math.max(cap, 1) }, (_, i) => i + 1);
}

/** Keep a chosen count inside what is offered. */
export function clampInviteCount(choice: number, slots: number | undefined | null): number {
  const options = inviteCountOptions(slots);
  return Number.isInteger(choice) && choice >= 1 ? Math.min(choice, options.length) : 1;
}

export function generateLabel(count: number): string {
  return count === 1 ? 'Generate invite link' : `Generate ${count} invite links`;
}

/** "host/#invite=…a91" — enough to tell rows apart; the full link rides the Copy button. */
export function shortInviteLink(url: string): string {
  const at = url.indexOf('#invite=');
  const host = url.slice(0, at < 0 ? url.length : at).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return at < 0 ? host : `${host}/#invite=…${url.slice(-4)}`;
}
