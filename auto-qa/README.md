# auto-qa

Branch-local testing harness for `futarchy-fi/futarchy-api`. Lives entirely
on the `auto-qa` branch — **never merge into `main`**. Adds coverage
*without touching production code*; if a test fails because production is
broken, leave it failing and document.

## Run

```sh
npm run auto-qa:test                              # all tests
node --test auto-qa/tests/<x>.test.mjs            # one file
AUTO_QA_API_BASE=http://localhost:3031 npm run auto-qa:test   # against local
```

All tests skip cleanly when `api.futarchy.fi` is unreachable.

## Layout

```
auto-qa/
├── README.md                ← you are here
├── PROGRESS.md              ← per-PR ledger (hypothesis + ideal test + status)
└── tests/
    ├── path-prefix.test.mjs           ← /charts/<x> ≡ /<x> (PR #1)
    ├── passthrough-contract.test.mjs  ← scalar/list filters + periodStartUnix snapping (PRs #4/#7/#8/#9)
    ├── unified-chart.test.mjs         ← /api/v2/.../chart shape + token symbols (PRs #5/#6)
    ├── multi-proposal-smoke.test.mjs  ← chart endpoint over diverse fixtures
    ├── spot-candles.test.mjs          ← /api/v1/spot-candles contract
    ├── indexer-freshness.test.mjs     ← indexer head not too far behind chain tip
    └── registry-org-shape.test.mjs    ← Organization entity shape (cross-repo guard for `interface` PR #61)
```

## API surfaces covered

| Surface | Tests |
|---|---|
| `GET /api/v2/proposals/:id/chart` | unified-chart + multi-proposal-smoke |
| `POST /candles/graphql` | passthrough-contract + path-prefix |
| `POST /registry/graphql` | registry-org-shape + indexer-freshness |
| `GET /api/v1/spot-candles` | spot-candles |
| `GET /charts/<...>` (legacy prefix) | path-prefix |

## Ops invariants tracked

| Invariant | Where | Threshold |
|---|---|---|
| Candles indexer (Gnosis) lag | `indexer-freshness.test.mjs` | < 5000 blocks (~7h) |
| Registry indexer lag | `indexer-freshness.test.mjs` | < 15000 blocks (~21h) |
| Org table not empty | `registry-org-shape.test.mjs` | ≥ 1 org |
| `periodStartUnix` snapped to period boundary | `passthrough-contract.test.mjs` | `ts % 3600 === 0` |
| Volume reported in human units | `unified-chart.test.mjs` | < 1e15 |

## Fixtures

Canonical test proposal: **GIP-150 v2** at
`0x1a0f209fa9730a4668ce43ce18982cb0010a972a` — has CONDITIONAL +
EXPECTED_VALUE + PREDICTION pools all indexed, exercises the full
fallback chain.

Pinned 7-day historical window: `1777737600..1778342400` (2026-05-03 to
2026-05-09 UTC). Past data → reproducible across reruns.

## Adding a test

1. Pick a PR from `PROGRESS.md` with `Test status: not-started`.
2. Write `auto-qa/tests/<short-name>.test.mjs` using `node:test`.
3. Use the canonical fixture above unless you have reason to add another.
4. Provide a `t.skip` path for offline runs (`isApiReachable()` helper
   pattern in existing tests).
5. Run `npm run auto-qa:test` and update `PROGRESS.md`.

## Cross-repo

Sister harness at `futarchy-fi/interface` on its own `auto-qa` branch.
Some tests are mirror-cases of each other — e.g. the `periodStartUnix`
snapping test on this side complements the chart-render test on the
interface side.
