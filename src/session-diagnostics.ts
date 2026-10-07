// ClaudeBWAI — session diagnostics while a recording runs (einh, "Session log in r7"): every 5 s one sample of scene draw
// cost and per-guest video stats goes to main, which writes it beside the recording (desktop/session-diagnostics.cjs).
// Guest stats reuse the 2 s getStats the call rows already take (PeerCall.lastStats); nothing here polls getStats again.
// Guests are slot numbers; no name, address, candidate or token is read into a payload. Any refusal stops logging.
import type { DesktopBridge } from './bridge.js';

export const DIAGNOSTICS_INTERVAL_MS = 5000;
const MAX_STREAMS = 4;
export type InboundVideo = { codec: string | null; width: number | null; height: number | null; fps: number | null;
  framesDropped: number | null; framesDecoded: number | null; jitter: number | null; packetsLost: number | null;
  decoderImplementation: string | null; powerEfficientDecoder: boolean | null };
export type OutboundVideo = { codec: string | null; width: number | null; height: number | null; fps: number | null;
  encoderImplementation: string | null; powerEfficientEncoder: boolean | null; qualityLimitationReason: 'none' | 'cpu' | 'bandwidth' | 'other' | null;
  /** Per-window deltas (null on first sight or a reset counter); totalEncodeTime in seconds. */
  framesEncoded: number | null; totalEncodeTime: number | null; qpSum: number | null };
export type GuestSample = { slot: number; inbound: InboundVideo[]; outbound: OutboundVideo[] };
export type SceneSample = { framesDrawn: number; drawnFps: number; avgDrawMs: number | null; maxDrawMs: number | null; backend: SceneBackend };
export type RecorderInfo = { codec: string | null; mimeType: string | null };
export type DiagnosticsPayload =
  | { kind: 'start'; quality: 1080 | 2160; participants: number; recorder: RecorderInfo }
  | { kind: 'sample'; windowMs: number; participants: number; scene: SceneSample; recorder: RecorderInfo; guests: GuestSample[] }
  | { kind: 'end'; outcome: 'complete' | 'error' }
  | { kind: 'call'; slot: number; state: CallEventState; reason: CallEventReason }
  | { kind: 'compositor'; backend: SceneBackend; reason: CompositorReason };
/** ClaudeBWAI — einh 4 Oct (r10): a call's transitions, by scene slot. Enumerated values only; keep equal to desktop/session-diagnostics.cjs. */
export const CALL_EVENT_STATES = ['reconnecting', 'connected', 'failed', 'released'] as const;
export const CALL_EVENT_REASONS = ['media-lost', 'recovered', 'established', 'recovery-failed', 'setup-failed', 'page-gone', 'call-gone', 'stream-changed', 'reconnect-button'] as const;
export type CallEventState = typeof CALL_EVENT_STATES[number];
export type CallEventReason = typeof CALL_EVENT_REASONS[number];
/** ClaudeBWAI — einh 4 Oct (CP4a): which compositor drew the samples, and why it changed. Enumerated only; keep equal to desktop/session-diagnostics.cjs. */
export const SCENE_BACKENDS = ['webgl2', 'canvas2d'] as const;
export const COMPOSITOR_REASONS = ['webgl2-unavailable', 'context-lost', 'context-restored', 'fallback-canvas2d', 'recording-failed'] as const;
export type SceneBackend = typeof SCENE_BACKENDS[number];
export type CompositorReason = typeof COMPOSITOR_REASONS[number];
/** One connected call: its scene slot, an identity object for delta bookkeeping (never serialised) and its latest stats. */
export type GuestStatsSource = { slot: number; source: object; entries: readonly any[] };

