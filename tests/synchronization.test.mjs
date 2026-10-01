import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSynchronization, SYNCHRONIZATION_LIMIT_MS, TWO_HOUR_MS } from '../dist/synchronization.js';

// DiuleJ's native fixtures, extended by CodexBWAI against the reviewed contract.
// Numeric fixtures exercise assessment rules; they do not qualify recorded media.
function evidence(durationMs = TWO_HOUR_MS, offsets = [0, 0, 0], uncertaintyMs = 0) {
    const times = [Math.min(100, durationMs / 8), durationMs / 2, durationMs - Math.min(100, durationMs / 8)];
    return {
        version: 1, durationMs, requiredComparisonIds: ['host-av'],
        comparisons: [{ id: 'host-av', kind: 'audio-video', markers:
            ['start', 'middle', 'end'].map((point, index) => ({
                point, referenceMs: times[index], targetMs: times[index] + offsets[index], uncertaintyMs
            }))
        }]
    };
}

function assertNotMeasured(input, label) {
    const result = assessSynchronization(input);
    assert.equal(result.state, 'not_measured', label);
    assert.equal(result.qualification, 'not_verified', label);
    assert.equal(result.limitMs, 40);
    assert.equal(result.checkCount, 0);
    assert.deepEqual(result.checkedComparisonIds, []);
    assert.deepEqual(result.comparisons, []);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length < 120);
}

test('40ms is inclusive in both directions; uncertainty never grants an unsupported pass', () => {
    assert.equal(SYNCHRONIZATION_LIMIT_MS, 40);
    for (const [offset, uncertainty, state] of [
        [40, 0, 'within_limit'], [-40, 0, 'within_limit'],
        [40.001, 0, 'outside_limit'], [-40.001, 0, 'outside_limit'],
        [35, 5, 'within_limit'], [-35, 5, 'within_limit'],
        [45, 5, 'indeterminate'], [-45, 5, 'indeterminate'],
        [45.001, 5, 'outside_limit'], [-45.001, 5, 'outside_limit'],
        [0, 40, 'within_limit'], [0, 40.001, 'indeterminate']
    ]) {
        const result = assessSynchronization(evidence(TWO_HOUR_MS, [offset, offset, offset], uncertainty));
        assert.equal(result.state, state, `${offset} +/- ${uncertainty}`);
        assert.equal(result.comparisons[0].state, state);
        assert.ok(result.comparisons[0].markers.every(marker => marker.state === state));
        assert.equal(result.qualification, state === 'within_limit' ? 'two_hour_verified' : 'not_verified');
    }
});

test('qualification uses measured duration and drift has no hidden acceptance limit', () => {
    for (const [duration, qualification] of [[1, 'sample_only'], [TWO_HOUR_MS - 1, 'sample_only'],
        [TWO_HOUR_MS, 'two_hour_verified'], [86400000, 'two_hour_verified']]) {
        assert.equal(assessSynchronization(evidence(duration)).qualification, qualification);
    }
    const result = assessSynchronization(evidence(TWO_HOUR_MS, [-40, 0, 40]));
    assert.equal(result.state, 'within_limit');
    assert.equal(result.comparisons[0].driftMs, 80);
    assert.equal(result.comparisons[0].maxWorstCaseAbsMs, 40);
});

test('output normalizes required IDs and marker names without mutating or sharing input', () => {
    const input = evidence();
    const other = structuredClone(input.comparisons[0]);
    other.id = 'guest-av'; other.kind = 'inter-track-video';
    input.comparisons.push(other);
    input.requiredComparisonIds = ['guest-av', 'host-av'];
    input.comparisons[0].markers.reverse();
    const before = structuredClone(input);
    function freeze(value) {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    }
    freeze(input);
    const result = assessSynchronization(input);
    assert.equal(result.state, 'within_limit');
    assert.equal(result.checkCount, 6);
    assert.deepEqual(result.checkedComparisonIds, ['guest-av', 'host-av']);
    assert.deepEqual(result.comparisons.map(comparison => comparison.id), ['guest-av', 'host-av']);
    assert.deepEqual(result.comparisons[1].markers.map(marker => marker.point), ['start', 'middle', 'end']);
    result.comparisons[0].markers[0].targetMs = 999;
    result.checkedComparisonIds.pop();
    assert.deepEqual(input, before);
    assert.equal(assessSynchronization(input).checkCount, 6);
});

