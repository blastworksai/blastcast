// DiuleJ — BCAST-3 admission domain. Isolated, independently testable.
// No HTTP, no Electron IPC, no filesystem, no external dependencies.
'use strict';
const { randomBytes } = require('node:crypto');

const MAX_GUESTS = 7;
const INVITE_TTL_MS = 30 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const REDEEM_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const NAME_MAX = 80;
const NAME_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const CONSENT_VERSION_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// Allowed input keys for requestJoin — reject anything unknown.
// ClaudeBWAI — 'device': 'phone' (einh 3 Oct, "Phone-only fix in r8"): a phone guest says so, and the host's offer then asks
// that guest for H.264 (the offer's codec order decides what the guest sends). Only that one value exists; desktops omit it.
const JOIN_ALLOWED_KEYS = new Set(['name', 'consent', 'consentVersion', 'device']);

// Tombstone retention: terminal entries (rejected/removed/revoked/expired with
// session) are kept for idempotency but pruned after this limit per store.
const MAX_TOMBSTONES = 64;

/** Generate a url-safe random token (32 bytes → 43 base64url chars). */
function genToken() { return randomBytes(32).toString('base64url'); }
/** Generate a short stable id for host-side references (not a credential). */
function genId() { return randomBytes(16).toString('base64url'); }

/**
 * @typedef {object} AdmissionStoreOptions
 * @property {() => number} [now]      Injectable clock (ms epoch).
 * @property {number}       [maxGuests] Override guest cap (1–7, default 7).
 */

/**
 * Create an admission store — pure in-memory domain.
 *
 * Invitation lifecycle: create → (guest redeems with browser-generated key)
 * → guest consents and requests join → host admits/rejects → host may remove.
 *
 * Key invariant: an invite token authenticates the INVITATION doorway;
 * redemption binds a browser-generated unpredictable key; the returned session
 * credential authenticates a single BROWSER SESSION. A second browser with the
 * same invite token but a different redemptionKey cannot recover the credential.
 *
 * @param {AdmissionStoreOptions} [options]
 */
function createAdmissionStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // Cap maxGuests at MAX_GUESTS (7) — not configurable higher.
  const maxGuests = Number.isInteger(options.maxGuests) && options.maxGuests >= 1 && options.maxGuests <= MAX_GUESTS
    ? options.maxGuests : MAX_GUESTS;

  // ── Internal state ──────────────────────────────────────────────
  //
  // invitations: Map<inviteToken, Invitation>
  //   Invitation = { id, token, expiresAt, revokedAt, redemptionKey, session }
  //   session    = null | { sessionCredential, id, name, consentedAt,
  //                         consentVersion, requestedAt, decision,
  //                         decidedAt, removedAt }
  //
  const invitations = new Map();

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Has the doorway TTL stopped applying? The 30-minute TTL governs the doorway
   * only: once the host has admitted the session at least once, the invitation
   * lives until revoked, removed, or the store is reset.
   */
  function pastDoorway(inv) {
    return inv.session !== null && inv.session.admittedAt !== null;
  }

  /** Is the doorway TTL expired for this invitation? (never true once admitted.) */
  function ttlExpired(inv) {
    return !pastDoorway(inv) && inv.expiresAt <= now();
  }

  /** Is this invitation alive (not expired, not revoked)? Uses null checks, not truthiness. */
  function alive(inv) {
    return inv.revokedAt === null && !ttlExpired(inv);
  }

  /** Is this invitation terminal (expired OR revoked OR session rejected/removed)? */
  function isTerminal(inv) {
    if (inv.revokedAt !== null) return true;
    if (ttlExpired(inv)) return true;
    if (inv.session) {
      if (inv.session.decision === 'rejected') return true;
      if (inv.session.removedAt !== null || inv.session.leftAt !== null) return true;
    }
    return false;
  }

  /** Count active (non-terminal) invitations — the capacity denominator. */
  function activeCount() {
    let n = 0;
    for (const inv of invitations.values()) {
      if (!isTerminal(inv)) n++;
    }
    return n;
  }

  /** Count how many sessions are admitted (not removed, not expired/revoked). */
  function admittedCount() {
    let n = 0;
    for (const inv of invitations.values()) {
      if (alive(inv) && inv.session && inv.session.decision === 'admitted' && inv.session.removedAt === null && inv.session.leftAt === null) n++;
    }
    return n;
  }

  /**
   * Prune expired sessionless invitations and enforce tombstone cap.
   * Terminal entries are kept as idempotency tombstones
   * up to MAX_TOMBSTONES; oldest are deleted first.
   */
  function prune() {
    // Remove expired invitations that never had a session (no tombstone needed).
    for (const [token, inv] of invitations) {
      if (ttlExpired(inv) && inv.session === null) invitations.delete(token);
    }
    // Enforce tombstone cap: count all terminal entries, including unused revoked links.
    const tombstones = [];
    for (const [token, inv] of invitations) {
      if (isTerminal(inv)) {
        tombstones.push({ token, expiresAt: inv.expiresAt });
      }
    }
    if (tombstones.length > MAX_TOMBSTONES) {
      tombstones.sort((a, b) => a.expiresAt - b.expiresAt);
      const excess = tombstones.length - MAX_TOMBSTONES;
      for (let i = 0; i < excess; i++) invitations.delete(tombstones[i].token);
    }
  }

  /** Find invitation by stable id. */
  function byId(inviteId) {
    for (const inv of invitations.values()) {
      if (inv.id === inviteId) return inv;
    }
    return null;
  }

  /** Find invitation by session credential. */
  function bySession(sessionCredential) {
    for (const inv of invitations.values()) {
      if (inv.session && inv.session.sessionCredential === sessionCredential) return inv;
    }
    return null;
  }

  /** Deep-copy a value (plain objects, arrays, primitives). */
  function deepCopy(val) {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(deepCopy);
    const out = {};
    for (const k of Object.keys(val)) out[k] = deepCopy(val[k]);
    return out;
  }

  /** Safe public view of one invitation (for host list) — defensive deep copy. */
  function publicView(inv) {
    const base = {
      id: inv.id,
      expiresAt: inv.expiresAt,
      alive: alive(inv),
      revoked: inv.revokedAt !== null,
    };
    if (inv.session === null) {
      if (inv.revokedAt !== null) return deepCopy({ ...base, phase: 'revoked' });
      if (ttlExpired(inv)) return deepCopy({ ...base, phase: 'expired' });
      return deepCopy({ ...base, phase: 'open' });
    }
    const s = inv.session;
    const session = {
      id: s.id,
      name: s.name,
      consentedAt: s.consentedAt,
      consentVersion: s.consentVersion,
      requestedAt: s.requestedAt,
      device: s.device ?? null,
      decision: s.decision,
      decidedAt: s.decidedAt,
      removedAt: s.removedAt,
      leftAt: s.leftAt,
    };
    let phase = 'redeemed';
    if (s.requestedAt !== null) phase = 'pending';
    if (s.decision === 'admitted') phase = s.removedAt !== null ? 'removed' : 'admitted';
    if (s.decision === 'rejected') phase = 'rejected';
    if (s.removedAt !== null) phase = 'removed';
    if (s.leftAt !== null) phase = 'left';
    // Expired/revoked guests must not appear as admitted.
    if (!alive(inv) && (phase === 'admitted' || phase === 'pending')) {
      phase = inv.revokedAt !== null ? 'revoked' : 'expired';
    }
    return deepCopy({ ...base, phase, session });
  }

  // ── Public operations ───────────────────────────────────────────

  /**
   * Create an invitation. Returns { ok, invite } or { ok:false, message }.
   * The returned invite contains the token (credential) for one-time delivery.
   * Capacity counts ACTIVE invitations only — terminal entries release slots.
   */
  function createInvitation() {
    const res = createInvitations(1);
    return res.ok ? { ok: true, invite: res.invites[0] } : res;
  }

  /** ClaudeBWAI — how many more invitations the host may create right now (the same capacity rule createInvitation enforces). */
  function remainingSlots() {
    prune();
    return Math.max(0, maxGuests - activeCount());
  }

  /**
   * ClaudeBWAI — create `count` separate one-person invitations all-or-nothing (einh, 4 Oct: "Generate X amount of invite links").
   * Refuses a non-integer, a count below 1, or a count above the remaining slots; nothing is created on a refusal.
   */
  function createInvitations(count) {
    if (!Number.isInteger(count) || count < 1) return { ok: false, message: 'Choose a whole number of invitations, at least 1.' };
    const remaining = remainingSlots();
    if (count > remaining) {
      return { ok: false, message: remaining === 0
        ? `At most ${maxGuests} invitations may be active. Revoke one first.`
        : `Only ${remaining} more invitation${remaining === 1 ? '' : 's'} can be created (at most ${maxGuests} active).` };
    }
    const invites = [];
    for (let i = 0; i < count; i++) {
      const token = genToken();
      const id = genId();
      const inv = { id, token, expiresAt: now() + INVITE_TTL_MS, revokedAt: null, redemptionKey: null, session: null };
      invitations.set(token, inv);
      invites.push({ id, token, expiresAt: inv.expiresAt });
    }
    return { ok: true, invites };
  }

  /**
   * Revoke a single invitation by its stable id.
   * Immediately invalidates associated session if any.
   */
  function revokeInvitation(inviteId) {
    if (typeof inviteId !== 'string' || !ID_RE.test(inviteId)) {
      return { ok: false, message: 'Invalid invitation id.' };
    }
    const inv = byId(inviteId);
    if (!inv) return { ok: false, message: 'Invitation not found.' };
    if (inv.revokedAt !== null) return { ok: true, alreadyRevoked: true };
    inv.revokedAt = now();
    return { ok: true };
  }

  /**
   * Revoke all invitations — host shutdown path.
   */
  function revokeAll() {
    const t = now();
    for (const inv of invitations.values()) {
      if (inv.revokedAt === null) inv.revokedAt = t;
    }
    return { ok: true, count: invitations.size };
  }

  /**
   * Redeem an invite token into a browser-session credential.
   *
   * The caller MUST provide a browser-generated unpredictable 32-byte
   * redemptionKey (base64url, 43 chars). The first call binds the key;
   * repeat with the SAME invite+key returns the same session (retry-safe).
   * A DIFFERENT key or missing key is rejected — a second browser holding
   * the same invite link cannot recover the session credential.
   *
   * @param {string} inviteToken   The invite-link credential.
   * @param {string} redemptionKey Browser-generated 32-byte key (base64url).
   * @returns {{ ok: boolean, sessionCredential?: string, sessionId?: string, expiresAt?: number, message?: string }}
   */
  function redeemInvitation(inviteToken, redemptionKey) {
    if (typeof inviteToken !== 'string' || !TOKEN_RE.test(inviteToken)) {
      return { ok: false, message: 'Invalid invitation.' };
    }
    if (typeof redemptionKey !== 'string' || !REDEEM_KEY_RE.test(redemptionKey)) {
      return { ok: false, message: 'A browser-generated redemption key is required.' };
    }
    const inv = invitations.get(inviteToken);
    if (!inv || !alive(inv)) {
      return { ok: false, message: 'This invitation has expired or been revoked.' };
    }
    if (inv.session === null) {
      // First redemption: bind the key and create the session.
      inv.redemptionKey = redemptionKey;
      inv.session = {
        sessionCredential: genToken(),
        id: genId(),
        name: null,
        consentedAt: null,
        consentVersion: null,
        requestedAt: null,
        decision: null,
        decidedAt: null,
        removedAt: null,
        leftAt: null,
        admittedAt: null,
        device: null,
      };
    } else {
      // Already redeemed: only the same key may recover the credential.
      if (inv.redemptionKey !== redemptionKey) {
        return { ok: false, message: 'This invitation was already redeemed by another browser.' };
      }
      const s = inv.session;
      // The host ended this session: no way back in on this link.
      if (s.removedAt !== null) return { ok: false, message: 'You were removed from this session.' };
      if (s.decision === 'rejected') return { ok: false, message: 'This request was rejected.' };
      const pristine = s.requestedAt === null && s.leftAt === null && s.decision === null;
      if (!pristine) {
        // Same browser, rejoin: back to the pre-join state with a new credential.
        // Same session id (one host row) and admittedAt is kept (no doorway TTL).
        if (s.leftAt !== null && activeCount() >= maxGuests) {
          return { ok: false, message: `At most ${maxGuests} invitations may be active. Revoke one first.` };
        }
        s.sessionCredential = genToken();
        s.name = null;
        s.consentedAt = null;
        s.consentVersion = null;
        s.requestedAt = null;
        s.decision = null;
        s.decidedAt = null;
        s.leftAt = null;
        s.device = null;
      }
    }
    return {
      ok: true,
      sessionCredential: inv.session.sessionCredential,
      sessionId: inv.session.id,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * Guest requests to join — requires name + explicit consent.
   * Authenticated by session credential (NOT invite token).
   * Idempotent if same name+consent; conflict if different.
   * Rejects unknown input fields and validates consentVersion format.
   *
   * @param {string} sessionCredential
   * @param {{ name: string, consent: boolean, consentVersion?: string }} input
   */
  function requestJoin(sessionCredential, input) {
    if (typeof sessionCredential !== 'string' || !SESSION_RE.test(sessionCredential)) {
      return { ok: false, message: 'Invalid session.' };
    }
    const inv = bySession(sessionCredential);
    if (!inv) return { ok: false, message: 'Session not found or invitation expired.' };
    if (!alive(inv)) return { ok: false, message: 'This invitation has expired or been revoked.' };
    const s = inv.session;
    if (s.leftAt !== null) return { ok: false, message: 'You left this session.' };
    if (s.decision === 'rejected') return { ok: false, message: 'This request was rejected.' };
    if (s.removedAt !== null) return { ok: false, message: 'You were removed from this session.' };

    // Validate input — reject null, arrays, non-objects, and unknown fields.
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, message: 'Invalid request body.' };
    }
    for (const key of Object.keys(input)) {
      if (!JOIN_ALLOWED_KEYS.has(key)) {
        return { ok: false, message: `Unknown field: ${key}` };
      }
    }
    if (input.consent !== true) return { ok: false, message: 'Explicit recording consent is required before joining.' };
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > NAME_MAX || NAME_RE.test(input.name)) {
      return { ok: false, message: 'Provide a display name (1–80 printable characters).' };
    }
    const trimmedName = input.name.trim();
    if ('device' in input && input.device !== 'phone') return { ok: false, message: 'Invalid device.' };
    const device = input.device === 'phone' ? 'phone' : null;
    // Validate consentVersion: optional, but if provided must be a bounded string.
    let version = '1';
    if ('consentVersion' in input) {
      if (typeof input.consentVersion !== 'string' || !CONSENT_VERSION_RE.test(input.consentVersion)) {
        return { ok: false, message: 'Invalid consent version (1–32 alphanumeric characters).' };
      }
      version = input.consentVersion;
    }

    // Idempotent check
    if (s.requestedAt !== null) {
      if (s.name === trimmedName && s.consentVersion === version) {
        return { ok: true, phase: s.decision === 'admitted' ? 'admitted' : 'pending', idempotent: true };
      }
      return { ok: false, code: 'CONFLICT', message: 'A different join request already exists for this session.' };
    }

    s.name = trimmedName;
    s.device = device;
    s.consentedAt = now();
    s.consentVersion = version;
    s.requestedAt = now();
    return { ok: true, phase: 'pending' };
  }

  /**
   * Host admits a pending guest. Authenticated by being in the host process.
   * Checks alive() before every decision — expired/revoked invitations are refused.
   * @param {string} sessionId  The stable session id (not the credential).
   */
  function admitGuest(sessionId) {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
      return { ok: false, message: 'Invalid session id.' };
    }
    for (const inv of invitations.values()) {
      if (inv.session && inv.session.id === sessionId) {
        if (!alive(inv)) return { ok: false, message: 'This invitation has expired or been revoked.' };
        const s = inv.session;
        if (s.leftAt !== null) return { ok: false, message: 'This guest left the session.' };
        if (s.requestedAt === null) return { ok: false, message: 'Guest has not requested to join.' };
        if (s.decision === 'admitted' && s.removedAt === null) {
          // Idempotent success — but still check alive first (above).
          return { ok: true, idempotent: true };
        }
        if (s.decision === 'rejected') return { ok: false, message: 'This request was already rejected.' };
        if (s.removedAt !== null) return { ok: false, message: 'This guest was removed.' };
        if (admittedCount() >= maxGuests) {
          return { ok: false, message: `At most ${maxGuests} guests may be admitted. Remove one first.` };
        }
        s.decision = 'admitted';
        s.decidedAt = now();
        if (s.admittedAt === null) s.admittedAt = now();
        return { ok: true };
      }
    }
    return { ok: false, message: 'Session not found.' };
  }

  /**
   * Host rejects a pending guest.
   * Checks alive() before decision.
   * @param {string} sessionId
   */
  function rejectGuest(sessionId) {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
      return { ok: false, message: 'Invalid session id.' };
    }
    for (const inv of invitations.values()) {
      if (inv.session && inv.session.id === sessionId) {
        if (!alive(inv)) return { ok: false, message: 'This invitation has expired or been revoked.' };
        const s = inv.session;
        if (s.leftAt !== null) return { ok: false, message: 'This guest left the session.' };
        if (s.requestedAt === null) return { ok: false, message: 'Guest has not requested to join.' };
        if (s.decision === 'rejected') return { ok: true, idempotent: true };
        if (s.decision === 'admitted' && s.removedAt === null) return { ok: false, message: 'Guest is already admitted. Remove them first.' };
        s.decision = 'rejected';
        s.decidedAt = now();
        return { ok: true };
      }
    }
    return { ok: false, message: 'Session not found.' };
  }

  /**
   * Host removes an admitted guest. Invalidates access immediately.
   * @param {string} sessionId
   */
  function removeGuest(sessionId) {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
      return { ok: false, message: 'Invalid session id.' };
    }
    for (const inv of invitations.values()) {
      if (inv.session && inv.session.id === sessionId) {
        const s = inv.session;
        if (s.leftAt !== null) return { ok: false, message: 'This guest left the session.' };
        if (s.decision !== 'admitted') return { ok: false, message: 'Guest is not admitted.' };
        if (s.removedAt !== null) return { ok: true, idempotent: true };
        s.removedAt = now();
        return { ok: true };
      }
    }
    return { ok: false, message: 'Session not found.' };
  }

  function isSessionAdmitted(sessionId) {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return false;
    for (const inv of invitations.values()) {
      if (inv.session && inv.session.id === sessionId) {
        if (!alive(inv)) return false;
        const s = inv.session;
        return s.decision === 'admitted' && s.leftAt === null && s.removedAt === null;
      }
    }
    return false;
  }

  /** True while the invite token names a live (unexpired, unrevoked) invitation. Read-only; used to rate-limit by credential. */
  function inviteIsLive(inviteToken) {
    if (typeof inviteToken !== 'string' || !TOKEN_RE.test(inviteToken)) return false;
    const inv = invitations.get(inviteToken);
    return !!inv && alive(inv);
  }

  /**
   * Check guest status by session credential.
   * @param {string} sessionCredential
   */
  function guestStatus(sessionCredential) {
    if (typeof sessionCredential !== 'string' || !SESSION_RE.test(sessionCredential)) {
      return { ok: false, message: 'Invalid session.' };
    }
    const inv = bySession(sessionCredential);
    if (!inv) return { ok: false, message: 'Session not found.' };
    if (!alive(inv)) return { ok: false, message: 'This invitation has expired or been revoked.' };
    const s = inv.session;
    if (s.leftAt !== null) return { ok: false, message: 'You left this session.' };
    if (s.removedAt !== null) return { ok: false, message: 'You were removed from this session.' };
    if (s.decision === 'rejected') return { ok: false, message: 'Your request was rejected.' };
    let phase = 'redeemed';
    if (s.requestedAt !== null) phase = 'pending';
    if (s.decision === 'admitted') phase = 'admitted';
    return { ok: true, phase, expiresAt: inv.expiresAt, sessionId: s.id };
  }

  /**
   * Host list — safe defensive-copy public view, no credentials exposed.
   * Each guest entry is a deep copy — no live internal references.
   */
  function hostList() {
    prune();
    const list = [];
    for (const inv of invitations.values()) {
      list.push(publicView(inv));
    }
    return { ok: true, guests: list };
  }

  /**
   * Guest leaves session. Records a distinct voluntary departure (invalidating access) in all phases.
   * @param {string} sessionCredential
   */
  function leaveSession(sessionCredential) {
    if (typeof sessionCredential !== 'string' || !SESSION_RE.test(sessionCredential)) {
      return { ok: false, message: 'Invalid session.' };
    }
    const inv = bySession(sessionCredential);
    if (!inv) return { ok: false, message: 'Session not found.' };
    const s = inv.session;
    if (s.leftAt !== null) return { ok: true, idempotent: true };
    if (s.removedAt !== null) return { ok: false, message: 'You were removed from this session.' };
    s.leftAt = now();
    return { ok: true };
  }

  return {
    createInvitation,
    revokeInvitation,
    revokeAll,
    createInvitations,
    remainingSlots,
    redeemInvitation,
    requestJoin,
    admitGuest,
    rejectGuest,
    removeGuest,
    leaveSession,
    guestStatus,
    inviteIsLive,
    isSessionAdmitted,
    hostList,
  };
}

module.exports = { createAdmissionStore, MAX_GUESTS, INVITE_TTL_MS };
