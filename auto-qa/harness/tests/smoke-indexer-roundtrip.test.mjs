/**
 * smoke-indexer-roundtrip.test.mjs — Phase 3 slice 5: THE chain↔indexer invariant.
 *
 * The first test that proves the indexer correctly observes blocks
 * anvil produces. Full flow:
 *
 *   1. Start anvil at fork block N (~46100000)
 *   2. Start registry indexer with RESET=true (creates _metadatas
 *      table + inserts last_indexed_block=0)
 *   3. bootstrapAfterStart('registry', N): wait for table → UPDATE
 *      last_indexed_block to (N - 1) → restart indexer container
 *   4. Wait for indexer GraphQL to respond after restart
 *   5. Read last_indexed_block via psql → should advance to N
 *      within a small window
 *   6. Mine 5 blocks on anvil → height N+5
 *   7. Wait for indexer's last_indexed_block to reach N+5
 *   8. Tear down everything
 *
 * Skip behavior:
 *   - SKIP if anvil not on PATH
 *   - SKIP if indexer clone missing
 *   - SKIP if docker daemon unreachable
 *
 * Runtime: 90-180s (Docker build + initial scan + mine cycle).
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-indexer-roundtrip.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:roundtrip
 *
 * If the test crashes:
 *   npm run auto-qa:e2e:indexers:stop
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { startAnvilFork } from '../orchestrator/services.mjs';
import { startIndexers } from '../scripts/start-indexers.mjs';
import { bootstrapAfterStart, readStartBlock } from '../scripts/bootstrap-start-block.mjs';
import { detectAnvil } from '../scripts/detect-anvil.mjs';
import { detectIndexers } from '../scripts/detect-indexers.mjs';
import { blockNumber, mineBlock } from '../scripts/block-clock.mjs';

const ANVIL_PORT = Number(process.env.HARNESS_ANVIL_PORT) || 8546;
const READY_TIMEOUT_MS = Number(process.env.HARNESS_INDEXER_READY_MS) || 240_000;
const SYNC_TIMEOUT_MS = Number(process.env.HARNESS_INDEXER_SYNC_MS) || 60_000;
const POLL_MS = 2_000;

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
        if (!r.ok) return false;
        const j = await r.json();
        return j?.data?.__typename === 'Query';
    } catch { return false; }
}

async function awaitGraphQL(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await probeGraphQL(url)) return { ok: true, elapsedMs: Date.now() - start };
        await wait(POLL_MS);
    }
    return { ok: false, elapsedMs: Date.now() - start };
}

async function awaitIndexedAtLeast(kind, target, timeoutMs) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        try {
            last = await readStartBlock({ kind });
            if (last !== null && last >= target) {
                return { ok: true, last, elapsedMs: Date.now() - start };
            }
        } catch { /* postgres might be restarting */ }
        await wait(POLL_MS);
    }
    return { ok: false, last, elapsedMs: Date.now() - start };
}

test(
    'Phase 3 slice 5 — chain↔indexer roundtrip: indexer follows anvil',
    { timeout: READY_TIMEOUT_MS + SYNC_TIMEOUT_MS + 60_000 },
    async (t) => {
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
            t.skip('docker daemon not reachable');
            return;
        }

        const t0 = Date.now();
        let anvil = null;
        let indexerHandle = null;

        try {
            // 1. Start anvil
            t.diagnostic('starting anvil…');
            anvil = await startAnvilFork({ port: ANVIL_PORT });
            const initialHead = await blockNumber(anvil.url);
            t.diagnostic(`anvil at block ${initialHead}`);

            // 2. Start registry indexer with RESET=true
            t.diagnostic('starting registry indexer (Docker build + init)…');
            indexerHandle = await startIndexers({
                anvilPort: ANVIL_PORT,
                reset: true,
                registryOnly: true,
                blockRange: 100,
            });
            t.diagnostic(`indexer compose up; url=${indexerHandle.registryUrl}`);

            // Wait for the indexer GraphQL to respond at least once
            // (proves the table will exist soon)
            const ready1 = await awaitGraphQL(indexerHandle.registryUrl, READY_TIMEOUT_MS);
            assert.ok(ready1.ok,
                `indexer GraphQL should respond within ${READY_TIMEOUT_MS}ms`);
            t.diagnostic(`indexer first-ready after ${ready1.elapsedMs}ms`);

            // 3. bootstrapAfterStart: wait for table, UPDATE, restart
            t.diagnostic(`bootstrapping last_indexed_block to ${initialHead - 1}…`);
            const boot = await bootstrapAfterStart({
                kind: 'registry',
                startBlock: initialHead,
            });
            t.diagnostic(
                `bootstrap done: wrote ${boot.written}, ` +
                    `table appeared after ${boot.tableAvailableAfterMs}ms`,
            );

            // 4. Wait for GraphQL to come back after restart
            const ready2 = await awaitGraphQL(indexerHandle.registryUrl, READY_TIMEOUT_MS);
            assert.ok(ready2.ok,
                `indexer GraphQL should respond after restart within ${READY_TIMEOUT_MS}ms`);
            t.diagnostic(`indexer post-restart-ready after ${ready2.elapsedMs}ms`);

            // 5. Read last_indexed_block — should advance to >= initialHead soon
            const sync1 = await awaitIndexedAtLeast(
                'registry', initialHead, SYNC_TIMEOUT_MS,
            );
            assert.ok(sync1.ok,
                `indexer should reach anvil head ${initialHead} within ` +
                    `${SYNC_TIMEOUT_MS}ms (got ${sync1.last})`);
            t.diagnostic(`indexer reached ${sync1.last} after ${sync1.elapsedMs}ms`);

            // 6. Mine 5 blocks on anvil
            const newHead = await mineBlock(anvil.url, 5);
            assert.equal(newHead, initialHead + 5);
            t.diagnostic(`anvil mined: ${initialHead} → ${newHead}`);

            // 7. Wait for indexer to follow
            const sync2 = await awaitIndexedAtLeast(
                'registry', newHead, SYNC_TIMEOUT_MS,
            );
            assert.ok(sync2.ok,
                `indexer should follow to ${newHead} within ` +
                    `${SYNC_TIMEOUT_MS}ms (got ${sync2.last})`);
            t.diagnostic(`indexer followed to ${sync2.last} after ${sync2.elapsedMs}ms`);

            t.diagnostic(`✓ full roundtrip in ${Date.now() - t0}ms`);
        } finally {
            // Tear down indexer first (so it doesn't loop on dead anvil)
            if (indexerHandle) {
                try { await indexerHandle.stop(); }
                catch (err) { t.diagnostic(`indexer stop error: ${err.message}`); }
            }
            if (anvil) {
                try { await anvil.stop(); }
                catch (err) { t.diagnostic(`anvil stop error: ${err.message}`); }
            }
        }
    },
);