test('any definite failure outranks ambiguity regardless of comparison order', () => {
    for (const reverse of [false, true]) {
        const input = evidence(TWO_HOUR_MS, [42, 42, 42], 5);
        const failed = evidence(TWO_HOUR_MS, [-50, -50, -50], 5).comparisons[0];
        failed.id = 'guest-av';
        input.comparisons.push(failed); input.requiredComparisonIds.push(failed.id);
        if (reverse) input.requiredComparisonIds.reverse();
        assert.equal(assessSynchronization(input).state, 'outside_limit');
    }
});

test('missing, duplicate, malformed or out-of-coverage evidence never returns partial success', () => {
    const changes = [
        input => { input.version = 2; },
        input => { input.durationMs = 0; },
        input => { input.durationMs = 86400001; },
        input => { input.durationMs *= 2; }, // markers do not cover the claimed duration
        input => { input.requiredComparisonIds = []; },
        input => { input.requiredComparisonIds.push('missing'); },
        input => { input.requiredComparisonIds.push('host-av'); },
        input => { input.requiredComparisonIds[0] = '\n'; },
        input => { input.comparisons.push(structuredClone(input.comparisons[0])); },
        input => { input.comparisons[0].id = 'unrequested'; },
        input => { input.comparisons[0].kind = 'unknown'; },
        input => { input.comparisons[0].extra = true; },
        input => { input.comparisons[0].markers.pop(); },
        input => { input.comparisons[0].markers[2].point = 'start'; },
        input => { input.comparisons[0].markers[2].point = 'unknown'; },
        input => { input.comparisons[0].markers[0].extra = true; },
        input => { input.comparisons[0].markers[0].referenceMs = 10001; },
        input => { input.comparisons[0].markers[1].referenceMs += 10001; },
        input => { input.comparisons[0].markers[2].referenceMs -= 10001; },
        input => { input.comparisons[0].markers[2].referenceMs = input.durationMs + 1; },
        input => { input.comparisons[0].markers[1].targetMs = 100; },
        input => { input.comparisons[0].markers[2].targetMs = input.durationMs + 60001; },
        input => { input.comparisons[0].markers[0].uncertaintyMs = 60001; }
    ];
    for (const [index, change] of changes.entries()) {
        const input = evidence(); change(input); assertNotMeasured(input, `case ${index}`);
    }
    for (const value of [NaN, Infinity, -Infinity, -1, '40', null, undefined, {}, 40n]) {
        for (const key of ['referenceMs', 'targetMs', 'uncertaintyMs']) {
            const input = evidence(); input.comparisons[0].markers[1][key] = value;
            assertNotMeasured(input, key);
        }
        const input = evidence(); input.durationMs = value; assertNotMeasured(input, 'durationMs');
    }
    assertNotMeasured({ checksum: 'verified', durationMs: TWO_HOUR_MS });
    const partial = evidence(); partial.comparisons[0].markers = [partial.comparisons[0].markers[0]];
    assertNotMeasured(partial);
});

test('strict plain data excludes inherited fields, symbols, hidden extras and accessor execution', () => {
    const inherited = evidence(); Object.setPrototypeOf(inherited, { polluted: true });
    assertNotMeasured(inherited, 'custom prototype');
    const polluted = evidence(); Object.defineProperty(polluted, '__proto__', { value: {} });
    assertNotMeasured(polluted, 'hidden prototype field');
    const symbol = evidence(); symbol[Symbol('extra')] = true;
    assertNotMeasured(symbol, 'symbol key');
    const sparse = evidence(); delete sparse.comparisons[0].markers[1];
    assertNotMeasured(sparse, 'sparse array');
    let reads = 0;
    const accessor = evidence();
    Object.defineProperty(accessor, 'durationMs', { get() { reads++; throw new Error('private payload'); } });
    assertNotMeasured(accessor, 'accessor');
    assert.equal(reads, 0);
    const arrayAccessor = evidence();
    Object.defineProperty(arrayAccessor.comparisons, '0', { get() { reads++; return evidence().comparisons[0]; } });
    assertNotMeasured(arrayAccessor, 'array accessor');
    assert.equal(reads, 0);
    const revoked = Proxy.revocable(evidence(), {}); revoked.revoke();
    assertNotMeasured(revoked.proxy, 'unreadable proxy');
});

test('Valid exact 2-hour evidence (within_limit)', () => {
    const input = {
        version: 1,
        durationMs: TWO_HOUR_MS,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 10, uncertaintyMs: 5 },
                    { point: 'middle', referenceMs: TWO_HOUR_MS / 2, targetMs: TWO_HOUR_MS / 2 + 10, uncertaintyMs: 5 },
                    { point: 'end', referenceMs: TWO_HOUR_MS, targetMs: TWO_HOUR_MS + 10, uncertaintyMs: 5 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'within_limit');
    assert.equal(res.qualification, 'two_hour_verified');
    assert.equal(res.checkCount, 3);
    assert.equal(res.comparisons[0].driftMs, 0); // 10 - 10
    assert.equal(res.comparisons[0].driftUncertaintyMs, 10); // 5 + 5
});

