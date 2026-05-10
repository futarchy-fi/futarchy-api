/**
 * smoke-bootstrap-start-block.test.mjs — Phase 3 slice 3 contract test.
 *
 * Validates argument validation + error-handling layer of
 * bootstrap-start-block.mjs WITHOUT actually executing SQL (which
 * requires the indexer postgres containers to be UP, which requires
 * Docker daemon).
 *
 * Cases:
 *   1. CLI --help prints usage and exits 0
 *   2. CLI without --kind exits 1 with usage hint
 *   3. CLI with bad --kind exits 1
 *   4. CLI with valid --kind but no --start exits 1
 *   5. CLI with --start as negative exits 1
 *   6. CLI with valid args + daemon down exits 3 with clear message
 *   7. Programmatic: bootstrapStartBlock throws on bad startBlock (0 or negative)
 *   8. Programmatic: bootstrapStartBlock throws on unknown kind
 *
 * The "actually inject the row" path needs daemon up + indexers running;
 * that lands in slice 4's roundtrip smoke.
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-bootstrap-start-block.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:bootstrap
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { bootstrapStartBlock } from '../scripts/bootstrap-start-block.mjs';

const SCRIPT = new URL('../scripts/bootstrap-start-block.mjs', import.meta.url).pathname;

function dockerIsRunning() {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

test('Phase 3 slice 3 — CLI --help prints usage and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `--help should exit 0 (got ${r.status})`);
    assert.match(r.stdout, /bootstrap-start-block\.mjs — Forked Replay Harness/);
    assert.match(r.stdout, /--kind/);
    assert.match(r.stdout, /--start/);
    assert.match(r.stdout, /--read/);
});

test('Phase 3 slice 3 — CLI without --kind exits 1', () => {
    const r = spawnSync('node', [SCRIPT, '--start', '46100000'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `missing --kind should exit 1 (got ${r.status})`);
    assert.match(r.stderr, /missing required --kind/);
});

test('Phase 3 slice 3 — CLI with bad --kind exits 1', () => {
    const r = spawnSync('node', [SCRIPT, '--kind', 'bogus', '--start', '46100000'], {
        encoding: 'utf8',
    });
    assert.equal(r.status, 1, `bad --kind should exit 1 (got ${r.status})`);
    assert.match(r.stderr, /--kind must be one of: registry, candles/);
});

test('Phase 3 slice 3 — CLI with valid --kind but no --start exits 1', () => {
    const r = spawnSync('node', [SCRIPT, '--kind', 'registry'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `missing --start should exit 1 (got ${r.status})`);
    assert.match(r.stderr, /missing required --start/);
});

test('Phase 3 slice 3 — CLI with negative --start exits 1', () => {
    const r = spawnSync('node', [SCRIPT, '--kind', 'registry', '--start', '-5'], {
        encoding: 'utf8',
    });
    assert.equal(r.status, 1, `negative --start should exit 1 (got ${r.status})`);
    assert.match(r.stderr, /--start must be a non-negative integer/);
});

test('Phase 3 slice 3 — CLI with valid args + daemon down exits 3', (t) => {
    if (dockerIsRunning()) {
        t.skip('docker daemon is UP; this test requires daemon-down branch');
        return;
    }
    const r = spawnSync('node', [SCRIPT, '--kind', 'registry', '--start', '46100000'], {
        encoding: 'utf8',
    });
    assert.equal(r.status, 3, `daemon down should exit 3 (got ${r.status})`);
    assert.match(r.stderr, /docker daemon not reachable/i);
});

test('Phase 3 slice 3 — programmatic: bootstrapStartBlock throws on startBlock=0', async () => {
    await assert.rejects(
        () => bootstrapStartBlock({ kind: 'registry', startBlock: 0 }),
        /startBlock must be a positive integer/,
    );
});

test('Phase 3 slice 3 — programmatic: bootstrapStartBlock throws on negative startBlock', async () => {
    await assert.rejects(
        () => bootstrapStartBlock({ kind: 'registry', startBlock: -1 }),
        /startBlock must be a positive integer/,
    );
});

test('Phase 3 slice 3 — programmatic: bootstrapStartBlock throws on unknown kind', async () => {
    await assert.rejects(
        () => bootstrapStartBlock({ kind: 'bogus', startBlock: 100 }),
        /unknown kind/,
    );
});
