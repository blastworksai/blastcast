const { performance } = require('node:perf_hooks');
const { createAdmissionStore, MAX_GUESTS } = require('./admission.cjs');
const { createSignalingBroker } = require('./signaling.cjs');
const { parseRoute, createRouteVerifier, verifyRoute } = require('./guest-route.cjs');
const { createRateLimiter } = require('./guest-rate-limit.cjs');
const { createHandler } = require('./guest-api.cjs');
const { expireReadiness, blockReadiness } = require('./guest-readiness.cjs');
const { status, callConfiguration } = require('./guest-status.cjs');
const { stop, configure } = require('./guest-lifecycle.cjs');

// Composition root of the guest server: creates the shared state, wires the guest-* modules, owns the public surface.
// Request handling -> guest-api(.cjs, guest-api-source.cjs); static files -> guest-static.cjs; limits -> guest-rate-limit.cjs;
// readiness -> guest-readiness.cjs; status -> guest-status.cjs; listener lifecycle -> guest-lifecycle.cjs.

// ClaudeBWAI — presence is not admission. Admission (admission.cjs) says who MAY be in the call; presence says who is
// still THERE. A guest page sends an authenticated request at least every 2 s while open (status poll; call poll every
// 500 ms; original uploads), so silence for PRESENCE_TIMEOUT_MS means the page has gone (tab closed, phone asleep,
// network lost). A disconnected guest stays admitted: Remove still works, a returning page resumes on its own, and a
// reload of the same browser goes back through the waiting list (the same-browser rejoin in admission.cjs).
const PRESENCE_TIMEOUT_MS = 12_000;
function createPresenceTracker({ now = Date.now, timeoutMs = PRESENCE_TIMEOUT_MS } = {}) {
  const seen = new Map();
  const gone = new Set(); // ClaudeBWAI — einh 4 Oct (r10): sessions whose page said it was closing (pagehide beacon), until the page speaks again.
  return {
    touch(sessionId) { seen.set(sessionId, now()); gone.delete(sessionId); },
    /** The page announced it is closing: disconnected NOW, and flagged so the host skips call recovery for it. */
    markGone(sessionId) { seen.delete(sessionId); gone.add(sessionId); },
    isGone(sessionId) { return gone.has(sessionId); },
    clear() { seen.clear(); gone.clear(); },
    /** 'connected' while the guest's page has spoken within the timeout, 'disconnected' afterwards (or never seen). */
    state(sessionId) {
      const at = seen.get(sessionId);
      return at !== undefined && now() - at <= timeoutMs ? 'connected' : 'disconnected';
    },
  };
}

function createGuestServer({ directory, now = Date.now, monotonicNow = () => performance.now(), probe = verifyRoute, sources = null } = {}) {
  const store = createAdmissionStore({ now });
  const ctx = {
    directory, now, monotonicNow, probe, sources, store,
    state: {
      server: null, route: null, verified: false, generation: 0, phase: 'off', readiness: null,
      controller: null, nonce: '', proof: '', latest: null,
      readinessToken: '', readinessDigest: null, readinessDeadline: 0,
      configuring: null,
    },
    opened: new Map(), // ClaudeBWAI — open invitations created this session: id -> { id, token, expiresAt }, in creation order.
    limiter: createRateLimiter({ now, store }),
    // CodexBWAI: connection lifetime and storage lifetime can end independently.
    activeUploads: new Map(),
    signaling: createSignalingBroker(store),
    presence: createPresenceTracker({ now }),
    // ClaudeBWAI — Codex review of 68ea271 (P1): original requests still in flight per guest. A backgrounded phone can hold
    // one upload open for longer than the presence timeout; while it is open the guest is still delivering.
    sourceInFlight: new Map(),
    // ClaudeBWAI — guests whose browser cannot record an original (self-reported, strict boolean). Never in a roster, never waited for.
    originalsUnsupported: new Set(),
    handle: null,
  };
  ctx.handle = createHandler(ctx);
  const st = ctx.state;

  return {
    status: () => status(ctx),
    stop: () => stop(ctx),
    callConfiguration: sessionId => callConfiguration(ctx, sessionId),
    configure: (input, acquireOrigin) => configure(ctx, input, acquireOrigin),
    failReadiness() {
      expireReadiness(ctx);
      if (st.phase !== 'outside-check' || !st.route) return { ok: false, message: 'There is no active outside-network check.' };
      blockReadiness(ctx, st.route.routeType === 'direct' ? 'DIRECT_OUTSIDE_UNREACHABLE' : 'PROVIDER_OUTSIDE_UNREACHABLE');
      return status(ctx);
    },
    // Internal saved-wizard path: acceptance is enabled, reachability is not asserted.
    enableSavedInvites() {
      expireReadiness(ctx);
      if (!st.route?.helper || !st.server || !['outside-check', 'ready'].includes(st.phase))
        return { ok: false, message: 'Start your saved guest connection again.' };
      st.verified = true; st.phase = 'ready';
      st.readiness = { ...st.readiness, stages: { ...st.readiness.stages, outside: st.readiness.stages.outside === 'passed' ? 'passed' : 'not-proven' } };
      return status(ctx);
    },
    // ClaudeBWAI — `count` separate one-person invitations, created together or not at all.
    invite(count = 1) {
      expireReadiness(ctx);
      if (!st.verified || st.phase !== 'ready') return { ok: false, message: 'Complete the outside-network readiness check before creating an invitation.' };
      const res = store.createInvitations(count);
      if (!res.ok) return res;
      for (const inv of res.invites) ctx.opened.set(inv.id, inv);
      st.latest = res.invites[res.invites.length - 1];
      return status(ctx);
    },
    revoke() {
      store.revokeAll();
      st.latest = null; ctx.opened.clear();
      return status(ctx);
    },
    // Adding internal admission store access so boundary/IPC can call these:
    admit: (sessionId) => store.admitGuest(sessionId),
    reject: (sessionId) => store.rejectGuest(sessionId),
    remove: (sessionId) => store.removeGuest(sessionId),
    revokeInvite: (inviteId) => store.revokeInvitation(inviteId),
    sendSignal: ctx.signaling.sendGuestSignal,
    pollSignals: ctx.signaling.pollGuestSignals,
  };
}
module.exports = { createGuestServer, createPresenceTracker, PRESENCE_TIMEOUT_MS, parseRoute, verifyRoute, createRouteVerifier, MAX_GUESTS };
