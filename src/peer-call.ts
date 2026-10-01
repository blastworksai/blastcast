export type SignalMessage = 
  | { type: 'description'; description: { type: 'offer' | 'answer'; sdp: string }; screenMid?: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }
  | { type: 'screen'; active: boolean }
  | { type: 'hangup' };

export type CallState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

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
  }) {
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
      this.pc.addTrack(track, this.stream);
    }
    
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
        this.updateState('connected', 'Media path established');
      } else if (cs === 'disconnected') {
        this.updateState('disconnected', 'Media path disconnected');
        this.clearTimeout();
        this.connectionTimeout = setTimeout(() => {
          this.fail('Connection lost: failed to recover media path within timeout');
        }, 15000);
      } else if (cs === 'failed') {
        this.fail('Media connection failed');
      } else if (cs === 'connecting') {
        this.updateState('connecting', 'Connecting media path');
      }
    };
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
    this.clearTimeout();
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
        const offer = await currentPc.createOffer();
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
        
        await currentPc.setLocalDescription(offer);
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

      // Set identity before setRemoteDescription dispatches track events.
      if (message.screenMid !== undefined) {
        if (!this.screenEnabled || (this.role === 'host' && message.screenMid !== this.screenTransceiver?.mid))
          throw new Error('Unexpected display transceiver');
        this.remoteScreenMid = message.screenMid;
      }
      await currentPc.setRemoteDescription(message.description as RTCSessionDescriptionInit);
      if (this.screenEnabled && this.remoteScreenMid !== null) {
        this.screenTransceiver = currentPc.getTransceivers().find(value => value.mid === this.remoteScreenMid) ?? null;
        if (!this.screenTransceiver || this.screenTransceiver.receiver.track.kind !== 'video') throw new Error('Missing display transceiver');
        this.screenTransceiver.direction = 'sendrecv';
      }
      if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      
      if (message.description.type === 'offer' && this.role === 'guest') {
        this.clearTimeout();
        this.connectionTimeout = setTimeout(() => {
          this.fail('The call could not connect. Check both network connections; a working invitation does not guarantee a media connection.');
        }, 15000);
        const answer = await currentPc.createAnswer();
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
        
        await currentPc.setLocalDescription(answer);
        this.enqueueOutbound({ type: 'description', description: { type: 'answer', sdp: answer.sdp as string }, ...(this.remoteScreenMid !== null ? { screenMid: this.remoteScreenMid } : {}) });
        this.publishCandidates();
        await this.setScreen(this.localScreen);
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      }
      
      for (const candidate of this.earlyCandidates) {
        await currentPc.addIceCandidate(candidate);
        if (this.pc !== currentPc || (this.state as CallState) === 'closed' || (this.state as CallState) === 'failed') return;
      }
      this.earlyCandidates = [];
    } else if (message.type === 'candidate') {
      if (message.candidate) {
        if (currentPc.remoteDescription) {
          await currentPc.addIceCandidate(message.candidate);
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
  
  close(): void {
    if ((this.state as CallState) === 'closed') return;
    this.clearTimeout();
    this.state = 'closed';
    this.onState('closed', 'Call closed');
    this.cleanup();
  }
}
