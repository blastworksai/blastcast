// CodexBWAI — guest-only metering. Never changes, records or plays the input track.
export class GuestMeter {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private track: MediaStreamTrack | null = null;
  private frame = 0;
  private lastSignal = 0;
  private resumeFailed = false;
  private previousMessage = '';

  constructor(
    private readonly level: (value: number) => void,
    private readonly message: (value: string) => void,
    private readonly muted: () => boolean,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Call synchronously from Retry/Join/Unmute, before awaiting permissions. */
  unlock(): void {
    try {
      const context = this.context ??= this.createContext();
      this.resumeFailed = false;
      void context.resume().catch(() => {
        if (this.context === context) { this.resumeFailed = true; this.report('Microphone meter could not start. Use Retry camera & microphone. Audio delivery is not verified.'); }
      });
    } catch {
      this.report('Microphone meter is unavailable in this browser. Audio delivery is not verified.');
    }
  }

  clear(): void {
    cancelAnimationFrame(this.frame);
    this.source?.disconnect(); this.analyser?.disconnect();
    this.source = null; this.analyser = null; this.track = null;
    this.level(0);
    this.report('Microphone input is off.');
  }

  close(): void {
    this.clear();
    const context = this.context; this.context = null;
    if (context) void context.close().catch(() => { /* Context is detached; it cannot publish or retain a stream. */ });
  }

  attach(stream: MediaStream): void {
    this.clear();
    if (!this.context) this.unlock();
    const context = this.context;
    if (!context) return;
    this.track = stream.getAudioTracks()[0] ?? null;
    try {
      this.source = context.createMediaStreamSource(stream);
      const analyser = this.analyser = context.createAnalyser();
      analyser.fftSize = 256;
      this.source.connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      this.lastSignal = this.now();
      const tick = () => {
        if (this.context !== context || this.analyser !== analyser) return;
        const track = this.track;
        const paused = context.state !== 'running' || this.resumeFailed;
        let level = 0;
        if (track?.readyState === 'live' && !track.muted && !this.muted() && !paused) {
          analyser.getByteTimeDomainData(values);
          level = Math.min(100, Math.sqrt(values.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / values.length) * 300);
        }
        if (level > 0.5) this.lastSignal = this.now();
        this.level(level);
        this.report(this.muted() ? 'Microphone is muted in BlastCast.'
          : !track || track.readyState !== 'live' ? 'Microphone stopped. Use Retry camera & microphone.'
          : track.muted ? 'The browser has interrupted microphone input. Close other apps using it, then retry.'
          : paused ? 'Microphone meter is paused by the browser. Use Retry camera & microphone. Audio delivery is not verified.'
          : this.now() - this.lastSignal >= 5000 ? 'No microphone signal detected. Speak to test; if this stays flat, choose another microphone and retry.'
          : level > 0.5 ? 'Microphone signal detected on this device. This does not verify audio reaching the host.'
          : 'Speak to check microphone input.');
        this.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      this.clear();
      this.report('Microphone meter is unavailable in this browser. Audio delivery is not verified.');
    }
  }

  private report(value: string): void {
    if (value !== this.previousMessage) { this.previousMessage = value; this.message(value); }
  }
}
