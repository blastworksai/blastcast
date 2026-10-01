// CodexBWAI — optional durable guest sink keeps persistence independent of host receipt.
import { SOURCE_TRANSFER_PIECE, type DurableSourceSink, type SourceDeliveryProgress } from './source-outbox.js';
import type {
  SourceTransport,
  SourceCaptureState,
  SourceStart,
} from './source-protocol.js';
import {
  SOURCE_MIME,
  SOURCE_MAX_CHUNK,
  SOURCE_MAX_PENDING,
} from './source-protocol.js';

export class SourceCapture {
  private _state: SourceCaptureState = {
    phase: 'idle',
    episodeId: null,
    epochId: null,
    capturedBytes: 0,
    acknowledgedBytes: 0,
    pendingBytes: 0,
    message: '',
  };

  private transport: SourceTransport;
  private onState: (state: SourceCaptureState) => void;
  private makeRecorder: (stream: MediaStream) => MediaRecorder;
  private now: () => number;
  private drainTimeoutMs: number;
  private finalizeTimeoutMs: number;
  private allowPartialSource: boolean;

  private recorder: MediaRecorder | null = null;
  private queue: Array<{ blob: Blob; startMonoMs: number; endMonoMs: number }> = [];
  private activeTracks: MediaStreamTrack[] = [];
  private activeStopPromise: Promise<void> | null = null;
  private beginPromise: Promise<void> | null = null;
  private processingQueue = false;
  private sequence = 0;
  private lastEventMonoMs = 0;
  private failed = false;
  private stopped = false;

