const http = require('node:http');
const https = require('node:https');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAdmissionStore, MAX_GUESTS } = require('./admission.cjs');
const { createSignalingBroker } = require('./signaling.cjs');
const { parseHelper } = require('./relay-config.cjs');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REDEEMPTION_KEY = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const assets = new Map([
  ['/', ['guest.html', 'text/html; charset=utf-8']],
  ['/guest.js', ['guest.js', 'text/javascript']],
  ['/camera-background.js', ['camera-background.js', 'text/javascript']],
  ['/preview.js', ['preview.js', 'text/javascript']],
  ['/guest-call.js', ['guest-call.js', 'text/javascript']],
  ['/screen-share.js', ['screen-share.js', 'text/javascript']],
  ['/device-access.js', ['device-access.js', 'text/javascript']],
  ['/peer-call.js', ['peer-call.js', 'text/javascript']],
  ['/guest.css', ['guest.css', 'text/css']],
  ['/Blastworks-Cast-256.png', ['Blastworks-Cast-256.png', 'image/png']],
  ['/source-protocol.js', ['source-protocol.js', 'text/javascript']],
  ['/source-capture.js', ['source-capture.js', 'text/javascript']],
  ['/source-outbox.js', ['source-outbox.js', 'text/javascript']],
  ['/source-session.js', ['source-session.js', 'text/javascript']],
  ['/source-recovery.js', ['source-recovery.js', 'text/javascript']],
  ['/bodypix/tf.min.js', ['bodypix/tf.min.js', 'text/javascript']],
  ['/bodypix/body-pix.min.js', ['bodypix/body-pix.min.js', 'text/javascript']],
  ['/bodypix/model-stride16.json', ['bodypix/model-stride16.json', 'application/json']],
  ['/bodypix/group1-shard1of1.bin', ['bodypix/group1-shard1of1.bin', 'application/octet-stream']],
  ['/bodypix/NOTICE.txt', ['bodypix/NOTICE.txt', 'text/plain; charset=utf-8']],
]);
const readinessAssets = new Map([
  ['/readiness', ['readiness.html', 'text/html; charset=utf-8']],
  ['/readiness.js', ['readiness.js', 'text/javascript']],
  ['/readiness.css', ['readiness.css', 'text/css']],
]);
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
};
const readinessHeaders = {
  ...headers,
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), display-capture=()',
};

const pendingStages = () => ({ listener: 'pending', address: 'pending', https: 'pending', route: 'pending', outside: 'pending' });
const outsideStages = () => ({ listener: 'passed', address: 'pending', https: 'pending', route: 'pending', outside: 'pending' });
const passedStages = () => ({ listener: 'passed', address: 'passed', https: 'passed', route: 'passed', outside: 'passed' });
const blockedStages = listener => ({ listener, address: 'not-proven', https: 'not-proven', route: 'not-proven', outside: 'failed' });
function digest(value) { return createHash('sha256').update(value).digest(); }

function parseRoute(input) {
  if (!input || typeof input !== 'object' || !['origin,port,routeType', 'helper,origin,port,routeType'].includes(Object.keys(input).sort().join()) ||
      typeof input.origin !== 'string' || input.origin.length > 300 ||
      !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('Enter an HTTPS address and a local port from 1024 to 65535.');
  if (input.routeType !== 'direct' && input.routeType !== 'tunnel') throw new Error('Choose direct forwarding or an HTTPS tunnel/provider as the route type.');
  let url;
  try { url = new URL(input.origin); } catch { throw new Error('Enter a valid HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use an HTTPS address without a path, password, query or fragment.');
  const helper = parseHelper(input.helper);
  if (helper && input.routeType !== 'tunnel') throw new Error('A helper requires the HTTPS tunnel route.');
  return { origin: url.origin, host: url.host, port: input.port, routeType: input.routeType, ...(helper ? { helper } : {}) };
}

function routeError(code, message) { const error = new Error(message); error.code = code; return error; }

function createRouteVerifier({ ca } = {}) {
  return function verifyRoute(origin, nonce, proof, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const options = { signal, agent: false, ...(ca === undefined ? {} : { ca }) };
    const request = https.get(`${origin}/route-check/${nonce}`, options, response => {
      let body = '';
      if (response.statusCode !== 200) { response.resume(); request.destroy(routeError('HOST_ROUTE_MISMATCH', 'Guest address did not return the route check.')); return; }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 256) request.destroy(routeError('HOST_ROUTE_MISMATCH', 'Unexpected route-check response.'));
      });
      response.on('error', reject);
      response.on('end', () => body === proof ? resolve() : reject(routeError('HOST_ROUTE_MISMATCH', 'Guest address points somewhere else.')));
    });
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    timer = setTimeout(() => request.destroy(routeError('HOST_ROUTE_UNREACHABLE', 'Guest address did not answer in time.')), 5000);
  });
  };
}
const verifyRoute = createRouteVerifier();