// The same patterns main enforces; a value that does not fit becomes null rather than getting the whole sample refused.
const IP_LIKE = /\d{1,3}(?:\.\d{1,3}){3}/;
const text = (value: unknown, pattern: RegExp): string | null => typeof value === 'string' && pattern.test(value) && !IP_LIKE.test(value) ? value : null;
const count = (value: unknown, max = 1e9): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : null;
const real = (value: unknown, max: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 1000) / 1000 : null;
// ClaudeBWAI — Codex review of 68ea271 (P2): free-text stats become enumerated values here; main accepts only these lists
// (desktop/session-diagnostics.cjs CODECS/ENCODERS). An unknown value is 'other', a missing one null.
export const DIAGNOSTIC_CODECS = ['video/VP8', 'video/VP9', 'video/AV1', 'video/H264', 'video/H265', 'audio/opus'] as const;
export const DIAGNOSTIC_ENCODERS = ['SimulcastEncoderAdapter', 'MediaFoundationVideoEncoder', 'VideoToolbox', 'ExternalEncoder', 'OpenH264', 'libvpx', 'libaom'] as const;
export function codecName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return DIAGNOSTIC_CODECS.find(name => name.toLowerCase() === value.toLowerCase()) ?? 'other';
}
/** Chromium reports e.g. "SimulcastEncoderAdapter (libvpx, libvpx)" or "MediaFoundationVideoEncodeAccelerator": the first known name it contains. */
export function encoderName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const lower = value.toLowerCase();
  return DIAGNOSTIC_ENCODERS.find(name => lower.includes(name.toLowerCase()))
    ?? (lower.includes('mediafoundation') ? 'MediaFoundationVideoEncoder' : lower.includes('videotoolbox') ? 'VideoToolbox' : 'other');
}
// ClaudeBWAI — einh 4 Oct (CP4a): decoder names are enumerated like encoders. Specific names come BEFORE the generic ExternalDecoder,
// because Chromium reports "ExternalDecoder (D3D11VideoDecoder)" and the hardware path is the fact worth logging.
export const DIAGNOSTIC_DECODERS = ['D3D11VideoDecoder', 'MediaFoundation', 'VideoToolbox', 'VDAVideoDecoder', 'FFmpeg', 'libvpx', 'libaom', 'ExternalDecoder'] as const;
export function decoderName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const lower = value.toLowerCase();
  return DIAGNOSTIC_DECODERS.find(name => lower.includes(name.toLowerCase())) ?? 'other';
}
const codecOf = (entry: any, byId: Map<string, any>): string | null => codecName(byId.get(entry.codecId)?.mimeType);
const kindOf = (entry: any): string | undefined => entry.kind ?? entry.mediaType;
export function recorderInfo(mimeType: string): RecorderInfo {
  return { codec: text(/codecs=([a-z0-9]+)/.exec(mimeType)?.[1], /^[a-z0-9]{1,12}$/), mimeType: text(mimeType, /^video\/webm(?:;codecs=[a-z0-9.,]{1,40})?$/) };
}

/** Video streams in one getStats report, with cumulative counters keyed by stats id (the id stays in memory only).
 * An idle transceiver (the unused screen-share slot) has moved no bytes and is left out. */
