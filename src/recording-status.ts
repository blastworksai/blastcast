// CodexBWAI — delivery and synchronization have separate evidence and separate states.
import type { RecordingState } from './recording.js';
import type { SourceStatus, SourceSummary } from './source-protocol.js';
// Moved from the removed src/synchronization.ts; the assessor lives in experiments/bcast-7-sync/.
export const SYNCHRONIZATION_LIMIT_MS = 40;

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

// ClaudeBWAI — the originals wait line follows closePolicy (canFinishIncomplete), so it never promises an hour
// while Finish with missing originals is already available.
export function originalsWaitMessage(value: SourceStatus | null): string {
  if (value?.recovered && !value.allSourcesComplete)
    return 'Recovered originals from an interrupted studio. Guests can no longer reconnect to them. Verified files are kept; press Finish with missing originals to keep the partial files as incomplete and record again.';
  if (value?.phase !== 'stopped' || value.allSourcesComplete) return 'Original backup set pending. Keep the studio and guest pages open.';
  if (value.canFinishIncomplete) return value.finishReason === 'overdue'
    ? 'More than an hour has passed since production finished. You can now explicitly finish with missing originals.'
    : 'No guest is still sending an original. You can finish with missing originals now.';
  const remaining = value.incompleteOverrideInMs;
  return remaining == null || remaining === 0 ? 'Keep the studio open while connected guests send their originals.'
    : `Keep the studio open while connected guests send their originals. Finish with missing originals unlocks when they stop sending, or in ${Math.ceil(remaining / 60000)} min.`;
}
