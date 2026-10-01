// DiuleJ — BCAST-3 admission domain tests.
// node --test tests/admission.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionStore, MAX_GUESTS, INVITE_TTL_MS } from '../desktop/admission.cjs';

// ── Helpers ──────────────────────────────────────────────────────

function clock(start = 1_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  fn.set = (v) => { t = v; };
  return fn;
}

/** Generate a fake 43-char base64url key for redemption. */
function fakeKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = '';
  for (let i = 0; i < 43; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function fullJoin(store, inviteToken, name = 'Alice', consent = true) {
  const key = fakeKey();
  const redeem = store.redeemInvitation(inviteToken, key);
  assert.ok(redeem.ok, `redeem failed: ${redeem.message}`);
  const join = store.requestJoin(redeem.sessionCredential, { name, consent });
  assert.ok(join.ok, `join failed: ${join.message}`);
  return { sessionCredential: redeem.sessionCredential, sessionId: redeem.sessionId, redemptionKey: key };
}

// ── State transitions ────────────────────────────────────────────

describe('createAdmissionStore', () => {
  it('exports default constants', () => {
    assert.equal(MAX_GUESTS, 7);
    assert.equal(INVITE_TTL_MS, 30 * 60_000);
  });

  it('creates an invitation with token and expiry', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const result = store.createInvitation();
    assert.ok(result.ok);
    assert.equal(typeof result.invite.token, 'string');
    assert.equal(result.invite.token.length, 43);
    assert.equal(result.invite.expiresAt, now() + INVITE_TTL_MS);
  });

  it('invitation tokens are unique', () => {
    const store = createAdmissionStore();
    const a = store.createInvitation();
    const b = store.createInvitation();
    assert.notEqual(a.invite.token, b.invite.token);
    assert.notEqual(a.invite.id, b.invite.id);
  });

  it('host list starts empty', () => {
    const store = createAdmissionStore();
    const list = store.hostList();
    assert.ok(list.ok);
    assert.deepEqual(list.guests, []);
  });

  it('host list shows open invitation', () => {
    const store = createAdmissionStore();
    store.createInvitation();
    const list = store.hostList();
    assert.equal(list.guests.length, 1);
    assert.equal(list.guests[0].phase, 'open');
  });
});

// ── REGRESSION: credential replay attack ─────────────────────────

describe('credential replay (issue 1)', () => {
  it('second browser with different key cannot recover admitted credential', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();

    // Browser A redeems
    const keyA = fakeKey();
    const redeemA = store.redeemInvitation(inv.invite.token, keyA);
    assert.ok(redeemA.ok);

    // Guest joins and host admits
    store.requestJoin(redeemA.sessionCredential, { name: 'Alice', consent: true });
    store.admitGuest(redeemA.sessionId);

    // Browser B tries the same invite token with a different key — AFTER admission
    const keyB = fakeKey();
    assert.notEqual(keyA, keyB); // keys are different
    const redeemB = store.redeemInvitation(inv.invite.token, keyB);
    assert.equal(redeemB.ok, false, 'must not return admitted session credential');
    assert.ok(redeemB.message.includes('already redeemed'));
  });

  it('same browser retrying with same key recovers credential (retry-safe)', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r1 = store.redeemInvitation(inv.invite.token, key);
    const r2 = store.redeemInvitation(inv.invite.token, key);
    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.equal(r1.sessionCredential, r2.sessionCredential);
  });

  it('redeem without redemptionKey is rejected', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const r = store.redeemInvitation(inv.invite.token);
    assert.equal(r.ok, false);
  });

  it('redeem with empty/short key is rejected', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    assert.equal(store.redeemInvitation(inv.invite.token, '').ok, false);
    assert.equal(store.redeemInvitation(inv.invite.token, 'tooshort').ok, false);
  });
});

// ── REGRESSION: capacity recovery (issue 2) ──────────────────────

