import test from 'node:test';
import assert from 'node:assert';
import { createAdmissionStore } from '../desktop/admission.cjs';
import { createSignalingBroker } from '../desktop/signaling.cjs';

test('signaling broker', async (t) => {
  const store = createAdmissionStore({ now: Date.now });
  const broker = createSignalingBroker(store);
  
  const res = store.createInvitation();
  const token = res.invite.token;
  
  const redemptionKey = 'fixture'.repeat(6) + 'x';
  const redeemRes = store.redeemInvitation(token, redemptionKey);
  const sessionCred = redeemRes.sessionCredential;

  await t.test('unadmitted guest signals denied', () => {
    // Before join
    assert.strictEqual(broker.guestPoll(sessionCred, null, 0).ok, false);
    assert.strictEqual(broker.guestSend(sessionCred, 'host-call-id-123456789', { type: 'hangup' }).ok, false);
  });

  store.requestJoin(sessionCred, { name: 'Alice', consent: true });
  
  const list = store.hostList().guests;
  const sessionId = list[0].session.id;

  await t.test('pending guest signals denied', () => {
    // Before admit
    assert.strictEqual(broker.guestPoll(sessionCred, null, 0).ok, false);
    assert.strictEqual(broker.guestSend(sessionCred, 'host-call-id-123456789', { type: 'hangup' }).ok, false);
  });

  store.admitGuest(sessionId);

  await t.test('null call with no offer polls empty', () => {
    const r = broker.guestPoll(sessionCred, null, 0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.callId, null);
    assert.strictEqual(r.messages.length, 0);
  });

  await t.test('host offer starts a new call', () => {
    const r = broker.sendGuestSignal(sessionId, 'host-call-id-123456789', { type: 'description', description: { type: 'offer', sdp: 'fake-sdp' }});
    assert.strictEqual(r.ok, true);
  });
  
  await t.test('guest polls and receives offer', () => {
    const r = broker.guestPoll(sessionCred, null, 0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.callId, 'host-call-id-123456789');
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].message.type, 'description');
  });

  await t.test('guest sends answer', () => {
    const r = broker.guestSend(sessionCred, 'host-call-id-123456789', { type: 'description', description: { type: 'answer', sdp: 'fake-answer' }});
    assert.strictEqual(r.ok, true);
  });
  
  await t.test('host polls answer', () => {
    const r = broker.pollGuestSignals(sessionId, 'host-call-id-123456789', 0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].message.type, 'description');
  });
  
  await t.test('host polling prunes guest queue', () => {
    broker.pollGuestSignals(sessionId, 'host-call-id-123456789', 1);
    const state = broker.pollGuestSignals(sessionId, 'host-call-id-123456789', 1);
    assert.strictEqual(state.messages.length, 0);
  });

  await t.test('lost cursor explicitly rejected', () => {
    // Host polled at 1, queue was pruned. Now polling at 0 should be a lost cursor
    const r = broker.pollGuestSignals(sessionId, 'host-call-id-123456789', 0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Lost cursor.');
  });

  await t.test('new call supersedes old', () => {
    const r = broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'description', description: { type: 'offer', sdp: 'new-sdp' }});
    assert.strictEqual(r.ok, true);

    // Guest polling with old call ID gets reset
    const guestR = broker.guestPoll(sessionCred, 'host-call-id-123456789', 0);
    assert.strictEqual(guestR.ok, true);
    assert.strictEqual(guestR.callId, 'host-call-id-new-00000'); // the new call id
    assert.strictEqual(guestR.messages.length, 1);
    assert.strictEqual(guestR.messages[0].sequence, 1);
  });

  await t.test('same-ID offer replays do not erase queued answers', () => {
    // Guest sends an answer
    broker.guestSend(sessionCred, 'host-call-id-new-00000', { type: 'description', description: { type: 'answer', sdp: 'new-answer' }});
    // Host sends the same offer again (same callId)
    broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'description', description: { type: 'offer', sdp: 'new-sdp' }});
    
    // Poll host queue to see if guest answer is still there
    const r = broker.pollGuestSignals(sessionId, 'host-call-id-new-00000', 0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].message.description.type, 'answer');
  });

  await t.test('oversized SDP rejected', () => {
    const hugeSdp = 'x'.repeat(65537); // > 64KiB
    const r = broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'description', description: { type: 'offer', sdp: hugeSdp }});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Invalid signal message.');
  });

  await t.test('queue overflow rejected', () => {
    for (let i = 0; i < 64; i++) {
      broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'candidate', candidate: null });
    }
    const r = broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'candidate', candidate: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Signaling queue overflow.');
  });

  await t.test('stale guest writes rejected', () => {
    const r = broker.guestSend(sessionCred, 'stale-call-id-12345678', { type: 'candidate', candidate: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Stale callId.');
  });

  await t.test('removal invalidates signaling', () => {
    store.removeGuest(sessionId);
    assert.strictEqual(broker.guestPoll(sessionCred, null, 0).ok, false);
    assert.strictEqual(broker.sendGuestSignal(sessionId, 'host-call-id-new-00000', { type: 'hangup' }).ok, false);
  });
});

