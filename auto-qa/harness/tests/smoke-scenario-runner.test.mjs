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
    registryTypename = 'Query',
    candlesTypename = 'Query',
    // Direct-indexer probes (slice 4d-scenarios-more) hit /registry-direct/graphql
    // and /candles-direct/graphql so we can distinguish "via api" from
    // "direct" in the same fixture.
    registryDirectTypename = 'Query',
    candlesDirectTypename = 'Query',
    // Set to true to make the direct-indexer paths return 502, simulating
    // an indexer that's down even though the api passthrough still works
    // (e.g., api is caching).
    registryDirectDown = false,
    candlesDirectDown = false,
    // JSON-RPC mock at /rpc (slice 4d-scenarios-more rateSanity).
    // sDAIRateRaw is the BigInt raw rate to return; default is 1.2e18.
    // Set to 0n to simulate a broken contract; null to make eth_call error.
    sDAIRateRaw = (12n * 10n ** 17n),  // 1.2 * 1e18
    rpcError = null,
} = {}) {
    return new Promise((res) => {
        const server = createServer((req, response) => {
            req.on('data', () => {});
            req.on('end', () => {
                if (req.url === '/health' && req.method === 'GET') {
                    if (!healthOk) { response.statusCode = 503; response.end('down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (req.url === '/registry/graphql' && req.method === 'POST') {
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ data: { __typename: registryTypename } }));
                    return;
                }
                if (req.url === '/candles/graphql' && req.method === 'POST') {
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ data: { __typename: candlesTypename } }));
                    return;
                }
                if (req.url === '/registry-direct/graphql' && req.method === 'POST') {
                    if (registryDirectDown) { response.statusCode = 502; response.end('indexer down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ data: { __typename: registryDirectTypename } }));
                    return;
                }
                if (req.url === '/candles-direct/graphql' && req.method === 'POST') {
                    if (candlesDirectDown) { response.statusCode = 502; response.end('indexer down'); return; }
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ data: { __typename: candlesDirectTypename } }));
                    return;
                }
                if (req.url === '/rpc' && req.method === 'POST') {
                    response.setHeader('content-type', 'application/json');
                    if (rpcError) {
                        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: rpcError }));
                        return;
                    }
                    // Pad the rate to a 32-byte hex (64 chars after 0x).
                    const hex = sDAIRateRaw.toString(16).padStart(64, '0');
                    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + hex }));
                    return;
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
    assert.match(r.stdout, /apiCanReachRegistry/);
    assert.match(r.stdout, /apiCanReachCandles/);
    assert.match(r.stdout, /registryDirect/);
    assert.match(r.stdout, /candlesDirect/);
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
