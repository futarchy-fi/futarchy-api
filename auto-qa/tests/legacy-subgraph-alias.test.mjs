/**
 * Legacy subgraph alias smoke test (auto-qa).
 *
 * Pins POST /subgraphs/name/algebra-proposal-candles-v1 — a backward-
 * compat shim that proxies to the same upstream as /candles/graphql
 * but ALSO injects `spotCandles: []` into the response data block.
 *
 * Older clients (the Snapshot widget at snapshot-labs/sx-monorepo, and
 * pre-Cloud-Run integrations) hardcoded this URL pattern. Removing it
 * would silently 404 those callers — same class of bug as PR #1
 * (`/charts` prefix lost). Not tied to a single PR, but defensive.
 *
 * Pinned invariants:
 *   - POST returns 200 + GraphQL envelope
 *   - GET returns 4xx (POST-only)
 *   - Response data block always includes `spotCandles` key (the shim
 *     injects it even when the query doesn't ask for it)
 *   - Real `candles(...)` queries return data with the same shape as
 *     `/candles/graphql` (no functional drift between the two routes)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const LEGACY   = '/subgraphs/name/algebra-proposal-candles-v1';
const MODERN   = '/candles/graphql';

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function gqlPost(path, query) {
    const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, body: await r.json() };
}

test('legacy alias — POST { __typename } returns 200 + Query', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await gqlPost(LEGACY, '{ __typename }');
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.equal(body?.data?.__typename, 'Query',
        `expected data.__typename === "Query", got ${JSON.stringify(body).slice(0, 200)}`);
});

test('legacy alias — GET is rejected (POST-only surface)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const r = await fetch(`${API_BASE}${LEGACY}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
    });
    assert.notEqual(r.status, 200,
        `GET on legacy subgraph alias should not return 200; got ${r.status}`);
    assert.ok(r.status < 500,
        `GET should be rejected cleanly, not 5xx; got ${r.status}`);
});

test('legacy alias — response data ALWAYS includes spotCandles key (shim invariant)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // The legacy route's identifying behavior: it injects spotCandles
    // into the response even when the query doesn't ask for it. Older
    // clients branch on this key's presence. If the shim drops the
    // injection, those clients break silently.
    const { body } = await gqlPost(LEGACY, '{ __typename }');
    assert.ok('spotCandles' in (body?.data || {}),
        `legacy alias must inject spotCandles into data; got keys [${Object.keys(body?.data || {}).join(', ')}]`);
});

test('legacy alias — modern /candles/graphql does NOT inject spotCandles', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // Negative confirmation: the spotCandles injection is unique to the
    // legacy route. If both routes start injecting, or both stop, the
    // routes have drifted from their distinct contracts.
    const { body } = await gqlPost(MODERN, '{ __typename }');
    assert.ok(!('spotCandles' in (body?.data || {})),
        `modern /candles/graphql must NOT inject spotCandles (that's the legacy alias's job); ` +
        `got keys [${Object.keys(body?.data || {}).join(', ')}]`);
});

test('legacy alias — real candles query returns data matching /candles/graphql', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const query = '{ candles(first: 3) { id close periodStartUnix } }';
    const [legacy, modern] = await Promise.all([
        gqlPost(LEGACY, query),
        gqlPost(MODERN, query),
    ]);
    assert.equal(legacy.status, 200);
    assert.equal(modern.status, 200);
    assert.ok(Array.isArray(legacy.body?.data?.candles),
        `legacy candles array missing; got ${JSON.stringify(legacy.body).slice(0, 200)}`);
    assert.ok(Array.isArray(modern.body?.data?.candles),
        `modern candles array missing; got ${JSON.stringify(modern.body).slice(0, 200)}`);
    assert.equal(legacy.body.data.candles.length, modern.body.data.candles.length,
        `legacy and modern returned different candle counts (${legacy.body.data.candles.length} vs ${modern.body.data.candles.length}) ` +
        `for the same query — routes have drifted`);

    // The candle shape itself must match per-row.
    if (legacy.body.data.candles.length > 0) {
        const lk = Object.keys(legacy.body.data.candles[0]).sort();
        const mk = Object.keys(modern.body.data.candles[0]).sort();
        assert.deepEqual(lk, mk, `candle field shape drifted: legacy=${lk}, modern=${mk}`);
    }
});

test('legacy alias — malformed query yields errors[] envelope', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await gqlPost(LEGACY, 'NOT_VALID_GRAPHQL');
    assert.ok(Array.isArray(body?.errors) && body.errors.length > 0,
        `expected errors[] in response body, got ${JSON.stringify(body).slice(0, 200)}`);
    assert.ok(typeof body.errors[0]?.message === 'string',
        `errors[0].message must be a string`);
});
