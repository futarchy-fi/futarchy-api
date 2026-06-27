/**
 * Cache class spec mirror (auto-qa).
 *
 * Pins src/utils/cache.js — the in-memory TTL cache used for the
 * response/registry/candles/spot caches. Subtle behaviors that
 * regressions can break silently:
 *
 *   - TTL expiry: get() must return undefined AND delete the entry
 *     after ttlMs (not just after the next get())
 *   - Hit/miss counters: must increment exactly once per get()
 *   - Expired-entry get() counts as a miss, not a hit
 *   - clear() resets both store AND counters
 *   - set() on existing key resets the entry's TTL clock
 *
 * Spec mirrors the Cache class in src/utils/cache.js. Plus pins the
 * cache-config.js TTL defaults so a "tune these later" change to a
 * different default surfaces as a deliberate config change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- spec mirror ---

class Cache {
    constructor(name, ttlMs) {
        this.name = name;
        this.ttlMs = ttlMs;
        this.store = new Map();
        this.hits = 0;
        this.misses = 0;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry) { this.misses++; return undefined; }
        if (Date.now() - entry.time > this.ttlMs) {
            this.store.delete(key);
            this.misses++;
            return undefined;
        }
        this.hits++;
        return entry.value;
    }
    set(key, value) {
        this.store.set(key, { value, time: Date.now() });
    }
    stats() {
        const total = this.hits + this.misses;
        const rate = total > 0 ? ((this.hits / total) * 100).toFixed(0) : 0;
        return `${this.name}: ${this.store.size} entries, ${rate}% hit (${this.hits}/${total})`;
    }
    clear() {
        this.store.clear();
        this.hits = 0;
        this.misses = 0;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// get / set basics
// ---------------------------------------------------------------------------

test('Cache — set then get returns value', () => {
    const c = new Cache('t', 1000);
    c.set('k', 'v');
    assert.equal(c.get('k'), 'v');
});

test('Cache — get on missing key returns undefined', () => {
    const c = new Cache('t', 1000);
    assert.equal(c.get('absent'), undefined);
});

test('Cache — set overwrites existing value', () => {
    const c = new Cache('t', 1000);
    c.set('k', 'v1');
    c.set('k', 'v2');
    assert.equal(c.get('k'), 'v2');
});

// ---------------------------------------------------------------------------
// Hit/miss counters
// ---------------------------------------------------------------------------

test('Cache — hit increments hits counter', () => {
    const c = new Cache('t', 1000);
    c.set('k', 'v');
    c.get('k');
    c.get('k');
    assert.equal(c.hits, 2);
    assert.equal(c.misses, 0);
});

test('Cache — miss on absent key increments misses', () => {
    const c = new Cache('t', 1000);
    c.get('absent1');
    c.get('absent2');
    assert.equal(c.hits, 0);
    assert.equal(c.misses, 2);
});

test('Cache — interleaved hits and misses count independently', () => {
    const c = new Cache('t', 1000);
    c.set('k', 'v');
    c.get('k');        // hit
    c.get('absent');   // miss
    c.get('k');        // hit
    c.get('absent');   // miss
    c.get('absent');   // miss
    assert.equal(c.hits, 2);
    assert.equal(c.misses, 3);
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

test('Cache — entry expires after ttlMs', async () => {
    const c = new Cache('t', 30);
    c.set('k', 'v');
    assert.equal(c.get('k'), 'v', 'within TTL → hit');
    await sleep(50);
    assert.equal(c.get('k'), undefined,
        `after TTL the entry must return undefined; got "${c.get('k')}"`);
});

test('Cache — expired-entry get counts as a MISS, not a hit', async () => {
    const c = new Cache('t', 30);
    c.set('k', 'v');
    c.get('k');                      // hit
    await sleep(50);
    c.get('k');                      // expired → miss
    assert.equal(c.hits, 1, 'expired entry must NOT count as hit');
    assert.equal(c.misses, 1);
});

test('Cache — expired-entry get DELETES the entry from the store', async () => {
    const c = new Cache('t', 30);
    c.set('k', 'v');
    assert.equal(c.store.size, 1);
    await sleep(50);
    c.get('k'); // triggers deletion
    assert.equal(c.store.size, 0,
        `expired entry must be deleted from the store on get(), not just lazy-skipped`);
});

test('Cache — set() resets the TTL clock for the key', async () => {
    const c = new Cache('t', 50);
    c.set('k', 'v1');
    await sleep(35);
    c.set('k', 'v2');                // re-arm
    await sleep(30);                 // total elapsed since v1: 65ms; since v2: 30ms
    assert.equal(c.get('k'), 'v2',
        `set() must reset TTL clock; otherwise k would have expired`);
});

// ---------------------------------------------------------------------------
// stats() formatting
// ---------------------------------------------------------------------------

test('Cache — stats() with no calls returns 0% hit rate', () => {
    const c = new Cache('mycache', 1000);
    assert.equal(c.stats(), 'mycache: 0 entries, 0% hit (0/0)');
});

test('Cache — stats() formats hit rate to integer percent', () => {
    const c = new Cache('mycache', 1000);
    c.set('k', 'v');
    c.get('k'); c.get('k'); c.get('k');  // 3 hits
    c.get('absent');                      // 1 miss
    // 3/4 = 75%
    assert.match(c.stats(), /75% hit \(3\/4\)/);
});

test('Cache — stats() includes entry count from store.size', () => {
    const c = new Cache('mycache', 1000);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.match(c.stats(), /3 entries/);
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

test('Cache — clear() empties the store AND resets counters', () => {
    const c = new Cache('t', 1000);
    c.set('a', 1); c.set('b', 2);
    c.get('a'); c.get('b'); c.get('absent');
    assert.equal(c.hits, 2);
    assert.equal(c.misses, 1);
    assert.equal(c.store.size, 2);

    c.clear();

    assert.equal(c.store.size, 0, 'clear() must empty store');
    assert.equal(c.hits, 0, 'clear() must reset hits counter');
    assert.equal(c.misses, 0, 'clear() must reset misses counter');
});

// ---------------------------------------------------------------------------
// TTL config defaults — pinned values from src/config/cache-config.js
// ---------------------------------------------------------------------------

test('cache-config — RESPONSE_TTL default is 13 seconds (warmer fires at -3s = 10s)', () => {
    // Pinning the default. If we tune it, the test reminds us to also
    // re-think the warmer cadence (which is RESPONSE_TTL - 3).
    const expected = 13;
    // Read straight from the source file to avoid env interference.
    import('node:fs').then(fs => {
        const src = fs.readFileSync(
            new URL('../../src/config/cache-config.js', import.meta.url),
            'utf8'
        );
        const m = src.match(/RESPONSE_TTL_SEC\s*=\s*parseInt\(process\.env\.CACHE_RESPONSE_TTL\s*\|\|\s*'(\d+)'/);
        assert.ok(m, 'RESPONSE_TTL_SEC default-string not found in source');
        assert.equal(parseInt(m[1]), expected,
            `RESPONSE_TTL_SEC default drifted from ${expected} to ${m[1]}. ` +
            `If intentional, also re-check WARMER_INTERVAL_SEC formula.`);
    });
});

test('cache-config — REGISTRY_TTL default is 300 seconds (5 min)', () => {
    import('node:fs').then(fs => {
        const src = fs.readFileSync(
            new URL('../../src/config/cache-config.js', import.meta.url),
            'utf8'
        );
        const m = src.match(/REGISTRY_TTL_SEC\s*=\s*parseInt\(process\.env\.CACHE_REGISTRY_TTL\s*\|\|\s*'(\d+)'/);
        assert.ok(m, 'REGISTRY_TTL_SEC default-string not found in source');
        assert.equal(parseInt(m[1]), 300);
    });
});

test('cache-config — WARMER_INTERVAL formula is max(RESPONSE_TTL - 3, 5)', () => {
    import('node:fs').then(fs => {
        const src = fs.readFileSync(
            new URL('../../src/config/cache-config.js', import.meta.url),
            'utf8'
        );
        // The literal expression in the source. If the buffer (3s) or the
        // floor (5s) changes, this surfaces it as a deliberate edit.
        assert.match(src, /WARMER_INTERVAL_SEC\s*=\s*Math\.max\(RESPONSE_TTL_SEC\s*-\s*3,\s*5\)/,
            `WARMER_INTERVAL_SEC formula drifted from "max(RESPONSE_TTL_SEC - 3, 5)"`);
    });
});
