// CodexBWAI — explicit, video-only display consent with cancellation-safe ownership.
export class ScreenShare {
  private current: MediaStream | null = null;
  private generation = 0;
  private pending = false;
  constructor(private acquire: () => Promise<MediaStream>,
    private changed: (stream: MediaStream | null, message: string) => void) {}
  get stream(): MediaStream | null { return this.current; }
  get busy(): boolean { return this.pending; }
  async start(): Promise<void> {
    if (this.pending || this.current) return;
    const generation = ++this.generation;
    this.pending = true;
    this.changed(null, 'Choose a screen or window to share.');
    try {
      const stream = await this.acquire();
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      // Video only: an implementation returning unexpected audio must never leak it.
      stream.getAudioTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') {
        stream.getTracks().forEach(value => value.stop());
        throw new Error('No live display track');
      }
      this.current = stream;
      track.addEventListener('ended', () => { if (this.current === stream) this.stop(); }, { once: true });
      this.changed(stream, 'Screen sharing is on. The host may include it in the mixed recording.');
    } catch {
      if (generation === this.generation) this.changed(null, 'Screen sharing did not start. The picker may have been cancelled or access denied.');
    } finally { if (generation === this.generation) this.pending = false; }
  }
  stop(): void {
    ++this.generation; this.pending = false;
    const previous = this.current; this.current = null;
    previous?.getTracks().forEach(track => track.stop());
    this.changed(null, 'Screen sharing is off.');
  }
}
export function showScreen(video: HTMLVideoElement, stream: MediaStream | null): void {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.hidden = !stream; video.muted = true;
  if (stream) void video.play().catch(() => {});
  else video.pause();
}
