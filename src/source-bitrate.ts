// ClaudeBWAI — einh, 4 Oct 2026 ("Adaptive at take start"): a guest's take is one MediaRecorder, so its bitrate is chosen
// once, when the original starts, from what the guest's uplink can carry beside the live call.
export const SOURCE_AUDIO_BPS = 128_000;
export const SOURCE_VIDEO_FAST_BPS = 4_000_000;
export const SOURCE_VIDEO_SLOW_BPS = 1_800_000;
/** What the fast original adds to the line: its own video + audio. */
export const SOURCE_FAST_LOAD_BPS = SOURCE_VIDEO_FAST_BPS + SOURCE_AUDIO_BPS;
export const SOURCE_HEADROOM = 1.25;
/** Never wait longer than this for the uplink estimate; a slow answer means the safe rate. */
export const SOURCE_PROBE_TIMEOUT_MS = 1500;
export const SOURCE_PACE_FLOOR_BYTES_PER_SEC = 262_144;
export const SOURCE_PACE_MARGIN = 1.2;

/** 4 Mbit/s only when the line carries the call video cap + the original + headroom; unknown means the safe 1.8. */
export function chooseSourceVideoBps(availableBps: number | null | undefined, callCapBps: number): number {
  if (typeof availableBps !== 'number' || !Number.isFinite(availableBps) || availableBps <= 0) return SOURCE_VIDEO_SLOW_BPS;
  return availableBps >= callCapBps + SOURCE_FAST_LOAD_BPS * SOURCE_HEADROOM ? SOURCE_VIDEO_FAST_BPS : SOURCE_VIDEO_SLOW_BPS;
}

/** During-recording upload pace for a take recorded at this rate: it must never backlog on the line it was chosen for. */
export function sourcePaceBytesPerSec(videoBps: number, audioBps = SOURCE_AUDIO_BPS): number {
  return Math.max(SOURCE_PACE_FLOOR_BYTES_PER_SEC, Math.round((videoBps + audioBps) / 8 * SOURCE_PACE_MARGIN));
}

export type SourceUplink = { availableBps: number | null; callCapBps: number };
