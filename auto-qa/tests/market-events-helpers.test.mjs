/**
 * market-events helpers + invariants spec mirror (auto-qa).
 *
 * Pins src/routes/market-events.js — the /market-events/proposals/:id
 * route handler that powers the Companies + market-page YES/NO+spot
 * price tiles. Replaced the legacy stag.api.tickspread.com endpoint.
 *
 * The handler orchestrates: (1) resolve proposalId via registry, (2)
 * fetch pools via Algebra subgraph, (3) fetch spot via GeckoTerminal,
 * (4) compute USD prices via currency-rate provider, (5) build a
 * compound JSON response. Most of it is async I/O — this file pins:
 *
 *   1. AGGREGATOR_ADDRESS — canonical Trustur aggregator address.
 *      MUST match registry-adapter.js (cross-pinned via test count).
 *   2. getMockedTimeline — pure helper: start = now - 2 days,
 *      end = now + 3 days, both in seconds.
 *   3. resolveProposalId fallback path 3 (no registry mapping) —
 *      returns lowercased proposalId/proposalAddress + ORIGINAL-CASE
 *      originalProposalId. The case-preservation invariant lets the
 *      UI display the user's input casing (e.g. for snapshot links).
 *   4. lookupProposalBySnapshotId query shape — search key is
 *      "snapshot_id" literal; value is lowercased proposalId.
 *   5. findPoolByOutcome 3-tier fallback — CONDITIONAL → PREDICTION
 *      → EXPECTED_VALUE. New markets like GIP-150 v2 lack CONDITIONAL
 *      pools; the fallback covers them.
 *   6. Spot-price :: rate convergence — when ticker has "::" the raw
 *      spot is already xDAI-quoted; otherwise multiply by currencyRate
 *      to convert sDAI → xDAI.
 *   7. Response shape contract — top-level keys + nested pool_id
 *      passthrough (downstream graphql-proxy needs both pool_id +
 *      pool_ticker to fetch spot candles).
 *   8. Default chainId = 100 (Gnosis) when proposal config missing.
 *   9. Timeline defaults: 2 days back, 3 days forward when registry
 *      doesn't supply chartStartRange / closeTimestamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/routes/market-events.js', import.meta.url),
    'utf8',
);

// --- spec mirror of getMockedTimeline (pure) ---
function getMockedTimeline(nowMs = Date.now()) {
    const start = nowMs - (2 * 24 * 60 * 60 * 1000);
    const end = nowMs + (3 * 24 * 60 * 60 * 1000);
    return {
        start: Math.floor(start / 1000),
        end: Math.floor(end / 1000),
    };
}

// --- spec mirror of findPoolByOutcome ---
function findPoolByOutcome(pools, side) {
    return pools.find(p => p.outcomeSide === side && p.type === 'CONDITIONAL')
        || pools.find(p => p.outcomeSide === side && p.type === 'PREDICTION')
        || pools.find(p => p.outcomeSide === side && p.type === 'EXPECTED_VALUE');
}

// ---------------------------------------------------------------------------
// AGGREGATOR_ADDRESS — canonical Trustur aggregator (cross-pin)
// ---------------------------------------------------------------------------

test('AGGREGATOR_ADDRESS — pinned to canonical 0xc5eb43d... (lowercase form)', () => {
    // Pinned: this address gates which proposals are considered "ours".
    // A typo would either return zero proposals (filter rejects all)
    // or accept proposals from another aggregator (security boundary
    // crossed silently).
    const m = SRC.match(/AGGREGATOR_ADDRESS\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'AGGREGATOR_ADDRESS not found');
    assert.equal(m[1], '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1',
        `AGGREGATOR_ADDRESS drifted from canonical Trustur aggregator (lowercase form). ` +
        `MUST cross-match: (a) registry-adapter.js AGGREGATOR_ADDRESS [pinned in ` +
        `registry-adapter.test.mjs], (b) interface DEFAULT_AGGREGATOR [pinned in ` +
        `subgraph-endpoints.test.mjs of futarchy-fi/interface].`);
});

test('AGGREGATOR_ADDRESS — case-insensitive comparison used in filter', () => {
    // Pinned the .toLowerCase() comparison shape. A regression to
    // strict equality would silently filter out the real entries
    // (registry returns checksummed addresses).
    assert.match(SRC,
        /aggregatorId\s*===\s*AGGREGATOR_ADDRESS\.toLowerCase\(\)/,
        `aggregator filter must use .toLowerCase() comparison — registry ` +
        `returns checksummed addresses; strict equality would silently filter all out`);
});

// ---------------------------------------------------------------------------
// getMockedTimeline — pure helper
// ---------------------------------------------------------------------------

test('getMockedTimeline — start = now - 2 days (seconds)', () => {
    const t = getMockedTimeline(1_000_000_000_000);  // fixed epoch ms
    const expected = Math.floor((1_000_000_000_000 - 2 * 24 * 60 * 60 * 1000) / 1000);
    assert.equal(t.start, expected);
});

test('getMockedTimeline — end = now + 3 days (seconds)', () => {
    const t = getMockedTimeline(1_000_000_000_000);
    const expected = Math.floor((1_000_000_000_000 + 3 * 24 * 60 * 60 * 1000) / 1000);
    assert.equal(t.end, expected);
});

test('getMockedTimeline — window length is exactly 5 days (in seconds)', () => {
    const t = getMockedTimeline(1_000_000_000_000);
    assert.equal(t.end - t.start, 5 * 24 * 60 * 60,
        `window length drifted from 5 days (2 back + 3 forward). ` +
        `Affects every proposal whose registry config lacks chartStartRange/closeTimestamp.`);
});

test('getMockedTimeline — outputs are integers (Math.floor on division)', () => {
    const t = getMockedTimeline(1_000_000_000_001);  // not divisible by 1000
    assert.equal(Number.isInteger(t.start), true);
    assert.equal(Number.isInteger(t.end), true);
});

test('source — getMockedTimeline default 2-back/3-forward shape pinned', () => {
    // Defense in depth — source-text pin so a refactor to (1, 1) or
    // (7, 7) requires deliberate test update.
    assert.match(SRC,
        /now\s*-\s*\(2\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\)/,
        `start drifted from now - 2 days (in ms)`);
    assert.match(SRC,
        /now\s*\+\s*\(3\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\)/,
        `end drifted from now + 3 days (in ms)`);
});

// ---------------------------------------------------------------------------
// findPoolByOutcome — 3-tier fallback
// ---------------------------------------------------------------------------

test('findPoolByOutcome — picks CONDITIONAL when present', () => {
    const pools = [
        { outcomeSide: 'YES', type: 'CONDITIONAL', id: 'cond' },
        { outcomeSide: 'YES', type: 'PREDICTION', id: 'pred' },
        { outcomeSide: 'YES', type: 'EXPECTED_VALUE', id: 'ev' },
    ];
    assert.equal(findPoolByOutcome(pools, 'YES').id, 'cond');
});

test('findPoolByOutcome — falls back to PREDICTION when CONDITIONAL absent', () => {
    // Pinned scenario: GIP-150 v2 markets without CONDITIONAL pools.
    const pools = [
        { outcomeSide: 'YES', type: 'PREDICTION', id: 'pred' },
        { outcomeSide: 'YES', type: 'EXPECTED_VALUE', id: 'ev' },
    ];
    assert.equal(findPoolByOutcome(pools, 'YES').id, 'pred');
});

test('findPoolByOutcome — falls back to EXPECTED_VALUE when no CONDITIONAL/PREDICTION', () => {
    const pools = [
        { outcomeSide: 'YES', type: 'EXPECTED_VALUE', id: 'ev' },
    ];
    assert.equal(findPoolByOutcome(pools, 'YES').id, 'ev');
});

test('findPoolByOutcome — returns undefined when no pool matches the outcome side', () => {
    const pools = [{ outcomeSide: 'NO', type: 'CONDITIONAL' }];
    assert.equal(findPoolByOutcome(pools, 'YES'), undefined);
});

test('findPoolByOutcome — outcome side filter is exact-match (case-sensitive)', () => {
    // Pinned: graph node returns canonical "YES"/"NO" — anything else
    // means a regression in the upstream subgraph or the adapter.
    const pools = [{ outcomeSide: 'yes', type: 'CONDITIONAL' }];
    assert.equal(findPoolByOutcome(pools, 'YES'), undefined);
});

test('source — findPoolByOutcome 3-tier fallback chain pinned', () => {
    // Order matters: CONDITIONAL > PREDICTION > EXPECTED_VALUE.
    // A regression that re-orders silently picks a different pool
    // for any market with multiple types (different prices).
    const fbBlock = SRC.match(/findPoolByOutcome\(side\)\s*\{([\s\S]*?)\}\s*const yesPool/);
    assert.ok(fbBlock, 'findPoolByOutcome body not found');
    const order = ['CONDITIONAL', 'PREDICTION', 'EXPECTED_VALUE'];
    let lastIdx = -1;
    for (const t of order) {
        const idx = fbBlock[1].indexOf(t);
        assert.ok(idx > lastIdx,
            `findPoolByOutcome fallback order drifted: ${t} not after ${order[order.indexOf(t) - 1] || 'start'}`);
        lastIdx = idx;
    }
});

// ---------------------------------------------------------------------------
// resolveProposalId fallback path 3 — case preservation invariant
// ---------------------------------------------------------------------------

test('source — resolveProposalId direct fallback returns lowercased ids + ORIGINAL-CASE originalProposalId', () => {
    // Pinned: the UI uses originalProposalId for display (snapshot
    // links etc.) and proposalId for canonical lookup. A regression
    // that lowercases originalProposalId loses the user's input casing.
    const m = SRC.match(/return\s*\{\s*proposalId:\s*normalized,[\s\S]*?originalProposalId:\s*proposalId,[\s\S]*?organizationId:\s*null/);
    assert.ok(m,
        `direct fallback shape drifted — must return ` +
        `{proposalId: normalized, proposalAddress: normalized, originalProposalId: proposalId (case-preserved), organizationId: null, organizationName: null}`);
});

test('source — resolveProposalId path 1 (snapshot) and path 2 (org metadata) precede direct fallback', () => {
    // Pinned the 3-step fallback ORDER. A regression that flips path 1
    // and path 2 changes which mapping wins for proposals registered
    // both ways (legacy + new) — silently different metadata picked.
    const fn = SRC.match(/async function resolveProposalId\(proposalId\)\s*\{([\s\S]*?)^\}/m);
    assert.ok(fn);
    const order = ['lookupProposalBySnapshotId', 'lookupProposalInOrgMetadata', 'No registry mapping found'];
    let lastIdx = -1;
    for (const marker of order) {
        const idx = fn[1].indexOf(marker);
        assert.ok(idx > lastIdx,
            `resolveProposalId fallback order drifted: ${marker} not after ${order[order.indexOf(marker) - 1] || 'start'}`);
        lastIdx = idx;
    }
});

// ---------------------------------------------------------------------------
// lookupProposalBySnapshotId — query shape
// ---------------------------------------------------------------------------

test('source — lookupProposalBySnapshotId queries metadataEntries with key="snapshot_id"', () => {
    // Pinned the literal key string. A typo here returns zero entries
    // and every snapshot-link proposal lookup silently falls through
    // to the org-metadata path (slower + may return wrong proposal).
    assert.match(SRC,
        /metadataEntries\(where:\s*\{\s*\n?\s*key:\s*"snapshot_id"/,
        `metadataEntries query key drifted from "snapshot_id"`);
});

test('source — lookupProposalBySnapshotId lowercases the snapshot id BEFORE query', () => {
    // Pinned: snapshot ids are case-sensitive in some clients but the
    // registry stores lowercase. A regression that drops .toLowerCase
    // would mismatch on uppercase input from URL params.
    assert.match(SRC,
        /lookupProposalBySnapshotId\(snapshotProposalId\)\s*\{[\s\S]*?normalizedId\s*=\s*snapshotProposalId\.toLowerCase\(\)/,
        `snapshot id must be lowercased before query`);
});

// ---------------------------------------------------------------------------
// Spot-price :: rate convergence — pinned conversion logic
// ---------------------------------------------------------------------------

test('source — when ticker has "::", spotPrice = rawSpotPrice (already xDAI)', () => {
    // Pinned: tickers with :: have a built-in rate provider so the
    // GeckoTerminal price is already in the conditional-pool unit.
    // A regression that ALWAYS multiplies by currencyRate would
    // double-apply the rate and corrupt spot.
    assert.match(SRC,
        /spotPrice\s*=\s*tickerHasRateProvider\s*\?\s*rawSpotPrice\s*:\s*rawSpotPrice\s*\*\s*currencyRate/,
        `spot-price :: rate convergence drifted — must be: ` +
        `tickerHasRateProvider ? rawSpot : rawSpot * currencyRate`);
});

test('source — tickerHasRateProvider detected via includes("::")', () => {
    // Pinned the detection literal.
    assert.match(SRC,
        /tickerHasRateProvider\s*=\s*ticker\.includes\(['"]::['"]\)/,
        `tickerHasRateProvider detection drifted`);
});

// ---------------------------------------------------------------------------
// Default chainId = 100 (Gnosis) — fallback when proposal config missing
// ---------------------------------------------------------------------------

test('source — chainId defaults to 100 (Gnosis) when resolved.chain is falsy', () => {
    // Pinned: the OR-fallback chainId = resolved.chain || 100. A
    // regression that defaults to 1 (Ethereum) routes EVERY queryless
    // proposal to wrong-chain RPCs — they fail and the response is
    // empty.
    assert.match(SRC,
        /chainId\s*=\s*resolved\.chain\s*\|\|\s*100/,
        `chainId default drifted from 100 (Gnosis)`);
});

// ---------------------------------------------------------------------------
// Response shape — top-level contract pins
// ---------------------------------------------------------------------------

test('source — response has status: "ok" + the 6 documented top-level keys', () => {
    // Pinned: the consumer (futarchy-fi/interface companies + market
    // pages) destructures these keys. Renaming silently breaks the UI.
    const expectedKeys = [
        'status', 'event_id', 'conditional_yes', 'conditional_no',
        'spot', 'company_tokens', 'timeline', 'volume',
    ];
    for (const k of expectedKeys) {
        assert.match(SRC, new RegExp(`${k}:`),
            `response shape missing key "${k}"`);
    }
    // status must be 'ok' literal.
    assert.match(SRC,
        /status:\s*['"]ok['"]/,
        `top-level status must be 'ok'`);
});

test('source — spot block includes pool_ticker (so graphql-proxy can fetch spot candles)', () => {
    // Pinned: the comment says "Include ticker so graphql-proxy can
    // fetch spot candles". A regression that drops it silently breaks
    // the spot candle line on every chart.
    assert.match(SRC,
        /spot:\s*\{[\s\S]*?pool_ticker:\s*ticker\s*\|\|\s*null/,
        `spot.pool_ticker passthrough drifted — graphql-proxy needs this for spot candles`);
});

test('source — fallback symbols: "TOKEN" for company, "CURRENCY" for currency', () => {
    // Pinned: when symbol is missing, these placeholders prevent
    // undefined leaks into the UI. A regression to empty string would
    // render "/" or " " strangely.
    assert.match(SRC, /tokenSymbol:\s*companyToken\?\.\s*symbol\s*\|\|\s*['"]TOKEN['"]/);
    assert.match(SRC, /tokenSymbol:\s*currencyToken\?\.\s*symbol\s*\|\|\s*['"]CURRENCY['"]/);
});

test('source — timeline defaults: 2 days back / 3 days forward when registry config missing', () => {
    // Pinned: matches the getMockedTimeline window. Drift between this
    // inline OR-fallback and getMockedTimeline would surface as
    // inconsistent windows depending on which proposal config keys
    // were missing.
    assert.match(SRC,
        /timelineStart\s*=\s*chartStartRange\s*\|\|\s*\(now\s*-\s*2\s*\*\s*24\s*\*\s*60\s*\*\s*60\)/,
        `timelineStart default drifted from "now - 2 days (in seconds)"`);
    assert.match(SRC,
        /timelineEnd\s*=\s*closeTimestamp\s*\|\|\s*\(now\s*\+\s*3\s*\*\s*24\s*\*\s*60\s*\*\s*60\)/,
        `timelineEnd default drifted from "now + 3 days (in seconds)"`);
});

// ---------------------------------------------------------------------------
// Volume calculation — currency-side pick + USD conversion
// ---------------------------------------------------------------------------

test('source — volume picks currency side via role.includes("CURRENCY")', () => {
    // Pinned: the volume amount must be in CURRENCY units (sDAI),
    // converted to USD via currencyRate. A regression that picks the
    // company-side volume would surface volume in TOKEN units —
    // silently wrong by orders of magnitude.
    assert.match(SRC,
        /token0\?\.\s*role\?\.\s*includes\(['"]CURRENCY['"]\)/,
        `volume currency-side detection drifted`);
});

test('source — volume_usd = currency_volume * (currencyRate || 1)', () => {
    // Pinned the OR-fallback: when currencyRate isn't loaded, treat
    // as 1 (don't crash, just show raw currency volume as USD).
    // A regression that omits the OR would yield NaN volume when
    // rate provider is missing.
    assert.match(SRC,
        /rawCurrency\s*\*\s*\(currencyRate\s*\|\|\s*1\)/,
        `volume_usd formula drifted from rawCurrency * (currencyRate || 1)`);
});

// ---------------------------------------------------------------------------
// IS_CHECKPOINT mode dispatching — adapters chosen by mode
// ---------------------------------------------------------------------------

test('source — handler dispatches resolve based on IS_CHECKPOINT mode', () => {
    // Pinned: Checkpoint uses the registry-adapter path; Graph Node
    // uses the inline resolveProposalId. A regression that always
    // picks one corrupts the other mode silently.
    assert.match(SRC,
        /resolved\s*=\s*IS_CHECKPOINT\s*\?\s*await\s+resolveProposalAdapter\(proposalId\)\s*:\s*await\s+resolveProposalId\(proposalId\)/,
        `IS_CHECKPOINT dispatch shape drifted for resolve`);
});

test('source — handler dispatches fetchPools based on IS_CHECKPOINT mode', () => {
    // Pinned: same dual-mode invariant for pools.
    assert.match(SRC,
        /pools\s*=\s*IS_CHECKPOINT\s*\?\s*await\s+fetchPoolsAdapter\(tradingContractId,\s*chainId\)\s*:\s*await\s+fetchPoolsForProposal\(tradingContractId\)/,
        `IS_CHECKPOINT dispatch shape drifted for fetchPools`);
});

test('source — error path returns 500 with {error: message} (not bare 500)', () => {
    // Pinned: the handler surfaces error messages so the frontend
    // can show specifics. A regression to bare 500 / HTML would
    // strip the message.
    assert.match(SRC,
        /res\.status\(500\)\.json\(\s*\{\s*error:\s*error\.message\s*\}\s*\)/,
        `500 error path shape drifted from {error: error.message}`);
});
