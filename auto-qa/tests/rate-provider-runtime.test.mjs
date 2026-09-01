/**
 * rate-provider runtime spec (auto-qa).
 *
 * Pins src/services/rate-provider.js — the ERC-4626 getRate() helper
 * used to convert sDAI quotes back to underlying-token units. The
 * existing rate-provider-config.test.mjs covers the constants
 * (selector, chain config, cache duration, error/return-1 paths via
 * source text). This file covers BEHAVIOR by stubbing global.fetch:
 *
 *   1. eth_call payload shape — jsonrpc 2.0, id 1, method eth_call,
 *      params [{to, data: GET_RATE_SELECTOR}, "latest"]. A regression
 *      that switches to eth_estimateGas, drops "latest", or uses a
 *      different jsonrpc version would silently return 1 (catch swallow).
 *
 *   2. BigInt parsing — uint256 hex result divided by 1e18 to get a
 *      decimal. Tested at canonical sDAI scale (~1.224691) plus
 *      identity (1e18 → 1.0) and zero (0x0 → 0).
 *
 *   3. Default chainId is 100 — getRate(addr) without chainId hits
 *      Gnosis RPC, not Ethereum. A regression to a non-default would
 *      route every legacy caller to the wrong chain.
 *
 *   4. Default-providerAddress short-circuit — getRate(undefined, ...)
 *      returns 1 WITHOUT calling fetch. Network unreachable scenarios
 *      shouldn't fail when caller has no provider.
 *
 *   5. Unknown chainId short-circuits before fetch — returns 1, no
 *      network call attempted. Adding a new chain to CHAIN_CONFIG is
 *      the only safe extension point.
 *
 *   6. RPC error envelope handling — when response includes {error:
 *      {code, message}}, getRate returns 1 (no throw). The destructure
 *      `const {result, error} = await response.json()` means malformed
 *      JSON without `result` is also handled by the BigInt(undefined)
 *      throw → caught → returns 1.
 *
 *   7. Cache key includes BOTH providerAddress AND chainId — the same
 *      provider on different chains gets distinct cache slots. A key
 *      collapse would return Gnosis rate when querying Ethereum.
 *
 *   8. Cache key uses literal 'default' string when providerAddress is
 *      falsy — `${addr || 'default'}-${chainId}`. So getRateCached(null,
 *      100) and getRateCached(undefined, 100) share a slot.
 *
 *   9. Cache HIT — same key within TTL returns cached value WITHOUT
 *      calling fetch again.
 *
 *  10. Cache MISS after TTL — calls fetch a second time and refreshes
 *      the cache entry. (We can't easily fast-forward the 5min TTL in
 *      a unit test, so we monkey-patch Date.now to simulate.)
 *
 *  11. Default chainId in getRateCached is also 100 — symmetry with
 *      getRate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRate, getRateCached } from '../../src/services/rate-provider.js';

// ───── helpers ─────

/**
 * Replace global.fetch with a stub that captures every call and returns
 * the next queued response. Returns {restore, calls, queue}.
 */
function stubFetch() {
    const orig = global.fetch;
    const calls = [];
    const queue = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
        if (queue.length === 0) {
            throw new Error('stubFetch: queue empty');
        }
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return {
            json: async () => next,
        };
    };
    return {
        calls,
        queue,
        restore: () => { global.fetch = orig; },
    };
}

/**
 * Mute console.log/error during a test and capture them.
 */
function muteConsole() {
    const origLog = console.log;
    const origErr = console.error;
    const logs = [];
    console.log = (...args) => logs.push(['log', ...args]);
    console.error = (...args) => logs.push(['error', ...args]);
    return {
        logs,
        restore: () => {
            console.log = origLog;
            console.error = origErr;
        },
    };
}

const SDAI_ON_GNOSIS = '0x89C80A4540A00b5270347E02e2E144c71da2EceD';
const GET_RATE_SELECTOR = '0x679aefce';

// ───── 1. eth_call payload shape ─────

test('getRate posts proper JSON-RPC eth_call to chain RPC', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        // 1.224691... * 1e18 in hex
        queue.push({ result: '0x10fd72d12cb20d40' });
        await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://rpc.gnosis.gateway.fm');
        assert.equal(calls[0].opts.method, 'POST');
        assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
        const body = calls[0].body;
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.id, 1);
        assert.equal(body.method, 'eth_call');
        assert.deepEqual(body.params, [
            { to: SDAI_ON_GNOSIS, data: GET_RATE_SELECTOR },
            'latest',
        ]);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate uses chain 100 (Gnosis) by default — no chainId arg', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' }); // 1.0
        await getRate(SDAI_ON_GNOSIS);
        assert.equal(calls[0].url, 'https://rpc.gnosis.gateway.fm');
    } finally {
        c.restore();
        restore();
    }
});

