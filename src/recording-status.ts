// CodexBWAI — delivery and synchronization have separate evidence and separate states.
import type { RecordingState } from './recording.js';
import type { SourceStatus, SourceSummary } from './source-protocol.js';
import { SYNCHRONIZATION_LIMIT_MS } from './synchronization.js';

export type DeliveryState = 'not_started' | 'recording' | 'transferring' | 'finalizing' | 'saved' | 'verified' | 'incomplete' | 'failed';
export type RecordingRow = {
  id: string; label: string; kind: 'Mixed episode' | 'Participant original';
  delivery: DeliveryState; deliveryLabel: string; detail: string;
  synchronization: { state: 'not_measured'; label: 'Not measured'; limitMs: 40 };
};
const deliveryLabels: Record<DeliveryState, string> = {
  not_started: 'Not started', recording: 'Recording', transferring: 'Transferring', finalizing: 'Finalizing',
  saved: 'Saved', verified: 'Verified', incomplete: 'Incomplete', failed: 'Failed',
};
const mixedDelivery: Record<RecordingState['phase'], DeliveryState> = {
  idle: 'not_started', starting: 'not_started', recording: 'recording', finalizing: 'finalizing', complete: 'saved', error: 'failed',
};
function sourceDelivery(source: SourceSummary, phase: SourceStatus['phase']): DeliveryState {
  if (source.failed) return 'failed';
  switch (source.phase) {
    case 'complete': return 'verified';
    case 'incomplete': return 'incomplete';
    case 'pending': return phase === 'recording' ? 'not_started' : 'incomplete';
    case 'recording': return phase === 'recording' ? 'recording' : 'transferring';
    case 'finalizing': return 'finalizing';
  }
}
function row(id: string, label: string, kind: RecordingRow['kind'], delivery: DeliveryState, detail: string): RecordingRow {
  return { id, label, kind, delivery, deliveryLabel: deliveryLabels[delivery], detail,
    synchronization: { state: 'not_measured', label: 'Not measured', limitMs: SYNCHRONIZATION_LIMIT_MS } };
}
export function recordingRows(mixed: RecordingState, originals: SourceStatus | null): RecordingRow[] {
  const rows = [row('mixed', 'Mixed episode', 'Mixed episode', mixedDelivery[mixed.phase], mixed.message)];
  // A source poll can still carry the previous episode while a new begin is pending or fails.
  if (!originals || (!originals.recovered && (!mixed.episodeId || originals.episodeId !== mixed.episodeId))) return rows;
  for (const source of originals.sources) {
    const delivery = sourceDelivery(source, originals.phase);
    const detail = delivery === 'verified' ? 'Original received and verified on disk.'
      : delivery === 'failed' ? 'Saving or verification failed. Saved media is retained.'
      : delivery === 'incomplete' ? originals.recovered ? 'Original incomplete after restart. Saved media has been kept.'
        : originals.phase === 'closed' ? 'Original incomplete. Saved media has been kept.'
        : 'Original incomplete. Keep the studio and guest page open while delivery is pending.'
      : `${(source.bytes / 1048576).toFixed(1)} MB received`;
    rows.push(row(`original:${source.participantId}`, source.label, 'Participant original', delivery, detail));
  }
  return rows;
}
