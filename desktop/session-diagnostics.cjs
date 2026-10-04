// ClaudeBWAI — local session diagnostics, written beside the recording while it runs (einh, "Session log in r7").
// The renderer sends start/sample/end payloads through the recording bridge; main owns the path (derived from the active
// recording's target), adds process metrics and machine facts, and appends one JSON object per line. Nothing here is
// uploaded. Guests are slot numbers only: the schema has no field that can carry a name, an address or a token, and
// every string is pattern-checked. A full log, a refused payload or an I/O failure stops logging; recording never sees it.
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 32 * 1024;
const MAX_GUESTS = 8, MAX_STREAMS = 4;
const IP_LIKE = /\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i;
const num = max => v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
const int = max => v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= max);
const text = pattern => v => v === null || (typeof v === 'string' && pattern.test(v) && !IP_LIKE.test(v));
const bool = v => v === null || typeof v === 'boolean';
const oneOf = (...values) => v => v === null || values.includes(v);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
// Exactly these keys, each valid: an unknown key (a path, a name) is a refusal, never a silent drop.
const shape = spec => v => plain(v) && Object.keys(v).length === Object.keys(spec).length && Object.entries(spec).every(([key, ok]) => Object.hasOwn(v, key) && ok(v[key]));
const list = (max, item) => v => Array.isArray(v) && v.length <= max && v.every(item);
// ClaudeBWAI — Codex review of 68ea271 (P2): no free text. Every string field is an enumerated value, so nothing shaped like
// a name, a path or a token can be written (the old patterns let "Alice Smith" or a long base64url string through).
// Keep these lists equal to the renderer's in src/session-diagnostics.ts.
const CODECS = ['video/VP8', 'video/VP9', 'video/AV1', 'video/H264', 'video/H265', 'audio/opus', 'other'];
const ENCODERS = ['libvpx', 'libaom', 'OpenH264', 'ExternalEncoder', 'MediaFoundationVideoEncoder', 'VideoToolbox', 'SimulcastEncoderAdapter', 'other'];
const LIMITATIONS = ['none', 'cpu', 'bandwidth', 'other'];
const codec = oneOf(...CODECS);
const recorder = shape({ codec: oneOf('vp8', 'vp9', 'av1', 'h264'), mimeType: oneOf('video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=av1,opus', 'video/webm;codecs=h264,opus') });
const inbound = shape({ codec, width: int(16384), height: int(16384), fps: num(1000), framesDropped: int(1e9), framesDecoded: int(1e9), jitter: num(1e4), packetsLost: int(1e9) });
const outbound = shape({ codec, width: int(16384), height: int(16384), fps: num(1000), encoderImplementation: oneOf(...ENCODERS),
  powerEfficientEncoder: bool, qualityLimitationReason: oneOf(...LIMITATIONS) });
