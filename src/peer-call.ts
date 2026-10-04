// ClaudeBWAI — lag fixes live here (not a new module) so the packaged asset list is unchanged.
// Cap what each call sender encodes. The recordings never go through these senders.
export type VideoCap = {
  /** Encoder ceiling in bits per second. */
  maxBitrate: number;
  /** Tallest picture to send; taller tracks are scaled down to it, shorter ones are left alone. */
  maxHeight: number;
  maxFramerate: number;
  /** Scale to use when the track does not report its height yet. */
  unknownScale?: number;
  /** ClaudeBWAI — measure maxHeight against the shorter side, so portrait and landscape get the same detail. */
  shortSide?: boolean;
};
/** Host to guest: a monitor view only. The program is recorded locally at full size. */
export const HOST_CALL_VIDEO_CAP: VideoCap = { maxBitrate: 600_000, maxHeight: 360, maxFramerate: 15, unknownScale: 3 };
/** Guest to host: the host draws the mix from this video, so it keeps 1080p. 4K cameras are halved. */
export const GUEST_CALL_VIDEO_CAP: VideoCap = { maxBitrate: 4_000_000, maxHeight: 1080, maxFramerate: 30 };
/** ClaudeBWAI — einh 3 Oct ("Phone-only fix in r8"): a phone guest's call video, so a mobile uplink keeps up. 720p measured on
 * the SHORT side (a portrait phone sends 720×1280), 24 fps, about 1.5 Mbps. The phone's local original is not affected. */
export const MOBILE_GUEST_CALL_VIDEO_CAP: VideoCap = { maxBitrate: 1_500_000, maxHeight: 720, maxFramerate: 24, shortSide: true };

type CappableSender = Pick<RTCRtpSender, 'getParameters' | 'setParameters'> & { track: MediaStreamTrack | null };

export function scaleFor(height: number | undefined, cap: VideoCap): number {
  if (!height || height <= 0) return cap.unknownScale ?? 1;
  return height > cap.maxHeight ? Math.round((height / cap.maxHeight) * 100) / 100 : 1;
}

/** Applies the cap to one video sender. Returns false (never throws) when the sender cannot take it yet. */
export async function applyVideoCap(sender: CappableSender | null | undefined, cap: VideoCap): Promise<boolean> {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return false;
  try {
    const params = sender.getParameters();
    const encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
    const settings = sender.track?.getSettings?.();
    const height = cap.shortSide && settings?.width && settings?.height ? Math.min(settings.width, settings.height) : settings?.height;
    const scale = scaleFor(height, cap);
    for (const encoding of encodings) {
      encoding.maxBitrate = cap.maxBitrate;
      encoding.maxFramerate = cap.maxFramerate;
      encoding.scaleResolutionDownBy = scale;
    }
    params.encodings = encodings;
    await sender.setParameters(params);
    return true;
  } catch { return false; }
}

/** replaceTrack drops nothing in theory, but the encoder may restart; cap again for the new track's size. */
export async function replaceTrackCapped(sender: CappableSender & Pick<RTCRtpSender, 'replaceTrack'>,
  track: MediaStreamTrack | null, cap: VideoCap): Promise<void> {
  await sender.replaceTrack(track);
  if (track) await applyVideoCap(sender, cap);
}

/** ClaudeBWAI — einh 3 Oct (item 8): codec list with H.264 first (packetization-mode=1 before 0), everything else after in
 * its original order (rtx/red/ulpfec stay). Phones encode H.264 in hardware; VP8 is software there and stutters. */
export function preferH264<T extends { mimeType: string; sdpFmtpLine?: string }>(codecs: readonly T[]): T[] {
  const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return [...codecs];
  const mode1 = h264.filter(c => /packetization-mode=1/.test(c.sdpFmtpLine ?? ''));
  return [...mode1, ...h264.filter(c => !mode1.includes(c)), ...codecs.filter(c => !h264.includes(c))];
}

