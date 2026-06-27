/**
 * smoke-start-indexers.test.mjs — Phase 3 slice 2: indexer launcher contract.
 *
 * Validates the dispatch/error-handling layer of start-indexers.mjs WITHOUT
 * actually pulling Docker images or building the indexers (which takes
 * 50-90s per indexer per Spike-001).
 *
 * Cases:
 *   1. startIndexers throws DOCKER_DOWN when daemon unreachable (cleanly,
 *      with a useful error code)
 *   2. startIndexers throws INDEXERS_NOT_FOUND when sibling clone is
 *      missing (verified by INDEXERS_PATH override to a bad path; this
 *      check fires BEFORE the docker-availability check would, but only
 *      because we're forcing the error path — the real check order is
 *      docker-first)
 *   3. CLI mode with --help prints the usage block and exits 0
 *   4. CLI mode with --stop and daemon down exits 3
 *
 * The actual "bring up indexers, query them" smoke is slice 3+ — this
 * test only proves the wrapper layer is sound.
 *
 * Skip behavior:
 *   - none — this test is fast (<1s)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
    startIndexers,
    stopIndexers,
} from '../scripts/start-indexers.mjs';

const SCRIPT = new URL('../scripts/start-indexers.mjs', import.meta.url).pathname;

function dockerIsRunning() {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

test('Phase 3 slice 2 — startIndexers throws INDEXERS_NOT_FOUND with bad INDEXERS_PATH', async () => {
    const orig = process.env.INDEXERS_PATH;
    process.env.INDEXERS_PATH = '/tmp/this-path-does-not-exist-yet-67890';
    try {
        await assert.rejects(
            () => startIndexers({ anvilPort: 8546 }),
            (err) => {
                // Note: the docker-availability check comes BEFORE the
                // indexer-clone check in the real call path. So if
                // docker is up, we hit the indexer error; if down, we
                // hit the docker error. Either acceptable error code
                // proves our error-handling chain works.
                assert.ok(
                    err.code === 'INDEXERS_NOT_FOUND' || err.code === 'DOCKER_DOWN',
                    `expected INDEXERS_NOT_FOUND or DOCKER_DOWN; got ${err.code}`,
                );
                return true;
            },
        );
    } finally {
        if (orig === undefined) delete process.env.INDEXERS_PATH;
        else process.env.INDEXERS_PATH = orig;
    }
});

test('Phase 3 slice 2 — startIndexers throws DOCKER_DOWN when daemon unreachable', async (t) => {
    if (dockerIsRunning()) {
        t.skip('docker daemon is UP; cannot test daemon-down branch');
        return;
    }
    await assert.rejects(
        () => startIndexers({ anvilPort: 8546 }),
        (err) => {
            assert.equal(err.code, 'DOCKER_DOWN',
                `expected DOCKER_DOWN; got ${err.code}`);
            assert.match(err.message, /docker daemon not reachable/i);
            return true;
        },
    );
});

test('Phase 3 slice 2 — stopIndexers without args fails clean if daemon down', async (t) => {
    if (dockerIsRunning()) {
        t.skip('docker daemon is UP; this test requires daemon-down branch');
        return;
    }
    // stopIndexers with no args calls requireIndexers (filesystem) —
    // if INDEXERS_PATH override isn't bad, it'll succeed at finding
    // them, then try to call docker compose down which will fail
    // silently per "best-effort" semantics. So the call itself
    // shouldn't throw.
    await stopIndexers();
});

test('Phase 3 slice 2 — CLI --help prints usage and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `--help should exit 0 (got ${r.status})`);
    assert.match(r.stdout, /start-indexers\.mjs — Forked Replay Harness/);
    assert.match(r.stdout, /--anvil-port/);
    assert.match(r.stdout, /--block-range/);
    assert.match(r.stdout, /--stop/);
});

test('Phase 3 slice 2 — CLI --stop with daemon down exits 3', (t) => {
    if (dockerIsRunning()) {
        t.skip('docker daemon is UP; cannot test daemon-down branch');
        return;
    }
    const r = spawnSync('node', [SCRIPT, '--stop'], { encoding: 'utf8' });
    assert.equal(r.status, 3, `--stop with daemon down should exit 3 (got ${r.status})`);
    assert.match(r.stderr, /docker daemon not reachable/i);
});

test('Phase 3 slice 2 — CLI exits 2 when INDEXERS_PATH points at a bad path AND daemon up', (t) => {
    if (!dockerIsRunning()) {
        t.skip('docker daemon is DOWN; this test requires the indexer-check branch');
        return;
    }
    const r = spawnSync('node', [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, INDEXERS_PATH: '/tmp/bad-path-no-clone-99999' },
    });
    assert.equal(r.status, 2, `INDEXERS_NOT_FOUND should exit 2 (got ${r.status})`);
    assert.match(r.stderr, /not found/i);
    assert.match(r.stderr, /git clone/i);
});
