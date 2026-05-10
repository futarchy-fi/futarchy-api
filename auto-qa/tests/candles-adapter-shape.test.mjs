/**
 * candles-adapter mode-dispatch + Checkpoint normalization spec mirror (auto-qa).
 *
 * Pins src/adapters/candles-adapter.js — beyond the proxyCandlesQuery
 * rewriter (covered in proxy-candles-rewriter.test.mjs), this file
 * pins the SIX OTHER concerns in the adapter:
 *
 *   1. Public-API mode dispatch — fetchPoolsForProposal, fetchCandles,
 *      getLatestPrice all dispatch on IS_CHECKPOINT to either the
 *      graphNode_* or checkpoint_* internal. A regression that always
 *      picks one corrupts the other mode silently.
 *
 *   2. Checkpoint volume normalization — pool volumes come back in raw
 *      wei (1e18-scaled). The adapter divides by 1e18 to give
 *      human-readable. A regression that drops the division silently
 *      inflates every volume by 18 decimal places.
 *
 *   3. isInverted-driven role assignment — Checkpoint returns
 *      token0/token1 as flat addresses. Roles are assigned from
 *      isInverted:
 *        Default:  token0 = COMPANY, token1 = CURRENCY
 *        Inverted: token0 = CURRENCY, token1 = COMPANY
 *      Critical: market-events.js uses role to pick which side carries
 *      currency volume. Inversion bug = wrong volume side → wrong USD.
 *
 *   4. Pool ID + proposal ID stripping — Checkpoint stores chain-
 *      prefixed IDs ("100-0xabc..."); the adapter normalizes to bare
 *      addresses for downstream uniformity with Graph Node shape.
 *
 *   5. Period TYPE divergence between modes — Graph Node sends
 *      period: "3600" (BigInt as string); Checkpoint sends period: 3600
 *      (Int). Schema mismatch silently fails query validation.
 *
 *   6. Time-filter divergence — Graph Node filters via
 *      periodStartUnix_gte/_lte; Checkpoint filters via time_gte/_lte.
 *      Different fields! (Checkpoint exposes both — only the FILTER
 *      uses time; the response uses periodStartUnix per PR #9.)
 *
 * The pure shape concerns are pinned via source-text + spec mirror
 * of the wei→human + role-from-inversion functions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/adapters/candles-adapter.js', import.meta.url),
    'utf8',
);

// --- spec mirror of the Checkpoint volume normalization ---
function normalizeVolume(rawWei) {
    return rawWei
        ? String(parseFloat(rawWei) / 1e18)
        : '0';
}

// --- spec mirror of the isInverted-driven role assignment ---
function inferTokenRoles(isInverted) {
    return {
        token0Role: isInverted ? 'CURRENCY' : 'COMPANY',
        token1Role: isInverted ? 'COMPANY'  : 'CURRENCY',
    };
}

// ---------------------------------------------------------------------------
// Public-API mode dispatch
// ---------------------------------------------------------------------------

test('source — fetchPoolsForProposal dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /export async function fetchPoolsForProposal\(proposalAddress,\s*chainId\s*=\s*100\)\s*\{[\s\S]*?return\s+IS_CHECKPOINT[\s\S]*?\?\s*checkpoint_fetchPools\(proposalAddress,\s*chainId\)[\s\S]*?:\s*graphNode_fetchPools\(proposalAddress\)/,
        `fetchPoolsForProposal mode-dispatch shape drifted`);
});

test('source — fetchCandles dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /export async function fetchCandles\(poolId,\s*minTimestamp,\s*maxTimestamp,\s*chainId\s*=\s*100\)\s*\{[\s\S]*?return\s+IS_CHECKPOINT[\s\S]*?\?\s*checkpoint_fetchCandles\(poolId,\s*minTimestamp,\s*maxTimestamp,\s*chainId\)[\s\S]*?:\s*graphNode_fetchCandles\(poolId,\s*minTimestamp,\s*maxTimestamp\)/,
        `fetchCandles mode-dispatch shape drifted`);
});

test('source — getLatestPrice dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /export async function getLatestPrice\(poolId,\s*maxTimestamp\s*=\s*null,\s*chainId\s*=\s*100\)\s*\{[\s\S]*?return\s+IS_CHECKPOINT[\s\S]*?\?\s*checkpoint_getLatestPrice\(poolId,\s*maxTimestamp,\s*chainId\)[\s\S]*?:\s*graphNode_getLatestPrice\(poolId,\s*maxTimestamp\)/,
        `getLatestPrice mode-dispatch shape drifted`);
});

test('source — all three public functions default chainId to 100 (Gnosis)', () => {
    // Pinned: drift to 1 silently routes Gnosis pool queries to wrong
    // chain → empty results.
    assert.match(SRC, /export async function fetchPoolsForProposal\(proposalAddress,\s*chainId\s*=\s*100\)/);
    assert.match(SRC, /export async function fetchCandles\(poolId,\s*minTimestamp,\s*maxTimestamp,\s*chainId\s*=\s*100\)/);
    assert.match(SRC, /export async function getLatestPrice\(poolId,\s*maxTimestamp\s*=\s*null,\s*chainId\s*=\s*100\)/);
});

// ---------------------------------------------------------------------------
// Checkpoint volume normalization — wei → human (divide by 1e18)
// ---------------------------------------------------------------------------

test('volume normalization — 1e18 wei → "1" (one whole token)', () => {
    assert.equal(normalizeVolume('1000000000000000000'), '1');
});

test('volume normalization — 0 wei → "0" (string, not number)', () => {
    assert.equal(normalizeVolume('0'), '0',
        `wei "0" must produce string "0" — caller may .toString() it again`);
});

test('volume normalization — null/undefined wei → "0" (sentinel)', () => {
    // Pinned: undefined volumeToken0 from Checkpoint should produce "0",
    // NOT crash on parseFloat(undefined) which yields NaN.
    assert.equal(normalizeVolume(null), '0');
    assert.equal(normalizeVolume(undefined), '0');
    assert.equal(normalizeVolume(''), '0');
});

test('volume normalization — fractional wei → human decimal string', () => {
    assert.equal(normalizeVolume('500000000000000000'), '0.5',
        `0.5 ETH worth of wei must normalize to "0.5"`);
});

test('source — checkpoint_fetchPools normalizes both volumeToken0 AND volumeToken1', () => {
    // Pinned: a regression that fixes only one side (most likely
    // copy-paste) silently leaves one side wei-scaled — tile shows
    // 1e18× volume.
    const matches = [...SRC.matchAll(/parseFloat\(pool\.volumeToken[01]\)\s*\/\s*1e18/g)];
    assert.equal(matches.length, 2,
        `expected exactly 2 wei→human normalizations (volumeToken0 + volumeToken1); got ${matches.length}`);
});

test('source — volume normalization wraps in String() (pool-shape uniformity)', () => {
    // Pinned: subgraph emits volume as string; we keep it as string.
    // A regression that drops String() returns Number — breaks
    // consumers expecting string interface.
    assert.match(SRC,
        /String\(parseFloat\(pool\.volumeToken0\)\s*\/\s*1e18\)/,
        `volumeToken0 normalization must wrap in String()`);
    assert.match(SRC,
        /String\(parseFloat\(pool\.volumeToken1\)\s*\/\s*1e18\)/,
        `volumeToken1 normalization must wrap in String()`);
});

// ---------------------------------------------------------------------------
// isInverted-driven role assignment (CRITICAL for currency-side detection)
// ---------------------------------------------------------------------------

test('inferTokenRoles — DEFAULT (not inverted): token0=COMPANY, token1=CURRENCY', () => {
    const r = inferTokenRoles(false);
    assert.equal(r.token0Role, 'COMPANY');
    assert.equal(r.token1Role, 'CURRENCY');
});

test('inferTokenRoles — INVERTED: token0=CURRENCY, token1=COMPANY (swapped)', () => {
    // Pinned: this is the critical invariant. market-events.js looks
    // for `role.includes("CURRENCY")` to pick the volume side. If
    // inversion silently flips, currency volume comes from company
    // side → wrong USD volume by orders of magnitude.
    const r = inferTokenRoles(true);
    assert.equal(r.token0Role, 'CURRENCY');
    assert.equal(r.token1Role, 'COMPANY');
});

test('source — token0 role = isInverted ? CURRENCY : COMPANY', () => {
    assert.match(SRC,
        /token0:\s*typeof pool\.token0\s*===\s*['"]string['"]\s*\?[\s\S]*?role:\s*pool\.isInverted\s*\?\s*['"]CURRENCY['"]\s*:\s*['"]COMPANY['"]/,
        `token0 role-assignment ternary drifted from isInverted ? CURRENCY : COMPANY`);
});

test('source — token1 role = isInverted ? COMPANY : CURRENCY (swap of token0)', () => {
    // Pinned: token1 role MUST be the swap of token0's role. A
    // regression that uses the same ternary for both would assign
    // CURRENCY to both sides on inverted pools — the currency-side
    // detection in market-events.js then matches BOTH and the OR
    // fallback logic never fires.
    assert.match(SRC,
        /token1:\s*typeof pool\.token1\s*===\s*['"]string['"]\s*\?[\s\S]*?role:\s*pool\.isInverted\s*\?\s*['"]COMPANY['"]\s*:\s*['"]CURRENCY['"]/,
        `token1 role-assignment ternary drifted from isInverted ? COMPANY : CURRENCY`);
});

test('source — preserves token0/token1 if NOT a string (Graph Node nested-object shape)', () => {
    // Pinned: when token0/token1 are already objects (e.g. mocked test
    // input or Graph-Node-style data passed through), don't overwrite.
    // The ternary checks `typeof pool.token0 === 'string'`.
    assert.match(SRC,
        /typeof pool\.token0\s*===\s*['"]string['"]\s*\?\s*\{[^}]*\}\s*:\s*pool\.token0/,
        `token0 must be passed through unchanged when it is already an object`);
});

// ---------------------------------------------------------------------------
// Pool ID + proposal ID stripping (chain prefix removal)
// ---------------------------------------------------------------------------

test('source — checkpoint_fetchPools strips chain prefix from pool.id', () => {
    // Pinned: downstream code (market-events, frontend) expects bare
    // addresses. Failing to strip would surface "100-0xabc..." in
    // every link / display.
    assert.match(SRC,
        /id:\s*stripChainPrefix\(pool\.id\)/,
        `checkpoint_fetchPools must strip chain prefix from pool.id`);
});

test('source — checkpoint_fetchPools strips chain prefix from proposal id (when string)', () => {
    // Pinned: when proposal arrives as a string (Checkpoint shape), the
    // synthesized object's id must be stripped too.
    assert.match(SRC,
        /typeof pool\.proposal\s*===\s*['"]string['"]\s*\?\s*\{\s*id:\s*stripChainPrefix\(pool\.proposal\)/,
        `proposal id stripping shape drifted`);
});

test('source — synthesized proposal stub has 4 fields: id + 3 nulls (Graph Node shape parity)', () => {
    // Pinned: { id, marketName: null, companyToken: null, currencyToken: null }.
    // This shape lets downstream code that destructures Graph Node
    // proposals continue working without null-checks — the keys exist
    // even if the values are null.
    assert.match(SRC,
        /\{\s*id:\s*stripChainPrefix\(pool\.proposal\),\s*marketName:\s*null,\s*companyToken:\s*null,\s*currencyToken:\s*null\s*\}/,
        `synthesized proposal stub shape drifted from {id, marketName: null, companyToken: null, currencyToken: null}`);
});

// ---------------------------------------------------------------------------
// Period TYPE divergence — Graph Node "3600" (BigInt str) vs Checkpoint 3600 (Int)
// ---------------------------------------------------------------------------

test('source — graphNode_fetchCandles uses period: "3600" (BigInt as string, QUOTED)', () => {
    // Pinned: Graph Node BigInt scalar is JSON-encoded as quoted string.
    // A regression to bare 3600 would fail Graph Node validation.
    assert.match(SRC,
        /graphNode_fetchCandles\([\s\S]*?period:\s*"3600"/,
        `graphNode_fetchCandles period type drifted — must be QUOTED "3600" for BigInt scalar`);
});

test('source — checkpoint_fetchCandles uses period: 3600 (Int, UNQUOTED)', () => {
    // Pinned: Checkpoint Int scalar is bare number. A regression to
    // "3600" would fail Checkpoint validation.
    assert.match(SRC,
        /checkpoint_fetchCandles\([\s\S]*?period:\s*3600(?!")/,
        `checkpoint_fetchCandles period type drifted — must be UNQUOTED 3600 for Int scalar`);
});

test('source — graphNode_getLatestPrice ALSO uses period: "3600" (BigInt str)', () => {
    // Pinned: both Graph Node candle queries (fetchCandles + getLatestPrice)
    // must agree on the period type.
    assert.match(SRC,
        /graphNode_getLatestPrice\([\s\S]*?period:\s*"3600"/,
        `graphNode_getLatestPrice period type drifted from "3600"`);
});

test('source — checkpoint_getLatestPrice ALSO uses period: 3600 (Int)', () => {
    assert.match(SRC,
        /checkpoint_getLatestPrice\([\s\S]*?period:\s*3600(?!")/,
        `checkpoint_getLatestPrice period type drifted from 3600`);
});

// ---------------------------------------------------------------------------
// Time-filter divergence — periodStartUnix_gte/_lte vs time_gte/_lte
// ---------------------------------------------------------------------------

test('source — graphNode_fetchCandles filters via periodStartUnix_gte/_lte (QUOTED BigInt)', () => {
    assert.match(SRC,
        /graphNode_fetchCandles[\s\S]*?periodStartUnix_gte:\s*"\$\{minTimestamp\}"[\s\S]*?periodStartUnix_lte:\s*"\$\{maxTimestamp\}"/,
        `graphNode_fetchCandles time-filter shape drifted (must use periodStartUnix_gte/_lte, QUOTED for BigInt)`);
});

test('source — checkpoint_fetchCandles filters via time_gte/_lte (UNQUOTED Int)', () => {
    // Pinned: Checkpoint uses `time` for the filter (raw timestamp),
    // but the RESPONSE selects `periodStartUnix` (period-snapped).
    // This is the PR #9 invariant — they're DISTINCT fields. A
    // regression to filter on periodStartUnix_gte (Graph-Node style)
    // would fail Checkpoint validation.
    assert.match(SRC,
        /checkpoint_fetchCandles[\s\S]*?time_gte:\s*\$\{minTimestamp\}[\s\S]*?time_lte:\s*\$\{maxTimestamp\}/,
        `checkpoint_fetchCandles time-filter shape drifted (must use time_gte/_lte, UNQUOTED Int)`);
});

test('source — checkpoint_fetchCandles RESPONSE selects periodStartUnix (NOT time)', () => {
    // Pinned PR #9 invariant on the response side. The frontend expects
    // periodStartUnix; the filter side uses time.
    assert.match(SRC,
        /checkpoint_fetchCandles[\s\S]*?candles\([\s\S]*?\)\s*\{\s*periodStartUnix\s+close\s*\}/,
        `checkpoint_fetchCandles response field drifted — MUST select periodStartUnix (PR #9 invariant: callers expect period-snapped boundary, not raw last-swap time)`);
});

test('source — checkpoint_fetchCandles orderBy: time (NOT periodStartUnix)', () => {
    // Pinned: the orderBy uses time (Checkpoint sorts on the raw
    // timestamp). Response then carries periodStartUnix, but order
    // is determined by time.
    assert.match(SRC,
        /checkpoint_fetchCandles[\s\S]*?orderBy:\s*time[\s\S]*?orderDirection:\s*asc/,
        `checkpoint_fetchCandles must orderBy: time (asc) — drift surfaces as out-of-order candles`);
});

test('source — checkpoint_fetchCandles normalizes periodStartUnix to STRING in response map', () => {
    // Pinned: the map step does String(c.periodStartUnix) — Checkpoint
    // returns Int, but downstream expects string (consistent with
    // Graph Node BigInt-as-string).
    assert.match(SRC,
        /periodStartUnix:\s*String\(c\.periodStartUnix\)/,
        `checkpoint_fetchCandles must String() periodStartUnix in response map`);
});

// ---------------------------------------------------------------------------
// Pagination cap — first: 1000 in fetchCandles
// ---------------------------------------------------------------------------

test('source — both fetchCandles backends cap at first: 1000 candles', () => {
    // Pinned: 1000 hourly candles ≈ 41.6 days. A regression to a smaller
    // cap silently truncates chart history.
    const matches = [...SRC.matchAll(/first:\s*1000/g)];
    assert.equal(matches.length, 2,
        `expected first: 1000 cap in BOTH graphNode_fetchCandles + checkpoint_fetchCandles; got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// gqlFetch helper — error semantic + body shape
// ---------------------------------------------------------------------------

test('source — gqlFetch throws on data.errors[0].message (NOT silent return)', () => {
    // Pinned: silent error swallowing is the default failure mode for
    // GraphQL clients. The throw forces callers to handle errors.
    assert.match(SRC,
        /if\s*\(json\.errors\)\s*\{\s*throw\s+new\s+Error\(`GraphQL:\s*\$\{json\.errors\[0\]\.message\}`\)/,
        `gqlFetch must throw on json.errors (silent return would mask validation errors)`);
});

test('source — gqlFetch returns json.data (NOT the full response)', () => {
    // Pinned: callers do `await gqlFetch(...)` then `data?.pools`.
    // A regression that returns json (not json.data) would surface
    // as null-deref everywhere downstream.
    assert.match(SRC,
        /return\s+json\.data\s*;?\s*\}/,
        `gqlFetch must return json.data (not full json envelope)`);
});

test('source — gqlFetch sends POST + Content-Type: application/json', () => {
    assert.match(SRC,
        /method:\s*['"]POST['"][\s\S]*?headers:\s*\{\s*['"]Content-Type['"]:\s*['"]application\/json['"]/,
        `gqlFetch must POST with Content-Type: application/json`);
});

test('source — gqlFetch passes variables in body (default {})', () => {
    // Pinned the default {} for variables — a regression to
    // undefined would JSON-encode as no `variables` key, which some
    // strict GraphQL servers reject.
    assert.match(SRC,
        /async function gqlFetch\(url,\s*query,\s*variables\s*=\s*\{\}\)/,
        `gqlFetch variables default drifted from {}`);
});