  private drainResolve: (() => void) | null = null;
  private pendingCount = 0;
  private queuedBytes = 0;
  private durable?: DurableSourceSink;
  private durationTimer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    transport: SourceTransport;
    allowPartialSource?: boolean;
    onState: (state: SourceCaptureState) => void;
    makeRecorder?: (stream: MediaStream) => MediaRecorder;
    now?: () => number;
    drainTimeoutMs?: number;
    finalizeTimeoutMs?: number;
    durable?: (progress: (state: SourceDeliveryProgress) => void, failed: (message: string) => void) => DurableSourceSink;
  }) {
    this.transport = options.transport;
    this.allowPartialSource = options.allowPartialSource === true;
    this.durable = options.durable?.(state => {
      if (!this.failed) this.updateState({ acknowledgedBytes: state.acknowledgedBytes,
        pendingBytes: this._state.capturedBytes-state.acknowledgedBytes, message: state.message });
    }, message => { void this.fail(message); });
    this.onState = options.onState;
    this.makeRecorder =
      options.makeRecorder ||
      ((stream) => new MediaRecorder(stream, { mimeType: SOURCE_MIME }));
    this.now = options.now || (() => performance.now());
    const dt = options.drainTimeoutMs ?? 30000;
    this.drainTimeoutMs = (Number.isFinite(dt) && dt > 0) ? Math.min(dt, 30000) : 30000;
    const ft = options.finalizeTimeoutMs ?? 120000;
    this.finalizeTimeoutMs = (Number.isFinite(ft) && ft > 0) ? Math.min(ft, 120000) : 120000;
  }

  get state(): SourceCaptureState {
    return { ...this._state };
  }

  get busy(): boolean {
    return this._state.phase !== 'idle' && this._state.phase !== 'complete' && this._state.phase !== 'incomplete';
  }

  private updateState(partial: Partial<SourceCaptureState>) {
    this._state = { ...this._state, ...partial };
    this.onState({ ...this._state });
  }

  async start(stream: MediaStream, options: SourceStart): Promise<void> {
    if (this.busy || this._state.phase === 'complete' || this._state.phase === 'incomplete') {
      return;
    }
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    
    let activeVideo = 0;
    let activeAudio = 0;
    let width = 0;
    let height = 0;

    let liveVideoTracks: MediaStreamTrack[] = [];
    let liveAudioTracks: MediaStreamTrack[] = [];
    
    for (const track of videoTracks) {
      if (track.readyState === 'live') {
        activeVideo++;
        liveVideoTracks.push(track);
        const settings = track.getSettings();
        width = Math.max(width, settings.width || 0);
        height = Math.max(height, settings.height || 0);
      }
    }
    for (const track of audioTracks) {
      if (track.readyState === 'live') {
        activeAudio++;
        liveAudioTracks.push(track);
      }
    }

    const validTracks = this.allowPartialSource
      ? activeVideo <= 1 && activeAudio <= 1 && activeVideo + activeAudio >= 1
      : activeVideo === 1 && activeAudio === 1;
    if (!validTracks) {
      await this.fail(this.allowPartialSource ? 'Require one live camera and/or microphone source, with at most one track of each kind'
        : 'Require exactly one live video and one live audio track');
      return;
    }

    if (width > 3840 || height > 2160) {
      await this.fail('Source dimensions exceed 3840x2160');
      return;
    }

    this.activeTracks = [...liveVideoTracks, ...liveAudioTracks];
    for (const track of this.activeTracks) {
      track.addEventListener('ended', this.handleTrackEnded);
    }

    this.updateState({
      phase: 'starting',
      episodeId: options.episodeId,
      epochId: options.epochId,
      capturedBytes: 0,
      acknowledgedBytes: 0,
      pendingBytes: 0,
      message: 'Starting capture...',
    });

    this.sequence = 0;
    this.failed = false;
    this.stopped = false;
    this.queue = [];
    this.queuedBytes = 0;
    
    try {
      this.recorder = this.makeRecorder(stream);
    } catch (e: any) {
      await this.fail('Recorder creation failed: ' + e.message);
      return;
    }

    this.recorder.addEventListener('dataavailable', this.handleDataAvailable);
    this.recorder.addEventListener('error', this.handleRecorderError);
    this.recorder.addEventListener('stop', this.handleRecorderUnexpectedStop);

    const startedMonoMs = this.now();
    this.lastEventMonoMs = startedMonoMs;
    
    try {
      this.recorder.start(500);
    } catch (e: any) {
      await this.fail('Recorder start failed: ' + e.message);
      return;
    }

    const hostStartedMs = options.clock.hostNowMs + startedMonoMs - options.clock.localMonoMs;
    
    this.updateState({ phase: 'recording', message: 'Recording in progress' });
    if (this.durable) this.durationTimer = setTimeout(() => { void this.stop(); }, 2 * 60 * 60 * 1000);

    this.beginPromise = (async () => {
      try {
        const descriptor = {
          episodeId: options.episodeId,
          epochId: options.epochId,
          mimeType: SOURCE_MIME,
          startedMonoMs,
          hostStartedMs,
          clockUncertaintyMs: options.clock.uncertaintyMs,
          width,
          height
        };
        if (this.durable) { await this.durable.open(descriptor); return; }
        const ack = await this.transport.begin(descriptor);
        if (!ack.ok) {
          throw new Error(ack.message);
        }
        if (ack.episodeId !== options.episodeId || ack.epochId !== options.epochId) {
          throw new Error('Mismatched begin ACK identity');
        }
      } catch (e: any) {
        await this.fail('Begin failed: ' + e.message);
      }
    })();
  }

  private handleTrackEnded = () => {
    this.fail('Hardware track ended');
  };

  private handleRecorderUnexpectedStop = () => {
    if (!this.stopped && !this.failed) {
      this.fail('Recorder stopped unexpectedly');
    }
  };

  private handleRecorderError = (e: Event) => {
    this.fail('Recorder error: ' + (e as any).error?.message);
  };

  private handleDataAvailable = (e: BlobEvent) => {
    if (this.failed) return;
    if (e.data) {
      if (e.data.size === 0) {
        // Empty blob may be sent on stop, still check queue drain
        if (this.drainResolve && this.queue.length === 0 && this.pendingCount === 0 && !this.processingQueue) {
          if (this.drainResolve) this.drainResolve();
        }
        return;
      }
      const endMonoMs = this.now();
      const startMonoMs = this.lastEventMonoMs;
      this.lastEventMonoMs = endMonoMs;
      
      this.updateState({ 
        capturedBytes: this._state.capturedBytes + e.data.size,
        pendingBytes: this._state.pendingBytes + e.data.size
      });
      
      if (e.data.size > SOURCE_MAX_CHUNK) {
        this.fail('Chunk exceeds maximum size');
        return;
      }
      this.queuedBytes += e.data.size;
      if ((this.durable ? this.queuedBytes : this._state.pendingBytes) > SOURCE_MAX_PENDING) {
        this.fail('Pending bytes bound exceeded');
        return;
      }

      const pieceSize = this.durable ? SOURCE_TRANSFER_PIECE : SOURCE_MAX_CHUNK;
      for (let offset=0; offset<e.data.size; offset+=pieceSize) {
        this.queue.push({ blob: this.durable ? e.data.slice(offset,offset+pieceSize) : e.data, startMonoMs,
          endMonoMs: offset+pieceSize >= e.data.size ? endMonoMs : startMonoMs });
      }
      this.processQueue();
    }
  };

  private async sha256(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async processQueue() {
    if (this.processingQueue || this.failed) return;
    this.processingQueue = true;

    try {
      if (this.beginPromise) {
        await this.beginPromise;
      }
      
      while (this.queue.length > 0 && !this.failed) {
        const item = this.queue[0];
        if (!item) break;
        const buffer = await item.blob.arrayBuffer();
        const hash = await this.sha256(buffer);
        const seq = this.sequence;

        if (this.failed) break;

        this.pendingCount++;
        const chunk = {
          episodeId: this._state.episodeId!,
          epochId: this._state.epochId!,
          sequence: seq,
          byteLength: buffer.byteLength,
          sha256: hash,
          startMonoMs: item.startMonoMs,
          endMonoMs: item.endMonoMs
        };
        if (this.durable) {
          await this.durable.append(chunk,buffer);
          this.pendingCount--;
          if (this.failed) break;
          this.sequence++; this.queue.shift(); this.queuedBytes -= buffer.byteLength;
          continue;
        }
        const ack = await this.transport.append(chunk, buffer);
        this.pendingCount--;

        if (this.failed) break;

        if (!ack.ok) {
          throw new Error(ack.message);
        }
        if (ack.episodeId !== this._state.episodeId || ack.epochId !== this._state.epochId || ack.sequence !== seq || ack.sha256 !== hash || ack.byteLength !== buffer.byteLength) {
          throw new Error('Mismatched append ACK identity/hash/length');
        }
        
        this.sequence++;
        this.queue.shift();
        this.queuedBytes -= buffer.byteLength;

        this.updateState({
          acknowledgedBytes: this._state.acknowledgedBytes + buffer.byteLength,
          pendingBytes: this._state.pendingBytes - buffer.byteLength
        });
      }
    } catch (e: any) {
      await this.fail('Append failed: ' + e.message);
    } finally {
      this.processingQueue = false;
      if (this.drainResolve && this.queue.length === 0 && this.pendingCount === 0) {
        this.drainResolve();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.activeStopPromise) {
      return this.activeStopPromise;
    }
    if (!this.busy || this.failed) {
      return;
    }
    
    this.stopped = true;
    clearTimeout(this.durationTimer);
    this.updateState({ phase: 'stopping', message: 'Stopping capture...' });
    
    this.activeStopPromise = (async () => {
      // The final dataavailable callback may enqueue work after stop() began with
      // an empty queue. Wait for stop first, then observe the current drain state.
      let recorderStopPromise = Promise.resolve();
      if (this.recorder && this.recorder.state !== 'inactive') {
        recorderStopPromise = new Promise<void>(resolve => {
          this.recorder!.addEventListener('stop', () => resolve(), { once: true });
        });
        try { this.recorder.stop(); }
        catch { await this.fail('Original capture could not stop cleanly.'); return; }
      }
      const drained = (async () => {
        await recorderStopPromise;
        await this.beginPromise;
        if (this.failed) return;
        if (this.queue.length === 0 && this.pendingCount === 0 && !this.processingQueue) return;
        await new Promise<void>(resolve => { this.drainResolve = resolve; });
      })();

      let timerId: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          drained,
          new Promise((_, reject) => { timerId = setTimeout(() => reject(new Error('Drain timeout')), this.drainTimeoutMs); })
        ]);
      } catch (e: any) {
        await this.fail(e.message);
        return;
      } finally {
        clearTimeout(timerId!);
      }

      if (this.failed) return;

      try {
        const endMonoMs = this.lastEventMonoMs;
        const end = {
          episodeId: this._state.episodeId!,
          epochId: this._state.epochId!,
          chunkCount: this.sequence,
          endedMonoMs: endMonoMs
        };
        const finishPromise = this.durable ? this.durable.finish(end) : this.transport.finish(end);

        let finishTimerId: ReturnType<typeof setTimeout>;
        const ack = await Promise.race([
          finishPromise,
          new Promise<any>((_, reject) => { finishTimerId = setTimeout(() => reject(new Error('Finalize timeout')), this.finalizeTimeoutMs); })
        ]).finally(() => clearTimeout(finishTimerId!));

        if (this.failed) return;

        if (!ack.ok) {
          throw new Error(ack.message);
        }
        if (ack.episodeId !== this._state.episodeId || ack.epochId !== this._state.epochId || ack.bytes !== this._state.acknowledgedBytes) {
          throw new Error('Mismatched finish ACK identity/bytes');
        }

        this.cleanup();
        this.updateState({ phase: 'complete', message: 'Capture complete' });
      } catch (e: any) {
        await this.fail('Finish failed: ' + e.message);
      } finally {
        this.activeStopPromise = null;
      }
    })();
    return this.activeStopPromise;
  }

  private cleanup() {
    clearTimeout(this.durationTimer);
    for (const track of this.activeTracks) {
      track.removeEventListener('ended', this.handleTrackEnded);
    }
    this.activeTracks = [];
    if (this.recorder) {
      this.recorder.removeEventListener('dataavailable', this.handleDataAvailable);
      this.recorder.removeEventListener('error', this.handleRecorderError);
      this.recorder.removeEventListener('stop', this.handleRecorderUnexpectedStop);
    }
  }

  async fail(message: string): Promise<void> {
    return this.stopIncomplete(message, false);
  }

  async retainForRecovery(message = 'Original delivery stopped. Saved local media is ready for a recovery file.'): Promise<void> {
    return this.stopIncomplete(message, true);
  }

  private async stopIncomplete(message: string, freeze: boolean): Promise<void> {
    if (this.failed || this._state.phase === 'complete' || this._state.phase === 'incomplete') return;
    this.failed = true;
    this.stopped = true;
    if (freeze && this.durable?.freeze) await this.durable.freeze();
    else this.durable?.cancel();
    
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch(e) {}
    }
    
    if (this.drainResolve) {
      this.drainResolve();
    }

    this.cleanup();
    this.updateState({ phase: 'incomplete', message });
  }
}
