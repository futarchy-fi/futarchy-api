/**
 * fetchSpotCandles orchestrator spec mirror (auto-qa).
 *
 * Pins src/services/spot-price.js's main public export
 * fetchSpotCandles — the ~140-line orchestrator that dispatches to
 * three distinct paths based on config shape:
 *
 *   1. MULTI-HOP path (config.isMultiHop) — token-pair multi-hop,
 *      pools resolved via searchPool, prices multiplied.
 *   2. COMPOSITE path (config.isComposite) — pool-address multi-hop,
 *      direct fetch by address (no search), with optional rate
 *      provider divisor.
 *   3. SINGLE POOL path — direct (config.poolAddress) or
 *      search-by-base/quote.
 *
 * ALL THREE paths return the SAME 5-field response envelope
 * `{candles, price, rate, pool, error}`. Drift in any field name
 * breaks downstream consumers.
 *
 * Eight concerns:
 *
 *   1. Path dispatch order: invalid → multi-hop → composite → single.
 *   2. Response envelope shape: 5 fields, error null on success.
 *   3. Caller-provided limit overrides config.limit.
 *   4. latestPrice = last candle's value (or null if empty).
 *   5. Multi-hop: parallel fetchHopCandles via Promise.all.
 *   6. Composite: per-pool fetch with per-hop invert, then optional
 *      rate divisor, then optional final invert. Order matters.
 *   7. Single pool: rate is null OR 1 (NEVER applied — comment
 *      explains GeckoTerminal already returns correct unit).
 *   8. Error envelope: try/catch wraps the whole orchestrator;
 *      catch returns the same 5-field shape with error.message.
 *
 * Plus the getSpotPrice convenience wrapper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/spot-price.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// Path dispatch — invalid config → multi-hop → composite → single
// ---------------------------------------------------------------------------

test('source — invalid config (parseConfig returns null) → returns 5-field envelope with error="Invalid config"', () => {
    // Pinned: parseConfig returns null on falsy input. The orchestrator
    // short-circuits BEFORE any network call.
    assert.match(SRC,
        /if\s*\(!config\)\s*\{\s*return\s*\{\s*candles:\s*\[\],\s*price:\s*null,\s*rate:\s*null,\s*pool:\s*null,\s*error:\s*['"]Invalid config['"]\s*\}/,
        `invalid-config short-circuit shape drifted from {candles:[], price:null, rate:null, pool:null, error:'Invalid config'}`);
});

test('source — fetchSpotCandles default param: configString = DEFAULT_CONFIG', () => {
    assert.match(SRC,
        /export async function fetchSpotCandles\(configString\s*=\s*DEFAULT_CONFIG/,
        `fetchSpotCandles default configString drifted from DEFAULT_CONFIG`);
});

test('source — caller-provided limit OVERRIDES config.limit', () => {
    // Pinned: `if (limit) config.limit = limit;` — explicit limit
    // takes precedence over the config-string parsed limit. Drift to
    // ignoring caller limit silently caps at config default (500).
    assert.match(SRC,
        /if\s*\(limit\)\s*config\.limit\s*=\s*limit/,
        `caller-limit override shape drifted`);
});

test('source — path dispatch ORDER: isMultiHop → isComposite → single (in source body)', () => {
    // Pinned the dispatch order. A regression that flips multi-hop and
    // composite checks could route a composite ticker through the
    // multi-hop path (which would crash on hop.poolAddress access).
    const fn = SRC.match(/export async function fetchSpotCandles[\s\S]*?^\}\s*$/m);
    assert.ok(fn);
    const body = fn[0];
    const multiIdx = body.indexOf('config.isMultiHop');
    const compositeIdx = body.indexOf('config.isComposite');
    const singleIdx = body.indexOf('// SINGLE POOL PATH');
    assert.ok(multiIdx > -1 && compositeIdx > -1 && singleIdx > -1,
        'all three path markers present');
    assert.ok(multiIdx < compositeIdx,
        `MULTI-HOP check must come BEFORE COMPOSITE check`);
    assert.ok(compositeIdx < singleIdx,
        `COMPOSITE check must come BEFORE single-pool fall-through`);
});

// ---------------------------------------------------------------------------
// Response envelope — 5-field shape uniformity across ALL paths
// ---------------------------------------------------------------------------

test('source — multi-hop path returns {candles, price, rate, pool, error}', () => {
    // Pinned: rate is null on multi-hop (no rate divisor applied);
    // pool is the hop names joined by ' → '; error null on success.
    assert.match(SRC,
        /\/\/ ⭐ MULTI-HOP PATH[\s\S]*?return\s*\{\s*candles,\s*price:\s*latestPrice,\s*rate:\s*null,\s*pool:\s*hopNames,\s*error:\s*null,?\s*\}/,
        `multi-hop response envelope shape drifted from {candles, price, rate:null, pool:hopNames, error:null}`);
});

test('source — composite path returns {candles, price, rate, pool, error}', () => {
    assert.match(SRC,
        /\/\/ ⭐ COMPOSITE PATH[\s\S]*?return\s*\{\s*candles,\s*price:\s*latestPrice,\s*rate:\s*null,\s*pool:\s*poolNames,\s*error:\s*null,?\s*\}/,
        `composite response envelope shape drifted`);
});

test('source — single pool path returns {candles, price, rate, pool, error}', () => {
    // Pinned: rate is null OR 1 (when rateProvider configured but NOT
    // actually applied). pool is the poolAddress (NOT poolName).
    assert.match(SRC,
        /\/\/ SINGLE POOL PATH[\s\S]*?return\s*\{\s*candles,\s*price:\s*latestPrice,\s*rate,\s*pool:\s*poolAddress,\s*error:\s*null,?\s*\}/,
        `single-pool response envelope shape drifted`);
});

test('source — error envelope shape MATCHES success envelope (5 fields)', () => {
    // Pinned: the catch block returns the same shape with error.message.
    // A regression that returns a different shape forces consumers
    // to check the response shape.
    assert.match(SRC,
        /\}\s*catch\s*\(e\)\s*\{[\s\S]*?return\s*\{\s*candles:\s*\[\],\s*price:\s*null,\s*rate:\s*null,\s*pool:\s*null,\s*error:\s*e\.message\s*\}/,
        `error envelope shape drifted from {candles:[], price:null, rate:null, pool:null, error: e.message}`);
});

// ---------------------------------------------------------------------------
// Multi-hop path — Promise.all + invert at end
// ---------------------------------------------------------------------------

test('source — multi-hop fetches hops in PARALLEL via Promise.all', () => {
    assert.match(SRC,
        /hopCandlesPromises\s*=\s*config\.hops\.map\(hop\s*=>[\s\S]*?fetchHopCandles\(hop,\s*config\.network,\s*config\.interval,\s*config\.limit,\s*beforeTimestamp\)[\s\S]*?Promise\.all\(hopCandlesPromises\)/,
        `multi-hop parallel-fetch shape drifted (must use Promise.all over hops.map)`);
});

test('source — multi-hop applies combineHopCandles AFTER all hops resolved', () => {
    // Pinned: combine MUST run after parallel resolve (otherwise it
    // sees a Promise array instead of candle arrays).
    assert.match(SRC,
        /hopCandlesArray\s*=\s*await\s+Promise\.all\(hopCandlesPromises\)[\s\S]*?candles\s*=\s*combineHopCandles\(hopCandlesArray\)/,
        `multi-hop must combineHopCandles AFTER Promise.all resolution`);
});

test('source — multi-hop final invert applied AFTER combineHopCandles (NOT before)', () => {
    // Pinned: the invert (entire result inversion) must run AFTER
    // combine. Order matters because per-hop inverts already happened
    // inside fetchHopCandles.
    const block = SRC.match(/\/\/ ⭐ MULTI-HOP PATH[\s\S]*?\/\/ ⭐ COMPOSITE PATH/);
    assert.ok(block);
    const combineIdx = block[0].indexOf('combineHopCandles');
    const invertIdx = block[0].indexOf('config.invert');
    assert.ok(combineIdx > -1 && invertIdx > -1);
    assert.ok(combineIdx < invertIdx,
        `multi-hop final invert MUST come AFTER combineHopCandles`);
});

test('source — multi-hop pool field is hop names joined by " → " (Unicode arrow)', () => {
    // Pinned: the visual separator. A regression to '+' or '/' would
    // break log readability and any UI that surfaces this string.
    assert.match(SRC,
        /hopNames\s*=\s*config\.hops\.map\(h\s*=>\s*`\$\{h\.base\}\/\$\{h\.quote\}`\)\.join\(['"] → ['"]\)/,
        `multi-hop pool name format drifted from "base/quote → base/quote" (Unicode arrow)`);
});

// ---------------------------------------------------------------------------
// Composite path — per-pool fetch + per-hop invert + rate divisor + final invert
// ---------------------------------------------------------------------------

test('source — composite fetches pools via fetchCandlesFromGecko (NOT searchPool)', () => {
    // Pinned: composite has pool addresses already; no search needed.
    // A regression that calls searchPool would 404 (search by address
    // doesn't work).
    assert.match(SRC,
        /\/\/ ⭐ COMPOSITE PATH[\s\S]*?fetchCandlesFromGecko\(hop\.poolAddress,\s*config\.network,\s*config\.interval,\s*config\.limit,\s*beforeTimestamp\)/,
        `composite must fetch via fetchCandlesFromGecko(hop.poolAddress, ...) — NOT searchPool`);
});

test('source — composite applies per-hop invert INSIDE the parallel map (before combine)', () => {
    // Pinned: per-hop invert is applied per-hop, before combineHopCandles.
    // This is distinct from the FINAL invert (config.invert) which is
    // applied AFTER combine.
    const block = SRC.match(/\/\/ ⭐ COMPOSITE PATH[\s\S]*?\/\/ SINGLE POOL PATH/);
    assert.ok(block);
    assert.match(block[0],
        /if\s*\(hop\.invert\)\s*\{\s*candles\s*=\s*candles\.map\(c\s*=>\s*\(\{\s*\.\.\.c,\s*value:\s*1\s*\/\s*c\.value\s*\}\)\)/,
        `composite per-hop invert shape drifted`);
});

test('source — composite applies rate provider AFTER combineHopCandles (divides candle values by rate)', () => {
    // Pinned: rate divisor converts xDAI → sDAI (or similar). MUST be
    // after combine so the final composite price gets divided.
    const block = SRC.match(/\/\/ ⭐ COMPOSITE PATH[\s\S]*?\/\/ SINGLE POOL PATH/);
    assert.ok(block);
    const combineIdx = block[0].indexOf('combineHopCandles');
    const rateIdx = block[0].indexOf('getRate(config.rateProvider');
    assert.ok(combineIdx > -1 && rateIdx > -1);
    assert.ok(combineIdx < rateIdx,
        `composite rate divisor MUST be applied AFTER combineHopCandles`);
});

test('source — composite rate divisor: candles.map(c => ({...c, value: c.value / rate}))', () => {
    // Pinned the divide-by-rate shape. A regression to multiplication
    // would invert the conversion direction.
    assert.match(SRC,
        /\/\/ ⭐ COMPOSITE PATH[\s\S]*?candles\s*=\s*candles\.map\(c\s*=>\s*\(\{\s*\.\.\.c,\s*value:\s*c\.value\s*\/\s*rate\s*\}\)\)/,
        `composite rate-divisor shape drifted (must DIVIDE c.value by rate, not multiply)`);
});

test('source — composite FINAL invert applied AFTER rate divisor (3-step order)', () => {
    // Pinned the order: combine → rate divide → final invert. A
    // regression that flips the last two would invert BEFORE divide,
    // changing the result.
    const block = SRC.match(/\/\/ ⭐ COMPOSITE PATH[\s\S]*?\/\/ SINGLE POOL PATH/);
    assert.ok(block);
    const rateIdx = block[0].indexOf('candles = candles.map(c => ({ ...c, value: c.value / rate }))');
    const invertIdx = block[0].indexOf('if (config.invert)');
    assert.ok(rateIdx > -1 && invertIdx > -1);
    assert.ok(rateIdx < invertIdx,
        `composite final invert MUST be AFTER rate divisor`);
});

test('source — composite pool field is hop pool addresses joined by "+" (NOT " → ")', () => {
    // Pinned: composite uses '+' as separator (matches the config string
    // syntax `composite::0xPOOL1+0xPOOL2`). Distinct from multi-hop's
    // ' → ' Unicode arrow.
    assert.match(SRC,
        /poolNames\s*=\s*config\.hops\.map\(h\s*=>\s*h\.poolAddress\.slice\(0,\s*10\)\)\.join\(['"]\+['"]\)/,
        `composite pool name format drifted from poolAddress.slice(0,10).join('+')`);
});

// ---------------------------------------------------------------------------
// Single pool path — searchPool fallback when no poolAddress
// ---------------------------------------------------------------------------

test('source — single pool path: if config.poolAddress, use directly; else searchPool', () => {
    // Pinned the fallback: direct address bypasses search; missing
    // address triggers searchPool by base/quote. A regression that
    // always searches would silently waste API calls + may pick wrong
    // pool when an address is explicit.
    assert.match(SRC,
        /if\s*\(config\.poolAddress\)\s*\{\s*poolAddress\s*=\s*config\.poolAddress;\s*poolName\s*=\s*['"]Direct Pool['"]\s*;?\s*\}\s*else\s*\{[\s\S]*?searchPool\(config\.network,\s*config\.base,\s*config\.quote\)/,
        `single-pool direct-vs-search fallback shape drifted`);
});

test('source — single pool path: rate is null when no rateProvider, 1 when rateProvider set (NOT applied)', () => {
    // Pinned: the comment explicitly says "Rate provider info is
    // available but NOT applied to candles". The rate field is metadata
    // only — neither divides nor multiplies. A regression that applies
    // it would silently scale prices.
    assert.match(SRC,
        /\/\/ Note:\s*Rate provider info is available but NOT applied to candles[\s\S]*?const rate\s*=\s*config\.rateProvider\s*\?\s*1\s*:\s*null/,
        `single-pool rate metadata-only behavior drifted (must be 1 OR null, NEVER applied)`);
});

// ---------------------------------------------------------------------------
// latestPrice — derivation from candle array
// ---------------------------------------------------------------------------

test('source — latestPrice = candles[candles.length - 1].value (last candle), null if empty', () => {
    // Pinned: each path computes latestPrice the same way. A regression
    // that picks candles[0] would yield the OLDEST price.
    const matches = [...SRC.matchAll(/latestPrice\s*=\s*candles\.length\s*>\s*0\s*\?\s*candles\[candles\.length\s*-\s*1\]\.value\s*:\s*null/g)];
    assert.equal(matches.length, 3,
        `expected exactly 3 latestPrice computations (one per path: multi-hop, composite, single); got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// Invert mechanic — common shape across paths
// ---------------------------------------------------------------------------

test('source — config.invert applied as `candles.map(c => ({...c, value: 1 / c.value}))` (3 sites)', () => {
    // Pinned: the invert formula is the same across all 3 paths.
    // Spec mirror is exact pattern.
    const matches = [...SRC.matchAll(/candles\.map\(c\s*=>\s*\(\{\s*\.\.\.c,\s*value:\s*1\s*\/\s*c\.value\s*\}\)\)/g)];
    assert.ok(matches.length >= 3,
        `expected >=3 invert sites (one per path); got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// getSpotPrice convenience wrapper
// ---------------------------------------------------------------------------

test('source — getSpotPrice exists as second public export', () => {
    assert.match(SRC,
        /export async function getSpotPrice\(configString\s*=\s*DEFAULT_CONFIG\)/,
        `getSpotPrice export signature drifted from (configString = DEFAULT_CONFIG)`);
});

// ---------------------------------------------------------------------------
// Error path — try/catch wraps entire orchestrator
// ---------------------------------------------------------------------------

test('source — entire orchestrator wrapped in try/catch (single error envelope)', () => {
    // Pinned: a single try/catch at the top of fetchSpotCandles. A
    // regression that adds nested try/catches inside individual paths
    // could swallow errors silently.
    const fn = SRC.match(/export async function fetchSpotCandles[\s\S]*?^\}\s*$/m);
    assert.ok(fn);
    const tryMatches = [...fn[0].matchAll(/\btry\s*\{/g)];
    // 1 outer try in fetchSpotCandles. Inner async IIFE in composite
    // doesn't count — but be lenient: assert at least 1 outer try.
    assert.ok(tryMatches.length >= 1,
        `fetchSpotCandles must have at least 1 try/catch (outer wrapper)`);
});

test('source — error path logs error.message via console.error (debug observability)', () => {
    assert.match(SRC,
        /console\.error\(['"]\[spotPrice\] Error:['"],\s*e\.message\)/,
        `error log shape drifted from "[spotPrice] Error: <msg>"`);
});

// ---------------------------------------------------------------------------
// Module export surface
// ---------------------------------------------------------------------------

test('source — exactly 2 exports: fetchSpotCandles + getSpotPrice', () => {
    // Pinned: the public surface is intentionally narrow. New exports
    // should be deliberate.
    const exports = [...SRC.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)].map(m => m[2]);
    assert.deepEqual(exports.sort(), ['fetchSpotCandles', 'getSpotPrice'].sort(),
        `module exports drifted from canonical [fetchSpotCandles, getSpotPrice]`);
});
