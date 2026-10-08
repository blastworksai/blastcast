// CodexBWAI: a preview owns every acquired track until it stops or is superseded.
export type SourceErrors = { camera?: string; microphone?: string };
export type DeviceKind = 'camera' | 'microphone';
/** ClaudeBWAI — a device that stopped sending (its track muted): which one, so the studio can name it and offer Reconnect. */
export type DeviceNotice = { kind: DeviceKind; label: string; stillMuted: boolean };
export type PreviewState = { errors?: SourceErrors; notices?: DeviceNotice[]; phase: 'idle' | 'requesting' | 'live' | 'interrupted' | 'error'; message: string; denied?: true };
export type Selection = { camera: string; microphone: string; height: 1080 | 2160 | 'auto'; cameraEnabled?: boolean; microphoneEnabled?: boolean };

export function mediaError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const messages: Record<string, string> = {
    NotAllowedError: 'Camera or microphone access was denied. Allow BlastCast in your system privacy settings, then try again.',
    NotFoundError: 'No matching camera or microphone was found. Connect the selected device, refresh the list and try again.',
    NotReadableError: 'A device could not be opened. Close other apps using your camera or microphone, then try again.',
    OverconstrainedError: 'That device cannot use these settings. Choose another device or a lower resolution.',
    AbortError: 'The device stopped responding. Reconnect it and try again.',
    SecurityError: 'The system blocked device access. Check your camera and microphone privacy settings.',
  };
  return messages[name] ?? 'Preview could not start. Check your devices and try again.';
}

// Orientation-neutral: a portrait 2160x3840 camera passes the landscape 3840x2160 ceiling.
export function exceedsCeiling(settings: { width?: number; height?: number }, ceiling: { width: number; height: number }): boolean {
  const w = settings.width ?? 0, h = settings.height ?? 0;
  return Math.max(w, h) > ceiling.width || Math.min(w, h) > ceiling.height;
}

// ClaudeBWAI — einh 8 Oct, "Retry once at 1080": Safari on macOS refuses a 1080p camera (FaceTime HD) when max is set and ideal (4K) is out of its range; ideal 1080 with the same max is accepted.
export function relaxedVideo(c: MediaStreamConstraints): MediaStreamConstraints | null {
  const video = c.video;
  if (!video || typeof video !== 'object') return null;
  const range = (value: unknown, ideal: number): ConstrainULongRange => {
    const max = value && typeof value === 'object' ? (value as ConstrainULongRange).max : undefined;
    return max === undefined ? { ideal } : { ideal, max };
  };
  const width = range(video.width, 1920), height = range(video.height, 1080);
  // Nothing to relax when the request already asked for ideal 1080 (the host's 1080 setting): a retry would repeat it.
  if (JSON.stringify(width) === JSON.stringify(video.width) && JSON.stringify(height) === JSON.stringify(video.height)) return null;
  return { ...c, video: { ...video, width, height } };
}

