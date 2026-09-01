/**
 * Legacy v1 prices endpoint test (auto-qa).
 *
 * Pins the contract of GET /api/v1/market-events/proposals/:id/prices.
 * This is the older single-call price endpoint used by some clients
 * (predates /api/v2/.../chart). Wasn't covered by any test before this
 * iteration.
 *
 * Plus a soft response-time bound — both v1 and v2 should respond in
 * well under 5s for a fully-indexed proposal. If they slow down past
 * that, the warmer/cache is misbehaving.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const FIXTURE = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a'; // GIP-150 v2

const RESPONSE_TIME_BOUND_MS = 5000;

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function timed(fn) {
    const t0 = Date.now();
    const result = await fn();
    return { ms: Date.now() - t0, ...result };
}

async function fetchV1() {
    const r = await fetch(
        `${API_BASE}/api/v1/market-events/proposals/${FIXTURE}/prices`,
        { signal: AbortSignal.timeout(15000) }
    );
    return { status: r.status, body: await r.json() };
}

async function fetchV2() {
    const min = 1777737600, max = 1778342400;
    const r = await fetch(
        `${API_BASE}/api/v2/proposals/${FIXTURE}/chart?minTimestamp=${min}&maxTimestamp=${max}`,
        { signal: AbortSignal.timeout(15000) }
    );
    return { status: r.status, body: await r.json() };
}

test('v1 prices endpoint — HTTP 200 with documented envelope', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchV1();
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.equal(body.status, 'ok', `expected status=ok, got ${body.status}`);
    assert.equal(
        (body.event_id || '').toLowerCase(),
        FIXTURE.toLowerCase(),
        'event_id mismatch'
    );
    // Required envelope keys.
    for (const k of ['conditional_yes', 'conditional_no', 'company_tokens', 'timeline', 'volume']) {
        assert.ok(body[k], `v1 response missing top-level key "${k}"`);
    }
});

test('v1 prices — conditional_yes/no have prices and pool_ids for fully-indexed proposal', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchV1();
    for (const side of ['conditional_yes', 'conditional_no']) {
        const slot = body[side] || {};
        assert.ok('price_usd' in slot, `${side} missing price_usd`);
        assert.ok('pool_id' in slot, `${side} missing pool_id`);
        assert.ok(typeof slot.price_usd === 'number' && slot.price_usd > 0,
            `${side}.price_usd should be positive number, got ${slot.price_usd}`);
        assert.ok(/^0x[a-f0-9]{40}$/.test(slot.pool_id || ''),
            `${side}.pool_id should be a plain address`);
    }
});

test('v1 prices — company_tokens.base resolves (not "PNK" fallback)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchV1();
    const base = body.company_tokens?.base?.tokenSymbol;
    assert.ok(typeof base === 'string' && base.length > 0,
        `company_tokens.base.tokenSymbol must be non-empty string, got ${base}`);
    assert.notEqual(base, 'PNK', 'leaked legacy "PNK" fallback');
    assert.equal(base, 'GNO', `expected GNO for GIP-150, got ${base}`);
});

test('v1 vs v2 — overlapping fields agree', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const v1 = await fetchV1();
    const v2 = await fetchV2();
    // Both endpoints serve the same underlying market — base symbol must match.
    assert.equal(
        v1.body.company_tokens?.base?.tokenSymbol,
        v2.body.market?.company_tokens?.base?.tokenSymbol,
        'v1 and v2 disagree on company_tokens.base.tokenSymbol'
    );
    // YES pool ID must match (both should resolve the same CONDITIONAL pool).
    assert.equal(
        v1.body.conditional_yes?.pool_id,
        v2.body.market?.conditional_yes?.pool_id,
        'v1 and v2 disagree on conditional_yes.pool_id'
    );
});

test('response time — v1 endpoint completes in < 5s', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { ms, status } = await timed(fetchV1);
    assert.equal(status, 200);
    assert.ok(ms < RESPONSE_TIME_BOUND_MS,
        `v1 took ${ms}ms (bound: ${RESPONSE_TIME_BOUND_MS}ms). Warmer/cache regression?`);
});

test('response time — v2 endpoint completes in < 5s', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { ms, status } = await timed(fetchV2);
    assert.equal(status, 200);
    assert.ok(ms < RESPONSE_TIME_BOUND_MS,
        `v2 took ${ms}ms (bound: ${RESPONSE_TIME_BOUND_MS}ms). Warmer/cache regression?`);
});
