// CodexBWAI — version-one participant-local source contract. IDs are correlation, not authority.
export const SOURCE_MIME = 'video/webm;codecs=vp8,opus';
export const SOURCE_MAX_CHUNK = 8 * 1024 * 1024;
export const SOURCE_MAX_PENDING = 16 * 1024 * 1024;
export type SourceFailure = { ok: false; message: string };
export type SourceClock = { hostNowMs: number; localMonoMs: number; uncertaintyMs: number };
export type SourceDescriptor = { episodeId: string; epochId: string; mimeType: string;
  startedMonoMs: number; hostStartedMs: number; clockUncertaintyMs: number; width: number; height: number };
export type SourceChunk = { episodeId: string; epochId: string; sequence: number; byteLength: number;
  sha256: string; startMonoMs: number; endMonoMs: number };
export type SourceEnd = { episodeId: string; epochId: string; chunkCount: number; endedMonoMs: number };
export type SourceBeginAck = { ok: true; episodeId: string; epochId: string } | SourceFailure;
export type SourceChunkAck = { ok: true; episodeId: string; epochId: string; sequence: number; sha256: string; byteLength: number } | SourceFailure;
export type SourceFinishAck = { ok: true; episodeId: string; epochId: string; name: string; bytes: number } | SourceFailure;
export type SourceTransport = {
  begin(descriptor: SourceDescriptor): Promise<SourceBeginAck>;
  append(chunk: SourceChunk, bytes: ArrayBuffer): Promise<SourceChunkAck>;
  finish(end: SourceEnd): Promise<SourceFinishAck>;
};
export type SourcePhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'complete' | 'incomplete';
export type SourceCaptureState = { phase: SourcePhase; episodeId: string | null; epochId: string | null;
  capturedBytes: number; acknowledgedBytes: number; pendingBytes: number; message: string };
export type SourceStart = { episodeId: string; epochId: string; clock: SourceClock };

export type SourceSummaryPhase = 'pending' | 'recording' | 'finalizing' | 'complete' | 'incomplete';
export type SourceSummary = { participantId: string; label: string; phase: SourceSummaryPhase; failed: boolean;
  epochs: { epochId: string; phase: SourceSummaryPhase; bytes: number; chunks: number; name?: string }[];
  bytes: number; message?: string };
export type SourceStatus = { episodeId: string; hostNowMs: number; phase: 'recording' | 'stopped' | 'closed'; closing?: boolean;
  recovered?: boolean; incompleteOverrideInMs?: number | null;
  sources: SourceSummary[]; allSourcesComplete: boolean };
export type SourceControl = { ok: true; episode: { episodeId: string; phase: 'recording' | 'stopped' | 'closed';
  participantId: string; hostNowMs: number; eligible: boolean; recoveryKey?: string } | null; source: SourceSummary | null };
