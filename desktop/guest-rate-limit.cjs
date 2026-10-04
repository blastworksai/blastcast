// Per-credential request buckets (ClaudeBWAI, rate limit per credential). Window 10 s. Numbers: the old shared pools
// (1000 other per 10 s) divided by MAX_GUESTS and rounded up; chunks keep the old 3000 per credential.
// Unauthenticated traffic shares one small pre-auth bucket and can never take from a guest's bucket.
// Split out of guests.cjs (no behaviour change). Pure apart from the injected clock and admission store.
const { MAX_GUESTS } = require('./admission.cjs');
const { SESSION_RE } = require('./guest-http.cjs');

const RATE_WINDOW_MS = 10_000;
const REST_PER_CREDENTIAL = Math.ceil(1000 / MAX_GUESTS);   // 143
const CHUNK_PER_CREDENTIAL = 3000;                          // unscaled: one guest's post-Stop drain may burst (see source-resilience test); already authenticated and serialised per session
const PRE_AUTH_LIMIT = 600;                                 // readiness/page loads for a full room fit; a flood does not

function createRateLimiter({ now = Date.now, store }) {
  const buckets = new Map();
  const preAuth = { at: 0, n: 0, cat: 0, cn: 0 };
  let lastSweep = 0;
  function tick(bucket, kind, limit) {
    const t = now();
    const [atKey, nKey] = kind === 'chunk' ? ['cat', 'cn'] : ['at', 'n'];
    if (t - bucket[atKey] >= RATE_WINDOW_MS) { bucket[atKey] = t; bucket[nKey] = 0; }
    bucket.last = t;
    return ++bucket[nKey] > limit;
  }
  function bucketFor(key) {
    let b = buckets.get(key);
    if (!b) { b = { at: 0, n: 0, cat: 0, cn: 0, last: now() }; buckets.set(key, b); }
    return b;
  }
  // Inactive buckets (no request for a full window) are dropped, so memory is bounded by live credentials.
  function sweep() {
    const t = now();
    if (t - lastSweep < RATE_WINDOW_MS) return;
    lastSweep = t;
    for (const [key, b] of buckets) if (t - b.last >= RATE_WINDOW_MS) buckets.delete(key);
  }
  function credentialKey(request) {
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!SESSION_RE.test(token)) return null;
    if (request.method === 'POST' && request.url === '/api/redeem') return store.inviteIsLive(token) ? `i:${token}` : null;
    if (request.method !== 'POST' || !request.url.startsWith('/api/')) return null;
    const st = store.guestStatus(token);
    return st.ok ? `s:${st.sessionId}` : null;
  }
  /** True when this request is over its limit. Counted only AFTER the Host check. */
  function isOver(request) {
    const sourceChunk = request.method === 'POST' && request.url === '/api/source/chunk';
    sweep();
    const limitKey = credentialKey(request);
    if (limitKey) return sourceChunk ? tick(bucketFor(limitKey), 'chunk', CHUNK_PER_CREDENTIAL) : tick(bucketFor(limitKey), 'rest', REST_PER_CREDENTIAL);
    return tick(preAuth, 'rest', PRE_AUTH_LIMIT);
  }
  return { isOver, forget: key => buckets.delete(key), clear: () => buckets.clear() };
}

module.exports = { createRateLimiter, RATE_WINDOW_MS, REST_PER_CREDENTIAL, CHUNK_PER_CREDENTIAL, PRE_AUTH_LIMIT };
