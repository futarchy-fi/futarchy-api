/**
 * Chain-prefix helper spec mirror (auto-qa).
 *
 * Pins the three pure helpers in src/adapters/candles-adapter.js that
 * underpin the entire Checkpoint passthrough translation:
 *
 *   stripChainPrefix(id)             → "100-0xabc..." → "0xabc..."
 *   addChainPrefix(id, chainId=100)  → "0xabc..."     → "100-0xabc..."
 *   stripPrefixesAndNormalize(value) → recursive walker
 *
 * Plus the CHAIN_PREFIXED_RE pattern that gates the recursive strip.
 *
 * These functions translate IDs in BOTH directions across the proxy
 * boundary — every PR #4/#7/#8/#9 fix relied on getting them right.
 * A regression in any one of them returns wrong data for every
 * passthrough query (or 200-with-no-data, even worse since it looks
 * normal).
 *
 * Spec mirrors src/adapters/candles-adapter.js (the relevant function
 * bodies and the regex). The mirror omits production logging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- spec mirror ---

const CHAIN_PREFIXED_RE = /^\d+-0x[a-fA-F0-9]{40}$/;

function stripChainPrefix(id) {
    if (!id) return id;
    const match = id.match(/^\d+-(.+)$/);
    return match ? match[1] : id;
}

function addChainPrefix(id, chainId = 100) {
    if (!id) return id;
    if (/^\d+-/.test(id)) return id;  // don't double-prefix
    return `${chainId}-${id}`;
}

function stripPrefixesAndNormalize(value) {
    if (Array.isArray(value)) return value.map(stripPrefixesAndNormalize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'string' && CHAIN_PREFIXED_RE.test(v)) {
                out[k] = stripChainPrefix(v);
            } else {
                out[k] = stripPrefixesAndNormalize(v);
            }
        }
        return out;
    }
    return value;
}

const ADDR = '0xeb96dc321604aa7d82d34047281bd1ac7c4eac42';
const PREFIXED = `100-${ADDR}`;

// ---------------------------------------------------------------------------
// stripChainPrefix
// ---------------------------------------------------------------------------

test('stripChainPrefix — strips "100-" from a chain-prefixed address', () => {
    assert.equal(stripChainPrefix(PREFIXED), ADDR);
});

test('stripChainPrefix — handles other chain ids (1-, 137-)', () => {
    assert.equal(stripChainPrefix(`1-${ADDR}`), ADDR);
    assert.equal(stripChainPrefix(`137-${ADDR}`), ADDR);
});

test('stripChainPrefix — leaves bare address unchanged (idempotent)', () => {
    assert.equal(stripChainPrefix(ADDR), ADDR);
    // Idempotent under repeated application:
    assert.equal(stripChainPrefix(stripChainPrefix(PREFIXED)), ADDR);
});

test('stripChainPrefix — passes null/undefined/"" through unchanged', () => {
    assert.equal(stripChainPrefix(null), null);
    assert.equal(stripChainPrefix(undefined), undefined);
    assert.equal(stripChainPrefix(''), '');
});

test('stripChainPrefix — strips composite IDs (pool-period-ts shape)', () => {
    // Real Checkpoint IDs look like "1-0xabc...-3600-1758682800". The
    // strip removes only the leading "<digits>-" segment.
    const composite = `1-${ADDR}-3600-1758682800`;
    assert.equal(stripChainPrefix(composite), `${ADDR}-3600-1758682800`);
});

// ---------------------------------------------------------------------------
// addChainPrefix
// ---------------------------------------------------------------------------

test('addChainPrefix — prepends "100-" to a bare address (default chain)', () => {
    assert.equal(addChainPrefix(ADDR), PREFIXED);
});

test('addChainPrefix — uses provided chainId when given', () => {
    assert.equal(addChainPrefix(ADDR, 1), `1-${ADDR}`);
    assert.equal(addChainPrefix(ADDR, 137), `137-${ADDR}`);
});

test('addChainPrefix — does NOT double-prefix already-prefixed input', () => {
    // Critical idempotency invariant: the proxy may apply this in
    // multiple translation steps; a double-prefix breaks downstream lookups.
    assert.equal(addChainPrefix(PREFIXED), PREFIXED);
    assert.equal(addChainPrefix(`1-${ADDR}`), `1-${ADDR}`);
});

test('addChainPrefix — passes null/undefined/"" through unchanged', () => {
    assert.equal(addChainPrefix(null), null);
    assert.equal(addChainPrefix(undefined), undefined);
    assert.equal(addChainPrefix(''), '');
});

test('addChainPrefix ∘ stripChainPrefix — round-trip on bare address', () => {
    // Critical: proxy translates IDs both directions. Stripping then
    // re-adding must return a value that re-strips back to the original.
    const back = stripChainPrefix(addChainPrefix(ADDR));
    assert.equal(back, ADDR);
});

// ---------------------------------------------------------------------------
// CHAIN_PREFIXED_RE pattern
// ---------------------------------------------------------------------------

test('CHAIN_PREFIXED_RE — matches valid chain-prefixed addresses', () => {
    assert.ok(CHAIN_PREFIXED_RE.test(`100-${ADDR}`));
    assert.ok(CHAIN_PREFIXED_RE.test(`1-${ADDR}`));
    // Mixed case in the address part:
    const mixed = `100-0xEb96dC321604aA7D82d34047281BD1ac7c4eac42`;
    assert.ok(CHAIN_PREFIXED_RE.test(mixed),
        `regex must accept mixed-case hex (uppercase letter detection)`);
});

test('CHAIN_PREFIXED_RE — rejects bare addresses (no chain prefix)', () => {
    assert.ok(!CHAIN_PREFIXED_RE.test(ADDR),
        `bare address must NOT match (would mass-strip nothing-prefixed strings)`);
});

test('CHAIN_PREFIXED_RE — rejects composite IDs (id-period-ts shape)', () => {
    // Composite IDs end with -<digits>, so they don't match the strict pattern.
    // This means the recursive walker leaves them intact.
    assert.ok(!CHAIN_PREFIXED_RE.test(`1-${ADDR}-3600-1758682800`),
        `composite ID must NOT match (preserves composite IDs in response untouched)`);
});

test('CHAIN_PREFIXED_RE — rejects non-address shapes', () => {
    for (const bad of [
        '',
        '0x',
        '100-not-an-address',
        '100-0xshort',
        `100-0x${'g'.repeat(40)}`,            // 'g' is not hex
        `100-${ADDR}extra`,                    // trailing chars
        `extra100-${ADDR}`,                    // leading chars
        `100-${ADDR.slice(0, 41)}`,           // 39 hex chars
        `100-${ADDR}f`,                        // 41 hex chars
    ]) {
        assert.ok(!CHAIN_PREFIXED_RE.test(bad),
            `regex should reject ${JSON.stringify(bad)}`);
    }
});

// ---------------------------------------------------------------------------
// stripPrefixesAndNormalize — recursive walker
// ---------------------------------------------------------------------------

test('walker — strips top-level string fields that match the pattern', () => {
    const input = { id: PREFIXED, pool: PREFIXED, name: 'My Pool' };
    assert.deepEqual(stripPrefixesAndNormalize(input), {
        id: ADDR, pool: ADDR, name: 'My Pool',
    });
});

test('walker — recurses into nested objects', () => {
    const input = {
        outer: { inner: { id: PREFIXED } },
    };
    assert.deepEqual(stripPrefixesAndNormalize(input), {
        outer: { inner: { id: ADDR } },
    });
});

test('walker — recurses into arrays', () => {
    const input = { candles: [{ id: PREFIXED }, { id: `1-${ADDR}` }] };
    assert.deepEqual(stripPrefixesAndNormalize(input), {
        candles: [{ id: ADDR }, { id: ADDR }],
    });
});

test('walker — leaves non-matching strings intact', () => {
    const input = {
        name: 'GNO/sDAI',
        url: 'https://example.com',
        timestamp: '1778230223',  // numeric string, no chain prefix
        composite: `1-${ADDR}-3600-1758682800`,  // composite ID
        almostMatch: '100-0xabc',  // too short to match strict pattern
    };
    assert.deepEqual(stripPrefixesAndNormalize(input), input);
});

test('walker — handles primitives and nullish at any depth', () => {
    assert.equal(stripPrefixesAndNormalize(null), null);
    assert.equal(stripPrefixesAndNormalize(undefined), undefined);
    assert.equal(stripPrefixesAndNormalize(42), 42);
    assert.equal(stripPrefixesAndNormalize(true), true);
    assert.equal(stripPrefixesAndNormalize('plain'), 'plain');
});

test('walker — preserves array order and length', () => {
    const input = [{ id: PREFIXED }, { id: `1-${ADDR}` }, { name: 'mid' }];
    const out = stripPrefixesAndNormalize(input);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, ADDR);
    assert.equal(out[2].name, 'mid');
});

test('walker — idempotent (run twice produces same output)', () => {
    const input = { candles: [{ id: PREFIXED, pool: PREFIXED, ts: '1778230223' }] };
    const once = stripPrefixesAndNormalize(input);
    const twice = stripPrefixesAndNormalize(once);
    assert.deepEqual(once, twice);
});
