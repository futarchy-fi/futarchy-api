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
    // Spot-candles happy-path (slice 4d-scenarios-more
    // apiSpotCandlesHappyPath): when ticker is present, default
    // returns 200 + {spotCandles: []} matching the api's empty-
    // result shape. Toggle to simulate data-plane failures:
    //   - status: change to 500 to simulate downstream throw
    //   - body: change to break shape (e.g. drop spotCandles field)
    spotCandlesWithTickerStatus = 200,
    spotCandlesWithTickerBody = JSON.stringify({ spotCandles: [] }),
    // Unified-chart happy-path (slice 4d-scenarios-more
    // apiUnifiedChartShape): /api/v2/proposals/<id>/chart by
    // default returns 200 + {candles: {yes:[], no:[], spot:[]},
    // metadata: {}} — the minimal shape consumers depend on.
    // Toggle status / body to simulate failures.
    unifiedChartStatus = 200,
    unifiedChartBody = JSON.stringify({
        metadata: {},
        candles: { yes: [], no: [], spot: [] },
    }),
    // Observability headers for apiUnifiedChartHasObservabilityHeaders
    // (slice 4d-scenarios-more). Defaults match what
    // src/routes/unified-chart.js emits on a cache MISS.
    unifiedChartXCache = 'MISS',
    unifiedChartXResponseTime = '12ms',
    // Market-events happy-path (slice 4d-scenarios-more
    // apiMarketEventsShape): /api/v1/market-events/proposals/
    // <id>/prices defaults to 200 + the minimal contract
    // consumers depend on (status, conditional_{yes,no},
    // spot, timeline). Toggle status / body to simulate
    // failures.
    marketEventsStatus = 200,
    marketEventsBody = JSON.stringify({
        status: 'ok',
        event_id: 'harness-probe-proposal',
        conditional_yes: { price_usd: 0.55, pool_id: 'mock-pool-yes' },
        conditional_no: { price_usd: 0.45, pool_id: 'mock-pool-no' },
        spot: { price_usd: 1.05, pool_ticker: 'harness-probe-ticker' },
        timeline: { start: 1700000000, end: 1700864000, chain_id: 100 },
    }),
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
    // Pool type for probabilityBounds (slice 4d-scenarios-more).
    // Default PREDICTION (the most common futarchy market type;
    // makes the invariant active in the happy path). Tests can
    // override to CONDITIONAL or EXPECTED_VALUE to exercise the
    // vacuous branch (or null/undefined for the "schema missing
    // field" case).
    poolType = 'PREDICTION',
    // Per-organization aggregator FK for
    // organizationAggregatorReferentialIntegrity (slice 4d-
    // scenarios-more). Indexed by organization position; null
    // means every org defaults to mock-agg-0 (a real aggregator
    // from buildRegistry). Tests pass an explicit array to
    // simulate orphan-org bugs.
    organizationAggregatorIds = null,
    // Per-proposalEntity organization FK for
    // proposalEntityOrganizationReferentialIntegrity (slice 4d-
    // scenarios-more). Closes the registry FK chain coverage.
    // Default null → every proposal references mock-org-0.
    proposalEntityOrganizationIds = null,
    // Inject the production futarchy aggregator address into the
    // aggregators list (slice 4d-scenarios-more
    // registryHasFutarchyProdAggregator). Default true so the
    // happy-path invariant passes; override to false to simulate
    // wrong-fork-block / wrong-chain bootstrap scenarios where
    // the indexer has aggregators but missed the prod one.
    includeFutarchyProdAggregator = true,
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
    // Latest block details for anvilLatestBlockSensible (slice
    // 4d-scenarios-more chain time-shape probe). Defaults match a
    // sane recent block; tests override to simulate stuck-clock,
    // garbage-hash, or genesis-only scenarios.
    latestBlockHash = '0x' + 'a1b2c3d4'.repeat(8),  // valid 0x + 64 hex
    latestBlockTimestampHex = '0x' + Math.floor(Date.now() / 1000 - 60).toString(16),  // 1 min ago
    // web3_clientVersion response for anvilClientVersionMentionsAnvil
    // (slice 4d-scenarios-more). Default mimics anvil's actual
    // version string. Tests override to "geth/v1.13" etc. for the
    // wrong-client failure case.
    clientVersion = 'anvil/0.1.0',
    // eth_gasPrice response for anvilGasPricePresent
    // (slice 4d-scenarios-more). Default 0x12a05f200 = 5_000_000_000
    // wei = 5 gwei (a sensible anvil-default-ish price). Tests override
    // to null (EIP-1559-only mode), '0x0' (broken fee market), or a
    // non-string (RPC-layer regression).
    gasPriceHex = '0x12a05f200',
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
        (_, i) => ({ id: `mock-pool-${i}`, type: poolType }));
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
        proposalEntities: Array.from({ length: registryProposalEntitiesCount }, (_, i) => {
            const row = { id: `mock-prop-entity-${i}` };
            // FK to an Organization. Default mock-org-0 (the first
            // org from buildRegistry, present when
            // registryOrganizationsCount > 0). Tests override
            // proposalEntityOrganizationIds[i] for orphan-proposal
            // simulation.
            const orgId = proposalEntityOrganizationIds ? proposalEntityOrganizationIds[i] : 'mock-org-0';
            row.organization = { id: orgId };
            return row;
        }),
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
        aggregators: (() => {
            const mock = Array.from({ length: registryAggregatorsCount },
                (_, i) => ({ id: `mock-agg-${i}` }));
            if (includeFutarchyProdAggregator) {
                // APPEND (not prepend) so existing tests that
                // assert index-0 = mock-agg-0 keep working. Tests
                // checking "missing prod" set
                // includeFutarchyProdAggregator=false; tests
                // checking "vacuously" set registryAggregatorsCount=0
                // AND includeFutarchyProdAggregator=false.
                mock.push({ id: '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1' });
            }
            return mock;
        })(),
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
        // Pool object also carries `type` for probabilityBounds
        // (slice 4d-scenarios-more) — defaults to PREDICTION via
        // the poolType fixture knob; overrides via that knob, not
        // per-candle, since type is a property of the pool not the
        // candle.
        const poolId = candlePoolIds ? candlePoolIds[i] : 'mock-pool-0';
        row.pool = { id: poolId, type: poolType };
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
                if (req.url?.startsWith('/api/v1/spot-candles') && req.method === 'GET') {
                    // Dispatch on whether `ticker` query param is present.
                    // The bare `/api/v1/spot-candles` URL has no `?` and
                    // returns the no-ticker (400 by default) branch;
                    // anything with `?ticker=...` returns the happy-path
                    // (200 + spotCandles array by default).
                    const hasTicker = req.url.includes('ticker=');
                    response.setHeader('content-type', 'application/json');
                    if (hasTicker) {
                        response.statusCode = spotCandlesWithTickerStatus;
                        response.end(spotCandlesWithTickerBody);
                    } else {
                        response.statusCode = spotCandlesNoTickerStatus;
                        response.end(spotCandlesNoTickerBody);
                    }
                    return;
                }
                if (req.url?.match(/^\/api\/v1\/market-events\/proposals\/[^/]+\/prices/) && req.method === 'GET') {
                    response.statusCode = marketEventsStatus;
                    response.setHeader('content-type', 'application/json');
                    response.end(marketEventsBody);
                    return;
                }
                if (req.url?.match(/^\/api\/v2\/proposals\/[^/]+\/chart/) && req.method === 'GET') {
                    // Match /api/v2/proposals/<anything-but-slash>/chart
                    // (with optional query string). The proposalId is a
                    // path param so we use a regex; the apiUnifiedChartShape
                    // invariant uses 'harness-probe-proposal' but tests
                    // can put any id there.
                    response.statusCode = unifiedChartStatus;
                    response.setHeader('content-type', 'application/json');
                    // Observability headers (slice 4d-scenarios-more
                    // apiUnifiedChartHasObservabilityHeaders). Set
                    // unconditionally — the production handler also
                    // sets them on every code path. Knobs let tests
                    // null these out to simulate dropped instrumentation.
                    if (unifiedChartXCache !== null) {
                        response.setHeader('x-cache', unifiedChartXCache);
                    }
                    if (unifiedChartXResponseTime !== null) {
                        response.setHeader('x-response-time', unifiedChartXResponseTime);
                    }
                    response.end(unifiedChartBody);
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
                        case 'eth_getBlockByNumber':
                            return replyResult({
                                hash: latestBlockHash,
                                timestamp: latestBlockTimestampHex,
                                number: blockNumberHex,
                                parentHash: '0x' + '0'.repeat(64),
                            });
                        case 'web3_clientVersion':
                            return replyResult(clientVersion);
                        case 'eth_gasPrice':
                            return replyResult(gasPriceHex);
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
        // Default fixture: 1 mock org/proposal each + 2 aggregators
        // (mock-agg-0 + the appended prod aggregator from
        // includeFutarchyProdAggregator=true).
        assert.match(inv.detail, /proposalEntities=1, organizations=1, aggregators=2/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiRegistryMatchesDirect vacuously matches when all entity counts are 0', async () => {
    const fx = await startFixture({
        registryProposalEntitiesCount: 0,
        registryOrganizationsCount: 0,
        registryAggregatorsCount: 0,
        // Also disable prod aggregator injection so total really is 0
        includeFutarchyProdAggregator: false,
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

test('runAllInvariants — anvilLatestBlockSensible happy: recent timestamp + valid hash', async () => {
    // Defaults: ts ≈ 1min ago, hash is valid 0x + 64 hex chars.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'anvilLatestBlockSensible');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /latest block 0xa1b2c3d4… @ ts=\d+/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilLatestBlockSensible stuck-clock (timestamp = 0)', async () => {
    const fx = await startFixture({
        latestBlockTimestampHex: '0x0',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilLatestBlockSensible');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /stuck clock|2020-01-01|wrong fork era/);
        // The count-only block-number probe STILL passes — distinguishes
        // "block exists" from "block has sensible time"
        const num = results.find((r) => r.name === 'anvilBlockNumber');
        assert.equal(num.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilLatestBlockSensible clock skewed forward (year 2099)', async () => {
    const farFuture = Math.floor(new Date('2099-01-01').getTime() / 1000);
    const fx = await startFixture({
        latestBlockTimestampHex: '0x' + farFuture.toString(16),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilLatestBlockSensible');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /clock skewed forward|now \+ 1d/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilLatestBlockSensible garbage hash (anvil bug)', async () => {
    const fx = await startFixture({ latestBlockHash: '0xdeadbeef' });  // too short
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilLatestBlockSensible');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /block\.hash invalid/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilClientVersionMentionsAnvil happy: client identifies as anvil', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'anvilClientVersionMentionsAnvil');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /client version: anvil\/0\.1\.0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilClientVersionMentionsAnvil happy: case-insensitive match', async () => {
    const fx = await startFixture({ clientVersion: 'Anvil 1.5.0-stable (rev=abc123)' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'anvilClientVersionMentionsAnvil');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /client version: Anvil 1\.5\.0-stable/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilClientVersionMentionsAnvil wrong client (geth)', async () => {
    // Running against a Gnosis fork on geth — chain ID matches but
    // anvil_/evm_ extensions for impersonation/snapshots/time-warp
    // would silently fail later in scenario tests.
    const fx = await startFixture({ clientVersion: 'Geth/v1.13.0-stable/linux-amd64/go1.21' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilClientVersionMentionsAnvil');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /does not contain "anvil"|wrong EVM client/);
        // anvilChainId STILL passes — distinguishes wrong-chain from
        // wrong-client failure modes
        const chainId = results.find((r) => r.name === 'anvilChainId');
        assert.equal(chainId.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilClientVersionMentionsAnvil non-string response', async () => {
    // RPC returns null or object (handler regression on the chain
    // process). Distinct from "wrong client" — this is "broken
    // response shape".
    const fx = await startFixture({ clientVersion: null });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilClientVersionMentionsAnvil');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /returned non-string|null/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilGasPricePresent happy: 5 gwei (default fixture)', async () => {
    const fx = await startFixture();  // default gasPriceHex = '0x12a05f200' = 5 gwei
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'anvilGasPricePresent');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /gas price 5000000000 wei/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — anvilGasPricePresent happy: edge low (1 wei)', async () => {
    // Sanity that any positive value passes — even 1 wei is "fee
    // market alive". The invariant cares about > 0, not magnitude.
    const fx = await startFixture({ gasPriceHex: '0x1' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'anvilGasPricePresent');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /gas price 1 wei/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilGasPricePresent EIP-1559-only mode (null)', async () => {
    // Anvil started with a flag that disables legacy gas pricing —
    // eth_gasPrice returns null. Tools that estimate via the legacy
    // method silently break.
    const fx = await startFixture({ gasPriceHex: null });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilGasPricePresent');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /returned null.*legacy gas pricing disabled/);
        // anvilChainId STILL passes — chain identity is fine, only the
        // fee market is broken. Demonstrates the value-add over
        // chain-identity-only probes.
        const chain = results.find((r) => r.name === 'anvilChainId');
        assert.equal(chain.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilGasPricePresent broken fee market (0x0)', async () => {
    // anvil --gas-price 0 misconfig. Transactions appear free,
    // masking real-world gas accounting bugs in scenarios.
    const fx = await startFixture({ gasPriceHex: '0x0' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilGasPricePresent');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /eth_gasPrice = 0.*broken fee market/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: anvilGasPricePresent non-hex response (number)', async () => {
    // RPC-layer regression: anvil version returns a decimal number
    // instead of a hex string. Downstream BigInt parsing breaks.
    const fx = await startFixture({ gasPriceHex: 5000000000 });  // number, not string
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'anvilGasPricePresent');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /returned non-hex-string.*RPC-layer regression/);
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

test('runAllInvariants — apiSpotCandlesHappyPath happy: 200 + empty spotCandles array', async () => {
    // Default fixture: ticker present → 200 + {spotCandles: []}.
    // Empty array is the documented happy-path empty case (still
    // 200, JSON, has the expected field — just no data).
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiSpotCandlesHappyPath');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /200 \+ spotCandles array of length 0/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiSpotCandlesHappyPath happy: 200 + spotCandles with data', async () => {
    const fx = await startFixture({
        spotCandlesWithTickerBody: JSON.stringify({
            spotCandles: [
                { periodStartUnix: '1700000000', close: '0.42' },
                { periodStartUnix: '1700003600', close: '0.45' },
            ],
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiSpotCandlesHappyPath');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /200 \+ spotCandles array of length 2/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiSpotCandlesHappyPath data-plane error (500 from downstream throw)', async () => {
    // Validation passed but the downstream fetchSpotCandles call
    // throws and the catch-all returns 500. apiSpotCandlesValidates
    // (the 400-path probe) STILL passes because it tests a different
    // request — distinguishes the two failure modes.
    const fx = await startFixture({
        spotCandlesWithTickerStatus: 500,
        spotCandlesWithTickerBody: JSON.stringify({ error: 'downstream timeout', spotCandles: [] }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiSpotCandlesHappyPath');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /expected 200, got 500|data plane broken/);
        const validates = results.find((r) => r.name === 'apiSpotCandlesValidates');
        assert.equal(validates.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiSpotCandlesHappyPath response-shape regression (missing spotCandles field)', async () => {
    // Endpoint returns 200 + JSON but the `spotCandles` key is gone.
    // Could be a refactor that returned the raw spotData object
    // instead of {spotCandles: candles}, or a renamed field.
    const fx = await startFixture({
        spotCandlesWithTickerBody: JSON.stringify({ candles: [] }),  // wrong key
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiSpotCandlesHappyPath');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /missing spotCandles array|transform regression/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiUnifiedChartShape happy: 200 + empty yes/no/spot arrays', async () => {
    // Default fixture: 200 + {metadata: {}, candles: {yes:[], no:[], spot:[]}}.
    // All three arrays empty is a valid happy-path "no candles yet"
    // case (e.g. fresh proposal, no swaps); shape is still right.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /200 \+ candles\.\{yes,no,spot\} all arrays \(yes=0, no=0, spot=0\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiUnifiedChartShape happy: 200 + populated yes/no/spot arrays', async () => {
    const fx = await startFixture({
        // Bump direct candles count so the chartCandleCountsBoundedByDirect
        // invariant (which asserts api yes+no <= direct count) doesn't
        // fire — apiUnifiedChartShape happy returns yes=2 + no=1 = 3
        // candles, so direct needs ≥ 3. Times must align with api's
        // {1700000000, 1700003600} so chartCandlesAreSubsetOfDirect
        // (slice 4d-scenarios-more) also passes — that invariant
        // requires every api time to appear in direct's time set.
        // Array order is DESCENDING (largest first) so the existing
        // candleTimeMonotonic invariant ALSO stays happy.
        candlesCandlesCount: 3,
        candleTimes: [1700007200, 1700003600, 1700000000],
        unifiedChartBody: JSON.stringify({
            metadata: { trading_contract_id: 'mock-contract' },
            candles: {
                yes: [{ time: 1700000000, close: '0.42' }, { time: 1700003600, close: '0.45' }],
                no: [{ time: 1700000000, close: '0.58' }],
                spot: [{ time: 1700000000, close: '1.05' }],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /yes=2, no=1, spot=1/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiUnifiedChartShape data-plane error (500 from resolve/fetch)', async () => {
    // proposal resolve / pool fetch / response transform errored
    // and the catch-all returned 500. Other api invariants STILL
    // pass — distinguishes "this endpoint's data plane broken"
    // from "api is down".
    const fx = await startFixture({
        unifiedChartStatus: 500,
        unifiedChartBody: JSON.stringify({ error: 'pool fetch failed' }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /expected 200, got 500|data plane broken/);
        const health = results.find((r) => r.name === 'apiHealth');
        assert.equal(health.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — chartCandleCountsBoundedByDirect happy: 0 ≤ 1 (default fixture)', async () => {
    // Default: api returns empty yes/no arrays, direct returns 1 candle.
    // 0+0 ≤ 1 — passes naturally. This also represents the "fresh
    // proposal, no candles yet but indexer has some" case.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'chartCandleCountsBoundedByDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /api yes=0 \+ no=0 = 0 ≤ direct 1/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — chartCandleCountsBoundedByDirect vacuous: both 0', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'chartCandleCountsBoundedByDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /both api .* and direct return 0 candles \(vacuous\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — chartCandleCountsBoundedByDirect happy: api subset matches direct (1 yes + 1 no ≤ 5)', async () => {
    const fx = await startFixture({
        candlesCandlesCount: 5,
        // candleTimes must include 1700000000 (the time api returns
        // on both yes/no sides) so the sister chartCandlesAreSubsetOfDirect
        // invariant (slice 4d-scenarios-more) also passes — it requires
        // every api time to appear in direct's time set. DESCENDING
        // order keeps candleTimeMonotonic happy.
        candleTimes: [1700014400, 1700010800, 1700007200, 1700003600, 1700000000],
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: {
                yes: [{ time: 1700000000, close: '0.42' }],
                no: [{ time: 1700000000, close: '0.58' }],
                spot: [],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'chartCandleCountsBoundedByDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /api yes=1 \+ no=1 = 2 ≤ direct 5/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: chartCandleCountsBoundedByDirect filter regression (api returns more than direct)', async () => {
    // The bug: api filter regressed — instead of returning only
    // the proposal's candles, it returns 5 yes + 5 no = 10. But
    // the indexer only has 1 candle. Impossible — flag it.
    const fx = await startFixture({
        candlesCandlesCount: 1,
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: {
                yes: [
                    { time: 1700000000, close: '0.42' },
                    { time: 1700003600, close: '0.43' },
                    { time: 1700007200, close: '0.44' },
                    { time: 1700010800, close: '0.45' },
                    { time: 1700014400, close: '0.46' },
                ],
                no: [
                    { time: 1700000000, close: '0.58' },
                    { time: 1700003600, close: '0.57' },
                    { time: 1700007200, close: '0.56' },
                    { time: 1700010800, close: '0.55' },
                    { time: 1700014400, close: '0.54' },
                ],
                spot: [],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'chartCandleCountsBoundedByDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /api candle count.*= 10.*> direct count.*1.*filter regression|fabrication/);
        // apiUnifiedChartShape STILL passes — the SHAPE is fine
        // (yes/no/spot are arrays); the gap is the COUNT relationship
        // to direct, which only this invariant checks
        const shape = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(shape.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — chartCandlesAreSubsetOfDirect happy: vacuous (api returns 0 candles, default fixture)', async () => {
    // Default fixture: api chart returns yes=[], no=[], spot=[] → 0 total.
    // chartCandlesAreSubsetOfDirect short-circuits to ok+vacuous before
    // touching direct.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'chartCandlesAreSubsetOfDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /api returned 0 candles \(vacuous/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — chartCandlesAreSubsetOfDirect happy: api times all match direct (yes=2 + no=1)', async () => {
    // Direct has 3 candles at known times; api returns a subset of
    // those exact times. Every api time appears in the direct set.
    // candleTimes in DESCENDING order so candleTimeMonotonic stays happy.
    const fx = await startFixture({
        candlesCandlesCount: 3,
        candleTimes: [1700007200, 1700003600, 1700000000],
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: {
                yes: [{ time: 1700000000, close: '0.42' }, { time: 1700003600, close: '0.45' }],
                no: [{ time: 1700007200, close: '0.58' }],
                spot: [],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'chartCandlesAreSubsetOfDirect');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /3 api candles \(yes=2 \+ no=1\) all match direct times/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: chartCandlesAreSubsetOfDirect (api fabricates a timestamp the indexer never emitted)', async () => {
    // Direct has 3 candles at {1700000000, 1700003600, 1700007200}.
    // API returns yes=[1700000000, 1700099999] — the second time is
    // NOT in direct's set. Cache key mismatch / transform regression
    // / period-boundary off-by-one all manifest this way.
    //
    // Count check still passes (api total 2 + 0 = 2 ≤ direct 3) — only
    // the per-row time check catches this. That's the value of this
    // invariant: it strengthens the count bound into a per-time-pair
    // membership check. DESCENDING order keeps candleTimeMonotonic happy.
    const fx = await startFixture({
        candlesCandlesCount: 3,
        candleTimes: [1700007200, 1700003600, 1700000000],
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: {
                yes: [
                    { time: 1700000000, close: '0.42' },
                    { time: 1700099999, close: '0.43' },  // NOT in direct
                ],
                no: [],
                spot: [],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'chartCandlesAreSubsetOfDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /api candles\.yes\[1\]\.time=1700099999 not in direct candles time set/);
        // Count check STILL passes (2 ≤ 3) — only per-row time
        // membership catches this fabrication. Demonstrates the
        // value-add of this invariant over chartCandleCountsBoundedByDirect.
        const counts = results.find((r) => r.name === 'chartCandleCountsBoundedByDirect');
        assert.equal(counts.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: chartCandlesAreSubsetOfDirect (api emits non-finite time — transform regression)', async () => {
    // Transform bug: a parseInt() on the period boundary returned
    // NaN and the api stringified it (which becomes 'NaN' or 'invalid').
    // Direct has data; api row's time is non-finite.
    //
    // Note: we use the string 'invalid-time' (not null) because
    // Number(null) === 0 (finite) but Number('invalid-time') === NaN.
    // The transform bug we're catching is one that emits a string
    // representation of a parse failure.
    const fx = await startFixture({
        candlesCandlesCount: 1,
        candleTimes: [1700000000],
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: {
                yes: [{ time: 'invalid-time', close: '0.42' }],  // non-finite
                no: [],
                spot: [],
            },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'chartCandlesAreSubsetOfDirect');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /api candles\.yes\[0\]\.time not finite.*transform regression/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiUnifiedChartShape missing yes array (refactor that drops a side)', async () => {
    // Refactor that dropped the YES key (or renamed it) — frontend
    // crashes destructuring `candles.yes`. Catches a real UI-break
    // bug class.
    const fx = await startFixture({
        unifiedChartBody: JSON.stringify({
            metadata: {},
            candles: { no: [], spot: [] },  // missing yes
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /candles\.yes missing or not array|UI consumers crash/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiUnifiedChartHasObservabilityHeaders happy: X-Cache=MISS + X-Response-Time=12ms', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiUnifiedChartHasObservabilityHeaders');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /X-Cache=MISS, X-Response-Time=12ms/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiUnifiedChartHasObservabilityHeaders happy on HIT path', async () => {
    const fx = await startFixture({
        unifiedChartXCache: 'HIT',
        unifiedChartXResponseTime: '0ms',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiUnifiedChartHasObservabilityHeaders');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /X-Cache=HIT, X-Response-Time=0ms/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiUnifiedChartHasObservabilityHeaders X-Cache header dropped', async () => {
    // A refactor removed the cache layer or its instrumentation —
    // the body is fine but the X-Cache header is gone. Ops
    // dashboards go blind. apiUnifiedChartShape STILL passes since
    // body shape is unaffected.
    const fx = await startFixture({ unifiedChartXCache: null });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiUnifiedChartHasObservabilityHeaders');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /X-Cache header expected.*got null|cache layer instrumentation/);
        // Body-shape probe still passes — distinguishes header-only
        // regressions from body regressions
        const shape = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(shape.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiUnifiedChartHasObservabilityHeaders X-Cache=STALE (third state added without telling ops)', async () => {
    // A refactor added a third cache state that ops dashboards
    // don't know about (e.g., 'STALE' for serve-stale-while-
    // revalidate). The HIT/MISS-only pie chart now has a hidden
    // bucket.
    const fx = await startFixture({ unifiedChartXCache: 'STALE' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiUnifiedChartHasObservabilityHeaders');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /expected 'HIT' or 'MISS', got "STALE"/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiUnifiedChartHasObservabilityHeaders X-Response-Time wrong format', async () => {
    // Timing instrumentation regression — emits raw ms count
    // without unit suffix.
    const fx = await startFixture({ unifiedChartXResponseTime: '12' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiUnifiedChartHasObservabilityHeaders');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /X-Response-Time expected.*got "12"|timing-instrumentation/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — apiMarketEventsShape happy: 200 + full contract shape', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'apiMarketEventsShape');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /yes=\$0\.55, no=\$0\.45/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiMarketEventsShape data-plane error (500 from pool resolve)', async () => {
    const fx = await startFixture({
        marketEventsStatus: 500,
        marketEventsBody: JSON.stringify({ error: 'pool resolve failed' }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiMarketEventsShape');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /expected 200, got 500|data plane broken/);
        // OTHER api endpoints still pass — distinguishes per-endpoint
        // failure from api-wide outage
        const chart = results.find((r) => r.name === 'apiUnifiedChartShape');
        assert.equal(chart.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiMarketEventsShape status field renamed', async () => {
    // 'status' literal is the consumer branch point — if it's
    // renamed (or removed when the api unifies envelope shapes
    // across endpoints), every consumer's "status === 'ok'" branch
    // breaks silently.
    const fx = await startFixture({
        marketEventsBody: JSON.stringify({
            state: 'ok',  // wrong key
            conditional_yes: { price_usd: 0.55, pool_id: 'mock-pool-yes' },
            conditional_no: { price_usd: 0.45, pool_id: 'mock-pool-no' },
            spot: { price_usd: 1.05 },
            timeline: { start: 1700000000, end: 1700864000 },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiMarketEventsShape');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /response\.status expected 'ok'|consumers branch on this literal/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: apiMarketEventsShape conditional_yes missing (pool resolve null without proper error path)', async () => {
    // Pool resolve returned null but the response shape didn't
    // degrade gracefully — conditional_yes key just missing.
    // UI dashboard crashes destructuring.
    const fx = await startFixture({
        marketEventsBody: JSON.stringify({
            status: 'ok',
            // conditional_yes intentionally missing
            conditional_no: { price_usd: 0.45, pool_id: 'mock-pool-no' },
            spot: { price_usd: 1.05 },
            timeline: { start: 1700000000, end: 1700864000 },
        }),
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'apiMarketEventsShape');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /conditional_yes missing or not object|UI dashboard crashes/);
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
    const fx = await startFixture({
        registryAggregatorsCount: 0,
        // Also turn off prod injection so registryHasFutarchyProdAggregator
        // doesn't quietly mask the empty-aggregators case
        includeFutarchyProdAggregator: false,
    });
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

test('runAllInvariants — registryHasFutarchyProdAggregator happy: prod address present', async () => {
    // Defaults: includeFutarchyProdAggregator=true → prod address
    // appended to aggregator list.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'registryHasFutarchyProdAggregator');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /prod aggregator 0xc5eb43d5… present \(2 total\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — registryHasFutarchyProdAggregator vacuous when no aggregators', async () => {
    const fx = await startFixture({
        registryAggregatorsCount: 0,
        includeFutarchyProdAggregator: false,
    });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'registryHasFutarchyProdAggregator');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no aggregators .*registryHasAggregators concern/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: registryHasFutarchyProdAggregator prod missing (wrong start_block / wrong chain)', async () => {
    // Indexer has aggregators but the prod one is missing — likely
    // bootstrapped against a too-early block, wrong chain, or had
    // its data wiped without re-syncing the deployment event.
    const fx = await startFixture({
        registryAggregatorsCount: 3,        // some aggregators exist
        includeFutarchyProdAggregator: false, // but NOT the prod one
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'registryHasFutarchyProdAggregator');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /prod aggregator 0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1 not in indexer|wrong start_block|wrong chain/);
        // registryHasAggregators STILL passes (3 aggregators exist) —
        // distinguishes "no aggregators at all" (existence concern)
        // from "wrong specific aggregators" (this invariant's
        // concern)
        const exists = results.find((r) => r.name === 'registryHasAggregators');
        assert.equal(exists.ok, true);
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

test('runAllInvariants — candlePricesNonNegative happy: all OHLC ≥ 0', async () => {
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'candlePricesNonNegative');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /OHLC all ≥ 0.*open=0\.45.*high=0\.5.*low=0\.4.*close=0\.48/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — candlePricesNonNegative vacuously true with no candles', async () => {
    const fx = await startFixture({ candlesCandlesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'candlePricesNonNegative');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no candles to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candlePricesNonNegative all-negative OHLC (ordering passes by accident)', async () => {
    // All-negative satisfies "low ≤ open, close ≤ high" — ordering
    // check is happy. probabilityBounds is vacuous for non-PREDICTION
    // pool. This invariant catches what the others miss.
    const fx = await startFixture({
        poolType: 'CONDITIONAL',  // probabilityBounds vacuous
        latestCandleLow: '-3.0',
        latestCandleHigh: '-1.0',
        latestCandleOpen: '-2.0',
        latestCandleClose: '-2.5',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candlePricesNonNegative');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /(open|high|low|close)=-?\d+(\.\d+)? < 0|sign-bug leak/);
        // candleOHLCOrdering STILL passes — proves the gap exists
        const ohlc = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(ohlc.ok, true);
        // probabilityBounds vacuous on CONDITIONAL — proves it doesn't
        // help here either
        const prob = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(prob.ok, true);
        assert.match(prob.detail, /not PREDICTION/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: candlePricesNonNegative mixed-sign OHLC (low<0 but high>0)', async () => {
    // Subtler case: low is negative, high is positive. Ordering
    // PASSES (low ≤ open ≤ high holds with open=-0.5 between -1 and 1).
    // probabilityBounds catches close < 0 for PREDICTION pools, but
    // close here is 0.5 (positive); only OPEN is negative. Universal
    // sign check is the only one that catches this.
    const fx = await startFixture({
        // Keep pool type PREDICTION to show even this case slips
        // probabilityBounds (since probabilityBounds only checks close)
        poolType: 'PREDICTION',
        latestCandleLow: '-1.0',
        latestCandleHigh: '1.0',
        latestCandleOpen: '-0.5',
        latestCandleClose: '0.5',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'candlePricesNonNegative');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /open=-0\.5 < 0|sign-bug leak/);
        // Ordering passes (low ≤ open ≤ high holds for negatives too)
        const ohlc = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(ohlc.ok, true);
        // probabilityBounds passes — close=0.5 is in [0,1]
        const prob = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(prob.ok, true);
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

test('runAllInvariants — probabilityBounds happy: PREDICTION pool, close=0.48 ∈ [0, 1]', async () => {
    // Defaults: poolType='PREDICTION', latestCandleClose='0.48'.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /candle mock-candle-0 \(PREDICTION\): close=0\.48 ∈ \[0, 1\]/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — probabilityBounds vacuously true for CONDITIONAL pools (price isn\'t a probability)', async () => {
    // CONDITIONAL pools are YES_TOKEN/YES_CURRENCY ratios, often >1.
    // The invariant SHOULD skip them rather than false-fail.
    const fx = await startFixture({
        poolType: 'CONDITIONAL',
        latestCandleClose: '2.5',
        latestCandleHigh: '3.0',
        latestCandleLow: '2.0',
        latestCandleOpen: '2.2',
    });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /CONDITIONAL.*not PREDICTION|bounds don't apply/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: probabilityBounds raw uint256 leak (close=1e18)', async () => {
    // Indexer regression that returns raw uint256 as decimal string.
    // 1e18 = 1000000000000000000 — vastly outside [0, 1].
    const fx = await startFixture({
        latestCandleClose: '1000000000000000000',
        // Set high/low to satisfy OHLC ordering so this isolates
        // the magnitude bug from the ordering bug
        latestCandleHigh: '1000000000000000000',
        latestCandleLow: '1000000000000000000',
        latestCandleOpen: '1000000000000000000',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /close=1000000000000000000 > 1|raw uint256 leak/);
        // OHLC ordering passes — distinguishes magnitude bug from
        // ordering bug
        const ohlc = results.find((r) => r.name === 'candleOHLCOrdering');
        assert.equal(ohlc.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: probabilityBounds negative close (sign-bug leak)', async () => {
    // Sign bug in price-derivation handler — probability landed at
    // a negative value. Impossible by AMM construction; clear bug.
    const fx = await startFixture({
        latestCandleClose: '-0.25',
        // OHLC ordering preserved
        latestCandleHigh: '0.10',
        latestCandleLow: '-0.30',
        latestCandleOpen: '-0.20',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /close=-0\.25 < 0|sign bug|probabilities can't be negative/);
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

test('runAllInvariants — swapAmountsBoundedAbove happy: small decimal amounts', async () => {
    // Defaults: amountIn=10.5, amountOut=4.2 — both well under 1e15.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'swapAmountsBoundedAbove');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /amountIn=10\.5, amountOut=4\.2 both < /);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — swapAmountsBoundedAbove vacuously true with no swaps', async () => {
    const fx = await startFixture({ candlesSwapsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'swapAmountsBoundedAbove');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no swaps to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swapAmountsBoundedAbove raw uint256 leak (amountIn=1e18)', async () => {
    // The bug: indexer emits amountIn as "1000000000000000000" (raw
    // uint256, 1 token at 18 decimals) instead of decimal "1.0".
    // parseFloat returns 1e18, which is huge.
    const fx = await startFixture({
        latestSwapAmountIn: '1000000000000000000',
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapAmountsBoundedAbove');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /raw uint256 leak|amountIn=1e\+18/);
        // swapAmountsPositive STILL passes — the value IS positive,
        // just astronomically too large. Distinguishes magnitude
        // bug from sign bug.
        const positive = results.find((r) => r.name === 'swapAmountsPositive');
        assert.equal(positive.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: swapAmountsBoundedAbove huge amountOut (token-decimal misalignment)', async () => {
    // Scenario: a refactor that scales by 1e6 instead of 1e0 (wrong
    // token decimals). amountOut becomes a 12-digit number.
    const fx = await startFixture({
        latestSwapAmountOut: '4200000000000000',  // 4.2 * 1e15
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'swapAmountsBoundedAbove');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /amountOut=.*≥ 1000000000000000|raw uint256 leak/);
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

test('runAllInvariants — proposalEntityOrganizationReferentialIntegrity happy: proposal references existing org', async () => {
    // Defaults: 1 organization (mock-org-0), 1 proposalEntity
    // defaulting to organization.id="mock-org-0". FK intact.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'proposalEntityOrganizationReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /proposalEntity mock-prop-entity-0 → organization mock-org-0 \(FK intact/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — proposalEntityOrganizationReferentialIntegrity vacuously true with no proposalEntities', async () => {
    const fx = await startFixture({ registryProposalEntitiesCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'proposalEntityOrganizationReferentialIntegrity');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no proposalEntities to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: proposalEntityOrganizationReferentialIntegrity orphan proposal (FK derivation bug)', async () => {
    // Proposal references a nonexistent org — proposal-event
    // handler derived FK wrong.
    const fx = await startFixture({
        registryOrganizationsCount: 2,
        proposalEntityOrganizationIds: ['nonexistent-org-xyz'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'proposalEntityOrganizationReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references organization nonexistent-org-xyz but no such organization|orphan proposal/);
        // Existence + the OTHER registry FK still pass — distinguishes
        // "proposal-handler FK bug" from "org-handler FK bug"
        const orgInv = results.find((r) => r.name === 'organizationAggregatorReferentialIntegrity');
        assert.equal(orgInv.ok, true);
        const propsExist = results.find((r) => r.name === 'registryHasProposalEntities');
        assert.equal(propsExist.ok, true);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: proposalEntityOrganizationReferentialIntegrity all orgs deleted (orphan-storm)', async () => {
    // Organizations wiped; proposal sync may continue independently
    // and its FK becomes stale. Catches schema migrations that
    // dropped Organization rows without GC-ing ProposalEntity.
    const fx = await startFixture({
        registryOrganizationsCount: 0,
        registryProposalEntitiesCount: 1,
        proposalEntityOrganizationIds: ['mock-org-0'],
    });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'proposalEntityOrganizationReferentialIntegrity');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /references organization mock-org-0 but no such organization/);
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

test('runAllInvariants — poolTypeIsValidEnum happy: PREDICTION pool', async () => {
    // Defaults: 1 pool with type='PREDICTION'.
    const fx = await startFixture();
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'poolTypeIsValidEnum');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /1 pool\(s\) all have valid enum type \(saw: PREDICTION\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — poolTypeIsValidEnum happy: CONDITIONAL pool', async () => {
    const fx = await startFixture({ poolType: 'CONDITIONAL' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, true);
        const inv = results.find((r) => r.name === 'poolTypeIsValidEnum');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /saw: CONDITIONAL/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — poolTypeIsValidEnum vacuously true with no pools', async () => {
    const fx = await startFixture({ candlesPoolsCount: 0 });
    try {
        const { results } = await runAllInvariants(fullCtx(fx.url));
        const inv = results.find((r) => r.name === 'poolTypeIsValidEnum');
        assert.equal(inv.ok, true);
        assert.match(inv.detail, /no pools to check \(vacuously true\)/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: poolTypeIsValidEnum typo (PRDICTION instead of PREDICTION)', async () => {
    // Typo bug — passes existence + FK checks, slips probabilityBounds
    // (which treats non-PREDICTION as vacuous), but is silently
    // dropped by api's findPoolByOutcome() lookup. This invariant
    // catches the typo at the indexer layer.
    const fx = await startFixture({ poolType: 'PRDICTION' });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'poolTypeIsValidEnum');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /type="PRDICTION" ∉|schema drift|typo|api adapter/);
        // candlesHasPools STILL passes (existence is fine)
        const exists = results.find((r) => r.name === 'candlesHasPools');
        assert.equal(exists.ok, true);
        // probabilityBounds STILL passes (vacuous on non-PREDICTION)
        const prob = results.find((r) => r.name === 'probabilityBounds');
        assert.equal(prob.ok, true);
        assert.match(prob.detail, /not PREDICTION|bounds don't apply/);
    } finally {
        await fx.stop();
    }
});

test('runAllInvariants — failure: poolTypeIsValidEnum null type (handler regression)', async () => {
    // Indexer regression that drops the type field write — pool
    // exists with null type. Passes every other check.
    const fx = await startFixture({ poolType: null });
    try {
        const { pass, results } = await runAllInvariants(fullCtx(fx.url));
        assert.equal(pass, false);
        const inv = results.find((r) => r.name === 'poolTypeIsValidEnum');
        assert.equal(inv.ok, false);
        assert.match(inv.error, /type=null ∉|schema drift|null/);
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
    assert.match(r.stdout, /apiSpotCandlesHappyPath/);
    assert.match(r.stdout, /apiUnifiedChartShape/);
    assert.match(r.stdout, /apiUnifiedChartHasObservabilityHeaders/);
    assert.match(r.stdout, /chartCandleCountsBoundedByDirect/);
    assert.match(r.stdout, /apiMarketEventsShape/);
    assert.match(r.stdout, /apiCanReachRegistry/);
    assert.match(r.stdout, /apiCanReachCandles/);
    assert.match(r.stdout, /apiCandlesMatchesDirect/);
    assert.match(r.stdout, /apiRegistryMatchesDirect/);
    assert.match(r.stdout, /registryDirect/);
    assert.match(r.stdout, /candlesDirect/);
    assert.match(r.stdout, /registryHasProposalEntities/);
    assert.match(r.stdout, /registryHasOrganizations/);
    assert.match(r.stdout, /registryHasAggregators/);
    assert.match(r.stdout, /registryHasFutarchyProdAggregator/);
    assert.match(r.stdout, /candlesHasPools/);
    assert.match(r.stdout, /poolTypeIsValidEnum/);
    assert.match(r.stdout, /candlesHasSwaps/);
    assert.match(r.stdout, /candlesHasCandles/);
    assert.match(r.stdout, /candleOHLCOrdering/);
    assert.match(r.stdout, /candleVolumesNonNegative/);
    assert.match(r.stdout, /candlePricesNonNegative/);
    assert.match(r.stdout, /probabilityBounds/);
    assert.match(r.stdout, /swapAmountsPositive/);
    assert.match(r.stdout, /swapAmountsBoundedAbove/);
    assert.match(r.stdout, /swapTimestampSensible/);
    assert.match(r.stdout, /candleTimeMonotonic/);
    assert.match(r.stdout, /swapTimeMonotonicNonStrict/);
    assert.match(r.stdout, /swapPoolReferentialIntegrity/);
    assert.match(r.stdout, /candlePoolReferentialIntegrity/);
    assert.match(r.stdout, /candleSwapTimeWindowConsistency/);
    assert.match(r.stdout, /organizationAggregatorReferentialIntegrity/);
    assert.match(r.stdout, /proposalEntityOrganizationReferentialIntegrity/);
    assert.match(r.stdout, /anvilBlockNumber/);
    assert.match(r.stdout, /anvilChainId/);
    assert.match(r.stdout, /anvilLatestBlockSensible/);
    assert.match(r.stdout, /anvilClientVersionMentionsAnvil/);
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