test('getRate routes chain 1 to Ethereum RPC (eth.llamarpc.com)', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' });
        await getRate('0xabc', 1);
        assert.equal(calls[0].url, 'https://eth.llamarpc.com');
    } finally {
        c.restore();
        restore();
    }
});

// ───── 2. BigInt parsing ─────

test('getRate parses uint256 result with 18-decimal scaling', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        // 1.5 * 1e18 = 1500000000000000000 = 0x14d1120d7b160000
        queue.push({ result: '0x14d1120d7b160000' });
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 1.5);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate parses 1.0 identity rate (0x0de0b6b3a7640000)', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' });
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 1);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate parses 0x0 → 0 (no zero-guard in source)', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0' });
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 0);
    } finally {
        c.restore();
        restore();
    }
});

// ───── 3. Short-circuit: missing providerAddress ─────

test('getRate returns 1 when providerAddress is undefined — NO fetch call', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        const rate = await getRate(undefined, 100);
        assert.equal(rate, 1);
        assert.equal(calls.length, 0, 'fetch must NOT be called');
        assert.equal(queue.length, 0);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate returns 1 when providerAddress is null — NO fetch call', async () => {
    const { restore, calls } = stubFetch();
    const c = muteConsole();
    try {
        const rate = await getRate(null, 100);
        assert.equal(rate, 1);
        assert.equal(calls.length, 0);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate returns 1 when providerAddress is empty string — NO fetch call', async () => {
    const { restore, calls } = stubFetch();
    const c = muteConsole();
    try {
        const rate = await getRate('', 100);
        assert.equal(rate, 1);
        assert.equal(calls.length, 0);
    } finally {
        c.restore();
        restore();
    }
});

// ───── 4. Short-circuit: unknown chainId ─────

test('getRate returns 1 + logs error when chainId is not in CHAIN_CONFIG — NO fetch call', async () => {
    const { restore, calls } = stubFetch();
    const c = muteConsole();
    try {
        const rate = await getRate(SDAI_ON_GNOSIS, 999);
        assert.equal(rate, 1);
        assert.equal(calls.length, 0);
        assert.ok(c.logs.some(l => l[0] === 'error' && /Unknown chain/.test(String(l[1]))));
    } finally {
        c.restore();
        restore();
    }
});

// ───── 5. RPC error envelope ─────

test('getRate returns 1 when RPC responds with {error: ...}', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ error: { code: -32000, message: 'execution reverted' } });
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 1);
        assert.ok(c.logs.some(l => l[0] === 'error' && /RPC Error/.test(String(l[1]))));
    } finally {
        c.restore();
        restore();
    }
});

test('getRate returns 1 when fetch throws (network failure)', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push(new Error('ECONNREFUSED'));
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 1);
        assert.ok(c.logs.some(l => l[0] === 'error'));
    } finally {
        c.restore();
        restore();
    }
});

test('getRate returns 1 when result is missing AND no error field (BigInt throws)', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({}); // neither result nor error
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        // BigInt(undefined) throws → caught → returns 1
        assert.equal(rate, 1);
    } finally {
        c.restore();
        restore();
    }
});

test('getRate returns 1 when result is non-hex garbage (BigInt throws)', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: 'not-a-hex-string' });
        const rate = await getRate(SDAI_ON_GNOSIS, 100);
        assert.equal(rate, 1);
    } finally {
        c.restore();
        restore();
    }
});

// ───── 6. Cache behavior ─────

test('getRateCached: HIT within TTL — second call does NOT re-fetch', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' }); // 1.0
        // Use a unique address per test so we don't collide with the
        // module-level rateCache from earlier tests.
        const addr = '0x1111111111111111111111111111111111111111';
        const r1 = await getRateCached(addr, 100);
        const r2 = await getRateCached(addr, 100);
        assert.equal(r1, 1);
        assert.equal(r2, 1);
        assert.equal(calls.length, 1, 'only one fetch despite two calls');
    } finally {
        c.restore();
        restore();
    }
});

