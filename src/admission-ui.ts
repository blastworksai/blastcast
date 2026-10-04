// DiuleJ — BCAST-3 host-side admission UI adapter.
// Isolated: accepts a container element + explicit callbacks; no framework.
// Compiles with existing tsc; runs in Electron renderer (browser context).
//
// Styles: load src/admission.css via <link> in the host HTML.
// Do NOT inject inline <style> — desktop CSP requires style-src 'self'.

import { ORIGINALS_UNSUPPORTED_HOST_LABEL } from './source-protocol.js';
/** Guest entry as reported by the host list. */
export interface GuestEntry {
  id: string;
  phase: 'open' | 'redeemed' | 'pending' | 'admitted' | 'rejected' | 'removed' | 'left' | 'revoked' | 'expired';
  alive: boolean;
  revoked: boolean;
  expiresAt: number;
  /** ClaudeBWAI — presence (guests.cjs), set for admitted guests: is their page still there? Separate from the admission phase. */
  presence?: 'connected' | 'disconnected';
  /** ClaudeBWAI — einh 4 Oct (r10): the guest's page announced it was closing (pagehide); the host skips call recovery for it. */
  pageGone?: boolean;
  /** ClaudeBWAI — the guest's browser cannot record an original (self-reported): the host records them from the call. */
  originalsUnsupported?: boolean;
  session?: {
    id: string;
    name: string;
    consentedAt: number | null;
    consentVersion: string | null;
    requestedAt: number | null;
    /** ClaudeBWAI — 'phone' when the guest's page said so at join; desktops send nothing. */
    device?: 'phone' | null;
    decision: 'admitted' | 'rejected' | null;
    decidedAt: number | null;
    removedAt: number | null;
  };
}

/** Result of a host action. */
export interface ActionResult {
  ok: boolean;
  message?: string;
  idempotent?: boolean;
}

/** Callbacks the adapter calls on host actions. */
export interface AdmissionCallbacks {
  onAdmit(sessionId: string): Promise<ActionResult>;
  onReject(sessionId: string): Promise<ActionResult>;
  onRemove(sessionId: string): Promise<ActionResult>;
  onRevoke(inviteId: string): Promise<ActionResult>;
}

/** ClaudeBWAI — the row's state text: an admitted guest whose page has gone says so (einh, 3 Oct: "Disconnected, can rejoin"). */
export function admissionRowLabel(guest: Pick<GuestEntry, 'phase' | 'presence' | 'originalsUnsupported' | 'pageGone'> & { session?: { id: string } }): string {
  // einh 4 Oct (r10): while the call is recovering its media (30 s) Reconnecting wins over a presence lapse: a dropped network silences the
  // page and the media together. Only a call lost for good (lostSessions) or one that is not recovering says Disconnected.
  if (guest.phase === 'admitted' && guest.session && lostSessions.has(guest.session.id)) return 'Disconnected — can rejoin from the same browser';
  if (guest.phase === 'admitted' && guest.session && reconnectingSessions.has(guest.session.id) && !guest.pageGone) return 'Reconnecting…'; // a page that said it was closing is not a network drop
  if (guest.phase === 'admitted' && guest.presence === 'disconnected') return 'Disconnected — can rejoin from the same browser';
  if (guest.phase === 'admitted' && guest.originalsUnsupported === true) return `${guest.phase} — ${ORIGINALS_UNSUPPORTED_HOST_LABEL}`;
  return guest.phase;
}

/** ClaudeBWAI — sessions whose call media is recovering (set by HostCalls, read when the row renders; the panel refreshes on its poll). */
const reconnectingSessions = new Set<string>();
export function setGuestReconnecting(sessionId: string, reconnecting: boolean): void {
  if (reconnecting) reconnectingSessions.add(sessionId); else reconnectingSessions.delete(sessionId);
}

/** ClaudeBWAI — einh 4 Oct: sessions whose call media is gone for good (recovery failed or the call ended) while the guest's page may still poll. Cleared when a new call connects. */
const lostSessions = new Set<string>();
export function setGuestMediaLost(sessionId: string, lost: boolean): void {
  if (lost) { lostSessions.add(sessionId); reconnectingSessions.delete(sessionId); } else lostSessions.delete(sessionId);
}

// ── Adapter ──────────────────────────────────────────────────────

/**
 * Create the admission panel. Call `update(guests)` to refresh the list.
 * Requires src/admission.css loaded via <link> (not inline <style>).
 *
 * @param container Target DOM element.
 * @param callbacks Host action handlers.
 */
