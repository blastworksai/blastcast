// ClaudeBWAI — a portrait original the live path accepts (b076e12) must also survive restart recovery and guest export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSourceStore } from '../desktop/sources.cjs';
import { writeSourceRecovery } from '../dist/source-recovery.js';

const portrait = { width:2160, height:3840 };

test('a 2160x3840 portrait original recovers after an interruption', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-portrait-'));
  t.after(() => fs.rm(folder, { recursive:true, force:true }));
  const episodeId = crypto.randomUUID(), epochId = crypto.randomUUID(), bytes = Buffer.from('portrait-chunk');
  const store = createSourceStore({ folder: () => folder, finalize: async (i, o) => fs.copyFile(i, o) });
  assert.equal((await store.beginEpisode({ id:episodeId, participants:[{ id:'host', label:'Host' }] })).ok, true);
  assert.equal((await store.beginSource('host', { episodeId, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:10,
    hostStartedMs:5, clockUncertaintyMs:1, ...portrait })).ok, true);
  const chunk = { episodeId, epochId, sequence:0, byteLength:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), startMonoMs:10, endMonoMs:20 };
  assert.equal((await store.appendSource('host', chunk, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).ok, true);
  assert.equal((await store.interrupt()).ok, true);
  assert.deepEqual(await createSourceStore({ folder: () => folder }).recover(), { ok:true, recovered:true, episodeId });
});

test('a guest can export a recovery file for a portrait original', async () => {
  const participantId = '1234567890123456789012', recoveryKey = 'A'.repeat(43);
  const episodeId = '11111111-1111-4111-8111-111111111111', epochId = '22222222-2222-4222-8222-222222222222';
  const bytes = new TextEncoder().encode('tail!');
  const chunk = { episodeId, epochId, sequence:1, byteLength:bytes.byteLength, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), startMonoMs:20, endMonoMs:30 };
  const record = { descriptor:{ episodeId, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:10, hostStartedMs:5, clockUncertaintyMs:1, ...portrait },
    participantId, recoveryKey, next:2, acked:1, bytes:8, ackedBytes:3, end:{ episodeId, epochId, chunkCount:2, endedMonoMs:30 } };
  const queue = { snapshot: action => action({ records: async () => [record], chunk: async () => ({ chunk, bytes:bytes.buffer }) }) };
  const writer = { write: async () => {}, close: async () => {}, abort: async () => {} };
  assert.deepEqual(await writeSourceRecovery(queue, { participantId, recoveryKey, episodeId }, writer), { epochs:1, chunks:1, bytes:5 });
});