/** Runs `draw` at most `fps` times per second from a faster tick source (rAF). Returns whether to draw now. */
export function createFrameGate(fps: number): (nowMs: number) => boolean {
  const interval = 1000 / fps;
  let next = -Infinity;
  return (nowMs: number) => {
    // 1 ms of slack: a 60 Hz tick lands at 16.67 ms steps and must pass a 33.3 ms gate on every second tick.
    if (nowMs + 1 < next) return false;
    next = next === -Infinity || nowMs - next > interval ? nowMs + interval : next + interval;
    return true;
  };
}

/** Leading-edge throttle; `run(true)` forces it (state changes). */
export function createThrottle(fn: () => void, intervalMs: number, now: () => number = () => performance.now()): (force?: boolean) => void {
  let last = -Infinity;
  return (force = false) => {
    const t = now();
    if (!force && t - last < intervalMs) return;
    last = t; fn();
  };
}

// ---- call signalling and media ----
export type SignalMessage = 
  | { type: 'description'; description: { type: 'offer' | 'answer'; sdp: string }; screenMid?: string;
      /** ClaudeBWAI — ICE restart: the host's re-offer on a live call. `generation` (1, 2, 3…) is echoed by the guest's answer so a late answer to an earlier offer is dropped. */
      iceRestart?: boolean; generation?: number }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }
  | { type: 'screen'; active: boolean }
  | { type: 'hangup' };

export type CallState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'closed';

/** ClaudeBWAI — einh 4 Oct ("A: amber Reconnecting…"): a media path that drops after the call was up gets this long to recover. */
export const RECOVERY_DEADLINE_MS = 30_000;
/** The host waits this long on 'disconnected' (browsers often heal on their own) before restarting ICE; 'failed' restarts at once. */
export const RECOVERY_GRACE_MS = 2_500;
/** Each restart attempt gets this long to reach 'connected' before the next one; at most RECOVERY_MAX_ATTEMPTS inside the deadline. */
export const RECOVERY_ATTEMPT_MS = 8_000;
export const RECOVERY_MAX_ATTEMPTS = 3;

export type PeerCallDiagnostics = {
  route: 'relay' | 'direct' | 'unknown';
  protocol: string | null;
  audioBytesReceived: number;
  videoBytesReceived: number;
};

const unknownDiagnostics = (): PeerCallDiagnostics => ({
  route: 'unknown', protocol: null, audioBytesReceived: 0, videoBytesReceived: 0,
});

export class PeerCall {
  private role: 'host' | 'guest';
  private stream: MediaStream;
  private sendFn: (message: SignalMessage) => Promise<void>;
  private onRemoteStream: (stream: MediaStream) => void;
  private onState: (state: CallState, message: string) => void;
  
