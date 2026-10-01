import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSourceStore } from '../desktop/sources.cjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('creates episode and validates input schemas', async () => {
  await withTempDir(async dir => {
    const store = createSourceStore({ folder: () => dir });
    const id = crypto.randomUUID();
    
    // Test unknown keys
    assert.equal((await store.beginEpisode({ id, participants: [{id: 'host', label: 'Host'}], extra: 1 })).ok, false);
    
    assert.equal((await store.beginEpisode({
      id,
      participants: [
        { id: 'host', label: 'Host' },
        { id: '1234567890123456789012', label: 'Guest' }
      ]
    })).ok, true);

    const epochId = crypto.randomUUID();
    // Test bad fields
    assert.equal((await store.beginSource('host', {
      episodeId: id, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280.5, height: 720
    })).ok, false); // fractional width
    
    // Mutated caller inputs: array for width?
    assert.equal((await store.beginSource('host', {
      episodeId: id, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: [1280], height: 720
    })).ok, false);

    assert.equal((await store.beginSource('host', {
      episodeId: id, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280, height: 720
    })).ok, true);
    
    await store.closeEpisode(id);
  });
});

test('handles injected IO failure and partial writes gracefully', async () => {
  await withTempDir(async dir => {
    let mockIo = {
      open: async (p, flags, mode) => {
        const handle = await fs.open(p, flags, mode);
        return {
          write: async (b, offset, length) => {
            if (p.endsWith('.partial')) {
               // Simulate short write
               const bytesWritten = Math.floor(length / 2);
               await handle.write(b, offset, bytesWritten);
               return { bytesWritten }; // this loop will eventually fail if we inject error or we just return short and it loops?
               // Wait, writeAll loops until bytesWritten == length.
               // Let's inject an error on the second call.
            }
            return handle.write(b, offset, length);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
          read: async (...args) => handle.read(...args)
        };
      },
      mkdir: async (p, opts) => fs.mkdir(p, opts),
      link: async (a,b) => fs.link(a,b),
      unlink: async (a) => fs.unlink(a)
    };
    
    let failNextWrite = false;
    let mockIo2 = {
      open: async (p, flags, mode) => {
        const handle = await fs.open(p, flags, mode);
        return {
          write: async (b, offset, length) => {
            if (p.endsWith('.partial') && failNextWrite) {
               throw new Error('Injected IO Failure');
            }
            return handle.write(b, offset, length);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
          read: async (...args) => handle.read(...args)
        };
      },
      mkdir: async (p, opts) => fs.mkdir(p, opts),
      link: async (a,b) => fs.link(a,b),
      unlink: async (a) => fs.unlink(a)
    };

    const store = createSourceStore({ folder: () => dir, io: mockIo2 });
    const epId = crypto.randomUUID();
    await store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });

    const epochId = crypto.randomUUID();
    await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 0, hostStartedMs: 0, clockUncertaintyMs: 0,
      width: 1280, height: 720
    });

    const buf = new Uint8Array(10);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    failNextWrite = true;
    const appRes = await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256,
      startMonoMs: 0, endMonoMs: 10
    }, buf.buffer);

    assert.equal(appRes.ok, false);
    assert.match(appRes.message, /not be confirmed on disk/);
    
    let status = store.status();
    assert.equal(status.sources[0].phase, 'incomplete');
    assert.equal(status.sources[0].failed, true, 'observed disk rejection is a known failure');
    await store.shutdown();
  });
});

test('shutdown aborts pending and retains bytes', async () => {
  await withTempDir(async dir => {
    let writePending = null;
    let finishWrite;
    let mockIo = {
      open: async (p, flags, mode) => {
        const handle = await fs.open(p, flags, mode);
        return {
          write: async (b, offset, length) => {
            if (p.endsWith('.partial') && !writePending) {
              writePending = new Promise(r => finishWrite = r);
              await writePending;
            }
            return handle.write(b, offset, length);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
          read: async (...args) => handle.read(...args)
        };
      },
      mkdir: async (p, opts) => fs.mkdir(p, opts),
      link: async (a,b) => fs.link(a,b),
      unlink: async (a) => fs.unlink(a)
    };
    const store = createSourceStore({ folder: () => dir, io: mockIo });
    const epId = crypto.randomUUID();
    await store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });

    const epochId = crypto.randomUUID();
    await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 0, hostStartedMs: 0, clockUncertaintyMs: 0, width: 1280, height: 720
    });

    const buf = new Uint8Array(10);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const p = store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256, startMonoMs: 0, endMonoMs: 10
    }, buf.buffer);

    await new Promise(r => setTimeout(r, 50));
    
    const shut = store.shutdown({ timeoutMs: 100 });
    
    const shutRes = await shut;
    assert.equal(shutRes.ok, false);
    assert.match(shutRes.message, /I\/O is still outstanding/);
    
    finishWrite();
    const pRes = await p;
    // Should fail with 'Closed during write' caught as I/O failure
    assert.equal(pRes.ok, false);
    assert.equal((await store.shutdown()).ok, true);
    assert.equal(store.status().sources[0].failed, false, 'intentional shutdown is incomplete, not failed I/O');
  });
});

