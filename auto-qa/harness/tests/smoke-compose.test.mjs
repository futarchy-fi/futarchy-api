/**
 * smoke-compose.test.mjs — Phase 1 slice 2: docker compose validation.
 *
 * Validates that the compose file brings the `anvil` service up to a
 * healthy state and that the same block-clock smoke from
 * smoke-fork.test.mjs works against the compose-managed anvil.
 *
 * Behavior:
 *   - SKIP cleanly if `docker` not on PATH
 *   - SKIP cleanly if `docker info` fails (daemon down)
 *   - SKIP cleanly if compose file fails `docker compose config`
 *   - Otherwise: docker compose up -d anvil → wait for healthy →
 *     run mine/snapshot/revert round-trip → docker compose down
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-compose.test.mjs
 * or:        npm run auto-qa:e2e:smoke:compose
 *
 * Cleanup is best-effort — if the test crashes, run
 *   docker compose -f auto-qa/harness/docker-compose.yml down
 * manually.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import {
    chainId,
    blockNumber,
    snapshot,
    revert,
    mineBlock,
} from '../scripts/block-clock.mjs';

// ANVIL_HOST_PORT is also read by the compose file (with default 8545).
// Using 8547 to avoid colliding with smoke-fork.test.mjs (uses 8546)
// or any local dev anvil on 8545.
const PORT = Number(process.env.ANVIL_HOST_PORT) || 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const COMPOSE_PATH = new URL('../docker-compose.yml', import.meta.url).pathname;
const HEALTHY_TIMEOUT_MS = 90_000;
const HEALTHY_POLL_MS = 1_000;

function dockerAvailable() {
    const which = spawnSync('which', ['docker'], { encoding: 'utf8' });
    if (which.status !== 0) {
        return { ok: false, reason: 'docker not on PATH' };
    }
    const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    if (info.status !== 0) {
        return {
            ok: false,
            reason: 'docker daemon not reachable (start Docker Desktop or systemctl start docker)',
        };
    }
    const config = spawnSync(
        'docker',
        ['compose', '-f', COMPOSE_PATH, 'config'],
        { encoding: 'utf8' },
    );
    if (config.status !== 0) {
        return {
            ok: false,
            reason: `docker compose config failed: ${config.stderr || config.stdout}`,
        };
    }
    return { ok: true };
}

function composeUp() {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'docker',
            ['compose', '-f', COMPOSE_PATH, 'up', '-d', 'anvil'],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, ANVIL_HOST_PORT: String(PORT) },
            },
        );
        let stderrBuf = '';
        child.stderr.on('data', (c) => { stderrBuf += c.toString(); });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`compose up exited ${code}: ${stderrBuf}`));
        });
    });
}

function composeDown() {
    return new Promise((resolve) => {
        const child = spawn(
            'docker',
            ['compose', '-f', COMPOSE_PATH, 'down', '-v', '--timeout', '5'],
            { stdio: 'ignore' },
        );
        child.on('exit', () => resolve()); // best-effort cleanup
    });
}

async function awaitHealthy() {
    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < HEALTHY_TIMEOUT_MS) {
        const r = spawnSync(
            'docker',
            ['inspect', '-f', '{{.State.Health.Status}}', 'harness-anvil'],
            { encoding: 'utf8' },
        );
        lastStatus = (r.stdout || '').trim();
        if (lastStatus === 'healthy') return { ok: true, elapsedMs: Date.now() - start };
        if (lastStatus === 'unhealthy') {
            return { ok: false, reason: 'unhealthy', elapsedMs: Date.now() - start };
        }
        await wait(HEALTHY_POLL_MS);
    }
    return {
        ok: false,
        reason: `timed out waiting for healthy (last: ${lastStatus || 'no status'})`,
        elapsedMs: Date.now() - start,
    };
}

test('Phase 1 slice 2 — compose brings anvil up healthy + block-clock round-trips', async (t) => {
    const env = dockerAvailable();
    if (!env.ok) {
        t.skip(env.reason);
        return;
    }

    t.diagnostic('docker daemon available, bringing anvil up via compose');
    await composeUp();

    try {
        const health = await awaitHealthy();
        assert.ok(health.ok,
            `anvil should report healthy within ${HEALTHY_TIMEOUT_MS}ms ` +
                `(${health.reason || 'ok'}, elapsed ${health.elapsedMs}ms)`);
        t.diagnostic(`anvil healthy after ${health.elapsedMs}ms`);

        const cid = await chainId(RPC);
        assert.equal(cid, 100, 'chain ID must be 100 (Gnosis)');

        const initial = await blockNumber(RPC);
        assert.ok(initial > 0, `forked block number must be > 0 (was ${initial})`);
        t.diagnostic(`compose-managed anvil at block ${initial}`);

        const snapId = await snapshot(RPC);
        const mined = await mineBlock(RPC, 5);
        assert.equal(mined, initial + 5);
        const reverted = await revert(RPC, snapId);
        assert.equal(reverted, true);
        const after = await blockNumber(RPC);
        assert.equal(after, initial);

        t.diagnostic('snapshot/revert round-trip clean against compose-managed anvil');
    } finally {
        t.diagnostic('tearing down compose');
        await composeDown();
    }
});
