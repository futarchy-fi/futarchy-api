/**
 * unified-chart source-text invariants spec mirror (auto-qa).
 *
 * Pins src/routes/unified-chart.js — the v2 endpoint that bundles
 * everything the UI needs (market metadata + YES/NO candles + spot
 * candles) into a single request. Existing unified-chart.test.mjs
 * covers BEHAVIOR (live integration: response shape, candles non-empty,
 * volume in human units). This file pins the SOURCE-TEXT INVARIANTS
 * those integration tests can't see:
 *
 *   1. Query-parameter defaults — minTimestamp=0, maxTimestamp=now,
 *      includeSpot defaults TRUE (===false check), applyCurrencyRate
 *      defaults FALSE (==='true' check). Drift in any of these
 *      changes default UI behavior silently.
 *
 *   2. Response-cache key composition — 5-tuple key
 *      `proposalId:min:max:includeSpot:applyCurrencyRate`. A regression
 *      that drops a key dimension would serve stale data when that
 *      dimension changes (e.g. user toggles applyCurrencyRate but
 *      sees old cached response).
 *
 *   3. Per-pool candle cache key shape — `yes:<poolId>:<min>:<max>`
 *      and `no:<poolId>:<min>:<max>` (4-tuple). Distinct prefixes
 *      prevent YES/NO collisions on shared poolId edge cases.
 *
 *   4. Spot cache key — `<ticker>` for live, `<ticker>:hist:<dayBucket>`
 *      for historical (>3 days old). Same pattern as index.js
 *      /api/v1/spot-candles — cross-pin so they stay in sync.
 *
 *   5. effectiveMinTimestamp clamping — max(minTimestamp,
 *      chartStartRange). Prevents the chart from rendering candles
 *      BEFORE the registered chart start.
 *
 *   6. Parallel-fetch shape — 4-way Promise.all (rate, yesCandles,
 *      noCandles, spotData). Serial would 4x latency.
 *
 *   7. applyRateToCandles helper — scales open/high/low/close by
 *      rate. NaN-safe via `c.open ? ... : c.open` pattern. Bypassed
 *      when rate === 1 OR applyCurrencyRate=false.
 *
 *   8. AGGREGATOR_ADDRESS — duplicated from market-events.js.
 *      Cross-pin to ensure they stay in sync.
 *
 *   9. composite:: skip in spot rate divisor — same invariant as
 *      index.js. Cross-pin.
 *
 *  10. X-Cache headers — HIT/MISS + TTL + Response-Time. Pinned
 *      because the frontend may key UI behavior on X-Cache.
 *
 *  11. refreshChart mock req/res pattern — pinned for the warmer
 *      integration. A regression in the mock shape silently breaks
 *      the warmer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/routes/unified-chart.js', import.meta.url),
    'utf8',
);

// --- spec mirror of applyRateToCandles ---
function applyRateToCandles(candles, rate, shouldApplyRate) {
    if (!shouldApplyRate) return candles;
    return candles.map(c => ({
        ...c,
        open: c.open ? String(parseFloat(c.open) * rate) : c.open,
        high: c.high ? String(parseFloat(c.high) * rate) : c.high,
        low: c.low ? String(parseFloat(c.low) * rate) : c.low,
        close: c.close ? String(parseFloat(c.close) * rate) : c.close,
    }));
}

// --- spec mirror of effectiveMinTimestamp clamp ---
function effectiveMin(minTimestamp, chartStartRange) {
    return chartStartRange
        ? Math.max(minTimestamp, chartStartRange)
        : minTimestamp;
}

// ---------------------------------------------------------------------------
// Query-parameter defaults
// ---------------------------------------------------------------------------

test('source — minTimestamp default = 0 (parseInt fallback)', () => {
    assert.match(SRC,
        /minTimestamp\s*=\s*parseInt\(req\.query\.minTimestamp\)\s*\|\|\s*0/,
        `minTimestamp default drifted from parseInt(...) || 0`);
});

test('source — maxTimestamp default = now (Math.floor(Date.now()/1000))', () => {
    assert.match(SRC,
        /maxTimestamp\s*=\s*parseInt\(req\.query\.maxTimestamp\)\s*\|\|\s*Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/,
        `maxTimestamp default drifted from parseInt(...) || Math.floor(Date.now()/1000)`);
});

test('source — includeSpot defaults TRUE (=== "false" negation)', () => {
    // Pinned: pattern `req.query.includeSpot !== 'false'` means default
    // is true. A regression to `=== 'true'` flips default to false →
    // every chart loads without spot data.
    assert.match(SRC,
        /includeSpot\s*=\s*req\.query\.includeSpot\s*!==\s*['"]false['"]/,
        "includeSpot default-true pattern drifted (must be `req.query.includeSpot !== 'false'`)");
});

test('source — applyCurrencyRate defaults FALSE (=== "true" check)', () => {
    // Pinned: opt-in flag. Drift to default-true would silently
    // multiply every candle by currencyRate → 1.x× scaled prices.
    assert.match(SRC,
        /applyCurrencyRate\s*=\s*req\.query\.applyCurrencyRate\s*===\s*['"]true['"]/,
        `applyCurrencyRate default-false pattern drifted (must be ===true)`);
});

// ---------------------------------------------------------------------------
// Response-cache key composition (5-tuple)
// ---------------------------------------------------------------------------

test('source — response cache key includes ALL 5 dimensions', () => {
    // Pinned: dropping any dimension would serve stale cached responses
    // when that dimension changes.
    assert.match(SRC,
        /cacheKey\s*=\s*`\$\{proposalId\}:\$\{minTimestamp\}:\$\{maxTimestamp\}:\$\{includeSpot\}:\$\{applyCurrencyRate\}`/,
        `response cache key drifted from 5-tuple ${'$'}{proposalId}:${'$'}{min}:${'$'}{max}:${'$'}{includeSpot}:${'$'}{applyCurrencyRate}`);
});

test('source — cache HIT path serves immediately with X-Cache: HIT + 0ms', () => {
    // Pinned: the cache hit reports 0ms response time (because no work
    // was done). Frontend may key UX (skeleton vs flash) on X-Cache.
    assert.match(SRC,
        /res\.set\(['"]X-Cache['"],\s*['"]HIT['"]\)/,
        `cache HIT must set X-Cache: HIT header`);
    assert.match(SRC,
        /res\.set\(['"]X-Response-Time['"],\s*['"]0ms['"]\)/,
        `cache HIT must report X-Response-Time: 0ms`);
});

test('source — cache MISS path sets X-Cache: MISS + actual elapsed time', () => {
    assert.match(SRC,
        /res\.set\(['"]X-Cache['"],\s*['"]MISS['"]\)/,
        `cache MISS must set X-Cache: MISS header`);
    assert.match(SRC,
        /res\.set\(['"]X-Response-Time['"],\s*`\$\{elapsed\}ms`\)/,
        `cache MISS must report X-Response-Time: ${'$'}{elapsed}ms`);
});

test('source — both HIT + MISS report X-Cache-TTL from RESPONSE_TTL_SEC', () => {
    // Pinned: TTL header lets clients (or cdn) know how long to trust
    // the response. Pinned at both branches.
    const matches = [...SRC.matchAll(/res\.set\(['"]X-Cache-TTL['"],\s*String\(RESPONSE_TTL_SEC\)\)/g)];
    assert.equal(matches.length, 2,
        `X-Cache-TTL must be set on BOTH HIT and MISS branches; got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// Per-pool candle cache key — yes:/no: prefix prevents collision
// ---------------------------------------------------------------------------

test('source — YES candles cache key shape: yes:<poolId>:<min>:<max>', () => {
    // Pinned: distinct yes:/no: prefix. A regression that uses just
    // poolId could collide if YES and NO share a poolId (rare but
    // possible in test fixtures / edge configurations).
    assert.match(SRC,
        /yes:\$\{yesPool\.id\}:\$\{effectiveMinTimestamp\}:\$\{maxTimestamp\}/,
        `YES candles cache key drifted from "yes:<poolId>:<min>:<max>"`);
});

test('source — NO candles cache key shape: no:<poolId>:<min>:<max>', () => {
    assert.match(SRC,
        /no:\$\{noPool\.id\}:\$\{effectiveMinTimestamp\}:\$\{maxTimestamp\}/,
        `NO candles cache key drifted from "no:<poolId>:<min>:<max>"`);
});

// ---------------------------------------------------------------------------
// Spot cache key — same pattern as index.js (cross-pin)
// ---------------------------------------------------------------------------

test('source — spot historical threshold = 3 days (cross-pin with index.js)', () => {
    // Pinned: same threshold as index.js. Drift between the two would
    // partition cache differently → either cache misses or stale hits.
    assert.match(SRC,
        /isHistorical\s*=\s*maxTimestamp\s*<\s*\(now\s*-\s*3\s*\*\s*86400\)/,
        `historical threshold drifted from 3 days (cross-pin: index.js uses same)`);
});

test('source — spot historical cache key shape: <ticker>:hist:<dayBucket>', () => {
    assert.match(SRC,
        /\$\{ticker\}:hist:\$\{Math\.floor\(maxTimestamp\s*\/\s*86400\)\}/,
        `historical cache key shape drifted (cross-pin: index.js uses same)`);
});

test('source — spot live cache key is just <ticker> (no qualifier)', () => {
    // Pinned the live-key shape via the cacheKey ternary structure.
    assert.match(SRC,
        /isHistorical\s*\?\s*`[^`]+`\s*:\s*ticker/,
        `live spot cache key drifted from bare ticker`);
});

// ---------------------------------------------------------------------------
// effectiveMinTimestamp clamp — max(minTimestamp, chartStartRange)
// ---------------------------------------------------------------------------

test('effectiveMin spec mirror — clamps to chartStartRange when present and larger', () => {
    assert.equal(effectiveMin(100, 200), 200);
    assert.equal(effectiveMin(300, 200), 300);
});

test('effectiveMin spec mirror — passes through when chartStartRange null', () => {
    assert.equal(effectiveMin(100, null), 100);
});

test('source — effectiveMinTimestamp computed as max(minTimestamp, chartStartRange)', () => {
    assert.match(SRC,
        /effectiveMinTimestamp\s*=\s*chartStartRange[\s\S]*?\?\s*Math\.max\(minTimestamp,\s*chartStartRange\)\s*:\s*minTimestamp/,
        `effectiveMinTimestamp clamp shape drifted`);
});

// ---------------------------------------------------------------------------
// Parallel fetch — 4-way Promise.all
// ---------------------------------------------------------------------------

test('source — parallel fetch is Promise.all over 4 destructured items: rate, yesCandles, noCandles, spotData', () => {
    // Pinned: serial fetches would 4x wall-clock latency. Pinned the
    // exact destructure shape so a regression that drops one entry
    // (or adds one without updating consumers) breaks the test.
    assert.match(SRC,
        /const\s+\[currencyRate,\s*yesCandles,\s*noCandles,\s*spotData\]\s*=\s*await\s+Promise\.all\(\[/,
        `parallel-fetch destructure shape drifted from [currencyRate, yesCandles, noCandles, spotData]`);
});

// ---------------------------------------------------------------------------
// applyRateToCandles helper — bypass + per-field scaling
// ---------------------------------------------------------------------------

test('applyRateToCandles spec mirror — bypass when shouldApplyRate=false', () => {
    const c = [{ close: '1.5' }];
    assert.equal(applyRateToCandles(c, 2, false), c,
        `must return SAME reference (no copy) when bypassed`);
});

test('applyRateToCandles spec mirror — scales close by rate', () => {
    const r = applyRateToCandles([{ close: '1.5' }], 2, true);
    assert.equal(r[0].close, '3');
});

test('applyRateToCandles spec mirror — null/missing close passes through (NOT NaN)', () => {
    // Pinned: `c.close ? ... : c.close` guard prevents parseFloat(null)→NaN.
    // A regression that drops the guard would corrupt every candle that
    // happens to have null close.
    const r = applyRateToCandles([{ close: null }], 2, true);
    assert.equal(r[0].close, null);
    const r2 = applyRateToCandles([{}], 2, true);
    assert.equal(r2[0].close, undefined);
});

test('applyRateToCandles spec mirror — preserves other fields via spread', () => {
    const r = applyRateToCandles([{ close: '1', timestamp: 100 }], 2, true);
    assert.equal(r[0].timestamp, 100);
});

test('source — applyRateToCandles bypass when !shouldApplyRate (early return)', () => {
    assert.match(SRC,
        /if\s*\(!shouldApplyRate\)\s*return\s+candles/,
        `applyRateToCandles must early-return on !shouldApplyRate (avoid mapping cost)`);
});

test('source — shouldApplyRate definition: applyCurrencyRate AND rate !== 1', () => {
    // Pinned: rate=1 means no conversion needed. A regression that
    // drops the `rate !== 1` clause would do unnecessary work for
    // every chart in single-currency pools.
    assert.match(SRC,
        /shouldApplyRate\s*=\s*applyCurrencyRate\s*&&\s*rate\s*!==\s*1/,
        `shouldApplyRate definition drifted from applyCurrencyRate && rate !== 1`);
});

test('source — applyRateToCandles scales 4 OHLC fields: open, high, low, close', () => {
    // Pinned: each of OHLC must be scaled. A regression that omits
    // one (e.g. skips open) silently breaks chart axes.
    for (const field of ['open', 'high', 'low', 'close']) {
        assert.match(SRC, new RegExp(
            `${field}:\\s*c\\.${field}\\s*\\?\\s*String\\(parseFloat\\(c\\.${field}\\)\\s*\\*\\s*rate\\)\\s*:\\s*c\\.${field}`
        ),
            `OHLC field "${field}" not scaled per spec`);
    }
});

// ---------------------------------------------------------------------------
// AGGREGATOR_ADDRESS — duplicated from market-events.js (cross-pin)
// ---------------------------------------------------------------------------

test('source — AGGREGATOR_ADDRESS pinned to canonical (cross-pin with market-events.js)', () => {
    // Pinned: must equal market-events.js value [pinned in
    // market-events-helpers.test.mjs]. A regression that diverges
    // would mis-route org lookups in this file vs market-events.
    const m = SRC.match(/AGGREGATOR_ADDRESS\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'AGGREGATOR_ADDRESS not found');
    assert.equal(m[1], '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1',
        `AGGREGATOR_ADDRESS drifted — MUST cross-match market-events.js (lowercase form)`);
});

// ---------------------------------------------------------------------------
// composite:: skip in spot rate divisor (cross-pin with index.js)
// ---------------------------------------------------------------------------

test('source — composite:: tickers SKIP rate divisor (cross-pin with index.js)', () => {
    // Pinned: composite pools natively divide their prices in the
    // backend proxy. Re-applying here would double-divide → silent
    // price corruption.
    assert.match(SRC,
        /ticker\.includes\(['"]::['"]\)\s*&&\s*!ticker\.startsWith\(['"]composite::['"]\)/,
        `composite:: skip drifted — cross-pin: index.js uses same pattern`);
});

// ---------------------------------------------------------------------------
// findPoolByOutcome 3-tier fallback (cross-pin with market-events.js)
// ---------------------------------------------------------------------------

test('source — findPoolByOutcome 3-tier fallback CONDITIONAL → PREDICTION → EXPECTED_VALUE', () => {
    // Pinned: same 3-tier order as market-events.js. A regression
    // here picks a different pool type silently.
    const fbBlock = SRC.match(/function findPoolByOutcome\(side\)\s*\{([\s\S]*?)\}\s*const yesPool/);
    assert.ok(fbBlock, 'findPoolByOutcome body not found');
    const order = ['CONDITIONAL', 'PREDICTION', 'EXPECTED_VALUE'];
    let lastIdx = -1;
    for (const t of order) {
        const idx = fbBlock[1].indexOf(t);
        assert.ok(idx > lastIdx,
            `findPoolByOutcome fallback order drifted: ${t} not after ${order[order.indexOf(t) - 1] || 'start'}`);
        lastIdx = idx;
    }
});

// ---------------------------------------------------------------------------
// Response shape — top-level {market, candles}
// ---------------------------------------------------------------------------

test('source — response top-level shape is {market, candles} (NOT flat like market-events)', () => {
    // Pinned: this is the v2 endpoint with a structured response.
    // market-events.js v1 is flat. A regression that flattens this
    // back would break frontend destructuring.
    assert.match(SRC,
        /const response\s*=\s*\{\s*market:\s*\{[\s\S]*?candles:\s*\{[\s\S]*?\}\s*\}/,
        `response shape drifted from {market: {...}, candles: {...}}`);
});

test('source — response.candles has 3 sub-keys: yes, no, spot', () => {
    assert.match(SRC,
        /candles:\s*\{\s*yes:\s*applyRateToCandles\(yesCandles\),\s*no:\s*applyRateToCandles\(noCandles\),\s*spot:\s*spotCandles\s*\}/,
        `candles sub-shape drifted from {yes, no, spot} (yes/no go through applyRateToCandles, spot does not)`);
});

test('source — timeline includes currency_rate_applied flag (debug observability)', () => {
    // Pinned: the flag tells consumers whether candles are in raw or
    // rate-applied units. Without it, a debug session can't tell.
    assert.match(SRC,
        /currency_rate_applied:\s*shouldApplyRate/,
        `timeline.currency_rate_applied flag drifted`);
});

// ---------------------------------------------------------------------------
// Warmer registration + refreshChart mock pattern
// ---------------------------------------------------------------------------

test('source — registerForWarming called with cacheKey + reproducible params', () => {
    // Pinned: the warmer needs both the cache key (to know what to
    // refresh) and the params (to call back into the handler).
    // includeSpot is HARDCODED to true in the warmer call so the
    // background refresh always primes spot too.
    assert.match(SRC,
        /registerForWarming\(cacheKey,\s*\{\s*proposalId,\s*minTimestamp,\s*maxTimestamp,\s*includeSpot:\s*true\s*\}\)/,
        `registerForWarming call shape drifted (must hardcode includeSpot: true)`);
});

test('source — refreshChart is exported (warmer integration point)', () => {
    assert.match(SRC,
        /export\s+async\s+function\s+refreshChart\(\{\s*proposalId,\s*minTimestamp,\s*maxTimestamp,\s*includeSpot\s*\}\)/,
        `refreshChart export signature drifted`);
});

test('source — refreshChart constructs mock req + mock res shapes', () => {
    // Pinned: the mock req has params + query; mock res has json/set/status.
    // A regression in the mock shape (missing res.set) would crash the
    // handler when it sets X-Cache headers.
    assert.match(SRC,
        /const mockReq\s*=\s*\{\s*params:\s*\{\s*proposalId\s*\},\s*query:\s*\{[\s\S]*?\}\s*\}/,
        `refreshChart mockReq shape drifted`);
    // Looser shape pin: require json/set/status methods + chainable status return.
    assert.match(SRC,
        /const mockRes\s*=\s*\{[\s\S]*?json:[\s\S]*?set:[\s\S]*?status:\s*\(\)\s*=>\s*\(\{\s*json:/,
        `refreshChart mockRes shape drifted (must include json/set/status, with status returning chainable {json})`);
});

test('source — error path responds 500 with {error: error.message}', () => {
    assert.match(SRC,
        /res\.status\(500\)\.json\(\{\s*error:\s*error\.message\s*\}\)/,
        `error response shape drifted from {error: error.message}`);
});

// ---------------------------------------------------------------------------
// Org-metadata fallback chain — proposal-level FIRST, then org-lookup
// ---------------------------------------------------------------------------

test('source — pricePrecision uses ?? fallback (NOT || — preserves 0)', () => {
    // Pinned: ?? null vs || null distinction. pricePrecision=0 is a
    // legitimate value (means integer prices). || would falsy-coerce
    // 0 to org-lookup unnecessarily.
    assert.match(SRC,
        /pricePrecision\s*=\s*resolved\.pricePrecision\s*\?\?\s*await\s+lookupOrgMetadataField/,
        `pricePrecision must use ?? (not ||) — value 0 must survive proposal-level lookup`);
});

test('source — currencyRateProvider uses ?? fallback', () => {
    assert.match(SRC,
        /currencyRateProvider\s*=\s*resolved\.currencyStableRate\s*\?\?\s*await\s+lookupOrgMetadataField/,
        `currencyRateProvider must use ?? fallback`);
});

test('source — currencyStableSymbol uses ?? fallback', () => {
    assert.match(SRC,
        /currencyStableSymbol\s*=\s*resolved\.currencyStableSymbol\s*\?\?\s*await\s+lookupOrgMetadataField/,
        `currencyStableSymbol must use ?? fallback`);
});