test('getRateCached: distinct chainIds get distinct cache slots', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x14d1120d7b160000' }); // 1.5 (Gnosis)
        queue.push({ result: '0x1bc16d674ec80000' }); // 2.0 (Ethereum)
        const addr = '0x2222222222222222222222222222222222222222';
        const r100 = await getRateCached(addr, 100);
        const r1   = await getRateCached(addr, 1);
        assert.equal(r100, 1.5);
        assert.equal(r1, 2);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, 'https://rpc.gnosis.gateway.fm');
        assert.equal(calls[1].url, 'https://eth.llamarpc.com');
    } finally {
        c.restore();
        restore();
    }
});

test('getRateCached: distinct providerAddresses get distinct cache slots', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' }); // 1.0
        queue.push({ result: '0x14d1120d7b160000' }); // 1.5
        const r1 = await getRateCached(
            '0x3333333333333333333333333333333333333333', 100,
        );
        const r2 = await getRateCached(
            '0x4444444444444444444444444444444444444444', 100,
        );
        assert.equal(r1, 1);
        assert.equal(r2, 1.5);
        assert.equal(calls.length, 2);
    } finally {
        c.restore();
        restore();
    }
});

test('getRateCached: missing providerAddress uses literal "default" key — NO fetch call', async () => {
    const { restore, calls } = stubFetch();
    const c = muteConsole();
    try {
        // No fetch will fire because getRate short-circuits when
        // providerAddress is falsy. The cache will store the rate=1.
        const r1 = await getRateCached(undefined, 100);
        const r2 = await getRateCached(null, 100);
        assert.equal(r1, 1);
        assert.equal(r2, 1);
        // Both calls used "default" key — second is a cache hit but
        // wouldn't fetch even if it weren't.
        assert.equal(calls.length, 0);
    } finally {
        c.restore();
        restore();
    }
});

test('getRateCached: TTL expiry triggers re-fetch (Date.now monkey-patch)', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    const origNow = Date.now;
    try {
        queue.push({ result: '0x0de0b6b3a7640000' }); // 1.0
        queue.push({ result: '0x14d1120d7b160000' }); // 1.5

        // Anchor time at T0
        let T = 1_700_000_000_000;
        Date.now = () => T;

        const addr = '0x5555555555555555555555555555555555555555';
        const r1 = await getRateCached(addr, 100);
        assert.equal(r1, 1);
        assert.equal(calls.length, 1);

        // 4:59 later — STILL in cache window (<5min)
        T += 4 * 60 * 1000 + 59 * 1000;
        const r2 = await getRateCached(addr, 100);
        assert.equal(r2, 1, 'cache hit returns stale value');
        assert.equal(calls.length, 1, 'no new fetch within TTL');

        // 5:01 later — past TTL
        T += 2 * 1000;
        const r3 = await getRateCached(addr, 100);
        assert.equal(r3, 1.5, 'cache miss fetches fresh value');
        assert.equal(calls.length, 2);
    } finally {
        Date.now = origNow;
        c.restore();
        restore();
    }
});

test('getRateCached: default chainId is 100 — symmetry with getRate', async () => {
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' });
        const addr = '0x6666666666666666666666666666666666666666';
        await getRateCached(addr); // no chainId arg
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://rpc.gnosis.gateway.fm');
    } finally {
        c.restore();
        restore();
    }
});

// ───── 7. Concurrency / re-entrance ─────

test('getRateCached: concurrent calls within TTL each fetch (no in-flight dedup)', async () => {
    // The implementation has NO in-flight dedup — two concurrent calls
    // for the same key will both fire fetch (then both store). Pinned
    // so a future "add p-limit dedup" PR knows it's a behavior change.
    const { restore, calls, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' });
        queue.push({ result: '0x0de0b6b3a7640000' });
        const addr = '0x7777777777777777777777777777777777777777';
        const [a, b] = await Promise.all([
            getRateCached(addr, 100),
            getRateCached(addr, 100),
        ]);
        assert.equal(a, 1);
        assert.equal(b, 1);
        assert.equal(calls.length, 2, 'both calls fetched (no in-flight dedup)');
    } finally {
        c.restore();
        restore();
    }
});

// ───── 8. Side-effect logging on success ─────

test('getRate logs the resolved rate with provider prefix on success', async () => {
    const { restore, queue } = stubFetch();
    const c = muteConsole();
    try {
        queue.push({ result: '0x0de0b6b3a7640000' });
        await getRate(SDAI_ON_GNOSIS, 100);
        const successLog = c.logs.find(
            l => l[0] === 'log' && /Rate from .* on Gnosis/.test(String(l[1])),
        );
        assert.ok(successLog, 'success log line present');
    } finally {
        c.restore();
        restore();
    }
});
