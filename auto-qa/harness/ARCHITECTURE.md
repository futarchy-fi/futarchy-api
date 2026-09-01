# Forked Replay Harness — Architecture

This is the **shared architecture spec** for the Forked Replay Harness.
The same file is mirrored in both repos:

- `futarchy-fi/futarchy-api` hosts the **server side**: anvil fork,
  indexer, futarchy-api, orchestrator, scenarios, chaos injection.
- `futarchy-fi/interface` hosts the **UI side**: Playwright config,
  wallet stub, page-object models, flows, DOM↔API consistency
  assertions.

The two halves communicate over docker-compose's internal network and
share state via the orchestrator. Neither side modifies production code.

For phasing, status, and effort breakdown see [`PROGRESS.md`](./PROGRESS.md).
For repo-local how-to see [`README.md`](./README.md).

## Service topology

```
        ┌──────────────────────────────────────────────────────────┐
        │  Orchestrator (futarchy-api/auto-qa/harness/orchestrator)│
        │  - owns the block clock                                  │
        │  - drives scenario script                                │
        │  - emits cross-layer assertion failures                  │
        └─┬───────────────┬───────────────┬─────────────────┬──────┘
          │ JSON-RPC      │ JSON-RPC      │ HTTP            │ HTTP/CDP
          ▼               ▼               ▼                 ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐    ┌────────────────┐
    │  anvil   │   │  Local   │   │ futarchy │    │   Playwright   │
    │  (fork   │◄──┤Checkpoint│   │  -api    │    │   + headless   │
    │ Gnosis)  │   │ indexer  │◄──┤(Express) │◄───┤  Chromium      │
    │ port     │   │ port     │   │ port 3000│    │  (interface    │
    │ 8545     │   │ 3001     │   │          │    │   /auto-qa     │
    └──────────┘   └──────────┘   └──────────┘    │   /harness)    │
                                                   └───────┬────────┘
                                                           │
                                              ┌────────────▼─────────┐
                                              │  Next.js dev server  │
                                              │  (futarchy-fi/       │
                                              │   interface, mounted │
                                              │   sibling clone)     │
                                              │  port 3010 (host)    │
                                              └──────────────────────┘
```

All five services run inside one docker-compose stack on a private
`harness-net` bridge. The orchestrator exposes no ports; it talks to
everything else via service names.

## Repo split

| Concern | Lives in | Path |
|---|---|---|
| anvil fork launcher | futarchy-api | `auto-qa/harness/scripts/start-fork.mjs` |
| Block clock + tx replay | futarchy-api | `auto-qa/harness/scripts/block-clock.mjs` |
| Local Checkpoint launcher | futarchy-api | `auto-qa/harness/scripts/start-indexer.mjs` |
| Local futarchy-api (this repo's `src/`) | futarchy-api | docker-compose service |
| Cross-layer assertion library | futarchy-api | `auto-qa/harness/orchestrator/invariants.mjs` |
| Scenario fixtures | futarchy-api | `auto-qa/harness/scenarios/` |
| Chaos injection | futarchy-api | `auto-qa/harness/scripts/chaos.mjs` |
| docker-compose | futarchy-api | `auto-qa/harness/docker-compose.yml` |
| Playwright config | interface | `auto-qa/harness/playwright.config.mjs` |
| Wallet stub (EIP-1193) | interface | `auto-qa/harness/fixtures/wallet-stub.mjs` |
| Page-object models | interface | `auto-qa/harness/pages/` |
| End-to-end flows | interface | `auto-qa/harness/flows/` |
| DOM↔API invariants | interface | `auto-qa/harness/invariants/` |

## Boot sequence

1. `docker compose -f futarchy-api/auto-qa/harness/docker-compose.yml up -d`
2. anvil starts, forks Gnosis at the configured block, healthcheck
   passes via `cast block-number`
3. Checkpoint indexer starts, points at `http://anvil:8545`, ingests
   from `START_BLOCK`
4. futarchy-api starts, points at `http://anvil:8545` for RPC and
   `http://indexer:3001/graphql` for indexed data
5. (Optional, only when running UI tests) interface-dev starts,
   points at `http://anvil:8545` and `http://api:3000`
6. Orchestrator runs the chosen scenario script
7. Per-block: orchestrator advances anvil clock, mines, then runs
   the cross-layer invariant battery
8. Per-scenario: snapshot/revert anvil between scenarios so they don't
   share state

## Cross-layer invariant catalogue

| Layer A | vs | Layer B | Invariant |
|---|---|---|---|
| chain (anvil) | vs | indexer | every Swap event present, same token amounts, same sqrtPrice |
| indexer | vs | api `/candles/graphql` | candle aggregates match raw swaps |
| api `/spot-candles` | vs | api `/candles/graphql` | rate-applied prices reconcile |
| api `/v2/.../chart` | vs | indexer raw | unified-chart shape consistent |
| frontend DOM | vs | api response | every visible price/volume/TVL matches the API call that produced it |
| Playwright wallet swap | vs | chain receipt | tx mined, balance delta correct, conditional tokens minted |

## Economic invariants (always-on, evaluated every block)

- **Conservation**: ∑(YES + NO conditional tokens) = ∑(sDAI deposited)
- **Monotonicity**: TWAP window endpoints respect contract's `min(now, twapEnd)` clamp
- **Probability**: price ∈ [0, 1] for PREDICTION pools
- **No phantom mints**: `balanceOfBatch` sums match historical + synthetic deposits
- **Rate sanity**: sDAI rate from on-chain `getRate()` ≥ 1, monotonically increasing

## Cloning + running together

The harness needs both repos checked out as siblings:

```bash
mkdir -p ~/code/futarchy-fi
cd ~/code/futarchy-fi
git clone -b auto-qa https://github.com/futarchy-fi/futarchy-api.git
git clone -b auto-qa https://github.com/futarchy-fi/interface.git

# From futarchy-api (the harness host):
cd futarchy-api
docker compose -f auto-qa/harness/docker-compose.yml up -d

# Wait for healthchecks, then run the orchestrator:
npm run auto-qa:e2e:replay -- --scenario smoke
```

The compose file references `${INTERFACE_PATH}` (default
`../../../../interface`) for the sibling-clone mount. Override that env
var if your layout differs.

## Decision records

ADRs live in `docs/` on each side:

- `futarchy-api/auto-qa/harness/docs/ADR-001-foundry-vs-hardhat.md`
- `interface/auto-qa/harness/docs/ADR-001-synpress-vs-custom-stub.md`

Each ADR is one page, opinionated, and dated. New ADRs increment the
number (ADR-002, etc.) — do not amend old ADRs in place; supersede them.

## Open questions

These are deferred to the relevant phase but logged here so they don't
get lost:

1. **Indexer schema migration story** (Phase 3) — Checkpoint's cold-start
   warm-up time is the biggest CI risk; do we ship a pre-warmed snapshot
   or accept the boot cost?
2. **Multi-user wallet provisioning** (Phase 4) — anvil dev mnemonic
   gives us 10 deterministic addresses; do we need more for arbitrage
   scenarios?
3. **Frontend test-id discipline** (Phase 5) — DOM-equivalent price
   extraction is brittle without `data-testid` attributes in the
   production code. Do we add them as part of the harness work, or
   accept brittle selectors?
4. **Scenario capture format** (Phase 6) — JSON snapshot of `(block range,
   tx list, expected end-state)` vs full state-dump replay. Tradeoff
   between fidelity and snapshot size.
5. **CI execution model** (Phase 7) — nightly cron vs manually-triggered
   workflow vs PR-gated. Decision deferred until we know the runtime
   per scenario.
