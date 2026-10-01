// CodexBWAI — local persistence and host delivery are deliberately separate receipts.
import type { SourceDescriptor, SourceChunk, SourceEnd, SourceFinishAck, SourceTransport } from './source-protocol.js';
export const SOURCE_TRANSFER_PIECE = 64 * 1024;
const MAX_RETAINED_BYTES = 2 * 1024 * 1024 * 1024;
export class SourceTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
export type SourceRecoveryBinding = { participantId: string; recoveryKey: string };
export type LocalSourceRecord = { descriptor: SourceDescriptor; participantId: string | null; recoveryKey: string | null;
  next: number; acked: number; bytes: number; ackedBytes: number; end: SourceEnd | null };
export type SourceQueueItem = { chunk: SourceChunk; bytes: ArrayBuffer };
export type SourceQueueSnapshot = {
  records(): Promise<LocalSourceRecord[]>;
  chunk(epochId: string, sequence: number): Promise<SourceQueueItem | null>;
};
export interface SourceQueue {
  create(descriptor: SourceDescriptor): Promise<void>;
  append(chunk: SourceChunk, bytes: ArrayBuffer): Promise<void>;
  peek(epochId: string): Promise<{record: LocalSourceRecord; item: SourceQueueItem | null}>;
  acknowledge(chunk: SourceChunk): Promise<void>;
  seal(end: SourceEnd): Promise<void>;
  complete(epochId: string): Promise<void>;
  close(): void;
}

