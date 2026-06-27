/**
 * spot-price fetcher helpers spec mirror (auto-qa).
 *
 * Pins src/services/spot-price.js fetcher helpers BEYOND the existing
 * spot-price-helpers.test.mjs (combineHopCandles + NETWORK_MAP +
 * GECKO endpoint selection) and spot-price-parse-config.test.mjs
 * (parseConfig). This file covers the four remaining helpers:
 *
 *   1. searchPool — GeckoTerminal pool search by base/quote name
 *      (case-insensitive substring match in the pool name).
 *
 *   2. fetchCandlesFromGecko — URL construction (timeframe selection,
 *      currency=token, before_timestamp), candle transformation
 *      (ohlcv array index 4 = close, time index 0), reverse + dedup
 *      + ascending-sort.
 *
 *   3. getRate — on-chain rate-provider eth_call (cross-pin with
 *      rate-provider.js — same selector 0x679aefce + 18-decimal
 *      scaling).
 *
 *   4. fetchHopCandles — orchestrator: search → fetch → optional
 *      per-hop invert (1/price). The per-hop invert is what powers
 *      configs like "PNK/WETH+!sDAI/WETH" to produce PNK/sDAI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/spot-price.js', import.meta.url),
    'utf8',
);

// --- spec mirror of timeframe selection ---
function pickTimeframe(interval) {
    return interval.includes('hour')
        ? 'hour'
        : interval.includes('min')
            ? 'minute'
            : 'day';
}

// --- spec mirror of ohlcv → {time, value} mapping (index 0=time, index 4=close) ---
function mapOhlcv(ohlcv) {
    return ohlcv
        .map(c => ({ time: c[0], value: parseFloat(c[4]) }))
        .reverse();
}

// --- spec mirror of dedup-by-time + ascending sort ---
function dedupAndSort(raw) {
    const seen = new Set();
    return raw.filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
    }).sort((a, b) => a.time - b.time);
}

// --- spec mirror of per-hop invert (1/price) ---
function applyHopInvert(candles, invert) {
    if (!invert) return candles;
    return candles.map(c => ({ ...c, value: 1 / c.value }));
}

// ---------------------------------------------------------------------------
// fetchCandlesFromGecko — timeframe selection
// ---------------------------------------------------------------------------

test('pickTimeframe — interval contains "hour" → "hour"', () => {
    assert.equal(pickTimeframe('hour'), 'hour');
    assert.equal(pickTimeframe('hour-500-xdai'), 'hour');
});

test('pickTimeframe — interval contains "min" → "minute"', () => {
    assert.equal(pickTimeframe('minute'), 'minute');
    assert.equal(pickTimeframe('5min'), 'minute');
});

test('pickTimeframe — anything else → "day" (default)', () => {
    // Pinned: the fall-through default is "day". Drift to error or
    // null would crash callers passing custom intervals.
    assert.equal(pickTimeframe('day'), 'day');
    assert.equal(pickTimeframe(''), 'day');
    assert.equal(pickTimeframe('weekly'), 'day');
});

test('source — fetchCandlesFromGecko timeframe selection: hour | min → minute | else day', () => {
    assert.match(SRC,
        /timeframe\s*=\s*interval\.includes\(['"]hour['"]\)\s*\?\s*['"]hour['"]\s*:\s*interval\.includes\(['"]min['"]\)\s*\?\s*['"]minute['"]\s*:\s*['"]day['"]/,
        `timeframe selection ternary drifted from hour|min→minute|else day`);
});

// ---------------------------------------------------------------------------
// fetchCandlesFromGecko — URL shape pins
// ---------------------------------------------------------------------------

test('source — fetchCandlesFromGecko URL: /networks/{net}/pools/{addr}/ohlcv/{tf}', () => {
    // Pinned the exact URL path. A regression that swaps the segment
    // order would 404 every candle fetch.
    assert.match(SRC,
        /\$\{GECKO_API\}\/networks\/\$\{geckoNetwork\}\/pools\/\$\{poolAddress\}\/ohlcv\/\$\{timeframe\}/,
        `GeckoTerminal candles URL path drifted from /networks/{net}/pools/{addr}/ohlcv/{tf}`);
});

test('source — fetchCandlesFromGecko query params: aggregate=1, limit=N, currency=token', () => {
    // Pinned: currency=token gives prices in QUOTE TOKEN (not USD).
    // A regression that drops currency=token would silently switch to
    // USD prices → wrong scale for downstream multi-hop math.
    assert.match(SRC,
        /\?aggregate=1&limit=\$\{limit\}&currency=token/,
        `query params drifted from "?aggregate=1&limit=N&currency=token"`);
});

test('source — fetchCandlesFromGecko appends &before_timestamp= ONLY when provided', () => {
    // Pinned: the append is conditional. Always-appending with null
    // would yield "before_timestamp=null" → API rejects.
    assert.match(SRC,
        /if\s*\(beforeTimestamp\)\s*\{\s*url\s*\+=\s*`&before_timestamp=\$\{beforeTimestamp\}`/,
        `before_timestamp conditional-append shape drifted`);
});

test('source — fetchCandlesFromGecko throws on !res.ok with status code in message', () => {
    assert.match(SRC,
        /if\s*\(!res\.ok\)\s*throw new Error\(`Candles failed: \$\{res\.status\}`\)/,
        `candles error message drifted from "Candles failed: ${'$'}{res.status}"`);
});

// ---------------------------------------------------------------------------
// fetchCandlesFromGecko — ohlcv parsing (index 0=time, index 4=close)
// ---------------------------------------------------------------------------

test('mapOhlcv — uses index 0 for time and index 4 for close (parseFloat)', () => {
    // Pinned: ohlcv tuple is [time, open, high, low, close, volume].
    // Index 4 = close. A regression to index 1 (open) would silently
    // use opening prices.
    const raw = [
        [100, 1.0, 1.5, 0.8, 1.2, 1000],  // time=100, close=1.2
        [200, 1.2, 1.8, 1.1, 1.5, 1500],
    ];
    const r = mapOhlcv(raw);
    // After reverse, last input is first.
    assert.equal(r[0].time, 200);
    assert.equal(r[0].value, 1.5);
    assert.equal(r[1].time, 100);
    assert.equal(r[1].value, 1.2);
});

test('mapOhlcv — REVERSES the input order (newest-first → oldest-first per Gecko)', () => {
    // Pinned: Gecko returns newest-first; we want oldest-first for
    // chart rendering. The .reverse() is critical.
    const raw = [[3, 0, 0, 0, 30, 0], [2, 0, 0, 0, 20, 0], [1, 0, 0, 0, 10, 0]];
    const r = mapOhlcv(raw);
    assert.deepEqual(r.map(c => c.time), [1, 2, 3]);
});

test('source — ohlcv mapped via c[0] (time) + c[4] (close, parseFloat)', () => {
    // Allow trailing comma after parseFloat(c[4]).
    assert.match(SRC,
        /ohlcv\.map\(c\s*=>\s*\(\{\s*time:\s*c\[0\],\s*value:\s*parseFloat\(c\[4\]\),?\s*\}\)\)\.reverse\(\)/,
        `ohlcv map shape drifted from {time: c[0], value: parseFloat(c[4])}.reverse()`);
});

// ---------------------------------------------------------------------------
// fetchCandlesFromGecko — dedup + sort (Gecko sometimes returns dupes)
// ---------------------------------------------------------------------------

test('dedupAndSort — removes duplicate timestamps (keeps first occurrence)', () => {
    // Pinned: Gecko sometimes returns duplicate candles at the same
    // timestamp. Without dedup, downstream forward-fill / multiplication
    // gets confused by multiple values per time bucket.
    const raw = [
        { time: 100, value: 1 },
        { time: 200, value: 2 },
        { time: 100, value: 99 },  // duplicate — dropped
    ];
    const r = dedupAndSort(raw);
    assert.equal(r.length, 2);
    assert.equal(r[0].value, 1, `must keep FIRST occurrence (value=1, not value=99)`);
});

test('dedupAndSort — sorts ASCENDING by time (chart-friendly order)', () => {
    const raw = [
        { time: 300, value: 30 },
        { time: 100, value: 10 },
        { time: 200, value: 20 },
    ];
    const r = dedupAndSort(raw);
    assert.deepEqual(r.map(c => c.time), [100, 200, 300]);
});

test('source — dedup uses Set + filter pattern (NOT findIndex which is O(n²))', () => {
    // Pinned: Set-based dedup is O(n); findIndex would be O(n²) on
    // large candle arrays.
    assert.match(SRC,
        /const seen\s*=\s*new Set\(\);[\s\S]*?if\s*\(seen\.has\(c\.time\)\)\s*return\s+false;[\s\S]*?seen\.add\(c\.time\)/,
        `dedup pattern drifted from Set + filter`);
});

test('source — sort comparator: a.time - b.time (ASCENDING)', () => {
    assert.match(SRC,
        /\.sort\(\(a,\s*b\)\s*=>\s*a\.time\s*-\s*b\.time\)/,
        `dedup sort comparator drifted from ascending (a.time - b.time)`);
});

// ---------------------------------------------------------------------------
// searchPool — query format + match filter
// ---------------------------------------------------------------------------

test('source — searchPool query is `${base} ${quote}` (space-separated)', () => {
    // Pinned: GeckoTerminal accepts either "WETH PNK" or "WETH/PNK".
    // The space form is preferred. A regression to slash form would
    // change matching results.
    assert.match(SRC,
        /const query\s*=\s*`\$\{base\}\s+\$\{quote\}`/,
        `searchPool query string drifted from "${'$'}{base} ${'$'}{quote}" space-separated`);
});

test('source — searchPool uses encodeURIComponent on the query', () => {
    // Pinned: token symbols can contain unsafe characters (rare but
    // possible). encodeURIComponent prevents URL injection.
    assert.match(SRC,
        /\$\{encodeURIComponent\(query\)\}/,
        `searchPool query must be encoded via encodeURIComponent`);
});

test('source — searchPool match filter: name (lowercased) includes BOTH base AND quote', () => {
    // Pinned: must match BOTH tokens in the pool name. A regression
    // to OR would match the wrong pool (e.g. WETH/USDC for "WETH PNK").
    assert.match(SRC,
        /name\.includes\(base\.toLowerCase\(\)\)\s*&&\s*name\.includes\(quote\.toLowerCase\(\)\)/,
        `searchPool match filter drifted from BOTH base AND quote (NOT or)`);
});

test('source — searchPool throws "Pool not found: base/quote" on no match', () => {
    assert.match(SRC,
        /if\s*\(!match\)\s*throw new Error\(`Pool not found:\s*\$\{base\}\/\$\{quote\}`\)/,
        `searchPool no-match error drifted`);
});

test('source — searchPool returns {address, name, network} (3-field shape)', () => {
    // Pinned: callers destructure {address}. A regression that
    // changes shape would break fetchHopCandles which uses
    // pool.address + pool.name.
    assert.match(SRC,
        /return\s*\{\s*address:\s*match\.attributes\?\.\s*address,\s*name:\s*match\.attributes\?\.\s*name,\s*network:[\s\S]*?\}/,
        `searchPool return shape drifted`);
});

// ---------------------------------------------------------------------------
// getRate — on-chain rate provider call (cross-pin with rate-provider.js)
// ---------------------------------------------------------------------------

test('source — getRate uses GET_RATE_SELECTOR = 0x679aefce (cross-pin with rate-provider.js)', () => {
    // Pinned: same selector as src/services/rate-provider.js. This is
    // the keccak256("getRate()")[:4] of the ERC-4626 rate provider
    // standard. A regression would silently call the wrong function
    // selector → revert.
    assert.match(SRC,
        /GET_RATE_SELECTOR\s*=\s*['"]0x679aefce['"]/,
        `GET_RATE_SELECTOR drifted from 0x679aefce — cross-pin: rate-provider.js uses same`);
});

test('source — getRate uses 18-decimal scaling: Number(BigInt(result)) / 1e18', () => {
    // Pinned: ERC-4626 standard returns rate scaled by 1e18. A
    // regression that uses /1e6 (USDC scale) or /1e8 (BTC scale)
    // would be off by orders of magnitude.
    assert.match(SRC,
        /rate\s*=\s*Number\(BigInt\(result\)\)\s*\/\s*1e18/,
        `getRate decimal scaling drifted from 18 (1e18)`);
});

test('source — getRate eth_call body shape (jsonrpc 2.0 + eth_call + latest)', () => {
    // Pinned the JSON-RPC envelope. A regression that drops jsonrpc
    // or uses a different method would fail RPC validation.
    assert.match(SRC,
        /jsonrpc:\s*['"]2\.0['"][\s\S]*?method:\s*['"]eth_call['"][\s\S]*?params:\s*\[\s*\{\s*to:\s*rateProvider,\s*data:\s*GET_RATE_SELECTOR\s*\},\s*['"]latest['"]\]/,
        `getRate eth_call body shape drifted`);
});

test('source — getRate returns 1 (no-conversion) when network unknown', () => {
    // Pinned: same fallback semantics as rate-provider.js.
    assert.match(SRC,
        /if\s*\(!networkInfo\)\s*return\s+1/,
        `getRate must return 1 (no-conversion) on unknown network`);
});

test('source — getRate returns 1 (no-conversion) on any error (try/catch)', () => {
    assert.match(SRC,
        /\}\s*catch\s*\(e\)\s*\{[\s\S]*?return\s+1/,
        `getRate must return 1 on error (NOT throw)`);
});

test('source — getRate uses NETWORK_MAP[network].rpc (network-aware RPC selection)', () => {
    // Pinned: each network has its own RPC. A regression that hardcodes
    // a Gnosis RPC would break Ethereum-side rate providers.
    assert.match(SRC,
        /networkInfo\.rpc/,
        `getRate must use NETWORK_MAP[network].rpc — NOT hardcoded URL`);
});

// ---------------------------------------------------------------------------
// fetchHopCandles — search → fetch → per-hop invert
// ---------------------------------------------------------------------------

test('applyHopInvert — invert=false returns candles unchanged (identity)', () => {
    const c = [{ time: 1, value: 0.5 }];
    assert.equal(applyHopInvert(c, false), c,
        `non-invert path must return SAME reference (no copy)`);
});

test('applyHopInvert — invert=true applies 1/value to each candle', () => {
    const c = [{ time: 1, value: 0.5 }, { time: 2, value: 4 }];
    const r = applyHopInvert(c, true);
    assert.deepEqual(r, [
        { time: 1, value: 2 },    // 1/0.5
        { time: 2, value: 0.25 }, // 1/4
    ]);
});

test('applyHopInvert — preserves other candle fields via spread', () => {
    const c = [{ time: 1, value: 2, extra: 'kept' }];
    const r = applyHopInvert(c, true);
    assert.equal(r[0].extra, 'kept');
});

test('source — fetchHopCandles applies per-hop invert: candles.map(c => ({...c, value: 1 / c.value}))', () => {
    // Pinned: the spread + 1/value is the canonical invert form.
    // Drift to assigning 1/value without spread would lose other
    // fields.
    assert.match(SRC,
        /candles\s*=\s*candles\.map\(c\s*=>\s*\(\{\s*\.\.\.\s*c,\s*value:\s*1\s*\/\s*c\.value\s*\}\)\)/,
        `fetchHopCandles invert shape drifted from map(c => ({...c, value: 1/c.value}))`);
});

test('source — fetchHopCandles invert is gated on hop.invert (NOT a global flag)', () => {
    // Pinned: per-hop invert (driven by ! prefix in config). A
    // regression to a global invert would invert ALL hops.
    assert.match(SRC,
        /if\s*\(hop\.invert\)\s*\{[\s\S]*?candles\s*=\s*candles\.map/,
        `fetchHopCandles invert must be gated on hop.invert (NOT global)`);
});

test('source — fetchHopCandles calls searchPool BEFORE fetchCandlesFromGecko (search to find pool addr)', () => {
    // Pinned: the order matters — fetch needs the pool address.
    const fn = SRC.match(/async function fetchHopCandles\([\s\S]*?^\}/m);
    assert.ok(fn);
    const searchIdx = fn[0].indexOf('searchPool');
    const fetchIdx = fn[0].indexOf('fetchCandlesFromGecko');
    assert.ok(searchIdx > -1 && fetchIdx > -1);
    assert.ok(searchIdx < fetchIdx,
        `fetchHopCandles must call searchPool BEFORE fetchCandlesFromGecko (need pool addr first)`);
});

test('source — fetchHopCandles passes hop.base + hop.quote to searchPool, NOT the whole hop', () => {
    // Pinned: searchPool destructure is by base/quote args. A regression
    // that passes the whole hop would not find a pool.
    assert.match(SRC,
        /searchPool\(network,\s*hop\.base,\s*hop\.quote\)/,
        `fetchHopCandles must pass (network, hop.base, hop.quote) to searchPool`);
});

// ---------------------------------------------------------------------------
// Cross-pin: getRate selector matches rate-provider.js
// ---------------------------------------------------------------------------

test('cross-file — getRate selector 0x679aefce equals rate-provider.js GET_RATE_SELECTOR', () => {
    // Pinned: both files MUST agree on the ERC-4626 getRate() function
    // selector. Cross-pin so any drift in either file flags the test.
    const RATE_PROVIDER_SRC = readFileSync(
        new URL('../../src/services/rate-provider.js', import.meta.url),
        'utf8',
    );
    const m1 = SRC.match(/GET_RATE_SELECTOR\s*=\s*['"]([^'"]+)['"]/);
    const m2 = RATE_PROVIDER_SRC.match(/GET_RATE_SELECTOR\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m1, 'spot-price.js GET_RATE_SELECTOR not found');
    assert.ok(m2, 'rate-provider.js GET_RATE_SELECTOR not found');
    assert.equal(m1[1], m2[1],
        `selector divergence between spot-price.js and rate-provider.js — both must use 0x679aefce`);
    assert.equal(m1[1], '0x679aefce',
        `selector drifted from canonical 0x679aefce (keccak256("getRate()")[:4])`);
});
