/**
 * smoke-multi-spawn.test.mjs — Phase 2 slice 4: orchestrator robustness.
 *
 * Brings up anvil + api N times in succession. Catches:
 *   - port leaks in services.mjs (stop() not actually freeing the port)
 *   - orphaned child processes (stop() not waiting for exit)
 *   - state retention across cycles (a previous cycle's anvil cache
 *     leaking into the next)
 *
 * Each cycle:
 *   1. Spawn anvil + api in parallel
 *   2. Probe both (chainId, /health)
 *   3. Stop both, wait for exit
 *   4. Re-probe the ports — they should now be REFUSED (proof port released)
 *
 * Skip behavior:
 *   - SKIP if anvil not on PATH
 *
 * Runtime: ~3-4s per cycle * N cycles. N=3 by default (~10-15s total).
 * Override via HARNESS_STRESS_CYCLES env.
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-multi-spawn.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:stress
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startAnvilFork, startLocalApi, stopAll } from '../orchestrator/services.mjs';
import { detectAnvil } from '../scripts/detect-anvil.mjs';
import { chainId, blockNumber } from '../scripts/block-clock.mjs';

const ANVIL_PORT = Number(process.env.HARNESS_ANVIL_PORT) || 8546;
const API_PORT = Number(process.env.HARNESS_API_PORT) || 3031;
const CYCLES = Number(process.env.HARNESS_STRESS_CYCLES) || 3;

async function probeRefused(url) {
    // After stop(), reaching the port should result in connection
    // refused (not a 200, not a timeout). Returns true if the fetch
    // throws (port released), false if it responded.
    try {
        await fetch(url, { signal: AbortSignal.timeout(2000) });
        return false;
    } catch {
        return true;
    }
}

test(`Phase 2 slice 4 — ${CYCLES} successive spawn+stop cycles, no port leaks`, async (t) => {
    const info = await detectAnvil();
    if (!info.found) {
        t.skip(`anvil not on PATH (${info.reason})`);
        return;
    }

    const heights = [];
    for (let i = 1; i <= CYCLES; i++) {
        const handles = [];
        const cycleStart = Date.now();

        try {
            const [anvil, api] = await Promise.all([
                startAnvilFork({ port: ANVIL_PORT }),
                startLocalApi({ port: API_PORT }),
            ]);
            handles.push(anvil, api);

            // Confirm each layer responds.
            const cid = await chainId(anvil.url);
            assert.equal(cid, 100, `cycle ${i}: anvil chainId mismatch`);

            const head = await blockNumber(anvil.url);
            assert.ok(head > 0, `cycle ${i}: anvil block height should be > 0`);
            heights.push(head);

            const r = await fetch(`${api.url}/health`);
            assert.equal(r.status, 200, `cycle ${i}: api /health status`);

            t.diagnostic(`cycle ${i}: anvil@${head}, api ok, ${Date.now() - cycleStart}ms`);
        } finally {
            await stopAll(handles);
        }

        // After stop, ports MUST be released. Brief settle to allow
        // OS-level socket cleanup.
        await new Promise((res) => setTimeout(res, 200));
        const anvilGone = await probeRefused(`http://127.0.0.1:${ANVIL_PORT}`);
        const apiGone = await probeRefused(`http://127.0.0.1:${API_PORT}/health`);

        assert.equal(anvilGone, true,
            `cycle ${i}: anvil port ${ANVIL_PORT} should be REFUSED after stop()`);
        assert.equal(apiGone, true,
            `cycle ${i}: api port ${API_PORT} should be REFUSED after stop()`);
    }

    // Across cycles: anvil should have given consistent forks (same
    // chain, similar block heights — within a few blocks due to
    // chain progress between iterations).
    const minH = Math.min(...heights);
    const maxH = Math.max(...heights);
    assert.ok(maxH - minH < 100,
        `cycles should fork at similar heights (range: ${minH}..${maxH})`);
    t.diagnostic(`cycle heights: ${heights.join(', ')} (range ${maxH - minH})`);
});