// One budget transaction spans every retained epoch in this origin, including other tabs.
export class IndexedSourceQueue implements SourceQueue {
  private db: Promise<IDBDatabase>;
  private lockName: string;
  constructor(name = 'blastcast-source-outbox-v1', private maxBytes = MAX_RETAINED_BYTES,
    private binding: SourceRecoveryBinding | null = null) {
    this.lockName = `${name}:exclusive`;
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('records'); db.createObjectStore('chunks'); db.createObjectStore('budget');
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Local recording storage is blocked.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    if (!navigator.locks) return Promise.reject(new Error('Safe local recording storage is unavailable in this browser.'));
    return navigator.locks.request(this.lockName, { mode: 'exclusive' }, action);
  }
  private async transaction<T>(write: boolean, action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['records','chunks','budget'], write ? 'readwrite' : 'readonly', { durability: 'strict' });
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('Local recording storage transaction failed.'));
      tx.onerror = () => {}; // Abort delivers the error; never resolve from request success alone.
      try { action(tx, result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async create(descriptor: SourceDescriptor): Promise<void> {
    return this.locked(() => this.transaction<void>(true, tx => {
      const records = tx.objectStore('records'), count = records.count();
      count.onsuccess = () => {
        if (count.result >= 64) { tx.abort(); return; }
        records.add({descriptor,participantId:this.binding?.participantId ?? null,recoveryKey:this.binding?.recoveryKey ?? null,
          next:0,acked:0,bytes:0,ackedBytes:0,end:null}, descriptor.epochId);
      };
    }));
  }
  async append(chunk: SourceChunk, bytes: ArrayBuffer): Promise<void> {
    if (bytes.byteLength !== chunk.byteLength || !bytes.byteLength || bytes.byteLength > SOURCE_TRANSFER_PIECE) throw new Error('Invalid local source piece.');
    return this.locked(() => this.transaction<void>(true, tx => {
      const records = tx.objectStore('records'), budget = tx.objectStore('budget');
      const record = records.get(chunk.epochId), used = budget.get('bytes');
      used.onsuccess = () => {
        const r = record.result as LocalSourceRecord | undefined;
        const total = (used.result ?? 0) + bytes.byteLength;
        if (!r || r.end || r.descriptor.episodeId !== chunk.episodeId || r.next !== chunk.sequence || total > this.maxBytes) { tx.abort(); return; }
        tx.objectStore('chunks').add({chunk,bytes}, [chunk.epochId,chunk.sequence]);
        records.put({...r,next:r.next+1,bytes:r.bytes+bytes.byteLength}, chunk.epochId);
        budget.put(total,'bytes');
      };
    }));
  }
  async peek(epochId: string): Promise<{record: LocalSourceRecord; item: SourceQueueItem | null}> {
    return this.transaction(false, (tx, result) => {
      const request = tx.objectStore('records').get(epochId);
      request.onsuccess = () => {
        const record = request.result as LocalSourceRecord | undefined;
        if (!record) { tx.abort(); return; }
        const item = tx.objectStore('chunks').get([epochId,record.acked]);
        item.onsuccess = () => {
          if (record.acked < record.next && !item.result) { tx.abort(); return; }
          result({record,item:item.result ?? null});
        };
      };
    });
  }
  async acknowledge(chunk: SourceChunk): Promise<void> {
    return this.locked(() => this.transaction<void>(true, tx => {
      const records = tx.objectStore('records'), chunks = tx.objectStore('chunks'), budget = tx.objectStore('budget');
      const record = records.get(chunk.epochId), item = chunks.get([chunk.epochId,chunk.sequence]), used = budget.get('bytes');
      used.onsuccess = () => {
        const r = record.result as LocalSourceRecord | undefined;
        const local = item.result as SourceQueueItem | undefined;
        if (!r || !local || r.acked !== chunk.sequence || local.chunk.sha256 !== chunk.sha256 || local.chunk.byteLength !== chunk.byteLength) { tx.abort(); return; }
        records.put({...r,acked:r.acked+1,ackedBytes:r.ackedBytes+chunk.byteLength},chunk.epochId);
        chunks.delete([chunk.epochId,chunk.sequence]); budget.put(used.result-chunk.byteLength,'bytes');
      };
    }));
  }
  async seal(end: SourceEnd): Promise<void> {
    return this.locked(() => this.transaction<void>(true, tx => {
      const records = tx.objectStore('records'), request = records.get(end.epochId);
      request.onsuccess = () => {
        const r = request.result as LocalSourceRecord | undefined;
        if (!r || r.descriptor.episodeId !== end.episodeId || r.next !== end.chunkCount || r.end) { tx.abort(); return; }
        records.put({...r,end},end.epochId);
      };
    }));
  }
  async complete(epochId: string): Promise<void> {
    return this.locked(() => this.transaction<void>(true, tx => {
      const records = tx.objectStore('records'), request = records.get(epochId);
      request.onsuccess = () => {
        const r = request.result as LocalSourceRecord | undefined;
        if (!r?.end || r.acked !== r.next || r.ackedBytes !== r.bytes) { tx.abort(); return; }
        records.delete(epochId);
      };
    }));
  }
  snapshot<T>(action: (snapshot: SourceQueueSnapshot) => Promise<T>): Promise<T> {
    return this.locked(() => action({
      records: () => this.transaction(false, (tx, result) => {
        const request = tx.objectStore('records').getAll();
        request.onsuccess = () => result(request.result as LocalSourceRecord[]);
      }),
      chunk: (epochId, sequence) => this.transaction(false, (tx, result) => {
        const request = tx.objectStore('chunks').get([epochId,sequence]);
        request.onsuccess = () => result((request.result as SourceQueueItem | undefined) ?? null);
      }),
    }));
  }
  close(): void { void this.db.then(db => db.close(), () => {}); }
}

export type SourceDeliveryProgress = { acknowledgedBytes: number; message: string };
export interface DurableSourceSink {
  open(descriptor: SourceDescriptor): Promise<void>;
  append(chunk: SourceChunk, bytes: ArrayBuffer): Promise<void>;
  finish(end: SourceEnd): Promise<SourceFinishAck>;
  cancel(): void;
  freeze?(): Promise<void>;
}
export class SourceOutbox implements DurableSourceSink {
  private epochId = '';
  private running = false;
  private requested = false;
  private cancelled = false;
  private begun = false;
  private sealed = false;
  private nextUploadAt = 0;
  private acknowledgedBytes = 0;
  private finishResolve?: (ack: SourceFinishAck) => void;
  private finishReject?: (error: Error) => void;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  private runningTask: Promise<void> | null = null;
  constructor(private options: { store: SourceQueue; transport: SourceTransport;
    progress: (state: SourceDeliveryProgress) => void; failed: (message: string) => void;
    now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, ms); }));
  }
  async open(descriptor: SourceDescriptor): Promise<void> {
    await this.options.store.create(descriptor); this.epochId = descriptor.epochId;
    if (!this.cancelled) this.kick();
  }
  async append(chunk: SourceChunk, bytes: ArrayBuffer): Promise<void> {
    if (this.cancelled) throw new Error('Original delivery stopped. Saved local media is retained.');
    await this.options.store.append(chunk, bytes); this.kick();
  }
  async finish(end: SourceEnd): Promise<SourceFinishAck> {
    if (this.cancelled) throw new Error('Original delivery stopped.');
    await this.options.store.seal(end); this.sealed = true;
    if (this.cancelled) throw new Error('Original delivery stopped.');
    const result = new Promise<SourceFinishAck>((resolve,reject) => { this.finishResolve=resolve;this.finishReject=reject; });
    this.kick(); return result;
  }
  cancel(): void {
    this.stopDelivery();
    // In-flight transactions may still commit. Closing a connection does not erase them.
    this.options.store.close();
  }
  async freeze(): Promise<void> {
    this.stopDelivery();
    await this.runningTask;
  }
  private stopDelivery(): void {
    this.cancelled = true; clearTimeout(this.timer); this.wake?.();
    this.finishReject?.(new Error('Original delivery stopped. Saved local media is retained.'));
  }
  private alive(): void { if (this.cancelled) throw new Error('Delivery cancelled'); }
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let delay = 500;
    for (;;) {
      this.alive();
      try { const reply = await operation(); this.alive(); return reply; }
      catch (error) {
        this.alive();
        if (!(error instanceof SourceTransportError) || !error.retryable) throw error;
        this.options.progress({acknowledgedBytes:this.acknowledgedBytes,message:'Connection interrupted. Recording is saved on this device while delivery retries. Keep this page open.'});
        await this.sleep(delay); delay = Math.min(delay*2,5000);
      }
    }
  }
  private kick(): void {
    this.requested = true;
    if (this.running || this.cancelled) return;
    this.running = true;
    this.runningTask = this.deliver().catch(() => {
      if (!this.cancelled) {
        this.options.failed('Original delivery could not be verified. Previously saved local media is retained; keep this page open.');
        this.cancel();
      }
    }).finally(() => { this.running = false; this.runningTask = null; if (this.requested && !this.cancelled) this.kick(); });
  }
  private async deliver(): Promise<void> {
    while (!this.cancelled) {
      this.requested = false;
      const {record, item} = await this.options.store.peek(this.epochId); this.alive();
      const d = record.descriptor;
      if (!this.begun) {
        const ack = await this.retry(() => this.options.transport.begin(d));
        if (!ack.ok || ack.episodeId !== d.episodeId || ack.epochId !== d.epochId) throw new Error('Invalid begin receipt');
        this.begun = true;
      }
      if (item) {
        const c = item.chunk;
        const ack = await this.retry(async () => {
          const delay = this.nextUploadAt-this.now(); if (delay>0) await this.sleep(delay);
          this.alive();
          this.nextUploadAt = this.now()+c.byteLength/(this.sealed ? 1048576 : 262144)*1000;
          return this.options.transport.append(c,item.bytes);
        });
        if (!ack.ok || ack.episodeId !== c.episodeId || ack.epochId !== c.epochId || ack.sequence !== c.sequence || ack.sha256 !== c.sha256 || ack.byteLength !== c.byteLength) throw new Error('Invalid chunk receipt');
        await this.options.store.acknowledge(c); this.alive();
        this.acknowledgedBytes = record.ackedBytes+c.byteLength;
        this.options.progress({acknowledgedBytes:this.acknowledgedBytes,message:'Recording delivery in progress. Keep this page open until the host verifies your original.'});
      } else if (record.end) {
        const ack = await this.retry(() => this.options.transport.finish(record.end!));
        if (!ack.ok || ack.episodeId !== d.episodeId || ack.epochId !== d.epochId || ack.bytes !== record.bytes || record.ackedBytes !== record.bytes) throw new Error('Invalid final receipt');
        await this.options.store.complete(this.epochId); this.alive();
        this.finishResolve?.(ack); this.cancelled=true; this.options.store.close(); return;
      } else return;
    }
  }
}
