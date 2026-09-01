/**
 * smoke-detect-indexers.test.mjs — Phase 3 slice 1.5: sibling-clone discovery.
 *
 * Validates that:
 *   - detectIndexers() finds the futarchy-indexers clone in the
 *     standard sibling location
 *   - The expected subdirs (registry + candles checkpoint) exist
 *   - The clone is at a real git revision
 *   - requireIndexers() throws cleanly with a clone hint when missing
 *     (simulated via INDEXERS_PATH override to a known-bad path)
 *
 * No anvil/docker dependency — pure filesystem/git probe.
 *
 * Run via:   node --test auto-qa/harness/tests/smoke-detect-indexers.test.mjs
 *       or:  npm run auto-qa:e2e:smoke:detect:indexers
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    detectIndexers,
    requireIndexers,
} from '../scripts/detect-indexers.mjs';

test('Phase 3 slice 1.5 — detectIndexers finds the local clone with both indexer subdirs', async (t) => {
    const info = await detectIndexers();
    if (!info.found) {
        // Don't fail hard — the clone might genuinely be absent on a
        // fresh dev box. Surface the hint and skip.
        t.skip(`futarchy-indexers clone not found: ${info.reason}\n${info.cloneHint}`);
        return;
    }

    assert.ok(info.root, 'root path should be present');
    assert.ok(info.registry?.compose, 'registry compose path should be set');
    assert.ok(info.candles?.compose, 'candles compose path should be set');
    assert.match(info.registry.compose, /futarchy-complete\/checkpoint\/docker-compose\.yml$/);
    assert.match(info.candles.compose, /proposals-candles\/checkpoint\/docker-compose\.yml$/);
    assert.ok(info.gitHead, `git HEAD should resolve (got ${info.gitHead})`);
    assert.equal(typeof info.gitDirty, 'boolean', 'gitDirty should be a boolean');

    t.diagnostic(`found at ${info.root} @ ${info.gitHead}${info.gitDirty ? ' (dirty)' : ''}`);
});

test('Phase 3 slice 1.5 — requireIndexers throws clean error with clone hint when missing', async () => {
    // Force a known-bad path to simulate "clone not present"
    const origEnv = process.env.INDEXERS_PATH;
    process.env.INDEXERS_PATH = '/tmp/this-path-definitely-does-not-exist-12345';

    try {
        await assert.rejects(
            () => requireIndexers(),
            (err) => {
                assert.equal(err.code, 'INDEXERS_NOT_FOUND',
                    `error code should be INDEXERS_NOT_FOUND (got ${err.code})`);
                assert.match(err.message, /not found/i);
                assert.match(err.message, /git clone/i, 'install hint should mention git clone');
                return true;
            },
        );
    } finally {
        if (origEnv === undefined) delete process.env.INDEXERS_PATH;
        else process.env.INDEXERS_PATH = origEnv;
    }
});
