// CodexBWAI — explicit, streamed guest recovery; the host remains the verifier.
import type { LocalSourceRecord, SourceQueueSnapshot } from './source-outbox.js';
import { SOURCE_PIECE_BYTES, SOURCE_RETAINED_BYTES, SOURCE_MAX_BYTES, SOURCE_MAX_CHUNKS, SOURCE_CHUNK_KEYS, UUID } from './source-limits.js';
import type { SourceChunk, SourceDescriptor, SourceEnd } from './source-protocol.js';

export const RECOVERY_MAGIC = new TextEncoder().encode('BLASTCASTRECOV1\n');
export const RECOVERY_EXTENSION = '.bcr';
const MAX_MANIFEST = 1024 * 1024;
const MAX_FRAME_META = 1024;
const MAX_PIECE = SOURCE_PIECE_BYTES;
const MAX_RETAINED = SOURCE_RETAINED_BYTES;
const MAX_SOURCE_BYTES = SOURCE_MAX_BYTES;
const MAX_CHUNKS = SOURCE_MAX_CHUNKS;
const PARTICIPANT = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const DESCRIPTOR = ['episodeId','epochId','mimeType','startedMonoMs','hostStartedMs','clockUncertaintyMs','width','height'];
const END = ['episodeId','epochId','chunkCount','endedMonoMs'];
const CHUNK = SOURCE_CHUNK_KEYS;

export type SourceRecoveryIdentity = { participantId: string; recoveryKey: string; episodeId: string };
type RecoveryEpoch = { descriptor: SourceDescriptor; acked: number; next: number; ackedBytes: number; bytes: number;
  end: SourceEnd | null; retainedChunks: number; retainedBytes: number };
type RecoveryManifest = { version: 1; participantId: string; recoveryKey: string; episodeId: string; epochs: RecoveryEpoch[] };
export type SourceRecoveryWriter = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};
export type RecoverySnapshotQueue = { snapshot<T>(action: (snapshot: SourceQueueSnapshot) => Promise<T>): Promise<T> };

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => plain(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) &&
  (value as number) >= min && (value as number) <= max;
const time = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0 &&
  (value as number) <= Number.MAX_SAFE_INTEGER;
function invalid(message = 'Saved recovery data is invalid.'): never { throw new Error(message); }

function descriptor(value: unknown, identity: SourceRecoveryIdentity): asserts value is SourceDescriptor {
  if (!exact(value,DESCRIPTOR) || value.episodeId !== identity.episodeId || typeof value.epochId !== 'string' || !UUID.test(value.epochId) ||
    value.mimeType !== 'video/webm;codecs=vp8,opus' || !time(value.startedMonoMs) || !time(value.hostStartedMs) ||
    !time(value.clockUncertaintyMs) || !integer(value.width,0,3840) || !integer(value.height,0,3840) || Math.min(value.width,value.height) > 2160) invalid();
}
function ending(value: unknown, d: SourceDescriptor, next: number): asserts value is SourceEnd | null {
  if (value === null) return;
  if (!exact(value,END) || value.episodeId !== d.episodeId || value.epochId !== d.epochId ||
    !integer(value.chunkCount,0,MAX_CHUNKS) || value.chunkCount !== next || !time(value.endedMonoMs)) invalid();
}
function recoveryEpoch(record: LocalSourceRecord, identity: SourceRecoveryIdentity): RecoveryEpoch {
  if (!exact(record,['descriptor','participantId','recoveryKey','next','acked','bytes','ackedBytes','end']) ||
    record.participantId !== identity.participantId || record.recoveryKey !== identity.recoveryKey) invalid();
  descriptor(record.descriptor,identity);
  if (!integer(record.next,0,MAX_CHUNKS) || !integer(record.acked,0,record.next) ||
    !integer(record.bytes,0,MAX_SOURCE_BYTES) || !integer(record.ackedBytes,0,record.bytes)) invalid();
  ending(record.end,record.descriptor,record.next);
  const retainedChunks = record.next-record.acked, retainedBytes = record.bytes-record.ackedBytes;
  if (retainedBytes > MAX_RETAINED || (!retainedChunks && retainedBytes) || (retainedChunks && !retainedBytes) ||
    (!retainedChunks && !record.end)) invalid('No retained recovery data is available for this episode.');
  return { descriptor:record.descriptor,acked:record.acked,next:record.next,ackedBytes:record.ackedBytes,
    bytes:record.bytes,end:record.end,retainedChunks,retainedBytes };
}
function chunk(value: unknown, epoch: RecoveryEpoch, sequence: number): asserts value is SourceChunk {
  if (!exact(value,CHUNK) || value.episodeId !== epoch.descriptor.episodeId || value.epochId !== epoch.descriptor.epochId ||
    value.sequence !== sequence || !integer(value.byteLength,1,MAX_PIECE) || typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) || !time(value.startMonoMs) || !time(value.endMonoMs) ||
    value.startMonoMs < epoch.descriptor.startedMonoMs || value.endMonoMs < value.startMonoMs) invalid();
}
function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0,value,false); return bytes;
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
}

