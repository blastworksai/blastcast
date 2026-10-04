// Host-facing status snapshot and the guest call configuration. Split out of guests.cjs (no behaviour change).
const { expireReadiness } = require('./guest-readiness.cjs');

function guestRows(ctx) {
  const { store, presence, sourceInFlight, originalsUnsupported } = ctx;
  const listRes = store.hostList();
  return listRes.guests.map(g => {
    if (!g.alive && g.phase === 'redeemed') {
      g.phase = g.revoked ? 'revoked' : 'expired';
    }
    // ClaudeBWAI — presence rides beside the admission phase, never instead of it.
    if (g.session && g.phase === 'admitted') {
      g.uploading = sourceInFlight.has(g.session.id);
      if (originalsUnsupported.has(g.session.id)) g.originalsUnsupported = true;
      g.presence = g.uploading ? 'connected' : presence.state(g.session.id);
      if (presence.isGone(g.session.id)) g.pageGone = true; // einh 4 Oct (r10): the guest's page closed on purpose; not a network drop
    }
    return g;
  });
}

function readinessView(readiness) {
  return readiness ? {
    routeType: readiness.routeType,
    stages: { ...readiness.stages },
    check: readiness.check ? { ...readiness.check } : null,
    hint: readiness.hint ? { ...readiness.hint } : null,
    diagnosis: readiness.diagnosis ? { ...readiness.diagnosis } : null,
  } : null;
}

function status(ctx) {
  const st = ctx.state;
  expireReadiness(ctx);
  ctx.signaling.pruneAll();
  const guests = guestRows(ctx);
  if (st.latest) {
    const g = guests.find(x => x.id === st.latest.id);
    if (!g || !g.alive || ['left', 'removed', 'rejected', 'revoked', 'expired'].includes(g.phase)) st.latest = null;
  }
  // ClaudeBWAI — the open, unused invitations (one source of truth: the store's own phase for each id).
  const phaseOf = new Map(guests.map(g => [g.id, g]));
  for (const id of [...ctx.opened.keys()]) { const g = phaseOf.get(id); if (!g || !g.alive || g.phase !== 'open') ctx.opened.delete(id); }
  const route = st.route;
  const openInvites = route ? [...ctx.opened.values()].map(i => ({ id: i.id, url: `${route.origin}/#invite=${i.token}`, expiresAt: i.expiresAt })) : [];
  return {
    ok: true,
    phase: st.phase,
    inviteSlots: ctx.store.remainingSlots(),
    invites: openInvites,
    origin: route?.origin ?? '',
    port: route?.port ?? null,
    helper: route?.helper ? { provider: route.helper.provider, iceTransportPolicy: route.helper.iceTransportPolicy, quota: 'unknown' } : null,
    readiness: readinessView(st.readiness),
    invite: st.latest ? { url: `${route.origin}/#invite=${st.latest.token}`, expiresAt: st.latest.expiresAt } : null,
    guests
  };
}

function callConfiguration(ctx, sessionId) {
  const st = ctx.state;
  if (!st.verified || st.phase !== 'ready' || !ctx.store.isSessionAdmitted(sessionId))
    return { ok: false, message: 'This guest is not admitted on the current route.' };
  const helper = st.route?.helper;
  return { ok: true, iceServers: helper ? structuredClone(helper.iceServers) : [],
    iceTransportPolicy: helper?.iceTransportPolicy ?? 'all' };
}

module.exports = { status, callConfiguration };
