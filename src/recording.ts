// CodexBWAI — capture queue is capped; media is acknowledged only after disk sync.
import type { DesktopBridge, RecordingResult } from './bridge.js';
export const MAX_CHUNK = 8 * 1024 * 1024;
export const MAX_PENDING = 16 * 1024 * 1024;
export const RECORDING_MIME_TYPE = 'video/webm;codecs=vp8,opus'; // ClaudeBWAI — named so the diagnostics log reports the same codec.
export function recordingVideoBitrate(stream: Pick<MediaStream, 'getVideoTracks'>): number {
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  return (settings.width ?? 0) >= 3000 || (settings.height ?? 0) >= 2000 ? 24000000 : 6000000;
}
export type RecordingState = { phase: 'idle' | 'starting' | 'recording' | 'finalizing' | 'complete' | 'error'; episodeId: string | null; message: string; pendingBytes: number; peakBytes: number };
export class Recording {
  state: RecordingState = { phase: 'idle', episodeId: null, message: 'Ready to record the selected scene and mixed audio.', pendingBytes: 0, peakBytes: 0 };
  private recorder: MediaRecorder | null = null;
  private id: string | null = null;
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private reason = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finished: Promise<void> = Promise.resolve();
  private finishResolve: (() => void) | null = null;
  constructor(private readonly bridge: DesktopBridge, private readonly changed: (state: RecordingState) => void,
    private readonly make: (stream: MediaStream) => MediaRecorder = stream => {
      const mimeType = RECORDING_MIME_TYPE;
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('WebM recording is unavailable in this runtime.');
      return new MediaRecorder(stream, { mimeType, videoBitsPerSecond: recordingVideoBitrate(stream), audioBitsPerSecond: 128000 });
    }) {}
  get busy(): boolean { return ['starting', 'recording', 'finalizing'].includes(this.state.phase); }
  private publish(phase: RecordingState['phase'], message: string): void {
    this.state = { ...this.state, phase, message }; this.changed(this.state);
  }
  private require(result: RecordingResult): void { if (!result.ok) throw new Error(result.message); }
  async start(stream: MediaStream): Promise<void> {
    if (this.busy) return;
    this.reason = ''; this.sequence = 0; this.id = null; this.tail = Promise.resolve();
    this.state = { ...this.state, episodeId: null, pendingBytes: 0, peakBytes: 0 };
    this.publish('starting', 'Opening recording file…');
    this.finished = new Promise(resolve => { this.finishResolve = resolve; });
    try {
      const begin = await this.bridge.beginRecording(); this.require(begin);
      if (!begin.ok || !begin.id) throw new Error('Recording file could not open.');
      this.id = begin.id;
      this.state = { ...this.state, episodeId: begin.id };
      if (this.reason || stream.getTracks().some(track => track.readyState !== 'live')) throw new Error(this.reason || 'A recording device stopped.');
      this.recorder = this.make(stream);
      this.recorder.ondataavailable = event => this.enqueue(event.data);
      this.recorder.onerror = () => { void this.fail('Media capture failed. Partial files are retained.'); };
      this.recorder.onstop = () => { void this.finalize(); };
      this.recorder.start(250);
      this.timer = setTimeout(() => { void this.stop(); }, 2 * 60 * 60 * 1000);
      this.publish('recording', 'Recording on this computer. Microphone mute applies to the saved audio.');
    } catch (error) {
      this.reason = error instanceof Error ? error.message : 'Recording could not start.';
      if (this.id) { try { await this.bridge.abortRecording(this.id); } catch { /* below stays failed */ } }
      this.recorder = null; this.publish('error', this.reason); this.finishResolve?.();
    }
  }
  private enqueue(blob: Blob): void {
    if (!blob.size || this.reason) return;
    if (blob.size > MAX_CHUNK || this.state.pendingBytes + blob.size > MAX_PENDING) {
      void this.fail('The drive could not keep up with capture. Recording stopped; partial files are retained.'); return;
    }
    this.state.pendingBytes += blob.size;
    this.state.peakBytes = Math.max(this.state.peakBytes, this.state.pendingBytes);
    this.tail = this.tail.then(async () => {
      if (this.reason) return;
      const bytes = await blob.arrayBuffer();
      this.require(await this.bridge.appendRecording(this.id!, this.sequence++, bytes));
    }).catch(error => { void this.fail(error instanceof Error ? error.message : 'Saving failed.'); })
      .finally(() => { this.state.pendingBytes -= blob.size; });
  }
  async fail(message: string): Promise<void> {
    if (!this.busy) return;
    this.reason ||= message;
    if (this.state.phase !== 'starting') await this.stop();
  }
  async stop(): Promise<void> {
    if (!this.busy) return;
    if (this.state.phase === 'starting') return this.finished;
    if (this.state.phase === 'recording') {
      clearTimeout(this.timer);
      this.publish('finalizing', 'Finishing the recording. Keep BlastCast and the drive connected…');
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    }
    return this.finished;
  }
  private async finalize(): Promise<void> {
    clearTimeout(this.timer);
    if (this.state.phase === 'recording') this.reason ||= 'Capture stopped unexpectedly. Partial files are retained.';
    this.publish('finalizing', 'Draining saved media and building the playback index…');
    try {
      await this.tail;
      if (this.reason) { await this.bridge.abortRecording(this.id!); throw new Error(this.reason); }
      const result = await this.bridge.finishRecording(this.id!); this.require(result);
      this.publish('complete', result.ok ? `Saved ${result.name}. ${result.warning ?? 'Open the recording to play it independently.'}` : '');
    } catch (error) {
      try { await this.bridge.abortRecording(this.id!); } catch { /* original failure remains visible */ }
      this.publish('error', error instanceof Error ? error.message : 'Recording failed. Partial files are retained.');
    } finally { this.recorder = null; this.finishResolve?.(); }
  }
}
