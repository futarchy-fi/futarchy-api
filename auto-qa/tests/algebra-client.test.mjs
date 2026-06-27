/**
 * algebra-client spec mirror (auto-qa).
 *
 * Pins src/services/algebra-client.js — the LEGACY Graph Node-shaped
 * client used as the non-Checkpoint fallback in two route handlers
 * (unified-chart.js, market-events.js). Imported when FUTARCHY_MODE
 * is NOT 'checkpoint'.
 *
 * The Checkpoint adapter (candles-adapter.js) is the modern path; this
 * file's queries are Graph Node-shaped only. Three things matter:
 *
 *   1. ALGEBRA_ENDPOINT === ENDPOINTS.candles. A regression that
 *      hard-codes a stale URL would survive lint but break in deploys
 *      whose ENDPOINTS.candles diverged.
 *
 *   2. period: "3600" — hardcoded 1-hour candle granularity. Drift
 *      silently changes the chart sampling rate and corrupts any
 *      downstream caller comparing periods.
 *
 *   3. getLatestPrice silently returns 0 (not null/undefined/NaN)
 *      when no candle is found. Pinned because callers may treat
 *      0 as "no data" or as "actually 0 price" — a regression
 *      that returns null would crash anything doing arithmetic on
 *      the result.
 *
 *   4. fetchPoolsForProposal uses GraphQL VARIABLE binding ($proposalId)
 *      with type String! — NOT BigInt!, NOT inline string interpolation.
 *      Variable binding protects against injection. A regression to
 *      `where: { proposal: "${proposalId}" }` (inline) would be a
 *      query-injection vector.
 *
 *   5. getLatestPrice's maxTimestamp filter: when null → omit the
 *      _lte filter; when set → include it. A regression that always
 *      includes the filter would either query "everything <= null"
 *      (zero rows) or interpolate "null" literally (invalid query).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/algebra-client.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// Endpoint binding — ALGEBRA_ENDPOINT must come from ENDPOINTS.candles
// ---------------------------------------------------------------------------

test('algebra-client — ALGEBRA_ENDPOINT is bound to ENDPOINTS.candles (not hardcoded)', () => {
    // Pinned so a refactor that hardcodes a URL doesn't drift from the
    // env-driven config. This module imports `{ ENDPOINTS }` from
    // '../config/endpoints.js' — verify the binding.
    assert.match(SRC,
        /import\s*\{\s*ENDPOINTS\s*\}\s*from\s*['"]\.\.\/config\/endpoints\.js['"]/,
        `algebra-client must import ENDPOINTS from config/endpoints.js`);
    assert.match(SRC,
        /ALGEBRA_ENDPOINT\s*=\s*ENDPOINTS\.candles/,
        `ALGEBRA_ENDPOINT must equal ENDPOINTS.candles (env-driven)`);
});

test('algebra-client — does NOT hardcode any URL in module scope', () => {
    // Defensive: scan for inline http(s):// URLs outside of comments.
    // The query strings are templated, so this catches a sneaky hardcoded
    // endpoint that bypasses ENDPOINTS.
    const linesWithUrls = SRC.split('\n').filter(line => {
        // Strip line comments before scanning.
        const codeOnly = line.replace(/\/\/.*$/, '');
        // Skip block-comment continuation lines.
        if (codeOnly.trim().startsWith('*')) return false;
        return /https?:\/\//.test(codeOnly);
    });
    assert.equal(linesWithUrls.length, 0,
        `algebra-client.js contains hardcoded URLs outside comments:\n${linesWithUrls.join('\n')}`);
});

// ---------------------------------------------------------------------------
// fetchPoolsForProposal — GraphQL variable binding (not inline interpolation)
// ---------------------------------------------------------------------------

test('fetchPoolsForProposal — uses $proposalId variable binding (not inline interpolation)', () => {
    // Pinned: inline interpolation `where: { proposal: "${proposalId}" }`
    // would be a query-injection vector. Variable binding routes through
    // the GraphQL parser.
    assert.match(SRC,
        /query\s+GetProposalPools\s*\(\s*\$proposalId:\s*String!\s*\)/,
        `fetchPoolsForProposal must declare $proposalId: String! as a query variable`);
    assert.match(SRC,
        /pools\(where:\s*\{\s*proposal:\s*\$proposalId\s*\}\)/,
        `fetchPoolsForProposal must reference $proposalId via where clause (not inline)`);
});

test('fetchPoolsForProposal — variable type is String! (not BigInt!)', () => {
    // Pinned: Graph Node accepts String for ID fields; using BigInt!
    // would be a Checkpoint-shape mistake (Checkpoint uses different
    // scalars). This module is Graph-Node-shaped per its docstring.
    assert.match(SRC,
        /\$proposalId:\s*String!/,
        `proposalId must be String! — BigInt! is wrong shape for Graph Node`);
    assert.doesNotMatch(SRC,
        /\$proposalId:\s*BigInt/,
        `proposalId must NOT be typed as BigInt (Graph Node uses String for ID-like fields)`);
});

test('fetchPoolsForProposal — passes proposalId via fetch body variables, not query body', () => {
    // The variable goes in the JSON body's `variables` object, not
    // template-substituted into the query string.
    assert.match(SRC,
        /body:\s*JSON\.stringify\(\s*\{\s*query,\s*variables:\s*\{\s*proposalId\s*\}\s*\}\)/,
        `fetchPoolsForProposal must pass proposalId via variables object (not template-substituted)`);
});

// ---------------------------------------------------------------------------
// getLatestPrice — period 3600 (1 hour) hardcoded
// ---------------------------------------------------------------------------

test('getLatestPrice — period is hardcoded "3600" (1 hour candles)', () => {
    // Pinned: 3600 = 1 hour. Drift to 60 (1 min) would 60x the data
    // volume and change chart sampling. Drift to 86400 (1 day) would
    // make charts look empty for short proposals.
    // Both whereClause branches must use period "3600".
    const periodMatches = [...SRC.matchAll(/period:\s*['"](\d+)['"]/g)];
    assert.ok(periodMatches.length >= 2,
        `expected at least 2 references to period in getLatestPrice (one per branch); found ${periodMatches.length}`);
    for (const m of periodMatches) {
        assert.equal(m[1], '3600',
            `period drifted from "3600" (1 hour) to "${m[1]}". ` +
            `Changes candle granularity for every getLatestPrice caller.`);
    }
});

// ---------------------------------------------------------------------------
// getLatestPrice — maxTimestamp branching (filter included only when set)
// ---------------------------------------------------------------------------

test('getLatestPrice — maxTimestamp parameter defaults to null (not undefined)', () => {
    // Pinned because the ternary checks `maxTimestamp ?` — undefined
    // would also fall to the no-filter branch, but null is the explicit
    // signal. A refactor that defaults to 0 would always exclude all
    // candles (since periodStartUnix_lte: "0" matches nothing).
    assert.match(SRC,
        /getLatestPrice\(poolId,\s*maxTimestamp\s*=\s*null\)/,
        `maxTimestamp must default to null (not undefined, not 0)`);
});

test('getLatestPrice — when maxTimestamp set, includes periodStartUnix_lte filter', () => {
    assert.match(SRC,
        /periodStartUnix_lte:\s*"\$\{maxTimestamp\}"/,
        `maxTimestamp branch must include periodStartUnix_lte: "\${maxTimestamp}"`);
});

test('getLatestPrice — when maxTimestamp null, omits periodStartUnix_lte filter', () => {
    // The ternary structure: `maxTimestamp ? <filter+lte> : <filter without lte>`.
    // Verify the no-filter branch doesn't reference _lte.
    const m = SRC.match(/whereClause\s*=\s*maxTimestamp[\s\S]*?:\s*`([^`]+)`/);
    assert.ok(m, 'no-filter ternary branch not found');
    assert.doesNotMatch(m[1], /_lte/,
        `the no-maxTimestamp branch must NOT include periodStartUnix_lte`);
});

// ---------------------------------------------------------------------------
// getLatestPrice — orderBy + orderDirection invariants
// ---------------------------------------------------------------------------

test('getLatestPrice — orderBy: periodStartUnix, orderDirection: desc, first: 1', () => {
    // To get the LATEST candle: must sort by periodStartUnix DESC and
    // take the first row. A regression to `orderDirection: asc` would
    // return the OLDEST candle — silent data corruption.
    assert.match(SRC,
        /first:\s*1[\s\S]*orderBy:\s*periodStartUnix[\s\S]*orderDirection:\s*desc/,
        `getLatestPrice query must be: first: 1, orderBy: periodStartUnix, orderDirection: desc`);
});

// ---------------------------------------------------------------------------
// Default-zero behavior — silent zero, not null/undefined/throw
// ---------------------------------------------------------------------------

test('getLatestPrice — returns 0 (not null) when no candle found', () => {
    // Pinned: the code does `candle ? parseFloat(candle.close) : 0`.
    // Callers (unified-chart, market-events) expect a numeric value.
    // A refactor that returns null would crash arithmetic in callers.
    assert.match(SRC,
        /return\s+candle\s*\?\s*parseFloat\(candle\.close\)\s*:\s*0/,
        `getLatestPrice must return 0 (not null/undefined) when no candle found`);
});

test('getLatestPrice — uses parseFloat (not Number, not parseInt) on candle.close', () => {
    // Pinned: candle.close is a string from the subgraph, can be a
    // decimal like "0.012345". parseInt would truncate to "0";
    // Number("") would yield 0 instead of NaN; parseFloat is the
    // correct widget.
    assert.match(SRC, /parseFloat\(candle\.close\)/);
    assert.doesNotMatch(SRC, /parseInt\(candle\.close/,
        `must NOT use parseInt — would truncate decimal prices to integer`);
});

// ---------------------------------------------------------------------------
// Error handling — both functions throw on GraphQL errors
// ---------------------------------------------------------------------------

test('algebra-client — both functions throw on GraphQL errors[0].message', () => {
    // Pinned: silent error swallowing would surface as empty data
    // downstream. The pattern `if (errors) throw new Error(errors[0].message)`
    // surfaces the GraphQL error to the route handler.
    const matches = [...SRC.matchAll(/if\s*\(errors\)\s*\{?\s*throw\s+new\s+Error\(errors\[0\]\.message\)/g)];
    assert.equal(matches.length, 2,
        `expected exactly 2 GraphQL-error-throw guards (one per exported function); got ${matches.length}`);
});

test('algebra-client — fetchPoolsForProposal returns [] (not null) when data.pools is missing', () => {
    // Pinned: `return data.pools || []` — falsy data.pools coerces to [].
    // A refactor that returns null would force every caller to add a
    // null guard.
    assert.match(SRC,
        /return\s+data\.pools\s*\|\|\s*\[\]/,
        `fetchPoolsForProposal must return data.pools || [] (default to empty array)`);
});

// ---------------------------------------------------------------------------
// Pool query selection set — Graph-Node-only fields
// ---------------------------------------------------------------------------

test('fetchPoolsForProposal — selects nested token0/token1 with id/symbol/role', () => {
    // Pinned the nested selection — Graph Node supports it; Checkpoint
    // would reject (token0 is a String! scalar in Checkpoint). This
    // mismatch is precisely why callers route to candles-adapter.js
    // (not this file) when in Checkpoint mode.
    assert.match(SRC,
        /token0\s*\{\s*id\s+symbol\s+role\s*\}/,
        `pools query must select nested token0 { id symbol role } (Graph-Node-only shape)`);
    assert.match(SRC,
        /token1\s*\{\s*id\s+symbol\s+role\s*\}/,
        `pools query must select nested token1 { id symbol role }`);
});

test('fetchPoolsForProposal — selects nested proposal { ... companyToken / currencyToken } block', () => {
    // Same Graph-Node-only shape pinning. The companyToken/currencyToken
    // nested selection would also fail against Checkpoint.
    assert.match(SRC,
        /proposal\s*\{[\s\S]*companyToken\s*\{\s*id\s+symbol\s*\}[\s\S]*currencyToken\s*\{\s*id\s+symbol\s*\}/,
        `pools query must select nested proposal { ... companyToken/currencyToken { id symbol } }`);
});

// ---------------------------------------------------------------------------
// Module-level docstring — declares LEGACY status
// ---------------------------------------------------------------------------

test('algebra-client — docstring labels module as legacy / Graph-Node-only', () => {
    // Pinned because callers must understand to use candles-adapter.js
    // for mode-aware code. A refactor that drops this comment risks
    // someone wiring algebra-client into a new code path.
    assert.match(SRC,
        /Graph Node|graph[-_ ]node/i,
        `module docstring must mention Graph Node (legacy mode)`);
    assert.match(SRC,
        /candles-adapter/,
        `module docstring must direct readers to candles-adapter for mode-aware code`);
});
