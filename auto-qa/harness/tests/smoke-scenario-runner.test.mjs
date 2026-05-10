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
    const candleTimeAnchor = Math.floor(Date.now() / 1000);
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
        return row;
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
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ data: { __typename: registryTypename } }));
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
                    // Return a superset response so __typename + data probes
                    // can be made against the same endpoint without the
                    // fixture having to parse the GraphQL query body.
                    const proposalEntities = Array.from({ length: registryProposalEntitiesCount },
                        (_, i) => ({ id: `mock-prop-entity-${i}` }));
                    const organizations = Array.from({ length: registryOrganizationsCount },
                        (_, i) => ({ id: `mock-org-${i}` }));
                    const aggregators = Array.from({ length: registryAggregatorsCount },
                        (_, i) => ({ id: `mock-agg-${i}` }));
                    response.end(JSON.stringify({
                        data: { __typename: registryDirectTypename, proposalEntities, organizations, aggregators },
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