function send(response, status, value, mime = 'application/json', policy = headers) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { ...policy, 'Content-Type': mime });
  response.end(mime === 'application/json' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
}
function jsonBody(request, limit = 2048) {
  return new Promise((resolve, reject) => {
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) { reject(new Error('json')); request.resume(); return; }
    let size = 0; const chunks = [];
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); reject(new Error('size')); request.destroy(); }
      else chunks.push(chunk);
    };
    const onError = err => { cleanup(); reject(err); };
    const onEnd = () => {
      cleanup();
      try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('json'); resolve(body); }
      catch { reject(new Error('json')); }
    };
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('error', onError);
      request.removeListener('end', onEnd);
    };
    request.on('data', onData);
    request.on('error', onError);
    request.on('end', onEnd);
  });
}


function rawBody(request, limit) {
  return new Promise((resolve, reject) => {
    if (request.headers['content-encoding']) { reject(new Error('encoding')); request.resume(); return; }
    const cl = request.headers['content-length'];
    if (!cl || !/^[1-9][0-9]*$/.test(cl)) { reject(new Error('length')); request.resume(); return; }
    const expected = parseInt(cl, 10);
    if (expected > limit) { reject(new Error('limit')); request.resume(); return; }
    
    let size = 0; const chunks = [];
    const onData = chunk => {
      size += chunk.length;
      if (size > limit || size > expected) { cleanup(); reject(new Error('size')); request.destroy(); }
      else chunks.push(chunk);
    };
    const onError = err => { cleanup(); reject(err); };
    const onEnd = () => {
      cleanup();
      if (size !== expected) reject(new Error('mismatch'));
      else {
        const buf = Buffer.concat(chunks);
        resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + expected));
      }
    };
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('error', onError);
      request.removeListener('end', onEnd);
    };
    request.on('data', onData);
    request.on('error', onError);
    request.on('end', onEnd);
  });
}

