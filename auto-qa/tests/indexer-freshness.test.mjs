/**
 * Indexer freshness test (auto-qa).
 *
 * For each indexer behind api.futarchy.fi (registry + candles), compare
 * its head block to the live Gnosis chain tip and assert the lag is
 * bounded. Catches "indexer stalled" regressions.
 *
 * Why a loose threshold:
 *   We've observed legitimate temporary lag (5-15k blocks) during normal
 *   operation. The thresholds below are picked to be loose enough to
 *   avoid flakes but tight enough to catch true stalls (>1 day behind).
 *
 * Per /loop directive: failures here are documentation, not auto-fixes.
 * If the indexer is genuinely broken on the day a test runs, leave the
 * failure visible so a real-fix pass can address it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const GNOSIS_RPC = process.env.AUTO_QA_GNOSIS_RPC || 'https://rpc.gnosischain.com';

// Loose thresholds (in blocks @ 5s/block on Gnosis):
//   1000  blocks ≈  83 min
//   5000  blocks ≈   7 hours
//  15000  blocks ≈ 21 hours
const CANDLES_LAG_THRESHOLD  =  5000; // ~7h is the upper edge of "catching up normally"
const REGISTRY_LAG_THRESHOLD = 15000; // currently lags more than candles; baseline accordingly

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function gnosisTip() {
    const res = await fetch(GNOSIS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return parseInt(j.result, 16);
}

async function indexerHead(graphqlUrl, indexerName = null) {
    const where = indexerName ? `, where: { indexer: "${indexerName}" }` : '';
    const query = `{ _checkpoints(first: 1, orderBy: block_number, orderDirection: desc${where}) { block_number } }`;
    const res = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return j.data?._checkpoints?.[0]?.block_number ?? null;
}

test('indexer freshness — candles (gnosis) head not too far behind chain tip', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    let tip;
    try { tip = await gnosisTip(); }
    catch (e) { t.skip(`Gnosis RPC unreachable: ${e.message}`); return; }

    const head = await indexerHead(`${API_BASE}/candles/graphql`, 'gnosis');
    assert.ok(head !== null, 'candles indexer returned no _checkpoints');

    const lag = tip - head;
    assert.ok(
        lag < CANDLES_LAG_THRESHOLD,
        `Candles Gnosis indexer is ${lag} blocks behind chain tip ` +
        `(threshold: ${CANDLES_LAG_THRESHOLD}). ` +
        `Indexer head: ${head}, chain tip: ${tip}. ` +
        `If the indexer is healthy and just catching up, raise the threshold.`
    );
});

test('indexer freshness — registry head not too far behind chain tip', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    let tip;
    try { tip = await gnosisTip(); }
    catch (e) { t.skip(`Gnosis RPC unreachable: ${e.message}`); return; }

    const head = await indexerHead(`${API_BASE}/registry/graphql`);
    assert.ok(head !== null, 'registry indexer returned no _checkpoints');

    const lag = tip - head;
    assert.ok(
        lag < REGISTRY_LAG_THRESHOLD,
        `Registry indexer is ${lag} blocks behind chain tip ` +
        `(threshold: ${REGISTRY_LAG_THRESHOLD}). ` +
        `Indexer head: ${head}, chain tip: ${tip}. ` +
        `As of this iteration the registry was running ~7900 blocks behind ` +
        `— if it has drifted further, that's a real ops issue.`
    );
});

test('indexer freshness — both indexers return a valid block number', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const candles  = await indexerHead(`${API_BASE}/candles/graphql`, 'gnosis');
    const registry = await indexerHead(`${API_BASE}/registry/graphql`);

    for (const [name, head] of [['candles-gnosis', candles], ['registry', registry]]) {
        assert.ok(typeof head === 'number' && head > 0,
            `${name} indexer head should be a positive number, got ${head}`);
        // Sanity: must be a Gnosis block, so > 30M (we passed 30M long ago)
        assert.ok(head > 30_000_000,
            `${name} head ${head} looks suspiciously low for current Gnosis chain`);
    }
});
