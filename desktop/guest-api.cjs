// Request handling for the guest server: the check order is Host, rate limit, route check, readiness assets,
// readiness confirm, verified gate, static assets, then the /api routes. Split out of guests.cjs (no behaviour change).
const { TOKEN, REDEEMPTION_KEY, SESSION_RE, headers, send, bearerToken, jsonBody } = require('./guest-http.cjs');
const { isReadinessAsset, serveReadinessAsset, guestAssetPath, hasAsset, serveAsset } = require('./guest-static.cjs');
const { handleReadinessConfirm } = require('./guest-readiness.cjs');
const { callConfiguration } = require('./guest-status.cjs');
const { sourceRoutes } = require('./guest-api-source.cjs');

const ALLOWED_POSTS = ['/api/redeem', '/api/preview', '/api/join', '/api/status', '/api/leave', '/api/call/send', '/api/call/poll', '/api/call/config', '/api/source/status', '/api/source/begin', '/api/source/chunk', '/api/source/finish', '/api/page-gone'];
const TOO_MANY = { message: 'Too many requests. Wait a moment and retry.' };
const invalid = response => send(response, 400, { message: 'Invalid request.' });

// ---- session routes: `call` = { token, participantId, body, current, statusRes } ----
function join(ctx, request, response, { token, body, statusRes }) {
  const joinRes = ctx.store.requestJoin(token, body);
  ctx.signaling.pruneAll();
  if (!joinRes.ok) { send(response, joinRes.code === 'CONFLICT' ? 409 : 400, { message: joinRes.message }); return; }
  send(response, 200, { ok: true, phase: joinRes.phase, expiresAt: statusRes.expiresAt });
}

function leave(ctx, request, response, { token, body, statusRes }) {
  if (Object.keys(body).length > 0) { invalid(response); return; }
  ctx.store.leaveSession(token);
  ctx.limiter.forget(`s:${statusRes.sessionId}`);
  ctx.signaling.pruneAll();
  send(response, 200, { ok: true, phase: 'left' });
}

function callConfig(ctx, request, response, { token, body }) {
  if (Object.keys(body).length) { invalid(response); return; }
  // Recheck after the asynchronous request body: removal/expiry can race it.
  const admitted = ctx.store.guestStatus(token);
  if (!admitted.ok || admitted.phase !== 'admitted') { send(response, 410, { message: 'Guest session is closed.' }); return; }
  send(response, 200, callConfiguration(ctx, admitted.sessionId));
}

function callSend(ctx, request, response, { token, body }) {
  if (Object.keys(body).length !== 2 || !('callId' in body) || !('message' in body)) { invalid(response); return; }
  const res = ctx.signaling.guestSend(token, body.callId, body.message);
  if (!res.ok) { send(response, 400, { message: res.message }); return; }
  send(response, 200, { ok: true });
}

function callPoll(ctx, request, response, { token, body }) {
  if (Object.keys(body).length !== 2 || !('callId' in body) || !('after' in body)) { invalid(response); return; }
  const res = ctx.signaling.guestPoll(token, body.callId, body.after);
  if (!res.ok) { send(response, 400, { message: res.message }); return; }
  send(response, 200, res);
}

// For status and preview, we just return the current phase.
function phaseOnly(ctx, request, response, { body, statusRes }) {
  if (Object.keys(body).length > 0) { invalid(response); return; }
  send(response, 200, { ok: true, phase: statusRes.phase, expiresAt: statusRes.expiresAt });
}

const sessionRoutes = {
  ...sourceRoutes,
  '/api/join': join,
  '/api/leave': leave,
  '/api/call/config': callConfig,
  '/api/call/send': callSend,
  '/api/call/poll': callPoll,
};

function redeem(ctx, response, token, body) {
  if (!TOKEN.test(token)) { send(response, 410, { message: 'Invalid invitation token.' }); return; }
  if (!body || typeof body.redemptionKey !== 'string' || !REDEEMPTION_KEY.test(body.redemptionKey) || Object.keys(body).length !== 1) {
    send(response, 400, { message: 'Invalid redemption request.' }); return;
  }
  const res = ctx.store.redeemInvitation(token, body.redemptionKey);
  if (!res.ok) { send(response, 410, { message: res.message }); return; }
  // A same-browser rejoin leaves the admitted state: drop any broker call state
  // so the host's next poll ends the stale peer instead of leaving it dangling.
  ctx.signaling.pruneAll();
  send(response, 200, { ok: true, phase: 'redeemed', sessionCredential: res.sessionCredential, expiresAt: res.expiresAt });
}

// Call and source routes need an admitted session before the body is read; returns false after answering.
function gateAdmitted(ctx, request, response, token) {
  const authorized = SESSION_RE.test(token) && ctx.store.guestStatus(token);
  if (!authorized || !authorized.ok) { request.resume(); send(response, 410, { message: 'This guest session is closed.' }); return false; }
  if (authorized.phase !== 'admitted') { request.resume(); send(response, 400, { message: 'Not admitted.' }); return false; }
  if (request.url.startsWith('/api/source/') && !ctx.sources) { request.resume(); send(response, 503, { message: 'Sources not configured.' }); return false; }
  return true;
}