function createGuestServer({ directory, now = Date.now, monotonicNow = () => performance.now(), probe = verifyRoute, sources = null } = {}) {
  let server = null, route = null, verified = false, generation = 0, phase = 'off', readiness = null;
  let controller = null, nonce = '', proof = '', latest = null;
  let readinessToken = '', readinessDigest = null, readinessDeadline = 0;
  let budgetAt = 0, budget = 0;
  let configuring = null;
  // CodexBWAI: connection lifetime and storage lifetime can end independently.
  const activeUploads = new Map();
  const store = createAdmissionStore({ now });
  const signaling = createSignalingBroker(store);

  function blockReadiness(code) {
    if (!route) return;
    const messages = {
      LOCAL_PORT_BUSY: 'That local port is in use. Choose another port and update your HTTPS route.',
      OUTSIDE_CHECK_EXPIRED: 'The outside-network check expired. Start a new check when the other device is ready.',
      DIRECT_OUTSIDE_UNREACHABLE: 'The outside check did not reach BlastCast. Firewall or forwarding, an unsupported mapping, or CGNAT may be the cause; BlastCast cannot distinguish these from inside this network. No automatic retry was started.',
      PROVIDER_OUTSIDE_UNREACHABLE: 'The HTTPS tunnel/provider route was not verified. This check does not provide TURN or prove media reachability. No automatic retry was started.',
    };
    phase = 'blocked'; verified = false; latest = null; store.revokeAll();
    readinessToken = ''; readinessDigest = null; readinessDeadline = 0;
    readiness = {
      routeType: route.routeType,
      stages: blockedStages(code === 'LOCAL_PORT_BUSY' ? 'failed' : 'passed'),
      check: null,
      hint: code === 'LOCAL_PORT_BUSY' ? null : readiness?.hint ?? null,
      diagnosis: { code, message: messages[code] },
    };
  }

  function expireReadiness() {
    if (readinessDeadline <= 0 || monotonicNow() < readinessDeadline) return false;
    if (phase === 'outside-check') blockReadiness('OUTSIDE_CHECK_EXPIRED');
    else if (phase === 'ready') { readinessDigest = null; readinessDeadline = 0; readinessToken = ''; readiness = { ...readiness, check: null }; }
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

  async function handle(request, response) {
    if (now() - budgetAt >= 10_000) { budgetAt = now(); budget = 0; }
    if (++budget > 1000) { request.resume(); send(response, 429, { message: 'Too many requests. Wait a moment and retry.' }); return; }
    const current = generation;
    if (!route || request.headers.host !== route.host) { request.resume(); send(response, 403, { message: 'Wrong guest address.' }); return; }
    if (request.method === 'GET' && nonce && request.url === `/route-check/${nonce}`) {
      send(response, 200, proof, 'text/plain'); return;
    }
    if (request.method === 'GET' && readinessAssets.has(request.url) && (phase === 'outside-check' || (phase === 'ready' && readinessDigest))) {
      const [file, mime] = readinessAssets.get(request.url);
      try { const bytes = await fs.readFile(path.join(directory, file)); send(response, 200, bytes, mime, readinessHeaders); }
      catch { send(response, 503, { message: 'Readiness page unavailable. Ask the host to rebuild BlastCast.' }, 'application/json', readinessHeaders); }
      return;
    }
    if (request.method === 'POST' && request.url === '/api/readiness/confirm') {
      const beforeGeneration = generation;
      if (request.headers.origin !== route.origin) { request.resume(); send(response, 403, { message: 'Open the readiness link at the host’s secure address.' }, 'application/json', readinessHeaders); return; }
      expireReadiness();
      if ((phase !== 'outside-check' && phase !== 'ready') || !readinessDigest || readinessDeadline <= 0) {
        request.resume(); send(response, 410, { message: 'This readiness check is closed.' }, 'application/json', readinessHeaders); return;
      }
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const candidate = TOKEN.test(token) ? digest(token) : Buffer.alloc(32);
      if (!timingSafeEqual(candidate, readinessDigest)) { request.resume(); send(response, 410, { message: 'This readiness check is closed.' }, 'application/json', readinessHeaders); return; }
      let body;
      try { body = await jsonBody(request, 256); } catch { if (!response.destroyed) send(response, 400, { message: 'Invalid readiness confirmation.' }, 'application/json', readinessHeaders); return; }
      expireReadiness();
      if (generation !== beforeGeneration || (phase !== 'outside-check' && phase !== 'ready') || !readinessDigest || readinessDeadline <= 0 ||
          Object.keys(body).sort().join() !== 'outsideNetwork,secureWithoutBypass' || body.outsideNetwork !== true || body.secureWithoutBypass !== true) {
        send(response, generation !== beforeGeneration || phase === 'blocked' ? 410 : 400,
          { message: generation !== beforeGeneration || phase === 'blocked' ? 'This readiness check is closed.' : 'Confirm both readiness statements.' },
          'application/json', readinessHeaders); return;
      }
      if (phase === 'outside-check' || readiness.stages.outside !== 'passed') {
        phase = 'ready'; verified = true; readinessToken = '';
        readiness = { ...readiness, stages: passedStages(), check: null, diagnosis: null };
      }
      send(response, 200, { ok: true, phase: 'ready' }, 'application/json', readinessHeaders); return;
    }
    if (!verified) { request.resume(); send(response, 503, { message: 'The host is still checking the guest address.' }); return; }
    const assetUrl = new URL(request.url, 'http://guest.invalid');
    const modelQuery = assetUrl.pathname === '/bodypix/model-stride16.json' && assetUrl.search === '?tfjs-format=file';
    const assetPath = assetUrl.search === '' || modelQuery ? assetUrl.pathname : '';
    if (request.method === 'GET' && assets.has(assetPath)) {
      const [file, mime] = assets.get(assetPath);
      try { const bytes = await fs.readFile(path.join(directory, file)); send(response, 200, bytes, mime); }
      catch { send(response, 503, { message: 'Guest page unavailable. Ask the host to rebuild BlastCast.' }); }
      return;
    }

    const allowedPosts = ['/api/redeem', '/api/preview', '/api/join', '/api/status', '/api/leave', '/api/call/send', '/api/call/poll', '/api/call/config', '/api/source/status', '/api/source/begin', '/api/source/chunk', '/api/source/finish'];
    if (request.method !== 'POST' || !allowedPosts.includes(request.url)) {
      request.resume(); send(response, 404, { message: 'Not found.' }); return;
    }
    if (request.headers.origin !== route.origin) { request.resume(); send(response, 403, { message: 'Open your invitation at the host’s secure address.' }); return; }

    const authHeader = request.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let body;
    // A64KiB SDP can expand sixfold in JSON escapes; keep the wire body bounded
    // separately from the decoded SDP/candidate limits in the broker.
    if (request.url.startsWith('/api/call/') || request.url.startsWith('/api/source/')) {
      const authorized = SESSION_RE.test(token) && store.guestStatus(token);
      if (!authorized || !authorized.ok) { request.resume(); send(response, 410, { message: 'This guest session is closed.' }); return; }
      if (authorized.phase !== 'admitted') { request.resume(); send(response, 400, { message: 'Not admitted.' }); return; }
      if (request.url.startsWith('/api/source/') && !sources) { request.resume(); send(response, 503, { message: 'Sources not configured.' }); return; }
    }
    const isSourceChunk = request.url === '/api/source/chunk';
    if (!isSourceChunk) {
      const bodyLimit = request.url === '/api/call/send' ? 400 * 1024 : 2048;
      try { body = await jsonBody(request, bodyLimit); } catch { if (!response.destroyed) send(response, 400, { message: 'Invalid request.' }); return; }
    }

    if (generation !== current || !verified) { send(response, 410, { message: 'This invitation is closed.' }); return; }

    if (request.url === '/api/redeem') {
      if (!TOKEN.test(token)) { send(response, 410, { message: 'Invalid invitation token.' }); return; }
      if (!body || typeof body.redemptionKey !== 'string' || !REDEEMPTION_KEY.test(body.redemptionKey) || Object.keys(body).length !== 1) {
        send(response, 400, { message: 'Invalid redemption request.' }); return;
      }
      const res = store.redeemInvitation(token, body.redemptionKey);
      if (!res.ok) { send(response, 410, { message: res.message }); return; }
      send(response, 200, { ok: true, phase: 'redeemed', sessionCredential: res.sessionCredential, expiresAt: res.expiresAt });
      return;
    }

    // For all other endpoints, 'token' is actually the sessionCredential
    if (!SESSION_RE.test(token)) { send(response, 410, { message: 'Invalid session credential.' }); return; }

    const statusRes = store.guestStatus(token);
    if (!statusRes.ok) { send(response, 410, { message: statusRes.message }); return; }
    const { phase: guestPhase, expiresAt } = statusRes;

    if (request.url.startsWith('/api/source/') && guestPhase !== 'admitted') {
      request.resume(); send(response, 410, { message: 'This guest session is closed.' }); return;
    }

    const participantId = statusRes.sessionId;

    if (request.url === '/api/source/status') {
      if (Object.keys(body).length > 0) { send(response, 400, { message: 'Invalid request.' }); return; }
      const sourceStatus = sources.status();
      if (!sourceStatus || !sourceStatus.episodeId) {
        send(response, 200, { ok: true, episode: null, source: null }); return;
      }
      const s = sourceStatus.sources.find(x => x.participantId === participantId);
      const eligible = !!s;
      const ownSource = s ? {
        participantId: s.participantId,
        label: s.label,
        phase: s.phase,
        epochs: s.epochs.map(e => ({ epochId: e.epochId, phase: e.phase, bytes: e.bytes, chunks: e.chunks })),
        bytes: s.bytes,
        message: s.message
      } : null;
      const recoveryKey = eligible && typeof sources.recoveryKey === 'function' ? sources.recoveryKey(participantId) : null;
      send(response, 200, { ok: true, episode: { episodeId: sourceStatus.episodeId, phase: sourceStatus.phase, participantId,
        hostNowMs: sourceStatus.hostNowMs,eligible,...(recoveryKey ? { recoveryKey } : {}) }, source: ownSource });
      return;
    }

    if (request.url === '/api/source/begin') {
      const res = await sources.beginSource(participantId, body);
      if (!res.ok) send(response, 400, { message: res.message });
      else send(response, 200, res);
      return;
    }

    if (request.url === '/api/source/chunk') {
      if (request.headers['content-type'] !== 'application/octet-stream') { request.resume(); send(response, 400, { message: 'Invalid request.' }); return; }
      const metaHeader = request.headers['x-blastcast-source'];
      if (!metaHeader || Buffer.byteLength(metaHeader, 'utf8') > 2048) { request.resume(); send(response, 400, { message: 'Invalid request.' }); return; }
      let metadata;
      try { metadata = JSON.parse(metaHeader); if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('json'); }
      catch { request.resume(); send(response, 400, { message: 'Invalid request.' }); return; }
      
      if (activeUploads.has(participantId)) { request.resume(); send(response, 409, { message: 'Concurrent chunk upload not allowed.' }); return; }
      const upload = {};
      activeUploads.set(participantId, upload);
      const releaseUpload = () => {
        if (activeUploads.get(participantId) === upload) activeUploads.delete(participantId);
      };
      response.once('close', releaseUpload);
      let didComplete = false;
      request.extendDeadline?.(30_000);
      try {
        const chunkBuffer = await rawBody(request, 8 * 1024 * 1024);
        const a2 = store.guestStatus(token);
        if (generation !== current || !verified || !a2.ok || a2.phase !== 'admitted') { didComplete = true; send(response, 410, { message: 'This guest session is closed.' }); return; }
        const res = await sources.appendSource(participantId, metadata, chunkBuffer);
        didComplete = true;
        if (response.destroyed) return;
        if (!res.ok) send(response, 400, { message: res.message });
        else send(response, 200, res);
      } catch (err) {
        if (!didComplete && !response.destroyed) {
            send(response, err.message === 'timeout' ? 408 : 400, { message: err.message === 'timeout' ? 'Upload timeout.' : 'Invalid chunk request.' });
        }
      } finally {
        response.removeListener('close', releaseUpload);
        releaseUpload();
      }
      return;
    }

    if (request.url === '/api/source/finish') {
      const a2 = store.guestStatus(token);
      if (generation !== current || !verified || !a2.ok || a2.phase !== 'admitted') { send(response, 410, { message: 'This guest session is closed.' }); return; }
      request.extendDeadline?.(120_000);
      try {
        const res = await sources.finishSource(participantId, body);
        if (response.destroyed) return;
        if (!res.ok) send(response, 400, { message: res.message });
        else send(response, 200, res);
      } catch (err) {
        if (!response.destroyed) send(response, 400, { message: 'Finalization timeout or error.' });
      }
      return;
    }


    if (request.url === '/api/join') {
      const joinRes = store.requestJoin(token, body);
      signaling.pruneAll();
      if (!joinRes.ok) { send(response, joinRes.code === 'CONFLICT' ? 409 : 400, { message: joinRes.message }); return; }
      send(response, 200, { ok: true, phase: joinRes.phase, expiresAt });
      return;
    }

    if (request.url === '/api/leave') {
      if (Object.keys(body).length > 0) { send(response, 400, { message: 'Invalid request.' }); return; }
      store.leaveSession(token);
      signaling.pruneAll();
      send(response, 200, { ok: true, phase: 'left' });
      return;
    }

    if (request.url === '/api/call/config') {
      if (Object.keys(body).length) { send(response, 400, { message: 'Invalid request.' }); return; }
      // Recheck after the asynchronous request body: removal/expiry can race it.
      const admitted = store.guestStatus(token);
      if (!admitted.ok || admitted.phase !== 'admitted') { send(response, 410, { message: 'Guest session is closed.' }); return; }
      send(response, 200, callConfiguration(admitted.sessionId));
      return;
    }

    if (request.url === '/api/call/send') {
      if (Object.keys(body).length !== 2 || !('callId' in body) || !('message' in body)) {
        send(response, 400, { message: 'Invalid request.' }); return;
      }
      const res = signaling.guestSend(token, body.callId, body.message);
      if (!res.ok) { send(response, 400, { message: res.message }); return; }
      send(response, 200, { ok: true });
      return;
    }

    if (request.url === '/api/call/poll') {
      if (Object.keys(body).length !== 2 || !('callId' in body) || !('after' in body)) {
        send(response, 400, { message: 'Invalid request.' }); return;
      }
      const res = signaling.guestPoll(token, body.callId, body.after);
      if (!res.ok) { send(response, 400, { message: res.message }); return; }
      send(response, 200, res);
      return;
    }

    // For status and preview, we just return the current phase
    if (Object.keys(body).length > 0) { send(response, 400, { message: 'Invalid request.' }); return; }
    send(response, 200, { ok: true, phase: guestPhase, expiresAt });
  }

  async function _clearState() {
    generation++;
    const myController = controller;
    controller = null;
    myController?.abort();
    verified = false; route = null; phase = 'off'; readiness = null;
    readinessToken = ''; readinessDigest = null; readinessDeadline = 0;
    nonce = ''; proof = ''; latest = null; store.revokeAll(); signaling.pruneAll();
    const active = server; server = null;
    if (active) {
       active.closeAllConnections();
       await new Promise(resolve => active.close(resolve));
    }
  }

  async function stop() {
    configuring = null;
    await _clearState();
  }

  function status() {
    expireReadiness();
    signaling.pruneAll();
    const listRes = store.hostList();
    const guests = listRes.guests.map(g => {
      if (!g.alive && g.phase === 'redeemed') {
        g.phase = g.revoked ? 'revoked' : 'expired';
      }
      return g;
    });
    if (latest) {
      const g = guests.find(x => x.id === latest.id);
      if (!g || !g.alive || ['left', 'removed', 'rejected', 'revoked', 'expired'].includes(g.phase)) latest = null;
    }
    return {
      ok: true,
      phase,
      origin: route?.origin ?? '',
      port: route?.port ?? null,
      helper: route?.helper ? { provider: route.helper.provider, iceTransportPolicy: route.helper.iceTransportPolicy, quota: 'unknown' } : null,
      readiness: readiness ? {
        routeType: readiness.routeType,
        stages: { ...readiness.stages },
        check: readiness.check ? { ...readiness.check } : null,
        hint: readiness.hint ? { ...readiness.hint } : null,
        diagnosis: readiness.diagnosis ? { ...readiness.diagnosis } : null,
      } : null,
      invite: latest ? { url: `${route.origin}/#invite=${latest.token}`, expiresAt: latest.expiresAt } : null,
      guests
    };
  }

  function callConfiguration(sessionId) {
    if (!verified || phase !== 'ready' || !store.isSessionAdmitted(sessionId))
      return { ok: false, message: 'This guest is not admitted on the current route.' };
    const helper = route?.helper;
    return { ok: true, iceServers: helper ? structuredClone(helper.iceServers) : [],
      iceTransportPolicy: helper?.iceTransportPolicy ?? 'all' };
  }

  return {
    status,
    stop,
    callConfiguration,
    async configure(input, acquireOrigin) {
      if (configuring) return { ok: false, message: 'Configuration already in progress.' };
      let next;
      try { next = parseRoute(input); } catch (error) { return { ok: false, message: error.message }; }

      const attempt = {};
      configuring = attempt;
      await _clearState();

      if (configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };

      route = next;
      phase = 'checking';
      readiness = { routeType: next.routeType, stages: pendingStages(), check: null, hint: null, diagnosis: null };

      try {
        const myNonce = randomBytes(32).toString('base64url');
        const myProof = randomBytes(32).toString('base64url');
        const myController = new AbortController();
        const myServer = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 5000 }, (req, res) => {
          // Destroy both sides without emitting an unhandled error after body listeners detach.
          const expire = () => { req.destroy(); res.destroy(); };
          let socketTimer = setTimeout(expire, 5000);
          req.socket.setTimeout(5000);
          req.extendDeadline = (ms) => {
            clearTimeout(socketTimer);
            socketTimer = setTimeout(expire, ms);
            req.socket.setTimeout(ms);
          };
          res.on('finish', () => clearTimeout(socketTimer));
          res.on('close', () => clearTimeout(socketTimer));
          void handle(req, res).catch((err) => { 
              clearTimeout(socketTimer);
              if (!res.headersSent && !res.destroyed) send(res, 500, { message: 'Guest request failed. Try again.' }); 
              else res.destroy(); 
          });
        });
        myServer.maxConnections = 32; myServer.keepAliveTimeout = 1000; myServer.maxRequestsPerSocket = 100;
        myServer.setTimeout(5000, socket => socket.destroy());

        await new Promise((resolve, reject) => {
          myServer.once('error', reject);
          myServer.listen(next.port, '127.0.0.1', resolve);
        });

        if (configuring !== attempt) {
          myServer.closeAllConnections();
          myServer.close();
          return { ok: false, message: 'Connection check was cancelled.' };
        }

        server = myServer;
        // Bind first: a generated tunnel must never expose another process that
        // happened to own this port. Requests remain rejected during acquisition.
        if (acquireOrigin) {
          const generatedOrigin = await acquireOrigin(next.port);
          if (configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };
          next = parseRoute({ ...input, origin: generatedOrigin });
          route = next;
        }
        controller = myController;
        nonce = myNonce;
        proof = myProof;
        readinessToken = randomBytes(32).toString('base64url');
        readinessDigest = digest(readinessToken);
        readinessDeadline = monotonicNow() + 600_000;
        phase = 'outside-check';
        readiness = {
          routeType: next.routeType,
          stages: outsideStages(),
          check: { url: `${next.origin}/readiness#check=${readinessToken}`, expiresAt: now() + 600_000 },
          hint: null,
          diagnosis: null,
        };
        configuring = null;
        const probeGeneration = generation;
        void Promise.resolve().then(() => probe(next.origin, myNonce, myProof, myController.signal)).then(() => {
          if (generation === probeGeneration && route === next) { nonce = ''; proof = ''; }
        }, error => {
          if (generation === probeGeneration && route === next && readiness) {
            nonce = ''; proof = '';
            readiness = { ...readiness, hint: probeHint(error) };
          }
        });
        return status();
      } catch (error) {
        if (configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };
        configuring = null;
        if (error.code === 'EADDRINUSE') {
          blockReadiness('LOCAL_PORT_BUSY');
          return status();
        }
        await _clearState();
        return { ok: false, message: 'Could not start the local guest server.' };
      }
    },
    failReadiness() {
      expireReadiness();
      if (phase !== 'outside-check' || !route) return { ok: false, message: 'There is no active outside-network check.' };
      blockReadiness(route.routeType === 'direct' ? 'DIRECT_OUTSIDE_UNREACHABLE' : 'PROVIDER_OUTSIDE_UNREACHABLE');
      return status();
    },
    // Internal saved-wizard path: acceptance is enabled, reachability is not asserted.
    enableSavedInvites() {
      expireReadiness();
      if (!route?.helper || !server || !['outside-check', 'ready'].includes(phase))
        return { ok: false, message: 'Start your saved guest connection again.' };
      verified = true; phase = 'ready';
      readiness = { ...readiness, stages: { ...readiness.stages, outside: readiness.stages.outside === 'passed' ? 'passed' : 'not-proven' } };
      return status();
    },
    invite() {
      expireReadiness();
      if (!verified || phase !== 'ready') return { ok: false, message: 'Complete the outside-network readiness check before creating an invitation.' };
      const res = store.createInvitation();
      if (!res.ok) return res;
      latest = res.invite;
      return status();
    },
    revoke() {
      store.revokeAll();
      latest = null;
      return status();
    },
    // Adding internal admission store access so boundary/IPC can call these:
    admit: (sessionId) => store.admitGuest(sessionId),
    reject: (sessionId) => store.rejectGuest(sessionId),
    remove: (sessionId) => store.removeGuest(sessionId),
    revokeInvite: (inviteId) => store.revokeInvitation(inviteId),
    sendSignal: signaling.sendGuestSignal,
    pollSignals: signaling.pollGuestSignals,
  };
}
module.exports = { createGuestServer, parseRoute, verifyRoute, createRouteVerifier, MAX_GUESTS };
