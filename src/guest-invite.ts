// ClaudeBWAI — guest invite persistence for a plain refresh (einh, 4 Oct: "Keep invite in the tab").
// The invite token lives in this tab's sessionStorage until the tab closes; never in the URL or localStorage.
export const INVITE_STORAGE_KEY = 'blastcast-invite';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const FRAGMENT_RE = /^#invite=([A-Za-z0-9_-]{43})$/;
export interface InviteStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Fragment wins and is remembered; otherwise a stored value is accepted only if it is a well-formed token. Storage may throw (Safari private mode). */
export function resolveInvite(hash: string, session: InviteStore | null): string {
  const fromFragment = FRAGMENT_RE.exec(hash)?.[1] ?? '';
  if (fromFragment) {
    try { session?.setItem(INVITE_STORAGE_KEY, fromFragment); } catch { /* fragment-only behaviour */ }
    return fromFragment;
  }
  try {
    const stored = session?.getItem(INVITE_STORAGE_KEY) ?? '';
    return TOKEN_RE.test(stored) ? stored : '';
  } catch { return ''; }
}

/** Forget this invite: the tab's copy and this invite's redemption-key entries (`<prefix>.key`, `<prefix>.name`). */
export function forgetInvite(session: InviteStore | null, local: InviteStore | null, storagePrefix: string): void {
  try { session?.removeItem(INVITE_STORAGE_KEY); } catch { /* nothing to forget */ }
  if (!storagePrefix) return;
  try { local?.removeItem(`${storagePrefix}.key`); local?.removeItem(`${storagePrefix}.name`); } catch { /* nothing to forget */ }
}
