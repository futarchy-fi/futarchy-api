/**
 * smoke-fork.test.mjs — Phase 1 end-to-end smoke.
 *
 * Validates that start-fork.mjs + block-clock.mjs work together against
 * a real Gnosis fork:
 *
 *   1. Spawn start-fork.mjs as a child process (ephemeral port).
 *   2. Wait for the "READY <port>" signal on its stdout.
 *   3. Use block-clock helpers to:
 *      - read chainId (must be 100)
 *      - read blockNumber (must be > 0 — it's a real fork)
 *      - take a snapshot
 *      - mine 5 blocks
 *      - revert to the snapshot
 *      - confirm height is restored
 *   4. Send SIGTERM to start-fork; wait for clean exit.
 *
 * This test is INTENTIONALLY NOT in `auto-qa/tests/` — it requires:
 *   - foundry/anvil installed locally
 *   - network reachability to a public Gnosis archive RPC
 *   - ~5 seconds runtime (fork download + RPC probes)
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-fork.test.mjs
 * or:        npm run auto-qa:e2e:smoke (added in this commit)
 *
 * If anvil is not on PATH, the test fails with a clear install hint.
 * If the public RPC is unreachable, the readiness probe in start-fork
 * times out at 30s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import {
    chainId,
    blockNumber,
    snapshot,
    revert,
    mineBlock,
} from '../scripts/block-clock.mjs';
import { detectAnvil } from '../scripts/detect-anvil.mjs';

// Pick a port unlikely to collide with anything else on a dev box.
const PORT = Number(process.env.HARNESS_TEST_PORT) || 8546;
const FORK_URL = process.env.FORK_URL || 'https://rpc.gnosis.gateway.fm';
const RPC = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 60_000;

/**
 * Spawn start-fork.mjs and wait for the READY line.
 * Returns {child, fullStdout} where fullStdout is the captured READY line.
 * The caller is responsible for SIGTERM.
 */
function spawnFork(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                new URL('../scripts/start-fork.mjs', import.meta.url).pathname,
                '--port', String(port),
                '--chain-id', '100',
                '--fork-url', FORK_URL,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        let stdoutBuf = '';
        let resolved = false;
        const onReady = (line) => {
            if (resolved) return;
            resolved = true;
            resolve({ child, readyLine: line });
        };

        child.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString();
            const m = stdoutBuf.match(/^READY\s+(\d+)\s*$/m);
            if (m) onReady(m[0]);
        });
        child.stderr.on('data', (chunk) => {
            // Surface anvil errors to the test runner output.
            process.stderr.write(`[smoke-fork] ${chunk}`);
        });
        child.on('exit', (code, signal) => {
            if (!resolved) {
                reject(new Error(
                    `start-fork exited before READY (code=${code}, signal=${signal})`,
                ));
            }
        });

        const timer = setTimeout(() => {
            if (resolved) return;
            child.kill('SIGTERM');
            reject(new Error(
                `start-fork did not emit READY within ${READY_TIMEOUT_MS}ms`,
            ));
        }, READY_TIMEOUT_MS);
        timer.unref();
    });
}

async function gracefulKill(child) {
    if (child.killed) return;
    child.kill('SIGTERM');
    await new Promise(res => child.on('exit', res));
}

test('Phase 1 smoke — start-fork spawns anvil, block-clock round-trips clean', async (t) => {
    // Pre-flight: skip cleanly if foundry isn't installed.
    const info = await detectAnvil();
    if (!info.found) {
        t.skip(`anvil not on PATH (${info.reason}). ${info.installHint}`);
        return;
    }

    const { child, readyLine } = await spawnFork(PORT);
    t.diagnostic(`start-fork ready: ${readyLine}`);

    try {
        // Pre-flight reads
        const cid = await chainId(RPC);
        assert.equal(cid, 100, 'chain ID must be 100 (Gnosis)');

        const initial = await blockNumber(RPC);
        assert.ok(initial > 0, `forked block number must be > 0 (was ${initial})`);
        t.diagnostic(`forked at block ${initial}`);

        // Pure mine — CHECKLIST.md Phase 1: "mine 10 blocks, confirm = N+10"
        const minedTen = await mineBlock(RPC, 10);
        assert.equal(minedTen, initial + 10,
            `mining 10 blocks should produce height ${initial + 10} (got ${minedTen})`);
        t.diagnostic(`mined 10 blocks: ${initial} → ${minedTen}`);

        // Snapshot → mine → revert round-trip — CHECKLIST.md Phase 1:
        // "snapshot → mine 5 blocks → revert → confirm at N"
        const snapId = await snapshot(RPC);
        assert.ok(typeof snapId === 'string' && snapId.startsWith('0x'),
            `snapshot must return a 0x-prefixed hex id (got ${snapId})`);

        const minedFive = await mineBlock(RPC, 5);
        assert.equal(minedFive, minedTen + 5,
            `5 more blocks after snapshot should produce height ${minedTen + 5} ` +
                `(got ${minedFive})`);

        const reverted = await revert(RPC, snapId);
        assert.equal(reverted, true, 'revert must report success');

        const after = await blockNumber(RPC);
        assert.equal(after, minedTen,
            `height should restore to ${minedTen} after revert (got ${after})`);

        t.diagnostic('snapshot/revert round-trip clean');

        // Time-pin: subsequent block timestamp should be controllable
        // (just verifying the helper doesn't throw — full TWAP-window
        // tests come in Phase 2)
        // Skipped here to keep the smoke fast.

        // Brief settle
        await wait(50);
    } finally {
        await gracefulKill(child);
    }
});