// CodexBWAI — invalid reads/writes must leave an existing exchange intact.
test('strict validation and owned snapshots preserve signaling state', () => {
  const store = createAdmissionStore({ now: () => 1000 });
  const broker = createSignalingBroker(store);
  const inv = store.createInvitation().invite;
  const guest = store.redeemInvitation(inv.token, 'fixture'.repeat(6) + 'x');
  store.requestJoin(guest.sessionCredential, { name: 'Fixture', consent: true });
  store.admitGuest(guest.sessionId);
  const id = 'c'.repeat(22);
  const offer = { type: 'description', description: { type: 'offer', sdp: 'initial' } };
  assert.equal(broker.sendGuestSignal(guest.sessionId, id, offer).ok, true);
  offer.description.sdp = 'mutated';
  const reply = broker.guestPoll(guest.sessionCredential, null, 0);
  assert.equal(reply.messages[0].message.description.sdp, 'initial');
  reply.messages[0].message.description.sdp = 'mutated reply';
  for (const bad of [null, [], {}, { type: 'hangup', extra: true }, { type: 'description', description: null },
    ...[NaN, Infinity, -1, .5, 65536].map(n => ({ type: 'candidate', candidate: { candidate: 'fixture', sdpMLineIndex: n } }))]) {
    assert.equal(broker.sendGuestSignal(guest.sessionId, id, bad).ok, false);
  }
  for (const cursor of [NaN, Infinity, -1, .5, 2]) assert.equal(broker.guestPoll(guest.sessionCredential, id, cursor).ok, false);
  assert.equal(broker.guestPoll(guest.sessionCredential, id, 0).messages[0].message.description.sdp, 'initial');
  assert.equal(broker.sendGuestSignal(guest.sessionId, id, { type: 'description', description: { type: 'offer', sdp: 'repeat' } }).ok, false);
});

test('screen signals and exact MID metadata stay admitted-only and strictly shaped', () => {
  const store=createAdmissionStore({now:Date.now}), broker=createSignalingBroker(store);
  const invite=store.createInvitation();const {sessionCredential}=store.redeemInvitation(invite.invite.token,'screen'.repeat(7)+'x');
  store.requestJoin(sessionCredential,{name:'Share',consent:true});const id=store.hostList().guests[0].session.id;const callId='screen-call-1234567890';
  assert.equal(broker.guestSend(sessionCredential,callId,{type:'screen',active:true}).ok,false);
  assert.equal(broker.sendGuestSignal(id,callId,{type:'description',description:{type:'offer',sdp:'fixture'},screenMid:'2'}).ok,false);
  store.admitGuest(id);
  assert.equal(broker.sendGuestSignal(id,callId,{type:'description',description:{type:'offer',sdp:'fixture'},screenMid:'2'}).ok,true);
  assert.equal(broker.guestSend(sessionCredential,callId,{type:'screen',active:true}).ok,true);
  for(const message of [{type:'screen',active:'yes'},{type:'screen',active:true,track:'secret'}, {type:'description',description:{type:'answer',sdp:'fixture'},screenMid:'x'.repeat(33)}, {type:'description',description:{type:'answer',sdp:'fixture'},screenMid:'2',extra:true}])assert.equal(broker.guestSend(sessionCredential,callId,message).ok,false);
  assert.equal(broker.pollGuestSignals(id,callId,0).messages[0].message.active,true);
});

test('an ICE-restart offer is the one repeat offer a live call accepts, numbered and on the same callId only', () => {
  const store = createAdmissionStore({ now: Date.now }), broker = createSignalingBroker(store);
  const invite = store.createInvitation(); const { sessionCredential } = store.redeemInvitation(invite.invite.token, 'restart'.repeat(6) + 'x');
  store.requestJoin(sessionCredential, { name: 'Reed', consent: true }); const id = store.hostList().guests[0].session.id; store.admitGuest(id);
  const callId = 'restart-call-123456789', offer = extra => ({ type: 'description', description: { type: 'offer', sdp: 'x' }, ...extra });
  assert.equal(broker.sendGuestSignal(id, callId, offer({})).ok, true);
  assert.equal(broker.sendGuestSignal(id, callId, offer({})).ok, false, 'a plain repeat offer is still refused');
  assert.equal(broker.sendGuestSignal(id, callId, offer({ iceRestart: true, generation: 1 })).ok, true);
  assert.equal(broker.sendGuestSignal(id, 'other-call-12345678901', offer({ iceRestart: true, generation: 1 })).ok, false, 'never on another callId');
  for (const bad of [{ iceRestart: false }, { generation: 0 }, { generation: 1.5 }, { iceRestart: true, generation: 'x' }]) assert.equal(broker.sendGuestSignal(id, callId, offer(bad)).ok, false);
  assert.equal(broker.guestPoll(sessionCredential, callId, 0).messages.length, 2, 'the host queue carried on: both offers, nothing reset');
  assert.equal(broker.guestSend(sessionCredential, callId, { type: 'description', description: { type: 'answer', sdp: 'y' }, generation: 1 }).ok, true);
});
