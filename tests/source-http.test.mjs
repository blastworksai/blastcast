import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { randomBytes } = require('node:crypto');
const { configureReady } = require('./helpers/network-readiness.cjs');

function freePort() {
  return new Promise(resolve => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, path, { token, origin, host, body, headers: customHeaders, bufferBody } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...customHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    if (host) headers.host = host;
    let payload;
    if (body !== undefined && !bufferBody) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    } else if (bufferBody) {
      payload = bufferBody;
      headers['content-length'] = payload.byteLength;
    }
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function createFakeSources(expectedId, hook = null) {
  let appendDelay = 0;
  return {
    setAppendDelay: (ms) => appendDelay = ms,
    recoveryKey: participantId => participantId === expectedId ? 'R'.repeat(43) : null,
    status: () => ({ episodeId: 'ep1', phase: 'recording', hostNowMs: Date.now(), sources: [{ participantId: expectedId, label: 'Guest', phase: 'recording', epochs: [], bytes: 0 }] }),
    beginSource: async (participantId, descriptor) => {
      if (participantId !== expectedId) return { ok: false, message: 'wrong participant' };
      return { ok: true, episodeId: descriptor.episodeId, epochId: descriptor.epochId };
    },
    appendSource: async (participantId, chunk, bytes) => {
      if (hook) hook();
      if (participantId !== expectedId) return { ok: false, message: 'wrong participant' };
      if (bytes.byteLength !== chunk.byteLength) return { ok: false, message: 'length mismatch' };
      if (appendDelay) await new Promise(r => setTimeout(r, appendDelay));
      return { ok: true, episodeId: chunk.episodeId, epochId: chunk.epochId, sequence: chunk.sequence, sha256: chunk.sha256, byteLength: chunk.byteLength };
    },
    finishSource: async (participantId, end) => {
      if (participantId !== expectedId) return { ok: false, message: 'wrong participant' };
      return { ok: true, episodeId: end.episodeId, epochId: end.epochId, name: 'file.webm', bytes: 100 };
    }
  };
}

async function setupAdmittedGuest(port, host, origin) {
  let expectedId = null;
  const sources = {
    status: () => ({ episodeId: 'ep1', phase: 'recording', hostNowMs: Date.now(), sources: [{ participantId: expectedId, label: 'Guest', phase: 'recording', epochs: [], bytes: 0 }] }),
    beginSource: async (participantId, descriptor) => ({ ok: true, episodeId: descriptor.episodeId, epochId: descriptor.epochId }),
    appendSource: async (participantId, chunk, bytes) => {
        if (participantId !== expectedId) return { ok: false, message: 'wrong participant' };
        if (bytes.byteLength !== chunk.byteLength) return {ok: false, message: 'length mismatch'};
        return { ok: true, episodeId: chunk.episodeId, epochId: chunk.epochId, sequence: chunk.sequence, sha256: chunk.sha256, byteLength: chunk.byteLength };
    },
    finishSource: async (participantId, end) => ({ ok: true, episodeId: end.episodeId, epochId: end.epochId, name: 'file.webm', bytes: 100 }),
    recoveryKey: participantId => participantId === expectedId ? 'R'.repeat(43) : null,
    setExpectedId: (id) => expectedId = id
  };
  const guests = createGuestServer({ directory: '/dev/null', probe: () => Promise.resolve(), sources });
  await configureReady(guests, { origin, port });
  
  const token = guests.invite().invite.url.split('#invite=')[1];
  const key = randomBytes(32).toString('base64url');
  
  const redeemed = await request(port, 'POST', '/api/redeem', { host, origin, token, body: { redemptionKey: key } });
  const session = redeemed.body.sessionCredential;
  
  await request(port, 'POST', '/api/join', { host, origin, token: session, body: { name: 'Alice', consent: true, consentVersion: '1' } });
  const id = guests.status().guests[0].session.id;
  guests.admit(id);
  sources.setExpectedId(id);
  
  return { guests, session, participantId: id, sources };
}

test('derived identity and status', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session, participantId } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const res = await request(port, 'POST', '/api/source/status', { host, origin, token: session, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.episode.episodeId, 'ep1');
  assert.equal(res.body.episode.participantId, participantId);
  assert.equal(res.body.episode.recoveryKey, 'R'.repeat(43));
  assert.equal(res.body.source.participantId, participantId);
});

