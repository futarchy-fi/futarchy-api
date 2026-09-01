/**
 * Unified-chart envelope shape test (auto-qa).
 *
 * Pins the type contract of GET /api/v2/proposals/:id/chart's
 * `market` block — type heterogeneity that frontend code branches on:
 *
 *   market.conditional_yes.price_usd  → number      (not string)
 *   market.conditional_no.price_usd   → number
 *   market.volume.conditional_yes.volume     → string  (preserves precision)
 *   market.volume.conditional_yes.volume_usd → string
 *   market.event_id, trading_address  → 0x-prefixed lowercase 42-char address
 *   market.{conditional_yes,no}.pool_id → same shape
 *   market.timeline.start / end       → integer unix timestamps
 *   market.timeline.chain_id          → 100 (Gnosis)
 *   market.company_tokens.base.tokenSymbol → non-empty string
 *
 * The numeric-type heterogeneity is the subtle one: price as `number`
 * preserves nothing, but volume as `string` preserves full precision
 * (the underlying values come from the indexer as 18-decimal strings
 * representing wei/human-unit conversions). A future "normalization"
 * that flips either type breaks the frontend's parsing path.
 *
 * Not tied to a single PR. Defensive against:
 *   - JSON serialization "improvement" that auto-converts strings→numbers
 *   - JSON serialization that auto-quotes numbers
 *   - Address normalization breaking (uppercase leak, missing 0x prefix)
 *   - chain_id changing during a multi-chain refactor without per-call test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const FIXTURE  = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a'; // GIP-150 v2
const WIN      = '?minTimestamp=1777737600&maxTimestamp=1778342400';

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function getChart() {
    const r = await fetch(`${API_BASE}/api/v2/proposals/${FIXTURE}/chart${WIN}`, {
        signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json() };
}

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

// ---------------------------------------------------------------------------
// Type heterogeneity invariants (the subtle ones)
// ---------------------------------------------------------------------------

test('chart envelope — price_usd is a NUMBER (not string)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    for (const side of ['conditional_yes', 'conditional_no']) {
        const slot = body.market?.[side];
        assert.equal(typeof slot.price_usd, 'number',
            `market.${side}.price_usd must be number; got ${typeof slot.price_usd} (${JSON.stringify(slot.price_usd)})`);
        assert.ok(Number.isFinite(slot.price_usd) && slot.price_usd > 0,
            `market.${side}.price_usd must be positive finite; got ${slot.price_usd}`);
    }
});

test('chart envelope — volume + volume_usd are STRINGS (precision preservation)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    for (const side of ['conditional_yes', 'conditional_no']) {
        const v = body.market?.volume?.[side];
        assert.ok(v, `volume.${side} block missing`);
        for (const k of ['volume', 'volume_usd']) {
            assert.equal(typeof v[k], 'string',
                `market.volume.${side}.${k} must be string (preserves precision); got ${typeof v[k]} (${JSON.stringify(v[k])})`);
            const n = Number(v[k]);
            assert.ok(Number.isFinite(n) && n > 0,
                `market.volume.${side}.${k} must parse as positive finite; got "${v[k]}"`);
        }
    }
});

test('chart envelope — volume status is "ok" for healthy fixture', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    for (const side of ['conditional_yes', 'conditional_no']) {
        assert.equal(body.market?.volume?.[side]?.status, 'ok',
            `volume.${side}.status must be "ok" for fully-indexed fixture`);
    }
});

// ---------------------------------------------------------------------------
// Address-shape invariants
// ---------------------------------------------------------------------------

test('chart envelope — event_id is the lowercased fixture address', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    assert.equal(body.market?.event_id, FIXTURE,
        `event_id should equal the requested proposalId`);
});

test('chart envelope — trading_address matches event_id (single-trade-address invariant)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    // Today the trading address equals the proposal address. If they
    // diverge in a refactor, this test surfaces it.
    assert.equal(body.market?.trading_address, body.market?.event_id,
        `trading_address vs event_id drift surfaced — was equal, now different`);
});

test('chart envelope — every pool_id is a lowercase 0x-prefixed 42-char address', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    const ids = [
        body.market?.conditional_yes?.pool_id,
        body.market?.conditional_no?.pool_id,
        body.market?.volume?.conditional_yes?.pool_id,
        body.market?.volume?.conditional_no?.pool_id,
    ];
    for (const id of ids) {
        assert.ok(ADDRESS_RE.test(id),
            `pool_id failed address shape check: ${id}. ` +
            `Expected 0x + 40 lowercase hex chars (chain prefix should already be stripped by proxy).`);
    }
});

test('chart envelope — YES and NO pool_ids are distinct', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    const yes = body.market?.conditional_yes?.pool_id;
    const no  = body.market?.conditional_no?.pool_id;
    assert.notEqual(yes, no,
        `YES and NO pool_ids are identical (${yes}) — pool resolution collapsed both sides to one pool`);
});

// ---------------------------------------------------------------------------
// Timeline + chain
// ---------------------------------------------------------------------------

test('chart envelope — timeline.start and end are integer unix timestamps', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    const tl = body.market?.timeline;
    for (const k of ['start', 'end']) {
        assert.ok(Number.isInteger(tl?.[k]),
            `timeline.${k} must be integer unix; got ${tl?.[k]} (type ${typeof tl?.[k]})`);
        // Sanity: in a sensible decade window (2020 .. 2050).
        assert.ok(tl[k] > 1577836800 && tl[k] < 2524608000,
            `timeline.${k}=${tl[k]} outside sane unix-time range`);
    }
});

test('chart envelope — timeline.start <= timeline.end', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    const tl = body.market?.timeline;
    assert.ok(tl.start <= tl.end,
        `timeline.start (${tl.start}) is after timeline.end (${tl.end})`);
});

test('chart envelope — timeline.chain_id is 100 (Gnosis)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    assert.equal(body.market?.timeline?.chain_id, 100,
        `chain_id must be 100 for Gnosis Chain; got ${body.market?.timeline?.chain_id}`);
});

// ---------------------------------------------------------------------------
// Tokens — non-fallback for healthy fixture
// ---------------------------------------------------------------------------

test('chart envelope — company_tokens.base.tokenSymbol is non-empty and not a fallback', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await getChart();
    const sym = body.market?.company_tokens?.base?.tokenSymbol;
    assert.ok(typeof sym === 'string' && sym.length > 0,
        `tokenSymbol must be non-empty string; got ${JSON.stringify(sym)}`);
    // PR #6 introduced 'TOKEN' as the catch-all when symbol resolution
    // fails. For GIP-150, the real symbol is GNO. If it falls through
    // to the fallback, symbol resolution is broken for our reference
    // fixture (worse than for the broken proposals already documented).
    assert.notEqual(sym, 'TOKEN',
        `tokenSymbol fell back to "TOKEN" for the canonical healthy fixture (GIP-150). ` +
        `Pool-resolution priority chain may have regressed.`);
    assert.notEqual(sym, 'PNK', `legacy "PNK" fallback leaked back in`);
});
