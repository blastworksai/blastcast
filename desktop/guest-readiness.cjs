// Readiness lifecycle of the guest server: stage sets, blocking, expiry, probe hints and the outside-check confirmation.
// Operates on the shared server state (ctx.state). Split out of guests.cjs (no behaviour change).
const { timingSafeEqual } = require('node:crypto');
const { TOKEN, readinessHeaders, digest, send, bearerToken, jsonBody } = require('./guest-http.cjs');

const pendingStages = () => ({ listener: 'pending', address: 'pending', https: 'pending', route: 'pending', outside: 'pending' });
const outsideStages = () => ({ listener: 'passed', address: 'pending', https: 'pending', route: 'pending', outside: 'pending' });
const passedStages = () => ({ listener: 'passed', address: 'passed', https: 'passed', route: 'passed', outside: 'passed' });
const blockedStages = listener => ({ listener, address: 'not-proven', https: 'not-proven', route: 'not-proven', outside: 'failed' });

const BLOCK_MESSAGES = {
  LOCAL_PORT_BUSY: 'That local port is in use. Choose another port and update your HTTPS route.',
  OUTSIDE_CHECK_EXPIRED: 'The outside-network check expired. Start a new check when the other device is ready.',
  DIRECT_OUTSIDE_UNREACHABLE: 'The outside check did not reach BlastCast. Firewall or forwarding, an unsupported mapping, or CGNAT may be the cause; BlastCast cannot distinguish these from inside this network. No automatic retry was started.',
  PROVIDER_OUTSIDE_UNREACHABLE: 'The HTTPS tunnel/provider route was not verified. This check does not provide TURN or prove media reachability. No automatic retry was started.',
};

function blockReadiness(ctx, code) {
  const st = ctx.state;
  if (!st.route) return;
  st.phase = 'blocked'; st.verified = false; st.latest = null; ctx.opened.clear(); ctx.store.revokeAll();
  st.readinessToken = ''; st.readinessDigest = null; st.readinessDeadline = 0;
  st.readiness = {
    routeType: st.route.routeType,
    stages: blockedStages(code === 'LOCAL_PORT_BUSY' ? 'failed' : 'passed'),
    check: null,
    hint: code === 'LOCAL_PORT_BUSY' ? null : st.readiness?.hint ?? null,
    diagnosis: { code, message: BLOCK_MESSAGES[code] },
  };
}

function expireReadiness(ctx) {
  const st = ctx.state;
  if (st.readinessDeadline <= 0 || ctx.monotonicNow() < st.readinessDeadline) return false;
  if (st.phase === 'outside-check') blockReadiness(ctx, 'OUTSIDE_CHECK_EXPIRED');
  else if (st.phase === 'ready') { st.readinessDigest = null; st.readinessDeadline = 0; st.readinessToken = ''; st.readiness = { ...st.readiness, check: null }; }
  return true;
}

function probeHint(error) {
  const errorCode = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') return { code: 'HOST_DNS_LOOKUP_FAILED', message: 'This computer could not resolve the guest address. The outside check remains available.' };
  if (errorCode === 'HOST_ROUTE_MISMATCH') return { code: 'HOST_ROUTE_MISMATCH', message: 'This computer reached an address that did not return BlastCast’s exact route check. The outside check remains authoritative.' };
  if (/CERT|TLS|HOSTNAME|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(errorCode) || /certificate|hostname|TLS/i.test(message)) return { code: 'HOST_TLS_VALIDATION_FAILED', message: 'This computer could not validate the HTTPS certificate. Do not bypass a browser warning; the outside check remains available.' };
  return { code: 'HOST_ROUTE_UNREACHABLE', message: 'This computer could not reach the public route. Hairpin NAT or split DNS can cause this even when the outside route works.' };
}

const closed = (response, status, message) => send(response, status, { message }, 'application/json', readinessHeaders);
const checkOpen = st => (st.phase === 'outside-check' || st.phase === 'ready') && st.readinessDigest && st.readinessDeadline > 0;

/** POST /api/readiness/confirm */
async function handleReadinessConfirm(ctx, request, response) {
  const st = ctx.state;
  const beforeGeneration = st.generation;
  if (request.headers.origin !== st.route.origin) { request.resume(); closed(response, 403, 'Open the readiness link at the host’s secure address.'); return; }
  expireReadiness(ctx);
  if (!checkOpen(st)) { request.resume(); closed(response, 410, 'This readiness check is closed.'); return; }
  const token = bearerToken(request);
  const candidate = TOKEN.test(token) ? digest(token) : Buffer.alloc(32);
  if (!timingSafeEqual(candidate, st.readinessDigest)) { request.resume(); closed(response, 410, 'This readiness check is closed.'); return; }
  let body;
  try { body = await jsonBody(request, 256); } catch { if (!response.destroyed) closed(response, 400, 'Invalid readiness confirmation.'); return; }
  expireReadiness(ctx);
  if (st.generation !== beforeGeneration || !checkOpen(st) ||
      Object.keys(body).sort().join() !== 'outsideNetwork,secureWithoutBypass' || body.outsideNetwork !== true || body.secureWithoutBypass !== true) {
    const gone = st.generation !== beforeGeneration || st.phase === 'blocked';
    closed(response, gone ? 410 : 400, gone ? 'This readiness check is closed.' : 'Confirm both readiness statements.'); return;
  }
  if (st.phase === 'outside-check' || st.readiness.stages.outside !== 'passed') {
    st.phase = 'ready'; st.verified = true; st.readinessToken = '';
    st.readiness = { ...st.readiness, stages: passedStages(), check: null, diagnosis: null };
  }
  send(response, 200, { ok: true, phase: 'ready' }, 'application/json', readinessHeaders);
}

module.exports = { pendingStages, outsideStages, passedStages, blockedStages, blockReadiness, expireReadiness, probeHint, handleReadinessConfirm };