describe('capacity recovery (issue 2)', () => {
  it('revoked invitation releases slot', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    const i1 = store.createInvitation();
    assert.ok(i1.ok);
    assert.equal(store.createInvitation().ok, false); // at cap

    store.revokeInvitation(i1.invite.id);
    const i2 = store.createInvitation();
    assert.ok(i2.ok, 'slot should be freed after revoke');
  });

  it('rejected guest releases slot', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    const i1 = store.createInvitation();
    const { sessionId } = fullJoin(store, i1.invite.token);
    store.rejectGuest(sessionId);
    const i2 = store.createInvitation();
    assert.ok(i2.ok, 'slot should be freed after reject');
  });

  it('removed guest releases slot', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    const i1 = store.createInvitation();
    const { sessionId } = fullJoin(store, i1.invite.token);
    store.admitGuest(sessionId);
    store.removeGuest(sessionId);
    const i2 = store.createInvitation();
    assert.ok(i2.ok, 'slot should be freed after remove');
  });

  it('expired invitation releases slot', () => {
    const now = clock();
    const store = createAdmissionStore({ now, maxGuests: 1 });
    store.createInvitation();
    now.advance(INVITE_TTL_MS + 1);
    const i2 = store.createInvitation();
    assert.ok(i2.ok, 'slot should be freed after expiry');
  });

  it('>100 sequential create/revoke cycles without lockout', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    for (let i = 0; i < 120; i++) {
      const inv = store.createInvitation();
      assert.ok(inv.ok, `cycle ${i} create failed`);
      assert.ok(store.revokeInvitation(inv.invite.id).ok);
    }
  });

  it('>100 sequential create/reject cycles without lockout', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    for (let i = 0; i < 110; i++) {
      const inv = store.createInvitation();
      assert.ok(inv.ok, `cycle ${i} create failed`);
      const { sessionId } = fullJoin(store, inv.invite.token);
      assert.ok(store.rejectGuest(sessionId).ok);
    }
  });

  it('>100 sequential create/admit/remove cycles without lockout', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    for (let i = 0; i < 105; i++) {
      const inv = store.createInvitation();
      assert.ok(inv.ok, `cycle ${i} create failed`);
      const { sessionId } = fullJoin(store, inv.invite.token);
      assert.ok(store.admitGuest(sessionId).ok);
      assert.ok(store.removeGuest(sessionId).ok);
    }
  });

  it('>100 sequential create/expire cycles without lockout', () => {
    const now = clock();
    const store = createAdmissionStore({ now, maxGuests: 1 });
    for (let i = 0; i < 110; i++) {
      const inv = store.createInvitation();
      assert.ok(inv.ok, `cycle ${i} create failed`);
      now.advance(INVITE_TTL_MS + 1);
    }
  });

  it('removed/rejected session cannot redeem into live credential again', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.ok(r.ok);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    store.admitGuest(r.sessionId);
    store.removeGuest(r.sessionId);
    // Trying to use the same session credential after removal:
    const status = store.guestStatus(r.sessionCredential);
    assert.equal(status.ok, false);
  });

  it('maxGuests is capped at 7', () => {
    const store = createAdmissionStore({ maxGuests: 64 });
    for (let i = 0; i < 7; i++) assert.ok(store.createInvitation().ok);
    assert.equal(store.createInvitation().ok, false);
  });
});

// ── REGRESSION: expired/revoked host decisions (issue 3) ─────────