test('chunk upload bounded and exact ACKs', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session, participantId } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  const bufferBody = Buffer.from('hello');
  
  const res = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody, headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.byteLength, 5);
});

test('malformed oversized content', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  
  const res = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, headers: {
      'content-type': 'application/octet-stream',
      'content-length': (8 * 1024 * 1024 + 1).toString(),
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  // Request won't send body since we didn't specify bufferBody, but wait, the length is tested on headers
  assert.equal(res.status, 400); // Because length exceeds limit
});

test('overlap is rejected 409 and slot is freed', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  let expectedId;
  let blockingResolver;
  const sources = {
    status: () => ({ episodeId: 'ep1', phase: 'recording', hostNowMs: Date.now(), sources: [{ participantId: expectedId, label: 'Guest', phase: 'recording', epochs: [], bytes: 0 }] }),
    beginSource: async () => ({ ok: true }),
    appendSource: async (participantId, chunk, bytes) => {
      if (blockingResolver) await new Promise(r => { const br = blockingResolver; blockingResolver = null; br(r); }); else return {ok:true, episodeId: chunk.episodeId, epochId: chunk.epochId, sequence: chunk.sequence, sha256: chunk.sha256, byteLength: chunk.byteLength};
      return { ok: true, episodeId: chunk.episodeId, epochId: chunk.epochId, sequence: chunk.sequence, sha256: chunk.sha256, byteLength: chunk.byteLength };
    },
    setExpectedId: (id) => expectedId = id
  };
  const guests = createGuestServer({ directory: '/dev/null', probe: () => Promise.resolve(), sources });
  await configureReady(guests, { origin, port });
  t.after(() => guests.stop());
  
  const token = guests.invite().invite.url.split('#invite=')[1];
  const redeemed = await request(port, 'POST', '/api/redeem', { host, origin, token, body: { redemptionKey: randomBytes(32).toString('base64url') } });
  const session = redeemed.body.sessionCredential;
  await request(port, 'POST', '/api/join', { host, origin, token: session, body: { name: 'Alice', consent: true, consentVersion: '1' } });
  const id = guests.status().guests[0].session.id;
  guests.admit(id);
  sources.setExpectedId(id);

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 1, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  
  let blockPromise = new Promise(r => blockingResolver = r);
  sources.appendSource = async (participantId, chunk, bytes) => {
    await blockPromise;
    return { ok: true, episodeId: chunk.episodeId, epochId: chunk.epochId, sequence: chunk.sequence, sha256: chunk.sha256, byteLength: chunk.byteLength };
  };
  // start first upload which blocks
  const firstReq = request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('a'), headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  // wait a bit for it to reach appendSource
  await new Promise(r => setTimeout(r, 50));
  
  const secondReq = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('b'), headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  assert.equal(secondReq.status, 409);
  
  blockingResolver();
  const firstRes = await firstReq;
  assert.equal(firstRes.status, 200);
  
  // Now slot should be free
  const thirdReq = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('c'), headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  assert.equal(thirdReq.status, 200);
});

test('revocation while reading body', async (t) => {
    // This is hard to test perfectly without chunked upload control, but we can revoke the session
    // after the headers but before the body finishes. The code checks after body upload.
    const port = await freePort();
    const host = 'test.example.com', origin = 'https://test.example.com';
    const { guests, session, participantId } = await setupAdmittedGuest(port, host, origin);
    t.after(() => guests.stop());

    const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
    
    // We send request manually
    const req = http.request({
        hostname: '127.0.0.1', port, method: 'POST', path: '/api/source/chunk',
        headers: {
            host, origin, authorization: `Bearer ${session}`,
            'content-type': 'application/octet-stream',
            'content-length': 5,
            'x-blastcast-source': JSON.stringify(chunkMeta)
        }
    });

    // Send part of the body
    req.write(Buffer.from('he'));

    // Revoke
    guests.revoke();

    // Send rest
    req.write(Buffer.from('llo'));
    req.end();

    const res = await new Promise((resolve) => {
        req.on('response', (response) => {
            let data = '';
            response.on('data', c => data += c);
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
        });
    });

    assert.equal(res.status, 410);
});

test('rejects Content-Encoding', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  
  const res = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('hello'), headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  assert.equal(res.status, 400); 
});

test('rejects malformed metadata schema', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = [{ bad: 'schema' }];
  
  const res = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('hello'), headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  assert.equal(res.status, 400);
});