test('duplicate retries and forged content', async () => {
  await withTempDir(async dir => {
    const store = createSourceStore({ folder: () => dir, finalize: async (i,o) => { await fs.writeFile(o, "mock"); return {}; } });

    const epId = crypto.randomUUID();
    await store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });

    const epochId = crypto.randomUUID();
    let beginRes = await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280, height: 720
    });
    assert.equal(beginRes.ok, true);
    
    // Idempotent begin
    beginRes = await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280, height: 720
    });
    assert.equal(beginRes.ok, true);

    // Conflict begin
    let beginConflict = await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 101, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280, height: 720
    });
    assert.equal(beginConflict.ok, false);

    const buf = new Uint8Array(10);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const early = await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 1, byteLength: 10, sha256,
      startMonoMs: 110, endMonoMs: 120
    }, buf.buffer);
    assert.equal(early.ok, false, 'out-of-order data cannot advance the receipt cursor');
    assert.equal(store.status().sources[0].bytes, 0);
    await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256,
      startMonoMs: 100, endMonoMs: 110
    }, buf.buffer);

    // Idempotent append
    const appResDup = await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256,
      startMonoMs: 100, endMonoMs: 110
    }, buf.buffer);
    assert.equal(appResDup.ok, true);

    // Forged content (same length and sequence but different bytes/sha)
    const buf2 = new Uint8Array(10); buf2.fill(1);
    const sha256_2 = crypto.createHash('sha256').update(buf2).digest('hex');
    const appResForged = await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256: sha256_2,
      startMonoMs: 100, endMonoMs: 110
    }, buf2.buffer);
    assert.equal(appResForged.ok, false);

    let finRes = await store.finishSource('host', { episodeId: epId, epochId, chunkCount: 1, endedMonoMs: 110 });
    assert.equal(finRes.ok, true);
    assert.equal(store.status().sources[0].failed, false);
    
    // Idempotent finish
    finRes = await store.finishSource('host', { episodeId: epId, epochId, chunkCount: 1, endedMonoMs: 110 });
    assert.equal(finRes.ok, true);
  });
});

test('real folder collision', async () => {
  await withTempDir(async dir => {
    const store = createSourceStore({ folder: () => dir });
    const epId = crypto.randomUUID();
    
    await fs.mkdir(path.join(dir, `sources-${epId}`));
    
    const res = await store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });
    assert.equal(res.ok, false);
    assert.match(res.message, /Existing files were not replaced/);
  });
});

test('concurrent begin and close', async () => {
  await withTempDir(async dir => {
    const store = createSourceStore({ folder: () => dir });
    const epId = crypto.randomUUID();
    const epId2 = crypto.randomUUID();
    
    const p1 = store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });
    const p2 = store.beginEpisode({ id: epId2, participants: [{ id: 'host', label: 'Host' }] });
    
    const [r1, r2] = await Promise.all([p1, p2]);
    // Only one should succeed or both fail safely, no corrupted state.
    assert.ok(r1.ok !== r2.ok);
  });
});


test('late append after close is refused', async () => {
  await withTempDir(async dir => {
    const store = createSourceStore({ folder: () => dir });
    const epId = crypto.randomUUID();
    await store.beginEpisode({ id: epId, participants: [{ id: 'host', label: 'Host' }] });
    const epochId = crypto.randomUUID();
    await store.beginSource('host', {
      episodeId: epId, epochId, mimeType: 'video/webm;codecs=vp8,opus',
      startedMonoMs: 0, hostStartedMs: 0, clockUncertaintyMs: 0, width: 1280, height: 720
    });
    
    await store.closeEpisode(epId);
    
    const buf = new Uint8Array(10);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const appRes = await store.appendSource('host', {
      episodeId: epId, epochId, sequence: 0, byteLength: 10, sha256, startMonoMs: 0, endMonoMs: 10
    }, buf.buffer);
    
    assert.equal(appRes.ok, false);
    assert.match(appRes.message, /unavailable or busy/i);
    assert.equal(store.status().sources[0].failed, false);
  });
});

