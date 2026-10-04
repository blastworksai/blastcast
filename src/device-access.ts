// CodexBWAI — temporary device discovery owns its tracks; it never starts a preview/call.
type Kind = 'video' | 'audio';
type Options = {
  authorize: () => Promise<boolean>;
  acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  refresh: () => Promise<void | boolean>;
  canRequest: () => boolean;
  live: () => boolean;
  busy: (value: boolean) => void;
  message: (value: string, error?: boolean) => void;
  denied?: () => void; // ClaudeBWAI — studio explains a denial (macOS status + Open System Settings)
};
export class DeviceAccess {
  private flight: Promise<void> | null = null;
  private generation = 0;
  private tracks = new Set<MediaStreamTrack>();
  private ready = new Set<Kind>();
  constructor(private readonly options: Options) {}
  get busy(): boolean { return this.flight !== null; }
  cancel(): void { this.generation++; this.tracks.forEach(track => track.stop()); this.tracks.clear(); }
  bind(select: HTMLSelectElement, kind: Kind): void {
    const interact = (event: Event) => {
      if (select.disabled || this.options.live() || this.ready.has(kind)) return;
      if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || !['Enter',' ','ArrowDown','ArrowUp','Home','End'].includes(event.key) && event.key.length !== 1)) return;
      if (event instanceof PointerEvent && event.button !== 0) return;
      event.preventDefault();
      void this.prepare().then(() => { if (!select.disabled && select.isConnected) select.focus(); });
    };
    select.addEventListener('pointerdown', interact);
    select.addEventListener('keydown', interact);
    select.addEventListener('click', interact); // Assistive/synthetic clicks need the same explicit request.
  }
  prepare(): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.options.canRequest() || this.options.live()) return Promise.resolve();
    const generation = this.generation;
    // Defer work until flight is assigned, preventing a synchronous UI callback race.
    this.flight = Promise.resolve().then(async () => {
      this.options.message('Allow camera and microphone access to list devices. Preview stays off.');
      try {
        if (!await this.options.authorize()) {
          if (generation === this.generation) { if (this.options.denied) this.options.denied(); else this.options.message('Access was not granted. Open a device list to try again.', true); }
          return;
        }
        if (generation !== this.generation || !this.options.canRequest()) return;
        const failed: string[] = [];
        const acquired: Kind[] = [];
        for (const kind of ['video','audio'] as const) {
          if (this.ready.has(kind)) continue;
          try {
            const stream = await this.options.acquire({ video: kind === 'video', audio: kind === 'audio' });
            for (const track of stream.getTracks()) this.tracks.add(track);
            if (generation !== this.generation || !this.options.canRequest()) return;
            acquired.push(kind);
          } catch {
            failed.push(kind === 'video' ? 'camera' : 'microphone');
            if (generation !== this.generation) return;
          }
        }
        const refreshed = await this.options.refresh();
        if (refreshed === false) { this.options.message('Devices could not be listed. Open a device list to retry.', true); return; }
        if (generation !== this.generation) return;
        acquired.forEach(kind => this.ready.add(kind));
        this.options.message(failed.length
          ? `Could not access ${failed.join(' and ')}. Check device and privacy settings, then open that list to retry. Other available devices are listed; preview stays off.`
          : 'Devices are listed. Open the list again to choose a device. Preview stays off.', failed.length > 0);
      } catch {
        if (generation === this.generation) this.options.message('Device access could not be checked. Open a device list to retry.', true);
      } finally {
        this.tracks.forEach(track => track.stop()); this.tracks.clear();
        this.flight = null; this.options.busy(false);
      }
    });
    this.options.busy(true);
    return this.flight;
  }
}
