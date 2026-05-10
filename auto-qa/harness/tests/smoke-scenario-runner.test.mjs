/**
 * smoke-scenario-runner.test.mjs — Phase 7 slice 4d-scenarios.
 *
 * Verifies the orchestrator's two starter invariants
 * (apiHealth + apiCanReachRegistry) against a tiny in-process
 * HTTP fixture that mimics the api's response shape, and that
 * the scenario-runner CLI's dry-run flag works without network.
 *
 * No docker daemon, no live api, no real indexer — pure offline.
 * Exercises the `INVARIANTS` array + `runAllInvariants()` against
 * a node:http server we control.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
    INVARIANTS,
    runAllInvariants,
} from '../orchestrator/invariants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(__dirname, '..', 'orchestrator', 'scenario-runner.mjs');

// ─── tiny api fixture ───────────────────────────────────────────────

function startFixture({
    healthOk = true,
    // Warmer endpoint (slice 4d-scenarios-more apiWarmer): default 200
    // returns a JSON status object; toggle warmerOk to false for 503.
    warmerOk = true,
    warmerContentType = 'application/json',
    // Spot-candles validation (slice 4d-scenarios-more apiSpotCandlesValidates):
    // default returns 400 + JSON {error: 'ticker required'} when ticker
    // missing (matching the api behavior). Toggle to override.
    spotCandlesNoTickerStatus = 400,
    spotCandlesNoTickerBody = JSON.stringify({ error: 'ticker required' }),
    registryTypename = 'Query',
    candlesTypename = 'Query',
    // Direct-indexer probes (slice 4d-scenarios-more) hit /registry-direct/graphql
    // and /candles-direct/graphql so we can distinguish "via api" from
    // "direct" in the same fixture.
    registryDirectTypename = 'Query',
    candlesDirectTypename = 'Query',
    // Data-aware probes — counts of mock entities returned by the
    // direct endpoints. Set to 0 to simulate "indexer reachable but
    // empty for that entity".
    registryProposalEntitiesCount = 1,
    registryOrganizationsCount = 1,
    registryAggregatorsCount = 1,
    candlesPoolsCount = 1,
    candlesSwapsCount = 1,
    candlesCandlesCount = 1,
    // Latest-candle field values for OHLC + volume invariants.
    // Default values satisfy both invariants; override to simulate
    // bugs in the aggregator.
    latestCandleOpen = '0.45',
    latestCandleHigh = '0.50',
    latestCandleLow = '0.40',
    latestCandleClose = '0.48',
    latestCandleVolumeToken0 = '100.0',
    latestCandleVolumeToken1 = '50.0',
    // Latest-swap field values for amounts + timestamp invariants.
    // Default values satisfy both; override to simulate event-decoder
    // bugs.
    latestSwapAmountIn = '10.5',
    latestSwapAmountOut = '4.2',
    latestSwapTimestamp = String(Math.floor(Date.now() / 1000) - 3600),  // 1h ago
    // Multi-row time/timestamp arrays for monotonicity invariants
    // (slice 4d-scenarios-more candleTimeMonotonic +
    // swapTimeMonotonicNonStrict). Indexed by row position. If null,
    // auto-generated as a strictly-decreasing series anchored at the
    // latest values + a default step. Tests pass an explicit array to
    // simulate failure modes (duplicate, out-of-order).
    candleTimes = null,
    candleTimeStep = 3600,            // 1 hour between candles when auto-generated
    swapTimestamps = null,
    swapTimestampStep = 12,            // 1 block (~12s) between swaps when auto-generated
    // Per-swap pool FK for swapPoolReferentialIntegrity (slice
    // 4d-scenarios-more). Indexed by swap position. If null,
    // every swap auto-references mock-pool-0 (a real pool from
    // buildPools). Tests pass an explicit array to simulate
    // orphan-swap bugs (e.g. ['nonexistent-pool']).
    swapPoolIds = null,
    // Per-candle pool FK for candlePoolReferentialIntegrity (slice
    // 4d-scenarios-more). Same pattern as swapPoolIds — indexed
    // by candle position; null means every candle defaults to
    // mock-pool-0. Tests use an array to simulate orphan-candle
    // bugs from broken period-aggregator FK derivation.
    candlePoolIds = null,
    // Per-organization aggregator FK for
    // organizationAggregatorReferentialIntegrity (slice 4d-
    // scenarios-more). Indexed by organization position; null
    // means every org defaults to mock-agg-0 (a real aggregator
    // from buildRegistry). Tests pass an explicit array to
    // simulate orphan-org bugs.
    organizationAggregatorIds = null,
    // Set to true to make the direct-indexer paths return 502, simulating
    // an indexer that's down even though the api passthrough still works
    // (e.g., api is caching).
    registryDirectDown = false,
    candlesDirectDown = false,
    // Drift hook for apiCandlesMatchesDirect (slice 4d-scenarios-more):
    // a callback that takes the candles array the direct endpoint would
    // return and rewrites it BEFORE the api passthrough returns it. Use
    // to simulate api caching stale data, adapter dropping fields,
    // schema-translation drift, etc. Default identity (no drift).
    apiCandlesDriftFn = (candles) => candles,
    // Drift hook for apiRegistryMatchesDirect (slice 4d-scenarios-more):
    // takes the registry data object the direct endpoint would return
    // ({proposalEntities, organizations, aggregators}) and rewrites it
    // BEFORE the api passthrough returns it. Default identity.
    apiRegistryDriftFn = (data) => data,
    // JSON-RPC mock at /rpc (slice 4d-scenarios-more rateSanity).
    // sDAIRateRaw is the BigInt raw rate to return; default is 1.2e18.
    // Set to 0n to simulate a broken contract; null to make eth_call error.
    sDAIRateRaw = (12n * 10n ** 17n),  // 1.2 * 1e18
    rpcError = null,
    // Block number + chain ID for anvilBlockNumber / anvilChainId
    // (slice 4d-scenarios-more block + chain probes). Defaults are
    // sane Gnosis values; tests override to simulate failures.
    blockNumberHex = '0x123abc',  // some positive block
    chainIdHex = '0x64',           // 100 = Gnosis
} = {}) {
    // ── shared row builders ──────────────────────────────────────────
    // Pulled out of the per-route handlers so the api passthrough
    // (/candles/graphql) and the direct endpoint (/candles-direct/
    // graphql) can return identical data by default. Tests that need
    // drift between the two go through `apiCandlesDriftFn`.
    // Anchor candle times at "2 hours ago" so
    // candleSwapTimeWindowConsistency passes by default
    // (latest swap defaults to "1h ago"; candle.time
    // must be ≤ swap.timestamp). Tests overriding
    // candleTimes get full control.
    const candleTimeAnchor = Math.floor(Date.now() / 1000) - 7200;
    const buildPools = () => Array.from({ length: candlesPoolsCount },
        (_, i) => ({ id: `mock-pool-${i}` }));
    const buildSwaps = () => Array.from({ length: candlesSwapsCount }, (_, i) => {
        const row = { id: `mock-swap-${i}` };
        if (i === 0) {
            row.amountIn = latestSwapAmountIn;
            row.amountOut = latestSwapAmountOut;
        }
        row.timestamp = swapTimestamps
            ? Number(swapTimestamps[i])
            : Number(latestSwapTimestamp) - i * swapTimestampStep;
        // FK to a Pool. Default: every swap points at mock-pool-0
        // (the first pool produced by buildPools, guaranteed to
        // exist when candlesPoolsCount > 0). Tests override
        // swapPoolIds[i] to simulate orphan-swap bugs.
        const poolId = swapPoolIds ? swapPoolIds[i] : 'mock-pool-0';
        row.pool = { id: poolId };
        return row;
    });
    const buildRegistry = () => ({
        proposalEntities: Array.from({ length: registryProposalEntitiesCount },
            (_, i) => ({ id: `mock-prop-entity-${i}` })),
        organizations: Array.from({ length: registryOrganizationsCount }, (_, i) => {
            const row = { id: `mock-org-${i}` };
            // FK to an Aggregator. Default mock-agg-0 (the first
            // aggregator from buildRegistry, present when
            // registryAggregatorsCount > 0). Tests override
            // organizationAggregatorIds[i] to simulate orphan-org bugs.
            const aggId = organizationAggregatorIds ? organizationAggregatorIds[i] : 'mock-agg-0';
            row.aggregator = { id: aggId };
            return row;
        }),
        aggregators: Array.from({ length: registryAggregatorsCount },
            (_, i) => ({ id: `mock-agg-${i}` })),
    });
    const buildCandles = () => Array.from({ length: candlesCandlesCount }, (_, i) => {
        const row = { id: `mock-candle-${i}` };
        if (i === 0) {
            row.open = latestCandleOpen;
            row.high = latestCandleHigh;
            row.low = latestCandleLow;
            row.close = latestCandleClose;
            row.volumeToken0 = latestCandleVolumeToken0;
            row.volumeToken1 = latestCandleVolumeToken1;
        }
        row.time = candleTimes
            ? Number(candleTimes[i])
            : candleTimeAnchor - i * candleTimeStep;
        // FK to a Pool — same pattern as buildSwaps. Default
        // mock-pool-0; candlePoolIds[i] override for orphan tests.
        const poolId = candlePoolIds ? candlePoolIds[i] : 'mock-pool-0';
        row.pool = { id: poolId };
        return row;
    });

    return new Promise((res) => {
        const server = createServer((req, response) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                if (req.url === '/health' && req.method === 'GET') {
                    if (!healthOk) { response.statusCode = 503; response.end('down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (req.url === '/warmer' && req.method === 'GET') {
                    if (!warmerOk) { response.statusCode = 503; response.end('down'); return; }
                    response.setHeader('content-type', warmerContentType);
                    response.end(JSON.stringify({ status: 'warm', queues: 0 }));
                    return;
                }
                if (req.url === '/api/v1/spot-candles' && req.method === 'GET') {
                    response.statusCode = spotCandlesNoTickerStatus;
                    response.setHeader('content-type', 'application/json');
                    response.end(spotCandlesNoTickerBody);
                    return;
                }
                if (req.url === '/registry/graphql' && req.method === 'POST') {
                    // Same pattern as /candles/graphql (slice 4d-
                    // scenarios-more): the api passthrough returns
                    // the SAME data as /registry-direct/graphql by
                    // default (because api literally forwards), but
                    // routed through apiRegistryDriftFn so tests can
                    // simulate per-entity drift.
                    response.setHeader('content-type', 'application/json');
                    if (registryDirectDown) {
                        // If upstream is down, api returns just
                        // __typename — preserves apiCanReachRegistry
                        // semantics.
                        response.end(JSON.stringify({ data: { __typename: registryTypename } }));
                        return;
                    }
                    const driftedRegistry = apiRegistryDriftFn(buildRegistry());
                    response.end(JSON.stringify({
                        data: { __typename: registryTypename, ...driftedRegistry },
                    }));
                    return;
                }
                if (req.url === '/candles/graphql' && req.method === 'POST') {
                    // The api passthrough used to return ONLY __typename
                    // (sufficient for apiCanReachCandles). For
                    // apiCandlesMatchesDirect we now return the SAME
                    // shape as /candles-direct/graphql by default
                    // (because the api literally forwards the query),
                    // BUT routed through apiCandlesDriftFn so tests
                    // can simulate adapter drift / cache staleness.
                    response.setHeader('content-type', 'application/json');
                    if (candlesDirectDown) {
                        // If the upstream is down, the api still returns
                        // its bare __typename probe — preserves the
                        // existing apiCanReachCandles semantics.
                        response.end(JSON.stringify({ data: { __typename: candlesTypename } }));
                        return;
                    }
                    const candlesForApi = apiCandlesDriftFn(buildCandles());
                    response.end(JSON.stringify({
                        data: {
                            __typename: candlesTypename,
                            pools: buildPools(),
                            swaps: buildSwaps(),
                            candles: candlesForApi,
                        },
                    }));
                    return;
                }
                if (req.url === '/registry-direct/graphql' && req.method === 'POST') {
                    if (registryDirectDown) { response.statusCode = 502; response.end('indexer down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        data: { __typename: registryDirectTypename, ...buildRegistry() },
                    }));
                    return;
                }
                if (req.url === '/candles-direct/graphql' && req.method === 'POST') {
                    if (candlesDirectDown) { response.statusCode = 502; response.end('indexer down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        data: {
                            __typename: candlesDirectTypename,
                            pools: buildPools(),
                            swaps: buildSwaps(),
                            candles: buildCandles(),
                        },
                    }));
                    return;
                }
                if (req.url === '/rpc' && req.method === 'POST') {
                    response.setHeader('content-type', 'application/json');
                    if (rpcError) {
                        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: rpcError }));
                        return;
                    }
                    let parsed;
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        response.statusCode = 400;
                        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32700, message: 'parse error' } }));
                        return;
                    }
                    const replyResult = (result) =>
                        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
                    switch (parsed.method) {
                        case 'eth_call': {
                            // Pad the rate to a 32-byte hex (64 chars after 0x).
                            const hex = sDAIRateRaw.toString(16).padStart(64, '0');
                            return replyResult('0x' + hex);
                        }
                        case 'eth_blockNumber':
                            return replyResult(blockNumberHex);
                        case 'eth_chainId':
                            return replyResult(chainIdHex);
                        default:
                            response.end(JSON.stringify({
                                jsonrpc: '2.0', id: parsed.id ?? 1,
                                error: { code: -32601, message: `method ${parsed.method} not mocked` },
                            }));
                            return;
                    }
                }
                response.statusCode = 404;
                response.end('not found');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            res({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) });
        });
    });
}

// Helper: build a ctx that wires the direct-probe URLs to the fixture's
// distinguished paths + the RPC URL to the fixture's /rpc mock. Use for
// any test that wants ALL invariants to find real endpoints.
function fullCtx(fxUrl) {
    return {
        apiUrl: fxUrl,
        registryUrl: `${fxUrl}/registry-direct/graphql`,
        candlesUrl: `${fxUrl}/candles-direct/graphql`,
        rpcUrl: `${fxUrl}/rpc`,
    };
}

// ─── tests ──────────────────────────────────────────────────────────

test('INVARIANTS array shape (slice 4d-scenarios scaffold)', () => {
    assert.ok(Array.isArray(INVARIANTS), 'INVARIANTS is array');
    assert.ok(INVARIANTS.length >= 2, 'at least 2 starter invariants');
    for (const inv of INVARIANTS) {
        assert.equal(typeof inv.name, 'string');
        assert.equal(typeof inv.description, 'string');
        assert.equal(typeof inv.layer, 'string');
        assert.equal(typeof inv.check, 'function');
    }
});

test('runAllInvariants — happy path: all invariants pass', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true, 'overall pass');
        assert.equal(results.length, INVARIANTS.length);
        for (const r of results) {
            assert.equal(r.ok, true, `invariant ${r.name} ok=${r.ok}, error=${r.error}`);
        }
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: api /health is 503', async () => {
    const fx = await startFixture({ healthOk: false });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false, 'overall fail');
        const health = results.find((r) => r.name === 'apiHealth');
        assert.equal(health.ok, false);
        assert.match(health.error, /HTTP 503|503/);
        // Other invariants still ran (no short-circuit)
        const reg = results.find((r) => r.name === 'apiCanReachRegistry');
        assert.equal(reg.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registry typename wrong', async () => {
    const fx = await startFixture({ registryTypename: 'NotQuery' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const reg = results.find((r) => r.name === 'apiCanReachRegistry');
        assert.equal(reg.ok, false);
        assert.match(reg.error, /unexpected __typename/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candles typename wrong (slice 4d-scenarios-more)', async () => {
    const fx = await startFixture({ candlesTypename: 'WrongType' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const candles = results.find((r) => r.name === 'apiCanReachCandles');
        assert.equal(candles.ok, false);
        assert.match(candles.error, /unexpected __typename/);
        // Other invariants still ran (no short-circuit)
        const health = results.find((r) => r.name === 'apiHealth');
        assert.equal(health.ok, true);
        const reg = results.find((r) => r.name === 'apiCanReachRegistry');
        assert.equal(reg.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registry direct probe down', async () => {
    const fx = await startFixture({ registryDirectDown: true });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const direct = results.find((r) => r.name === 'registryDirect');
        assert.equal(direct.ok, false);
        assert.match(direct.error, /HTTP 502|502/);
        // Api-passthrough invariants still pass — useful debug signal
        // (api can reach registry by some other route than orchestrator
        // can; likely caching or a stale connection)
        const apiReg = results.find((r) => r.name === 'apiCanReachRegistry');
        assert.equal(apiReg.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candles direct probe down', async () => {
    const fx = await startFixture({ candlesDirectDown: true });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const direct = results.find((r) => r.name === 'candlesDirect');
        assert.equal(direct.ok, false);
        assert.match(direct.error, /HTTP 502|502/);
        // Both api-passthrough invariants still pass
        const apiCandles = results.find((r) => r.name === 'apiCanReachCandles');
        assert.equal(apiCandles.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiCandlesMatchesDirect happy: api passthrough returns same data as direct', async () => {
    const fx = await startFixture({ candlesCandlesCount: 3 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiCandlesMatchesDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /3 candles match between api passthrough and direct/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiCandlesMatchesDirect vacuously true when both sides empty', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'apiCandlesMatchesDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /both sides have 0 candles/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiCandlesMatchesDirect length mismatch (api drops a candle — cache stale)', async () => {
    // Simulate api caching: it returns 1 fewer candle than direct.
    const fx = await startFixture({
        candlesCandlesCount: 3,
        apiCandlesDriftFn: (candles) => candles.slice(0, 2),  // api returns 2, direct returns 3
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiCandlesMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /length mismatch.*api returned 2.*direct returned 3|cache drift/);
        // Existence invariants still pass — distinguishes "api is
        // stale" from "indexer is empty"
        const direct = results.find((r) => r.name === 'candlesDirect');
        assert.equal(direct.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiCandlesMatchesDirect id drift (adapter rewrote ids)', async () => {
    // Simulate adapter bug: api rewrites the id of the first candle.
    const fx = await startFixture({
        candlesCandlesCount: 2,
        apiCandlesDriftFn: (candles) => candles.map((c, i) =>
            i === 0 ? { ...c, id: 'rewritten-by-adapter' } : c
        ),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiCandlesMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /candles\[0\]\.id: api=rewritten-by-adapter ≠ direct=mock-candle-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiRegistryMatchesDirect happy: api passthrough returns same registry data as direct', async () => {
    // Defaults: 1 proposalEntity + 1 organization + 1 aggregator on
    // both sides, all matching ids.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiRegistryMatchesDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /proposalEntities=1, organizations=1, aggregators=1/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiRegistryMatchesDirect vacuously matches when all entity counts are 0', async () => {
    const fx = await startFixture({
        registryProposalEntitiesCount: 0,
        registryOrganizationsCount: 0,
        registryAggregatorsCount: 0,
    });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'apiRegistryMatchesDirect');
        // Empty arrays still match (length 0 == 0 for all 3 entity types).
        // Note: this fails the existence checks but apiRegistryMatchesDirect
        // is purely about agreement; that's correct behavior.
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /proposalEntities=0, organizations=0, aggregators=0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiRegistryMatchesDirect organizations length mismatch (per-entity cache drift)', async () => {
    // Per-entity drift: api drops one organization but proposalEntities
    // and aggregators are fine. Tests that the loop reports the
    // SPECIFIC entity that diverged, not just "registry mismatch".
    const fx = await startFixture({
        registryOrganizationsCount: 3,
        apiRegistryDriftFn: (data) => ({
            ...data,
            organizations: data.organizations.slice(0, 2),  // api: 2, direct: 3
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiRegistryMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /organizations: length mismatch.*api=2.*direct=3/);
        // Existence + match checks for the OTHER entity types still pass —
        // proves the per-entity granularity is real
        const props = results.find((r) => r.name === 'registryHasProposalEntities');
        assert.equal(props.ok, true);
        const orgs = results.find((r) => r.name === 'registryHasOrganizations');
        assert.equal(orgs.ok, true);  // direct still has 3, existence is fine
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiRegistryMatchesDirect aggregator id rewrite (adapter mutates registry rows)', async () => {
    const fx = await startFixture({
        registryAggregatorsCount: 2,
        apiRegistryDriftFn: (data) => ({
            ...data,
            aggregators: data.aggregators.map((a, i) =>
                i === 0 ? { ...a, id: 'rewritten-by-adapter' } : a
            ),
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiRegistryMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /aggregators\[0\]\.id: api=rewritten-by-adapter ≠ direct=mock-agg-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiRegistryMatchesDirect proposalEntities WHOLE-row swap (not just length)', async () => {
    // api returns SAME length but DIFFERENT proposal — caches a stale
    // earlier proposal that was since superseded. Length-only check
    // would miss this; pair-wise id check catches it.
    const fx = await startFixture({
        registryProposalEntitiesCount: 1,
        apiRegistryDriftFn: (data) => ({
            ...data,
            proposalEntities: [{ id: 'stale-cached-prop-from-yesterday' }],
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiRegistryMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /proposalEntities\[0\]\.id: api=stale-cached-prop-from-yesterday ≠ direct=mock-prop-entity-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiCandlesMatchesDirect time drift (id matches but time wrong)', async () => {
    // Subtle bug: api returns candles with right ids but wrong times.
    // This catches partial-cache or partial-rewrite drift that pure
    // id matching would miss.
    const fx = await startFixture({
        candlesCandlesCount: 2,
        apiCandlesDriftFn: (candles) => candles.map((c) => ({ ...c, time: c.time + 100 })),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiCandlesMatchesDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /id matches but time drifted|partial-rewrite/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — rateSanity: happy at 1.2 sDAI rate', async () => {
    const fx = await startFixture();  // default sDAIRateRaw = 1.2 * 1e18
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const rate = results.find((r) => r.name === 'rateSanity');
        assert.equal(rate.ok, true);
        assert.match(rate.detail, /sDAI rate 1\.2/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: rateSanity rate < 1.0', async () => {
    // 0.5 * 1e18 = below the lower bound
    const fx = await startFixture({ sDAIRateRaw: 5n * 10n ** 17n });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const rate = results.find((r) => r.name === 'rateSanity');
        assert.equal(rate.ok, false);
        assert.match(rate.error, /< 1\.0/);
        // Other invariants still ran (no short-circuit)
        const health = results.find((r) => r.name === 'apiHealth');
        assert.equal(health.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: rateSanity RPC error', async () => {
    const fx = await startFixture({
        rpcError: { code: -32603, message: 'internal error' },
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const rate = results.find((r) => r.name === 'rateSanity');
        assert.equal(rate.ok, false);
        assert.match(rate.error, /RPC error|internal error/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilBlockNumber happy at 0x123abc', async () => {
    const fx = await startFixture();  // default blockNumberHex = 0x123abc
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const block = results.find((r) => r.name === 'anvilBlockNumber');
        assert.equal(block.ok, true);
        assert.match(block.detail, /block \d+/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilBlockNumber at 0', async () => {
    const fx = await startFixture({ blockNumberHex: '0x0' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const block = results.find((r) => r.name === 'anvilBlockNumber');
        assert.equal(block.ok, false);
        assert.match(block.error, /block number is 0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilChainId happy at Gnosis', async () => {
    const fx = await startFixture();  // default chainIdHex = 0x64
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const chain = results.find((r) => r.name === 'anvilChainId');
        assert.equal(chain.ok, true);
        assert.match(chain.detail, /Gnosis/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilChainId at bare anvil 0x7a69 (= 31337)', async () => {
    const fx = await startFixture({ chainIdHex: '0x7a69' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const chain = results.find((r) => r.name === 'anvilChainId');
        assert.equal(chain.ok, false);
        assert.match(chain.error, /chain id 31337|expected 0x64/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiWarmer happy: 200 + JSON', async () => {
    const fx = await startFixture();  // default warmerOk=true
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const w = results.find((r) => r.name === 'apiWarmer');
        assert.equal(w.ok, true);
        assert.match(w.detail, /200 \+ JSON/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiWarmer down (503)', async () => {
    const fx = await startFixture({ warmerOk: false });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const w = results.find((r) => r.name === 'apiWarmer');
        assert.equal(w.ok, false);
        assert.match(w.error, /HTTP 503|503/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiWarmer returns HTML not JSON', async () => {
    const fx = await startFixture({ warmerContentType: 'text/html' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const w = results.find((r) => r.name === 'apiWarmer');
        assert.equal(w.ok, false);
        assert.match(w.error, /non-JSON content-type: text\/html/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiSpotCandlesValidates happy: 400 + error JSON', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const v = results.find((r) => r.name === 'apiSpotCandlesValidates');
        assert.equal(v.ok, true);
        assert.match(v.detail, /400 \+ "ticker required"/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiSpotCandlesValidates returns 200 (validation removed)', async () => {
    const fx = await startFixture({
        spotCandlesNoTickerStatus: 200,
        spotCandlesNoTickerBody: JSON.stringify({ candles: [] }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const v = results.find((r) => r.name === 'apiSpotCandlesValidates');
        assert.equal(v.ok, false);
        assert.match(v.error, /should 400, got 200/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — registryHasProposalEntities happy: 1 proposal indexed', async () => {
    const fx = await startFixture();  // default registryProposalEntitiesCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'registryHasProposalEntities');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-prop-entity-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registry checkpoint empty (sync not done)', async () => {
    const fx = await startFixture({ registryProposalEntitiesCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'registryHasProposalEntities');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /0 ProposalEntity rows|sync not complete/);
        // Other invariants still ran (no short-circuit)
        const direct = results.find((r) => r.name === 'registryDirect');
        assert.equal(direct.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — registryHasOrganizations happy: 1 org indexed', async () => {
    const fx = await startFixture();  // default registryOrganizationsCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'registryHasOrganizations');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-org-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registry has proposals but no orgs (org event handler broken)', async () => {
    const fx = await startFixture({ registryOrganizationsCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const orgs = results.find((r) => r.name === 'registryHasOrganizations');
        assert.equal(orgs.ok, false);
        assert.match(orgs.error, /0 Organization rows|org event handler broken/);
        // ProposalEntity probe still passes — distinguishes the two
        // entity-specific failure modes
        const props = results.find((r) => r.name === 'registryHasProposalEntities');
        assert.equal(props.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — registryHasAggregators happy: 1 aggregator indexed', async () => {
    const fx = await startFixture();  // default registryAggregatorsCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'registryHasAggregators');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-agg-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registry has orgs but no aggregators (root entity unindexed)', async () => {
    const fx = await startFixture({ registryAggregatorsCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const aggs = results.find((r) => r.name === 'registryHasAggregators');
        assert.equal(aggs.ok, false);
        assert.match(aggs.error, /0 Aggregator rows|sync didn't reach root entity|aggregator event handler broken/);
        // Lower-level entity probes still pass
        const orgs = results.find((r) => r.name === 'registryHasOrganizations');
        assert.equal(orgs.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleOHLCOrdering happy: low ≤ open/close ≤ high', async () => {
    const fx = await startFixture();  // defaults: low=0.40 ≤ open=0.45, close=0.48 ≤ high=0.50
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /OHLC.*consistent/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candle high < low (impossible OHLC)', async () => {
    const fx = await startFixture({
        latestCandleHigh: '0.30',
        latestCandleLow: '0.60',
        latestCandleOpen: '0.40',
        latestCandleClose: '0.50',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /low=0\.6 > high=0\.3|impossible OHLC ordering/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candle close > high', async () => {
    const fx = await startFixture({
        latestCandleHigh: '0.50',
        latestCandleLow: '0.40',
        latestCandleOpen: '0.45',
        latestCandleClose: '0.99',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /close=0\.99 outside/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleOHLCOrdering vacuously true when no candles', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /vacuously true/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleVolumesNonNegative happy', async () => {
    const fx = await startFixture();  // defaults: 100.0 / 50.0
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candleVolumesNonNegative');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /volumes=100\/50 non-negative/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candle volume0 < 0 (signed-amount aggregator bug)', async () => {
    const fx = await startFixture({ latestCandleVolumeToken0: '-1.5' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleVolumesNonNegative');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /volumeToken0=-1\.5 < 0|signed-amount aggregator bug/);
        // OHLC invariant still passes (only volume is broken)
        const ohlc = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(ohlc.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapAmountsPositive happy', async () => {
    const fx = await startFixture();  // defaults: amountIn=10.5, amountOut=4.2
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'swapAmountsPositive');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /amountIn=10\.5, amountOut=4\.2 both > 0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swap amountOut ≤ 0 (signed-amount handler bug)', async () => {
    const fx = await startFixture({ latestSwapAmountOut: '-2.5' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapAmountsPositive');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /amountOut=-2\.5 ≤ 0|signed-amount handler bug/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapAmountsPositive vacuously true when no swaps', async () => {
    const fx = await startFixture({ candlesSwapsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'swapAmountsPositive');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /vacuously true/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapTimestampSensible happy: recent timestamp', async () => {
    const fx = await startFixture();  // default: 1h ago
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'swapTimestampSensible');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /timestamp=\d+/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swap timestamp = 0 (uninitialized)', async () => {
    const fx = await startFixture({ latestSwapTimestamp: '0' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapTimestampSensible');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /timestamp=0 < 1577836800|uninitialized or wrong topic slot/);
        // Other swap invariant still passes (only timestamp is broken)
        const amounts = results.find((r) => r.name === 'swapAmountsPositive');
        assert.equal(amounts.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swap timestamp far future (garbage from wrong topic)', async () => {
    // 100 years in the future — clearly garbage
    const farFuture = Math.floor(Date.now() / 1000) + 100 * 365 * 86400;
    const fx = await startFixture({ latestSwapTimestamp: String(farFuture) });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapTimestampSensible');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /likely garbage from wrong topic slot/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleTimeMonotonic happy: 3 candles strictly decreasing (auto-generated)', async () => {
    // candleTimeStep defaults to 3600 (1h); 3 candles auto-generates
    // [now, now-3600, now-7200] which is strictly decreasing.
    const fx = await startFixture({ candlesCandlesCount: 3 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candleTimeMonotonic');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /3 candles strictly decreasing/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleTimeMonotonic vacuously true with 1 candle', async () => {
    const fx = await startFixture();  // default count=1
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candleTimeMonotonic');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /only 1 candle\(s\); monotonicity vacuous/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candleTimeMonotonic duplicate-period (two candles same time)', async () => {
    // Two candles emitted with the SAME time — period-aggregator
    // upsert-as-insert bug. Order is desc so [1000, 1000] fails the
    // strict check.
    const fx = await startFixture({
        candlesCandlesCount: 2,
        candleTimes: [1700000000, 1700000000],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleTimeMonotonic');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /not strictly decreasing|duplicate period/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candleTimeMonotonic out-of-order (later time after earlier)', async () => {
    // Returned ordered desc but second time is GREATER — orderBy
    // broken or aggregator emitted with wrong period key.
    const fx = await startFixture({
        candlesCandlesCount: 3,
        candleTimes: [1700000000, 1699999000, 1699999500],  // 3rd > 2nd
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleTimeMonotonic');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /not strictly decreasing|aggregator bug/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapTimeMonotonicNonStrict happy: 3 swaps with one duplicate timestamp (same block)', async () => {
    // [now, now, now-12] — first two share a block timestamp (legal
    // for swaps in the same block). Non-strict check passes.
    const now = Math.floor(Date.now() / 1000);
    const fx = await startFixture({
        candlesSwapsCount: 3,
        swapTimestamps: [now, now, now - 12],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'swapTimeMonotonicNonStrict');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /3 swaps non-strictly decreasing/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swapTimeMonotonicNonStrict timestamp goes BACKWARDS', async () => {
    // [1000, 999, 1500] — third timestamp is GREATER than second,
    // violates desc ordering even non-strictly. Bug shape: orderBy
    // broken or wrong-block context on a swap.
    const fx = await startFixture({
        candlesSwapsCount: 3,
        swapTimestamps: [1700000000, 1699999988, 1700000500],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapTimeMonotonicNonStrict');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /timestamp going backwards|orderBy broken|wrong-block context/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapPoolReferentialIntegrity happy: swap references existing pool', async () => {
    // Defaults: 1 pool ("mock-pool-0"), 1 swap defaulting to
    // pool.id="mock-pool-0". FK intact.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'swapPoolReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /swap mock-swap-0 → pool mock-pool-0 \(FK intact/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapPoolReferentialIntegrity vacuously true with no swaps', async () => {
    const fx = await startFixture({ candlesSwapsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'swapPoolReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no swaps to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swapPoolReferentialIntegrity orphan swap (FK derivation bug)', async () => {
    // Swap references a nonexistent pool — handler computed FK wrong.
    const fx = await startFixture({
        candlesPoolsCount: 2,                           // mock-pool-0, mock-pool-1
        swapPoolIds: ['nonexistent-pool-xyz'],          // FK points nowhere
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapPoolReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references pool nonexistent-pool-xyz but no such pool|orphan swap/);
        // Existence checks still pass — the entities exist
        // independently; only their relationship is broken
        const pools = results.find((r) => r.name === 'candlesHasPools');
        assert.equal(pools.ok, true);
        const swaps = results.find((r) => r.name === 'candlesHasSwaps');
        assert.equal(swaps.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swapPoolReferentialIntegrity all pools deleted (orphan-storm)', async () => {
    // Pools wiped (e.g., schema migration that dropped Pool rows
    // without GC-ing Swaps). Existence check for pools fails too;
    // referential integrity catches the orphaned swap directly.
    const fx = await startFixture({
        candlesPoolsCount: 0,
        candlesSwapsCount: 1,
        swapPoolIds: ['mock-pool-0'],  // FK points at a no-longer-existing pool
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapPoolReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references pool mock-pool-0 but no such pool/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlePoolReferentialIntegrity happy: candle references existing pool', async () => {
    // Defaults: 1 pool ("mock-pool-0"), 1 candle defaulting to
    // pool.id="mock-pool-0". FK intact.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candlePoolReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /candle mock-candle-0 → pool mock-pool-0 \(FK intact/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlePoolReferentialIntegrity vacuously true with no candles', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candlePoolReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no candles to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candlePoolReferentialIntegrity orphan candle (period-aggregator FK bug)', async () => {
    // Candle's pool FK derived wrong by the aggregator. Distinct
    // failure mode from the swap-side equivalent: even if every
    // swap's FK is intact, the aggregator's per-bucket FK can be
    // independently wrong.
    const fx = await startFixture({
        candlesPoolsCount: 2,
        candlePoolIds: ['orphan-candle-pool-id'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candlePoolReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references pool orphan-candle-pool-id but no such pool|orphan candle/);
        // SWAP FK still intact — distinguishes "aggregator FK bug"
        // from "swap handler FK bug"
        const swapInv = results.find((r) => r.name === 'swapPoolReferentialIntegrity');
        assert.equal(swapInv.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candlePoolReferentialIntegrity all pools deleted (orphan-storm)', async () => {
    // Pools wiped while candle aggregates remain. Catches schema
    // migration that dropped Pool rows without GC-ing Candles —
    // distinct from the swap version because aggregator may
    // emit candles to disk independently of swap-event ingestion.
    const fx = await startFixture({
        candlesPoolsCount: 0,
        candlesCandlesCount: 1,
        candlePoolIds: ['mock-pool-0'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candlePoolReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references pool mock-pool-0 but no such pool/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleSwapTimeWindowConsistency happy: latest swap newer than latest candle (default fixture)', async () => {
    // Defaults: latestCandleTime ≈ 2h ago; latestSwapTimestamp ≈ 1h ago.
    // Latest swap > latest candle → invariant passes.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candleSwapTimeWindowConsistency');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /latest swap mock-swap-0.*latest candle mock-candle-0.*diff=\d+s/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleSwapTimeWindowConsistency vacuous: no swaps', async () => {
    const fx = await startFixture({ candlesSwapsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candleSwapTimeWindowConsistency');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /vacuous \(swaps=0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candleSwapTimeWindowConsistency vacuous: no candles', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candleSwapTimeWindowConsistency');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /vacuous .*candles=0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — organizationAggregatorReferentialIntegrity happy: org references existing aggregator', async () => {
    // Defaults: 1 aggregator (mock-agg-0), 1 organization defaulting
    // to aggregator.id="mock-agg-0". FK intact.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'organizationAggregatorReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /organization mock-org-0 → aggregator mock-agg-0 \(FK intact/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — organizationAggregatorReferentialIntegrity vacuously true with no organizations', async () => {
    const fx = await startFixture({ registryOrganizationsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'organizationAggregatorReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no organizations to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: organizationAggregatorReferentialIntegrity orphan org (FK derivation bug)', async () => {
    // Org references a nonexistent aggregator — org-event handler
    // computed FK wrong.
    const fx = await startFixture({
        registryAggregatorsCount: 2,
        organizationAggregatorIds: ['nonexistent-aggregator-xyz'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'organizationAggregatorReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references aggregator nonexistent-aggregator-xyz but no such aggregator|orphan org/);
        // Existence checks still pass — the entities exist
        // independently; only their relationship is broken
        const orgs = results.find((r) => r.name === 'registryHasOrganizations');
        assert.equal(orgs.ok, true);
        const aggs = results.find((r) => r.name === 'registryHasAggregators');
        assert.equal(aggs.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: organizationAggregatorReferentialIntegrity all aggregators deleted (orphan-storm)', async () => {
    // Aggregators wiped (e.g., schema migration that dropped
    // Aggregator rows without GC-ing Organizations).
    const fx = await startFixture({
        registryAggregatorsCount: 0,
        registryOrganizationsCount: 1,
        organizationAggregatorIds: ['mock-agg-0'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'organizationAggregatorReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references aggregator mock-agg-0 but no such aggregator/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candleSwapTimeWindowConsistency candle in future relative to latest swap (clock-skew bug)', async () => {
    // Candle exists for a period AHEAD of any observed swap. Bug
    // shape: aggregator's clock source skewed forward, OR indexer
    // dropped recent swaps while period-aggregator kept producing
    // buckets. With explicit candleTimes, the candle's time is
    // pinned at "1 day from now"; default swap timestamp is "1h
    // ago" → candle is in the future relative to latest swap.
    const aDayInTheFuture = Math.floor(Date.now() / 1000) + 86400;
    const fx = await startFixture({
        candlesCandlesCount: 1,
        candleTimes: [aDayInTheFuture],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candleSwapTimeWindowConsistency');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /latest swap.*<.*latest candle.*candle is in the FUTURE|aggregator clock-skew/);
        // Per-row time-shape probes still pass — distinguishes
        // "each entity's time field is internally consistent" from
        // "the entities' time fields are mutually consistent"
        const swapTs = results.find((r) => r.name === 'swapTimestampSensible');
        assert.equal(swapTs.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlesHasPools happy: 1 pool indexed', async () => {
    const fx = await startFixture();  // default candlesPoolsCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candlesHasPools');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-pool-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candles checkpoint empty (sync not done)', async () => {
    const fx = await startFixture({ candlesPoolsCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candlesHasPools');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /0 Pool rows|sync not complete/);
        const direct = results.find((r) => r.name === 'candlesDirect');
        assert.equal(direct.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlesHasSwaps happy: 1 swap indexed', async () => {
    const fx = await startFixture();  // default candlesSwapsCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candlesHasSwaps');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-swap-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candles has pools but no swaps (post-pool sync lag)', async () => {
    const fx = await startFixture({ candlesSwapsCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const swaps = results.find((r) => r.name === 'candlesHasSwaps');
        assert.equal(swaps.ok, false);
        assert.match(swaps.error, /0 Swap rows|sync not complete past pool deployment|no trades yet/);
        // Pools probe still passes — verifies the two invariants
        // distinguish different sync stages
        const pools = results.find((r) => r.name === 'candlesHasPools');
        assert.equal(pools.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlesHasCandles happy: 1 candle aggregated', async () => {
    const fx = await startFixture();  // default candlesCandlesCount=1
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candlesHasCandles');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /sample id: mock-candle-0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candles has swaps but no candles (aggregator broken)', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const candles = results.find((r) => r.name === 'candlesHasCandles');
        assert.equal(candles.ok, false);
        assert.match(candles.error, /0 Candle rows|aggregator broken/);
        // Swap probe still passes — distinguishes "swap sync done"
        // from "aggregation step failed"
        const swaps = results.find((r) => r.name === 'candlesHasSwaps');
        assert.equal(swaps.ok, true);
    } finally {
        await fx.stop();
    }
});

test('scenario-runner CLI — dry-run exits 0 without network', () => {
    const r = spawnSync('node', [RUNNER], {
        env: {
            ...process.env,
            HARNESS_COMPOSE: '1',
            HARNESS_DRY_RUN: '1',
        },
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit status: ${r.status}, stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.match(r.stdout, /invariants registered: \d+/);
    assert.match(r.stdout, /apiHealth/);
    assert.match(r.stdout, /apiWarmer/);
    assert.match(r.stdout, /apiSpotCandlesValidates/);
    assert.match(r.stdout, /apiCanReachRegistry/);
    assert.match(r.stdout, /apiCanReachCandles/);
    assert.match(r.stdout, /apiCandlesMatchesDirect/);
    assert.match(r.stdout, /apiRegistryMatchesDirect/);
    assert.match(r.stdout, /registryDirect/);
    assert.match(r.stdout, /candlesDirect/);
    assert.match(r.stdout, /registryHasProposalEntities/);
    assert.match(r.stdout, /registryHasOrganizations/);
    assert.match(r.stdout, /registryHasAggregators/);
    assert.match(r.stdout, /candlesHasPools/);
    assert.match(r.stdout, /candlesHasSwaps/);
    assert.match(r.stdout, /candlesHasCandles/);
    assert.match(r.stdout, /candleOHLCOrdering/);
    assert.match(r.stdout, /candleVolumesNonNegative/);
    assert.match(r.stdout, /swapAmountsPositive/);
    assert.match(r.stdout, /swapTimestampSensible/);
    assert.match(r.stdout, /candleTimeMonotonic/);
    assert.match(r.stdout, /swapTimeMonotonicNonStrict/);
    assert.match(r.stdout, /swapPoolReferentialIntegrity/);
    assert.match(r.stdout, /candlePoolReferentialIntegrity/);
    assert.match(r.stdout, /candleSwapTimeWindowConsistency/);
    assert.match(r.stdout, /organizationAggregatorReferentialIntegrity/);
    assert.match(r.stdout, /anvilBlockNumber/);
    assert.match(r.stdout, /anvilChainId/);
    assert.match(r.stdout, /rateSanity/);
});

test('scenario-runner CLI — native mode exits 2 with guidance', () => {
    const r = spawnSync('node', [RUNNER], {
        env: { ...process.env, HARNESS_COMPOSE: '', HARNESS_DRY_RUN: '' },
        encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /native mode not yet supported/);
});
