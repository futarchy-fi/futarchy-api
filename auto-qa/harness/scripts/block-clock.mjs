#!/usr/bin/env node
/**
 * block-clock.mjs — controlled time + block advancement on a local anvil fork.
 *
 * Phase 1: helper functions only — no CLI driver yet (orchestrator will
 * import these in Phase 2). The functions wrap anvil-specific JSON-RPC
 * methods with a thin error-mapping layer.
 *
 * Wraps these anvil JSON-RPC methods:
 *   evm_mine                       — mine N blocks immediately
 *   evm_setNextBlockTimestamp      — pin next-block timestamp
 *   evm_increaseTime               — advance time without mining
 *   evm_snapshot                   — snapshot state, return ID
 *   evm_revert                     — revert to a snapshot ID
 *   anvil_setBalance               — fund an account
 *   anvil_impersonateAccount       — sign as any address
 *   anvil_stopImpersonatingAccount — stop impersonating
 *
 * Usage:
 *   import { mineBlock, setNextTimestamp, snapshot, revert } from './block-clock.mjs';
 *
 *   const rpc = 'http://localhost:8545';
 *   const snapId = await snapshot(rpc);
 *   await setNextTimestamp(rpc, Math.floor(Date.now() / 1000));
 *   await mineBlock(rpc);
 *   // ... do test work ...
 *   await revert(rpc, snapId);
 */

const DEFAULT_TIMEOUT_MS = 10_000;

class RpcError extends Error {
    constructor(method, payload, response) {
        const detail = response?.error
            ? `${response.error.code}: ${response.error.message}`
            : `HTTP ${response?.status ?? '???'}`;
        super(`[block-clock] ${method} failed (${detail})`);
        this.name = 'RpcError';
        this.method = method;
        this.payload = payload;
        this.response = response;
    }
}

let _id = 0;
function nextId() { return ++_id; }

/**
 * Low-level JSON-RPC call. Returns the `result` field on success;
 * throws RpcError on non-2xx or `error` field present.
 */
async function rpc(rpcUrl, method, params = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: nextId(),
                method,
                params,
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        throw new RpcError(method, params, res);
    }

    const body = await res.json();
    if (body.error) {
        throw new RpcError(method, params, body);
    }
    return body.result;
}

// ───────────────────────────────────────────────────────────────────
// Mining
// ───────────────────────────────────────────────────────────────────

/**
 * Mine N blocks immediately. Returns the new block number (decimal).
 *
 * Uses evm_mine which returns "0x0" — to learn the new height we
 * follow up with eth_blockNumber.
 */
export async function mineBlock(rpcUrl, count = 1) {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error('[block-clock] mineBlock(count) — count must be a positive integer');
    }
    for (let i = 0; i < count; i++) {
        await rpc(rpcUrl, 'evm_mine');
    }
    const hex = await rpc(rpcUrl, 'eth_blockNumber');
    return parseInt(hex, 16);
}

/**
 * Pin the next-block timestamp (Unix seconds). The next mine will
 * produce a block at exactly this timestamp.
 */
export async function setNextTimestamp(rpcUrl, unixSeconds) {
    if (!Number.isInteger(unixSeconds) || unixSeconds < 0) {
        throw new Error('[block-clock] setNextTimestamp(ts) — ts must be a positive integer');
    }
    return rpc(rpcUrl, 'evm_setNextBlockTimestamp', [unixSeconds]);
}

/**
 * Increase time WITHOUT mining. Subsequent mined blocks will reflect
 * the cumulative offset.
 */
export async function increaseTime(rpcUrl, deltaSeconds) {
    if (!Number.isInteger(deltaSeconds) || deltaSeconds < 0) {
        throw new Error('[block-clock] increaseTime(delta) — delta must be a positive integer');
    }
    return rpc(rpcUrl, 'evm_increaseTime', [deltaSeconds]);
}

// ───────────────────────────────────────────────────────────────────
// Snapshot / revert
// ───────────────────────────────────────────────────────────────────

