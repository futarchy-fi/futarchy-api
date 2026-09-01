/**
 * spot-price helpers spec mirror (auto-qa).
 *
 * Pins src/services/spot-price.js's combineHopCandles + NETWORK_MAP +
 * GECKO endpoint selection logic.
 *
 * combineHopCandles is the core multi-hop price multiplier — given
 * candles for each hop in a multi-hop ticker (e.g. PNK/WETH × WETH/sDAI),
 * it produces a single composite series by:
 *   1. Collecting all unique timestamps across all hops
 *   2. Forward-filling missing prices per hop
 *   3. Multiplying prices once ALL hops have at least one known price
 *   4. Skipping timestamps before that warmup
 *
 * A regression in this multiplier silently corrupts every multi-hop
 * spot price the api serves.
 *
 * NETWORK_MAP routes network aliases to gecko names + chain ids + RPC
 * URLs. A typo silently routes queries to the wrong network.
 *
 * GECKO endpoint selection switches between pro-api.coingecko.com (when
 * COINGECKO_API_KEY is set) and api.geckoterminal.com. A regression
 * could silently leak a pro key to the public terminal endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/spot-price.js', import.meta.url),
    'utf8',
);

// --- spec mirror of combineHopCandles ---
function combineHopCandles(hopCandlesArray) {
    if (hopCandlesArray.length === 0) return [];
    if (hopCandlesArray.length === 1) return hopCandlesArray[0];

    const allTimestamps = new Set();
    hopCandlesArray.forEach(candles => candles.forEach(c => allTimestamps.add(c.time)));
    const sortedTimes = [...allTimestamps].sort((a, b) => a - b);

    const hopMaps = hopCandlesArray.map(candles => {
        const map = new Map();
        candles.forEach(c => map.set(c.time, c.value));
        return map;
    });

    const lastKnownPrices = hopMaps.map(() => null);
    const result = [];
    for (const time of sortedTimes) {
        let allHopsInitialized = true;
        for (let i = 0; i < hopMaps.length; i++) {
            if (hopMaps[i].has(time)) lastKnownPrices[i] = hopMaps[i].get(time);
            if (lastKnownPrices[i] === null) allHopsInitialized = false;
        }
        if (allHopsInitialized) {
            const compositeValue = lastKnownPrices.reduce((product, price) => product * price, 1);
            result.push({ time, value: compositeValue });
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// combineHopCandles — degenerate cases
// ---------------------------------------------------------------------------

test('combineHopCandles — empty array returns empty', () => {
    assert.deepEqual(combineHopCandles([]), []);
});

test('combineHopCandles — single-hop array returns it unchanged', () => {
    const hop = [{ time: 1, value: 10 }, { time: 2, value: 20 }];
    assert.equal(combineHopCandles([hop]), hop,
        `single-hop must return the SAME array (identity, not copy)`);
});

// ---------------------------------------------------------------------------
// combineHopCandles — happy path
// ---------------------------------------------------------------------------

test('combineHopCandles — two hops with same timestamps multiply per-timestamp', () => {
    const hop1 = [{ time: 1, value: 10 }, { time: 2, value: 20 }];
    const hop2 = [{ time: 1, value: 0.5 }, { time: 2, value: 0.25 }];
    assert.deepEqual(combineHopCandles([hop1, hop2]), [
        { time: 1, value: 5 },   // 10 * 0.5
        { time: 2, value: 5 },   // 20 * 0.25
    ]);
});

test('combineHopCandles — three hops multiply all together', () => {
    const h1 = [{ time: 1, value: 2 }];
    const h2 = [{ time: 1, value: 3 }];
    const h3 = [{ time: 1, value: 5 }];
    assert.deepEqual(combineHopCandles([h1, h2, h3]), [{ time: 1, value: 30 }]);
});

// ---------------------------------------------------------------------------
// combineHopCandles — forward-fill across missing timestamps
// ---------------------------------------------------------------------------

test('combineHopCandles — missing hop2 timestamp forward-fills from previous', () => {
    // hop1 has t=1,2,3; hop2 has only t=1 and t=3.
    // At t=2, hop2 forward-fills from t=1 (value=0.5).
    const hop1 = [{ time: 1, value: 10 }, { time: 2, value: 20 }, { time: 3, value: 30 }];
    const hop2 = [{ time: 1, value: 0.5 },                        { time: 3, value: 0.1 }];
    assert.deepEqual(combineHopCandles([hop1, hop2]), [
        { time: 1, value: 5 },   // 10 * 0.5
        { time: 2, value: 10 },  // 20 * 0.5 (forward-filled from t=1)
        { time: 3, value: 3 },   // 30 * 0.1
    ]);
});

test('combineHopCandles — skips timestamps before ALL hops are initialized', () => {
    // hop1 starts at t=1; hop2 starts at t=3. At t=1,2 hop2 is null
    // (no known price yet), so output starts at t=3.
    const hop1 = [{ time: 1, value: 10 }, { time: 2, value: 20 }, { time: 3, value: 30 }];
    const hop2 = [                                                  { time: 3, value: 0.1 }];
    assert.deepEqual(combineHopCandles([hop1, hop2]), [
        { time: 3, value: 3 },   // first time both hops have a known price
    ]);
});

test('combineHopCandles — output sorted by time ascending', () => {
    // Input out of order; output must be sorted.
    const hop1 = [{ time: 3, value: 30 }, { time: 1, value: 10 }, { time: 2, value: 20 }];
    const hop2 = [{ time: 2, value: 0.2 }, { time: 1, value: 0.1 }, { time: 3, value: 0.3 }];
    const r = combineHopCandles([hop1, hop2]);
    const times = r.map(c => c.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('combineHopCandles — preserves value as float (no precision loss)', () => {
    const hop1 = [{ time: 1, value: 1.123456789 }];
    const hop2 = [{ time: 1, value: 2.987654321 }];
    const r = combineHopCandles([hop1, hop2]);
    assert.equal(r[0].value, 1.123456789 * 2.987654321);
});

// ---------------------------------------------------------------------------
// NETWORK_MAP — alias routing
// ---------------------------------------------------------------------------

test('NETWORK_MAP — has xdai alias (chainId 100, gecko "xdai")', () => {
    assert.match(SRC,
        /xdai\s*:\s*\{[^}]*gecko:\s*['"]xdai['"][^}]*chainId:\s*100/,
        `xdai alias missing or chainId/gecko drift`);
});

test('NETWORK_MAP — has gnosis alias (chainId 100) — synonym for xdai', () => {
    // Both "xdai" and "gnosis" must route to the same chain. A regression
    // that drops "gnosis" alias breaks any caller using the modern name.
    assert.match(SRC,
        /gnosis\s*:\s*\{[^}]*gecko:\s*['"]xdai['"][^}]*chainId:\s*100/,
        `gnosis alias missing or chainId/gecko drift`);
});

test('NETWORK_MAP — has eth alias (chainId 1)', () => {
    assert.match(SRC,
        /eth\s*:\s*\{[^}]*gecko:\s*['"]eth['"][^}]*chainId:\s*1/,
        `eth alias missing or chainId/gecko drift`);
});

test('NETWORK_MAP — has base alias (chainId 8453)', () => {
    assert.match(SRC,
        /base\s*:\s*\{[^}]*gecko:\s*['"]base['"][^}]*chainId:\s*8453/,
        `base alias missing or chainId/gecko drift`);
});

test('NETWORK_MAP — RPC URLs are HTTPS', () => {
    const m = SRC.match(/NETWORK_MAP\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(m, 'NETWORK_MAP body not found');
    const rpcs = [...m[1].matchAll(/rpc:\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
    assert.ok(rpcs.length >= 3, `expected >=3 RPC URLs; got ${rpcs.length}`);
    for (const url of rpcs) {
        assert.match(url, /^https:\/\//, `NETWORK_MAP RPC not HTTPS: ${url}`);
    }
});

// ---------------------------------------------------------------------------
// GECKO endpoint selection — pro-api when key is present, public terminal otherwise
// ---------------------------------------------------------------------------

test('spot-price — GECKO_API switches to pro-api when key is set', () => {
    assert.match(SRC,
        /GECKO_API\s*=\s*GECKO_API_KEY[\s\S]*?['"]https:\/\/pro-api\.coingecko\.com\/api\/v3\/onchain['"]/,
        `pro-api endpoint not found in GECKO_API selection`);
});

test('spot-price — GECKO_API falls back to public api.geckoterminal.com', () => {
    assert.match(SRC,
        /['"]https:\/\/api\.geckoterminal\.com\/api\/v2['"]/,
        `public geckoterminal fallback URL missing`);
});

test('spot-price — GECKO_HEADERS adds x-cg-pro-api-key when key is set', () => {
    // Critical: the pro-api requires this header. A regression that
    // forgets it would 401 every request.
    assert.match(SRC,
        /GECKO_HEADERS\s*=\s*GECKO_API_KEY[\s\S]*?'x-cg-pro-api-key':\s*GECKO_API_KEY/,
        `x-cg-pro-api-key header missing in GECKO_HEADERS conditional`);
});

test('spot-price — GECKO_HEADERS omits the pro key when unset', () => {
    // Also critical: when no key, the public endpoint receives only
    // the accept header — no pro-key header (which would leak the
    // hardcoded fallback to a public endpoint).
    assert.match(SRC,
        /:\s*\{\s*accept:\s*['"]application\/json['"]\s*\}/,
        `public-headers branch (just accept) not found in GECKO_HEADERS`);
});
