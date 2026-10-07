// CodexBWAI — owns call lifetimes; Preview retains ownership of capture tracks.
import { PeerCall, type CallState } from './peer-call.js';
import { HOST_CALL_VIDEO_CAP } from './peer-call.js';
import { HostAudioMixer } from './audio-mix.js';
import type { DesktopBridge } from './bridge.js';
import { setGuestReconnecting, setGuestMediaLost, type GuestEntry } from './admission-ui.js';
import type { DrawableSource } from './scenes.js';
import type { GuestStatsSource, CallEventReason, CallEventState } from './session-diagnostics.js';

type Call = { recoveredAt?: number; statsAt: number; id: string; callId: string; decidedAt: number | null; index: number; peer: PeerCall | null; after: number; offered: boolean;
  state: CallState; row: HTMLElement; status: HTMLElement; video: HTMLVideoElement;
  screenVideo: HTMLVideoElement; name: string; level: HTMLMeterElement; levelLabel: HTMLElement; gain: HTMLInputElement; gainLabel: HTMLElement };

const STATS_INTERVAL_MS = 2000;
export const RECOVERED_HOLD_MS = 15_000; // ClaudeBWAI — r10: hold a just-recovered call until the page polls again
/** ClaudeBWAI — who gets a call tile: admitted AND still present. */
export function liveGuest(g: GuestEntry): boolean {
  return g.alive && !g.revoked && g.phase === 'admitted' && Boolean(g.session) && g.presence !== 'disconnected';
}

export class HostCalls {
  private stream: MediaStream | null = null;
  private mixer: HostAudioMixer | null = null;
  private calls = new Map<string, Call>();
  private gains = new Map<string, number>();
  private muted = new Set<string>();
  private hiddenCameras = new Set<string>();
  private monitoring = true;
  private localScreen: MediaStream | null = null;
  private generation = 0;
  private busy = false;
  private destroyed = false;
  private timer: ReturnType<typeof setInterval>;
  /** ClaudeBWAI — einh 4 Oct (r10): call state transitions for the session diagnostics log. Slot numbers and enumerated values only. */
  onCallEvent: ((slot: number, state: CallEventState, reason: CallEventReason) => void) | null = null;
  private emit(call: Call, state: CallEventState, reason: CallEventReason): void {
    try { this.onCallEvent?.(call.index, state, reason); } catch { /* diagnostics never touch the call */ }
  }

  constructor(private bridge: DesktopBridge, private container: HTMLElement,
    private message: HTMLElement, private audioButton: HTMLButtonElement) {
    audioButton.addEventListener('click', () => { void this.resumeAudio().catch(() => {}); });
    this.timer = setInterval(() => { void this.poll(); this.meters(); }, 500);
  }

  setStream(stream: MediaStream | null): void {
    if (stream === this.stream) return;
    this.generation++;
    for (const call of this.calls.values()) this.release(call, true, 'stream-changed');
    this.calls.clear();
    const previousMixer = this.mixer;
    this.mixer = null;
    void previousMixer?.close().catch(() => {
      if (!this.destroyed) this.message.textContent = 'Previous audio could not close cleanly. Restart BlastCast before continuing.';
    });
    this.stream = stream;
    this.audioButton.disabled = !stream;
    if (stream) {
      try { this.mixer = new HostAudioMixer(stream); }
      catch { this.message.textContent = 'Call audio could not start. Restart preview before calling or recording.'; return; }
      this.mixer.setMonitoring(this.monitoring);
      void this.resumeAudio().catch(() => {});
    } else this.message.textContent = 'Enable a source to connect admitted guests.';
    void this.poll();
  }

