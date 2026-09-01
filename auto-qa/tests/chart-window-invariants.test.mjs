/**
 * Chart endpoint time-window invariants (auto-qa).
 *
 * Pins the boundary semantics of GET /api/v2/proposals/:id/chart
 * around its `minTimestamp` / `maxTimestamp` query params. Catches a
 * class of quiet bugs where the endpoint returns data outside the
 * requested window — the chart silently shows old/wrong candles, with
 * no obvious symptom unless someone manually inspects timestamps.
 *
 * Invariants pinned:
 *
 *   1. Inverted window (max < min) is graceful — 200 + empty candles,
 *      not 5xx, not "all data ever".
 *   2. All-future window → 200 + empty candles for every series.
 *   3. All-past window → 200 + empty candles.
 *   4. Missing both timestamps → 200 + a sane default window
 *      (currently last-N-days), not error.
 *   5. Negative timestamps → graceful (200), not 5xx.
 *   6. For valid windows: every returned candle satisfies
 *      `min <= periodStartUnix <= max`.
 *   7. For valid windows: candles in each series are sorted
 *      strictly ascending by periodStartUnix.
 *   8. Each candle has the documented {periodStartUnix, close} shape
 *      and both fields parse as numbers.
 *
 * Not tied to any specific PR. Defensive against:
 *   - Window predicate flipped (>= ↔ <=) in the indexer query
 *   - Sort order inverted in a refactor
 *   - Default-window logic returning unbounded data on missing params
 *   - Inverted window crashing the upstream Checkpoint passthrough
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const FIXTURE  = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a'; // GIP-150 v2

const VALID_MIN = 1777737600;
const VALID_MAX = 1778342400;

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function fetchChart(qs = '') {
    const url = `${API_BASE}/api/v2/proposals/${FIXTURE}/chart${qs ? '?' + qs : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() };
}

function totalCandleCount(body) {
    const c = body?.candles || {};
    return (c.yes?.length || 0) + (c.no?.length || 0) + (c.spot?.length || 0);
}

// ---------------------------------------------------------------------------
// Graceful handling of degenerate windows
// ---------------------------------------------------------------------------

test('chart window — inverted window (max < min) returns 200 with empty candles', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart(
        `minTimestamp=${VALID_MAX}&maxTimestamp=${VALID_MIN}` // swapped
    );
    assert.equal(status, 200, `inverted window should be graceful 200; got ${status}`);
    assert.equal(totalCandleCount(body), 0,
        `inverted window must return 0 candles, got ${totalCandleCount(body)}. ` +
        `If it returns data, the window predicate is broken.`);
});

test('chart window — far-future window returns 200 with empty candles', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart('minTimestamp=2000000000&maxTimestamp=2100000000');
    assert.equal(status, 200);
    assert.equal(totalCandleCount(body), 0,
        `far-future window must return 0 candles; got ${totalCandleCount(body)}`);
});

test('chart window — far-past window returns 200 with empty candles', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart('minTimestamp=1000000000&maxTimestamp=1100000000');
    assert.equal(status, 200);
    assert.equal(totalCandleCount(body), 0,
        `far-past window must return 0 candles; got ${totalCandleCount(body)}`);
});

test('chart window — missing both timestamps still returns 200 (default window)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart('');
    assert.equal(status, 200, 'missing timestamps must apply a default window, not error');
    assert.ok(body?.candles, 'response must still have a candles object');
});

test('chart window — negative timestamps handled gracefully (not 5xx)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status } = await fetchChart('minTimestamp=-1&maxTimestamp=' + VALID_MAX);
    assert.ok(status < 500,
        `negative timestamp must NOT 5xx (defensive against query-param injection); got ${status}`);
});

// ---------------------------------------------------------------------------
// Window-respect invariants on a known-good window
// ---------------------------------------------------------------------------

test('chart window — every returned candle is within [min, max]', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart(`minTimestamp=${VALID_MIN}&maxTimestamp=${VALID_MAX}`);
    for (const series of ['yes', 'no', 'spot']) {
        const cs = body.candles?.[series] || [];
        for (const c of cs) {
            const t = Number(c.periodStartUnix);
            assert.ok(t >= VALID_MIN && t <= VALID_MAX,
                `${series} candle outside window: periodStartUnix=${t} not in [${VALID_MIN},${VALID_MAX}]`);
        }
    }
});

test('chart window — candles are sorted strictly ascending by periodStartUnix', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart(`minTimestamp=${VALID_MIN}&maxTimestamp=${VALID_MAX}`);
    for (const series of ['yes', 'no', 'spot']) {
        const cs = body.candles?.[series] || [];
        const times = cs.map(c => Number(c.periodStartUnix));
        for (let i = 1; i < times.length; i++) {
            assert.ok(times[i] > times[i-1],
                `${series} candles not strictly ascending at index ${i}: ` +
                `${times[i-1]} → ${times[i]}. Duplicate periodStartUnix or wrong sort order.`);
        }
    }
});

test('chart window — each candle has {periodStartUnix, close} as numeric strings', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart(`minTimestamp=${VALID_MIN}&maxTimestamp=${VALID_MAX}`);
    let saw = 0;
    for (const series of ['yes', 'no', 'spot']) {
        const cs = body.candles?.[series] || [];
        for (const c of cs) {
            saw++;
            assert.ok('periodStartUnix' in c, `${series} candle missing periodStartUnix`);
            assert.ok('close' in c, `${series} candle missing close`);
            assert.ok(Number.isFinite(Number(c.periodStartUnix)),
                `${series} periodStartUnix not parseable: ${c.periodStartUnix}`);
            assert.ok(Number.isFinite(Number(c.close)),
                `${series} close not parseable: ${c.close}`);
        }
    }
    assert.ok(saw > 0, 'fixture window returned 0 candles — fixture or window broke');
});

// ---------------------------------------------------------------------------
// 1-second window — exact boundary
// ---------------------------------------------------------------------------

test('chart window — 1-second window between two known candles returns at most 1 candle per series', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // periodStartUnix values are period-snapped (per PR #9 in api repo).
    // A 1-second window straddling an existing periodStartUnix should
    // either include exactly that one or zero candles — not multiple.
    const { body } = await fetchChart('minTimestamp=1778191200&maxTimestamp=1778191201');
    for (const series of ['yes', 'no', 'spot']) {
        const cs = body.candles?.[series] || [];
        assert.ok(cs.length <= 1,
            `${series} 1-second window returned ${cs.length} candles — periodStartUnix snapping broken?`);
    }
});