describe('expired/revoked host decisions (issue 3)', () => {
  it('admitGuest fails on expired invitation', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    now.advance(INVITE_TTL_MS + 1);
    const result = store.admitGuest(sessionId);
    assert.equal(result.ok, false, 'admitGuest must fail after expiry');
    assert.ok(result.message.includes('expired') || result.message.includes('revoked'));
  });

  it('admitGuest fails on revoked invitation', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    store.revokeInvitation(inv.invite.id);
    const result = store.admitGuest(sessionId);
    assert.equal(result.ok, false);
  });

  it('rejectGuest fails on expired invitation', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    now.advance(INVITE_TTL_MS + 1);
    assert.equal(store.rejectGuest(sessionId).ok, false);
  });

  it('idempotent admitGuest also checks alive', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    assert.ok(store.admitGuest(sessionId).ok);
    // Second call while alive → idempotent ok
    const r2 = store.admitGuest(sessionId);
    assert.ok(r2.ok);
    assert.ok(r2.idempotent);
    // Now expire
    now.advance(INVITE_TTL_MS + 1);
    const r3 = store.admitGuest(sessionId);
    assert.equal(r3.ok, false, 'idempotent admit must still check alive');
  });

  it('expired guest does not appear as admitted in host list', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    store.admitGuest(sessionId);
    now.advance(INVITE_TTL_MS + 1);
    const list = store.hostList();
    // The entry should exist but NOT show as 'admitted'
    for (const g of list.guests) {
      assert.notEqual(g.phase, 'admitted', 'expired guest must not appear admitted');
    }
  });

  it('revoked pending guest does not appear as pending in host list', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    fullJoin(store, inv.invite.token);
    store.revokeInvitation(inv.invite.id);
    const list = store.hostList();
    for (const g of list.guests) {
      assert.notEqual(g.phase, 'pending', 'revoked guest must not appear pending');
    }
  });
});

// ── REGRESSION: timestamp 0, input validation (issue 4) ──────────

describe('timestamp 0 and input validation (issue 4)', () => {
  it('clock starting at 0 works correctly', () => {
    const now = clock(0);
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    assert.ok(inv.ok);
    // revokedAt is null, not 0, so alive should be true
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.ok(r.ok);
    store.requestJoin(r.sessionCredential, { name: 'Test', consent: true });
    // requestedAt is 0 — must not be treated as falsy
    const list = store.hostList();
    assert.equal(list.guests[0].phase, 'pending');
    // Admit at t=0
    assert.ok(store.admitGuest(r.sessionId).ok);
    // Remove at t=0
    assert.ok(store.removeGuest(r.sessionId).ok);
    // removedAt is 0 — must not be treated as falsy
    assert.equal(store.guestStatus(r.sessionCredential).ok, false);
  });

  it('revoke at clock=0 works', () => {
    const now = clock(0);
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    store.revokeInvitation(inv.invite.id);
    // revokedAt is 0 — must not be treated as falsy
    const key = fakeKey();
    assert.equal(store.redeemInvitation(inv.invite.token, key).ok, false);
  });

  it('rejects unknown input fields in requestJoin', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.ok(r.ok);
    const j = store.requestJoin(r.sessionCredential, {
      name: 'Alice', consent: true, evil: 'payload',
    });
    assert.equal(j.ok, false);
    assert.ok(j.message.includes('Unknown field'));
  });

  it('rejects array as input to requestJoin', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.equal(store.requestJoin(r.sessionCredential, []).ok, false);
  });

  it('validates consentVersion type and length', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    // Number is rejected
    assert.equal(store.requestJoin(r.sessionCredential, { name: 'A', consent: true, consentVersion: 42 }).ok, false);
    // Too long
    assert.equal(store.requestJoin(r.sessionCredential, { name: 'A', consent: true, consentVersion: 'x'.repeat(33) }).ok, false);
    // Empty
    assert.equal(store.requestJoin(r.sessionCredential, { name: 'A', consent: true, consentVersion: '' }).ok, false);
    // Valid
    assert.ok(store.requestJoin(r.sessionCredential, { name: 'A', consent: true, consentVersion: 'v2.1' }).ok);
  });

  it('public views are defensive copies — mutating them does not affect state', () => {
    const store = createAdmissionStore();
    store.createInvitation();
    const list1 = store.hostList();
    // Mutate the returned guest
    list1.guests[0].phase = 'hacked';
    list1.guests[0].id = 'tampered';
    // Re-read — original must be intact
    const list2 = store.hostList();
    assert.notEqual(list2.guests[0].phase, 'hacked');
    assert.notEqual(list2.guests[0].id, 'tampered');
  });

  it('public views with sessions are deep copies', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    fullJoin(store, inv.invite.token);
    const list1 = store.hostList();
    list1.guests[0].session.name = 'TAMPERED';
    const list2 = store.hostList();
    assert.notEqual(list2.guests[0].session.name, 'TAMPERED');
  });
});

// ── Consent enforcement ──────────────────────────────────────────

