# Auto-QA Progress — futarchy-fi/futarchy-api

Working ledger for the `/loop` auto-QA initiative on the API repo.
Same methodology as `interface/auto-qa/PROGRESS.md`. Production code
is never modified — only tests on the `auto-qa` branch.

## Status snapshot

| Field | Value |
|---|---|
| Branch | `auto-qa` (off `origin/main`) |
| Iterations completed | 1 |
| PRs catalogued | 9 / 9 (full history) |
| PRs classified | 9 |
| Tests added | 0 |
| Tooling backlog | see below |

## PR ledger

### PR #9 — fix(api): preserve periodStartUnix as distinct snapped field
- **Class**: bug-fix
- **Hypothesis**: `proxyCandlesQuery` in `src/adapters/candles-adapter.js` rewrote every `periodStartUnix` substring in inbound queries to `time` (and synthesized `periodStartUnix = String(time)` on the way back), assuming Checkpoint only had a single timestamp field. Checkpoint actually exposes both `time` (raw last-swap ts) AND `periodStartUnix` (period-snapped boundary). Collapsing them returned raw swap times to clients asking for `periodStartUnix`, breaking the frontend chart's carry-forward fill — flat line at the earliest candle's price.
- **Ideal test**: Contract test for the proxy — for each declared response-field semantic ("`periodStartUnix` MUST be a multiple of `period`"), assert that property holds for every candle returned. Generalizes to "any proxy translation must preserve documented field semantics".
- **Tools needed**: HTTP test client + a fixture proposal with known candles + a property-checker that walks every candle in the response.
- **Test status**: not-started

### PR #8 — fix(api): translate pool_in/proposal_in array filters in passthrough
- **Class**: bug-fix
- **Hypothesis**: The `/candles/graphql` proxy chain-prefixed scalar `pool: "0xabc"` filters but missed list-form `pool_in: ["0xabc", "0xdef"]` and `proposal_in: [...]`. Frontend bulk queries returned 0 results.
- **Ideal test**: For every supported filter operator (`{eq, in, gte, lte, …}` × `{pool, proposal, id, …}`), send a query with a known-good address and assert non-empty result. Catches "we forgot to handle the array form" and any future filter the proxy forgets.
- **Tools needed**: Same HTTP test client + fixture-driven matrix runner.
- **Test status**: not-started

### PR #7 — fix(api): translate proposal: filter syntax in candles passthrough
- **Class**: bug-fix
- **Hypothesis**: Proxy translated `pool: "0xabc"` but not `proposal: "0xabc"`. Same family as #8 (incomplete filter coverage). Symptom: queries filtering by proposal address returned empty when going through `/candles/graphql`.
- **Ideal test**: subsumed by #8's matrix.
- **Tools needed**: same as #8.
- **Test status**: not-started

### PR #6 — fix(api): resolve token symbols from any pool type, drop PNK fallback
- **Class**: bug-fix
- **Hypothesis**: `unified-chart.js` / `market-events.js` only inspected `CONDITIONAL` pools to derive company/currency token symbols. New markets where CONDITIONAL pools weren't yet indexed (or didn't exist) fell through to the `'PNK'` hardcode → wrong ticker on charts. Fix: walk pools in priority `CONDITIONAL > EXPECTED_VALUE > PREDICTION` and parse the pool name regex.
- **Ideal test**: Snapshot test against `GET /api/v2/proposals/:id/chart` for proposals representing each (CONDITIONAL+, EXPECTED_VALUE+, PREDICTION-only) state — assert `company_tokens.base.tokenSymbol` is plausible and is NEVER literally `"PNK"` unless the proposal really is for PNK.
- **Tools needed**: HTTP client + fixtures for each market lifecycle stage. Hard part is finding/keeping a "PREDICTION-only" fixture stable.
- **Test status**: not-started

### PR #5 — fix(api): fall back to PREDICTION/EXPECTED_VALUE pools for new markets
- **Class**: bug-fix
- **Hypothesis**: Same family as #6 — endpoints assumed CONDITIONAL pools always existed. For new proposals where only PREDICTION/EXPECTED_VALUE pools are indexed yet, endpoints returned null prices.
- **Ideal test**: subsumed by #6's snapshot suite — assert prices are non-null for every market lifecycle stage.
- **Tools needed**: same as #6.
- **Test status**: not-started

