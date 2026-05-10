# Forked Replay Harness — Progress

End-to-end test harness that forks Gnosis at a past block, replays a futarchy
proposal lifecycle with synthetic users, and asserts cross-layer agreement
(chain ↔ indexer ↔ api ↔ frontend) at every block.

The harness spans both `futarchy-fi/futarchy-api` and `futarchy-fi/interface`.
This file is mirrored across both repos. Server-side infra (anvil, indexer,
api) is hosted here; UI infra (Playwright fixtures, page-object models) lives
in `interface/auto-qa/harness/`.

## Status

| Field | Value |
|---|---|
| Phase | 3 — slice 1 landed (ADR-002 decision made: build-from-source via futarchy-indexers sibling clone). Background spike running on START_BLOCK / anvil RPC compat. |
| Branch | `auto-qa` (both repos) |
| Location | `auto-qa/harness/` in both `interface` and `futarchy-api` |
| Runner | `npm run auto-qa:e2e` (separate from `npm run auto-qa:test`) |
| Owner | TBD |
| First-pass deadline | TBD |

## Effort breakdown (rough, per component)

| Component | Effort | Notes |
|---|---|---|
| Anvil fork + block clock + tx replay | S (1 wk) | Foundry already does this |
| Synthetic wallet stub for Playwright | M (2 wk) | Synpress mostly works; futarchy custom auth flows are the gotcha |
| Local Checkpoint indexer in CI | L (3 wk) | Schema migrations + warm-up time make this brittle |
| Cross-layer invariant DSL + assertion library | M (2 wk) | Has to be readable enough to debug failures |
| Scenario library (5-10 historical replays) | L (3 wk) | Each historical proposal needs careful state capture |
| OCR / DOM-equivalent price extraction | M (2 wk) | Brittle without good test IDs in the UI |
| Chaos injection + RPC fault library | S (1 wk) | tc/iptables wrapper |
| CI infra (compose, artifact capture, video on fail) | M (2 wk) | Probably the biggest day-2 cost |
| **Total** | **~3-4 months for one engineer** | |

## Phasing

Each phase is independently useful — we can stop at any phase boundary and
still have value.

| # | Phase | Effort | Stop-here value |
|---|---|---|---|
| 0 | Scaffold | 1-2 hrs | `harness/` dirs, deps, README, npm script skeleton, PROGRESS entries |
| 1 | Anvil fork + block clock | ~1 wk | Deterministic time control over a forked Gnosis chain |
| 2 | Chain ↔ api agreement (1 invariant) | ~1 wk | First cross-layer check working end-to-end |
| 3 | Local Checkpoint indexer in-loop | ~3 wks | Indexer reconciles with chain after each block |
| 4 | Synthetic wallet + first scripted swap | ~2 wks | Real on-chain mutation, full chain↔indexer↔api check |
| 5 | Playwright + DOM↔API assertions | ~3 wks | Frontend in the loop; UI consistency catches |
| 6 | Scenario library (replay 1 historical proposal) | ~2 wks | First "real bug shape" replayable |
| 7 | Chaos injection + nightly CI | ~2 wks | Production-shape resilience signal |

## Architecture

```
                ┌───────────────────────────────────────────────┐
                │  Orchestrator (Node test runner)              │
                │  - block clock, scenario script, assertions   │
                └─────┬──────────────┬───────────────┬──────────┘
                      │              │               │
              ┌───────▼──────┐  ┌────▼──────┐   ┌────▼──────┐
              │ Anvil fork   │  │ Local     │   │ Playwright│
              │ Gnosis @ N   │◄─┤ Checkpoint│   │ + N tabs  │
              │ JSON-RPC     │  │ indexer   │   │ (wallets) │
              └───┬──────────┘  └────┬──────┘   └────┬──────┘
                  │                  │               │
                  │             ┌────▼─────┐    ┌────▼──────┐
                  └────────────►│ futarchy │◄───┤ Next.js   │
                                │   -api   │    │ (frontend)│
                                └──────────┘    └───────────┘
```

Single docker-compose starts all four services. Orchestrator owns the clock.

## Cross-layer invariants

| Layer A | vs | Layer B | Invariant |
|---|---|---|---|
| chain | vs | indexer | every Swap event present, same token amounts, same sqrtPrice |
| indexer | vs | api `/candles/graphql` | candle aggregates match raw swaps |
| api `/spot-candles` | vs | api `/candles/graphql` | rate-applied prices reconcile |
| api `/v2/.../chart` | vs | indexer raw | unified-chart shape consistent |
| frontend DOM | vs | api response | every visible price/volume/TVL matches the API call that produced it |
| playwright wallet swap | vs | chain receipt | tx mined, balance delta correct, conditional tokens minted |

