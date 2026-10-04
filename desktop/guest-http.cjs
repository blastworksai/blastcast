// Wire helpers shared by the guest server modules: response headers, send, bounded body readers, credential patterns.
// Split out of guests.cjs (no behaviour change).
const { createHash } = require('node:crypto');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REDEEMPTION_KEY = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
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

function digest(value) { return createHash('sha256').update(value).digest(); }

function send(response, status, value, mime = 'application/json', policy = headers) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { ...policy, 'Content-Type': mime });
  response.end(mime === 'application/json' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
}

function bearerToken(request) {
  const auth = request.headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
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

module.exports = { TOKEN, REDEEMPTION_KEY, SESSION_RE, headers, readinessHeaders, digest, send, bearerToken, jsonBody, rawBody };