test('Valid short evidence (sample_only)', () => {
    const input = {
        version: 1,
        durationMs: 3600000,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 0, uncertaintyMs: 0 },
                    { point: 'middle', referenceMs: 1800000, targetMs: 1800000, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: 3600000, targetMs: 3600000, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'within_limit');
    assert.equal(res.qualification, 'sample_only');
});

test('Outside limit due to offset and uncertainty', () => {
    const input = {
        version: 1,
        durationMs: 3600000,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 50, uncertaintyMs: 5 }, // abs(offset)-uncertainty = 45 > 40
                    { point: 'middle', referenceMs: 1800000, targetMs: 1800000, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: 3600000, targetMs: 3600000, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'outside_limit');
    assert.equal(res.qualification, 'not_verified');
    assert.equal(res.comparisons[0].state, 'outside_limit');
    assert.equal(res.comparisons[0].markers[0].state, 'outside_limit');
});

test('Indeterminate limit', () => {
    const input = {
        version: 1,
        durationMs: 3600000,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 42, uncertaintyMs: 5 }, // worst case: 47, min case: 37 -> indeterminate
                    { point: 'middle', referenceMs: 1800000, targetMs: 1800000, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: 3600000, targetMs: 3600000, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'indeterminate');
    assert.equal(res.qualification, 'not_verified');
    assert.equal(res.comparisons[0].state, 'indeterminate');
});

test('Invalid keys structure', () => {
    const input = {
        version: 1,
        durationMs: 3600000,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 0, uncertaintyMs: 0 },
                    { point: 'middle', referenceMs: 1800000, targetMs: 1800000, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: 3600000, targetMs: 3600000, uncertaintyMs: 0 }
                ]
            }
        ],
        extra: true
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'not_measured');
    assert.equal(res.checkCount, 0);
});

test('Coverage validation - start reference outside window', () => {
    const input = {
        version: 1,
        durationMs: 3600000,
        requiredComparisonIds: ['comp1'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 15000, targetMs: 15000, uncertaintyMs: 0 }, // window is 10000
                    { point: 'middle', referenceMs: 1800000, targetMs: 1800000, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: 3600000, targetMs: 3600000, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'not_measured');
});

test('Multiple outputs with one failure', () => {
    const input = {
        version: 1,
        durationMs: TWO_HOUR_MS,
        requiredComparisonIds: ['comp1', 'comp2'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 0, uncertaintyMs: 0 },
                    { point: 'middle', referenceMs: TWO_HOUR_MS / 2, targetMs: TWO_HOUR_MS / 2, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: TWO_HOUR_MS, targetMs: TWO_HOUR_MS, uncertaintyMs: 0 }
                ]
            },
            {
                id: 'comp2',
                kind: 'inter-track-audio',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 45, uncertaintyMs: 2 }, // fails
                    { point: 'middle', referenceMs: TWO_HOUR_MS / 2, targetMs: TWO_HOUR_MS / 2, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: TWO_HOUR_MS, targetMs: TWO_HOUR_MS, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'outside_limit');
    assert.equal(res.qualification, 'not_verified');
    assert.equal(res.checkCount, 6);
});

test('Missing required comparison', () => {
    const input = {
        version: 1,
        durationMs: TWO_HOUR_MS,
        requiredComparisonIds: ['comp1', 'comp2'],
        comparisons: [
            {
                id: 'comp1',
                kind: 'audio-video',
                markers: [
                    { point: 'start', referenceMs: 0, targetMs: 0, uncertaintyMs: 0 },
                    { point: 'middle', referenceMs: TWO_HOUR_MS / 2, targetMs: TWO_HOUR_MS / 2, uncertaintyMs: 0 },
                    { point: 'end', referenceMs: TWO_HOUR_MS, targetMs: TWO_HOUR_MS, uncertaintyMs: 0 }
                ]
            }
        ]
    };
    const res = assessSynchronization(input);
    assert.equal(res.state, 'not_measured');
});

test('Bad payload shapes', () => {
    const res1 = assessSynchronization(null);
    assert.equal(res1.state, 'not_measured');

    const res2 = assessSynchronization({ version: 1, durationMs: NaN, comparisons: [], requiredComparisonIds: [] });
    assert.equal(res2.state, 'not_measured');
});