## Economic invariants (always-on)

- **Conservation**: ∑(YES + NO conditional tokens) = ∑(sDAI deposited) at every block
- **Monotonicity**: TWAP window endpoints respect contract's `min(now, twapEnd)` clamp
- **Probability**: price ∈ [0, 1] for PREDICTION pools
- **No phantom mints**: `balanceOfBatch` sums match historical + synthetic deposits
- **Rate sanity**: sDAI rate from on-chain `getRate()` ≥ 1 and monotonically increasing

## Bug shapes this catches that nothing else can

- Indexer/chain divergence after a reorg or schema change
- Frontend showing stale numbers when the API is healthy (PR #64 shape from interface)
- Conservation breaks from new merge/split paths
- TWAP window off-by-one at the resolution boundary (PR #54 shape)
- BUY/SELL inversion regressions in `subgraphTradesClient.js`
- Multi-RPC fallback being silently broken
- Wallet-flow regressions in `useFutarchy`
- Cross-protocol price drift between Algebra / CoW / Sushi quoters

## Open decisions (deferred to per-phase work)

- **Foundry vs Hardhat** for the fork — leaning Foundry/anvil (faster, simpler RPC)
- **Local Checkpoint vs subgraph** — Checkpoint matches production but harder to bootstrap
- **Synpress vs custom wallet stub** for Playwright — Synpress is canonical but futarchy's custom flows may need extension
- **Scenario capture format** — JSON snapshot of (block range, tx list, expected end-state) vs full state-dump replay
- **CI execution model** — nightly cron vs manually-triggered workflow vs PR-gated

## Iteration log

### Phase 0 — Scaffold

- **slice 1** — README, harness package.json with stub scripts,
  .gitignore, root `npm run auto-qa:e2e` wired through
  `npm --prefix auto-qa/harness run phase-status`. Verified the stub
  prints the phase status from the repo root. No deps installed yet.

- **slice 2** — `docker-compose.yml` skeleton committed. All real
  services (anvil, indexer, api, interface-dev, orchestrator) are
  block-commented with the eventual launch command + healthcheck +
  volume layout pinned. A `placeholder` (hello-world) service keeps
  `docker compose config` valid for CI dry-runs. Networking pinned to
  a single `harness-net` bridge; volumes go to `.compose-volumes/`
  (gitignored).

- **slice 3** — `scripts/start-fork.mjs` placeholder. Argument parsing
  + help text + structured exit codes documented (0 ready, 1 args, 2
  binary, 3 unreachable, 4 readiness timeout). `--help` works today;
  actual `anvil` subprocess launch is queued for Phase 1.

- **slice 4** — `ARCHITECTURE.md` cross-repo handshake doc. Identical
  copy lives in `interface/auto-qa/harness/ARCHITECTURE.md`. Documents
  the 5-service topology, repo split table, boot sequence, invariant
  catalogue, sibling-clone instructions, and 5 deferred open questions.

- **slice 5** — `docs/ADR-001-foundry-vs-hardhat.md` written by
  background agent. **Decision: Foundry/anvil.** Per-tx replay
  throughput dominates our workload, anvil's `evm_setNextBlockTimestamp`
  + manual `evm_mine` covers our TWAP-window needs without Hardhat's
  `hardhat_mine` advantage, and the single Rust binary cuts CI footprint
  vs a Node + node_modules Hardhat project. Long-run memory creep
  mitigated via snapshot/revert at scenario boundaries.

- **slice 6** — `npm install` ran cleanly in `auto-qa/harness/`,
  generating `package-lock.json` (300 bytes — empty deps tree, but
  reproducible for future additions). Verified no pollution of root
  `package.json` install.

- **slice 7** — `docker compose -f auto-qa/harness/docker-compose.yml
  config` validates cleanly. Removed the obsolete `version: "3.9"`
  field per Compose v2 deprecation. Output shows the placeholder
  service + harness-net bridge as expected.

- **slice 8** — `CHECKLIST.md` mirrored across both repos. Enumerates
  Phase 0 → Phase 7 readiness gates plus 3 cross-cutting acceptance
  gates (no production code mods, no real mainnet RPC during runs,
  harness deps isolated from root). All Phase 0 mechanical items
  checked; 2 human-gated items remain (ADR human review + full
  sister-link clone verification on a clean machine).

**Phase 0 status: code-complete.** Two human-gated items in
`CHECKLIST.md` remain before declaring Phase 0 done and starting
Phase 1:

  1. Both ADRs reviewed by a human + status changed from "Proposed"
     to "Accepted"
  2. Sister-link verified: a fresh `git clone` of both repos in
     `~/code/futarchy-fi/` runs `docker compose config` cleanly
     (the snippet in `ARCHITECTURE.md` is correct as written, but
     hasn't been exercised on a clean machine yet)

### Phase 1 — Anvil fork + block clock

- **slice 1** — `scripts/detect-anvil.mjs`: discovers anvil/cast/forge
  on PATH, parses `--version`, enforces a `MIN_VERSION = 1.0.0`,
  exposes `detectAnvil()` + `requireAnvil()` (the latter throws with a
  clear `foundryup` install hint). CLI mode prints a 3-line summary or
  `--json` for machine consumption. Confirmed working with locally
  installed Foundry 1.5.0-stable.

- **slice 1** — `scripts/start-fork.mjs` rewritten from scaffold to
  real launcher. Spawns anvil with resolved options, streams output to
  stderr (prefixed `[anvil]`), polls JSON-RPC `eth_blockNumber` every
  250ms until success or 30s timeout, then emits `READY <port>` on
  stdout for orchestrator consumption. SIGINT/SIGTERM forwarded; exit
  code mirrors anvil's. Documented exit-code taxonomy (0/1/2/3/4).

- **slice 1** — `scripts/block-clock.mjs` (new): thin JSON-RPC wrapper
  exposing `mineBlock(rpcUrl, count=1)`, `setNextTimestamp(rpcUrl, ts)`,
  `increaseTime(rpcUrl, delta)`, `snapshot(rpcUrl)`, `revert(rpcUrl, id)`,
  `setBalance(rpcUrl, addr, weiHex)`, `impersonateAccount`,
  `stopImpersonating`, plus `blockNumber`, `chainId`, `getBalance`
  query helpers. Custom `RpcError` class wraps non-2xx + JSON-RPC
  `error` envelopes. CLI mode runs a snapshot/mine/revert smoke
  against an external anvil. AbortController-backed 10s timeout per
  call.

- **slice 1** — `tests/smoke-fork.test.mjs` (new): node:test that
  spawns start-fork as a child process, awaits `READY`, runs
  block-clock through chainId/blockNumber/mine-10/snapshot/mine-5/revert
  round-trip, asserts heights, and SIGTERMs cleanly. **Validated
  end-to-end against `https://rpc.gnosis.gateway.fm` 2026-05-10:
  forked at block 46104021, all assertions pass, total runtime 2.8s.**
  Skips cleanly when anvil isn't on PATH.

- **slice 1** — `auto-qa/harness/package.json` scripts wired:
  `phase-status`, `detect`, `fork`, `smoke`, `test` (node:test on
  `tests/**`). Root `package.json` adds `auto-qa:e2e:detect`,
  `auto-qa:e2e:fork`, `auto-qa:e2e:smoke` shortcuts.

- **slice 2** — `docker-compose.yml` anvil block UNCOMMENTED + simplified.
  Uses published `ghcr.io/foundry-rs/foundry:latest`, command list
  (no shell), exposes `${ANVIL_HOST_PORT:-8545}:8545`, healthcheck via
  `cast block-number` with 5s start_period + 30 retries.
  Phase 0 placeholder service removed. New `tests/smoke-compose.test.mjs`
  drives `up -d` → await healthy → block-clock round-trip → `down -v`,
  with graceful SKIP when docker daemon unreachable. Wired as
  `npm run auto-qa:e2e:smoke:compose`. Live runtime validation needs
  Docker Desktop running; daemon was down during this iteration so
  the test currently skips.

- **slice 3** — `setNextTimestamp` runtime test added to
  `smoke-fork.test.mjs`. Pins next-block timestamp to (now+1h),
  mines, reads back via `eth_getBlockByNumber`, asserts exact
  match. Then mines a follow-up block and confirms timestamp >=
  pinned (anvil increments by 1s). **Validated** — pinned to
  `now+3600`, asserted exact, follow-up `+1s`.

- **slice 4** — `setBalance` runtime test: pin a target address to
  100 ETH (`0x56bc75e2d63100000`), confirm `eth_getBalance` returns
  that exact value. **Validated** against `0xff00ff00ff…` (had no
  prior balance on Gnosis fork — but assertion is on the post-set
  state regardless, since some Gnosis vanity addresses carry dust).

- **slice 4** — `impersonateAccount` runtime test: fund a fictional
  whale, impersonate, send 1 ETH from whale to recipient via
  `eth_sendTransaction` (only possible while impersonating), mine,
  confirm recipient balance. Stops impersonation in `finally`.
  **Validated** — sent 1 ETH between two synthetic addresses.

**Phase 1 status: COMPLETE.** All 6 CHECKLIST items ticked. 4 smoke
tests passing in ~11s total against a real Gnosis fork.

**Smoke summary (last full run, 2026-05-10):**

```
Phase 1 smoke — start-fork + block-clock        ✓ ~3s
Phase 1 slice 3 — setNextTimestamp              ✓ ~2.5s
Phase 1 slice 4 — setBalance                    ✓ ~2.5s
Phase 1 slice 4 — impersonateAccount            ✓ ~3s
Phase 1 slice 2 — compose smoke                  ⊘ skipped (daemon down)
```

### Phase 2 — Chain ↔ api agreement

**Reframe (slice 1, this iteration):** the api consumes a Checkpoint
indexer GraphQL endpoint (not RPC directly — `src/index.js` imports
no RPC client at the top level; `rate-provider.js` uses hardcoded
chain RPCs internally). So the literal CHECKLIST item
`chainBlockNumber === api.healthBlock` doesn't map to anything that
exists today: `/health` returns `{status, timestamp}` only. The real
literal block invariant defers to Phase 3 once a local Checkpoint
indexer joins the loop. Phase 2's foundational deliverable is
**dual-source liveness** — orchestrator drives both layers and
probes each via its native protocol.

- **slice 1** — `auto-qa/harness/orchestrator/services.mjs` (new):
  process-level helpers exposing `startAnvilFork({port, forkUrl,
  chainId})`, `startLocalApi({port, env})`, `stopAll(handles)`. Both
  start helpers spawn a child process, await readiness via the
  appropriate probe (anvil: parse "READY <port>" on stdout; api:
  poll `/health` for HTTP 200), and return a `{url, child, stop()}`
  handle. `stop()` SIGTERMs and waits for clean exit. `pollHttp`
  helper handles the polling loop. NOTE pinned: src/index.js
  hardcodes PORT=3031 (does NOT read PORT env), so the helper port
  param is a probe target, not an override.

- **slice 1** — `tests/smoke-api-health.test.mjs` (new): first
  cross-layer smoke. Brings up anvil + api in PARALLEL via
  `Promise.all`, then queries each via different codepaths:
  - anvil: `eth_chainId` (== 100), `eth_blockNumber` (>0)
  - api: `GET /health` (status==ok, timestamp ISO), `GET /warmer`
    (returns object)
  Logs a [Phase 3 placeholder] diagnostic noting where the literal
  block-comparison invariant will plug in. **Validated 2026-05-10:
  both services up after 3.4s, all assertions pass.**

- **slice 1** — npm scripts: `smoke:api` in harness package.json,
  `auto-qa:e2e:smoke:api` in root package.json.

- **slice 1** — CHECKLIST.md Phase 2 reframed and 2/3 items ticked
  (the 3rd, literal block invariant, defers to Phase 3 with an
  explicit note).

- **slice 2** (this iteration) — `orchestrator/stub-indexer.mjs` (new):
  pluggable in-process http server that stands in for the Checkpoint
  registry/candles indexer. Records call history; supports hot-swap
  responder. The api is configured to point at it via the
  `REGISTRY_URL` / `CANDLES_URL` env vars (discovered while reading
  `src/config/endpoints.js` — both vars exist and are read on api
  startup). New `tests/smoke-api-passthrough.test.mjs` runs 3 cases:
  - **200 verbatim**: send query through api → stub returns canned
    `{data: {proposals: [...]}}` → api forwards body+status both
    verbatim. Verified stub received the EXACT body we sent.
  - **500 propagation**: stub returns 500 → api passes through 500
    with the original error envelope.
  - **502 envelope on unreachable**: api configured with REGISTRY_URL
    pointing at a port where nothing listens → api returns 502 with
    `{errors:[{message:"[registry] upstream error: ..."}]}` per
    `makeGraphQLPassthrough` contract.
  All 3 pass in <1s total. **Real cross-layer integration validated.**

- **slice 4** (this iteration) — `tests/smoke-multi-spawn.test.mjs`:
  N successive anvil+api spawn/probe/stop cycles (default N=3,
  override via `HARNESS_STRESS_CYCLES`). After each `stop()`, probes
  the ports and asserts they are REFUSED (proof of release). Across
  cycles, asserts heights are within 100 blocks of each other (sanity
  check that we're hitting the same fork source). **Validated
  2026-05-10 — 3 cycles in 8.2s, port release clean each time,
  cycle heights 46104207-46104209 (range 2).**

- npm scripts: `smoke:passthrough`, `smoke:stress` in harness;
  `auto-qa:e2e:smoke:passthrough`, `auto-qa:e2e:smoke:stress` at root.

**Smoke summary (post-Phase 2 slices 1+2+4):**

```
Phase 1 smoke — start-fork + block-clock        ✓ ~3s
Phase 1 slice 3 — setNextTimestamp              ✓ ~2.5s
Phase 1 slice 4 — setBalance                    ✓ ~2.5s
Phase 1 slice 4 — impersonateAccount            ✓ ~3s
Phase 1 slice 2 — compose smoke                  ⊘ skipped (daemon down)
Phase 2 — orchestrator dual-source               ✓ ~3.5s
Phase 2 slice 2 — passthrough verbatim           ✓ ~280ms
Phase 2 slice 2 — passthrough 500                ✓ ~280ms
Phase 2 slice 2 — passthrough 502 unreachable    ✓ ~270ms
Phase 2 slice 4 — multi-spawn stress (3 cycles) ✓ ~8.2s
                                       TOTAL: 9 pass + 1 skip
```

**Phase 2 wrap-up — remaining:**

- slice 3 (deferred to Phase 4 entry) — `orchestrator/contracts.mjs`
  ethers v6 helpers (`readContract`, `sendContractTx`). Better built
  alongside the synthetic-swap work in Phase 4.

### Phase 3 — Local Checkpoint indexer

- **slice 1** (this iteration) — `docs/ADR-002-indexer-bootstrap.md`:
  decision made.

  **Context discovery this iteration**:
  - Memory + repo inspection revealed the indexer code already lives
    in `/Users/kas/futarchy-indexers/` (production VM + local clone).
  - `futarchy-complete/checkpoint/docker-compose.yml` is the registry
    indexer (port 3003 → host, 3000 internal, postgres on 5435).
    Builds from local Dockerfile; mounts `resolvers-patched.js` +
    `controller-patched.js` over `node_modules/@snapshot-labs/checkpoint/dist/`.
  - `proposals-candles/checkpoint/docker-compose.yml` is the candles
    indexer (port 3001 → host, 3000 internal, postgres on 5434).
    Reads `GNOSIS_RPC_URL` + `MAINNET_RPC_URL` envs.
  - **Decision: build-from-source via sibling clone.** Reuses
    production's exact compose + patches, no divergence. Stub-indexer
    from Phase 2 retained for fast unit-style tests.

  **Open spike dispatched** (background agent):
  - `START_BLOCK` env support on `@snapshot-labs/checkpoint` — needed
    for slice 4 (skip from genesis to anvil fork-block, since anvil
    doesn't have history before its fork point)
  - `GNOSIS_BLOCK_RANGE` semantics
  - Anvil RPC compatibility (any `trace_*` / `debug_*` calls that
    anvil doesn't support)
  - Cold-start time on M-class CI

  Results land in `docs/spike-001-checkpoint-anvil-compat.md` when
  the agent completes. Slice 2+ planning depends on the spike's
  recommendations.

- **slice 1** — Honest port note: `endpoints.js` defaults to
  `localhost:3003/graphql` for registry and `localhost:3004/graphql`
  for candles. The actual indexer compose binds registry to 3003 ✓
  but candles to **3001** (NOT 3004 as endpoints.js defaults). This
  is a pre-existing mismatch in production code; the harness sets
  `CANDLES_URL=http://localhost:3001/graphql` explicitly to bridge.

**Phase 3 wrap-up — remaining (gated on spike):**

- slice 2 — Compose extension: add `registry-indexer` + `candles-indexer`
  services that `extends:` from the futarchy-indexers compose, with
  RPC pointed at our anvil. Wire `INDEXERS_PATH` env for the sibling
  clone location.
- slice 3 — `orchestrator/services.mjs` `startLocalIndexers({reset})`
  helper with readiness probe (poll `{__typename}` until 200).
- slice 4 — START_BLOCK bootstrap (per spike outcome). Likely either
  env-var override on the indexer, OR a one-shot init container that
  pre-seeds postgres `last_indexed_block`.
- slice 5 — `tests/smoke-indexer-roundtrip.test.mjs`: anvil event →
  wait for indexer → query → assert. **THE Phase 3 invariant.**

**Phase 3 risks tracked:**

- Cold-start time may exceed CI tolerance (>2 min). Mitigation:
  pre-warmed postgres image with seeded schema.
- Anvil ↔ indexer RPC compat unknown until spike completes.
- Container shutdown ordering matters (indexer may loop trying to
  reach a dead anvil). `stopAll()` will need `stopOrdered()`.