export function videoStreams(entries: readonly any[]): { inbound: { id: string; video: InboundVideo }[]; outbound: { id: string; video: OutboundVideo }[] } {
  const byId = new Map(entries.filter(entry => entry && typeof entry.id === 'string').map(entry => [entry.id, entry]));
  const bytes = (entry: any, key: string) => Number.isFinite(entry[key]) ? entry[key] : 0;
  const inbound = entries.filter(entry => entry?.type === 'inbound-rtp' && entry.isRemote !== true && kindOf(entry) === 'video' && bytes(entry, 'bytesReceived') > 0)
    .sort((a, b) => bytes(b, 'bytesReceived') - bytes(a, 'bytesReceived')).slice(0, MAX_STREAMS)
    .map(entry => ({ id: String(entry.id), video: { codec: codecOf(entry, byId), width: count(entry.frameWidth, 16384), height: count(entry.frameHeight, 16384), fps: real(entry.framesPerSecond, 1000),
      framesDropped: count(entry.framesDropped), framesDecoded: count(entry.framesDecoded), jitter: real(entry.jitter, 1e4), packetsLost: count(entry.packetsLost),
      decoderImplementation: decoderName(entry.decoderImplementation), powerEfficientDecoder: typeof entry.powerEfficientDecoder === 'boolean' ? entry.powerEfficientDecoder : null } }));
  const outbound = entries.filter(entry => entry?.type === 'outbound-rtp' && kindOf(entry) === 'video' && bytes(entry, 'bytesSent') > 0)
    .sort((a, b) => bytes(b, 'bytesSent') - bytes(a, 'bytesSent')).slice(0, MAX_STREAMS)
    .map(entry => ({ id: String(entry.id), video: { codec: codecOf(entry, byId), width: count(entry.frameWidth, 16384), height: count(entry.frameHeight, 16384), fps: real(entry.framesPerSecond, 1000),
      encoderImplementation: encoderName(entry.encoderImplementation),
      powerEfficientEncoder: typeof entry.powerEfficientEncoder === 'boolean' ? entry.powerEfficientEncoder : null,
      qualityLimitationReason: ['none', 'cpu', 'bandwidth', 'other'].includes(entry.qualityLimitationReason) ? entry.qualityLimitationReason : null,
      framesEncoded: count(entry.framesEncoded), totalEncodeTime: real(entry.totalEncodeTime, 1e7), qpSum: count(entry.qpSum, 1e12) } }));
  return { inbound, outbound };
}

/** Frame draw cost over a window: cheap enough to call on every rendered frame. */
export class DrawMeter {
  private frames = 0; private total = 0; private max = 0;
  /** The compositor drawing now; the studio sets it when a backend takes over ('webgl2' or 'canvas2d'). */
  backend: SceneBackend = 'canvas2d';
  add(ms: number): void { if (!Number.isFinite(ms) || ms < 0) return; this.frames++; this.total += ms; if (ms > this.max) this.max = ms; }
  take(windowMs: number): SceneSample {
    const round = (value: number) => Math.round(value * 100) / 100;
    const sample = { framesDrawn: this.frames, drawnFps: windowMs > 0 ? round(this.frames * 1000 / windowMs) : 0,
      avgDrawMs: this.frames ? round(this.total / this.frames) : null, maxDrawMs: this.frames ? round(this.max) : null, backend: this.backend };
    this.frames = 0; this.total = 0; this.max = 0;
    return sample;
  }
}

/** Counters become per-window deltas; the first sight of a stream (or a reset counter) reports null, never a guess. */
export class GuestDeltas {
  private seen = new WeakMap<object, Map<string, Record<string, number | null>>>();
  sample(guests: readonly GuestStatsSource[]): GuestSample[] {
    return guests.map(({ slot, source, entries }) => {
      const streams = videoStreams(entries);
      const previous = this.seen.get(source) ?? new Map(), next = new Map<string, Record<string, number | null>>();
      const inbound = streams.inbound.map(({ id, video }) => {
        const before = previous.get(id); next.set(id, { framesDropped: video.framesDropped, framesDecoded: video.framesDecoded, packetsLost: video.packetsLost });
        const delta = (key: 'framesDropped' | 'framesDecoded' | 'packetsLost') => {
          const now = video[key], then = before?.[key];
          return now === null || then === null || then === undefined || now < then ? null : now - then;
        };
        return { ...video, framesDropped: delta('framesDropped'), framesDecoded: delta('framesDecoded'), packetsLost: delta('packetsLost') };
      });
      // ClaudeBWAI — einh 4 Oct (CP4a): encode counters follow the same delta rule, keyed apart from inbound ids.
      const outbound = streams.outbound.map(({ id, video }) => {
        const key = `out:${id}`, before = previous.get(key);
        next.set(key, { framesEncoded: video.framesEncoded, totalEncodeTime: video.totalEncodeTime, qpSum: video.qpSum });
        const delta = (name: 'framesEncoded' | 'totalEncodeTime' | 'qpSum') => {
          const now = video[name], then = before?.[name];
          return now === null || then === null || then === undefined || now < then ? null : Math.round((now - then) * 1000) / 1000;
        };
        return { ...video, framesEncoded: delta('framesEncoded'), totalEncodeTime: delta('totalEncodeTime'), qpSum: delta('qpSum') };
      });
      this.seen.set(source, next);
      return { slot, inbound, outbound };
    });
  }
}