/**
 * Take a state snapshot. Returns an opaque snapshot ID (hex string)
 * that can be passed to revert().
 *
 * Note: anvil consumes a snapshot ID on revert — re-snapshot after
 * revert if you want another rollback point.
 */
export async function snapshot(rpcUrl) {
    return rpc(rpcUrl, 'evm_snapshot');
}

/**
 * Revert state to a previous snapshot ID.
 * Returns true on success.
 */
export async function revert(rpcUrl, snapshotId) {
    if (!snapshotId) {
        throw new Error('[block-clock] revert(snapshotId) — snapshotId required');
    }
    const ok = await rpc(rpcUrl, 'evm_revert', [snapshotId]);
    return ok === true;
}

// ───────────────────────────────────────────────────────────────────
// Account manipulation
// ───────────────────────────────────────────────────────────────────

/**
 * Set an arbitrary balance on an address (in wei, hex string).
 *
 *   await setBalance(rpc, '0xabc...', '0xde0b6b3a7640000'); // 1 ether
 */
export async function setBalance(rpcUrl, address, weiHex) {
    if (!address || !address.startsWith('0x')) {
        throw new Error('[block-clock] setBalance(address) — must be 0x-prefixed');
    }
    if (typeof weiHex !== 'string' || !weiHex.startsWith('0x')) {
        throw new Error('[block-clock] setBalance(weiHex) — must be 0x-prefixed hex');
    }
    return rpc(rpcUrl, 'anvil_setBalance', [address, weiHex]);
}

/**
 * Start signing as the given address (no private key required).
 * Pair with stopImpersonating() when done.
 */
export async function impersonateAccount(rpcUrl, address) {
    if (!address || !address.startsWith('0x')) {
        throw new Error('[block-clock] impersonateAccount(address) — must be 0x-prefixed');
    }
    return rpc(rpcUrl, 'anvil_impersonateAccount', [address]);
}

export async function stopImpersonating(rpcUrl, address) {
    return rpc(rpcUrl, 'anvil_stopImpersonatingAccount', [address]);
}

// ───────────────────────────────────────────────────────────────────
// Convenience: query helpers
// ───────────────────────────────────────────────────────────────────

export async function blockNumber(rpcUrl) {
    const hex = await rpc(rpcUrl, 'eth_blockNumber');
    return parseInt(hex, 16);
}

export async function chainId(rpcUrl) {
    const hex = await rpc(rpcUrl, 'eth_chainId');
    return parseInt(hex, 16);
}

export async function getBalance(rpcUrl, address) {
    return rpc(rpcUrl, 'eth_getBalance', [address, 'latest']);
}

// Re-export the low-level rpc helper so callers can invoke methods we
// don't have a wrapper for yet.
export { rpc };

// CLI smoke test (does NOT spawn anvil — assumes one is already running).
if (import.meta.url === `file://${process.argv[1]}`) {
    const rpcUrl = process.argv[2] || 'http://127.0.0.1:8545';
    console.log(`[block-clock] smoke against ${rpcUrl}`);
    try {
        const cid = await chainId(rpcUrl);
        const bn = await blockNumber(rpcUrl);
        console.log(`  chainId=${cid}  blockNumber=${bn}`);

        const snap = await snapshot(rpcUrl);
        console.log(`  snapshot id: ${snap}`);
        const newBn = await mineBlock(rpcUrl, 5);
        console.log(`  mined 5 blocks, new height: ${newBn}`);
        const reverted = await revert(rpcUrl, snap);
        console.log(`  revert ok: ${reverted}`);
        const finalBn = await blockNumber(rpcUrl);
        console.log(`  height after revert: ${finalBn}`);
        if (finalBn !== bn) {
            console.error(`  ✗ height did not return to ${bn}`);
            process.exit(1);
        }
        console.log('  ✓ snapshot/revert round-trip clean');
    } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exit(2);
    }
}
