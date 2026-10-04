// CodexBWAI — source capture follows host commands; it always uses this device's Preview stream.
import { IndexedSourceQueue, SourceOutbox, type SourceRecoveryBinding } from './source-outbox.js';
import { writeSourceRecovery, type SourceRecoveryIdentity, type SourceRecoveryWriter } from './source-recovery.js';
import { SourceCapture } from './source-capture.js';
import type { SourceCaptureState, SourceControl, SourceTransport } from './source-protocol.js';
export class SourceSession {
  private stream: MediaStream | null = null;
  private enabled = false;
  private capture: SourceCapture | null = null;
  private attemptedEpisode = '';
  private generation = 0;
  private polling = false;
  private destroyed = false;
  private saving = false;
  private recoveryIdentity: SourceRecoveryIdentity | null = null;
  private timer: ReturnType<typeof setInterval>;
  constructor(private control: () => Promise<SourceControl>, private transport: SourceTransport,
    private changed: (state: SourceCaptureState) => void, private message: (text: string) => void, private durable = false, private options: { allowPartialSource?: boolean; uplink?: () => Promise<{ availableBps: number | null; callCapBps: number } | null> } = {}) {
    this.timer = setInterval(() => void this.poll(), 500);
  }
  get busy(): boolean { return this.capture?.busy ?? false; }
  get state(): SourceCaptureState | null { return this.capture?.state ?? null; }
  get canSaveRecovery(): boolean {
    const state = this.capture?.state;
    return Boolean(this.durable && this.recoveryIdentity && state?.episodeId === this.recoveryIdentity.episodeId &&
      state.phase !== 'idle' && state.phase !== 'complete' && !this.saving);
  }
  update(enabled: boolean, stream: MediaStream | null): void {
    if (this.enabled === enabled && this.stream === stream) return;
    this.generation++;
    if (this.capture?.busy) void this.capture.fail('Your original was interrupted. Saved partial media is kept; this original is incomplete.');
    if (stream !== this.stream) this.attemptedEpisode = '';
    this.enabled = enabled; this.stream = stream;
    if (enabled && stream) void this.poll();
  }
  async poll(): Promise<void> {
    if (this.polling || this.destroyed || !this.enabled) return;
    this.polling = true; const generation = this.generation;
    const before = performance.now();
    try {
      const reply = await this.control();
      const after = performance.now();
      if (generation !== this.generation || this.destroyed) return;
      if (!reply.ok) throw new Error('Original status unavailable');
      const episode = reply.episode;
      if (this.capture?.busy && (!episode || episode.episodeId !== this.capture.state.episodeId || episode.phase !== 'recording')) {
        if (episode?.phase === 'closed' || episode?.episodeId !== this.capture.state.episodeId) {
          void this.capture.fail('The host finished this episode. Any unreceived original remains incomplete.');
        } else void this.capture.stop();
      }
      if (!episode) { this.message('Original recording starts when the host presses Record.'); return; }
      if (!episode.eligible) { this.message('You joined after recording started. Your original can start with the next episode.'); return; }
      if (episode.phase !== 'recording' || !this.stream || this.capture?.busy || this.attemptedEpisode === episode.episodeId) return;
      this.attemptedEpisode = episode.episodeId;
      let binding: SourceRecoveryBinding | null = null;
      if (this.durable) {
        if (!/^[A-Za-z0-9_-]{22}$/.test(episode.participantId) || !episode.recoveryKey || !/^[A-Za-z0-9_-]{43}$/.test(episode.recoveryKey)) {
          throw new Error('Recovery identity unavailable');
        }
        binding = { participantId:episode.participantId,recoveryKey:episode.recoveryKey };
        this.recoveryIdentity = { ...binding,episodeId:episode.episodeId };
      }
      let capture: SourceCapture;
      capture = new SourceCapture({ transport: this.transport, allowPartialSource: this.options.allowPartialSource, uplink: this.options.uplink,
        durable: this.durable ? (progress, failed) => new SourceOutbox({store:new IndexedSourceQueue(undefined,undefined,binding), transport:this.transport,progress,failed}) : undefined, onState: state => {
        if (this.capture === capture) this.changed(state);
      } });
      this.capture = capture;
      await capture.start(this.stream, { episodeId: episode.episodeId, epochId: crypto.randomUUID(),
        clock: { hostNowMs: episode.hostNowMs, localMonoMs: (before + after) / 2, uncertaintyMs: (after - before) / 2 } });
    } catch { if (generation === this.generation) this.message('Original status is unavailable. Keep this page open while your original saves and delivery retries.'); }
    finally { this.polling = false; }
  }
  async saveRecovery(writer: SourceRecoveryWriter): Promise<{ epochs: number; chunks: number; bytes: number }> {
    if (!this.canSaveRecovery || !this.recoveryIdentity) throw new Error('No retained recovery data is available for this episode.');
    this.saving = true;
    const identity = this.recoveryIdentity;
    try {
      if (this.capture?.busy) await this.capture.retainForRecovery();
      const queue = new IndexedSourceQueue();
      try { return await writeSourceRecovery(queue,identity,writer); }
      finally { queue.close(); }
    } finally { this.saving = false; }
  }
  close(): void {
    this.destroyed = true; this.generation++; clearInterval(this.timer);
    if (this.capture?.busy) void this.capture.fail('This page closed before the original completed. Saved media is retained; the original is incomplete.');
  }
}
