// CodexBWAI — authenticated transport is supplied by the guest page.
import type { CallConfiguration } from './bridge.js';
import { GUEST_CALL_VIDEO_CAP, MOBILE_GUEST_CALL_VIDEO_CAP, PeerCall, desktopGuestCodecOptions, type SignalMessage } from './peer-call.js';
type Reply = { ok: boolean; callId: string | null; messages: { sequence: number; message: SignalMessage }[]; latest: number };
const GIVE_UP_MS = 60_000;
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
  private failures = 0;
  private firstFailureAt = 0;
  private nextPollAt = 0;
  constructor(private api: (endpoint: string, body: object) => Promise<unknown>,
    private video: HTMLVideoElement, private status: HTMLElement, private audio: HTMLButtonElement, private onScreen: (stream: MediaStream | null) => void = () => {},
    /** ClaudeBWAI — einh 3 Oct ("Phone-only fix in r8"): a phone asks for H.264 and sends at the mobile cap. Desktop unchanged. */
    private mobile = false) {
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
    this.failures = 0; this.nextPollAt = 0;
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
    if (this.busy || !this.enabled || !this.stream || Date.now() < this.nextPollAt) return;
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
          // ClaudeBWAI — einh 4 Oct (CP4b): desktop guests answer H.264 first (VP8 fallback); Firefox keeps its native order (unmeasured).
          ...(this.mobile ? { preferH264: true, videoCap: MOBILE_GUEST_CALL_VIDEO_CAP } : desktopGuestCodecOptions(typeof navigator === 'undefined' ? '' : navigator.userAgent)),
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
            this.status.textContent = state === 'reconnecting' ? 'Reconnecting to the host…' : state === 'connected' ? 'Connected · your devices are live with the host. The video above is the recording view.' : `${message}${state === 'failed' && config.iceServers.length ? ' Ask the host to check relay availability, allocation credentials and free allowance. The exact cause is unknown; no paid fallback was used.' : ''}${state === 'closed' || state === 'failed' ? ' Ask the host to Reconnect.' : ''}`;
            if (state === 'closed' || state === 'failed') { this.video.srcObject = null; this.audio.hidden = true; }
          },
        });
        await this.peer.setScreen(this.screen);
        await this.peer.start();
      }
      this.failures = 0; this.nextPollAt = 0;
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
    } catch (error) {
      // A 429 or a dropped request is not the end of the call: back off and poll again; give up only after a sustained outage.
      const transient = (error as { retryable?: boolean } | null)?.retryable === true || error instanceof TypeError;
      if (transient && generation === this.generation) {
        const now = Date.now();
        if (!this.failures) this.firstFailureAt = now;
        this.failures++;
        // einh 4 Oct (r10): while the peer is recovering its media the page's outage is the same outage; PeerCall's 30 s deadline owns the end.
        if (now - this.firstFailureAt < GIVE_UP_MS || this.status.dataset['callState'] === 'reconnecting') {
          this.nextPollAt = now + Math.min(500 * 2 ** (this.failures - 1), 5000);
          return;
        }
      }
      this.failures = 0; this.nextPollAt = 0;
      if (generation === this.generation) { this.stopPeer(false); this.status.textContent = 'Call setup interrupted. Ask the host to check connectivity, relay credentials and free allowance, then Reconnect. No paid fallback was used.'; }
    } finally { this.busy = false; }
  }
  /** The live call's uplink estimate and the video cap it carries, for choosing the original's bitrate at take start. */
  async uplink(): Promise<{ availableBps: number | null; callCapBps: number }> {
    return { availableBps: await (this.peer?.outgoingBitrate() ?? Promise.resolve(null)),
      callCapBps: this.mobile ? MOBILE_GUEST_CALL_VIDEO_CAP.maxBitrate : GUEST_CALL_VIDEO_CAP.maxBitrate };
  }
  close(): void { this.update(false, null); clearInterval(this.timer); }
}
