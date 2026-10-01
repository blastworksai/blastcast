// CodexBWAI — authenticated transport is supplied by the guest page.
import type { CallConfiguration } from './bridge.js';
import { PeerCall, type SignalMessage } from './peer-call.js';
type Reply = { ok: boolean; callId: string | null; messages: { sequence: number; message: SignalMessage }[]; latest: number };
export class GuestCall {
  private stream: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private peer: PeerCall | null = null;
  private callId: string | null = null;
  private after = 0;
  private generation = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval>;
  private enabled = false;
  constructor(private api: (endpoint: string, body: object) => Promise<unknown>,
    private video: HTMLVideoElement, private status: HTMLElement, private audio: HTMLButtonElement, private onScreen: (stream: MediaStream | null) => void = () => {}) {
    this.timer = setInterval(() => void this.poll(), 500);
    audio.addEventListener('click', () => {
      void video.play().then(() => { audio.hidden = true; }).catch(() => { status.textContent = 'The browser blocked call playback. Allow sound and select Play call audio.'; });
    });
  }
  async setScreen(stream: MediaStream | null): Promise<void> {
    this.screen = this.enabled ? stream : null;
    await this.peer?.setScreen(this.screen);
  }
  update(admitted: boolean, stream: MediaStream | null): void {
    if (admitted === this.enabled && stream === this.stream) return;
    this.stopPeer(true); this.generation++; this.enabled = admitted; this.stream = stream;
    if (!admitted) this.screen = null;
    this.status.textContent = admitted && stream ? 'Waiting for the host to connect. Keep devices on at both ends.' : 'The call starts after admission with your devices on.';
    void this.poll();
  }
  private stopPeer(notify: boolean): void {
    if (notify && this.peer && this.callId) void this.api('call/send', { callId: this.callId, message: { type: 'hangup' } }).catch(() => {});
    this.peer?.close(); this.peer = null; this.onScreen(null); this.video.pause(); this.video.srcObject = null; this.audio.hidden = true;
    // Retain the old ID: only an explicit new host attempt can restart a stopped call.
  }
  private async poll(): Promise<void> {
    if (this.busy || !this.enabled || !this.stream) return;
    this.busy = true; const generation = this.generation;
    try {
      const reply = await this.api('call/poll', { callId: this.callId, after: this.after }) as Reply;
      if (generation !== this.generation || !this.stream) return;
      if (!reply.ok) throw new Error('Signaling unavailable');
      if (reply.callId && reply.callId !== this.callId) {
        this.stopPeer(false); this.callId = reply.callId; this.after = 0;
        const callId = reply.callId;
        const current = () => generation === this.generation && this.callId === callId;
        const config = await this.api('call/config', {}) as CallConfiguration;
        if (!current() || !this.enabled || !this.stream) return;
        if (!config.ok) throw new Error('Call configuration unavailable');
        this.peer = new PeerCall({ role: 'guest', stream: this.stream, screenShare: true,
          onRemoteScreen: stream => { if (current()) this.onScreen(stream); }, iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy,
          send: async message => {
            if (!current()) throw new Error('Call replaced');
            await this.api('call/send', { callId, message });
          },
          onRemoteStream: stream => {
            if (!current()) return;
            if (this.video.srcObject !== stream) this.video.srcObject = stream;
            void this.video.play().catch(() => { if (current()) this.audio.hidden = false; });
          },
          onState: (state, message) => {
            if (!current()) return;
            this.status.dataset['callState'] = state;
            this.status.textContent = state === 'connected' ? 'Connected · your devices are live with the host. The video above is the recording view.' : `${message}${state === 'failed' && config.iceServers.length ? ' Ask the host to check relay availability, allocation credentials and free allowance. The exact cause is unknown; no paid fallback was used.' : ''}${state === 'closed' || state === 'failed' ? ' Ask the host to Reconnect.' : ''}`;
            if (state === 'closed' || state === 'failed') { this.video.srcObject = null; this.audio.hidden = true; }
          },
        });
        await this.peer.setScreen(this.screen);
        await this.peer.start();
      }
      for (const item of reply.messages) {
        if (generation !== this.generation) return;
        await this.peer?.receive(item.message); this.after = item.sequence;
      }
      const peer = this.peer;
      if (peer && this.status.dataset['callState'] === 'connected') {
        const media = await peer.diagnostics();
        if (generation !== this.generation || this.peer !== peer || this.status.dataset['callState'] !== 'connected') return;
        this.status.dataset['mediaRoute'] = media.route;
        this.status.textContent = `Connected · ${media.route === 'unknown' ? 'media route not measured' : media.route + ' media route'} · received audio ${media.audioBytesReceived} B / video ${media.videoBytesReceived} B`;
      }
    } catch {
      if (generation === this.generation) { this.stopPeer(false); this.status.textContent = 'Call setup interrupted. Ask the host to check connectivity, relay credentials and free allowance, then Reconnect. No paid fallback was used.'; }
    } finally { this.busy = false; }
  }
  close(): void { this.update(false, null); clearInterval(this.timer); }
}
