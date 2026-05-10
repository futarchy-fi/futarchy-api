/**
 * Multi-proposal smoke test for /api/v2/proposals/:id/chart (auto-qa).
 *
 * Iterates over a small set of diverse proposal fixtures and asserts
 * the endpoint returns a valid contract envelope for each:
 *   - HTTP 200
 *   - JSON body has `market` and `candles` keys
 *   - market.event_id matches the requested address
 *   - conditional_yes / conditional_no have the expected nested fields
 *     (pool_id, price_usd) — values may be null but keys must exist
 *
 * Doesn't assert data quality (price > 0, candles non-empty) — that's
 * the unified-chart.test.mjs's job for the canonical fixture. This is
 * a CONTRACT smoke test: any of the 3 fixtures returning a 5xx, broken
 * JSON, or a missing key surfaces a regression in the endpoint shape
 * that affects the entire fleet of proposals, not just GIP-150.
 *
 * Spot-check insight (recorded for posterity, NOT asserted as bug):
 * As of this iteration, the TSLA-Mega-Package proposal and CIP-82 both
 * return prices = 0 / base="TOKEN" / candles=[] from the live endpoint.
 * That's a real data issue but per /loop directive we document, not
 * fix. See auto-qa/PROGRESS.md for more.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

// Diverse proposal fixtures: each has a different shape (different
// company, currency, lifecycle stage). All must satisfy the contract.
const FIXTURES = [
    {
        addr: '0x1a0f209fa9730a4668ce43ce18982cb0010a972a',
        label: 'GIP-150 v2 (GNO/sDAI, fully indexed)',
        expectedBase: 'GNO',
    },
    {
        addr: '0xf1b12f03aac8992f0e06a4ebe43ec24373936b58',
        label: 'TSLA Mega Package (TSLAon/USDS)',
        // Data quality issues here — endpoint shape must still be valid.
        expectedBase: null,
    },
    {
        addr: '0x9590daf4d5cd4009c3f9767c5e7668175cfd37cf',
        label: 'Circle native USDC on Gnosis',
        expectedBase: null,
    },
];

// Pinned 7-day historical window for reproducibility.
const MIN_TS = 1777737600;
const MAX_TS = 1778342400;

async function fetchChart(addr) {
    const url = `${API_BASE}/api/v2/proposals/${addr}/chart?minTimestamp=${MIN_TS}&maxTimestamp=${MAX_TS}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { status: res.status, body: await res.json() };
}

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

for (const fx of FIXTURES) {
    test(`endpoint contract holds for ${fx.label}`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const { status, body } = await fetchChart(fx.addr);

        assert.equal(status, 200,
            `${fx.label}: expected 200, got ${status}`);
        assert.ok(body, `${fx.label}: empty body`);
        assert.ok(body.market, `${fx.label}: missing "market" key`);
        assert.ok(body.candles, `${fx.label}: missing "candles" key`);

        const m = body.market;
        assert.equal(
            (m.event_id || '').toLowerCase(),
            fx.addr.toLowerCase(),
            `${fx.label}: market.event_id mismatch`
        );

        // Conditional shape: keys must exist (values may be null/0).
        assert.ok('conditional_yes' in m, `${fx.label}: missing conditional_yes`);
        assert.ok('conditional_no'  in m, `${fx.label}: missing conditional_no`);
        for (const side of ['conditional_yes', 'conditional_no']) {
            const slot = m[side] || {};
            assert.ok('price_usd' in slot,
                `${fx.label}: ${side} missing price_usd field`);
            assert.ok('pool_id' in slot,
                `${fx.label}: ${side} missing pool_id field`);
        }

        assert.ok(m.company_tokens, `${fx.label}: missing company_tokens`);
        assert.ok(m.company_tokens.base, `${fx.label}: missing company_tokens.base`);
        const baseSymbol = m.company_tokens.base.tokenSymbol;
        assert.ok(typeof baseSymbol === 'string' && baseSymbol.length > 0,
            `${fx.label}: company_tokens.base.tokenSymbol must be non-empty string, got ${baseSymbol}`);
        // Never the legacy hardcoded fallback.
        assert.notEqual(baseSymbol, 'PNK',
            `${fx.label}: leaked legacy "PNK" fallback`);

        // Candles arrays must exist (may be empty).
        assert.ok(Array.isArray(body.candles.yes), `${fx.label}: candles.yes not array`);
        assert.ok(Array.isArray(body.candles.no),  `${fx.label}: candles.no not array`);

        // Optional: pin the expected base symbol when we know it.
        if (fx.expectedBase) {
            assert.equal(baseSymbol, fx.expectedBase,
                `${fx.label}: expected base symbol "${fx.expectedBase}", got "${baseSymbol}"`);
        }
    });
}
