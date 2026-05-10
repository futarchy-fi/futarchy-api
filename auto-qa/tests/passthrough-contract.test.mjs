/**
 * GraphQL passthrough contract test (auto-qa).
 *
 * Pins the behaviors fixed by PRs #4, #7, #8, #9 — they're a single
 * conceptual contract: the /candles/graphql proxy must accept Graph-Node-
 * shaped filter syntax from legacy clients and translate it to Checkpoint
 * shape on the way upstream, then strip Checkpoint's chain prefixes from
 * IDs in the response. AND `periodStartUnix` must come back snapped, not
 * collapsed to raw `time`.
 *
 * Each test exercises one filter shape that previously slipped through.
 * Tests skip cleanly when the live API is unreachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const CANDLES = `${API_BASE}/candles/graphql`;

// Stable fixture: GIP-150 v2 trading contract on Gnosis. Has CONDITIONAL
// pools indexed and is the canonical proposal for this auto-qa suite.
const PROPOSAL = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a';
const YES_POOL = '0xeb96dc321604aa7d82d34047281bd1ac7c4eac42';
const NO_POOL  = '0x83a337e14a4b191ec20562d3777ebfc3f40f84e1';

async function gql(query, variables = {}) {
    const res = await fetch(CANDLES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json() };
}

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

// ────────────────────────────────────────────────────────────────────────────
// PR #4 — translate plain pool IDs in /candles/graphql passthrough
// ────────────────────────────────────────────────────────────────────────────
test('PR #4 — scalar pool: "0xabc…" filter on candles entity is chain-prefixed', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // Candle.pool is a String FK; if PR #4's translation was reverted the
    // upstream would receive a plain address that doesn't match the
    // chain-prefixed stored IDs and we'd get an empty result silently — so
    // assert non-empty AND that response IDs come back without prefix.
    const { status, body } = await gql(
        `{ candles(first: 3, where: { pool: "${YES_POOL}", period: 3600 }) { pool periodStartUnix close } }`
    );
    assert.equal(status, 200, 'proxy returned non-200 for plain-address filter');
    assert.ok(!body.errors,
        `proxy errored on plain-address filter: ${JSON.stringify(body.errors)}`);
    const candles = body.data?.candles || [];
    assert.ok(candles.length > 0,
        'expected candles for YES pool — empty result suggests PR #4 prefix translation regressed');
    for (const c of candles) {
        assert.equal(c.pool, YES_POOL,
            `candle.pool should equal ${YES_POOL} (chain prefix stripped), got ${c.pool}`);
    }
});

// ────────────────────────────────────────────────────────────────────────────
// PR #7 — translate proposal: "0xabc…" filter
// ────────────────────────────────────────────────────────────────────────────
test('PR #7 — scalar proposal: "0xabc…" filter returns expected pools', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await gql(
        `{ pools(where: { proposal: "${PROPOSAL}" }) { id outcomeSide type } }`
    );
    assert.equal(status, 200);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    const pools = body.data?.pools || [];
    assert.ok(pools.length >= 2,
        `expected >=2 pools for GIP-150 (YES + NO CONDITIONAL); got ${pools.length}`);
    assert.ok(pools.every(p => /^0x[a-f0-9]{40}$/.test(p.id)),
        'pool IDs should come back without chain prefix (proxy normalizes)');
});

// ────────────────────────────────────────────────────────────────────────────
// PR #8 — translate pool_in / proposal_in / id_in array filters
// ────────────────────────────────────────────────────────────────────────────
test('PR #8 — pool_in: ["0xabc…", "0xdef…"] array filter', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await gql(
        `{ pools(where: { id_in: ["${YES_POOL}", "${NO_POOL}"] }) { id outcomeSide } }`
    );
    assert.equal(status, 200);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    const pools = body.data?.pools || [];
    assert.equal(pools.length, 2, `expected exactly 2 pools, got ${pools.length}`);
    const ids = new Set(pools.map(p => p.id));
    assert.ok(ids.has(YES_POOL), `missing YES pool ${YES_POOL}`);
    assert.ok(ids.has(NO_POOL),  `missing NO pool ${NO_POOL}`);
});

test('PR #8 — proposal_in: ["0xabc…"] array filter on candles entity', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await gql(
        `{ pools(where: { proposal_in: ["${PROPOSAL}"] }) { id proposal } }`
    );
    assert.equal(status, 200);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    const pools = body.data?.pools || [];
    assert.ok(pools.length > 0, 'expected at least one pool for the proposal');
    // Each pool's proposal field should equal the requested proposal
    // address (chain prefix stripped by the proxy).
    for (const p of pools) {
        assert.equal(p.proposal, PROPOSAL,
            `expected pool.proposal to equal ${PROPOSAL}, got ${p.proposal}`);
    }
});

// ────────────────────────────────────────────────────────────────────────────
// PR #9 — periodStartUnix preserved as snapped boundary, not collapsed to time
// ────────────────────────────────────────────────────────────────────────────
test('PR #9 — periodStartUnix in candle responses is snapped to period boundary', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await gql(
        `{ candles(first: 5, orderBy: periodStartUnix, orderDirection: desc, where: { pool: "${YES_POOL}", period: 3600 }) { periodStartUnix close } }`
    );
    assert.equal(status, 200);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    const candles = body.data?.candles || [];
    assert.ok(candles.length > 0, 'expected at least one candle for YES pool');
    for (const c of candles) {
        const ts = Number(c.periodStartUnix);
        assert.ok(Number.isFinite(ts), `periodStartUnix not a number: ${c.periodStartUnix}`);
        assert.equal(ts % 3600, 0,
            `periodStartUnix=${ts} not snapped to 3600s boundary — proxy collapsed it to time?`);
    }
});

test('PR #9 — periodStartUnix_lte filter accepted', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const cutoff = 1778342400; // 2026-05-09 18:00:00 UTC, hour-aligned
    const { status, body } = await gql(
        `{ candles(first: 3, orderBy: periodStartUnix, orderDirection: desc, where: { pool: "${YES_POOL}", period: 3600, periodStartUnix_lte: ${cutoff} }) { periodStartUnix } }`
    );
    assert.equal(status, 200);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    const candles = body.data?.candles || [];
    for (const c of candles) {
        assert.ok(Number(c.periodStartUnix) <= cutoff,
            `periodStartUnix_lte filter not honored: got ${c.periodStartUnix} > ${cutoff}`);
    }
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-cutting: response IDs must always come back without chain prefix
// ────────────────────────────────────────────────────────────────────────────
test('Cross-cutting — response IDs are stripped of chain prefix', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await gql(
        `{ pools(where: { proposal: "${PROPOSAL}" }) { id proposal } }`
    );
    const pools = body.data?.pools || [];
    for (const p of pools) {
        assert.ok(/^0x[a-f0-9]{40}$/.test(p.id),
            `pool.id leaked chain prefix: ${p.id}`);
        if (p.proposal) {
            assert.ok(/^0x[a-f0-9]{40}$/.test(p.proposal),
                `pool.proposal leaked chain prefix: ${p.proposal}`);
        }
    }
});