describe('consent enforcement', () => {
  it('consent=false is rejected', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    const j = store.requestJoin(r.sessionCredential, { name: 'Alice', consent: false });
    assert.equal(j.ok, false);
    assert.ok(j.message.includes('consent'));
  });

  it('missing consent field is rejected', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    // 'consent' is a known field but not provided — but wait, the key validation
    // now checks allowed keys. { name: 'Alice' } has only 'name', which is allowed.
    // But consent !== true → rejected.
    const j = store.requestJoin(r.sessionCredential, { name: 'Alice' });
    assert.equal(j.ok, false);
  });

  it('consent=true with valid name succeeds', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    const j = store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    assert.ok(j.ok);
    assert.equal(j.phase, 'pending');
  });
});

// ── Idempotency ──────────────────────────────────────────────────

describe('idempotency', () => {
  it('requestJoin is idempotent with same name+consent', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    const j2 = store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    assert.ok(j2.ok);
    assert.ok(j2.idempotent);
  });

  it('requestJoin conflicts with different name', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    const j2 = store.requestJoin(r.sessionCredential, { name: 'Bob', consent: true });
    assert.equal(j2.ok, false);
    assert.ok(j2.message.includes('different'));
  });

  it('admitGuest is idempotent', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    assert.ok(store.admitGuest(sessionId).ok);
    const a2 = store.admitGuest(sessionId);
    assert.ok(a2.ok);
    assert.ok(a2.idempotent);
  });

  it('rejectGuest is idempotent', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    assert.ok(store.rejectGuest(sessionId).ok);
    const r2 = store.rejectGuest(sessionId);
    assert.ok(r2.ok);
    assert.ok(r2.idempotent);
  });

  it('removeGuest is idempotent', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    store.admitGuest(sessionId);
    assert.ok(store.removeGuest(sessionId).ok);
    const r2 = store.removeGuest(sessionId);
    assert.ok(r2.ok);
    assert.ok(r2.idempotent);
  });

  it('revokeInvitation is idempotent', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    assert.ok(store.revokeInvitation(inv.invite.id).ok);
    const r2 = store.revokeInvitation(inv.invite.id);
    assert.ok(r2.ok);
    assert.ok(r2.alreadyRevoked);
  });
});

// ── Expiry ───────────────────────────────────────────────────────

describe('invitation expiry', () => {
  it('expired invitation cannot be redeemed', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    now.advance(INVITE_TTL_MS + 1);
    const r = store.redeemInvitation(inv.invite.token, fakeKey());
    assert.equal(r.ok, false);
  });

  it('expired invitation is pruned from host list', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    store.createInvitation();
    now.advance(INVITE_TTL_MS + 1);
    assert.equal(store.hostList().guests.length, 0);
  });

  it('session still valid before expiry, invalid after', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    now.advance(INVITE_TTL_MS - 1000);
    assert.ok(store.guestStatus(r.sessionCredential).ok);
    now.advance(2000);
    assert.equal(store.guestStatus(r.sessionCredential).ok, false);
  });
});

// ── Revocation ───────────────────────────────────────────────────

describe('revocation', () => {
  it('revoking invalidates session status immediately', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    store.revokeInvitation(inv.invite.id);
    const status = store.guestStatus(r.sessionCredential);
    assert.equal(status.ok, false);
  });

  it('revokeAll invalidates all sessions', () => {
    const store = createAdmissionStore();
    const i1 = store.createInvitation();
    const i2 = store.createInvitation();
    const r1 = store.redeemInvitation(i1.invite.token, fakeKey());
    const r2 = store.redeemInvitation(i2.invite.token, fakeKey());
    store.revokeAll();
    assert.equal(store.guestStatus(r1.sessionCredential).ok, false);
    assert.equal(store.guestStatus(r2.sessionCredential).ok, false);
  });
});

// ── Removal invalidates access ───────────────────────────────────