// Count the request as presence, and (for source routes) as an upload still in flight.
function trackPresence(ctx, request, response, sessionId) {
  const { presence, sourceInFlight } = ctx;
  presence.touch(sessionId); // ClaudeBWAI — any authenticated request from the page proves it is still open
  // ...and so does one that completes (a long upload started before the timeout and finished after it).
  response.once('finish', () => presence.touch(sessionId));
  if (request.url.startsWith('/api/source/')) {
    sourceInFlight.set(sessionId, (sourceInFlight.get(sessionId) ?? 0) + 1);
    response.once('close', () => { const left = (sourceInFlight.get(sessionId) ?? 1) - 1; if (left > 0) sourceInFlight.set(sessionId, left); else sourceInFlight.delete(sessionId); });
  }
}

// ClaudeBWAI — einh 4 Oct (r10): the guest page's one-shot "tab closed" note (navigator.sendBeacon on pagehide). A beacon cannot set
// an Authorization header, so the session credential rides in the JSON body, exactly {session}. It does NOT count as presence.
// Answers match the other session routes: 400 for a wrong shape, 410 for a closed/unknown session, 204 on success.
async function pageGone(ctx, request, response, current) {
  let body;
  try { body = await jsonBody(request, 256); } catch { if (!response.destroyed) invalid(response); return; }
  if (ctx.state.generation !== current || !ctx.state.verified) { send(response, 410, { message: 'This invitation is closed.' }); return; }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'session' || typeof body.session !== 'string') { invalid(response); return; }
  const authorized = SESSION_RE.test(body.session) && ctx.store.guestStatus(body.session);
  if (!authorized || !authorized.ok || authorized.phase !== 'admitted') { send(response, 410, { message: 'This guest session is closed.' }); return; }
  ctx.presence.markGone(authorized.sessionId);
  response.writeHead(204, headers); response.end();
}

async function handleApi(ctx, request, response, current) {
  const st = ctx.state;
  if (request.method !== 'POST' || !ALLOWED_POSTS.includes(request.url)) {
    request.resume(); send(response, 404, { message: 'Not found.' }); return;
  }
  if (request.headers.origin !== st.route.origin) { request.resume(); send(response, 403, { message: 'Open your invitation at the host’s secure address.' }); return; }

  if (request.url === '/api/page-gone') { await pageGone(ctx, request, response, current); return; }
  const token = bearerToken(request);
  let body;
  // A64KiB SDP can expand sixfold in JSON escapes; keep the wire body bounded
  // separately from the decoded SDP/candidate limits in the broker.
  if (request.url.startsWith('/api/call/') || request.url.startsWith('/api/source/')) {
    if (!gateAdmitted(ctx, request, response, token)) return;
  }
  if (request.url !== '/api/source/chunk') {
    const bodyLimit = request.url === '/api/call/send' ? 400 * 1024 : 2048;
    try { body = await jsonBody(request, bodyLimit); } catch { if (!response.destroyed) send(response, 400, { message: 'Invalid request.' }); return; }
  }

  if (st.generation !== current || !st.verified) { send(response, 410, { message: 'This invitation is closed.' }); return; }

  if (request.url === '/api/redeem') { redeem(ctx, response, token, body); return; }

  // For all other endpoints, 'token' is actually the sessionCredential
  if (!SESSION_RE.test(token)) { send(response, 410, { message: 'Invalid session credential.' }); return; }

  const statusRes = ctx.store.guestStatus(token);
  if (!statusRes.ok) { send(response, 410, { message: statusRes.message }); return; }
  trackPresence(ctx, request, response, statusRes.sessionId);

  if (request.url.startsWith('/api/source/') && statusRes.phase !== 'admitted') {
    request.resume(); send(response, 410, { message: 'This guest session is closed.' }); return;
  }

  const route = sessionRoutes[request.url] ?? phaseOnly;
  await route(ctx, request, response, { token, participantId: statusRes.sessionId, body, current, statusRes });
}

// The pre-API checks, in order. Returns true once the request has been answered.
async function handlePublic(ctx, request, response) {
  const st = ctx.state;
  if (request.method === 'GET' && st.nonce && request.url === `/route-check/${st.nonce}`) {
    send(response, 200, st.proof, 'text/plain'); return true;
  }
  if (request.method === 'GET' && isReadinessAsset(request.url) && (st.phase === 'outside-check' || (st.phase === 'ready' && st.readinessDigest))) {
    await serveReadinessAsset(ctx.directory, request.url, response); return true;
  }
  if (request.method === 'POST' && request.url === '/api/readiness/confirm') { await handleReadinessConfirm(ctx, request, response); return true; }
  if (!st.verified) { request.resume(); send(response, 503, { message: 'The host is still checking the guest address.' }); return true; }
  const assetPath = guestAssetPath(request.url);
  if (request.method === 'GET' && hasAsset(assetPath)) { await serveAsset(ctx.directory, assetPath, response); return true; }
  return false;
}

function createHandler(ctx) {
  return async function handle(request, response) {
    const st = ctx.state;
    const current = st.generation;
    if (!st.route || request.headers.host !== st.route.host) { request.resume(); send(response, 403, { message: 'Wrong guest address.' }); return; }
    // Rate limit, counted only AFTER the Host check and per credential (Behind the tunnel every peer is 127.0.0.1, so per-IP
    // is impossible). A request carrying a live session credential (or a live invite bearer on /api/redeem) draws on its own
    // bucket; everything else shares the small pre-auth bucket, so an outsider flooding the public address can never 429 a guest.
    if (ctx.limiter.isOver(request)) { request.resume(); send(response, 429, TOO_MANY, 'application/json', { ...headers, 'Retry-After': '1' }); return; }
    if (await handlePublic(ctx, request, response)) return;
    await handleApi(ctx, request, response, current);
  };
}

module.exports = { createHandler };