export function constraints(selection: Selection): MediaStreamConstraints {
  if (selection.height !== 1080 && selection.height !== 2160 && selection.height !== 'auto') throw new Error('Unsupported resolution');
  const ceiling = selection.height === 1080 ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
  return {
    video: selection.cameraEnabled === false ? false : {
      ...(selection.camera ? { deviceId: { exact: selection.camera } } : {}),
      width: { ideal: ceiling.width, max: ceiling.width },
      height: { ideal: ceiling.height, max: ceiling.height },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: selection.microphoneEnabled === false ? false : {
      ...(selection.microphone ? { deviceId: { exact: selection.microphone } } : {}),
      echoCancellation: true, noiseSuppression: true,
    },
  };
}

// ClaudeBWAI — einh 3 Oct, "B: name + fix + button". The wording for a device whose track went quiet.
// A fresh track that arrives muted (or mutes right after a Reconnect) means the cause is outside BlastCast: say so.
// The host's own OS names where a device gets muted: einh's "Windows" wording on Windows, the equivalent elsewhere.
export type HostOs = 'windows' | 'macos' | 'linux';
export function hostOs(userAgent = globalThis.navigator?.userAgent ?? ''): HostOs { return /Mac OS X|Macintosh/.test(userAgent) ? 'macos' : /Linux|X11/.test(userAgent) ? 'linux' : 'windows'; }
const OS_WORDS: Record<HostOs, { short: string; sound: string; camera: string }> = {
  windows: { short: 'in Windows', sound: 'in Windows Sound settings', camera: 'in Windows camera settings' },
  macos: { short: 'in macOS', sound: 'in System Settings › Sound', camera: 'in System Settings › Privacy & Security › Camera' },
  linux: { short: 'in your system settings', sound: 'in your system sound settings', camera: 'in your system camera settings' },
};
export function deviceNoticeText(notice: DeviceNotice, os: HostOs = hostOs()): string {
  const label = notice.label.trim(), w = OS_WORDS[os];
  if (notice.kind === 'microphone') return notice.stillMuted
    ? `Still no sound from ${label || 'your microphone'}. Check that it isn't muted ${w.sound} and that no other app is using it exclusively.`
    : `Your microphone${label ? ` (${label})` : ''} stopped sending sound — it may be muted ${w.short} or in use by another app.`;
  return notice.stillMuted
    ? `Still no video from ${label || 'your camera'}. Check that it isn't turned off ${w.camera} and that no other app is using it exclusively.`
    : `Your camera${label ? ` (${label})` : ''} stopped sending video — it may be turned off ${w.short} or in use by another app.`;
}
export function reconnectLabel(kind: DeviceKind): string { return kind === 'microphone' ? 'Reconnect microphone' : 'Reconnect camera'; }
const kindOf = (track: MediaStreamTrack): DeviceKind => track.kind === 'video' ? 'camera' : 'microphone';
/** A mute this soon after a Reconnect counts as the fresh track also being muted. */
const STILL_MUTED_WINDOW_MS = 5000;
export type PreviewOptions = {
  /** Studio: name the muted device (deviceNoticeText) and publish notices. Off keeps the guest page's generic wording. */
  deviceNotices?: boolean;
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  now?: () => number;
};

export class Preview {
  microphoneMuted = false;

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted;
    this.current?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    // ClaudeBWAI — Codex review of 68ea271 (P1): a microphone replaced mid-take still feeds the host original until that
    // original finishes, so Mute must silence it too (otherwise the original keeps recording speech while the UI says Muted).
    for (const track of this.retained) if (track.kind === 'audio') track.enabled = !muted;
    this.changed(this.state, this.current);
  }

  /** ClaudeBWAI — tracks handed back by setDevice({ retain }) that still feed a running original; Mute follows them. */
  private retained = new Set<MediaStreamTrack>();
  /** Stop and forget retained tracks once nothing records them any more. */
  releaseRetained(): void {
    for (const track of this.retained) track.stop();
    this.retained.clear();
  }

  private generation = 0;
  private current: MediaStream | null = null;
  private pending = new Set<MediaStream>();
  private errors: SourceErrors = {};
  private notices: Partial<Record<DeviceKind, DeviceNotice>> = {};
  private independent = false;
  private kindGeneration: Record<DeviceKind, number> = { camera: 0, microphone: 0 };
  private reconnectedAt = new Map<MediaStreamTrack, number>();
  state: PreviewState = { phase: 'idle', message: 'Your camera and microphone are off.' };
  private readonly createStream: (tracks: MediaStreamTrack[]) => MediaStream;
  private readonly now: () => number;

  constructor(
    private readonly acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
    private readonly changed: (state: PreviewState, stream: MediaStream | null) => void,
    private readonly options: PreviewOptions = {},
  ) {
    this.createStream = options.createStream ?? (tracks => new MediaStream(tracks));
    this.now = options.now ?? (() => Date.now());
  }

  private release(): void {
    this.current?.getTracks().forEach(track => track.stop());
    this.current = null;
    for (const stream of this.pending) stream.getTracks().forEach(track => track.stop());
    this.pending.clear();
  }

  private publish(phase: PreviewState['phase'], message: string): void {
    const notices = Object.values(this.notices);
    this.state = { phase, message, ...(Object.keys(this.errors).length ? { errors: { ...this.errors } } : {}),
      ...(notices.length ? { notices: notices.map(notice => ({ ...notice })) } : {}) };
    this.changed(this.state, this.current);
  }

  stop(message = 'Preview stopped. Your camera and microphone are off.'): void {
    this.generation++;
    this.release();
    this.errors = {}; this.notices = {};
    this.publish('idle', message);
  }

  // ClaudeBWAI — 'interrupted' while any owned track is muted, else 'live'; the message names each quiet device.
  private publishCurrent(): void {
    const tracks = this.current?.getTracks() ?? [];
    if (!tracks.length) { this.publish(Object.keys(this.errors).length ? 'error' : 'idle', Object.values(this.errors).join(' ') || 'Your camera and microphone are off.'); return; }
    if (tracks.some(track => track.muted)) {
      this.publish('interrupted', this.options.deviceNotices
        ? [...Object.values(this.notices).map(notice => deviceNoticeText(notice)), ...Object.values(this.errors)].join(' ')
        : 'A device is temporarily unavailable. Check its privacy switch or other apps.');
    } else this.publish('live', this.liveMessage());
  }

  private noticeFor(track: MediaStreamTrack): DeviceNotice {
    const at = this.reconnectedAt.get(track);
    return { kind: kindOf(track), label: track.label ?? '', stillMuted: at !== undefined && this.now() - at <= STILL_MUTED_WINDOW_MS };
  }

  /** Mute, unmute and end handling for one track; every handler ignores a track this preview no longer owns. */
  private watch(track: MediaStreamTrack): void {
    const owned = () => Boolean(this.current?.getTracks().includes(track));
    track.addEventListener('ended', () => {
      if (!owned()) return;
      const kind = kindOf(track);
      delete this.notices[kind];
      if (this.independent) {
        this.current!.removeTrack(track);
        track.stop();
        this.errors[kind] = `${kind === 'camera' ? 'Camera' : 'Microphone'} disconnected. Reconnect it and enable it again.`;
        this.publish(this.current!.getTracks().length ? 'live' : 'error', Object.values(this.errors).join(' '));
        return;
      }
      this.generation++;
      this.release();
      this.publish('error', 'A device disconnected or access was revoked. Reconnect it, refresh devices and try again.');
    });
    track.addEventListener('mute', () => {
      if (!owned()) return;
      this.notices[kindOf(track)] = this.noticeFor(track);
      this.publishCurrent();
    });
    track.addEventListener('unmute', () => {
      if (!owned()) return;
      delete this.notices[kindOf(track)];
      this.publishCurrent();
    });
  }

  /**
   * ClaudeBWAI — turn ONE device on, off or restart it (Reconnect) while the other device's track keeps running untouched.
   * The result is a new stream object holding the untouched track plus the new one, so nothing that recorded the old
   * stream sees its track set change. Replaced tracks are stopped, or handed back in `retired` when `retain` is set
   * (a running original still holds them; stopping one would end that original).
   */
  async setDevice(kind: DeviceKind, selection: Selection, authorize: () => Promise<boolean>,
    options: { retain?: boolean | (() => boolean); reconnect?: boolean } = {}): Promise<{ retired: MediaStreamTrack[] }> {
    const current = this.current;
    if (!current || this.state.phase === 'requesting') { await this.start(selection, authorize); return { retired: [] }; }
    const generation = this.generation, attempt = ++this.kindGeneration[kind];
    const trackKind = kind === 'camera' ? 'video' : 'audio';
    const enabled = kind === 'camera' ? selection.cameraEnabled !== false : selection.microphoneEnabled !== false;
    const stale = () => generation !== this.generation || attempt !== this.kindGeneration[kind] || this.current !== current;
    let fresh: MediaStreamTrack | null = null;
    if (enabled) {
      let acquired: MediaStream | null = null;
      try {
        if (!await authorize()) throw new DOMException('Access was not granted.', 'NotAllowedError');
        if (stale()) return { retired: [] };
        const requested = constraints({ ...selection, cameraEnabled: kind === 'camera', microphoneEnabled: kind === 'microphone' });
        acquired = await this.acquireWithRetry({ video: kind === 'camera' ? requested.video : false, audio: kind === 'microphone' ? requested.audio : false }, stale);
        if (stale()) { acquired.getTracks().forEach(track => track.stop()); return { retired: [] }; }
        for (const track of acquired.getTracks()) if (track.kind !== trackKind) track.stop();
        fresh = acquired.getTracks().find(track => track.kind === trackKind) ?? null;
        if (!fresh || fresh.readyState !== 'live') throw new Error('Selected device is not live');
        const settings = fresh.getSettings?.() ?? {};
        const ceiling = selection.height === 1080 ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
        if (exceedsCeiling(settings, ceiling))
          throw new Error('Camera exceeded the selected ceiling');
      } catch (error) {
        acquired?.getTracks().forEach(track => track.stop());
        if (stale()) return { retired: [] };
        // A failed Reconnect keeps the quiet track (and its notice); a failed turn-on adds nothing.
        this.errors[kind] = `${kind === 'camera' ? 'Camera' : 'Microphone'}: ${mediaError(error)}`;
        this.publishCurrent();
        return { retired: [] };
      }
    }
    const kept = current.getTracks().filter(track => track.kind !== trackKind);
    const replaced = current.getTracks().filter(track => track.kind === trackKind);
    const tracks = [...kept, ...(fresh ? [fresh] : [])].sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1);
    delete this.errors[kind]; delete this.notices[kind];
    for (const track of replaced) this.reconnectedAt.delete(track);
    if (fresh) {
      if (fresh.kind === 'audio') fresh.enabled = !this.microphoneMuted;
      if (options.reconnect) this.reconnectedAt.set(fresh, this.now());
      this.watch(fresh);
      if (fresh.muted) this.notices[kind] = { kind, label: fresh.label ?? '', stillMuted: Boolean(options.reconnect) };
    }
    this.independent = true;
    this.current = tracks.length ? this.createStream(tracks) : null;
    // ClaudeBWAI — Codex review of 68ea271 (P2): decided now, at the swap, not when the acquisition started: Record may have
    // been pressed meanwhile, and the replaced track then feeds the new original.
    const retain = typeof options.retain === 'function' ? options.retain() : Boolean(options.retain);
    if (retain) for (const track of replaced) { if (track.kind === 'audio') track.enabled = !this.microphoneMuted; this.retained.add(track); }
    else replaced.forEach(track => track.stop());
    if (!this.current) { this.errors = {}; this.notices = {}; this.publish('idle', 'Your camera and microphone are off.'); }
    else this.publishCurrent();
    return { retired: retain ? replaced : [] };
  }


  private liveMessage(): string {
    return Object.values(this.errors).join(' ') || 'Sources are active. Nothing is being recorded.';
  }

  private async acquireWithRetry(c: MediaStreamConstraints, stale: () => boolean): Promise<MediaStream> {
    try { return await this.acquire(c); } catch (error) {
      const e = error as { name?: string; constraint?: string };
      const retry = e?.name === 'OverconstrainedError' && (e.constraint === 'width' || e.constraint === 'height') ? relaxedVideo(c) : null;
      // A preview stopped or superseded while the first ask was pending must not open the camera again.
      if (!retry || stale()) throw error;
      return this.acquire(retry);
    }
  }

  // Explicit host toggles isolate failures: an unavailable camera cannot silence a mic.
  private async acquireIndependent(selection: Selection, generation: number): Promise<MediaStream | null> {
    const requested = constraints(selection);
    const results = await Promise.all((['camera', 'microphone'] as const).map(async source => {
      const kind = source === 'camera' ? 'video' : 'audio';
      if (!requested[kind]) return null;
      let stream: MediaStream | null = null;
      try {
        stream = await this.acquireWithRetry({ video: kind === 'video' ? requested.video : false, audio: kind === 'audio' ? requested.audio : false }, () => generation !== this.generation);
        if (generation !== this.generation) {
          stream.getTracks().forEach(track => track.stop());
          return null;
        }
        // Never retain a device which the caller did not enable.
        for (const track of stream.getTracks()) {
          if (track.kind !== kind) { track.stop(); stream.removeTrack(track); }
        }
        const tracks = stream.getTracks();
        if (!tracks.length || tracks.some(track => track.readyState !== 'live')) throw new Error('Selected device is not live');
        const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
        const ceiling = selection.height === 1080 ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
        if (exceedsCeiling(settings, ceiling)) throw new Error('Camera exceeded the selected ceiling');
        this.pending.add(stream);
        return stream;
      } catch (error) {
        stream?.getTracks().forEach(track => track.stop());
        if (generation === this.generation) this.errors[source] = `${source === 'camera' ? 'Camera' : 'Microphone'}: ${mediaError(error)}`;
        return null;
      }
    }));
    if (generation !== this.generation) return null;
    const streams = results.filter((stream): stream is MediaStream => stream !== null);
    const combined = streams[0];
    if (!combined) return null;
    for (const stream of streams) {
      this.pending.delete(stream);
      if (stream !== combined) stream.getTracks().forEach(track => combined.addTrack(track));
    }
    return combined;
  }

  async start(selection: Selection, authorize: () => Promise<boolean>): Promise<void> {
    const generation = ++this.generation;
    this.release();
    this.errors = {};
    if (selection.cameraEnabled === false && selection.microphoneEnabled === false) {
      this.publish('idle', 'Your camera and microphone are off.');
      return;
    }
    const independent = selection.cameraEnabled !== undefined || selection.microphoneEnabled !== undefined;
    this.independent = independent;
    this.notices = {};
    this.publish('requesting', 'Waiting for device access…');
    try {
      const allowed = await authorize();
      if (generation !== this.generation) return;
      if (!allowed) {
        this.publish('idle', 'Access was not granted. Your devices are off. Try again when you are ready.');
        this.state = { ...this.state, denied: true }; // ClaudeBWAI — lets the studio explain a macOS denial visibly
        this.changed(this.state, this.current);
        return;
      }
      const stream = independent
        ? await this.acquireIndependent(selection, generation)
        : await this.acquireWithRetry(constraints(selection), () => generation !== this.generation);
      if (!stream) {
        if (generation === this.generation) this.publish('error', Object.values(this.errors).join(' '));
        return;
      }
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      stream.getAudioTracks().forEach(track => { track.enabled = !this.microphoneMuted; });
      this.current = stream;
      const video = stream.getVideoTracks()[0];
      const audio = stream.getAudioTracks()[0];
      if ((!independent && (!video || !audio)) || stream.getTracks().some(track => track.readyState !== 'live')) {
        throw new Error('Both devices must be live');
      }
      const settings = video?.getSettings() ?? {};
      const ceiling = selection.height === 1080 ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
      if (exceedsCeiling(settings, ceiling)) { // orientation-neutral: portrait passes the landscape ceiling
        throw new Error('Camera exceeded the selected ceiling');
      }
      for (const track of stream.getTracks()) {
        this.watch(track);
        if (track.muted) this.notices[kindOf(track)] = this.noticeFor(track);
      }
      this.publishCurrent();
    } catch (error) {
      if (generation !== this.generation) return;
      this.release();
      this.publish('error', mediaError(error));
    }
  }
}