  private pc: RTCPeerConnection | null = null;
  private videoCap: VideoCap | null;
  private preferH264 = false;
  private cameraSenders: RTCRtpSender[] = [];
  private state: CallState = 'new';
  private earlyCandidates: RTCIceCandidateInit[] = [];
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  
  private negotiationQueue: Promise<void> = Promise.resolve();
  private outboundQueue: Promise<void> = Promise.resolve();
  private outboundCount = 0;
  private inboundCount = 0;
  private startCalled = false;
  private aggregateRemoteStream = new MediaStream();
  private screenTransceiver: RTCRtpTransceiver | null = null;
  private remoteScreenMid: string | null = null;
  private remoteScreen: MediaStream | null = null;
  private remoteScreenActive = false;
  private localScreen: MediaStream | null = null;
  private screenQueue: Promise<void> = Promise.resolve();
  private onRemoteScreen: (stream: MediaStream | null) => void;
  private screenEnabled: boolean;
  private descriptionPublished = false;
  private localCandidates: SignalMessage[] = [];
  // ClaudeBWAI — media-path recovery. Only the host (the offerer) restarts ICE; the guest waits and answers.
  private everConnected = false;
  private recovering = false;
  private restartAttempts = 0;
  private offerGeneration = 0;
  private seenGeneration = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { 
    role: 'host' | 'guest';
    stream: MediaStream;
    send: (message: SignalMessage) => Promise<void>;
    onRemoteStream: (stream: MediaStream) => void;
    onState: (state: CallState, message: string) => void;
    screenShare?: boolean;
    onRemoteScreen?: (stream: MediaStream | null) => void;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: RTCIceTransportPolicy;
    /** Caps what this side's camera/program video sender encodes. Recordings are unaffected. */
    videoCap?: VideoCap;
    /** ClaudeBWAI — ask for H.264 on the camera video (phone guests). Silently ignored where unsupported. */
    preferH264?: boolean;
  }) {
    this.preferH264 = options.preferH264 === true;
    // The guest page builds its PeerCall in guest-call.ts, so the guest cap is the role default.
    this.videoCap = options.videoCap ?? (options.role === 'guest' ? GUEST_CALL_VIDEO_CAP : null);
    this.role = options.role;
    this.screenEnabled = options.screenShare === true;
    this.onRemoteScreen = options.onRemoteScreen ?? (() => {});
    this.stream = options.stream;
    this.sendFn = options.send;
    this.onRemoteStream = options.onRemoteStream;
    this.onState = options.onState;
    
    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers ?? [],
      iceTransportPolicy: options.iceTransportPolicy ?? 'all',
    });
    
    for (const track of this.stream.getTracks()) {
      const sender = this.pc.addTrack(track, this.stream) as RTCRtpSender | undefined;
      if (sender && track.kind === 'video') this.cameraSenders.push(sender);
    }
    void this.capSenders();
    
    if (this.screenEnabled && this.role === 'host') {
      // Reserve ordinary camera and microphone receive sections independently of
      // local source enablement. Otherwise a guest camera can bind to the sole
      // video section intended for screen sharing when the host is mic-only.
      for (const kind of ['audio', 'video'] as const) {
        if (!this.stream.getTracks().some(track => track.kind === kind)) {
          this.pc.addTransceiver(kind, { direction: 'sendrecv' });
        }
      }
      this.screenTransceiver = this.pc.addTransceiver('video', { direction: 'sendrecv' });
    }
    this.pc.ontrack = (event) => {
      if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      if (this.remoteScreenMid !== null && event.transceiver.mid === this.remoteScreenMid) {
        this.remoteScreen = new MediaStream([event.track]);
        if (this.remoteScreenActive) this.onRemoteScreen(this.remoteScreen);
        return;
      }
      this.aggregateRemoteStream.addTrack(event.track);
      this.onRemoteStream(this.aggregateRemoteStream);
    };
    
    this.pc.onicecandidate = (event) => {
      if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      const message: SignalMessage = { type: 'candidate', candidate: event.candidate ? event.candidate.toJSON() : null };
      if (!this.descriptionPublished) {
        if (this.localCandidates.length >= 64) { this.fail('Local candidate queue overflow'); return; }
        this.localCandidates.push(message);
      } else this.enqueueOutbound(message);
    };
    
    this.pc.onconnectionstatechange = () => {
      if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed' || !this.pc) return;
      
      const cs = this.pc.connectionState;
      if (cs === 'connected') {
        this.clearTimeout();
        this.endRecovery();
        this.everConnected = true;
        void this.capSenders();
        this.updateState('connected', 'Media path established');
      } else if (cs === 'disconnected' || cs === 'failed') {
        if (!this.everConnected) {
          // Never connected: the setup timeout owns it, exactly as before.
          if (cs === 'failed') this.fail('Media connection failed');
          else {
            this.updateState('disconnected', 'Media path disconnected');
            this.clearTimeout();
            this.connectionTimeout = setTimeout(() => {
              this.fail('Connection lost: failed to recover media path within timeout');
            }, 15000);
          }
        } else this.beginRecovery(cs === 'failed');
      } else if (cs === 'connecting') {
        if (!this.recovering) this.updateState('connecting', 'Connecting media path');
      }
    };
  }

  /** ClaudeBWAI — the media path dropped on a call that was up: show 'reconnecting', start the overall deadline, and (host
   * only) restart ICE after the grace (at once when the browser says 'failed'). */
  private beginRecovery(failed: boolean): void {
    if (!this.recovering) {
      this.recovering = true;
      this.restartAttempts = 0;
      this.updateState('reconnecting', 'Reconnecting…');
      this.deadlineTimer = setTimeout(() => {
        this.fail('Connection lost: failed to recover media path within 30 s');
      }, RECOVERY_DEADLINE_MS);
    }
    if (this.role !== 'host') return; // glare guard: the guest never initiates
    if (this.attemptTimer) return; // an attempt is already in flight
    if (failed) {
      // An immediate restart owns the attempt: a pending grace restart must not fire a second one.
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      void this.restartIce();
    }
    else if (!this.graceTimer) this.graceTimer = setTimeout(() => { this.graceTimer = null; void this.restartIce(); }, RECOVERY_GRACE_MS);
  }

  private endRecovery(): void {
    this.recovering = false; this.restartAttempts = 0;
    for (const name of ['graceTimer', 'attemptTimer', 'deadlineTimer'] as const) {
      if (this[name]) { clearTimeout(this[name]!); this[name] = null; }
    }
  }

  /** Host only: restartIce(), then a fresh offer (iceRestart, next generation) through the normal signalling channel. */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (this.role !== 'host' || !pc || !this.recovering || this.restartAttempts >= RECOVERY_MAX_ATTEMPTS) return;
    if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
    if (this.attemptTimer) return; // an attempt is already in flight; its timer owns the next one
    this.restartAttempts++;
    const generation = ++this.offerGeneration;
    this.attemptTimer = setTimeout(() => { this.attemptTimer = null; if (this.recovering) void this.restartIce(); }, RECOVERY_ATTEMPT_MS);
    try {
      (pc as { restartIce?: () => void }).restartIce?.();
      this.applyCodecPreferences(pc);
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.pc !== pc || !this.recovering || generation !== this.offerGeneration) return;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc || !this.recovering) return;
      const mid = this.screenTransceiver?.mid;
      this.enqueueOutbound({ type: 'description', description: { type: 'offer', sdp: offer.sdp as string }, iceRestart: true, generation, ...(mid != null ? { screenMid: mid } : {}) });
    } catch { /* this attempt is lost; the attempt timer tries again, the deadline ends it */ }
  }

  /** Chromium only honours encoding parameters once negotiated, so this runs after each description and on connect. */
  private async capSenders(): Promise<void> {
    const cap = this.videoCap, pc = this.pc;
    if (!cap || !pc) return;
    await Promise.all(this.cameraSenders.map(sender => applyVideoCap(sender, cap)));
  }

  /** ClaudeBWAI — H.264 first on the camera video transceiver (never the screen one). Applied before each local description;
   * a browser without setCodecPreferences or H.264 keeps its default order. */
  private applyCodecPreferences(pc: RTCPeerConnection): void {
    if (!this.preferH264) return;
    try {
      const capabilities: RTCRtpCodec[] | undefined = (globalThis as any).RTCRtpReceiver?.getCapabilities?.('video')?.codecs;
      if (!capabilities?.length) return;
      const ordered = preferH264(capabilities);
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver === this.screenTransceiver || !this.cameraSenders.includes(transceiver.sender)) continue;
        if (typeof transceiver.setCodecPreferences === 'function') transceiver.setCodecPreferences(ordered);
      }
    } catch { /* default codec order */ }
  }

  /** Swaps the camera/program video track and re-applies the cap for the new track. */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const sender = this.cameraSenders[0];
    if (!sender) return;
    if (this.videoCap) await replaceTrackCapped(sender, track, this.videoCap);
    else await sender.replaceTrack(track);
  }

  /** ClaudeBWAI — swaps (or adds or removes) the microphone on the negotiated audio sender; the video and the SDP are untouched. */
  async replaceAudioTrack(track: MediaStreamTrack | null): Promise<boolean> {
    const pc = this.pc;
    if (!pc) return false;
    const transceiver = pc.getTransceivers().find(t => t !== this.screenTransceiver && (t.sender.track?.kind ?? t.receiver.track?.kind) === 'audio');
    if (!transceiver) return false;
    await transceiver.sender.replaceTrack(track);
    return true;
  }

  private publishCandidates(): void {
    this.descriptionPublished = true;
    for (const candidate of this.localCandidates) this.enqueueOutbound(candidate);
    this.localCandidates = [];
  }

  /** Replaces only the reserved display sender; never changes the camera original. */
  setScreen(stream: MediaStream | null): Promise<void> {
    this.localScreen = stream;
    this.screenQueue = this.screenQueue.catch(() => {}).then(async () => {
      const pc = this.pc, sender = this.screenTransceiver?.sender;
      if (!pc || !sender || !this.screenEnabled) return;
      const track = this.localScreen?.getVideoTracks()[0] ?? null;
      await sender.replaceTrack(track);
      if (this.pc !== pc) return;
      if (this.descriptionPublished) this.enqueueOutbound({ type: 'screen', active: track !== null });
    });
    return this.screenQueue;
  }

  /** ClaudeBWAI — the line's estimated outgoing bits/s from the selected candidate pair; null when the browser does not say. */
  async outgoingBitrate(): Promise<number | null> {
    const pc = this.pc;
    if (!pc || this.state === 'closed' || this.state === 'failed') return null;
    try {
      const entries: any[] = []; (await pc.getStats()).forEach(value => entries.push(value));
      const selectedId = entries.find(e => e.type === 'transport' && typeof e.selectedCandidatePairId === 'string')?.selectedCandidatePairId;
      const pair = (selectedId && entries.find(e => e.id === selectedId)) ||
        entries.find(e => e.type === 'candidate-pair' && e.nominated === true && e.state === 'succeeded');
      const bps = pair?.availableOutgoingBitrate;
      return typeof bps === 'number' && Number.isFinite(bps) && bps > 0 ? bps : null;
    } catch { return null; }
  }

  /** ClaudeBWAI — the last getStats report diagnostics() took, as a list (empty until the first one). */
  lastStats: readonly any[] = [];
  async diagnostics(): Promise<PeerCallDiagnostics> {
    const currentPc = this.pc;
    if (!currentPc || this.state === 'closed' || this.state === 'failed') return unknownDiagnostics();

    let report: RTCStatsReport;
    try {
      report = await currentPc.getStats();
    } catch {
      return unknownDiagnostics();
    }
    if (this.pc !== currentPc || (this.state as CallState) === 'closed' ||
      (this.state as CallState) === 'failed') return unknownDiagnostics();

    // RTCStatsReport is map-like. Only a transport-selected pair, or one
    // unambiguous nominated/succeeded pair, proves the active media route.
    if (!report || typeof report.forEach !== 'function') return unknownDiagnostics();
    const entries: any[] = [];
    report.forEach(value => entries.push(value));
    this.lastStats = entries; // ClaudeBWAI — the session diagnostics log reads this rather than taking a second getStats.
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const selectedIds = new Set(entries.filter(entry => entry.type === 'transport' &&
      typeof entry.selectedCandidatePairId === 'string').map(entry => entry.selectedCandidatePairId));
    let pair: any;
    if (selectedIds.size === 1) {
      const selected = byId.get([...selectedIds][0]);
      if (selected?.type === 'candidate-pair' && selected.state === 'succeeded') pair = selected;
    } else if (selectedIds.size === 0) {
      const candidates = entries.filter(entry => entry.type === 'candidate-pair' &&
        entry.nominated === true && entry.state === 'succeeded');
      if (candidates.length === 1) pair = candidates[0];
    }

    let route: PeerCallDiagnostics['route'] = 'unknown';
    let protocol: string | null = null;
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      if (local?.type === 'local-candidate' && remote?.type === 'remote-candidate') {
        if (local.candidateType === 'relay' || remote.candidateType === 'relay') route = 'relay';
        else if (['host', 'srflx', 'prflx'].includes(local.candidateType) &&
          ['host', 'srflx', 'prflx'].includes(remote.candidateType)) route = 'direct';
        protocol = typeof local.protocol === 'string' ? local.protocol :
          typeof remote.protocol === 'string' ? remote.protocol : null;
      }
    }

    let audioBytesReceived = 0;
    let videoBytesReceived = 0;
    for (const entry of entries) {
      if (entry.type !== 'inbound-rtp' || entry.isRemote === true ||
        !Number.isFinite(entry.bytesReceived) || entry.bytesReceived < 0) continue;
      const kind = entry.kind ?? entry.mediaType;
      if (kind === 'audio' && Number.isFinite(audioBytesReceived + entry.bytesReceived))
        audioBytesReceived += entry.bytesReceived;
      if (kind === 'video' && Number.isFinite(videoBytesReceived + entry.bytesReceived))
        videoBytesReceived += entry.bytesReceived;
    }
    return { route, protocol, audioBytesReceived, videoBytesReceived };
  }
  
  private updateState(newState: CallState, message: string) {
    if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
    this.state = newState;
    this.onState(newState, message);
  }
  
  private fail(reason: string) {
    if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
    this.clearTimeout(); this.endRecovery();
    this.state = 'failed';
    this.onState('failed', reason);
    this.cleanup();
  }
  
  private clearTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }
  
  private cleanup() {
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.earlyCandidates = [];
    this.remoteScreen = null; this.remoteScreenActive = false;
    this.onRemoteScreen(null);
    // Pending promises decrement their own counters as they settle.
  }

  private enqueueOutbound(message: SignalMessage) {
    if (this.outboundCount >= 64) {
      this.fail('Network error: Outbound signaling queue overflow');
      return;
    }
    this.outboundCount++;
    this.outboundQueue = this.outboundQueue.then(() => {
      if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      return this.sendFn(message);
    })
      .catch(err => {
        this.fail('Network error: Signaling transport failed');
      })
      .finally(() => {
        this.outboundCount--;
      });
  }

  async start(): Promise<void> {
    if (this.startCalled || this.state !== 'new' || !this.pc) return;
    this.startCalled = true;
    this.updateState('connecting', this.role === 'host' ? 'Connecting to the guest…' : 'Waiting for the host’s offer…');
    
    if (this.role === 'host') {
      this.connectionTimeout = setTimeout(() => {
        this.fail('Media connection timeout: verified HTTPS invitation could not establish a media path');
      }, 15000);
      try {
        const currentPc = this.pc;
        this.applyCodecPreferences(currentPc);
        const offer = await currentPc.createOffer();
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
        
        await currentPc.setLocalDescription(offer);
        void this.capSenders();
        const mid = this.screenTransceiver?.mid;
        if (this.screenEnabled && mid == null) throw new Error('Display transceiver not negotiated');
        this.remoteScreenMid = mid ?? null;
        this.enqueueOutbound({ type: 'description', description: { type: 'offer', sdp: offer.sdp as string }, ...(mid != null ? { screenMid: mid } : {}) });
        this.publishCandidates();
        await this.setScreen(this.localScreen);
      } catch (err: any) {
        this.fail('Failed to initialize signaling exchange');
      }
    }
  }
  
  receive(message: SignalMessage): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return Promise.resolve();
    if (this.inboundCount >= 64) {
      this.fail('Network error: Inbound signaling queue overflow');
      return Promise.resolve();
    }
    this.inboundCount++;
    this.negotiationQueue = this.negotiationQueue.then(() => this.processMessage(message))
      .catch(err => {
        this.fail('Signal processing error: Failed to process incoming signal');
      })
      .finally(() => {
        this.inboundCount--;
      });
    return this.negotiationQueue;
  }
  
  private async processMessage(message: SignalMessage): Promise<void> {
    if ((this.state as CallState) === 'closed' || (this.state as CallState) === 'failed' || !this.pc) return;
    const currentPc = this.pc;
    
    if (message.type === 'hangup') {
      this.close();
      return;
    }
    
    if (message.type === 'screen') {
      if (!this.screenEnabled || this.remoteScreenMid === null) return;
      this.remoteScreenActive = message.active;
      this.onRemoteScreen(message.active ? this.remoteScreen : null);
      return;
    }
    if (message.type === 'description') {
      if (this.role === 'host' && message.description.type === 'offer') {
        this.fail('Signaling error: Host received an offer instead of an answer');
        return;
      }
      if (this.role === 'guest' && message.description.type === 'answer') {
        this.fail('Signaling error: Guest received an answer instead of an offer');
        return;
      }

      if (this.role === 'host') {
        // Stale-answer guard: only the answer to the newest offer counts; a duplicate on a settled connection is ignored.
        if ((message.generation ?? 0) !== this.offerGeneration) return;
        const signalingState = (currentPc as { signalingState?: string }).signalingState;
        if (signalingState === 'stable') return;
      } else if (message.description.type === 'offer') {
        if ((message.generation ?? 0) < this.seenGeneration) return;
        this.seenGeneration = message.generation ?? 0;
      }

      // Set identity before setRemoteDescription dispatches track events.
      if (message.screenMid !== undefined) {
        if (!this.screenEnabled || (this.role === 'host' && message.screenMid !== this.screenTransceiver?.mid))
          throw new Error('Unexpected display transceiver');
        this.remoteScreenMid = message.screenMid;
      }
      await currentPc.setRemoteDescription(message.description as RTCSessionDescriptionInit);
      void this.capSenders();
      if (this.screenEnabled && this.remoteScreenMid !== null) {
        this.screenTransceiver = currentPc.getTransceivers().find(value => value.mid === this.remoteScreenMid) ?? null;
        if (!this.screenTransceiver || this.screenTransceiver.receiver.track.kind !== 'video') throw new Error('Missing display transceiver');
        this.screenTransceiver.direction = 'sendrecv';
      }
      if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      
      if (message.description.type === 'offer' && this.role === 'guest') {
        // A restart offer on a call that was up must not arm the 15 s setup timeout: ICE may stay 'connected' without an event.
        if (!this.everConnected) {
          this.clearTimeout();
          this.connectionTimeout = setTimeout(() => {
            this.fail('The call could not connect. Check both network connections; a working invitation does not guarantee a media connection.');
          }, 15000);
        }
        this.applyCodecPreferences(currentPc);
        const answer = await currentPc.createAnswer();
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
        
        await currentPc.setLocalDescription(answer);
        void this.capSenders();
        this.enqueueOutbound({ type: 'description', description: { type: 'answer', sdp: answer.sdp as string }, ...(this.remoteScreenMid !== null ? { screenMid: this.remoteScreenMid } : {}), ...(message.generation ? { generation: message.generation } : {}) });
        this.publishCandidates();
        await this.setScreen(this.localScreen);
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      }
      
      for (const candidate of this.earlyCandidates) {
        await this.addCandidate(currentPc, candidate);
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      }
      this.earlyCandidates = [];
    } else if (message.type === 'candidate') {
      if (message.candidate) {
        if (currentPc.remoteDescription) {
          await this.addCandidate(currentPc, message.candidate);
          if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
        } else {
          if (this.earlyCandidates.length >= 64) {
             this.fail('Network error: early candidate queue overflow');
             return;
          }
          this.earlyCandidates.push(message.candidate);
        }
      }
    }
  }
  
  /** After an ICE restart, a candidate from the superseded generation can be refused; that is not a call failure. */
  private async addCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    if (this.offerGeneration === 0 && this.seenGeneration === 0) return pc.addIceCandidate(candidate);
    try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
  }

  close(): void {
    if ((this.state as CallState) === 'closed') return;
    this.clearTimeout(); this.endRecovery();
    this.state = 'closed';
    this.onState('closed', 'Call closed');
    this.cleanup();
  }
}
