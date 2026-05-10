# Auto-QA Progress — futarchy-fi/futarchy-api

Working ledger for the `/loop` auto-QA initiative on the API repo.
Same methodology as `interface/auto-qa/PROGRESS.md`. Production code
is never modified — only tests on the `auto-qa` branch.

## Status snapshot

| Field | Value |
|---|---|
| Branch | `auto-qa` (off `origin/main`) |
| Iterations completed | 40 |
| PRs catalogued | 9 / 9 (full history) |
| PRs classified | 9 |
| Tests added | 592 (2 path-prefix + 7 passthrough-contract + 4 unified-chart + 3 multi-proposal-smoke + 3 spot-candles + 3 indexer-freshness + 4 registry-org-shape + 6 legacy-v1-prices + 3 operational-endpoints + 11 passthrough-smoke + 21 cors-headers + 6 cache-headers + 9 chart-window-invariants + 6 legacy-subgraph-alias + 11 chart-envelope-shape + 8 proposal-id-handling + 21 chain-prefix-helpers + 16 extract-tokens-from-pools + 17 cache-class + 11 endpoints-config + 11 warmer-list-management + 12 rate-provider-config + 13 spot-source-config + 20 spot-price-parse-config + 20 registry-adapter + 17 spot-price-helpers + 17 algebra-client + 20 graphql-passthrough-factory + 27 graphql-proxy-helpers + 32 proxy-candles-rewriter + 29 market-events-helpers + 26 index-app-shape + 32 candles-adapter-shape + 37 unified-chart-shape + 25 registry-adapter-resolve + 34 spot-price-fetchers + 26 fetch-spot-candles + 22 rate-provider-runtime — 590 passing, 1 skipped, **1 FAILING (pre-existing infra alarm — Gnosis candles indexer lag)**) |
| Cross-cutting catches | catastrophic-empty guards, indexer freshness bounds, metadata parseability, **parse-error status inconsistency between passthroughs**, CORS preflight + Apollo header allow-list + expose-headers, cache-layer disablement / stale-key / TTL drift |
| Ops invariants tracked | indexer lag (candles + registry) bounded vs. Gnosis chain tip — **iter 37: ALARM FIRING — Gnosis candles indexer at 46098065, chain tip 46103176, 5111 blocks behind (threshold 5000, ~7h of lag). Test working as designed; surfacing real ops issue. Per /loop: not silenced.** |
| PRs covered by tests | **8 / 9** (#1, #3, #4, #5, #6, #7, #8, #9 — only #2 infra remains) |
| API surfaces with smoke tests | **4 / 4** (`/api/v2/.../chart`, `/candles/graphql`, `/api/v1/spot-candles`, `/subgraphs/name/algebra-proposal-candles-v1` legacy alias) |
| Data-quality issues surfaced | 2 proposals (TSLA Mega Package, CIP-82) return zero prices + "TOKEN" fallback symbol — see below |
| **Real bugs surfaced** | **`/candles/graphql` returns HTTP 502 on malformed query (should be 400 like /registry/graphql)** — pinned in `passthrough-smoke.test.mjs::PARSE_ERROR_STATUS`; **hardcoded CoinGecko API key fallback in `src/services/spot-price.js` (`GECKO_API_KEY` default)** — pinned for ratchet in `spot-source-config.test.mjs` |
| Test runner | `node --test` via `npm run auto-qa:test` |
| Tooling backlog | see below |

## PR ledger

### PR #9 — fix(api): preserve periodStartUnix as distinct snapped field
- **Class**: bug-fix
- **Hypothesis**: `proxyCandlesQuery` in `src/adapters/candles-adapter.js` rewrote every `periodStartUnix` substring in inbound queries to `time` (and synthesized `periodStartUnix = String(time)` on the way back), assuming Checkpoint only had a single timestamp field. Checkpoint actually exposes both `time` (raw last-swap ts) AND `periodStartUnix` (period-snapped boundary). Collapsing them returned raw swap times to clients asking for `periodStartUnix`, breaking the frontend chart's carry-forward fill — flat line at the earliest candle's price.
- **Ideal test**: Contract test for the proxy — for each declared response-field semantic ("`periodStartUnix` MUST be a multiple of `period`"), assert that property holds for every candle returned. Generalizes to "any proxy translation must preserve documented field semantics".
- **Tools needed**: HTTP test client + a fixture proposal with known candles + a property-checker that walks every candle in the response.
- **Test status**: **landed-passing** (`auto-qa/tests/passthrough-contract.test.mjs`, 2 cases: snapping property + filter operator)

### PR #8 — fix(api): translate pool_in/proposal_in array filters in passthrough
- **Class**: bug-fix
- **Hypothesis**: The `/candles/graphql` proxy chain-prefixed scalar `pool: "0xabc"` filters but missed list-form `pool_in: ["0xabc", "0xdef"]` and `proposal_in: [...]`. Frontend bulk queries returned 0 results.
- **Ideal test**: For every supported filter operator (`{eq, in, gte, lte, …}` × `{pool, proposal, id, …}`), send a query with a known-good address and assert non-empty result. Catches "we forgot to handle the array form" and any future filter the proxy forgets.
- **Tools needed**: Same HTTP test client + fixture-driven matrix runner.
- **Test status**: **landed-passing** (`auto-qa/tests/passthrough-contract.test.mjs`, 2 cases: id_in + proposal_in)
- **Test status**: not-started (TODO future iteration)

### PR #7 — fix(api): translate proposal: filter syntax in candles passthrough
- **Class**: bug-fix
- **Hypothesis**: Proxy translated `pool: "0xabc"` but not `proposal: "0xabc"`. Same family as #8 (incomplete filter coverage). Symptom: queries filtering by proposal address returned empty when going through `/candles/graphql`.
- **Ideal test**: subsumed by #8's matrix.
- **Tools needed**: same as #8.
- **Test status**: **landed-passing** (covered by `passthrough-contract.test.mjs` PR #7 case) (TODO future iteration)

### PR #6 — fix(api): resolve token symbols from any pool type, drop PNK fallback
- **Class**: bug-fix
- **Hypothesis**: `unified-chart.js` / `market-events.js` only inspected `CONDITIONAL` pools to derive company/currency token symbols. New markets where CONDITIONAL pools weren't yet indexed (or didn't exist) fell through to the `'PNK'` hardcode → wrong ticker on charts. Fix: walk pools in priority `CONDITIONAL > EXPECTED_VALUE > PREDICTION` and parse the pool name regex.
- **Ideal test**: Snapshot test against `GET /api/v2/proposals/:id/chart` for proposals representing each (CONDITIONAL+, EXPECTED_VALUE+, PREDICTION-only) state — assert `company_tokens.base.tokenSymbol` is plausible and is NEVER literally `"PNK"` unless the proposal really is for PNK.
- **Tools needed**: HTTP client + fixtures for each market lifecycle stage. Hard part is finding/keeping a "PREDICTION-only" fixture stable.
- **Test status**: **landed-passing — TWO LAYERS** (a) `auto-qa/tests/unified-chart.test.mjs` PR #6 case asserts the end-to-end `base.tokenSymbol === "GNO"` against the live API; (b) `auto-qa/tests/extract-tokens-from-pools.test.mjs` (16 cases) directly pins the `extractTokensFromPools` priority chain (CONDITIONAL > EXPECTED_VALUE > PREDICTION), pattern matching, defensive null/missing-name handling, whitespace tolerance, and explicitly that no code path returns "PNK"

### PR #5 — fix(api): fall back to PREDICTION/EXPECTED_VALUE pools for new markets
- **Class**: bug-fix
- **Hypothesis**: Same family as #6 — endpoints assumed CONDITIONAL pools always existed. For new proposals where only PREDICTION/EXPECTED_VALUE pools are indexed yet, endpoints returned null prices.
- **Ideal test**: subsumed by #6's snapshot suite — assert prices are non-null for every market lifecycle stage.
- **Tools needed**: same as #6.
- **Test status**: **landed-passing** (`auto-qa/tests/unified-chart.test.mjs` PR #5 case — asserts both YES + NO `price_usd > 0`. TODO: add fixtures for EXPECTED_VALUE-only and PREDICTION-only markets to fully exercise the fallback chain.)

### PR #4 — fix(api): translate plain pool IDs in /candles/graphql passthrough
- **Class**: bug-fix
- **Hypothesis**: Proxy missed the inline scalar `pool: "0xabc"` form (only handled some other variant). Same family as #7, #8.
- **Ideal test**: subsumed by #8's matrix.
- **Tools needed**: same.
- **Test status**: **landed-passing** (covered by `passthrough-contract.test.mjs` PR #4 case) (TODO future iteration)

### PR #3 — feat(api): /registry/graphql and /candles/graphql passthroughs
- **Class**: feature
- **Hypothesis**: n/a
- **Ideal test**: Smoke test — passthroughs return HTTP 200 and a well-formed GraphQL envelope (`data` or `errors` key) for a trivial introspection query. Catches infra regressions (route mounted? upstream reachable? HTTPS termination working?).
- **Tools needed**: HTTP client.
- **Test status**: **landed-passing** (`auto-qa/tests/passthrough-smoke.test.mjs`, 11 cases — `{ __typename }` and `__schema` introspection on both endpoints, malformed-query envelope shape, GET rejection, parallel responsiveness, plus a baseline test pinning the surfaced inconsistency: `/candles/graphql` returns 502 on parse errors while `/registry/graphql` returns 400)

### PR #2 — infra(rpc-proxy): multi-RPC pool with tip buffer, failover, hash pinning
- **Class**: infra (also has bug-prevention character — pre-empts reorg loops)
- **Hypothesis**: n/a (not strictly fixing an in-flight bug, but hardening against a known failure mode)
- **Ideal test**: Inject a flaky upstream RPC and assert the pool failover completes within a deadline. Hash-pinning correctness check: ensure the proxy serves consistent block hashes across N consecutive requests for the same height.
- **Tools needed**: mock upstream RPC + ability to introspect proxy state.
- **Test status**: not-started (TODO future iteration)

### PR #1 — Restore /charts path prefix for Snapshot widget
- **Class**: bug-fix
- **Hypothesis**: After Cloud Run migration the legacy AWS API Gateway `/charts/...` path prefix was lost. The Snapshot widget at `snapshot-labs/sx-monorepo` still hits `https://api.futarchy.fi/charts/api/v2/...`. Without the prefix-strip middleware the route 404'd. Fix: add Express middleware that strips `/charts` from incoming URLs.
- **Ideal test**: Send `GET /charts/api/v2/proposals/:id/chart` and `GET /api/v2/proposals/:id/chart` to the same fixture proposal — assert they return identical JSON. Catches future accidental removal of the prefix-strip middleware.
- **Tools needed**: HTTP client + fixture proposal.
- **Test status**: **landed-passing** (`auto-qa/tests/path-prefix.test.mjs`, 2 cases, both green against live api.futarchy.fi)

## Class summary

| Class | Count | PRs |
|---|---|---|
| bug-fix | 7 | #1, #4, #5, #6, #7, #8, #9 |
| feature | 1 | #3 |
| infra | 1 | #2 |

## Cross-cutting tests (not tied to a single PR)

| Test | Catches | File |
|---|---|---|
| **CORS headers** | cors() middleware dropped, stricter origin allowlist, missing Apollo-Require-Preflight, expose-headers regression | `auto-qa/tests/cors-headers.test.mjs` (21 cases — preflight × origin matrix + actual-response CORS + Apollo header allow-list + X-Cache observability headers + pinned-policy ratchet) |
| **Cache headers** | cache-layer silently disabled, X-Cache value drift, TTL = 0 / unbounded, cache key includes non-deterministic component, HIT path silently degraded | `auto-qa/tests/cache-headers.test.mjs` (6 cases — header presence + HIT/MISS literal + TTL bounds + Response-Time format + back-to-back HIT determinism + HIT-vs-MISS latency ceiling) |
| **Chart window invariants** | window predicate flipped (>= ↔ <=), sort order inverted, default-window logic returning unbounded data, inverted/future/past windows crashing the upstream passthrough | `auto-qa/tests/chart-window-invariants.test.mjs` (9 cases — degenerate-window graceful handling + within-window invariant + strictly-ascending sort + candle shape parseability + 1-second snapping boundary) |
| **Legacy subgraph alias** | `/subgraphs/name/algebra-proposal-candles-v1` removed (would silently 404 the Snapshot widget + pre-Cloud-Run integrations), legacy/modern routes drift, spotCandles injection lost | `auto-qa/tests/legacy-subgraph-alias.test.mjs` (6 cases — POST 200 + GET rejected + spotCandles injection invariant + negative confirmation that modern route does NOT inject + cross-route data shape parity + malformed-query envelope) |
| **Chart envelope shape** | numeric type heterogeneity flipped (price_usd as string, or volume normalized to number losing precision), uppercase address leak, chain_id drift, YES/NO pool collapse, "TOKEN" fallback on canonical fixture | `auto-qa/tests/chart-envelope-shape.test.mjs` (11 cases — price_usd as number / volume as string invariant + address-shape regex + YES≠NO pool distinctness + timeline integrity + chain_id=100 pin + token-symbol non-fallback) |
| **Proposal ID handling** | case-insensitive lookup broken (uppercase request resolves different/no pool), garbage input crashes the proxy (5xx leak), path-traversal payload reaches upstream as a literal, oversized id triggers buffer-style bug | `auto-qa/tests/proposal-id-handling.test.mjs` (8 cases — uppercase==lowercase data parity + event_id case-normalization + zero-address graceful 200 + "TOKEN" fallback for zero-addr + non-hex/short/path-traversal/very-long inputs all 2xx, no 5xx) |
| **Operational endpoints** | /health stale, /warmer broken, edge cache freezing /health timestamp | `auto-qa/tests/operational-endpoints.test.mjs` |
| **Indexer freshness** | candles + registry indexer stalls (lag vs. Gnosis chain tip) | `auto-qa/tests/indexer-freshness.test.mjs` |

## Tooling backlog

Ranked by leverage across the catalogue.

| Rank | Tool | Catches | Effort |
|---|---|---|---|
| 1 | **GraphQL passthrough contract test** — matrix-driven HTTP client that hits `/candles/graphql` with every supported filter shape against a fixture proposal, validates response semantics (chain prefix stripping, `periodStartUnix` snapping, non-empty filter matches). | #4, #7, #8, #9 (4/9) | Low-Medium |
| 2 | **Unified-chart endpoint snapshot test** — `GET /api/v2/proposals/:id/chart` against fixtures spanning each market lifecycle stage; assert non-null prices, plausible token symbols, no `"PNK"` leak. | #5, #6 (2/9) | Medium |
| 3 | **Path-prefix dual-form test** — `/charts/<x>` ≡ `/<x>`. | #1 (1/9) | Trivial |
| 4 | **Property test for "field semantics" claims** — codify each promised invariant from the proxy's docstrings (e.g. "id is plain address, not chain-prefixed") as a generic walker. Generalizes #9. | #9 + future | Medium |

**Iteration plan**: Tool #3 first (trivial, cheap win, demonstrates the test runner is in place). Then #1 (highest catch count). Then #2.

## Test runner — resolved

Settled on `node --test` (zero deps). Run with:

```sh
npm run auto-qa:test
```

Glob: `auto-qa/tests/**/*.test.mjs`. First green test:
`auto-qa/tests/path-prefix.test.mjs` (covers PR #1).

## Data-quality findings (iteration 5 — multi-proposal smoke)

Spot-checked 3 fixtures via `/api/v2/proposals/:id/chart`. The endpoint
*shape* is fine for all 3 (contract test passes). But two return empty/zero data:

| Proposal | Address | Yes Price | No Price | Base Token | Status |
|---|---|---|---|---|---|
| GIP-150 v2 | `0x1a0f209f…` | 111.21 | 107.37 | GNO | ✅ healthy |
| TSLA Mega Package | `0xf1b12f03…` | 0 | 0 | "TOKEN" (fallback) | ⚠️ no data |
| CIP-82 (CoW DAO Grants) | `0xb0e6bc18…` | 0 | 0 | "TOKEN" (fallback) | ⚠️ no data |

Per /loop directive: NOT fixed. Likely root cause: these proposals don't
have CONDITIONAL pools indexed yet (or the indexer missed them), and
the EXPECTED_VALUE / PREDICTION fallback isn't kicking in for these
specific fixtures. Worth investigating in a real fix-pass:

  1. Are CONDITIONAL pools deployed on-chain for these proposals?
  2. Did the candles indexer skip the pool-creation events?
  3. If only EXPECTED_VALUE / PREDICTION pools exist, is the fallback
     in unified-chart.js actually picking them up?

The "TOKEN" string is the post-PR-#6 default (formerly "PNK"), so
PR #6 IS working — symbol resolution is just falling all the way
through to the default for these proposals.

## Cross-repo notes

- `interface/auto-qa/PROGRESS.md` covers the frontend; both ledgers should reference each other when a bug spans both (e.g. #65 on interface + #9 here are the same root cause class).
