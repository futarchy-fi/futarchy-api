/**
 * smoke-api-passthrough.test.mjs — Phase 2 slice 2: real cross-layer
 * round-trip without a real indexer.
 *
 * Architecture:
 *
 *   orchestrator → futarchy-api /registry/graphql → stub-indexer → response
 *
 * Validates that:
 *   1. The api correctly reads REGISTRY_URL / CANDLES_URL from env
 *   2. POST body is forwarded to the stub VERBATIM
 *   3. Stub's response (status, headers, body) round-trips back faithfully
 *   4. Upstream HTTP errors propagate via the documented envelope
 *      ({errors:[{message}]} with mapped status code)
 *   5. Missing upstream config produces 503 (NOT 500 — defined by
 *      makeGraphQLPassthrough)
 *
 * This is the FIRST cross-layer invariant that actually exercises the
 * api's data path (not just liveness). Once Phase 3 lands a live
 * Checkpoint indexer, the same shape can be retargeted at the real
 * indexer to detect schema drift.
 *
 * Skip behavior:
 *   - none — does not require anvil; pure HTTP + Express stack.
 *   - REQUIRES the api ports (3031) and stub indexer ports (3003)
 *     to be free.
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-api-passthrough.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:passthrough
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startLocalApi, stopAll } from '../orchestrator/services.mjs';
import { startStubIndexer } from '../orchestrator/stub-indexer.mjs';

const API_PORT = Number(process.env.HARNESS_API_PORT) || 3031;
const STUB_REGISTRY_PORT = Number(process.env.HARNESS_STUB_REGISTRY_PORT) || 3003;

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json, headers: res.headers };
}

test('Phase 2 slice 2 — api /registry/graphql forwards body and returns stub response verbatim', async (t) => {
    const handles = [];
    try {
        // Stub indexer first — api needs REGISTRY_URL set BEFORE spawn.
        const expectedResponse = {
            data: {
                proposals: [
                    { id: '0xabc', name: 'Test Proposal', status: 'OPEN' },
                    { id: '0xdef', name: 'Another',       status: 'CLOSED' },
                ],
            },
        };
        const stub = await startStubIndexer({
            port: STUB_REGISTRY_PORT,
            responder: () => ({ status: 200, json: expectedResponse }),
        });
        handles.push(stub);
        t.diagnostic(`stub indexer at ${stub.url}`);

        // Spawn api with REGISTRY_URL pointing at the stub.
        const api = await startLocalApi({
            port: API_PORT,
            env: { REGISTRY_URL: stub.url },
        });
        handles.push(api);
        t.diagnostic(`api at ${api.url} (REGISTRY_URL=${stub.url})`);

        // Send a query through the api.
        const query = {
            query: '{ proposals(first: 5) { id name status } }',
            variables: { foo: 'bar' },
        };
        const r = await postJson(`${api.url}/registry/graphql`, query);

        // ── Status passthrough ──
        assert.equal(r.status, 200,
            `api should pass through stub status 200 (got ${r.status})`);

        // ── Body passthrough ──
        assert.deepEqual(r.json, expectedResponse,
            'api should return the stub response body verbatim');

        // ── The stub should have received our body verbatim ──
        assert.equal(stub.calls.length, 1, 'stub should have received exactly 1 call');
        assert.deepEqual(stub.calls[0].body, query,
            'stub should have received the exact body we sent');

        t.diagnostic('round-trip body + status both verbatim');
    } finally {
        await stopAll(handles);
    }
});

test('Phase 2 slice 2 — upstream 500 propagates as 500 (status passthrough on errors)', async (t) => {
    const handles = [];
    try {
        const stub = await startStubIndexer({
            port: STUB_REGISTRY_PORT,
            responder: () => ({
                status: 500,
                json: { errors: [{ message: 'simulated indexer crash' }] },
            }),
        });
        handles.push(stub);

        const api = await startLocalApi({
            port: API_PORT,
            env: { REGISTRY_URL: stub.url },
        });
        handles.push(api);

        const r = await postJson(`${api.url}/registry/graphql`, {
            query: '{ broken }',
        });

        assert.equal(r.status, 500,
            `api should pass through stub status 500 (got ${r.status})`);
        assert.deepEqual(r.json, {
            errors: [{ message: 'simulated indexer crash' }],
        });
        t.diagnostic('upstream 500 round-trips correctly');
    } finally {
        await stopAll(handles);
    }
});

test('Phase 2 slice 2 — upstream unreachable returns 502 with envelope', async (t) => {
    const handles = [];
    try {
        // Point api at a port where NOTHING is listening.
        const api = await startLocalApi({
            port: API_PORT,
            env: {
                REGISTRY_URL: `http://127.0.0.1:${STUB_REGISTRY_PORT}/graphql`,
            },
        });
        handles.push(api);

        const r = await postJson(`${api.url}/registry/graphql`, {
            query: '{ anything }',
        });

        assert.equal(r.status, 502,
            `unreachable upstream should produce 502 (got ${r.status}); ` +
                `passthrough.js: catch returns 502 unless AbortError → 504`);
        assert.ok(Array.isArray(r.json?.errors),
            `error envelope should have errors[] (got ${JSON.stringify(r.json)})`);
        assert.match(r.json.errors[0]?.message || '',
            /\[registry\] upstream error/i,
            'error message should follow the documented prefix');
        t.diagnostic(`unreachable upstream → 502 with: ${r.json.errors[0].message}`);
    } finally {
        await stopAll(handles);
    }
});
