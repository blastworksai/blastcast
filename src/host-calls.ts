// CodexBWAI — owns call lifetimes; Preview retains ownership of capture tracks.
import { PeerCall, type CallState } from './peer-call.js';
import { HostAudioMixer } from './audio-mix.js';
import type { DesktopBridge } from './bridge.js';
import type { GuestEntry } from './admission-ui.js';
import type { DrawableSource } from './scenes.js';

type Call = { id: string; callId: string; index: number; peer: PeerCall | null; after: number; offered: boolean;
  state: CallState; row: HTMLElement; status: HTMLElement; video: HTMLVideoElement;
  screenVideo: HTMLVideoElement; name: string; level: HTMLMeterElement; levelLabel: HTMLElement; gain: HTMLInputElement; gainLabel: HTMLElement };

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

  constructor(private bridge: DesktopBridge, private container: HTMLElement,
    private message: HTMLElement, private audioButton: HTMLButtonElement) {
    audioButton.addEventListener('click', () => { void this.resumeAudio().catch(() => {}); });
    this.timer = setInterval(() => { void this.poll(); this.meters(); }, 500);
  }

  setStream(stream: MediaStream | null): void {
    if (stream === this.stream) return;
    this.generation++;
    for (const call of this.calls.values()) this.release(call, true);
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

  mixedStream(): MediaStream {
    if (!this.mixer) throw new Error('Restart preview to prepare mixed audio.');
    return this.mixer.getMixedStream();
  }

  sources(): DrawableSource[] {
    return [...this.calls.values()].map(call => {
      const track = (call.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      return { kind: 'camera', index: call.index,
        state: this.hiddenCameras.has(call.id) ? 'muted' : call.state === 'connected' && track?.readyState === 'live' && !track.muted && call.video.videoWidth > 0 ? 'live' : 'ended',
        drawable: call.video, naturalWidth: call.video.videoWidth, naturalHeight: call.video.videoHeight };
    });
  }

  private release(call: Call, notify: boolean): void {
    if (notify && call.peer && call.state !== 'closed') {
      void this.bridge.sendGuestSignal(call.id, call.callId, { type: 'hangup' }).catch(() => {});
    }
    call.peer?.close(); call.peer = null;
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
    const call: Call = { screenVideo, name:entry.session.name, id, callId, index, peer: null, after: 0, offered: false, state: 'new', row, status: label, video, level, levelLabel, gain, gainLabel };
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
      this.calls.delete(id); this.release(call, true); void this.poll();
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
      call.peer = new PeerCall({ role: 'host', stream, screenShare:true,
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
          call.state = state; row.dataset['callState'] = state;
          label.textContent = state === 'connected' ? 'Connected · live camera and microphone' : `${text}${state === 'failed' && config.iceServers.length ? ' Check connectivity, relay availability, allocation credentials and free allowance. The exact cause is unknown; no paid fallback was used.' : ''}${state === 'failed' || state === 'closed' ? ' Ask the guest to start preview, then Reconnect.' : ''}`;
          if (state === 'closed' || state === 'failed') { this.mixer?.removeGuest(id); video.srcObject = null; }
        },
      });
      await call.peer.setScreen(this.localScreen);
      void call.peer.start().catch(() => { if (current()) { call.peer?.close(); label.textContent = 'Call setup failed. Reconnect to retry.'; } });
    } catch {
      if (this.calls.get(id) !== call || generation !== this.generation) return;
      call.state = 'failed'; label.textContent = 'Call configuration or media setup failed. Check your relay account, credentials and allowance, then Reconnect. No paid fallback was used.';
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
      const admitted: GuestEntry[] = result.guests.filter((g: GuestEntry) => g.alive && !g.revoked && g.phase === 'admitted' && g.session);
      const activeIds = new Set(admitted.map(entry => entry.session!.id));
      for (const id of this.gains.keys()) if (!activeIds.has(id)) this.gains.delete(id);
      for (const [id, call] of this.calls) if (!admitted.some(g => g.session!.id === id)) {
        this.calls.delete(id); this.release(call, false); this.gains.delete(id);
      }
      for (const entry of admitted) if (!this.calls.has(entry.session!.id)) void this.create(entry);
      await Promise.all([...this.calls.values()].map(async call => {
        if (!call.peer || call.state === 'closed' || call.state === 'failed') return;
        // The offer must establish the broker queue before polling it.
        if (!call.offered) return;
        try {
          const signals = await this.bridge.pollGuestSignals(call.id, call.callId, call.after);
          if (generation !== this.generation || this.calls.get(call.id) !== call) return;
          if (!signals.ok) { call.peer.close(); call.status.textContent = 'Call setup ended. Reconnect to retry.'; return; }
          for (const item of signals.messages ?? []) {
            if (this.calls.get(call.id) !== call) return;
            await call.peer?.receive(item.message); call.after = item.sequence;
          }
          if (call.state === 'connected' && call.peer) {
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
