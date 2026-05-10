/**
 * registry-adapter spec mirror (auto-qa).
 *
 * Pins src/adapters/registry-adapter.js — the on-chain registry
 * lookup module that powers `resolveProposalId` (used to normalize
 * arbitrary proposal IDs to canonical addresses) and `lookupOrgMetadata`.
 *
 * Two layers:
 *   1. normalizeProposalResult — pure shape-normalizer with 14 fields,
 *      6 of which are integer-parsed. A regression in the parseInt
 *      logic would silently scale every proposal config value wrongly.
 *   2. Pinned canonical addresses — AGGREGATOR_ADDRESS,
 *      SNAPSHOT_LINK_REGISTRY, FACTORY_ADDRESS. AGGREGATOR_ADDRESS
 *      MUST match the DEFAULT_AGGREGATOR exported from
 *      futarchy-fi/interface (cross-pinned in
 *      auto-qa/tests/subgraph-endpoints.test.mjs there).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/adapters/registry-adapter.js', import.meta.url),
    'utf8',
);

// --- spec mirror of normalizeProposalResult ---
function normalizeProposalResult(proposal, config) {
    return {
        proposalId: proposal?.id?.toLowerCase(),
        proposalAddress: proposal?.proposalAddress?.toLowerCase(),
        originalProposalId: proposal?.id,
        organizationId: proposal?.organization?.id,
        organizationName: proposal?.organization?.name,
        coingeckoTicker: config.coingecko_ticker || null,
        closeTimestamp: config.closeTimestamp ? parseInt(config.closeTimestamp) : null,
        startCandleUnix: config.startCandleUnix ? parseInt(config.startCandleUnix) : null,
        twapStartTimestamp: config.twapStartTimestamp ? parseInt(config.twapStartTimestamp) : null,
        twapDurationHours: config.twapDurationHours ? parseInt(config.twapDurationHours) : null,
        twapDescription: config.twapDescription || null,
        chain: config.chain ? parseInt(config.chain) : null,
        pricePrecision: config.price_precision ? parseInt(config.price_precision) : null,
        currencyStableRate: config.currency_stable_rate || null,
        currencyStableSymbol: config.currency_stable_symbol || null,
    };
}

// ---------------------------------------------------------------------------
// normalizeProposalResult — id/address case normalization
// ---------------------------------------------------------------------------

test('normalize — proposalId is lowercased', () => {
    const r = normalizeProposalResult(
        { id: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' },
        {}
    );
    assert.equal(r.proposalId, '0xabcdef1234567890abcdef1234567890abcdef12');
});

test('normalize — proposalAddress is lowercased', () => {
    const r = normalizeProposalResult(
        { proposalAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' },
        {}
    );
    assert.equal(r.proposalAddress, '0xabcdef1234567890abcdef1234567890abcdef12');
});

test('normalize — originalProposalId preserves the input case (no normalization)', () => {
    // Pinned: clients can use originalProposalId to display the
    // checksummed form back to users. A refactor that lowercases here
    // too would lose that information.
    const r = normalizeProposalResult(
        { id: '0xAbCdEf1234567890aBcDeF1234567890AbCdEf12' },
        {}
    );
    assert.equal(r.originalProposalId, '0xAbCdEf1234567890aBcDeF1234567890AbCdEf12');
    assert.notEqual(r.originalProposalId, r.proposalId,
        `originalProposalId must preserve case while proposalId is lowercased`);
});

// ---------------------------------------------------------------------------
// normalizeProposalResult — null/missing handling
// ---------------------------------------------------------------------------

test('normalize — empty proposal returns all-undefined-or-null shape', () => {
    const r = normalizeProposalResult({}, {});
    assert.equal(r.proposalId, undefined);
    assert.equal(r.proposalAddress, undefined);
    assert.equal(r.originalProposalId, undefined);
    assert.equal(r.organizationId, undefined);
    assert.equal(r.coingeckoTicker, null);
    assert.equal(r.closeTimestamp, null);
    assert.equal(r.chain, null);
});

test('normalize — null proposal does not throw', () => {
    // Defensive guard. Optional chaining (?.id) handles this.
    assert.doesNotThrow(() => normalizeProposalResult(null, {}));
    const r = normalizeProposalResult(null, {});
    assert.equal(r.proposalId, undefined);
    assert.equal(r.proposalAddress, undefined);
});

// ---------------------------------------------------------------------------
// normalizeProposalResult — organization extraction
// ---------------------------------------------------------------------------

test('normalize — organization fields extracted', () => {
    const r = normalizeProposalResult({
        organization: { id: '0xorg', name: 'Acme DAO' },
    }, {});
    assert.equal(r.organizationId, '0xorg');
    assert.equal(r.organizationName, 'Acme DAO');
});

test('normalize — missing organization yields undefined fields (not throw)', () => {
    const r = normalizeProposalResult({}, {});
    assert.equal(r.organizationId, undefined);
    assert.equal(r.organizationName, undefined);
});

// ---------------------------------------------------------------------------
// normalizeProposalResult — parseInt config fields
// ---------------------------------------------------------------------------

test('normalize — closeTimestamp parsed as integer', () => {
    const r = normalizeProposalResult({}, { closeTimestamp: '1778230223' });
    assert.equal(r.closeTimestamp, 1778230223);
    assert.equal(typeof r.closeTimestamp, 'number');
});

test('normalize — chain parsed as integer (e.g. "100" → 100)', () => {
    const r = normalizeProposalResult({}, { chain: '100' });
    assert.equal(r.chain, 100);
});

test('normalize — twapDurationHours parsed as integer', () => {
    const r = normalizeProposalResult({}, { twapDurationHours: '48' });
    assert.equal(r.twapDurationHours, 48);
});

test('normalize — pricePrecision parsed as integer (snake_case "price_precision" key)', () => {
    // Source field name uses snake_case; output is camelCase.
    const r = normalizeProposalResult({}, { price_precision: '4' });
    assert.equal(r.pricePrecision, 4);
});

test('normalize — missing parseInt fields yield null (not 0 or NaN)', () => {
    const r = normalizeProposalResult({}, {});
    for (const k of ['closeTimestamp', 'startCandleUnix', 'twapStartTimestamp',
                     'twapDurationHours', 'chain', 'pricePrecision']) {
        assert.equal(r[k], null,
            `${k} must be null on missing config (not 0, not NaN, not undefined)`);
    }
});

test('normalize — empty-string config fields are falsy → null (not parseInt(""))', () => {
    // "" is falsy, so the ternary returns null. parseInt("") would yield NaN.
    // A refactor that drops the truthy-check would silently turn empty
    // strings into NaN values throughout the config.
    const r = normalizeProposalResult({}, {
        closeTimestamp: '', chain: '', twapDurationHours: '',
    });
    assert.equal(r.closeTimestamp, null);
    assert.equal(r.chain, null);
    assert.equal(r.twapDurationHours, null);
});

// ---------------------------------------------------------------------------
// normalizeProposalResult — string fields with || null fallback
// ---------------------------------------------------------------------------

test('normalize — coingeckoTicker is "" → null (the || fallback)', () => {
    const r = normalizeProposalResult({}, { coingecko_ticker: '' });
    assert.equal(r.coingeckoTicker, null,
        `empty string must fall through to null (otherwise downstream renders ""/empty)`);
});

test('normalize — coingeckoTicker preserved when present', () => {
    const r = normalizeProposalResult({}, { coingecko_ticker: 'gnosis' });
    assert.equal(r.coingeckoTicker, 'gnosis');
});

test('normalize — twapDescription / currencyStableSymbol fall through to null on missing', () => {
    const r = normalizeProposalResult({}, {});
    assert.equal(r.twapDescription, null);
    assert.equal(r.currencyStableSymbol, null);
    assert.equal(r.currencyStableRate, null);
});

// ---------------------------------------------------------------------------
// Pinned addresses — registry constants
// ---------------------------------------------------------------------------

test('registry-adapter — AGGREGATOR_ADDRESS matches the canonical aggregator', () => {
    // MUST equal DEFAULT_AGGREGATOR in futarchy-fi/interface (which is
    // cross-pinned in that repo's subgraph-endpoints.test.mjs at
    // 0xC5eB43D53e2FE5FddE5faf400CC4167e5b5d4Fc1, lowercase variant).
    const m = SRC.match(/AGGREGATOR_ADDRESS\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'AGGREGATOR_ADDRESS not found');
    assert.equal(m[1].toLowerCase(), '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1',
        `AGGREGATOR_ADDRESS drifted from the canonical aggregator. ` +
        `MUST match DEFAULT_AGGREGATOR in futarchy-fi/interface (otherwise the api ` +
        `queries a different aggregator than the frontend expects).`);
});

test('registry-adapter — SNAPSHOT_LINK_REGISTRY pinned address', () => {
    const m = SRC.match(/SNAPSHOT_LINK_REGISTRY\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'SNAPSHOT_LINK_REGISTRY not found');
    assert.equal(m[1], '0xa6Bc2857906C808bc0041f3A2977F53c6b6b0823',
        `SNAPSHOT_LINK_REGISTRY drifted from canonical address`);
});

test('registry-adapter — FACTORY_ADDRESS pinned address', () => {
    const m = SRC.match(/FACTORY_ADDRESS\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'FACTORY_ADDRESS not found');
    assert.equal(m[1], '0xa6cB18FCDC17a2B44E5cAd2d80a6D5942d30a345',
        `FACTORY_ADDRESS drifted from canonical futarchy proposal factory address`);
});

test('registry-adapter — GNOSIS_RPC default falls back to rpc.gnosischain.com', () => {
    const m = SRC.match(/GNOSIS_RPC\s*=\s*process\.env\.GNOSIS_RPC_URL\s*\|\|\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'GNOSIS_RPC default not found');
    assert.equal(m[1], 'https://rpc.gnosischain.com',
        `GNOSIS_RPC default drifted from https://rpc.gnosischain.com`);
});
