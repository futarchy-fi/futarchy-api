/**
 * src/index.js Express app shape spec mirror (auto-qa).
 *
 * Pins src/index.js — the top-level Express server. Most behavior is
 * exercised by the integration tests (passthrough-smoke, cors-headers,
 * etc.) but the file's STRUCTURE has invariants that don't show up
 * in those tests:
 *
 *   1. PORT = 3031, listening on '0.0.0.0' (LAN-accessible — pinned
 *      because dev workflow depends on it).
 *   2. Middleware ORDER: cors → express.json → app.disable('etag') →
 *      path-prefix middleware → route handlers. Wrong order silently
 *      changes behavior (etag enabled → 304 responses; path-prefix
 *      after routes → /charts paths 404).
 *   3. /candles/graphql endpoint:
 *      - missing query → 400 with errors envelope (not 500).
 *      - default chainId = 100 (Gnosis) when no $chainId variable.
 *      - upstream error → 502 with errors envelope.
 *   4. /api/v1/spot-candles endpoint:
 *      - composite:: tickers SKIP rate divisor (the comment notes
 *        composite pools natively divide in the backend proxy —
 *        applying again would double-divide).
 *      - Historical cache key bucketed by day when max < now - 3 days.
 *      - Cache bypass when USE_FUTARCHY_SPOT.
 *      - 400 when ticker missing.
 *   5. Warmer init: USE_FUTARCHY_SPOT short-circuits BEFORE the
 *      ENABLE_WARMER check (futarchy-spot's worker handles refresh).
 *   6. Route registration — pinned the 8 routes the file exposes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/index.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// Server constants — PORT, listen address
// ---------------------------------------------------------------------------

test('app — PORT = 3031', () => {
    // Pinned: changing the dev port breaks every developer's local
    // VITE_FUTARCHY_API_URL setting AND the canonical "where does the
    // local server run" doc convention.
    assert.match(SRC, /const\s+PORT\s*=\s*3031/,
        `PORT drifted from 3031 — breaks local dev convention + frontend env`);
});

test('app — listens on 0.0.0.0 (NOT 127.0.0.1) for LAN access', () => {
    // Pinned: 0.0.0.0 lets phones / other devices on the LAN reach
    // the local API for mobile testing. A regression to 127.0.0.1
    // silently breaks that workflow.
    assert.match(SRC, /app\.listen\(PORT,\s*['"]0\.0\.0\.0['"]/,
        `listen address must be '0.0.0.0' — 127.0.0.1 blocks LAN access`);
});

// ---------------------------------------------------------------------------
// Middleware order — cors → json → etag-disable → path-prefix → routes
// ---------------------------------------------------------------------------

test('middleware — cors() registered BEFORE express.json()', () => {
    const corsIdx = SRC.indexOf('app.use(cors(');
    const jsonIdx = SRC.indexOf('app.use(express.json())');
    assert.ok(corsIdx > -1 && jsonIdx > -1);
    assert.ok(corsIdx < jsonIdx,
        `cors() must precede express.json() — CORS preflight needs to fire ` +
        `before body parsing. Reverse order would 415 some preflights.`);
});

test('middleware — etag disabled (prevents 304 caching)', () => {
    // Pinned: the file comment says "Prevent 304 — ensures browser
    // always gets fresh response". A regression that enables etag
    // would silently start serving 304s on chart endpoints — frontend
    // would see "no body" responses and either crash or render stale
    // data.
    assert.match(SRC,
        /app\.disable\(['"]etag['"]\)[\s\S]*?Prevent 304/,
        `app.disable('etag') drifted — would re-introduce 304s on chart endpoints`);
});

test('middleware — path-prefix middleware registered BEFORE route handlers', () => {
    // Pinned: the /charts path-strip MUST run before the handlers,
    // otherwise /charts/api/v2/... 404s before reaching the unprefixed
    // handler.
    const middlewareIdx = SRC.indexOf("req.url.startsWith('/charts/')");
    const firstRouteIdx = SRC.indexOf("app.get('/health'");
    assert.ok(middlewareIdx > -1 && firstRouteIdx > -1);
    assert.ok(middlewareIdx < firstRouteIdx,
        `path-prefix middleware must precede route handlers — Snapshot widget ` +
        `still uses prefixed URLs (/charts/...). Reverse order = 404 from snapshot.`);
});

// ---------------------------------------------------------------------------
// Path-prefix logic — strip /charts/ prefix
// ---------------------------------------------------------------------------

test('path-prefix — /charts/foo → /foo (slice prefix length)', () => {
    assert.match(SRC,
        /req\.url\s*=\s*req\.url\.slice\(['"]\/charts['"]\.length\)/,
        `/charts/foo → /foo strip shape drifted`);
});

test('path-prefix — bare /charts → /', () => {
    // Pinned the bare-/charts case (no trailing slash). Without this
    // branch, hitting GET /charts would 404.
    assert.match(SRC,
        /req\.url\s*===\s*['"]\/charts['"][\s\S]*?req\.url\s*=\s*['"]\/['"]/,
        `bare /charts → / strip shape drifted`);
});

// ---------------------------------------------------------------------------
// /candles/graphql endpoint — query guard + default chainId + error envelope
// ---------------------------------------------------------------------------

test('/candles/graphql — missing query → 400 with errors envelope', () => {
    // Pinned: GraphQL clients expect the {errors:[{message}]} shape.
    // A regression to plain text 400 would surface as a confusing
    // "no errors array" exception in the consumer.
    assert.match(SRC,
        /if\s*\(!query\)\s*\{[\s\S]*?return\s+res\.status\(400\)\.json\(\{\s*errors:\s*\[\s*\{\s*message:\s*['"]\[candles\] missing query['"]/,
        `missing-query guard shape drifted — must be 400 with {errors:[{message}]} envelope`);
});

test('/candles/graphql — default chainId = 100 (Gnosis) when no $chainId variable', () => {
    // Pinned: callers can override via $chainId variable but the
    // default targets Gnosis. A regression to 1 (Ethereum) silently
    // routes Gnosis pool queries to the wrong chain → empty results.
    assert.match(SRC,
        /chainId\s*=\s*parseInt\(variables\?\.\s*chainId\)\s*\|\|\s*100/,
        `default chainId in /candles/graphql drifted from 100 (Gnosis)`);
});

test('/candles/graphql — upstream error → 502 with errors envelope', () => {
    // Pinned: 502 (Bad Gateway) is the right code for an upstream
    // failure. A regression to 500 would conflate handler bugs with
    // upstream outages.
    assert.match(SRC,
        /res\.status\(502\)\.json\(\{\s*errors:\s*\[\s*\{\s*message:\s*`\[candles\] upstream error:/,
        `upstream-error response shape drifted from 502 + {errors:[{message: "[candles] upstream error: ..."}]} `);
});

// ---------------------------------------------------------------------------
// /api/v1/spot-candles — composite:: skip + historical cache key + USE_FUTARCHY_SPOT bypass
// ---------------------------------------------------------------------------

test('/spot-candles — ticker missing → 400 with {error}', () => {
    assert.match(SRC,
        /if\s*\(!ticker\)\s*return\s+res\.status\(400\)\.json\(\{\s*error:\s*['"]ticker required['"]\s*\}\)/,
        `missing-ticker guard drifted from 400 + {error: 'ticker required'}`);
});

test('/spot-candles — composite:: tickers SKIP rate divisor (comment-pinned reason)', () => {
    // Pinned: composite pools natively divide their prices in the
    // backend proxy (spot-price.js). Re-applying the divisor here
    // would DOUBLE-divide → silent price corruption.
    // Source: ticker.includes('::') && !ticker.startsWith('composite::')
    assert.match(SRC,
        /ticker\.includes\(['"]::['"]\)\s*&&\s*!ticker\.startsWith\(['"]composite::['"]\)/,
        `composite:: skip drifted — composite tickers MUST be excluded from rate division`);
});

test('/spot-candles — historical threshold = 3 days (max < now - 3 * 86400)', () => {
    // Pinned: requests for data older than 3 days get a date-bucketed
    // cache key (one entry per UTC day). Recent requests use a
    // single shared key. Drift in the threshold changes the cache
    // partitioning — too low = excessive memory; too high = stale.
    assert.match(SRC,
        /isHistorical\s*=\s*max\s*<\s*\(now\s*-\s*3\s*\*\s*86400\)/,
        `historical threshold drifted from 3 days (3 * 86400 seconds)`);
});

test('/spot-candles — historical cache key bucketed by day (Math.floor(max/86400))', () => {
    assert.match(SRC,
        /\$\{ticker\}:hist:\$\{Math\.floor\(max\s*\/\s*86400\)\}/,
        `historical cache key shape drifted from "<ticker>:hist:<dayBucket>"`);
});

test('/spot-candles — USE_FUTARCHY_SPOT bypasses cache (comment: SQLite IS the cache)', () => {
    // Pinned: when futarchy-spot is wired, its SQLite acts as the
    // cache layer. Adding cache here would just duplicate / stale.
    assert.match(SRC,
        /if\s*\(USE_FUTARCHY_SPOT\)\s*\{[\s\S]*?spotData\s*=\s*await\s+fetchSpotCandles/,
        `USE_FUTARCHY_SPOT must short-circuit BEFORE the spotCache.get path`);
});

test('/spot-candles — error path responds 500 + {error, spotCandles: []} (envelope shape)', () => {
    // Pinned: returning spotCandles:[] keeps the consumer's shape
    // assumptions intact even on error — no NPE on `.length` etc.
    assert.match(SRC,
        /res\.status\(500\)\.json\(\{\s*error:\s*error\.message,\s*spotCandles:\s*\[\]\s*\}\)/,
        `error response shape drifted from {error, spotCandles: []}`);
});

// ---------------------------------------------------------------------------
// Warmer init — USE_FUTARCHY_SPOT short-circuits before ENABLE_WARMER
// ---------------------------------------------------------------------------

test('warmer init — USE_FUTARCHY_SPOT short-circuits BEFORE ENABLE_WARMER check', () => {
    // Pinned: order matters. If ENABLE_WARMER were checked first,
    // setting USE_FUTARCHY_SPOT=true would still start the warmer
    // (wasted work + duplicate refreshes against SQLite).
    const ufsIdx = SRC.indexOf('if (USE_FUTARCHY_SPOT) {');
    const ewIdx = SRC.indexOf('else if (ENABLE_WARMER)');
    assert.ok(ufsIdx > -1 && ewIdx > -1);
    assert.ok(ufsIdx < ewIdx,
        `USE_FUTARCHY_SPOT branch must precede ENABLE_WARMER branch`);
});

test('warmer init — startWarmer is called with refreshChart as the callback', () => {
    // Pinned: the warmer needs the actual chart-refresh callback to
    // know what to keep warm. A regression that calls startWarmer with
    // a no-op silently disables the optimization.
    assert.match(SRC,
        /startWarmer\(async\s*\(params\)\s*=>\s*\{\s*await\s+refreshChart\(params\);?\s*\}\)/,
        `startWarmer must be called with refreshChart-wrapping callback`);
});

// ---------------------------------------------------------------------------
// Route registration — pinned 8 endpoints
// ---------------------------------------------------------------------------

test('routes — /health endpoint registered (returns {status, timestamp})', () => {
    assert.match(SRC,
        /app\.get\(['"]\/health['"][\s\S]*?status:\s*['"]ok['"][\s\S]*?timestamp:\s*new Date\(\)\.toISOString\(\)/,
        `/health endpoint shape drifted`);
});

test('routes — /warmer endpoint registered (returns getWarmerStatus())', () => {
    assert.match(SRC,
        /app\.get\(['"]\/warmer['"][\s\S]*?getWarmerStatus\(\)/,
        `/warmer endpoint shape drifted`);
});

test('routes — /api/v2/proposals/:proposalId/chart wired to handleUnifiedChartRequest', () => {
    assert.match(SRC,
        /app\.get\(['"]\/api\/v2\/proposals\/:proposalId\/chart['"],\s*handleUnifiedChartRequest\)/,
        `unified-chart route shape drifted`);
});

test('routes — /api/v1/market-events/proposals/:proposalId/prices wired to handleMarketEventsRequest', () => {
    assert.match(SRC,
        /app\.get\(['"]\/api\/v1\/market-events\/proposals\/:proposalId\/prices['"],\s*handleMarketEventsRequest\)/,
        `market-events route shape drifted`);
});

test('routes — /subgraphs/name/algebra-proposal-candles-v1 (legacy alias) wired to handleGraphQLRequest', () => {
    // Pinned: legacy subgraph URL kept for back-compat with old
    // frontends. Removing it breaks any consumer still pointing at
    // the AWS-style URL.
    assert.match(SRC,
        /app\.post\(['"]\/subgraphs\/name\/algebra-proposal-candles-v1['"],\s*handleGraphQLRequest\)/,
        `legacy /subgraphs/... alias drifted`);
});

test('routes — /registry/graphql wired to makeGraphQLPassthrough(ENDPOINTS.registry, "registry")', () => {
    assert.match(SRC,
        /app\.post\(['"]\/registry\/graphql['"],\s*makeGraphQLPassthrough\(\(\)\s*=>\s*ENDPOINTS\.registry,\s*['"]registry['"]\)\)/,
        `/registry/graphql passthrough wiring drifted — must use makeGraphQLPassthrough with label 'registry'`);
});

// ---------------------------------------------------------------------------
// CORS — invariants beyond what cors-headers.test.mjs already covers
// ---------------------------------------------------------------------------

test('cors — Apollo-Require-Preflight is in allowedHeaders (Apollo client compat)', () => {
    // Pinned: Apollo Client adds this header automatically. Without
    // it in the allow-list, every Apollo-driven query is blocked by
    // CORS.
    assert.match(SRC,
        /allowedHeaders:\s*\[[^\]]*['"]Apollo-Require-Preflight['"]/,
        `cors allowedHeaders missing 'Apollo-Require-Preflight' — Apollo Client requests blocked`);
});

test('cors — X-Cache and X-Response-Time are exposed (debug observability)', () => {
    // Pinned: these debug headers let consumers (and the network tab)
    // see cache-hit/-miss + response-time without dev-tools tricks.
    assert.match(SRC,
        /exposedHeaders:\s*\[[^\]]*['"]X-Cache['"][^\]]*['"]X-Response-Time['"]/,
        `exposedHeaders drifted — X-Cache + X-Response-Time must be exposed for debug`);
});