/** Runs only between start() and stop(); a failed or refused write turns it off for the rest of the recording. */
export class SessionDiagnosticsLog {
  private id: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private last = 0;
  private broken = false;
  private deltas = new GuestDeltas();
  constructor(private readonly bridge: Pick<DesktopBridge, 'recordSessionDiagnostics'>, private readonly meter: DrawMeter,
    private readonly read: () => { participants: number; guests: GuestStatsSource[] }, private readonly recorder: RecorderInfo,
    private readonly intervalMs = DIAGNOSTICS_INTERVAL_MS, private readonly now = () => performance.now()) {}
  get active(): boolean { return this.id !== null; }
  private send(id: string, payload: DiagnosticsPayload): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (this.broken) return;
      try { if (!(await this.bridge.recordSessionDiagnostics(id, payload))?.ok) this.broken = true; }
      catch { this.broken = true; }
    });
    return this.tail;
  }
  start(id: string, quality: 1080 | 2160): void {
    if (this.id) return;
    this.id = id; this.broken = false; this.deltas = new GuestDeltas();
    let snapshot: { participants: number; guests: GuestStatsSource[] } = { participants: 1, guests: [] };
    try { snapshot = this.read(); this.deltas.sample(snapshot.guests); } catch { /* the first sample reports null deltas */ }
    this.meter.take(0); this.last = this.now();
    void this.send(id, { kind: 'start', quality, participants: snapshot.participants, recorder: this.recorder });
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }
  private sample(): void {
    const id = this.id; if (!id) return;
    if (this.broken) { clearInterval(this.timer); return; }
    try {
      const at = this.now(), windowMs = Math.max(0, Math.round(at - this.last)); this.last = at;
      const { participants, guests } = this.read();
      void this.send(id, { kind: 'sample', windowMs, participants, scene: this.meter.take(windowMs), recorder: this.recorder, guests: this.deltas.sample(guests) });
    } catch { this.broken = true; clearInterval(this.timer); }
  }
  /** One call transition while a recording runs; outside a recording it is dropped, and it never breaks the log. */
  event(slot: number, state: CallEventState, reason: CallEventReason): void {
    const id = this.id; if (!id || this.broken) return;
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 7) return;
    void this.send(id, { kind: 'call', slot, state, reason });
  }
  /** ClaudeBWAI — einh 4 Oct (CP4a): a compositor change while a recording runs; dropped outside one, and it never breaks the log. */
  compositorEvent(reason: CompositorReason, backend: SceneBackend): void {
    const id = this.id; if (!id || this.broken) return;
    if (!(COMPOSITOR_REASONS as readonly string[]).includes(reason) || !(SCENE_BACKENDS as readonly string[]).includes(backend)) return;
    void this.send(id, { kind: 'compositor', backend, reason });
  }
  /** Stops sampling; the end line follows only once the outcome is known. */
  pause(): void { clearInterval(this.timer); this.timer = undefined; }
  stop(outcome: 'complete' | 'error'): Promise<void> {
    const id = this.id; this.pause(); this.id = null;
    if (!id) return Promise.resolve();
    return this.send(id, { kind: 'end', outcome });
  }
}

/** ClaudeBWAI — einh 4 Oct (CP4a): the one call the studio makes to log a compositor event (it also sets meter.backend itself). */
export function logCompositorEvent(log: Pick<SessionDiagnosticsLog, 'compositorEvent'> | null | undefined, reason: CompositorReason, backend: SceneBackend): void {
  try { log?.compositorEvent(reason, backend); } catch { /* diagnostics never reach the caller */ }
}