  /** ClaudeBWAI — the host microphone changed (Mic toggle, Reconnect): swap only the audio, in the mix and on every call.
   * The scene video and the calls' negotiation are untouched, and the mixed stream a recording holds stays the same. */
  async replaceHostAudio(device: MediaStream): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    const track = device.getAudioTracks()[0] ?? null;
    for (const old of stream.getAudioTracks()) stream.removeTrack(old);
    if (track) stream.addTrack(track);
    try { this.mixer?.setHostStream(device); }
    catch { this.message.textContent = 'Call audio could not start. Restart preview before calling or recording.'; }
    await Promise.all([...this.calls.values()].map(call => call.peer?.replaceAudioTrack(track)));
  }

  /** ClaudeBWAI — the scene (program) video track was replaced (output quality change): every call's video sender and the
   * stream new calls start from take the new track. Audio and negotiation are untouched. */
  async replaceProgramVideo(track: MediaStreamTrack | null): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    for (const old of stream.getVideoTracks()) stream.removeTrack(old);
    if (track) stream.addTrack(track);
    await Promise.all([...this.calls.values()].map(call => call.peer?.replaceVideoTrack(track)));
  }

  async resumeAudio(): Promise<void> {
    const mixer = this.mixer;
    if (!mixer) throw new Error('Enable a source before enabling call audio.');
    try {
      await mixer.resume();
      if (mixer !== this.mixer) throw new Error('Preview changed. Enable audio again.');
      this.audioButton.hidden = true;
      this.message.textContent = this.monitoring ? 'Guest audio on. Guest levels also affect the recording.' : 'Listening off. Guest audio is still included in the recording.';
    } catch {
      this.audioButton.hidden = false;
      this.message.textContent = 'Audio playback is blocked. Enable audio to retry.';
      throw new Error('Call audio could not start.');
    }
  }

  async setScreen(stream: MediaStream | null): Promise<void> {
    this.localScreen = stream;
    await Promise.all([...this.calls.values()].map(call => call.peer?.setScreen(stream)));
  }
  screenSources(): {id:string;name:string;video:HTMLVideoElement}[] {
    return [...this.calls.values()].filter(call => call.screenVideo.srcObject && call.state === 'connected')
      .map(call => ({id:call.id,name:call.name,video:call.screenVideo}));
  }

  setMonitoring(enabled: boolean): void {
    this.monitoring = enabled; this.mixer?.setMonitoring(enabled);
    if (this.mixer) void this.resumeAudio().catch(() => {});
  }

  private move(id: string, targetIndex: number): void {
    const ordered = [...this.calls.values()].sort((a,b) => a.index-b.index);
    const from = ordered.findIndex(call => call.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
    const [call] = ordered.splice(from, 1); ordered.splice(targetIndex, 0, call!);
    ordered.forEach((item, i) => { item.index = i+1; this.container.append(item.row); });
  }

  // ClaudeBWAI — session diagnostics: connected calls by scene slot with the stats the 2 s diagnostics poll already took.
  diagnosticsSources(): { participants: number; guests: GuestStatsSource[] } {
    const guests = [...this.calls.values()].filter(call => call.state === 'connected' && call.peer)
      .sort((a, b) => a.index - b.index).map(call => ({ slot: call.index, source: call.peer as object, entries: call.peer!.lastStats }));
    return { participants: 1 + guests.length, guests };
  }

  mixedStream(): MediaStream {
    if (!this.mixer) throw new Error('Restart preview to prepare mixed audio.');
    return this.mixer.getMixedStream();
  }

  sources(): DrawableSource[] {
    return [...this.calls.values()].map(call => {
      const track = (call.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      return { kind: 'camera', index: call.index,
        state: this.hiddenCameras.has(call.id) ? 'muted' : call.state === 'reconnecting' && call.video.videoWidth > 0 ? 'reconnecting' : call.state === 'connected' && track?.readyState === 'live' && !track.muted && call.video.videoWidth > 0 ? 'live' : 'ended',
        drawable: call.video, naturalWidth: call.video.videoWidth, naturalHeight: call.video.videoHeight };
    });
  }

  private release(call: Call, notify: boolean, reason: CallEventReason = 'page-gone'): void {
    this.emit(call, 'released', reason);
    if (notify && call.peer && call.state !== 'closed') {
      void this.bridge.sendGuestSignal(call.id, call.callId, { type: 'hangup' }).catch(() => {});
    }
    call.peer?.close(); call.peer = null;
    setGuestReconnecting(call.id, false); setGuestMediaLost(call.id, false);
    this.mixer?.removeGuest(call.id);
    call.video.pause(); call.video.srcObject = null;
    call.screenVideo.pause(); call.screenVideo.srcObject = null;
    call.row.remove();
  }

  private async create(entry: GuestEntry): Promise<void> {
    if (!this.stream || !entry.session) return;
    const id = entry.session.id;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const callId = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const row = document.createElement('div'); row.className = 'call-row'; row.dataset['sessionId'] = id;
    const name = document.createElement('strong'); name.textContent = entry.session.name; name.dir = 'auto';
    const label = document.createElement('p'); label.className = 'small status'; label.setAttribute('role', 'status');
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.hidden = true;
    const level = document.createElement('meter'); level.min = 0; level.max = 1;
    level.setAttribute('aria-label', `${entry.session.name} original input level`);
    const levelLabel = document.createElement('span'); levelLabel.className = 'small';
    const gain = document.createElement('input'); gain.type = 'range'; gain.min = '-60'; gain.max = '0'; gain.step = '1';
    gain.value = String(this.gains.get(id) ?? 0); gain.setAttribute('aria-label', `${entry.session.name} volume in decibels`);
    const gainLabel = document.createElement('output'); gainLabel.textContent = `${gain.value} dB`;
    const reset = document.createElement('button'); reset.className = 'secondary'; reset.textContent = 'Reset to 0 dB';
    const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Reconnect';
    const used = new Set([...this.calls.values()].map(call => call.index));
    const index = [1, 2, 3, 4, 5, 6, 7].find(i => !used.has(i));
    if (!index) return;
    const screenVideo = document.createElement('video'); screenVideo.muted=true; screenVideo.playsInline=true; screenVideo.hidden=true;
    const call: Call = { statsAt: 0, screenVideo, name:entry.session.name, id, callId, decidedAt: entry.session.decidedAt ?? null, index, peer: null, after: 0, offered: false, state: 'new', row, status: label, video, level, levelLabel, gain, gainLabel };
    this.calls.set(id, call);
    const current = () => this.calls.get(id) === call && Boolean(call.peer) && call.state !== 'closed' && call.state !== 'failed';
    const setGain = () => {
      const db = Number(gain.value); this.gains.set(id, db); gainLabel.textContent = `${db} dB`;
      if (this.mixer?.getGuestSource(id)) this.mixer.setGainDb(id, db);
    };
    gain.addEventListener('input', setGain);
    reset.addEventListener('click', () => { gain.value = '0'; setGain(); });
    retry.addEventListener('click', () => {
      if (this.calls.get(id) !== call) return;
      this.calls.delete(id); this.release(call, true, 'reconnect-button'); void this.poll();
    });
    const mute = document.createElement('button'); mute.className = 'secondary';
    const updateMute = () => { mute.textContent = this.muted.has(id) ? 'Unmute mix' : 'Mute mix'; mute.setAttribute('aria-pressed', String(this.muted.has(id))); };
    updateMute(); mute.title = 'Affects your listening and mixed recording, not the guest original';
    mute.addEventListener('click', () => { if (this.muted.has(id)) this.muted.delete(id); else this.muted.add(id); this.mixer?.setGuestMuted(id, this.muted.has(id)); updateMute(); });
    const hide = document.createElement('button'); hide.className = 'secondary';
    const updateHide = () => { hide.textContent = this.hiddenCameras.has(id) ? 'Show camera' : 'Hide camera'; hide.setAttribute('aria-pressed', String(this.hiddenCameras.has(id))); };
    updateHide(); hide.title = 'Changes the composed scene only';
    hide.addEventListener('click', () => { if (this.hiddenCameras.has(id)) this.hiddenCameras.delete(id); else this.hiddenCameras.add(id); updateHide(); });
    const up = document.createElement('button'); up.textContent = '↑'; up.setAttribute('aria-label', `Move ${entry.session.name} up`);
    const down = document.createElement('button'); down.textContent = '↓'; down.setAttribute('aria-label', `Move ${entry.session.name} down`);
    const position = () => [...this.calls.values()].sort((a,b) => a.index-b.index).findIndex(c => c.id === id);
    up.addEventListener('click', () => this.move(id, position()-1)); down.addEventListener('click', () => this.move(id, position()+1));
    name.draggable = true; name.title = 'Drag to reorder scene slots';
    name.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-blastcast-guest', id); });
    row.addEventListener('dragover', event => { if(event.dataTransfer?.types.includes('application/x-blastcast-guest')) event.preventDefault(); });
    row.addEventListener('drop', event => { event.preventDefault(); const source = event.dataTransfer?.getData('application/x-blastcast-guest'); if(source) this.move(source, position()); });
    const actions = document.createElement('div'); actions.className = 'guest-mix-actions'; actions.append(mute, hide, up, down);
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Volume & connection'; details.append(summary, label, levelLabel, gain, gainLabel, reset, retry);
    row.append(name, video, level, actions, details); this.container.append(row);
    label.textContent = 'Connecting…';
    const generation = this.generation;
    const stream = this.stream;
    try {
      const config = await this.bridge.getGuestCallConfiguration(id);
      if (this.destroyed || generation !== this.generation || this.stream !== stream || this.calls.get(id) !== call) return;
      if (!config.ok) throw new Error('Call configuration unavailable');
      // ClaudeBWAI — einh 3 Oct (item 8): the offer's codec order decides what the guest SENDS, so a phone guest is offered
      // H.264 first (hardware-encoded on phones; VP8 is software there and stuttered). Desktop guests keep the default order.
      // ClaudeBWAI — einh 4 Oct (CP4b): desktop guests are offered H.264 first too (hardware on Windows/macOS, measured); a Firefox guest
      // answers in its native order (see peer-call.ts isFirefoxUserAgent). The cap stays 640x360: the hardware encoders accept it.
      call.peer = new PeerCall({ role: 'host', stream, screenShare:true, videoCap: HOST_CALL_VIDEO_CAP, preferH264: true,
        onRemoteScreen: screen => { if (!current()) return; screenVideo.srcObject=screen; if(screen) void screenVideo.play().catch(()=>{label.textContent='Guest screen could not play. Ask them to share again.';}); else screenVideo.pause(); }, iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy,
        send: async signal => {
          if (!current()) throw new Error('Call replaced.');
          const result = await this.bridge.sendGuestSignal(id, callId, signal);
          if (!result.ok) throw new Error('The host could not send call setup. Reconnect when guest access is ready.');
          if (signal.type === 'description' && signal.description.type === 'offer') call.offered = true;
        },
        onRemoteStream: stream => {
          if (!current()) return;
          if (video.srcObject !== stream) video.srcObject = stream;
          void video.play().catch(() => { if (current()) label.textContent = 'Guest video paused. Reconnect to retry.'; });
          // RTC may deliver video first. Attach audio only once that track exists.
          if (stream.getAudioTracks().length && this.mixer?.getGuestSource(id) !== stream) {
            try {
              this.mixer?.removeGuest(id); this.mixer?.addGuest(id, stream);
              this.mixer?.setGainDb(id, this.gains.get(id) ?? 0);
              this.mixer?.setGuestMuted(id, this.muted.has(id));
            } catch {
              call.peer?.close(); label.textContent = 'Guest audio could not start. Reconnect to retry.';
            }
          }
        },
        onState: (state, text) => {
          if (this.calls.get(id) !== call) return;
          const before = call.state;
          call.state = state; row.dataset['callState'] = state;
          if (state !== before) {
            if (state === 'reconnecting') this.emit(call, 'reconnecting', 'media-lost');
            else if (state === 'connected') { this.emit(call, 'connected', before === 'reconnecting' ? 'recovered' : 'established'); if (before === 'reconnecting') call.recoveredAt = Date.now(); }
            else if (state === 'failed') this.emit(call, 'failed', before === 'reconnecting' ? 'recovery-failed' : 'setup-failed');
          }
          setGuestReconnecting(id, state === 'reconnecting');
          // A call that failed or ended while still current means the guest's media is gone, even if their page still polls.
          if (state === 'failed' || state === 'closed') setGuestMediaLost(id, true); else if (state === 'connected') setGuestMediaLost(id, false);
          label.classList.toggle('reconnecting', state === 'reconnecting');
          label.textContent = state === 'reconnecting' ? 'Reconnecting… keeping the last picture while the connection recovers.' : state === 'connected' ? 'Connected · live camera and microphone' : `${text}${state === 'failed' && config.iceServers.length ? ' Check connectivity, relay availability, allocation credentials and free allowance. The exact cause is unknown; no paid fallback was used.' : ''}${state === 'failed' || state === 'closed' ? ' Ask the guest to start preview, then Reconnect.' : ''}`;
          if (state === 'closed' || state === 'failed') { this.mixer?.removeGuest(id); video.srcObject = null; }
        },
      });
      await call.peer.setScreen(this.localScreen);
      void call.peer.start().catch(() => { if (current()) { call.peer?.close(); label.textContent = 'Call setup failed. Reconnect to retry.'; } });
    } catch {
      if (this.calls.get(id) !== call || generation !== this.generation) return;
      call.state = 'failed'; setGuestMediaLost(id, true); label.textContent = 'Call configuration or media setup failed. Check your relay account, credentials and allowance, then Reconnect. No paid fallback was used.';
    }
  }

  private async poll(): Promise<void> {
    if (this.busy || this.destroyed || !this.stream || !this.mixer) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const result = await this.bridge.guestStatus();
      if (generation !== this.generation || this.destroyed) return;
      if (!result.ok) throw new Error('Guest access unavailable');
      // ClaudeBWAI — a guest whose page has gone (presence 'disconnected') leaves the live list and the scene; it stays admitted.
      const admitted: GuestEntry[] = result.guests.filter(liveGuest);
      // ClaudeBWAI — einh 4 Oct (r10): a guest whose page is quiet because their network dropped is the same outage as their media
      // dropping. While that call is in ICE recovery (its own 30 s deadline) the presence lapse must not release it, or the restart
      // is cancelled and the guest comes back as a brand-new call. The admission itself (alive, not revoked, same decidedAt) still counts.
      // A call that has just recovered is held too, until the page's next poll refreshes presence (the media can heal before the page polls).
      const holdingRecovery = (call: Call): boolean => Boolean(call.peer)
        && (call.state === 'reconnecting' || (call.state === 'connected' && call.recoveredAt !== undefined && Date.now() - call.recoveredAt < RECOVERED_HOLD_MS))
        && result.guests.some(g => g.alive && !g.revoked && g.phase === 'admitted' && !g.pageGone && g.session?.id === call.id && (g.session.decidedAt ?? null) === call.decidedAt);
      const activeIds = new Set([...admitted.map(entry => entry.session!.id), ...[...this.calls.values()].filter(holdingRecovery).map(call => call.id)]);
      for (const id of this.gains.keys()) if (!activeIds.has(id)) this.gains.delete(id);
      // A rejoin keeps the session id but is a new admission (decidedAt is reset, then set again).
      // A quick re-admit between two polls never leaves "admitted", so compare the admission itself.
      for (const [id, call] of this.calls) if (!holdingRecovery(call) && !admitted.some(g => g.session!.id === id && (g.session!.decidedAt ?? null) === call.decidedAt)) {
        const gone = result.guests.find(g => g.session?.id === id);
        this.calls.delete(id); this.release(call, false, gone?.pageGone ? 'page-gone' : call.state === 'failed' ? 'recovery-failed' : 'call-gone'); this.gains.delete(id);
      }
      for (const entry of admitted) if (!this.calls.has(entry.session!.id)) void this.create(entry);
      await Promise.all([...this.calls.values()].map(async call => {
        if (!call.peer || call.state === 'closed' || call.state === 'failed') return;
        // The offer must establish the broker queue before polling it.
        if (!call.offered) return;
        try {
          const signals = await this.bridge.pollGuestSignals(call.id, call.callId, call.after);
          if (generation !== this.generation || this.calls.get(call.id) !== call) return;
          if (!signals.ok) {
            // The broker no longer knows this call (pruned on rejoin, or replaced): drop it so the next poll accepts the new call.
            if (/^(Stale callId|Session is not admitted)/.test(signals.message ?? '')) { this.calls.delete(call.id); this.release(call, false, 'call-gone'); return; }
            call.peer.close(); call.status.textContent = 'Call setup ended. Reconnect to retry.'; return;
          }
          for (const item of signals.messages ?? []) {
            if (this.calls.get(call.id) !== call) return;
            await call.peer?.receive(item.message); call.after = item.sequence;
          }
          // Signals poll at 500 ms for setup; getStats() is heavy, so the diagnostics line refreshes every 2 s.
          if (call.state === 'connected' && call.peer && Date.now() - call.statsAt >= STATS_INTERVAL_MS) {
            call.statsAt = Date.now();
            const media = await call.peer.diagnostics();
            if (generation !== this.generation || this.calls.get(call.id) !== call || call.state !== 'connected') return;
            call.row.dataset['mediaRoute'] = media.route;
            call.status.textContent = `Connected · ${media.route === 'unknown' ? 'media route not measured' : media.route + ' media route'} · received audio ${media.audioBytesReceived} B / video ${media.videoBytesReceived} B`;
          }
        } catch {
          if (generation === this.generation && this.calls.get(call.id) === call) {
            call.peer?.close(); call.status.textContent = 'Guest connection interrupted. Reconnect to retry.';
          }
        }
      }));
    } catch {
      if (generation === this.generation) {
        for (const call of this.calls.values()) { call.peer?.close(); call.status.textContent = 'Host connection interrupted. Reconnect to retry.'; }
      }
    } finally { this.busy = false; }
  }

  private meters(): void {
    const levels = this.mixer?.getLevels() ?? [];
    for (const call of this.calls.values()) {
      const value = levels.find(level => level.id === call.id);
      call.level.value = Math.min(1, value?.rms ?? 0);
      call.levelLabel.textContent = value?.clipped ? 'Input clipping — ask guest to lower their microphone' : 'Original input';
      call.levelLabel.classList.toggle('error', Boolean(value?.clipped));
    }
  }

  close(): void { this.destroyed = true; clearInterval(this.timer); this.setStream(null); }
}
