export class HostAudioMixer {
  // CodexBWAI: closing is synchronous from the caller's perspective, even
  // while the browser releases its audio device asynchronously.
  private closed = false;
  private closing: Promise<void> | null = null;
  private ctx: AudioContext;
  private mixedDestination: MediaStreamAudioDestinationNode;
  private hostSource: MediaStreamAudioSourceNode | null = null;
  private monitor: GainNode;
  private mutedGuests = new Set<string>();
  
  private guests = new Map<string, {
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    analyzer: AnalyserNode;
    gainNode: GainNode;
  }>();
  
  private storedGainDb = new Map<string, number>();

  constructor(hostStream: MediaStream) {
    this.ctx = new AudioContext();
    this.monitor = this.ctx.createGain();
    this.monitor.connect(this.ctx.destination);
    let destination: MediaStreamAudioDestinationNode | undefined;
    try {
      destination = this.ctx.createMediaStreamDestination();
      this.mixedDestination = destination;
      
      // Host microphone goes to the mixed destination only, never host speakers.
      if (hostStream.getAudioTracks().length) {
        this.hostSource = this.ctx.createMediaStreamSource(hostStream);
        this.hostSource.connect(this.mixedDestination);
      }
    } catch (e) {
      destination?.stream.getTracks().forEach(track => track.stop());
      this.ctx.close().catch(() => {});
      throw e;
    }
  }

  async resume(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("AudioContext is closed"));
    }
    await this.ctx.resume();
    if (this.closed || this.ctx.state !== 'running') throw new Error('Audio is paused. Enable call audio to retry.');
  }

  private dbToGain(db: number): number {
    return Math.pow(10, db / 20);
  }

  /**
   * Adds a guest stream.
   * To replace an existing guest, you must call removeGuest first.
   * Gain preference is retained across replacement.
   */
  addGuest(id: string, originalStream: MediaStream): void {
    if (this.closed) {
      throw new Error("AudioContext is closed");
    }
    if (this.guests.has(id)) {
      throw new Error(`Guest ${id} already added`);
    }

    const owned: AudioNode[] = [];
    try {
      const source = this.ctx.createMediaStreamSource(originalStream); owned.push(source);
      const analyzer = this.ctx.createAnalyser(); owned.push(analyzer);
      analyzer.fftSize = 2048;
      source.connect(analyzer); // Meter the original input, before attenuation.
      const gainNode = this.ctx.createGain(); owned.push(gainNode);
      gainNode.gain.value = this.mutedGuests.has(id) ? 0 : this.dbToGain(this.storedGainDb.get(id) ?? 0);
      source.connect(gainNode);
      gainNode.connect(this.monitor);
      gainNode.connect(this.mixedDestination);
      this.guests.set(id, { stream: originalStream, source, analyzer, gainNode });
    } catch (error) {
      owned.forEach(node => node.disconnect());
      throw error;
    }
  }

  removeGuest(id: string): void {
    if (this.closed) return;
    const guest = this.guests.get(id);
    if (!guest) return;

    // Removing disconnects owned nodes
    guest.source.disconnect();
    guest.analyzer.disconnect();
    guest.gainNode.disconnect();
    this.guests.delete(id);
  }

  setGainDb(id: string, db: number): void {
    if (this.closed) {
      throw new Error("AudioContext is closed");
    }
    if (typeof db !== 'number' || !Number.isFinite(db) || db < -60 || db > 0) {
      throw new RangeError("Invalid gain value");
    }
    if (!this.guests.has(id)) {
      throw new Error(`Guest ${id} not found`);
    }
    
    this.storedGainDb.set(id, db);
    const guest = this.guests.get(id);
    if (guest) {
      guest.gainNode.gain.value = this.mutedGuests.has(id) ? 0 : this.dbToGain(db);
    }
  }

  // CodexBWAI — listening is a separate branch from the saved mix.
  setMonitoring(enabled: boolean): void { this.monitor.gain.value = enabled ? 1 : 0; }
  setGuestMuted(id: string, muted: boolean): void {
    if (muted) this.mutedGuests.add(id); else this.mutedGuests.delete(id);
    const guest = this.guests.get(id);
    if (guest) guest.gainNode.gain.value = muted ? 0 : this.dbToGain(this.storedGainDb.get(id) ?? 0);
  }

  getGainDb(id: string): number {
    return this.storedGainDb.get(id) ?? 0;
  }

  getMixedStream(): MediaStream {
    if (this.closed) throw new Error('AudioContext is closed');
    return this.mixedDestination.stream;
  }

  getGuestSource(id: string): MediaStream | undefined {
    return this.guests.get(id)?.stream;
  }

  getLevels(): { id: string, rms: number, peak: number, clipped: boolean, gainDb: number }[] {
    if (this.closed) return [];
    const levels: { id: string, rms: number, peak: number, clipped: boolean, gainDb: number }[] = [];
    const dataArray = new Float32Array(2048);

    for (const [id, guest] of this.guests.entries()) {
      guest.analyzer.getFloatTimeDomainData(dataArray);
      let sumSquares = 0;
      let peak = 0;
      let clipped = false;

      for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i]!;
        sumSquares += val * val;
        const absVal = Math.abs(val);
        if (absVal > peak) peak = absVal;
        if (absVal >= 1.0) clipped = true; // Clipping is generally at 1.0/-1.0
      }

      const rms = Math.sqrt(sumSquares / dataArray.length);
      const gainDb = this.storedGainDb.get(id) ?? 0;

      levels.push({ id, rms, peak, clipped, gainDb });
    }

    return levels;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Closing stops only owned output tracks
    const tracks = this.mixedDestination.stream.getTracks();
    for (const track of tracks) {
      track.stop();
    }
    
    for (const [id, guest] of this.guests.entries()) {
      guest.source.disconnect();
      guest.analyzer.disconnect();
      guest.gainNode.disconnect();
    }
    this.guests.clear();
    
    this.hostSource?.disconnect();
    this.monitor.disconnect();
    this.closing = this.ctx.close();
    return this.closing;
  }
}