export function recoveryFilename(episodeId: string): string {
  return `blastcast-recovery-${UUID.test(episodeId) ? episodeId.slice(0,8) : 'original'}${RECOVERY_EXTENSION}`;
}

export async function writeSourceRecovery(queue: RecoverySnapshotQueue, identity: SourceRecoveryIdentity,
  writer: SourceRecoveryWriter): Promise<{ epochs: number; chunks: number; bytes: number }> {
  if (!PARTICIPANT.test(identity.participantId) || !KEY.test(identity.recoveryKey) || !UUID.test(identity.episodeId)) invalid();
  try {
    const result = await queue.snapshot(async snapshot => {
      const records = await snapshot.records();
      if (!Array.isArray(records) || records.length > 64) invalid();
      const sameEpisode = records.filter(record => plain(record) && plain(record.descriptor) && record.descriptor.episodeId === identity.episodeId);
      if (sameEpisode.some(record => record.participantId !== identity.participantId || record.recoveryKey !== identity.recoveryKey)) {
        invalid('The retained originals do not match this authenticated guest.');
      }
      const epochs = sameEpisode.map(record => recoveryEpoch(record,identity))
        .sort((a,b) => a.descriptor.startedMonoMs-b.descriptor.startedMonoMs || a.descriptor.epochId.localeCompare(b.descriptor.epochId));
      if (!epochs.length || epochs.length > 8 || new Set(epochs.map(epoch => epoch.descriptor.epochId)).size !== epochs.length) {
        invalid('No retained recovery data is available for this episode.');
      }
      const retainedBytes = epochs.reduce((total,epoch) => total+epoch.retainedBytes,0);
      const retainedChunks = epochs.reduce((total,epoch) => total+epoch.retainedChunks,0);
      if (retainedBytes > MAX_RETAINED || (!retainedBytes && !epochs.some(epoch => epoch.end))) invalid();
      const manifest: RecoveryManifest = { version:1, ...identity, epochs };
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));
      if (!encoded.length || encoded.length > MAX_MANIFEST) invalid();
      await writer.write(RECOVERY_MAGIC); await writer.write(u32(encoded.length)); await writer.write(encoded);
      let written = 0;
      for (const epoch of epochs) {
        let bytes = 0, lastEnd = epoch.descriptor.startedMonoMs;
        for (let sequence=epoch.acked; sequence<epoch.next; sequence++) {
          const item = await snapshot.chunk(epoch.descriptor.epochId,sequence);
          if (!item) invalid();
          chunk(item.chunk,epoch,sequence);
          if (!(item.bytes instanceof ArrayBuffer) || item.bytes.byteLength !== item.chunk.byteLength ||
            item.chunk.startMonoMs < lastEnd || await sha256(item.bytes) !== item.chunk.sha256) invalid();
          const metadata = new TextEncoder().encode(JSON.stringify(item.chunk));
          if (!metadata.length || metadata.length > MAX_FRAME_META) invalid();
          await writer.write(u32(metadata.length)); await writer.write(metadata);
          await writer.write(u32(item.bytes.byteLength)); await writer.write(new Uint8Array(item.bytes));
          bytes += item.bytes.byteLength; lastEnd = item.chunk.endMonoMs; written++;
        }
        if (bytes !== epoch.retainedBytes || (epoch.end && epoch.end.endedMonoMs < lastEnd)) invalid();
      }
      if (written !== retainedChunks) invalid();
      return { epochs:epochs.length,chunks:written,bytes:retainedBytes };
    });
    await writer.close(); return result;
  } catch (error) {
    try { await writer.abort?.(error); } catch { /* Retained IndexedDB data remains the retry source. */ }
    throw error;
  }
}
