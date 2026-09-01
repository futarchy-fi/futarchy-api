# Forked Replay Harness — futarchy-api side

Server-side scaffold for the end-to-end test harness. See
[`PROGRESS.md`](./PROGRESS.md) for the full architecture, phasing, and
invariant catalogue.

## What lives here

This subtree hosts the **server-side** infrastructure of the harness:

- **Anvil fork** — local Gnosis fork pinned at a past block (Phase 1)
- **Block clock + tx replay** — controlled time advancement (Phase 1)
- **Local Checkpoint indexer** — pointed at the fork RPC (Phase 3)
- **Local futarchy-api instance** — pointed at the local indexer (Phase 2)
- **Cross-layer assertions** — chain ↔ indexer ↔ api invariant checks
- **Scenario fixtures** — captured historical proposals for replay (Phase 6)
- **Chaos injection** — RPC fault wrappers (Phase 7)

The **UI side** of the harness (Playwright fixtures, page-object models,
wallet stubs) lives in the sibling
[`interface/auto-qa/harness/`](https://github.com/futarchy-fi/interface/tree/auto-qa/auto-qa/harness)
directory.

## How to run

> **Phase 0 — scaffold only.** The harness is not yet runnable.

Once Phase 1 lands:

```bash
# From the repo root
npm run auto-qa:e2e             # print phase status (current)
npm run auto-qa:e2e:fork        # start anvil fork (Phase 1+)
npm run auto-qa:e2e:replay      # replay a captured scenario (Phase 6+)
npm run auto-qa:e2e:full        # full chain↔api↔ui replay (Phase 5+)
```

## Directory layout (planned)

```
auto-qa/harness/
├── PROGRESS.md           ← phasing, status, invariant catalogue
├── README.md             ← this file
├── package.json          ← harness-local deps (not installed at root)
├── .gitignore            ← anvil state, scenario snapshots, etc.
├── docker-compose.yml    ← (Phase 1+) anvil + indexer + api services
├── scripts/
│   ├── start-fork.mjs    ← (Phase 1) anvil fork launcher
│   ├── block-clock.mjs   ← (Phase 1) controlled time advancement
│   └── start-indexer.mjs ← (Phase 3) local Checkpoint launcher
├── orchestrator/
│   ├── runner.mjs        ← (Phase 2) test driver
│   └── invariants.mjs    ← (Phase 2) cross-layer assertion library
├── scenarios/            ← (Phase 6) captured historical proposals
└── tests/                ← (Phase 2+) cross-layer test files
```

`tests/` is intentionally separate from `auto-qa/tests/` so that
`npm run auto-qa:test` (fast unit/source-text pins) does NOT pick up
the heavyweight harness tests. The harness has its own runner.

## Constraints

- **Production code is never modified** by the harness — same as the
  rest of `auto-qa`.
- **No network calls to mainnet RPCs** during a harness run (anvil fork
  serves all RPC traffic locally).
- **CI execution model** is deferred to Phase 7 — until then, the
  harness is run manually.

## Phase tracking

See `PROGRESS.md` ↦ "Phasing" section. Currently in **Phase 0**.

## Owner

TBD — pick someone before Phase 3 (local Checkpoint indexer in CI) since
that's where most of the brittleness lives.