export function createAdmissionPanel(
  container: HTMLElement,
  callbacks: AdmissionCallbacks,
): { update(guests: readonly GuestEntry[]): void; destroy(): void } {

  const root = document.createElement('div');
  root.className = 'bcast-admission';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Guest admission');

  const heading = document.createElement('h3');
  heading.textContent = 'Guest Admission';
  root.appendChild(heading);

  // ClaudeBWAI — rows the host cleared with the red ×; renderer-side for the 2 Oct demo build.
  const dismissed = new Set<string>();
  let lastGuests: readonly GuestEntry[] = [];

  const list = document.createElement('ul');
  list.className = 'bcast-admission-list';
  root.appendChild(list);

  const errorEl = document.createElement('div');
  errorEl.className = 'bcast-admission-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'polite');
  root.appendChild(errorEl);

  container.appendChild(root);

  // Per-guest inflight tracking — all actions for the same guest are
  // mutually exclusive so admit/reject cannot race.
  const inflightGuests = new Set<string>();

  function showError(msg: string): void {
    errorEl.textContent = msg;
  }

  function clearError(): void {
    errorEl.textContent = '';
  }

  /** Disable/enable all action buttons for a guest by data-guest-key. */
  function setGuestButtonsDisabled(guestKey: string, disabled: boolean): void {
    for (const btn of list.querySelectorAll<HTMLButtonElement>(`button[data-guest-key="${guestKey}"]`)) {
      btn.disabled = disabled;
    }
  }

  async function wrapAction(guestKey: string, fn: () => Promise<ActionResult>): Promise<void> {
    if (inflightGuests.has(guestKey)) return;
    inflightGuests.add(guestKey);
    clearError();
    setGuestButtonsDisabled(guestKey, true);
    try {
      const result = await fn();
      if (!result.ok && result.message) showError(result.message);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      inflightGuests.delete(guestKey);
      // Re-enable after settle — buttons may have been replaced by update(),
      // so only re-enable if they still exist.
      setGuestButtonsDisabled(guestKey, false);
    }
  }

  function makeButton(
    label: string,
    cls: string,
    guestKey: string,
    handler: () => Promise<ActionResult>,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bcast-admission-btn ${cls}`;
    btn.textContent = label;
    btn.dataset['guestKey'] = guestKey;
    btn.addEventListener('click', () => { void wrapAction(guestKey, handler); });
    if (inflightGuests.has(guestKey)) btn.disabled = true;
    return btn;
  }

  /** Is this guest in a terminal/inactive state where actions are disabled? */
  function isInactive(guest: GuestEntry): boolean {
    return !guest.alive || guest.revoked ||
      guest.phase === 'rejected' || guest.phase === 'removed' || guest.phase === 'left' ||
      guest.phase === 'revoked' || guest.phase === 'expired';
  }

  function renderItem(guest: GuestEntry): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'bcast-admission-item';
    li.dataset['guestId'] = guest.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'bcast-admission-name';
    nameSpan.dir = 'auto';
    nameSpan.style.unicodeBidi = 'isolate';
    nameSpan.textContent = guest.session?.name ?? (guest.phase === 'open' ? '(open invitation)' : '(redeemed)');
    li.appendChild(nameSpan);

    const phaseSpan = document.createElement('span');
    phaseSpan.className = 'bcast-admission-phase';
    phaseSpan.dataset['phase'] = guest.phase;
    phaseSpan.textContent = admissionRowLabel(guest);
    if (guest.presence) li.dataset['presence'] = guest.presence;
    if (guest.phase === 'admitted' && guest.presence !== 'disconnected' && guest.session && lostSessions.has(guest.session.id)) li.dataset['media'] = 'lost';
    else if (guest.phase === 'admitted' && !guest.pageGone && guest.session && reconnectingSessions.has(guest.session.id)) li.dataset['media'] = 'reconnecting';
    li.appendChild(phaseSpan);

    const actions = document.createElement('span');
    actions.className = 'bcast-admission-actions';

    // Use guest.id as the per-guest action lock key so admit/reject
    // for the same guest cannot race.
    const guestKey = guest.id;
    const sid = guest.session?.id;
    const inactive = isInactive(guest);

    if (guest.phase === 'pending' && sid && !inactive) {
      const admitBtn = makeButton('Admit', 'bcast-admission-btn--admit', guestKey, () => callbacks.onAdmit(sid));
      const rejectBtn = makeButton('Reject', 'bcast-admission-btn--reject', guestKey, () => callbacks.onReject(sid));
      actions.appendChild(admitBtn);
      actions.appendChild(rejectBtn);
    } else if (guest.phase === 'admitted' && sid && !inactive) {
      actions.appendChild(makeButton('Remove', 'bcast-admission-btn--remove', guestKey, () => callbacks.onRemove(sid)));
    }

    if (guest.alive && !guest.revoked && (guest.phase === 'open' || guest.phase === 'redeemed')) {
      actions.appendChild(makeButton('Revoke', 'bcast-admission-btn--revoke', guestKey, () => callbacks.onRevoke(guest.id)));
    }

    if (inactive) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'bcast-admission-btn bcast-admission-btn--dismiss';
      dismiss.textContent = '×';
      dismiss.title = 'Remove this row';
      dismiss.setAttribute('aria-label', `Remove ${guest.session?.name ?? 'invitation'} row`);
      dismiss.addEventListener('click', () => { dismissed.add(guest.id); update(lastGuests); });
      actions.appendChild(dismiss);
    }

    li.appendChild(actions);
    return li;
  }

  function update(guests: readonly GuestEntry[]): void {
    lastGuests = guests;
    guests = guests.filter(guest => !dismissed.has(guest.id));
    // Preserve focus: record which guest-id button had focus.
    const focused = document.activeElement;
    let focusGuestId: string | null = null;
    let focusLabel: string | null = null;
    if (focused instanceof HTMLButtonElement && list.contains(focused)) {
      const li = focused.closest<HTMLLIElement>('[data-guest-id]');
      if (li) {
        focusGuestId = li.dataset['guestId'] ?? null;
        focusLabel = focused.textContent;
      }
    }

    list.replaceChildren();
    if (guests.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'bcast-admission-empty';
      empty.textContent = 'No guests. Create an invitation to start.';
      list.appendChild(empty);
      return;
    }
    for (const g of guests) {
      list.appendChild(renderItem(g));
    }

    // Restore focus to the same button if it still exists.
    if (focusGuestId && focusLabel) {
      const li = list.querySelector<HTMLLIElement>(`[data-guest-id="${focusGuestId}"]`);
      if (li) {
        for (const btn of li.querySelectorAll<HTMLButtonElement>('button')) {
          if (btn.textContent === focusLabel && !btn.disabled) {
            btn.focus();
            break;
          }
        }
      }
    }
  }

  function destroy(): void {
    root.remove();
    inflightGuests.clear();
  }

  // Start empty
  update([]);

  return { update, destroy };
}
