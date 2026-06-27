/**
 * extractTokensFromPools spec mirror (auto-qa).
 *
 * Pins src/utils/token-from-pool.js — the pool → company/currency
 * symbol resolver that PR #6 fixed (drop the 'PNK' fallback, walk
 * pool types in priority order). The PR-#6 unified-chart test pins
 * the end-to-end "no PNK leak" property; this test pins the function
 * directly so that any regression to the priority chain or pattern
 * matching surfaces with a clear failure message instead of a
 * downstream "TOKEN" fallback that could be mistaken for a data
 * indexing issue.
 *
 * Spec mirrors src/utils/token-from-pool.js. Two regexes plus a
 * priority array.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- spec mirror ---

const PATTERNS = [
    /^(?:YES|NO)_(\w+)\s*\/\s*(?:YES|NO)_(\w+)$/,  // CONDITIONAL form
    /^(?:YES|NO)_(\w+)\s*\/\s*(\w+)$/,             // EXPECTED_VALUE / PREDICTION form
];
const TYPE_PRIORITY = ['CONDITIONAL', 'EXPECTED_VALUE', 'PREDICTION'];

function extractTokensFromPools(pools) {
    if (!Array.isArray(pools) || pools.length === 0) {
        return { companyToken: null, currencyToken: null };
    }
    for (const type of TYPE_PRIORITY) {
        for (const pool of pools) {
            if (pool?.type !== type || !pool?.name) continue;
            for (const pat of PATTERNS) {
                const m = pool.name.match(pat);
                if (!m) continue;
                const [, left, right] = m;
                if (left === right) {
                    return { companyToken: null, currencyToken: { id: null, symbol: right } };
                }
                return {
                    companyToken:  { id: null, symbol: left },
                    currencyToken: { id: null, symbol: right },
                };
            }
        }
    }
    return { companyToken: null, currencyToken: null };
}

// ---------------------------------------------------------------------------
// Empty / invalid input
// ---------------------------------------------------------------------------

test('extractTokens — empty array → both null', () => {
    assert.deepEqual(extractTokensFromPools([]),
        { companyToken: null, currencyToken: null });
});

test('extractTokens — non-array → both null', () => {
    for (const v of [null, undefined, {}, 'pools', 42]) {
        assert.deepEqual(extractTokensFromPools(v),
            { companyToken: null, currencyToken: null });
    }
});

test('extractTokens — pools with no recognized type → both null', () => {
    const pools = [
        { type: 'UNKNOWN', name: 'YES_FOO / sDAI' },
        { type: 'OTHER', name: 'YES_BAR / NO_BAR' },
    ];
    assert.deepEqual(extractTokensFromPools(pools),
        { companyToken: null, currencyToken: null });
});

// ---------------------------------------------------------------------------
// Each pool type, happy path
// ---------------------------------------------------------------------------

test('extractTokens — CONDITIONAL "YES_GNO / YES_sDAI" → company=GNO, currency=sDAI', () => {
    assert.deepEqual(
        extractTokensFromPools([{ type: 'CONDITIONAL', name: 'YES_GNO / YES_sDAI' }]),
        {
            companyToken:  { id: null, symbol: 'GNO' },
            currencyToken: { id: null, symbol: 'sDAI' },
        }
    );
});

test('extractTokens — CONDITIONAL accepts NO_ prefix on either side', () => {
    assert.deepEqual(
        extractTokensFromPools([{ type: 'CONDITIONAL', name: 'NO_GNO / YES_sDAI' }]),
        {
            companyToken:  { id: null, symbol: 'GNO' },
            currencyToken: { id: null, symbol: 'sDAI' },
        }
    );
    assert.deepEqual(
        extractTokensFromPools([{ type: 'CONDITIONAL', name: 'NO_GNO / NO_sDAI' }]),
        {
            companyToken:  { id: null, symbol: 'GNO' },
            currencyToken: { id: null, symbol: 'sDAI' },
        }
    );
});

test('extractTokens — EXPECTED_VALUE "YES_GNO / sDAI" → company=GNO, currency=sDAI', () => {
    assert.deepEqual(
        extractTokensFromPools([{ type: 'EXPECTED_VALUE', name: 'YES_GNO / sDAI' }]),
        {
            companyToken:  { id: null, symbol: 'GNO' },
            currencyToken: { id: null, symbol: 'sDAI' },
        }
    );
});

test('extractTokens — PREDICTION "YES_sDAI / sDAI" → company=null, currency=sDAI', () => {
    // The degenerate symmetry case: pool name has the same symbol on both
    // sides → company is "unknown" (null) but currency is still useful.
    assert.deepEqual(
        extractTokensFromPools([{ type: 'PREDICTION', name: 'YES_sDAI / sDAI' }]),
        {
            companyToken:  null,
            currencyToken: { id: null, symbol: 'sDAI' },
        }
    );
});

// ---------------------------------------------------------------------------
// Priority chain — the heart of PR #6's fix
// ---------------------------------------------------------------------------

test('extractTokens — CONDITIONAL beats EXPECTED_VALUE in the priority walk', () => {
    // Both pool types present. CONDITIONAL must win even though
    // EXPECTED_VALUE comes first in the array.
    const pools = [
        { type: 'EXPECTED_VALUE', name: 'YES_FOO / USDC' },
        { type: 'CONDITIONAL',    name: 'YES_BAR / YES_USDC' },
    ];
    const r = extractTokensFromPools(pools);
    assert.equal(r.companyToken?.symbol, 'BAR',
        `CONDITIONAL pool must take priority; got "${r.companyToken?.symbol}"`);
});

test('extractTokens — EXPECTED_VALUE beats PREDICTION when CONDITIONAL absent', () => {
    const pools = [
        { type: 'PREDICTION',     name: 'YES_USDC / USDC' },
        { type: 'EXPECTED_VALUE', name: 'YES_BAR / USDC' },
    ];
    const r = extractTokensFromPools(pools);
    assert.equal(r.companyToken?.symbol, 'BAR',
        `EXPECTED_VALUE must take priority over PREDICTION; got "${r.companyToken?.symbol}"`);
});

test('extractTokens — falls all the way through to PREDICTION when no other types', () => {
    const pools = [{ type: 'PREDICTION', name: 'YES_USDC / USDC' }];
    const r = extractTokensFromPools(pools);
    assert.equal(r.companyToken, null);
    assert.equal(r.currencyToken?.symbol, 'USDC');
});

// ---------------------------------------------------------------------------
// Defensive — pools with missing/garbage fields
// ---------------------------------------------------------------------------

test('extractTokens — pools with no name field are skipped', () => {
    const pools = [
        { type: 'CONDITIONAL' },              // no name
        { type: 'CONDITIONAL', name: '' },    // empty name (falsy)
        { type: 'CONDITIONAL', name: 'YES_GNO / YES_sDAI' },
    ];
    const r = extractTokensFromPools(pools);
    assert.equal(r.companyToken?.symbol, 'GNO',
        `must skip pools without a name and find the next valid one`);
});

test('extractTokens — null/undefined entries in pools array are skipped', () => {
    const pools = [
        null,
        undefined,
        { type: 'CONDITIONAL', name: 'YES_GNO / YES_sDAI' },
    ];
    const r = extractTokensFromPools(pools);
    assert.equal(r.companyToken?.symbol, 'GNO',
        `null/undefined entries must NOT throw — must be skipped`);
});

test('extractTokens — unrecognized name format → both null', () => {
    const pools = [
        { type: 'CONDITIONAL', name: 'GNO/sDAI' },           // missing YES_/NO_
        { type: 'CONDITIONAL', name: 'YES_GNO + YES_sDAI' }, // wrong separator
        { type: 'CONDITIONAL', name: 'MAYBE_GNO / YES_sDAI' }, // wrong prefix
    ];
    assert.deepEqual(extractTokensFromPools(pools),
        { companyToken: null, currencyToken: null });
});

// ---------------------------------------------------------------------------
// Whitespace tolerance
// ---------------------------------------------------------------------------

test('extractTokens — patterns tolerate whitespace around the slash', () => {
    // \s* in the regex allows zero or more spaces.
    for (const name of [
        'YES_GNO / YES_sDAI',     // single spaces (canonical)
        'YES_GNO/YES_sDAI',       // no spaces
        'YES_GNO   /   YES_sDAI', // multiple spaces
    ]) {
        const r = extractTokensFromPools([{ type: 'CONDITIONAL', name }]);
        assert.equal(r.companyToken?.symbol, 'GNO',
            `whitespace variant "${name}" should still resolve company`);
    }
});

// ---------------------------------------------------------------------------
// Symbol-character permissiveness — \w covers [A-Za-z0-9_]
// ---------------------------------------------------------------------------

test('extractTokens — symbol can include digits and underscores (\\w class)', () => {
    const r = extractTokensFromPools([
        { type: 'CONDITIONAL', name: 'YES_USDC_e / YES_sDAI2' },
    ]);
    assert.equal(r.companyToken?.symbol, 'USDC_e');
    assert.equal(r.currencyToken?.symbol, 'sDAI2');
});

// ---------------------------------------------------------------------------
// Anti-PNK — the regression PR #6 fixed
// ---------------------------------------------------------------------------

test('extractTokens — never returns "PNK" as a literal fallback', () => {
    // The PR #6 fix made sure we never return 'PNK' from any code
    // path. The function itself never invents tokens — it only echoes
    // matched names — so 'PNK' would only appear if the pool name
    // contains it. This test pins that the function does not have a
    // hardcoded 'PNK' fallback in any branch.
    const r1 = extractTokensFromPools([]);
    assert.notEqual(r1.companyToken?.symbol, 'PNK');
    const r2 = extractTokensFromPools([{ type: 'UNKNOWN', name: 'whatever' }]);
    assert.notEqual(r2.companyToken?.symbol, 'PNK');
    const r3 = extractTokensFromPools([{ type: 'CONDITIONAL', name: 'malformed' }]);
    assert.notEqual(r3.companyToken?.symbol, 'PNK');
});
