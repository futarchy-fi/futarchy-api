/**
 * Unified-chart endpoint contract test (auto-qa).
 *
 * Pins behaviors fixed by PRs #5 and #6:
 *   PR #5 — endpoints used to assume CONDITIONAL pools always existed;
 *           for new proposals where only PREDICTION/EXPECTED_VALUE pools
 *           are indexed yet, prices came back null. Fix: fall back through
 *           CONDITIONAL > EXPECTED_VALUE > PREDICTION.
 *   PR #6 — token-symbol resolution only inspected CONDITIONAL pools and
 *           had a hardcoded "PNK" fallback. Symptom: wrong ticker shown
 *           on charts for proposals at certain lifecycle stages.
 *
 * Strategy: hit the live `/api/v2/proposals/:id/chart` endpoint for
 * GIP-150 v2 (the canonical fixture) and assert that the assembled
 * response satisfies the documented invariants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

// Stable fixture: GIP-150 v2. Has CONDITIONAL + EXPECTED_VALUE + PREDICTION
// pools all indexed, so it exercises the full pool-type fallback chain.
const FIXTURE = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a';

// Pinned 7-day historical window (Unix seconds) so candle responses are
// reproducible across reruns.
const MIN_TS = 1777737600; // 2026-05-03 00:00:00 UTC
const MAX_TS = 1778342400; // 2026-05-09 18:00:00 UTC

const URL = `${API_BASE}/api/v2/proposals/${FIXTURE}/chart?minTimestamp=${MIN_TS}&maxTimestamp=${MAX_TS}`;

async function fetchChart() {
    const res = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    return { status: res.status, body: await res.json() };
}

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

test('PR #5 — endpoint returns 200 with both YES and NO conditional prices', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart();
    assert.equal(status, 200, `endpoint returned ${status}`);

    const yes = body.market?.conditional_yes;
    const no  = body.market?.conditional_no;
    assert.ok(yes, 'market.conditional_yes missing');
    assert.ok(no,  'market.conditional_no missing');

    // PR #5 invariant: prices are non-null when ANY of the pool types
    // (CONDITIONAL > EXPECTED_VALUE > PREDICTION) has data. GIP-150 has
    // CONDITIONAL pools so we should get the CONDITIONAL price (~111 / ~107).
    assert.ok(typeof yes.price_usd === 'number' && yes.price_usd > 0,
        `conditional_yes.price_usd should be a positive number, got ${yes.price_usd}`);
    assert.ok(typeof no.price_usd === 'number' && no.price_usd > 0,
        `conditional_no.price_usd should be a positive number, got ${no.price_usd}`);

    // Each side should also expose its underlying pool address.
    assert.ok(/^0x[a-f0-9]{40}$/.test(yes.pool_id || ''),
        `conditional_yes.pool_id should be a plain address, got ${yes.pool_id}`);
    assert.ok(/^0x[a-f0-9]{40}$/.test(no.pool_id || ''),
        `conditional_no.pool_id should be a plain address, got ${no.pool_id}`);
});

test('PR #6 — company_tokens are resolved (no "PNK" fallback leak)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart();

    const companyTokens = body.market?.company_tokens;
    assert.ok(companyTokens, 'market.company_tokens missing');

    const baseSymbol = companyTokens.base?.tokenSymbol;
    assert.ok(baseSymbol && typeof baseSymbol === 'string',
        `company_tokens.base.tokenSymbol should be a non-empty string, got ${baseSymbol}`);
    // The PR #6 regression to guard against: PNK was the old hardcoded
    // fallback. GIP-150 is GNO/sDAI — must not show PNK.
    assert.notEqual(baseSymbol, 'PNK',
        'company_tokens.base.tokenSymbol leaked the legacy "PNK" fallback');

    // Strong invariant: GIP-150 specifically should resolve to GNO.
    assert.equal(baseSymbol, 'GNO',
        `expected GIP-150's base token to resolve to "GNO", got "${baseSymbol}"`);

    // Currency may be sDAI or sDAI's stable pair; either should be set.
    const currency = companyTokens.currency || {};
    const currencySymbol = currency.tokenSymbol || currency.stableSymbol;
    assert.ok(currencySymbol,
        `company_tokens.currency should expose tokenSymbol or stableSymbol, got ${JSON.stringify(currency)}`);
});

test('candles arrays are present and non-empty for the fixture window', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart();
    const yes = body.candles?.yes || [];
    const no  = body.candles?.no  || [];
    assert.ok(Array.isArray(yes) && Array.isArray(no),
        'candles.yes and candles.no must be arrays');
    assert.ok(yes.length > 0, `candles.yes empty for ${MIN_TS}..${MAX_TS}`);
    assert.ok(no.length  > 0, `candles.no  empty for ${MIN_TS}..${MAX_TS}`);
    // Each candle must have the snapped timestamp + close pair.
    for (const c of yes.concat(no)) {
        const ts = Number(c.periodStartUnix);
        assert.ok(Number.isFinite(ts), `candle.periodStartUnix not numeric: ${c.periodStartUnix}`);
        assert.equal(ts % 3600, 0, `candle.periodStartUnix ${ts} not snapped to hour`);
        assert.ok(typeof c.close === 'string' && parseFloat(c.close) > 0,
            `candle.close should parse to a positive number, got ${c.close}`);
    }
});

test('volume is reported in human units (not raw wei) for both sides', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart();
    const vol = body.market?.volume || {};

    const yesVol = parseFloat(vol.conditional_yes?.volume || '0');
    const noVol  = parseFloat(vol.conditional_no?.volume  || '0');

    // Sanity: human-unit volumes for GIP-150 are in the low thousands
    // (sDAI). Raw-wei volumes would be 1e18 times larger. If we suddenly
    // see a number >1e15, the unit normalization regressed.
    assert.ok(yesVol >= 0 && yesVol < 1e15,
        `conditional_yes.volume looks like raw wei: ${yesVol}`);
    assert.ok(noVol  >= 0 && noVol  < 1e15,
        `conditional_no.volume looks like raw wei: ${noVol}`);
});
