// Lifecycle of the guest server: HTTP listener, state reset, stop and configure. Split out of guests.cjs (no behaviour change).
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { digest, send } = require('./guest-http.cjs');
const { parseRoute } = require('./guest-route.cjs');
const { pendingStages, outsideStages, blockReadiness, probeHint } = require('./guest-readiness.cjs');
const { status } = require('./guest-status.cjs');

async function clearState(ctx) {
  const st = ctx.state;
  st.generation++;
  const myController = st.controller;
  st.controller = null;
  myController?.abort();
  st.verified = false; st.route = null; st.phase = 'off'; st.readiness = null; ctx.limiter.clear();
  st.readinessToken = ''; st.readinessDigest = null; st.readinessDeadline = 0;
  st.nonce = ''; st.proof = ''; st.latest = null; ctx.opened.clear(); ctx.store.revokeAll(); ctx.signaling.pruneAll(); ctx.presence.clear(); ctx.sourceInFlight.clear(); ctx.originalsUnsupported.clear();
  const active = st.server; st.server = null;
  if (active) {
    active.closeAllConnections();
    await new Promise(resolve => active.close(resolve));
  }
}

async function stop(ctx) {
  ctx.state.configuring = null;
  await clearState(ctx);
}

function createHttpServer(handle) {
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
  return myServer;
}

// Begin the outside check once the listener is bound and the origin is final.
function startOutsideCheck(ctx, next, myController, myNonce, myProof) {
  const st = ctx.state;
  st.controller = myController;
  st.nonce = myNonce;
  st.proof = myProof;
  st.readinessToken = randomBytes(32).toString('base64url');
  st.readinessDigest = digest(st.readinessToken);
  st.readinessDeadline = ctx.monotonicNow() + 600_000;
  st.phase = 'outside-check';
  st.readiness = {
    routeType: next.routeType,
    stages: outsideStages(),
    check: { url: `${next.origin}/readiness#check=${st.readinessToken}`, expiresAt: ctx.now() + 600_000 },
    hint: null,
    diagnosis: null,
  };
  st.configuring = null;
  const probeGeneration = st.generation;
  void Promise.resolve().then(() => ctx.probe(next.origin, myNonce, myProof, myController.signal)).then(() => {
    if (st.generation === probeGeneration && st.route === next) { st.nonce = ''; st.proof = ''; }
  }, error => {
    if (st.generation === probeGeneration && st.route === next && st.readiness) {
      st.nonce = ''; st.proof = '';
      st.readiness = { ...st.readiness, hint: probeHint(error) };
    }
  });
}

async function configure(ctx, input, acquireOrigin) {
  const st = ctx.state;
  if (st.configuring) return { ok: false, message: 'Configuration already in progress.' };
  let next;
  try { next = parseRoute(input); } catch (error) { return { ok: false, message: error.message }; }

  const attempt = {};
  st.configuring = attempt;
  await clearState(ctx);

  if (st.configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };

  st.route = next;
  st.phase = 'checking';
  st.readiness = { routeType: next.routeType, stages: pendingStages(), check: null, hint: null, diagnosis: null };

  try {
    const myNonce = randomBytes(32).toString('base64url');
    const myProof = randomBytes(32).toString('base64url');
    const myController = new AbortController();
    const myServer = createHttpServer(ctx.handle);

    await new Promise((resolve, reject) => {
      myServer.once('error', reject);
      myServer.listen(next.port, '127.0.0.1', resolve);
    });

    if (st.configuring !== attempt) {
      myServer.closeAllConnections();
      myServer.close();
      return { ok: false, message: 'Connection check was cancelled.' };
    }

    st.server = myServer;
    // Bind first: a generated tunnel must never expose another process that
    // happened to own this port. Requests remain rejected during acquisition.
    if (acquireOrigin) {
      const generatedOrigin = await acquireOrigin(next.port);
      if (st.configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };
      next = parseRoute({ ...input, origin: generatedOrigin });
      st.route = next;
    }
    startOutsideCheck(ctx, next, myController, myNonce, myProof);
    return status(ctx);
  } catch (error) {
    if (st.configuring !== attempt) return { ok: false, message: 'Connection check was cancelled.' };
    st.configuring = null;
    if (error.code === 'EADDRINUSE') {
      blockReadiness(ctx, 'LOCAL_PORT_BUSY');
      return status(ctx);
    }
    await clearState(ctx);
    return { ok: false, message: 'Could not start the local guest server.' };
  }
}

module.exports = { clearState, stop, createHttpServer, configure };
