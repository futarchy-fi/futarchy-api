/**
 * graphql-proxy helpers spec mirror (auto-qa).
 *
 * Pins src/routes/graphql-proxy.js — three pieces:
 *
 *   1. forwardFillCandles — chart-continuity helper. Given sparse
 *      hourly candles from the subgraph, fills gaps with the last-
 *      known close price up to min(maxTimestamp, Date.now()/1000).
 *      A regression here corrupts EVERY chart in the UI:
 *        - Drop the inter-candle gap fill → chart shows visible holes.
 *        - Use next.close instead of current.close → forward-fill becomes
 *          BACKWARD-fill (silent price-direction lie).
 *        - Forget the effectiveMax clamp → chart fills to the requested
 *          range past now (impossible-future ghost candles).
 *
 *   2. convertSpotCandles — spot data normalizer. Converts {time, value}
 *      to subgraph-shaped {periodStartUnix, close} (strings), filters
 *      to the requested [minTimestamp, maxTimestamp] inclusive, and
 *      divides by an optional rate divisor for ticker rate-provider
 *      configs.
 *
 *   3. Rate-divisor extraction from poolTicker — when poolTicker
 *      contains "::", the part after :: (before the network suffix)
 *      is the rate-provider address. A regression in the split logic
 *      would route to the wrong rate provider (silent price scaling
 *      bug). Source-text pinned.
 *
 * Pure helpers are not exported, so spec-mirrored inline. Behavior
 * cross-checked against the source by reading SRC and asserting key
 * structural invariants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/routes/graphql-proxy.js', import.meta.url),
    'utf8',
);

const ONE_HOUR = 3600;

// --- spec mirror of forwardFillCandles ---
// Note: spec mirror takes `now` as a parameter so tests are deterministic.
function forwardFillCandles(candles, maxTimestamp, now = Math.floor(Date.now() / 1000)) {
    if (!candles || candles.length === 0) return candles;

    const filled = [];
    const effectiveMax = Math.min(maxTimestamp, now);

    for (let i = 0; i < candles.length; i++) {
        const current = candles[i];
        const currentTime = parseInt(current.periodStartUnix);

        if (currentTime <= effectiveMax) {
            filled.push(current);
        }

        if (i < candles.length - 1) {
            const nextTime = parseInt(candles[i + 1].periodStartUnix);
            const gapHours = (nextTime - currentTime) / ONE_HOUR;
            if (gapHours > 1) {
                for (let hour = 1; hour < gapHours; hour++) {
                    const fillTime = currentTime + (hour * ONE_HOUR);
                    if (fillTime <= effectiveMax) {
                        filled.push({
                            periodStartUnix: String(fillTime),
                            close: current.close,
                        });
                    }
                }
            }
        } else {
            let fillTime = currentTime + ONE_HOUR;
            while (fillTime <= effectiveMax) {
                filled.push({
                    periodStartUnix: String(fillTime),
                    close: current.close,
                });
                fillTime += ONE_HOUR;
            }
        }
    }
    return filled;
}

// --- spec mirror of convertSpotCandles ---
function convertSpotCandles(spotData, minTimestamp, maxTimestamp, rateDivisor = 1) {
    if (!spotData?.candles || spotData.candles.length === 0) return [];
    return spotData.candles
        .filter(c => c.time >= minTimestamp && c.time <= maxTimestamp)
        .map(c => ({
            periodStartUnix: String(c.time),
            close: String(c.value / rateDivisor),
        }));
}

// ---------------------------------------------------------------------------
// forwardFillCandles — degenerate cases
// ---------------------------------------------------------------------------

test('forwardFill — null returns null (identity preserved)', () => {
    assert.equal(forwardFillCandles(null, 100), null);
});

test('forwardFill — undefined returns undefined', () => {
    assert.equal(forwardFillCandles(undefined, 100), undefined);
});

test('forwardFill — empty array returns empty array', () => {
    assert.deepEqual(forwardFillCandles([], 100), []);
});

// ---------------------------------------------------------------------------
// forwardFillCandles — single candle expands to fill range
// ---------------------------------------------------------------------------

test('forwardFill — single candle, maxTimestamp 3 hours later → 4 candles total', () => {
    // Initial candle at t=1000, max at t=1000+10800 (3 hours later, now=that).
    // Output: [{1000, 0.5}, {4600, 0.5}, {8200, 0.5}, {11800, 0.5}]
    const r = forwardFillCandles(
        [{ periodStartUnix: '1000', close: '0.5' }],
        1000 + 3 * ONE_HOUR,
        1000 + 3 * ONE_HOUR
    );
    assert.equal(r.length, 4);
    assert.equal(r[0].periodStartUnix, '1000');
    assert.equal(r[1].periodStartUnix, String(1000 + ONE_HOUR));
    assert.equal(r[2].periodStartUnix, String(1000 + 2 * ONE_HOUR));
    assert.equal(r[3].periodStartUnix, String(1000 + 3 * ONE_HOUR));
    for (const c of r) assert.equal(c.close, '0.5',
        `forward-fill must propagate close="0.5" — silent price corruption otherwise`);
});

test('forwardFill — single candle: filled timestamps are STRINGS (not numbers)', () => {
    // Pinned because callers parse with parseInt — accepting a number
    // would silently work locally but break JSON round-trips that
    // expect string.
    const r = forwardFillCandles(
        [{ periodStartUnix: '1000', close: '0.5' }],
        1000 + 2 * ONE_HOUR,
        1000 + 2 * ONE_HOUR
    );
    for (const c of r) {
        assert.equal(typeof c.periodStartUnix, 'string',
            `periodStartUnix must be string in fill output (got ${typeof c.periodStartUnix})`);
    }
});

// ---------------------------------------------------------------------------
// forwardFillCandles — gap filling between consecutive candles
// ---------------------------------------------------------------------------

test('forwardFill — 2 candles 5 hours apart get 4 fill candles between (with current.close)', () => {
    // candles at t=1000 and t=1000+5h. Between them: 4 fill candles
    // at t=1h, 2h, 3h, 4h offsets. Each carries the FIRST candle's close.
    const r = forwardFillCandles(
        [
            { periodStartUnix: '1000', close: '0.5' },
            { periodStartUnix: String(1000 + 5 * ONE_HOUR), close: '0.9' },
        ],
        1000 + 5 * ONE_HOUR,
        1000 + 5 * ONE_HOUR
    );
    assert.equal(r.length, 6, `expected 2 originals + 4 fills = 6 candles; got ${r.length}`);
    assert.equal(r[0].close, '0.5');
    // Fills 1..4 must carry FIRST candle's close (forward-fill — NOT next).
    for (let i = 1; i <= 4; i++) {
        assert.equal(r[i].close, '0.5',
            `fill candle ${i} must carry current.close="0.5" (forward-fill, NOT next.close="0.9")`);
    }
    assert.equal(r[5].close, '0.9');
});

test('forwardFill — adjacent candles (1h apart) get NO fills between', () => {
    // gapHours === 1 → loop `hour < 1` never executes → no fills.
    const r = forwardFillCandles(
        [
            { periodStartUnix: '1000', close: '0.1' },
            { periodStartUnix: String(1000 + ONE_HOUR), close: '0.2' },
        ],
        1000 + ONE_HOUR,
        1000 + ONE_HOUR
    );
    assert.equal(r.length, 2,
        `1-hour-apart candles must produce no fills; got ${r.length}`);
});

// ---------------------------------------------------------------------------
// forwardFillCandles — effectiveMax = min(maxTimestamp, now) clamp
// ---------------------------------------------------------------------------

test('forwardFill — clamp: when now < maxTimestamp, fills only up to now', () => {
    // Pinned: critical guard against ghost-future candles. The user's
    // chart query may request a window ending in the future; we MUST
    // NOT fabricate candles past the present.
    const now = 1000 + 2 * ONE_HOUR;
    const r = forwardFillCandles(
        [{ periodStartUnix: '1000', close: '0.5' }],
        1000 + 10 * ONE_HOUR,  // maxTimestamp far in the future
        now                      // but `now` is only 2h after t=1000
    );
    assert.equal(r.length, 3,
        `expected 1 original + 2 fills (up to now); got ${r.length}`);
    const lastTime = parseInt(r[r.length - 1].periodStartUnix);
    assert.ok(lastTime <= now,
        `last fill ${lastTime} must NOT exceed now=${now}`);
});

test('forwardFill — exclude candle whose time > effectiveMax', () => {
    // The first candle at t=1000 is past effectiveMax=500 — must be
    // excluded from output entirely.
    const r = forwardFillCandles(
        [{ periodStartUnix: '1000', close: '0.5' }],
        500,
        500
    );
    // currentTime=1000 > effectiveMax=500 → the original candle is NOT pushed.
    // No subsequent candles → no fills. Result: empty array.
    assert.deepEqual(r, []);
});

test('forwardFill — gap-fill stops at effectiveMax (not nextTime)', () => {
    // Two candles with a 5h gap, but now is only 2h after the first.
    // We should fill 1 hour (t+1h) and stop — NOT fill all 4 hours.
    const r = forwardFillCandles(
        [
            { periodStartUnix: '1000', close: '0.5' },
            { periodStartUnix: String(1000 + 5 * ONE_HOUR), close: '0.9' },
        ],
        1000 + 5 * ONE_HOUR,
        1000 + 2 * ONE_HOUR  // now
    );
    // Original at 1000 included.
    // Fill at t=1000+1h=4600 included (4600 <= 1000+2h=8200).
    // Fill at t=1000+2h=8200 included (8200 <= 8200).
    // Fill at t=1000+3h=11800 EXCLUDED (>8200).
    // Original at 1000+5h=19000 EXCLUDED (>8200).
    assert.equal(r.length, 3,
        `expected 1 original + 2 fills (clamped to now); got ${r.length}`);
});

// ---------------------------------------------------------------------------
// convertSpotCandles — degenerate cases
// ---------------------------------------------------------------------------

test('convertSpot — null spotData returns []', () => {
    assert.deepEqual(convertSpotCandles(null, 0, 1000), []);
});

test('convertSpot — spotData with no candles returns []', () => {
    assert.deepEqual(convertSpotCandles({}, 0, 1000), []);
});

test('convertSpot — empty candles array returns []', () => {
    assert.deepEqual(convertSpotCandles({ candles: [] }, 0, 1000), []);
});

// ---------------------------------------------------------------------------
// convertSpotCandles — format conversion + range filter
// ---------------------------------------------------------------------------

test('convertSpot — converts {time, value} to {periodStartUnix, close} as strings', () => {
    const r = convertSpotCandles(
        { candles: [{ time: 100, value: 1.5 }] },
        0, 200
    );
    assert.deepEqual(r, [{ periodStartUnix: '100', close: '1.5' }]);
    assert.equal(typeof r[0].periodStartUnix, 'string');
    assert.equal(typeof r[0].close, 'string');
});

test('convertSpot — range filter is inclusive at both ends', () => {
    // Pinned: the source uses `>=` and `<=`. A regression to strict
    // inequality would silently drop the boundary candles.
    const r = convertSpotCandles(
        { candles: [
            { time: 100, value: 1 },
            { time: 200, value: 2 },
            { time: 300, value: 3 },
        ] },
        100, 300
    );
    assert.equal(r.length, 3,
        `boundaries (time=100 AND time=300) must be INCLUDED; got ${r.length}`);
});

test('convertSpot — out-of-range candles are filtered out', () => {
    const r = convertSpotCandles(
        { candles: [
            { time: 50, value: 0.5 },   // before range
            { time: 100, value: 1 },     // in range
            { time: 200, value: 2 },     // in range
            { time: 350, value: 3.5 },   // after range
        ] },
        100, 300
    );
    assert.deepEqual(r.map(c => c.periodStartUnix), ['100', '200']);
});

// ---------------------------------------------------------------------------
// convertSpotCandles — rate divisor for "::" tickers
// ---------------------------------------------------------------------------

test('convertSpot — default rateDivisor=1 leaves values unchanged', () => {
    const r = convertSpotCandles(
        { candles: [{ time: 100, value: 1.5 }] }, 0, 1000
    );
    assert.equal(r[0].close, '1.5');
});

test('convertSpot — rateDivisor scales values down', () => {
    // Pinned for the "::" rate-provider ticker case. e.g. PNK/sDAI
    // = (PNK/USD) / (sDAI/USD rate).
    const r = convertSpotCandles(
        { candles: [{ time: 100, value: 2 }] }, 0, 1000, 4
    );
    assert.equal(r[0].close, '0.5',
        `value 2 / divisor 4 = 0.5; got ${r[0].close}`);
});

test('convertSpot — divisor preserves float precision (no rounding)', () => {
    const r = convertSpotCandles(
        { candles: [{ time: 100, value: 1 }] }, 0, 1000, 3
    );
    // 1/3 ≈ 0.3333333333333333 — String() gives full JS float repr.
    assert.match(r[0].close, /^0\.3333333/);
});

// ---------------------------------------------------------------------------
// Rate-divisor extraction from poolTicker — source shape pin
// ---------------------------------------------------------------------------

test('handler — extracts rate provider address via split("::")[1].split("-")[0]', () => {
    // Pinned the EXACT split logic. A regression that swaps slice or
    // switches delimiters would route to the wrong rate provider —
    // silent price-scaling corruption.
    assert.match(SRC,
        /poolTicker\.split\(['"]\:\:['"]\)\[1\]\?\.split\(['"]-['"]\)\[0\]/,
        `rate provider extraction must be poolTicker.split("::")[1]?.split("-")[0]`);
});

test('handler — chainId: networkPart === "xdai" → 100, else 1 (Ethereum)', () => {
    // Pinned because the rate provider is queried on a specific chain;
    // a regression that defaults to 100 (Gnosis) when it should be 1
    // (Ethereum) would query the wrong chain entirely → 0 rate → div0
    // corruption later.
    assert.match(SRC,
        /networkPart\s*===\s*['"]xdai['"]\s*\?\s*100\s*:\s*1/,
        `chainId selection must be: networkPart === "xdai" ? 100 : 1`);
});

test('handler — networkPart from poolTicker.split("-").pop() with default "xdai"', () => {
    // Pinned: the last "-"-segment is the network. Default is xdai
    // (Gnosis) when no "-" present.
    assert.match(SRC,
        /poolTicker\.split\(['"]-['"]\)\.pop\(\)\s*\|\|\s*['"]xdai['"]/,
        `networkPart must be poolTicker.split("-").pop() || "xdai"`);
});

// ---------------------------------------------------------------------------
// handler invariants — verify forwardFill is applied to BOTH yes and no
// ---------------------------------------------------------------------------

test('handler — forwardFillCandles called on both yesCandles and noCandles', () => {
    // Pinned: a regression that fills only one side would produce a
    // chart with visible YES gaps (or vice versa) — easy to overlook
    // until a user reports.
    // Count call sites only — exclude the function definition itself.
    const callSites = [...SRC.matchAll(/forwardFillCandles\(/g)]
        .filter(m => !SRC.slice(Math.max(0, m.index - 10), m.index).includes('function'));
    assert.equal(callSites.length, 2,
        `forwardFillCandles must be called exactly twice (yes + no); got ${callSites.length}`);
    assert.match(SRC, /yesCandles\s*=\s*forwardFillCandles\(/);
    assert.match(SRC, /noCandles\s*=\s*forwardFillCandles\(/);
});

test('handler — yes/no candles re-filtered to [minTimestamp, maxTimestamp] AFTER forward-fill', () => {
    // Pinned because forwardFill produces candles up to effectiveMax (now),
    // but the user requested a narrower window. Without a re-filter, the
    // response over-shoots maxTimestamp.
    assert.match(SRC,
        /yesCandles[\s\S]*\.filter\(c\s*=>\s*parseInt\(c\.periodStartUnix\)\s*>=\s*minTimestamp[\s\S]*<=\s*maxTimestamp\)/,
        `yesCandles must be re-filtered to [minTimestamp, maxTimestamp] after forwardFill`);
    assert.match(SRC,
        /noCandles[\s\S]*\.filter\(c\s*=>\s*parseInt\(c\.periodStartUnix\)\s*>=\s*minTimestamp[\s\S]*<=\s*maxTimestamp\)/,
        `noCandles must be re-filtered to [minTimestamp, maxTimestamp] after forwardFill`);
});

test('handler — variables.maxTimestamp overridden to now BEFORE subgraph query', () => {
    // Critical: the subgraph query must fetch ALL data up to now
    // (so we have a recent candle to forward-fill from), even if the
    // user asked for a narrower window. The narrower window is then
    // applied client-side.
    assert.match(SRC,
        /variables\s*=\s*\{\s*\.\.\.\s*variables,\s*maxTimestamp:\s*now\s*\}/,
        `variables.maxTimestamp must be overridden to now before subgraph fetch ` +
        `(otherwise no recent data to forward-fill from)`);
});

test('source — ONE_HOUR pinned at 3600 seconds', () => {
    const m = SRC.match(/ONE_HOUR\s*=\s*(\d+)/);
    assert.ok(m, 'ONE_HOUR not found');
    assert.equal(parseInt(m[1]), 3600,
        `ONE_HOUR drifted from 3600s — would silently change forward-fill granularity`);
});

test('handler — error → 500 with errors envelope (not bare 500)', () => {
    // Pinned: the catch block returns the GraphQL-shaped errors envelope.
    // A regression to plain text/HTML breaks the frontend's GraphQL
    // client error handling.
    assert.match(SRC,
        /res\.status\(500\)\.json\(\{\s*errors:\s*\[\s*\{\s*message:\s*error\.message\s*\}\s*\]\s*\}\)/,
        `error path must respond res.status(500).json({errors:[{message: error.message}]})`);
});
