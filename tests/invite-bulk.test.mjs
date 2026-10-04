// ClaudeBWAI — einh, 4 Oct: "Generate X amount of invite links". Main-process batch creation + the UI count logic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAdmissionStore, MAX_GUESTS } from '../desktop/admission.cjs';
import { inviteCountOptions, clampInviteCount, generateLabel, shortInviteLink } from '../dist/invite-list.js';

describe('createInvitations (main process)', () => {
  it('creates N separate invitations with distinct tokens and ids', () => {
    const store = createAdmissionStore();
    const res = store.createInvitations(3);
    assert.equal(res.ok, true);
    assert.equal(res.invites.length, 3);
    assert.equal(new Set(res.invites.map(i => i.token)).size, 3);
    assert.equal(new Set(res.invites.map(i => i.id)).size, 3);
    assert.equal(store.remainingSlots(), MAX_GUESTS - 3);
  });
  it('refuses a count over the remaining slots and creates none', () => {
    const store = createAdmissionStore();
    assert.equal(store.createInvitations(2).ok, true);
    const res = store.createInvitations(MAX_GUESTS - 1);
    assert.equal(res.ok, false);
    assert.equal(store.remainingSlots(), MAX_GUESTS - 2, 'a refused batch leaves nothing behind');
    assert.equal(store.createInvitations(MAX_GUESTS - 2).ok, true);
    assert.equal(store.remainingSlots(), 0);
    assert.equal(store.createInvitations(1).ok, false);
  });
  it('refuses non-integers, zero, negatives and non-numbers', () => {
    const store = createAdmissionStore();
    for (const bad of [0, -1, 1.5, NaN, Infinity, '2', null, undefined]) assert.equal(store.createInvitations(bad).ok, false, String(bad));
    assert.equal(store.remainingSlots(), MAX_GUESTS);
  });
  it('a revoked invitation frees its slot', () => {
    const store = createAdmissionStore();
    const { invites } = store.createInvitations(MAX_GUESTS);
    assert.equal(store.revokeInvitation(invites[0].id).ok, true);
    assert.equal(store.remainingSlots(), 1);
  });
});

describe('invite count logic (UI)', () => {
  it('offers 1..remaining, never more than the server accepts', () => {
    assert.deepEqual(inviteCountOptions(3), [1, 2, 3]);
    assert.equal(inviteCountOptions(7).length, 7);
    assert.equal(inviteCountOptions(99).length, 7);
    assert.deepEqual(inviteCountOptions(0), [1]);
    assert.equal(clampInviteCount(5, 2), 2);
    assert.equal(clampInviteCount(0, 4), 1);
    assert.equal(clampInviteCount(3, 7), 3);
  });
  it('the button label follows the count', () => {
    assert.equal(generateLabel(1), 'Generate invite link');
    assert.equal(generateLabel(3), 'Generate 3 invite links');
  });
  it('a shortened link keeps the host and the last four characters', () => {
    assert.equal(shortInviteLink('https://abc.example/#invite=XXXXXXXXXXXXa91x'), 'abc.example/#invite=…a91x');
  });
  it('the studio page wires the select, the list and Copy all; the single Copy link button is gone', () => {
    const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
    for (const id of ['guest-invite-count', 'guest-invite-list', 'copy-all-guest-invites']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(!html.includes('copy-guest-invite"'));
    const ui = readFileSync(new URL('../dist/invites.js', import.meta.url), 'utf8');
    assert.ok(ui.includes('createGuestInvites') && ui.includes('copyAllGuestInvites') && ui.includes('inviteCountOptions'));
  });
});

it('with guest access already ready, the whole batch is one createGuestInvites call (no 1 + N-1 split)', () => {
  const src = readFileSync(new URL('../src/invites.ts', import.meta.url), 'utf8');
  const click = src.slice(src.indexOf("el('create-guest-invite').addEventListener('click'"));
  const handler = click.slice(0, click.indexOf('\n});') + 4);
  assert.match(handler, /if \(lastPhase === 'ready'\) \{[\s\S]*createGuestInvites\(want\)[\s\S]*return;/);
  assert.ok(handler.indexOf("lastPhase === 'ready'") < handler.indexOf('generateSaved()'));
});