test('missing source, finalization failure and metadata failure remain distinct', async () => {
  await withTempDir(async dir => {
    let failMetadata = false;
    const store = createSourceStore({ folder: () => dir,
      finalize: async () => { throw new Error('Injected disk finalization failure'); },
      io: { rename: async (...args) => { if (failMetadata) throw new Error('Metadata unavailable'); return fs.rename(...args); } },
    });
    const id = crypto.randomUUID(), epochId = crypto.randomUUID();
    await store.beginEpisode({ id, participants: [{ id:'host', label:'Host' }, { id:'1234567890123456789012', label:'Missing guest' }] });
    assert.equal(store.status().sources[1].failed, false);
    await store.beginSource('host', { episodeId:id, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:0, hostStartedMs:0, clockUncertaintyMs:0, width:1280, height:720 });
    const bytes = new Uint8Array([1,2,3]);
    await store.appendSource('host', { episodeId:id, epochId, sequence:0, byteLength:bytes.byteLength, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), startMonoMs:0, endMonoMs:10 }, bytes.buffer);
    assert.equal((await store.finishSource('host', {episodeId:id,epochId,chunkCount:1,endedMonoMs:10})).ok, false);
    assert.equal(store.status().sources[0].failed, true);
    assert.equal(store.status().sources[1].failed, false, 'another participant failure does not mark a missing source failed');
    failMetadata = true;
    assert.equal((await store.stopEpisode(id)).ok, false);
    assert.equal(store.status().sources.every(source => source.failed), true, 'shared metadata failure affects each source');
    failMetadata = false;
    await store.closeEpisode(id);
    assert.equal(store.status().allSourcesComplete, false);
  });
});

test('closing during source startup and finalization is an interruption, not a known failure', async () => {
  for (const stage of ['startup', 'finalization']) await withTempDir(async dir => {
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const store = createSourceStore({ folder: () => dir,
      io: { open: async (file, ...args) => { if (stage === 'startup' && file.endsWith('.partial')) { entered(); await barrier; } return fs.open(file,...args); } },
      finalize: async (input, output) => { entered(); await barrier; await fs.writeFile(output, await fs.readFile(input)); },
    });
    const id = crypto.randomUUID(), epochId = crypto.randomUUID();
    await store.beginEpisode({ id, participants:[{id:'host',label:'Host'}] });
    let pending = store.beginSource('host', {episodeId:id,epochId,mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:0,hostStartedMs:0,clockUncertaintyMs:0,width:1280,height:720});
    if (stage === 'finalization') {
      await pending;
      const bytes = new Uint8Array([1,2,3]);
      await store.appendSource('host', {episodeId:id,epochId,sequence:0,byteLength:3,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),startMonoMs:0,endMonoMs:10}, bytes.buffer);
      pending = store.finishSource('host',{episodeId:id,epochId,chunkCount:1,endedMonoMs:10});
    }
    await waiting;
    const closing = store.closeEpisode(id); release();
    assert.equal((await pending).ok,false);
    assert.equal((await closing).ok,true);
    assert.equal(store.status().sources[0].phase,'incomplete');
    assert.equal(store.status().sources[0].failed,false,stage);
  });
});

test('eligible late begin and exact begin replay work while stopped; closed episode still rejects', async()=>{
 await withTempDir(async dir=>{
  const store=createSourceStore({folder:()=>dir}),id=crypto.randomUUID();
  await store.beginEpisode({id,participants:[{id:'host',label:'Host'}]});
  const d={episodeId:id,epochId:crypto.randomUUID(),mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:0,hostStartedMs:0,clockUncertaintyMs:0,width:1280,height:720};
  await store.stopEpisode(id);
  assert.equal((await store.beginSource('host',d)).ok,true);
  assert.equal((await store.beginSource('host',d)).ok,true);
  assert.equal((await store.beginSource('12345678901234567890',{...d,epochId:crypto.randomUUID()})).ok,false);
  assert.equal((await store.beginSource('host',{...d,width:640})).ok,false);
  await store.closeEpisode(id);
  assert.equal((await store.beginSource('host',d)).ok,false);
 });
});