const guest = shape({ slot: v => Number.isSafeInteger(v) && v >= 1 && v <= 7, inbound: list(MAX_STREAMS, inbound), outbound: list(MAX_STREAMS, outbound) });
const scene = shape({ framesDrawn: int(1e6), drawnFps: num(1000), avgDrawMs: num(6e4), maxDrawMs: num(6e4) });
// ClaudeBWAI — einh 4 Oct (r10): call transitions by slot. Enumerated, like everything else; keep equal to src/session-diagnostics.ts.
const CALL_STATES = ['reconnecting', 'connected', 'failed', 'released'];
const CALL_REASONS = ['media-lost', 'recovered', 'established', 'recovery-failed', 'setup-failed', 'page-gone', 'call-gone', 'stream-changed', 'reconnect-button'];
const notNull = ok => v => v !== null && ok(v);
const PAYLOADS = {
  call: shape({ kind: v => v === 'call', slot: v => Number.isSafeInteger(v) && v >= 1 && v <= 7, state: notNull(oneOf(...CALL_STATES)), reason: notNull(oneOf(...CALL_REASONS)) }),
  start: shape({ kind: v => v === 'start', quality: v => v === 1080 || v === 2160, participants: int(MAX_GUESTS), recorder }),
  sample: shape({ kind: v => v === 'sample', windowMs: int(36e5), participants: int(MAX_GUESTS), scene, recorder, guests: list(MAX_GUESTS - 1, guest) }),
  end: shape({ kind: v => v === 'end', outcome: oneOf('complete', 'error') }),
};
function validDiagnostics(payload) {
  if (!plain(payload) || !Object.hasOwn(PAYLOADS, payload.kind)) return false;
  try { if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) return false; } catch { return false; }
  return PAYLOADS[payload.kind](payload);
}
// <recording base>-diagnostics.jsonl, in the recording's own folder. Only main ever computes it.
function diagnosticsPath(target) { return path.join(path.dirname(target), `${path.basename(target, '.webm')}-diagnostics.jsonl`); }
// app.getAppMetrics() grouped by process type ("Tab" is Chromium's name for a renderer). CPU is percent since the last call.
function processMetrics(metrics) {
  const byType = {}; let cpu = 0, memoryKiB = 0;
  for (const item of Array.isArray(metrics) ? metrics : []) {
    const type = item?.type === 'Tab' ? 'Renderer' : typeof item?.type === 'string' ? item.type : 'Unknown';
    const usage = Number(item?.cpu?.percentCPUUsage) || 0, memory = Number(item?.memory?.workingSetSize) || 0;
    const entry = byType[type] ??= { count: 0, cpu: 0, memoryKiB: 0 };
    entry.count++; entry.cpu += usage; entry.memoryKiB += memory; cpu += usage; memoryKiB += memory;
  }
  for (const entry of Object.values(byType)) entry.cpu = Math.round(entry.cpu * 10) / 10;
  return { cpu: Math.round(cpu * 10) / 10, memoryKiB, byType };
}
function createSessionDiagnostics({ current, io = fs, info = async () => ({}), metrics = () => [], now = () => new Date(), maxBytes = MAX_LOG_BYTES }) {
  let log = null;
  async function write(state, object) {
    const line = `${JSON.stringify(object)}\n`, size = Buffer.byteLength(line);
    if (state.bytes + size > maxBytes) { state.stopped = true; return; }
    state.bytes += size;
    await io.appendFile(state.file, line, { mode: 0o600, flag: 'a' });
  }
  async function line(payload) {
    const { kind, ...rest } = payload, t = now().toISOString();
    // getAppMetrics reports CPU since its previous call, so the start line takes the baseline the first sample is measured from.
    if (kind === 'start') { try { metrics(); } catch { /* the first sample's CPU reads 0 */ } return { type: 'start', t, ...(await info()), ...rest }; }
    if (kind === 'call') return { type: 'call', t, ...rest };
    if (kind === 'sample') return { type: 'sample', t, ...rest, process: processMetrics(metrics()) };
    return { type: 'end', t, ...rest };
  }
  return {
    // Never throws: the caller is a recording-time bridge and a diagnostics failure must stay invisible to it.
    async record(id, payload) {
      try {
        if (!validDiagnostics(payload)) return { ok: false };
        const active = current();
        if (!active || active.id !== id || typeof active.target !== 'string') return { ok: false };
        if (!log || log.id !== id) {
          if (payload.kind !== 'start') return { ok: false };
          log = { id, file: diagnosticsPath(active.target), bytes: 0, stopped: false, ended: false, tail: Promise.resolve() };
        } else if (payload.kind === 'start') return { ok: false };
        const state = log;
        if (state.stopped || state.ended) return { ok: false };
        if (payload.kind === 'end') state.ended = true;
        state.tail = state.tail.then(async () => { if (!state.stopped) await write(state, await line(payload)); }).catch(() => { state.stopped = true; });
        await state.tail;
        return { ok: !state.stopped };
      } catch { if (log) log.stopped = true; return { ok: false }; }
    },
  };
}
module.exports = { CALL_STATES, CALL_REASONS, CODECS, ENCODERS, LIMITATIONS, createSessionDiagnostics, validDiagnostics, diagnosticsPath, processMetrics, MAX_LOG_BYTES, MAX_PAYLOAD_CHARS };
