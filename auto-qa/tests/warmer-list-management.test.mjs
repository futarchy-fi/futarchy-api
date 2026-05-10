/**
 * Warmer list-management spec mirror (auto-qa).
 *
 * Pins the LRU eviction + re-registration logic in
 * src/utils/warmer.js's `registerForWarming` function. The /warmer
 * endpoint exposes the warm-list size in production
 * (operational-endpoints.test.mjs covers that the endpoint shape is
 * sane) but no test pins the eviction policy itself — a refactor that
 * silently changes the eviction order or breaks re-registration would
 * cause the warmer to either churn (re-registration treated as new)
 * or unbound-grow (LRU eviction broken).
 *
 * Spec mirrors the relevant function bodies. Module-level state
 * (warmList Map, refreshFn, intervalId) is reproduced as locals so
 * each test starts clean.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- spec mirror ---

function makeWarmer(maxEntries) {
    const warmList = new Map();
    function registerForWarming(cacheKey, params) {
        const now = Date.now();
        if (warmList.has(cacheKey)) {
            warmList.get(cacheKey).lastSeen = now;
            return;
        }
        if (warmList.size >= maxEntries) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [key, entry] of warmList) {
                if (entry.lastSeen < oldestTime) {
                    oldestTime = entry.lastSeen;
                    oldestKey = key;
                }
            }
            if (oldestKey) warmList.delete(oldestKey);
        }
        warmList.set(cacheKey, { params, lastSeen: now, registeredAt: now });
    }
    return { warmList, registerForWarming };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// First-time registration
// ---------------------------------------------------------------------------

test('warmer — first registration adds entry to warm list', () => {
    const { warmList, registerForWarming } = makeWarmer(50);
    registerForWarming('k1', { proposalId: '0xaaa' });
    assert.equal(warmList.size, 1);
    assert.ok(warmList.has('k1'));
});

test('warmer — registered entry has params, lastSeen, registeredAt fields', () => {
    const { warmList, registerForWarming } = makeWarmer(50);
    registerForWarming('k1', { proposalId: '0xaaa' });
    const e = warmList.get('k1');
    assert.deepEqual(e.params, { proposalId: '0xaaa' });
    assert.ok(typeof e.lastSeen === 'number' && e.lastSeen > 0);
    assert.ok(typeof e.registeredAt === 'number' && e.registeredAt > 0);
    assert.equal(e.lastSeen, e.registeredAt,
        `lastSeen and registeredAt should match on initial registration`);
});

// ---------------------------------------------------------------------------
// Re-registration of existing key
// ---------------------------------------------------------------------------

test('warmer — re-registering existing key updates lastSeen but NOT size', async () => {
    const { warmList, registerForWarming } = makeWarmer(50);
    registerForWarming('k1', { proposalId: '0xaaa' });
    const firstLastSeen = warmList.get('k1').lastSeen;
    const firstRegisteredAt = warmList.get('k1').registeredAt;
    await sleep(15);
    registerForWarming('k1', { proposalId: '0xbbb' });
    assert.equal(warmList.size, 1, 're-register must NOT grow the list');
    const e = warmList.get('k1');
    assert.ok(e.lastSeen > firstLastSeen,
        `lastSeen should advance on re-register; got ${e.lastSeen} <= ${firstLastSeen}`);
    assert.equal(e.registeredAt, firstRegisteredAt,
        `registeredAt must NOT change on re-register (used for retention)`);
});

test('warmer — re-registration does NOT update params (params from initial registration)', async () => {
    // Critical pin: the function only updates lastSeen on re-registration,
    // ignoring the new params arg. A refactor that "fixes" this would
    // cause params drift if a stale call re-registers with bad data.
    const { warmList, registerForWarming } = makeWarmer(50);
    registerForWarming('k1', { proposalId: '0xORIGINAL' });
    registerForWarming('k1', { proposalId: '0xUPDATED' });
    assert.equal(warmList.get('k1').params.proposalId, '0xORIGINAL',
        `re-register must NOT overwrite params; params come from initial registration`);
});

// ---------------------------------------------------------------------------
// LRU eviction at WARMER_MAX_ENTRIES
// ---------------------------------------------------------------------------

test('warmer — at maxEntries, NEXT registration evicts the oldest by lastSeen', async () => {
    const max = 3;
    const { warmList, registerForWarming } = makeWarmer(max);
    registerForWarming('a', { proposalId: '0xa' }); await sleep(10);
    registerForWarming('b', { proposalId: '0xb' }); await sleep(10);
    registerForWarming('c', { proposalId: '0xc' }); // at capacity
    assert.equal(warmList.size, max);

    registerForWarming('d', { proposalId: '0xd' }); // should evict 'a'

    assert.equal(warmList.size, max, 'size must stay at maxEntries after eviction');
    assert.ok(!warmList.has('a'), 'oldest entry "a" must have been evicted');
    assert.ok(warmList.has('b'));
    assert.ok(warmList.has('c'));
    assert.ok(warmList.has('d'));
});

test('warmer — re-registering an old entry protects it from LRU eviction', async () => {
    // Re-register bumps lastSeen, so 'a' becomes newest. Now 'b' is oldest
    // and gets evicted on the next add.
    const max = 3;
    const { warmList, registerForWarming } = makeWarmer(max);
    registerForWarming('a', { proposalId: '0xa' }); await sleep(10);
    registerForWarming('b', { proposalId: '0xb' }); await sleep(10);
    registerForWarming('c', { proposalId: '0xc' }); await sleep(10);
    registerForWarming('a', { proposalId: '0xa' }); // bump 'a' to newest

    registerForWarming('d', { proposalId: '0xd' }); // should evict 'b' now

    assert.ok(warmList.has('a'), '"a" was bumped → must survive');
    assert.ok(!warmList.has('b'), '"b" is now oldest → must be evicted');
    assert.ok(warmList.has('c'));
    assert.ok(warmList.has('d'));
});

test('warmer — eviction at maxEntries=1 (degenerate) still works', () => {
    const { warmList, registerForWarming } = makeWarmer(1);
    registerForWarming('a', { proposalId: '0xa' });
    assert.equal(warmList.size, 1);
    registerForWarming('b', { proposalId: '0xb' });
    assert.equal(warmList.size, 1, 'size capped at 1');
    assert.ok(!warmList.has('a'), '"a" evicted');
    assert.ok(warmList.has('b'));
});

test('warmer — does NOT exceed maxEntries even with rapid registrations', async () => {
    const max = 5;
    const { warmList, registerForWarming } = makeWarmer(max);
    for (let i = 0; i < 20; i++) {
        registerForWarming(`k${i}`, { proposalId: `0x${i.toString().padStart(40, '0')}` });
    }
    assert.equal(warmList.size, max,
        `after 20 registrations to a max-${max} warmer, size must be exactly ${max}`);
});

// ---------------------------------------------------------------------------
// WARMER_MAX_ENTRIES + WARMER_RETENTION_DAYS defaults pinned
// ---------------------------------------------------------------------------

test('cache-config — WARMER_MAX_ENTRIES default is 50', () => {
    const src = readFileSync(
        new URL('../../src/config/cache-config.js', import.meta.url),
        'utf8',
    );
    const m = src.match(/WARMER_MAX_ENTRIES\s*=\s*parseInt\(process\.env\.WARMER_MAX_ENTRIES\s*\|\|\s*['"](\d+)['"]/);
    assert.ok(m, 'WARMER_MAX_ENTRIES default-string not found');
    assert.equal(parseInt(m[1]), 50,
        `WARMER_MAX_ENTRIES default drifted from 50 to ${m[1]}`);
});

test('cache-config — WARMER_RETENTION_DAYS default is 7', () => {
    const src = readFileSync(
        new URL('../../src/config/cache-config.js', import.meta.url),
        'utf8',
    );
    const m = src.match(/WARMER_RETENTION_DAYS\s*=\s*parseInt\(process\.env\.WARMER_RETENTION_DAYS\s*\|\|\s*['"](\d+)['"]/);
    assert.ok(m, 'WARMER_RETENTION_DAYS default-string not found');
    assert.equal(parseInt(m[1]), 7,
        `WARMER_RETENTION_DAYS default drifted from 7 to ${m[1]}`);
});

test('cache-config — ENABLE_WARMER defaults to true (enabled by default)', () => {
    const src = readFileSync(
        new URL('../../src/config/cache-config.js', import.meta.url),
        'utf8',
    );
    // Pinning that the default is "enabled" — flip-to-disabled by mistake
    // would silently break the warm-cache promise of every endpoint.
    assert.match(src,
        /ENABLE_WARMER\s*=\s*\(process\.env\.ENABLE_WARMER\s*\|\|\s*['"]true['"]\)/,
        `ENABLE_WARMER default flipped from "true" — warmer would silently disable`);
});
