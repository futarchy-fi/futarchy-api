/**
 * Rate-provider config spec mirror (auto-qa).
 *
 * Pins the configuration constants in src/services/rate-provider.js:
 *
 *   GET_RATE_SELECTOR  ABI selector for getRate() (ERC-4626)
 *   CHAIN_CONFIG       per-chain RPC URL + default rate provider
 *   CACHE_DURATION     5-minute TTL on rate lookups
 *
 * The selector is `keccak256("getRate()")[:4]` = 0x679aefce. If this
 * value drifts, the eth_call returns nothing (or worse, calls a
 * collidingfunction on the rate provider contract). Either way the
 * try/catch silently returns 1 — no on-screen error, just a wrong
 * conversion rate every time.
 *
 * The sDAI rate provider address (0x89C80A4540A00b5270347E02e2E144c71da2EceD)
 * is canonical — it's deployed on Gnosis and shared across multiple
 * dapps. A typo here breaks every sDAI conversion.
 *
 * Spec mirrors the config via source-text regex (the file imports
 * nothing testable as values — everything is module-internal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/rate-provider.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// GET_RATE_SELECTOR — ERC-4626 standard
// ---------------------------------------------------------------------------

test('rate-provider — GET_RATE_SELECTOR is exactly 0x679aefce (keccak256("getRate()")[:4])', () => {
    const m = SRC.match(/GET_RATE_SELECTOR\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'GET_RATE_SELECTOR not found');
    assert.equal(m[1], '0x679aefce',
        `GET_RATE_SELECTOR drifted from 0x679aefce. ` +
        `This is keccak256("getRate()")[:4] — if it changes, every rate lookup ` +
        `silently returns 1 (the try/catch fallback) and all sDAI conversions break.`);
});

test('rate-provider — GET_RATE_SELECTOR is referenced in the eth_call payload', () => {
    // Sanity: a refactor that defines the constant but stops using it.
    assert.match(SRC, /to:\s*providerAddress,\s*data:\s*GET_RATE_SELECTOR/,
        `eth_call payload no longer uses GET_RATE_SELECTOR`);
});

// ---------------------------------------------------------------------------
// CHAIN_CONFIG — per-chain entries
// ---------------------------------------------------------------------------

test('rate-provider — CHAIN_CONFIG has chain 1 (Ethereum)', () => {
    assert.match(SRC, /1\s*:\s*\{[^}]*name:\s*['"]Ethereum['"]/,
        `CHAIN_CONFIG[1] missing or name not "Ethereum"`);
});

test('rate-provider — CHAIN_CONFIG has chain 100 (Gnosis)', () => {
    assert.match(SRC, /100\s*:\s*\{[^}]*name:\s*['"]Gnosis['"]/,
        `CHAIN_CONFIG[100] missing or name not "Gnosis"`);
});

test('rate-provider — CHAIN_CONFIG[100].defaultRateProvider is canonical sDAI on Gnosis', () => {
    // The sDAI rate provider address is well-known and shared across dapps.
    // A typo here breaks every sDAI conversion silently.
    const m = SRC.match(/100\s*:\s*\{[^}]*defaultRateProvider:\s*['"]([^'"]+)['"]/);
    assert.ok(m, `CHAIN_CONFIG[100].defaultRateProvider not found`);
    assert.equal(m[1], '0x89C80A4540A00b5270347E02e2E144c71da2EceD',
        `CHAIN_CONFIG[100].defaultRateProvider drifted from canonical sDAI Gnosis address`);
});

test('rate-provider — CHAIN_CONFIG[1].defaultRateProvider is null (no Ethereum default yet)', () => {
    // Pinned current state. If we add an Ethereum sDAI/sUSDe/etc., this
    // surfaces as a deliberate config addition.
    const m = SRC.match(/1\s*:\s*\{[^}]*defaultRateProvider:\s*(null|['"][^'"]+['"])/);
    assert.ok(m, `CHAIN_CONFIG[1].defaultRateProvider not found`);
    assert.equal(m[1], 'null',
        `CHAIN_CONFIG[1].defaultRateProvider is no longer null — was ${m[1]}. ` +
        `If we added an Ethereum default, update this test.`);
});

// ---------------------------------------------------------------------------
// CACHE_DURATION
// ---------------------------------------------------------------------------

test('rate-provider — CACHE_DURATION is 5 * 60 * 1000 ms (5 min)', () => {
    // Rate updates rarely — sDAI rate is set per-day or so. 5min is the
    // sweet spot between freshness and RPC load.
    assert.match(SRC, /CACHE_DURATION\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
        `CACHE_DURATION drifted from 5 * 60 * 1000 (5 min)`);
});

// ---------------------------------------------------------------------------
// Failure mode — returns 1 (no-conversion fallback) on any error
// ---------------------------------------------------------------------------

test('rate-provider — getRate returns 1 on unknown chainId (no-conversion fallback)', () => {
    // Pin the fallback values: any failure path should return 1, NOT
    // throw, NOT return null. Returning 1 means "no conversion applied".
    // A regression that throws would crash request handlers.
    assert.match(SRC, /if\s*\(!chain\)\s*\{[\s\S]*?return\s+1\s*;?/,
        `unknown-chain branch must return 1 as no-conversion fallback`);
});

test('rate-provider — getRate returns 1 when providerAddress is missing', () => {
    assert.match(SRC, /if\s*\(!providerAddress\)\s*\{[\s\S]*?return\s+1\s*;?/,
        `missing providerAddress branch must return 1 as no-conversion fallback`);
});

test('rate-provider — getRate returns 1 in the catch block', () => {
    assert.match(SRC, /catch\s*\([^)]*\)\s*\{[\s\S]*?return\s+1\s*;?/,
        `catch block must return 1 as no-conversion fallback`);
});

test('rate-provider — getRate returns 1 when RPC returns an error field', () => {
    assert.match(SRC, /if\s*\(error\)\s*\{[\s\S]*?return\s+1\s*;?/,
        `RPC-error branch must return 1 as no-conversion fallback`);
});

// ---------------------------------------------------------------------------
// 18-decimal scaling
// ---------------------------------------------------------------------------

test('rate-provider — uses 18-decimal scaling (Number(rateBigInt) / 1e18)', () => {
    // sDAI rate provider returns the rate scaled by 1e18 (standard
    // ERC-4626 convention). A regression that uses a different divisor
    // (e.g. 1e6 for USDC) would scale every rate by 1e12 — TVL dashboards
    // would suddenly show absurd numbers.
    assert.match(SRC, /Number\(rateBigInt\)\s*\/\s*1e18/,
        `18-decimal scaling drifted — must be Number(rateBigInt) / 1e18`);
});
