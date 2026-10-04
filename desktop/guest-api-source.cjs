// /api/source/* routes (original-recording status, begin, chunk upload, finish). Split out of guests.cjs (no behaviour change).
// Each handler takes (ctx, request, response, call) where call = { token, participantId, body, current }.
const { headers, send, rawBody } = require('./guest-http.cjs');

const RETRY_HEADERS = { ...headers, 'Retry-After': '1' };

function sourceStatus(ctx, request, response, { participantId, body }) {
  const { sources, originalsUnsupported } = ctx;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length > 1 || (bodyKeys.length === 1 && (bodyKeys[0] !== 'originalsUnsupported' || typeof body.originalsUnsupported !== 'boolean'))) { send(response, 400, { message: 'Invalid request.' }); return; }
  if (bodyKeys.length === 1) { if (body.originalsUnsupported) originalsUnsupported.add(participantId); else originalsUnsupported.delete(participantId); }
  const status = sources.status();
  if (!status || !status.episodeId) {
    send(response, 200, { ok: true, episode: null, source: null }); return;
  }
  const s = status.sources.find(x => x.participantId === participantId);
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
  send(response, 200, { ok: true, episode: { episodeId: status.episodeId, phase: status.phase, participantId,
    hostNowMs: status.hostNowMs,eligible,...(recoveryKey ? { recoveryKey } : {}) }, source: ownSource });
}

async function sourceBegin(ctx, request, response, { participantId, body }) {
  const res = await ctx.sources.beginSource(participantId, body);
  if (!res.ok) send(response, res.gone ? 410 : 400, { message: res.message });
  else send(response, 200, res);
}

// Validate the chunk request headers; returns the parsed metadata, or null after answering 400.
function chunkMetadata(request, response) {
  if (request.headers['content-type'] !== 'application/octet-stream') { request.resume(); send(response, 400, { message: 'Invalid request.' }); return null; }
  const metaHeader = request.headers['x-blastcast-source'];
  if (!metaHeader || Buffer.byteLength(metaHeader, 'utf8') > 2048) { request.resume(); send(response, 400, { message: 'Invalid request.' }); return null; }
  let metadata;
  try { metadata = JSON.parse(metaHeader); if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('json'); }
  catch { request.resume(); send(response, 400, { message: 'Invalid request.' }); return null; }
  return metadata;
}

const stillAdmitted = (ctx, token, current) => {
  const a2 = ctx.store.guestStatus(token);
  return !(ctx.state.generation !== current || !ctx.state.verified || !a2.ok || a2.phase !== 'admitted');
};

async function sourceChunk(ctx, request, response, { token, participantId, current }) {
  const { activeUploads, sources, state } = ctx;
  const metadata = chunkMetadata(request, response);
  if (!metadata) return;

  if (activeUploads.has(participantId)) { request.resume(); send(response, 409, { message: 'Concurrent chunk upload not allowed.' }, 'application/json', RETRY_HEADERS); return; }
  const upload = {};
  activeUploads.set(participantId, upload);
  const releaseUpload = () => {
    if (activeUploads.get(participantId) === upload) activeUploads.delete(participantId);
  };
  // The slot is held until the write settles, not until the connection closes: a retry while the
  // previous chunk is still being written gets a retryable 409, never a spurious failure.
  let didComplete = false;
  request.extendDeadline?.(30_000);
  try {
    const chunkBuffer = await rawBody(request, 8 * 1024 * 1024);
    if (!stillAdmitted(ctx, token, current)) { didComplete = true; send(response, 410, { message: 'This guest session is closed.' }); return; }
    const res = await sources.appendSource(participantId, metadata, chunkBuffer);
    didComplete = true;
    if (response.destroyed) return;
    if (res.ok) send(response, 200, res);
    else if (res.busy) send(response, 409, { message: res.message }, 'application/json', RETRY_HEADERS);
    else send(response, res.gone ? 410 : 400, { message: res.message });
  } catch (err) {
    if (!didComplete && !response.destroyed) {
      send(response, err.message === 'timeout' ? 408 : 400, { message: err.message === 'timeout' ? 'Upload timeout.' : 'Invalid chunk request.' });
    }
  } finally {
    releaseUpload();
  }
}

async function sourceFinish(ctx, request, response, { token, participantId, body, current }) {
  if (!stillAdmitted(ctx, token, current)) { send(response, 410, { message: 'This guest session is closed.' }); return; }
  request.extendDeadline?.(120_000);
  try {
    const res = await ctx.sources.finishSource(participantId, body);
    if (response.destroyed) return;
    if (!res.ok) send(response, 400, { message: res.message });
    else send(response, 200, res);
  } catch (err) {
    if (!response.destroyed) send(response, 400, { message: 'Finalization timeout or error.' });
  }
}

const sourceRoutes = {
  '/api/source/status': sourceStatus,
  '/api/source/begin': sourceBegin,
  '/api/source/chunk': sourceChunk,
  '/api/source/finish': sourceFinish,
};

module.exports = { sourceRoutes, sourceStatus, sourceBegin, sourceChunk, sourceFinish };
