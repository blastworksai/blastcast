// CodexBWAI: a preview owns every acquired track until it stops or is superseded.
export type SourceErrors = { camera?: string; microphone?: string };
export type PreviewState = { errors?: SourceErrors; phase: 'idle' | 'requesting' | 'live' | 'interrupted' | 'error'; message: string };
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

export class Preview {
  microphoneMuted = false;

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted;
    this.current?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.changed(this.state, this.current);
  }

  private generation = 0;
  private current: MediaStream | null = null;
  private pending = new Set<MediaStream>();
  private errors: SourceErrors = {};
  state: PreviewState = { phase: 'idle', message: 'Your camera and microphone are off.' };

  constructor(
    private readonly acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
    private readonly changed: (state: PreviewState, stream: MediaStream | null) => void,
  ) {}

  private release(): void {
    this.current?.getTracks().forEach(track => track.stop());
    this.current = null;
    for (const stream of this.pending) stream.getTracks().forEach(track => track.stop());
    this.pending.clear();
  }

  private publish(phase: PreviewState['phase'], message: string): void {
    this.state = { phase, message, ...(Object.keys(this.errors).length ? { errors: { ...this.errors } } : {}) };
    this.changed(this.state, this.current);
  }

  stop(message = 'Preview stopped. Your camera and microphone are off.'): void {
    this.generation++;
    this.release();
    this.errors = {};
    this.publish('idle', message);
  }


  private liveMessage(): string {
    return Object.values(this.errors).join(' ') || 'Sources are active. Nothing is being recorded.';
  }

  // Explicit host toggles isolate failures: an unavailable camera cannot silence a mic.
  private async acquireIndependent(selection: Selection, generation: number): Promise<MediaStream | null> {
    const requested = constraints(selection);
    const results = await Promise.all((['camera', 'microphone'] as const).map(async source => {
      const kind = source === 'camera' ? 'video' : 'audio';
      if (!requested[kind]) return null;
      let stream: MediaStream | null = null;
      try {
        stream = await this.acquire({ video: kind === 'video' ? requested.video : false, audio: kind === 'audio' ? requested.audio : false });
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
        if ((settings.width ?? 0) > ceiling.width || (settings.height ?? 0) > ceiling.height) throw new Error('Camera exceeded the selected ceiling');
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
    this.publish('requesting', 'Waiting for device access…');
    try {
      const allowed = await authorize();
      if (generation !== this.generation) return;
      if (!allowed) {
        this.publish('idle', 'Access was not granted. Your devices are off. Try again when you are ready.');
        return;
      }
      const stream = independent
        ? await this.acquireIndependent(selection, generation)
        : await this.acquire(constraints(selection));
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
      if ((settings.width ?? 0) > ceiling.width || (settings.height ?? 0) > ceiling.height) {
        throw new Error('Camera exceeded the selected ceiling');
      }
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (generation !== this.generation) return;
          if (independent) {
            stream.removeTrack(track);
            track.stop();
            this.errors[track.kind === 'video' ? 'camera' : 'microphone'] = `${track.kind === 'video' ? 'Camera' : 'Microphone'} disconnected. Reconnect it and enable it again.`;
            this.publish(stream.getTracks().length ? 'live' : 'error', Object.values(this.errors).join(' '));
            return;
          }
          this.generation++;
          this.release();
          this.publish('error', 'A device disconnected or access was revoked. Reconnect it, refresh devices and try again.');
        });
        track.addEventListener('mute', () => {
          if (generation === this.generation) this.publish('interrupted', 'A device is temporarily unavailable. Check its privacy switch or other apps.');
        });
        track.addEventListener('unmute', () => {
          if (generation === this.generation && stream.getTracks().every(track => !track.muted)) this.publish('live', this.liveMessage());
        });
      }
      if (stream.getTracks().some(track => track.muted)) {
        this.publish('interrupted', 'A device is temporarily unavailable. Check its privacy switch or other apps.');
      } else this.publish('live', this.liveMessage());
    } catch (error) {
      if (generation !== this.generation) return;
      this.release();
      this.publish('error', mediaError(error));
    }
  }
}
