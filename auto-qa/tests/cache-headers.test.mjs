/**
 * Cache observability headers test (auto-qa).
 *
 * Pins the X-Cache instrumentation on /api/v2/.../chart — the only
 * heavily-cached read path. Three header invariants:
 *
 *   X-Cache:        "HIT" | "MISS"          (string literal)
 *   X-Cache-TTL:    non-negative integer    (seconds, time-to-live)
 *   X-Response-Time: integer + "ms" suffix  (server-measured)
 *
 * Catches:
 *   - Cache silently disabled (header missing, X-Response-Time stays
 *     high indefinitely → warmer / cache layer broken)
 *   - X-Cache always returns the same value (HIT permanently → stale
 *     responses; MISS permanently → cache never populated)
 *   - X-Cache-TTL drifts to 0 or to an unbounded value (TTL config
 *     broken)
 *   - The headers stop being present (frontend / dashboard
 *     instrumentation goes blind)
 *   - Cache key is too coarse — second consecutive call should HIT
 *
 * Not tied to any single PR. Defensive against a class of warmer/cache
 * regressions that would otherwise only surface as latency rises in
 * production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const FIXTURE  = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a'; // GIP-150 v2

// Pinned 7-day window (same fixture window used by other api tests).
const WINDOW = '?minTimestamp=1777737600&maxTimestamp=1778342400';
const URL_PATH = `/api/v2/proposals/${FIXTURE}/chart${WINDOW}`;

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function fetchChart() {
    const r = await fetch(`${API_BASE}${URL_PATH}`, { signal: AbortSignal.timeout(15000) });
    return {
        status: r.status,
        cache: r.headers.get('x-cache'),
        ttl: r.headers.get('x-cache-ttl'),
        responseTime: r.headers.get('x-response-time'),
    };
}

test('cache headers — X-Cache header is present on chart endpoint', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, cache } = await fetchChart();
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.ok(cache !== null,
        `X-Cache header is missing. Cache layer disabled? ` +
        `Or the response is being served by a non-instrumented path?`);
});

test('cache headers — X-Cache value is exactly "HIT" or "MISS"', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { cache } = await fetchChart();
    assert.ok(cache === 'HIT' || cache === 'MISS',
        `X-Cache must be exactly "HIT" or "MISS"; got "${cache}". ` +
        `A new value indicates the instrumentation drifted.`);
});

test('cache headers — X-Cache-TTL is a non-negative integer', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { ttl } = await fetchChart();
    assert.ok(ttl !== null, 'X-Cache-TTL header missing');
    const n = Number(ttl);
    assert.ok(Number.isInteger(n) && n >= 0,
        `X-Cache-TTL must be a non-negative integer; got "${ttl}"`);
    // TTL also shouldn't be absurdly large — pin a sanity ceiling.
    // 24h is generous (current value is 13s for the chart endpoint).
    assert.ok(n <= 86400,
        `X-Cache-TTL=${n}s is suspicious — chart data should refresh much sooner. ` +
        `If this was deliberate, raise the ceiling here.`);
});

test('cache headers — X-Response-Time is an integer ending in "ms"', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { responseTime } = await fetchChart();
    assert.ok(responseTime !== null, 'X-Response-Time header missing');
    assert.ok(/^\d+ms$/.test(responseTime),
        `X-Response-Time must match "<integer>ms"; got "${responseTime}"`);
});

test('cache headers — second consecutive request HITs (cache key works)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // Two requests back-to-back. The first MIGHT be a HIT (warmer
    // populated it earlier) or a MISS (cold). The second MUST be a HIT,
    // assuming TTL >= ~2s. If the second is a MISS, the cache key
    // changed between calls (e.g. a non-deterministic param leaks in).
    await fetchChart();
    const { cache } = await fetchChart();
    assert.equal(cache, 'HIT',
        `second back-to-back request returned ${cache}. ` +
        `Either cache is disabled, TTL is sub-second, or the key includes ` +
        `a non-deterministic component.`);
});

test('cache headers — HIT responses are faster than typical cold MISS', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // Force a HIT (second call). HIT responses come from memory, so they
    // should be fast. We pin a soft 100ms ceiling — if the cache stops
    // serving and we silently fall through to the cold path, this trips.
    await fetchChart(); // warm the cache
    const { cache, responseTime } = await fetchChart();
    if (cache !== 'HIT') {
        t.skip('second call did not HIT — covered by the dedicated HIT test');
        return;
    }
    const ms = parseInt(responseTime, 10);
    assert.ok(ms < 100,
        `HIT response took ${ms}ms — cache may be silently degraded. ` +
        `Typical HIT is 0-5ms.`);
});