### PR #4 — fix(api): translate plain pool IDs in /candles/graphql passthrough
- **Class**: bug-fix
- **Hypothesis**: Proxy missed the inline scalar `pool: "0xabc"` form (only handled some other variant). Same family as #7, #8.
- **Ideal test**: subsumed by #8's matrix.
- **Tools needed**: same.
- **Test status**: not-started

### PR #3 — feat(api): /registry/graphql and /candles/graphql passthroughs
- **Class**: feature
- **Hypothesis**: n/a
- **Ideal test**: Smoke test — passthroughs return HTTP 200 and a well-formed GraphQL envelope (`data` or `errors` key) for a trivial introspection query. Catches infra regressions (route mounted? upstream reachable? HTTPS termination working?).
- **Tools needed**: HTTP client.
- **Test status**: not-started

### PR #2 — infra(rpc-proxy): multi-RPC pool with tip buffer, failover, hash pinning
- **Class**: infra (also has bug-prevention character — pre-empts reorg loops)
- **Hypothesis**: n/a (not strictly fixing an in-flight bug, but hardening against a known failure mode)
- **Ideal test**: Inject a flaky upstream RPC and assert the pool failover completes within a deadline. Hash-pinning correctness check: ensure the proxy serves consistent block hashes across N consecutive requests for the same height.
- **Tools needed**: mock upstream RPC + ability to introspect proxy state.
- **Test status**: not-started

### PR #1 — Restore /charts path prefix for Snapshot widget
- **Class**: bug-fix
- **Hypothesis**: After Cloud Run migration the legacy AWS API Gateway `/charts/...` path prefix was lost. The Snapshot widget at `snapshot-labs/sx-monorepo` still hits `https://api.futarchy.fi/charts/api/v2/...`. Without the prefix-strip middleware the route 404'd. Fix: add Express middleware that strips `/charts` from incoming URLs.
- **Ideal test**: Send `GET /charts/api/v2/proposals/:id/chart` and `GET /api/v2/proposals/:id/chart` to the same fixture proposal — assert they return identical JSON. Catches future accidental removal of the prefix-strip middleware.
- **Tools needed**: HTTP client + fixture proposal.
- **Test status**: not-started

## Class summary

| Class | Count | PRs |
|---|---|---|
| bug-fix | 7 | #1, #4, #5, #6, #7, #8, #9 |
| feature | 1 | #3 |
| infra | 1 | #2 |

## Tooling backlog

Ranked by leverage across the catalogue.

| Rank | Tool | Catches | Effort |
|---|---|---|---|
| 1 | **GraphQL passthrough contract test** — matrix-driven HTTP client that hits `/candles/graphql` with every supported filter shape against a fixture proposal, validates response semantics (chain prefix stripping, `periodStartUnix` snapping, non-empty filter matches). | #4, #7, #8, #9 (4/9) | Low-Medium |
| 2 | **Unified-chart endpoint snapshot test** — `GET /api/v2/proposals/:id/chart` against fixtures spanning each market lifecycle stage; assert non-null prices, plausible token symbols, no `"PNK"` leak. | #5, #6 (2/9) | Medium |
| 3 | **Path-prefix dual-form test** — `/charts/<x>` ≡ `/<x>`. | #1 (1/9) | Trivial |
| 4 | **Property test for "field semantics" claims** — codify each promised invariant from the proxy's docstrings (e.g. "id is plain address, not chain-prefixed") as a generic walker. Generalizes #9. | #9 + future | Medium |

**Iteration plan**: Tool #3 first (trivial, cheap win, demonstrates the test runner is in place). Then #1 (highest catch count). Then #2.

## Test runner — open question

This repo has no test framework configured today. Options:

- `node --test` (built-in, zero deps, sufficient for HTTP assertions)
- `vitest` (richer assertions but adds a dep)

Default to `node --test` to keep the auto-qa surface area minimal. Future iteration: scaffold the runner script + first trivial test (#3).

## Cross-repo notes

- `interface/auto-qa/PROGRESS.md` covers the frontend; both ledgers should reference each other when a bug spans both (e.g. #65 on interface + #9 here are the same root cause class).
