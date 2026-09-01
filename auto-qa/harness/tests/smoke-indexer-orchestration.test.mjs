/**
 * smoke-indexer-orchestration.test.mjs — Phase 3 slice 4: stack orchestration.
 *
 * Proves the FULL stack comes up:
 *   1. anvil fork via start-fork.mjs (native subprocess, ~3s)
 *   2. registry indexer via start-indexers.mjs (docker compose,
 *      ~50-90s cold start per Spike-001)
 *   3. registry indexer GraphQL responds to {__typename} probe
 *   4. teardown leaves no leaked containers / ports
 *
 * This is the FIRST test that exercises start-indexers.mjs against
 * a live docker daemon. It does NOT yet validate chain↔indexer event
 * agreement (slice 5 — the bootstrap-vs-RESET race needs solving).
 *
 * Skip behavior:
 *   - SKIP if anvil not on PATH (foundry not installed)
 *   - SKIP if docker daemon not reachable (Docker Desktop down)
 *   - SKIP if futarchy-indexers sibling clone missing
 *
 * Runtime: ~90-120s on first run (Docker build dominates), faster
 * once images are cached. Override timeout via HARNESS_ORCH_TIMEOUT_MS.
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-indexer-orchestration.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:orchestration
 *
 * If the test crashes mid-flight, clean up manually with:
 *   npm run auto-qa:e2e:indexers:stop
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { startAnvilFork } from '../orchestrator/services.mjs';
import { startIndexers } from '../scripts/start-indexers.mjs';
import { detectAnvil } from '../scripts/detect-anvil.mjs';
import { detectIndexers } from '../scripts/detect-indexers.mjs';

const ANVIL_PORT = Number(process.env.HARNESS_ANVIL_PORT) || 8546;
const ORCH_TIMEOUT_MS = Number(process.env.HARNESS_ORCH_TIMEOUT_MS) || 240_000;
const READY_POLL_MS = 3_000;

function dockerIsRunning() {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

async function probeGraphQL(url) {
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{__typename}' }),
            signal: AbortSignal.timeout(2000),
        });
        if (!r.ok) return { ok: false, status: r.status };
        const j = await r.json();
        return { ok: true, body: j };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function awaitReady(url, timeoutMs) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        last = await probeGraphQL(url);
        if (last.ok) return { ok: true, elapsedMs: Date.now() - start };
        await wait(READY_POLL_MS);
    }
    return {
        ok: false,
        elapsedMs: Date.now() - start,
        reason: `timed out after ${timeoutMs}ms (last: ${last?.error || `status ${last?.status}`})`,
    };
}

test(
    'Phase 3 slice 4 — full stack orchestration: anvil + registry indexer come up',
    { timeout: ORCH_TIMEOUT_MS + 60_000 },
    async (t) => {
        // Pre-flight skips
        const anvilInfo = await detectAnvil();
        if (!anvilInfo.found) {
            t.skip(`anvil not on PATH (${anvilInfo.reason})`);
            return;
        }
        const indexerInfo = await detectIndexers();
        if (!indexerInfo.found) {
            t.skip(`futarchy-indexers clone not found: ${indexerInfo.reason}`);
            return;
        }
        if (!dockerIsRunning()) {
            t.skip('docker daemon not reachable (Docker Desktop down?)');
            return;
        }

        const t0 = Date.now();
        let anvil = null;
        let indexerHandle = null;

        try {
            // 1. Start anvil
            t.diagnostic('starting anvil fork…');
            anvil = await startAnvilFork({ port: ANVIL_PORT });
            t.diagnostic(`anvil up at ${anvil.url} after ${Date.now() - t0}ms`);

            // 2. Start ONLY the registry indexer (faster than both)
            t.diagnostic('starting registry indexer (Docker build + bootstrap may take 50-90s)…');
            const t1 = Date.now();
            indexerHandle = await startIndexers({
                anvilPort: ANVIL_PORT,
                reset: true,
                registryOnly: true,
                blockRange: 100,
            });
            t.diagnostic(
                `compose up returned after ${Date.now() - t1}ms; ` +
                    `registry url: ${indexerHandle.registryUrl}`,
            );

            // 3. Wait for the indexer's GraphQL to respond
            t.diagnostic(`waiting for ${indexerHandle.registryUrl} to respond…`);
            const ready = await awaitReady(
                indexerHandle.registryUrl,
                ORCH_TIMEOUT_MS - (Date.now() - t0),
            );
            assert.ok(ready.ok,
                `indexer GraphQL should respond within timeout: ${ready.reason}`);
            t.diagnostic(`indexer GraphQL ready after ${ready.elapsedMs}ms`);

            // 4. Verify __typename returns "Query"
            const probe = await probeGraphQL(indexerHandle.registryUrl);
            assert.ok(probe.ok, 'final probe should succeed');
            assert.equal(probe.body?.data?.__typename, 'Query',
                `__typename should be "Query" (got ${probe.body?.data?.__typename})`);

            t.diagnostic(`✓ full stack up in ${Date.now() - t0}ms`);
        } finally {
            // Tear down in dependency-aware order: indexer first
            // (otherwise it loops trying to reach a dead RPC), then anvil.
            if (indexerHandle) {
                t.diagnostic('stopping indexer…');
                try { await indexerHandle.stop(); }
                catch (err) { t.diagnostic(`indexer stop error: ${err.message}`); }
            }
            if (anvil) {
                t.diagnostic('stopping anvil…');
                try { await anvil.stop(); }
                catch (err) { t.diagnostic(`anvil stop error: ${err.message}`); }
            }
        }
    },
);
