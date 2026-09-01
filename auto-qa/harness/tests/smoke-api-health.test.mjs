/**
 * smoke-api-health.test.mjs — Phase 2 entry: dual-source liveness.
 *
 * The first cross-layer check. The orchestrator starts BOTH:
 *   - a local anvil fork (Gnosis @ latest)
 *   - a local futarchy-api (src/index.js bound to 3031)
 *
 * and queries each via DIFFERENT codepaths:
 *   - anvil: JSON-RPC eth_blockNumber, eth_chainId
 *   - api:   GET /health, GET /warmer
 *
 * then asserts that BOTH respond with sane values. Once Phase 3
 * lands a local Checkpoint indexer, this test will be extended to
 * compare a real shared number (e.g., indexer head ↔ chain tip).
 *
 * IMPORTANT: src/index.js currently HARDCODES PORT = 3031 — it does
 * NOT read PORT from env. So this test will FAIL with EADDRINUSE if
 * any other futarchy-api instance is already running locally. Stop
 * any local dev server before running.
 *
 * Skip behavior:
 *   - SKIP if anvil not on PATH (foundry not installed)
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-api-health.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:api
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startAnvilFork, startLocalApi, stopAll } from '../orchestrator/services.mjs';
import { detectAnvil } from '../scripts/detect-anvil.mjs';
import { blockNumber, chainId } from '../scripts/block-clock.mjs';

const ANVIL_PORT = Number(process.env.HARNESS_ANVIL_PORT) || 8546;
const API_PORT = Number(process.env.HARNESS_API_PORT) || 3031;

test('Phase 2 — orchestrator dual-source: anvil + api both live', async (t) => {
    const info = await detectAnvil();
    if (!info.found) {
        t.skip(`anvil not on PATH (${info.reason})`);
        return;
    }

    const handles = [];
    try {
        // Bring both up in PARALLEL — a real harness scenario won't
        // serialize, so prove the orchestrator can.
        t.diagnostic('starting anvil + api in parallel');
        const t0 = Date.now();
        const [anvil, api] = await Promise.all([
            startAnvilFork({ port: ANVIL_PORT }),
            startLocalApi({ port: API_PORT }),
        ]);
        handles.push(anvil, api);
        t.diagnostic(`both services up after ${Date.now() - t0}ms`);

        // ── Source A: anvil RPC ──
        const cid = await chainId(anvil.url);
        assert.equal(cid, 100, `anvil should report Gnosis chainId 100 (got ${cid})`);

        const head = await blockNumber(anvil.url);
        assert.ok(head > 0, `anvil should be at a real block height (got ${head})`);
        t.diagnostic(`anvil at block ${head}`);

        // ── Source B: futarchy-api ──
        const healthRes = await fetch(`${api.url}/health`);
        assert.equal(healthRes.status, 200, `/health should return 200 (got ${healthRes.status})`);
        const health = await healthRes.json();
        assert.equal(health.status, 'ok', `/health.status should be 'ok' (got ${health.status})`);
        assert.ok(typeof health.timestamp === 'string', 'health.timestamp should be ISO string');
        t.diagnostic(`api /health.timestamp = ${health.timestamp}`);

        const warmerRes = await fetch(`${api.url}/warmer`);
        assert.equal(warmerRes.status, 200, `/warmer should return 200 (got ${warmerRes.status})`);
        const warmer = await warmerRes.json();
        assert.ok(warmer && typeof warmer === 'object', '/warmer should return an object');
        t.diagnostic(`api /warmer responded with ${Object.keys(warmer).length} keys`);

        // ── Cross-layer (Phase 3 placeholder) ──
        // Once the Checkpoint indexer joins via Phase 3, replace the
        // placeholder below with: assert indexer head == anvil head
        // (within a small tolerance for the freshly-spawned fork).
        // For now we just record the values for future comparison.
        t.diagnostic(
            `[Phase 3 placeholder] anvil head = ${head}; ` +
                `would compare to indexer-reported head once available.`,
        );
    } finally {
        await stopAll(handles);
    }
});
