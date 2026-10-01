// DiuleJ native implementation (35d8ea0); CodexBWAI input-boundary review/fixes.
// Assesses supplied measurements only; callers bind the roster and markers to real media.
export const SYNCHRONIZATION_LIMIT_MS = 40;
export const TWO_HOUR_MS = 7200000;

export type ComparisonKind = 'audio-video' | 'inter-track-audio' | 'inter-track-video';
export type MarkerPoint = 'start' | 'middle' | 'end';

export type MarkerInput = {
    point: MarkerPoint;
    referenceMs: number;
    targetMs: number;
    uncertaintyMs: number;
};

export type ComparisonInput = {
    id: string;
    kind: ComparisonKind;
    markers: MarkerInput[];
};

export type SynchronizationInput = {
    version: 1;
    durationMs: number;
    comparisons: ComparisonInput[];
    requiredComparisonIds: string[];
};

export type MarkerState = 'within_limit' | 'outside_limit' | 'indeterminate';

export type ComputedMarker = {
    point: MarkerPoint;
    referenceMs: number;
    targetMs: number;
    uncertaintyMs: number;
    offsetMs: number;
    worstCaseAbsMs: number;
    state: MarkerState;
};

export type ComputedComparison = {
    id: string;
    kind: ComparisonKind;
    state: MarkerState;
    markers: ComputedMarker[];
    driftMs: number;
    driftUncertaintyMs: number;
    maxWorstCaseAbsMs: number;
};

export type SynchronizationAssessment = 
    | {
        state: 'not_measured';
        limitMs: 40;
        qualification: 'not_verified';
        comparisons: [];
        checkedComparisonIds: [];
        checkCount: 0;
        reason: string;
      }
    | {
        state: 'within_limit' | 'outside_limit' | 'indeterminate';
        limitMs: 40;
        durationMs: number;
        qualification: 'two_hour_verified' | 'sample_only' | 'not_verified';
        comparisons: ComputedComparison[];
        checkedComparisonIds: string[];
        checkCount: number;
      };

const VALID_KINDS = new Set(['audio-video', 'inter-track-audio', 'inter-track-video']);
const VALID_POINTS = new Set(['start', 'middle', 'end']);

