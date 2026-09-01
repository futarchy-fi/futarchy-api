/**
 * registry-adapter resolveProposalId + on-chain helpers spec mirror (auto-qa).
 *
 * Pins src/adapters/registry-adapter.js BEYOND the existing
 * registry-adapter.test.mjs (which covers normalizeProposalResult +
 * pinned addresses). This file covers the 4-step fallback chain in
 * resolveProposalId, the on-chain SnapshotLinkRegistry helper, mode-
 * dispatched lookups, and fetchProposalByAddress entity-name divergence.
 *
 * Five concerns:
 *
 *   1. 4-step fallback CHAIN ORDER in resolveProposalId — must follow
 *      exactly: on-chain registry → metadataentries snapshot_id →
 *      org metadata → bare-ID fallback. Drift in order silently
 *      changes which mapping wins for proposals registered both ways.
 *
 *   2. registryCache integration — cache check BEFORE any lookup;
 *      cache write at EACH successful step (including the bare-ID
 *      fallback) so subsequent calls don't re-do the work.
 *
 *   3. Mode-dispatch shape — both checkpoint_/graphNode_ lookup
 *      pairs (lookupBySnapshotId, lookupInOrgMetadata, lookupOrgMetadata)
 *      dispatch on IS_CHECKPOINT. A regression that always picks one
 *      breaks the other mode silently.
 *
 *   4. fetchProposalByAddress entity-name DIVERGENCE — 'proposalentities'
 *      (lowercase, Checkpoint) vs 'proposalEntities' (camelCase,
 *      Graph Node). A typo would 0-result the lookup.
 *
 *   5. on-chain helper shape — SnapshotLinkRegistry contract call
 *      (getFutarchyId returns [futarchyId, exists]) → factory
 *      proposals(futarchyId) → ZeroAddress check → lowercase return.
 *      JsonRpcProvider configured with chainId=100 + staticNetwork:true.
 *
 * Plus singleton pattern for the RPC provider (`let _rpcProvider = null`
 * + lazy init).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/adapters/registry-adapter.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// resolveProposalId — 4-step fallback CHAIN ORDER
// ---------------------------------------------------------------------------

test('resolveProposalId — fallback ORDER: onchain → snapshot_id → org metadata → bare-ID', () => {
    // Pinned: order matters because proposals may be registered via
    // multiple paths. Onchain is the canonical source of truth.
    // metadataentries snapshot_id is the modern lookup. Org metadata
    // is the legacy pattern. Bare-ID fallback is the "assume input
    // is already a proposal address" leaf.
    //
    // A regression that flips the order silently changes which
    // mapping wins for proposals registered both ways.
    const fn = SRC.match(/export\s+async\s+function\s+resolveProposalId\(proposalId\)\s*\{([\s\S]*?)^\}/m);
    assert.ok(fn, 'resolveProposalId function body not found');
    const body = fn[1];
    const markers = [
        'onchain_lookupBySnapshotId',
        'lookupBySnapshotId',         // step 2: graph_node_/checkpoint_lookupBySnapshotId
        'lookupInOrgMetadata',        // step 3: graph_node_/checkpoint_lookupInOrgMetadata
        'Use ID directly',            // step 4: marker comment
    ];
    let lastIdx = -1;
    for (const m of markers) {
        const idx = body.indexOf(m);
        assert.ok(idx > lastIdx,
            `resolveProposalId fallback order drifted: "${m}" not after "${markers[markers.indexOf(m) - 1] || 'start'}"`);
        lastIdx = idx;
    }
});

test('resolveProposalId — proposalId LOWERCASED before all lookups', () => {
    // Pinned: every lookup must use the lowercased form. A regression
    // that drops the .toLowerCase() would mismatch on uppercase input
    // (e.g. URL params with checksum-cased addresses).
    assert.match(SRC,
        /async function resolveProposalId\(proposalId\)\s*\{\s*const normalized\s*=\s*proposalId\.toLowerCase\(\)/,
        `proposalId must be lowercased into 'normalized' at function entry`);
});

test('resolveProposalId — bare-ID fallback returns proposalId as ORIGINAL case in originalProposalId', () => {
    // Pinned: callers may use originalProposalId for display.
    // Lowercasing it would lose the user's input casing.
    assert.match(SRC,
        /const fallback\s*=\s*\{\s*proposalId:\s*normalized,\s*proposalAddress:\s*normalized,\s*originalProposalId:\s*proposalId,/,
        `bare-ID fallback must preserve original case in originalProposalId`);
});

// ---------------------------------------------------------------------------
// registryCache integration — check BEFORE lookups, write at EACH step
// ---------------------------------------------------------------------------

test('registryCache — cache check BEFORE any lookup work', () => {
    // Pinned: a regression that moves the cache check after the
    // onchain lookup defeats the cache (every call hits the chain).
    const fn = SRC.match(/export\s+async\s+function\s+resolveProposalId\(proposalId\)\s*\{([\s\S]*?)^\}/m);
    const body = fn[1];
    const cacheGetIdx = body.indexOf('registryCache.get(normalized)');
    const onchainCallIdx = body.indexOf('onchain_lookupBySnapshotId(normalized)');
    assert.ok(cacheGetIdx > -1 && onchainCallIdx > -1);
    assert.ok(cacheGetIdx < onchainCallIdx,
        `registryCache.get must precede onchain_lookupBySnapshotId — otherwise cache is bypassed`);
});

test('registryCache — cache write at EACH successful step (4 sites)', () => {
    // Pinned: each successful path (including the bare-ID fallback)
    // must write to cache. A regression that skips one path causes
    // repeated network calls for that scenario.
    const matches = [...SRC.matchAll(/registryCache\.set\(normalized,\s*\w+/g)];
    assert.equal(matches.length, 4,
        `expected exactly 4 registryCache.set sites (one per fallback step); got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// Mode-dispatch shape — checkpoint_/graphNode_ pairs
// ---------------------------------------------------------------------------

test('source — lookupBySnapshotId dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /lookupFn\s*=\s*IS_CHECKPOINT\s*\?\s*checkpoint_lookupBySnapshotId\s*:\s*graphNode_lookupBySnapshotId/,
        `lookupBySnapshotId mode-dispatch shape drifted`);
});

test('source — lookupInOrgMetadata dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /orgLookupFn\s*=\s*IS_CHECKPOINT\s*\?\s*checkpoint_lookupInOrgMetadata\s*:\s*graphNode_lookupInOrgMetadata/,
        `lookupInOrgMetadata mode-dispatch shape drifted`);
});

test('source — lookupOrgMetadata public export dispatches on IS_CHECKPOINT', () => {
    assert.match(SRC,
        /export\s+async\s+function\s+lookupOrgMetadata\(orgId,\s*key\)\s*\{[\s\S]*?return\s+IS_CHECKPOINT[\s\S]*?\?\s*checkpoint_lookupOrgMetadata\(orgId,\s*key\)[\s\S]*?:\s*graphNode_lookupOrgMetadata\(orgId,\s*key\)/,
        `lookupOrgMetadata public-API dispatch shape drifted`);
});

// ---------------------------------------------------------------------------
// fetchProposalByAddress entity-name divergence
// ---------------------------------------------------------------------------

test('source — fetchProposalByAddress entity name: proposalentities (Checkpoint) vs proposalEntities (Graph Node)', () => {
    // Pinned the divergence. Checkpoint uses lowercase entity names
    // ('proposalentities'); Graph Node uses camelCase ('proposalEntities').
    // A typo on either side yields 0 results.
    assert.match(SRC,
        /entityName\s*=\s*IS_CHECKPOINT\s*\?\s*['"]proposalentities['"]\s*:\s*['"]proposalEntities['"]/,
        `entity-name dispatch drifted from 'proposalentities' (Checkpoint) vs 'proposalEntities' (Graph Node)`);
});

test('source — fetchProposalByAddress prefers proposal whose aggregator matches AGGREGATOR_ADDRESS', () => {
    // Pinned: when multiple proposals share the same proposalAddress
    // (e.g. across orgs), prefer the one whose aggregator matches
    // OUR canonical aggregator. A regression that drops this filter
    // would silently return the wrong org's proposal.
    assert.match(SRC,
        /proposals\.find\(p\s*=>\s*\{[\s\S]*?aggId\s*=\s*p\.organization\?\.\s*aggregator\?\.\s*id\?\.\s*toLowerCase\(\)[\s\S]*?return\s+aggId\s*===\s*AGGREGATOR_ADDRESS\.toLowerCase\(\)/,
        `aggregator-match filter shape drifted in fetchProposalByAddress`);
});

test('source — fetchProposalByAddress falls back to proposals[0] when no aggregator match', () => {
    // Pinned: || proposals[0] fallback. A regression that drops the
    // fallback would return null even when ANY proposal matches the
    // address (just not OUR aggregator).
    assert.match(SRC,
        /\.find\(p\s*=>\s*\{[\s\S]*?\}\)\s*\|\|\s*proposals\[0\]/,
        `proposals[0] fallback drifted — must fallback to first proposal when no aggregator match`);
});

test('source — fetchProposalByAddress JSON-parses metadata in try/catch (silent on parse failure)', () => {
    // Pinned: malformed metadata JSON shouldn't crash resolve. The
    // try/catch swallows parse errors and config stays {}.
    assert.match(SRC,
        /if\s*\(proposal\.metadata\)\s*\{\s*try\s*\{\s*config\s*=\s*JSON\.parse\(proposal\.metadata\);?\s*\}\s*catch[\s\S]*?\/\*\s*ignore\s*\*\/\s*\}/,
        `metadata JSON.parse try/catch shape drifted (silent ignore on parse failure)`);
});

// ---------------------------------------------------------------------------
// On-chain SnapshotLinkRegistry helper — 2-step contract call shape
// ---------------------------------------------------------------------------

test('source — onchain_lookupBySnapshotId zero-pads snapshotId to 32 bytes (bytes32 ABI)', () => {
    // Pinned: getFutarchyId expects bytes32. Snapshot IDs are usually
    // shorter; ethers.zeroPadValue(snapshotId, 32) pads to the right
    // length. A regression that drops the padding would fail ABI
    // encoding for short inputs.
    assert.match(SRC,
        /const padded\s*=\s*ethers\.zeroPadValue\(snapshotId,\s*32\)/,
        `snapshotId padding drifted from ethers.zeroPadValue(snapshotId, 32)`);
});

test('source — onchain_lookupBySnapshotId destructures [futarchyId, exists] from getFutarchyId', () => {
    // Pinned the tuple destructure. The ABI declares
    // `returns (uint256 futarchyId, bool exists)`. A regression that
    // accesses .futarchyId directly would silently get undefined.
    assert.match(SRC,
        /const\s*\[futarchyId,\s*exists\]\s*=\s*await\s+registry\.getFutarchyId\(padded\)/,
        `getFutarchyId destructure shape drifted from [futarchyId, exists]`);
});

test('source — onchain_lookupBySnapshotId returns null when !exists (early return)', () => {
    assert.match(SRC,
        /if\s*\(!exists\)\s*return\s+null/,
        `onchain helper must return null when exists=false (early return)`);
});

test('source — onchain_lookupBySnapshotId returns null when factory returns ZeroAddress', () => {
    // Pinned: the factory may return ZeroAddress for invalid futarchyId.
    // A regression that accepts ZeroAddress would surface "0x0000..." as
    // a valid proposal address downstream.
    assert.match(SRC,
        /if\s*\(proposalAddr\s*===\s*ethers\.ZeroAddress\)\s*return\s+null/,
        `ZeroAddress check drifted — factory result MUST be checked for zero`);
});

test('source — onchain_lookupBySnapshotId returns LOWERCASED proposalAddr', () => {
    // Pinned: lowercase return for cache-key consistency. Drift to
    // checksummed return would miss cache hits.
    assert.match(SRC,
        /return\s+proposalAddr\.toLowerCase\(\)/,
        `onchain helper must return lowercased proposalAddr`);
});

test('source — onchain_lookupBySnapshotId try/catch returns null on any error (silent)', () => {
    // Pinned: chain RPC failures shouldn't bubble — fall back to the
    // graph lookup chain. The catch logs a warning and returns null.
    assert.match(SRC,
        /\}\s*catch\s*\(e\)\s*\{[\s\S]*?console\.warn[\s\S]*?return\s+null/,
        `onchain helper catch must log warning + return null (NOT throw)`);
});

// ---------------------------------------------------------------------------
// JsonRpcProvider singleton + config
// ---------------------------------------------------------------------------

test('source — _rpcProvider is `let` (mutable singleton holder)', () => {
    // Pinned: lazy-init pattern. const would prevent assignment in
    // getRpcProvider().
    assert.match(SRC,
        /let\s+_rpcProvider\s*=\s*null/,
        `_rpcProvider must be 'let' initialized to null (lazy-init singleton)`);
});

test('source — JsonRpcProvider configured with chainId=100 + staticNetwork=true', () => {
    // Pinned: explicit chainId avoids the auto-detect roundtrip;
    // staticNetwork tells ethers not to refresh chain config (faster).
    assert.match(SRC,
        /new\s+ethers\.JsonRpcProvider\(GNOSIS_RPC,\s*100,\s*\{\s*staticNetwork:\s*true\s*\}\)/,
        `JsonRpcProvider config drifted from (GNOSIS_RPC, 100, { staticNetwork: true })`);
});

test('source — getRpcProvider lazy-init (only construct on first call)', () => {
    // Pinned: defensive against module-load-time RPC connections.
    // The `if (!_rpcProvider)` guard keeps construction inside the
    // function call (not at module-load).
    assert.match(SRC,
        /function getRpcProvider\(\)\s*\{\s*if\s*\(!_rpcProvider\)\s*\{\s*_rpcProvider\s*=\s*new\s+ethers\.JsonRpcProvider/,
        `getRpcProvider lazy-init shape drifted`);
});

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

test('source — registryAbi includes ONLY getFutarchyId(bytes32) view returns (uint256, bool)', () => {
    // Pinned: minimal ABI. A regression that adds more functions
    // (or wrong signature) increases bundle size and risks ABI drift.
    assert.match(SRC,
        /registryAbi\s*=\s*\[\s*['"]function getFutarchyId\(bytes32 snapshotId\) view returns \(uint256 futarchyId, bool exists\)['"]\s*,?\s*\]/,
        `registryAbi shape drifted from minimal getFutarchyId-only ABI`);
});

test('source — factoryAbi includes ONLY proposals(uint256) view returns (address)', () => {
    assert.match(SRC,
        /factoryAbi\s*=\s*\[\s*['"]function proposals\(uint256 index\) view returns \(address\)['"]\s*,?\s*\]/,
        `factoryAbi shape drifted from minimal proposals(uint256)-only ABI`);
});

// ---------------------------------------------------------------------------
// Cache key invariant — cache key uses normalized (lowercased) proposalId
// ---------------------------------------------------------------------------

test('source — registryCache keyed by lowercased proposalId (NOT original case)', () => {
    // Pinned: cache key MUST be lowercased. A regression that uses
    // the original case would miss cache hits for any input variant
    // (uppercase, mixed case).
    assert.match(SRC,
        /registryCache\.get\(normalized\)/,
        `registryCache.get must use 'normalized' (lowercased) key`);
    // All cache writes also use 'normalized'.
    const writes = [...SRC.matchAll(/registryCache\.set\(([^,]+),/g)].map(m => m[1].trim());
    for (const arg of writes) {
        assert.equal(arg, 'normalized',
            `registryCache.set must use 'normalized' (lowercased) key, got '${arg}'`);
    }
});

// ---------------------------------------------------------------------------
// Console.log on cache hit (debug observability)
// ---------------------------------------------------------------------------

test('source — cache HIT logs "Registry cache hit" with truncated id (debug aid)', () => {
    // Pinned: the cache-hit log helps trace traffic. Truncated id
    // (slice(0,10)) prevents log noise from full-length addresses.
    assert.match(SRC,
        /console\.log\(`\s*⚡\s*Registry cache hit:\s*\$\{normalized\.slice\(0,\s*10\)\}/,
        `cache-hit log shape drifted from "⚡ Registry cache hit: <id-prefix>..."`);
});