describe('removal', () => {
  it('removed guest cannot check status', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionCredential, sessionId } = fullJoin(store, inv.invite.token);
    store.admitGuest(sessionId);
    store.removeGuest(sessionId);
    const status = store.guestStatus(sessionCredential);
    assert.equal(status.ok, false);
    assert.ok(status.message.includes('removed'));
  });

  it('removed guest cannot rejoin', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionCredential, sessionId } = fullJoin(store, inv.invite.token);
    store.admitGuest(sessionId);
    store.removeGuest(sessionId);
    const j = store.requestJoin(sessionCredential, { name: 'Alice', consent: true });
    assert.equal(j.ok, false);
  });
});

// ── Security: no credential leakage ──────────────────────────────

describe('no credential leakage', () => {
  it('host list does not contain invite tokens', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    store.redeemInvitation(inv.invite.token, fakeKey());
    const list = store.hostList();
    const json = JSON.stringify(list);
    assert.ok(!json.includes(inv.invite.token), 'invite token leaked into host list');
  });

  it('host list does not contain session credentials', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true });
    const list = store.hostList();
    const json = JSON.stringify(list);
    assert.ok(!json.includes(r.sessionCredential), 'session credential leaked into host list');
  });

  it('host list does not contain redemption keys', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    store.redeemInvitation(inv.invite.token, key);
    const list = store.hostList();
    const json = JSON.stringify(list);
    assert.ok(!json.includes(key), 'redemption key leaked into host list');
  });
});

// ── Malformed / oversize inputs ──────────────────────────────────

describe('input validation', () => {
  it('rejects empty name', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.equal(store.requestJoin(r.sessionCredential, { name: '', consent: true }).ok, false);
    assert.equal(store.requestJoin(r.sessionCredential, { name: '   ', consent: true }).ok, false);
  });

  it('rejects oversize name', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    const longName = 'A'.repeat(81);
    assert.equal(store.requestJoin(r.sessionCredential, { name: longName, consent: true }).ok, false);
  });

  it('rejects control characters in name', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.equal(store.requestJoin(r.sessionCredential, { name: 'Alice\x00', consent: true }).ok, false);
    assert.equal(store.requestJoin(r.sessionCredential, { name: 'Alice\n', consent: true }).ok, false);
  });

  it('rejects non-string session credential', () => {
    const store = createAdmissionStore();
    assert.equal(store.requestJoin(null, { name: 'A', consent: true }).ok, false);
    assert.equal(store.requestJoin(42, { name: 'A', consent: true }).ok, false);
  });

  it('rejects non-string invitation id', () => {
    const store = createAdmissionStore();
    assert.equal(store.revokeInvitation(null).ok, false);
    assert.equal(store.revokeInvitation(42).ok, false);
  });

  it('rejects non-string session id', () => {
    const store = createAdmissionStore();
    assert.equal(store.admitGuest(null).ok, false);
    assert.equal(store.rejectGuest(undefined).ok, false);
    assert.equal(store.removeGuest(42).ok, false);
  });

  it('rejects null/missing input to requestJoin', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.equal(store.requestJoin(r.sessionCredential, null).ok, false);
    assert.equal(store.requestJoin(r.sessionCredential).ok, false);
  });
});

// ── Host/guest credential boundary ───────────────────────────────

describe('host/guest credential boundary', () => {
  it('admitGuest by session credential (not id) fails', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionCredential } = fullJoin(store, inv.invite.token);
    const r = store.admitGuest(sessionCredential);
    assert.equal(r.ok, false);
  });

  it('guest cannot admit/reject/remove through any interface', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionCredential } = fullJoin(store, inv.invite.token);
    assert.equal(store.admitGuest(sessionCredential).ok, false);
    assert.equal(store.rejectGuest(sessionCredential).ok, false);
    assert.equal(store.removeGuest(sessionCredential).ok, false);
  });
});

// ── Decision conflicts ───────────────────────────────────────────

describe('decision conflicts', () => {
  it('cannot admit after rejection', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    store.rejectGuest(sessionId);
    assert.equal(store.admitGuest(sessionId).ok, false);
  });

  it('cannot reject after admission (must remove first)', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    store.admitGuest(sessionId);
    const r = store.rejectGuest(sessionId);
    assert.equal(r.ok, false);
  });

  it('cannot remove an unadmitted guest', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    const r = store.removeGuest(sessionId);
    assert.equal(r.ok, false);
  });

  it('cannot admit a guest who has not joined', () => {
    const store = createAdmissionStore();
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    assert.equal(store.admitGuest(r.sessionId).ok, false);
  });
});