test('no admin HTTP route (HTTP routes only for own session)', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const res = await request(port, 'POST', '/api/source/admin', { host, origin, token: session, body: {} });
  assert.equal(res.status, 404);
});

test('unauthenticated request with slow body times out after 5s', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const guests = createGuestServer({ directory: '/dev/null', probe: () => Promise.resolve() });
  await configureReady(guests, { origin, port });
  t.after(() => guests.stop());

  const start = Date.now();
  const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/api/redeem',
      headers: {
          host, origin,
          'content-type': 'application/json',
          'content-length': 100
      }
  });

  req.write('{"redemptionKey": "');
  
  const res = await new Promise((resolve) => {
      req.on('response', (response) => {
          resolve({ status: response.statusCode });
      });
      req.on('error', (err) => {
          resolve({ error: err.message });
      });
  });

  const duration = Date.now() - start;
  assert.ok(duration >= 4900 && duration <= 6000, `Took ${duration}ms`);
  assert.ok(res.error === 'socket hang up' || res.status === 400 || res.error, 'Should fail');
});

test('authenticated chunk taking over 5 seconds succeeds (uses 30s deadline)', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  
  const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/api/source/chunk',
      headers: {
          host, origin, authorization: `Bearer ${session}`,
          'content-type': 'application/octet-stream',
          'content-length': 5,
          'x-blastcast-source': JSON.stringify(chunkMeta)
      }
  });

  req.write(Buffer.from('he'));

  await new Promise(r => setTimeout(r, 5500)); // wait > 5s

  req.write(Buffer.from('llo'));
  req.end();

  const res = await new Promise((resolve) => {
      req.on('response', (response) => {
          let data = '';
          response.on('data', c => data += c);
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', (err) => resolve({ error: err.message }));
  });

  assert.equal(res.status, 200);
});

test('incomplete chunk disconnection cleans up activeUploads slot for subsequent upload', async (t) => {
  const port = await freePort();
  const host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());

  const chunkMeta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 1, byteLength: 5, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  
  const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/api/source/chunk',
      headers: {
          host, origin, authorization: `Bearer ${session}`,
          'content-type': 'application/octet-stream',
          'content-length': 5,
          'x-blastcast-source': JSON.stringify(chunkMeta)
      }
  });

  req.write(Buffer.from('he'));
  req.on('error', () => {});
  req.destroy(); // Disconnect client

  // Wait a little for server to handle the destroy and run finally block
  await new Promise(r => setTimeout(r, 100));

  const res = await request(port, 'POST', '/api/source/chunk', {
    host, origin, token: session, bufferBody: Buffer.from('hello'), headers: {
      'content-type': 'application/octet-stream',
      'x-blastcast-source': JSON.stringify(chunkMeta)
    }
  });
  
  assert.equal(res.status, 200);
});

// CodexBWAI: a completed request body can still be waiting on durable storage.
test('disconnect releases an upload slot even during storage, without releasing its replacement', async t => {
  const port = await freePort(), host = 'test.example.com', origin = 'https://test.example.com';
  const { guests, session, sources } = await setupAdmittedGuest(port, host, origin);
  t.after(() => guests.stop());
  const calls = [];
  sources.appendSource = (_id, meta) => new Promise(resolve => calls.push(() => resolve({ ok: true, ...meta })));
  const meta = { episodeId: 'ep1', epochId: 'epoch1', sequence: 0, byteLength: 1, sha256: 'hash', startMonoMs: 0, endMonoMs: 1 };
  const headers = { host, origin, authorization: `Bearer ${session}`, 'content-type': 'application/octet-stream', 'content-length': 1, 'x-blastcast-source': JSON.stringify(meta) };
  const first = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/source/chunk', headers });
  first.on('error', () => {}); first.end('a');
  t.after(() => { first.destroy(); for (const finish of calls) finish(); });
  async function waitFor(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(predicate(), 'storage operation must be reached');
  }
  await waitFor(() => calls.length === 1);
  first.destroy();
  await new Promise(r => setTimeout(r, 30));
  const options = { host, origin, token: session, bufferBody: Buffer.from('a'), headers };
  const second = request(port, 'POST', '/api/source/chunk', options);
  // Attach rejection handling immediately so a failed assertion cannot leave a dangling request.
  second.catch(() => {});
  await waitFor(() => calls.length === 2);
  calls[0]();
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await request(port, 'POST', '/api/source/chunk', options)).status, 409);
  calls[1]();
  assert.equal((await second).status, 200);
});