function isObject(val: unknown): val is Record<string, unknown> {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
    const prototype = Object.getPrototypeOf(val);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(obj: Record<string, unknown>, keys: string[]): boolean {
    const objKeys = Reflect.ownKeys(obj);
    if (objKeys.length !== keys.length) return false;
    for (const key of objKeys) {
        if (typeof key !== 'string' || !keys.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return true;
}

// Only bounded, dense data arrays cross this boundary; never run custom iterators/getters.
function isDataArray(val: unknown, min: number, max: number): val is unknown[] {
    if (!Array.isArray(val) || Object.getPrototypeOf(val) !== Array.prototype) return false;
    const length = Object.getOwnPropertyDescriptor(val, 'length')?.value as unknown;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < min || length > max) return false;
    if (Reflect.ownKeys(val).length !== length + 1) return false;
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(val, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return true;
}

function isValidId(id: unknown): id is string {
    return typeof id === 'string' && id.length >= 1 && id.length <= 120 && /^[\x20-\x7E]+$/.test(id);
}

function isFiniteNonNegativeNumber(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function notMeasured(reason: string): SynchronizationAssessment {
    return {
        state: 'not_measured',
        limitMs: 40,
        qualification: 'not_verified',
        comparisons: [],
        checkedComparisonIds: [],
        checkCount: 0,
        reason
    };
}

export function assessSynchronization(input: unknown): SynchronizationAssessment {
    // Unknown input may include a revoked/throwing proxy. Never expose its exception or payload.
    try { return assessEvidence(input); }
    catch { return notMeasured('Unreadable evidence'); }
}

function assessEvidence(input: unknown): SynchronizationAssessment {
    if (!isObject(input)) return notMeasured('Input is not an object');
    if (!hasOnlyKeys(input, ['version', 'durationMs', 'comparisons', 'requiredComparisonIds'])) return notMeasured('Invalid input keys');
    
    if (input.version !== 1) return notMeasured('Invalid version');
    if (!isFiniteNonNegativeNumber(input.durationMs) || input.durationMs === 0 || input.durationMs > 86400000) return notMeasured('Invalid durationMs');
    
    if (!isDataArray(input.comparisons, 1, 24)) return notMeasured('Invalid comparisons array');
    if (!isDataArray(input.requiredComparisonIds, 1, 24)) return notMeasured('Invalid requiredComparisonIds array');

    const durationMs = input.durationMs;
    const windowMs = Math.min(10000, durationMs / 4);

    const reqIds = new Set<string>();
    for (const id of input.requiredComparisonIds) {
        if (!isValidId(id)) return notMeasured('Invalid requiredComparisonId');
        if (reqIds.has(id)) return notMeasured('Duplicate requiredComparisonId');
        reqIds.add(id);
    }

    if (reqIds.size !== input.comparisons.length) return notMeasured('comparisons and requiredComparisonIds length mismatch');

    const comparisonsMap = new Map<string, ComputedComparison>();
    
    for (const comp of input.comparisons) {
        if (!isObject(comp)) return notMeasured('Comparison is not an object');
        if (!hasOnlyKeys(comp, ['id', 'kind', 'markers'])) return notMeasured('Invalid comparison keys');
        if (!isValidId(comp.id)) return notMeasured('Invalid comparison id');
        if (comparisonsMap.has(comp.id)) return notMeasured('Duplicate comparison id');
        if (!reqIds.has(comp.id)) return notMeasured('Comparison id not in requiredComparisonIds');
        if (typeof comp.kind !== 'string' || !VALID_KINDS.has(comp.kind)) return notMeasured('Invalid comparison kind');
        if (!isDataArray(comp.markers, 3, 3)) return notMeasured('Invalid markers array length');

        const markersByPoint = new Map<string, ComputedMarker>();
        for (const marker of comp.markers) {
            if (!isObject(marker)) return notMeasured('Marker is not an object');
            if (!hasOnlyKeys(marker, ['point', 'referenceMs', 'targetMs', 'uncertaintyMs'])) return notMeasured('Invalid marker keys');
            if (typeof marker.point !== 'string' || !VALID_POINTS.has(marker.point)) return notMeasured('Invalid marker point');
            if (markersByPoint.has(marker.point)) return notMeasured('Duplicate marker point');
            
            if (!isFiniteNonNegativeNumber(marker.referenceMs) || marker.referenceMs > durationMs + 60000) return notMeasured('Invalid referenceMs');
            if (!isFiniteNonNegativeNumber(marker.targetMs) || marker.targetMs > durationMs + 60000) return notMeasured('Invalid targetMs');
            if (!isFiniteNonNegativeNumber(marker.uncertaintyMs) || marker.uncertaintyMs > 60000) return notMeasured('Invalid uncertaintyMs');
            
            const offsetMs = marker.targetMs - marker.referenceMs;
            const worstCaseAbsMs = Math.abs(offsetMs) + marker.uncertaintyMs;
            
            let mState: MarkerState = 'indeterminate';
            if (worstCaseAbsMs <= 40) mState = 'within_limit';
            else if (Math.max(0, Math.abs(offsetMs) - marker.uncertaintyMs) > 40) mState = 'outside_limit';
            
            markersByPoint.set(marker.point, {
                point: marker.point as MarkerPoint,
                referenceMs: marker.referenceMs,
                targetMs: marker.targetMs,
                uncertaintyMs: marker.uncertaintyMs,
                offsetMs,
                worstCaseAbsMs,
                state: mState
            });
        }

        const start = markersByPoint.get('start')!;
        const middle = markersByPoint.get('middle')!;
        const end = markersByPoint.get('end')!;

        if (start.referenceMs < 0 || start.referenceMs > windowMs) return notMeasured('Start reference outside window');
        if (middle.referenceMs < durationMs / 2 - windowMs || middle.referenceMs > durationMs / 2 + windowMs) return notMeasured('Middle reference outside window');
        if (end.referenceMs < durationMs - windowMs || end.referenceMs > durationMs) return notMeasured('End reference outside window');

        if (!(start.referenceMs < middle.referenceMs && middle.referenceMs < end.referenceMs)) return notMeasured('References not strictly increasing');
        if (!(start.targetMs < middle.targetMs && middle.targetMs < end.targetMs)) return notMeasured('Targets not strictly increasing');

        let cState: MarkerState = 'within_limit';
        for (const m of [start, middle, end]) {
            if (m.state === 'outside_limit') { cState = 'outside_limit'; break; }
        }
        if (cState === 'within_limit') {
            for (const m of [start, middle, end]) {
                if (m.state === 'indeterminate') { cState = 'indeterminate'; break; }
            }
        }

        const driftMs = end.offsetMs - start.offsetMs;
        const driftUncertaintyMs = end.uncertaintyMs + start.uncertaintyMs;
        const maxWorstCaseAbsMs = Math.max(start.worstCaseAbsMs, middle.worstCaseAbsMs, end.worstCaseAbsMs);

        comparisonsMap.set(comp.id, {
            id: comp.id,
            kind: comp.kind as ComparisonKind,
            state: cState,
            markers: [start, middle, end],
            driftMs,
            driftUncertaintyMs,
            maxWorstCaseAbsMs
        });
    }

    const computedComparisons: ComputedComparison[] = [];
    const checkedComparisonIds: string[] = [];
    let topState: MarkerState = 'within_limit';

    for (const id of reqIds) {
        const comp = comparisonsMap.get(id);
        if (!comp) return notMeasured('Missing required comparison');
        computedComparisons.push(comp);
        checkedComparisonIds.push(id);
        if (topState !== 'outside_limit') {
            if (comp.state === 'outside_limit') {
                topState = 'outside_limit';
            } else if (comp.state === 'indeterminate' && topState === 'within_limit') {
                topState = 'indeterminate';
            }
        }
    }

    let qualification: 'two_hour_verified' | 'sample_only' | 'not_verified' = 'not_verified';
    if (topState === 'within_limit') {
        if (durationMs >= TWO_HOUR_MS) {
            qualification = 'two_hour_verified';
        } else {
            qualification = 'sample_only';
        }
    }

    return {
        state: topState,
        limitMs: 40,
        durationMs,
        qualification,
        comparisons: computedComparisons,
        checkedComparisonIds,
        checkCount: input.comparisons.length * 3
    };
}
