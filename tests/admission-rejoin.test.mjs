// Admission: TTL governs the doorway only; same-browser rejoin.
// node --test tests/admission-rejoin.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionStore, INVITE_TTL_MS } from '../desktop/admission.cjs';

function clock(start = 1_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}
let counter = 0;
const key = () => String(++counter).padStart(43, 'k');
const MIN = 60_000;

function setup(options = {}) {
  const now = clock();
  const store = createAdmissionStore({ now, ...options });
  const inv = store.createInvitation().invite;
  return { now, store, inv };
}
function join(store, inv, k, name = 'Alice') {
  const r = store.redeemInvitation(inv.token, k);
  assert.ok(r.ok, r.message);
  const j = store.requestJoin(r.sessionCredential, { name, consent: true });
  assert.ok(j.ok, j.message);
  return r;
}

describe('TTL governs the doorway only', () => {
  it('admitted guest stays ok past TTL', () => {
    const { now, store, inv } = setup();
    const r = join(store, inv, key());
    assert.ok(store.admitGuest(r.sessionId).ok);
    now.advance(INVITE_TTL_MS + MIN);
    const s = store.guestStatus(r.sessionCredential);
    assert.ok(s.ok, s.message);
    assert.equal(s.phase, 'admitted');
    assert.ok(store.isSessionAdmitted(r.sessionId));
  });

  it('never-admitted pending guest expires at TTL+1', () => {
    const { now, store, inv } = setup();
    const r = join(store, inv, key());
    now.advance(INVITE_TTL_MS + MIN);
    assert.equal(store.guestStatus(r.sessionCredential).ok, false);
    assert.equal(store.admitGuest(r.sessionId).ok, false);
  });

  it('unredeemed link expires', () => {
    const { now, store, inv } = setup();
    now.advance(INVITE_TTL_MS + MIN);
    assert.equal(store.redeemInvitation(inv.token, key()).ok, false);
  });

  it('revoked admitted guest is cut off past TTL', () => {
    const { now, store, inv } = setup();
    const r = join(store, inv, key());
    store.admitGuest(r.sessionId);
    now.advance(INVITE_TTL_MS + MIN);
    store.revokeInvitation(inv.id);
    assert.equal(store.guestStatus(r.sessionCredential).ok, false);
  });

  it('prune does not drop an admitted-once session past TTL', () => {
    const { now, store, inv } = setup();
    const r = join(store, inv, key());
    store.admitGuest(r.sessionId);
    now.advance(INVITE_TTL_MS + MIN);
    store.createInvitation(); // prunes
    const list = store.hostList().guests.find(g => g.id === inv.id);
    assert.ok(list, 'still listed');
    assert.equal(list.phase, 'admitted');
    assert.equal(list.alive, true);
    assert.ok(store.guestStatus(r.sessionCredential).ok);
  });
});

describe('same-browser rejoin', () => {
  it('rejoin after admit lands pending with a new credential and same id', () => {
    const { now, store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.admitGuest(first.sessionId);
    now.advance(INVITE_TTL_MS + MIN);
    const again = store.redeemInvitation(inv.token, k);
    assert.ok(again.ok, again.message);
    assert.equal(again.sessionId, first.sessionId);
    assert.notEqual(again.sessionCredential, first.sessionCredential);
    assert.equal(store.guestStatus(first.sessionCredential).ok, false, 'old credential refused');
    assert.equal(store.guestStatus(again.sessionCredential).phase, 'redeemed');
    assert.equal(store.isSessionAdmitted(first.sessionId), false);
    const row = store.hostList().guests.find(g => g.id === inv.id);
    assert.equal(row.session.name, null);
    assert.equal(row.session.decision, null);
    assert.equal(row.session.requestedAt, null);
    // normal join form, then host admits again; still one row, still past TTL
    assert.ok(store.requestJoin(again.sessionCredential, { name: 'Alice', consent: true }).ok);
    assert.equal(store.guestStatus(again.sessionCredential).phase, 'pending');
    assert.ok(store.admitGuest(again.sessionId).ok);
    assert.equal(store.guestStatus(again.sessionCredential).phase, 'admitted');
    assert.equal(store.hostList().guests.length, 1);
  });

  it('pending (admitted-once) rejoin stays exempt from the TTL while waiting', () => {
    const { now, store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.admitGuest(first.sessionId);
    const again = store.redeemInvitation(inv.token, k);
    now.advance(INVITE_TTL_MS + MIN);
    assert.ok(store.guestStatus(again.sessionCredential).ok);
  });

  it('a different key is refused', () => {
    const { store, inv } = setup();
    const first = join(store, inv, key());
    store.admitGuest(first.sessionId);
    const other = store.redeemInvitation(inv.token, key());
    assert.equal(other.ok, false);
    assert.match(other.message, /another browser/);
    assert.ok(store.guestStatus(first.sessionCredential).ok, 'refusal changed nothing');
  });

  it('removed session cannot rejoin', () => {
    const { store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.admitGuest(first.sessionId);
    store.removeGuest(first.sessionId);
    const r = store.redeemInvitation(inv.token, k);
    assert.equal(r.ok, false);
    assert.match(r.message, /removed/);
  });

  it('rejected session cannot rejoin', () => {
    const { store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.rejectGuest(first.sessionId);
    const r = store.redeemInvitation(inv.token, k);
    assert.equal(r.ok, false);
    assert.match(r.message, /rejected/);
  });

  it('a guest who left may rejoin', () => {
    const { store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.admitGuest(first.sessionId);
    store.leaveSession(first.sessionCredential);
    const r = store.redeemInvitation(inv.token, k);
    assert.ok(r.ok, r.message);
    assert.equal(r.sessionId, first.sessionId);
    assert.equal(store.guestStatus(r.sessionCredential).phase, 'redeemed');
    assert.equal(store.hostList().guests[0].session.leftAt, null);
  });

  it('a never-admitted guest who left rejoins within the TTL, not after', () => {
    const { now, store, inv } = setup();
    const k = key();
    const first = join(store, inv, k);
    store.leaveSession(first.sessionCredential);
    assert.ok(store.redeemInvitation(inv.token, k).ok);
    store.leaveSession(store.hostList().guests.length && first.sessionCredential); // old cred is dead: no-op
    now.advance(INVITE_TTL_MS + MIN);
    assert.equal(store.redeemInvitation(inv.token, k).ok, false);
  });

  it('initial redeem retry still returns a working credential', () => {
    const { store, inv } = setup();
    const k = key();
    const a = store.redeemInvitation(inv.token, k);
    const b = store.redeemInvitation(inv.token, k);
    assert.ok(a.ok && b.ok);
    assert.equal(b.sessionCredential, a.sessionCredential);
    assert.equal(b.sessionId, a.sessionId);
    assert.ok(store.guestStatus(b.sessionCredential).ok);
  });

  it('rejoin from left respects the active-invitation cap', () => {
    const { store, inv } = setup({ maxGuests: 1 });
    const k = key();
    const first = join(store, inv, k);
    store.leaveSession(first.sessionCredential);
    assert.ok(store.createInvitation().ok); // takes the freed slot
    const r = store.redeemInvitation(inv.token, k);
    assert.equal(r.ok, false);
    assert.match(r.message, /At most 1/);
  });
});