// ── Full lifecycle ───────────────────────────────────────────────

describe('full lifecycle', () => {
  it('create → redeem → join → admit → remove', () => {
    const now = clock();
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionCredential, sessionId } = fullJoin(store, inv.invite.token, 'TestGuest');

    let status = store.guestStatus(sessionCredential);
    assert.ok(status.ok);
    assert.equal(status.phase, 'pending');

    let list = store.hostList();
    assert.equal(list.guests[0].phase, 'pending');
    assert.equal(list.guests[0].session.name, 'TestGuest');

    assert.ok(store.admitGuest(sessionId).ok);
    status = store.guestStatus(sessionCredential);
    assert.equal(status.phase, 'admitted');

    assert.ok(store.removeGuest(sessionId).ok);
    status = store.guestStatus(sessionCredential);
    assert.equal(status.ok, false);

    list = store.hostList();
    assert.equal(list.guests[0].phase, 'removed');
  });

  it('maxGuests option is respected', () => {
    const store = createAdmissionStore({ maxGuests: 1 });
    assert.ok(store.createInvitation().ok);
    assert.equal(store.createInvitation().ok, false);
  });

  it('ignores invalid maxGuests values', () => {
    const store = createAdmissionStore({ maxGuests: -1 });
    for (let i = 0; i < 7; i++) assert.ok(store.createInvitation().ok);
    assert.equal(store.createInvitation().ok, false);
  });
});

// ── Audit fields ─────────────────────────────────────────────────

describe('audit fields', () => {
  it('consent timestamp and version are recorded', () => {
    const now = clock(5000);
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const key = fakeKey();
    const r = store.redeemInvitation(inv.invite.token, key);
    now.advance(1000);
    store.requestJoin(r.sessionCredential, { name: 'Alice', consent: true, consentVersion: 'v2' });
    const list = store.hostList();
    const g = list.guests[0];
    assert.equal(g.session.consentedAt, 6000);
    assert.equal(g.session.consentVersion, 'v2');
    assert.equal(g.session.requestedAt, 6000);
  });

  it('decision timestamp is recorded', () => {
    const now = clock(1000);
    const store = createAdmissionStore({ now });
    const inv = store.createInvitation();
    const { sessionId } = fullJoin(store, inv.invite.token);
    now.advance(500);
    store.admitGuest(sessionId);
    const list = store.hostList();
    assert.equal(list.guests[0].session.decidedAt, 1500);
  });
});

// CodexBWAI — no-session revocations must be bounded like other tombstones.
it('repeated create and revoke without redemption keeps bounded host history', () => {
  const store = createAdmissionStore();
  for (let i = 0; i < 200; i++) {
    const result = store.createInvitation(); assert.equal(result.ok, true);
    assert.equal(store.revokeInvitation(result.invite.id).ok, true);
  }
  assert.ok(store.hostList().guests.length <= 64);
});

it('voluntary departure remains distinct from host removal and cannot be re-admitted', () => {
  const store = createAdmissionStore();
  const invite = store.createInvitation().invite;
  const guest = store.redeemInvitation(invite.token, 'k'.repeat(43));
  store.requestJoin(guest.sessionCredential, { name: 'Leaving guest', consent: true });
  assert.equal(store.leaveSession(guest.sessionCredential).ok, true);
  const row = store.hostList().guests[0];
  assert.equal(row.phase, 'left'); assert.equal(row.session.removedAt, null);
  assert.ok(Number.isFinite(row.session.leftAt));
  assert.match(store.guestStatus(guest.sessionCredential).message, /left/);
  assert.equal(store.admitGuest(guest.sessionId).ok, false);
  assert.equal(store.rejectGuest(guest.sessionId).ok, false);
  assert.equal(store.leaveSession(guest.sessionCredential).idempotent, true);
});
