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
| Phase | 5 done + Phase 6 fully done + Phase 7 slices 1+2 done + Phase 7 slices 3a + 3c + 3d STAGED on interface side + Phase 7 slices **4a-prep + 4a + 4b-plan + 4b-include + 4b-api-env + 4b-network-wire + 4c-prep + 4c-activate + 4d-prep + 4d-scenarios (scaffold) + 4d-activate + 4d-scenarios-more (apiCanReachCandles + registryDirect + candlesDirect + rateSanity + anvilBlockNumber + anvilChainId)** on api side (`docker compose config --services` returns 8 — full stack STRUCTURALLY COMPLETE; orchestrator now ships with 8 invariants — 3 api-passthrough + 2 direct-probe + 3 chain-layer; 16 smoke tests green). 30/30 browser tests green. Phase 3 25+16 smoke tests pass on api side. |
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

- **slice 1.5** (this iteration) — Spike-independent infrastructure
  that prepares for Phase 3 slices 2-5.

  - `scripts/detect-indexers.mjs` (new): mirror of `detect-anvil.mjs`
    for the indexer sibling clone. Walks candidate paths, validates
    both indexer subdirs (`futarchy-complete/checkpoint/` registry +
    `proposals-candles/checkpoint/` candles) have docker-compose +
    Dockerfile, reports git HEAD + dirty state. Exposes
    `detectIndexers()` returning structured info, and
    `requireIndexers()` throwing with a `git clone` hint. CLI mode
    prints a 4-line summary or `--json`.
    **Validated**: found at `/Users/kas/futarchy-indexers @ ce908a1`.

  - `INDEXERS_PATH` is treated as an OVERRIDE (not a candidate) —
    if set, no fallback search. This semantic was discovered + fixed
    when the smoke test caught the bug.

  - `orchestrator/services.mjs` — added `stopOrdered(handles)` helper
    that stops services in dependency order (interface → api →
    indexer → anvil), wrapping each in try/catch so one failure
    doesn't block subsequent stops. Addresses the Phase 3
    container-shutdown-order risk: indexer must stop BEFORE anvil
    or it loops on dead RPC until retry budget exhausts.

  - `tests/smoke-detect-indexers.test.mjs` (new): 2 cases — happy
    path (clone present, both subdirs valid, git HEAD reads) and
    error path (`requireIndexers` throws `INDEXERS_NOT_FOUND` with
    a `git clone` hint when `INDEXERS_PATH` points at a bad path).
    Both pass in 0.6s.

  - npm scripts: `detect:indexers`, `smoke:detect:indexers` in
    harness; corresponding `auto-qa:e2e:detect:indexers` +
    `auto-qa:e2e:smoke:detect:indexers` shortcuts at root.

**Smoke summary (post-Phase 3 slices 1+1.5):**

```
[Phase 1]
  start-fork + block-clock                        ✓ ~3s
  setNextTimestamp                                ✓ ~2.5s
  setBalance                                      ✓ ~2.5s
  impersonateAccount                              ✓ ~3s
  compose smoke                                    ⊘ skipped (daemon down)
[Phase 2]
  orchestrator dual-source                         ✓ ~3.5s
  passthrough verbatim                             ✓ ~280ms
  passthrough 500                                  ✓ ~280ms
  passthrough 502 unreachable                      ✓ ~270ms
  multi-spawn stress (3 cycles)                   ✓ ~8.2s
[Phase 3]
  detect-indexers (happy path)                     ✓ ~25ms
  detect-indexers (missing override)               ✓ ~1ms
                                       TOTAL: 11 pass + 1 skip
```

**Spike-001 result (`docs/spike-001-checkpoint-anvil-compat.md`):**

- **No `START_BLOCK` env** on `@snapshot-labs/checkpoint`. But
  `getStartBlockNum()` in `container.js:335` reads
  `_metadatas.last_indexed_block` from postgres — pre-seeding that
  row after `RESET=true` is the clean bootstrap path.
- **`GNOSIS_BLOCK_RANGE`** is the per-batch `eth_getLogs` window
  (set via the futarchy patch in `patch-graphnode-style.js:296-305`).
  For the harness, set small (~100) so the indexer doesn't try to
  scan beyond what anvil knows.
- **RPC compatibility is COMPLETE** — Checkpoint only calls
  `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, and
  `eth_getLogs`. All standard, all supported by anvil. **No blockers
  for the build-from-source path.**
- **Cold-start estimate**: 50-90s per indexer (Docker build + npm
  install dominate).
- **Recommended bootstrap**: wrapper script that runs `RESET=true`
  → injects the `last_indexed_block` row → invokes `npm run dev`.

- **slice 2** (this iteration) — `scripts/start-indexers.mjs` (new):
  brings up the two Checkpoint indexers via docker compose. Decision
  made during implementation: rather than `extends:`/`include:` (both
  awkward for the postgres dependency), drive each indexer compose
  as a SEPARATE compose project (`futarchy-harness-registry` and
  `futarchy-harness-candles`). The futarchy-indexers composes are
  not modified — env vars `RPC_URL`/`GNOSIS_RPC_URL`/`RESET`/
  `GNOSIS_BLOCK_RANGE` already exist on them and we drive via env.

  - **Networking**: indexers reach native anvil via
    `host.docker.internal:<port>` (Mac/Windows). Linux requires
    `ANVIL_HOST_URL=http://172.17.0.1:<port>` override (documented
    in CLI help; auto-detection deferred).
  - **Public surface**: `startIndexers({anvilPort, reset, blockRange,
    registryOnly, candlesOnly})` returns `{registryUrl, candlesUrl,
    stop()}`. `stopIndexers(handles?)` for cleanup.
  - **CLI**: `node scripts/start-indexers.mjs [--anvil-port N]
    [--reset|--no-reset] [--block-range N] [--stop]`. Env
    `HARNESS_WAIT=1` opts into post-up GraphQL readiness polling.
  - **Exit codes** documented (0 ok, 1 args, 2 indexers-not-found,
    3 docker-down, 4 compose-up failed, 5 readiness timeout).

  - `tests/smoke-start-indexers.test.mjs` (new): 6 cases covering
    the dispatch + error-handling layer WITHOUT actually pulling
    Docker images:
      1. INDEXERS_NOT_FOUND with bad INDEXERS_PATH override
      2. DOCKER_DOWN when daemon unreachable (skips when up)
      3. stopIndexers no-args clean call
      4. CLI --help prints usage + exits 0
      5. CLI --stop exits 3 when daemon down
      6. CLI exits 2 when INDEXERS_PATH bad AND daemon up (skips
         when daemon down — the daemon-up branch we can't validate
         without live docker)
    5 pass + 1 skip in 2.3s.

  - npm scripts: `smoke:start:indexers`, `indexers:start`,
    `indexers:stop` in harness; corresponding `auto-qa:e2e:*`
    shortcuts at root.

  - CHECKLIST item ticked: "indexer launchable from harness" with
    note about the SEPARATE compose project decision.

**Smoke summary (post-Phase 3 slice 2):**

```
[Phase 1]
  start-fork + block-clock                         ✓ ~3s
  setNextTimestamp                                 ✓ ~2.5s
  setBalance                                       ✓ ~2.5s
  impersonateAccount                               ✓ ~3s
  compose smoke                                     ⊘ skipped (daemon down)
[Phase 2]
  orchestrator dual-source                          ✓ ~3.5s
  passthrough verbatim                              ✓ ~280ms
  passthrough 500                                   ✓ ~280ms
  passthrough 502 unreachable                       ✓ ~270ms
  multi-spawn stress (3 cycles)                    ✓ ~8.2s
[Phase 3]
  detect-indexers (happy)                           ✓ ~25ms
  detect-indexers (missing-override)                ✓ ~1ms
  start-indexers INDEXERS_NOT_FOUND                 ✓ ~640ms
  start-indexers DOCKER_DOWN                        ✓ ~330ms
  stopIndexers no-args clean                        ✓ ~730ms
  start-indexers CLI --help                         ✓ ~40ms
  start-indexers CLI --stop daemon down             ✓ ~365ms
  start-indexers CLI INDEXERS_NOT_FOUND daemon up   ⊘ skipped (daemon down)
                                       TOTAL: 16 pass + 2 skip
```

- **slice 3** (this iteration) — `scripts/bootstrap-start-block.mjs`
  (new): pre-seeds `_metadatas.last_indexed_block` so the Checkpoint
  indexer skips from genesis to anvil's fork height. Per Spike-001:
  `Container.getStartBlockNum()` reads this row at indexer start and
  returns `max(configStart, lastBlock + 1)`. Writing
  `lastBlock = startBlock - 1` makes the next scan begin at exactly
  `startBlock`.

  - **SQL via `docker compose exec postgres psql`** — no host psql
    install needed. Uses `-T` for non-TTY, `ON_ERROR_STOP=1`, and
    parameterized indexer name (default 'gnosis' — both indexers
    register under that name per `src/index.ts`).
  - **Public surface**: `bootstrapStartBlock({kind, startBlock,
    indexerName})`, `readStartBlock({kind, indexerName})`. `kind` is
    `'registry'` or `'candles'`.
  - **CLI**: `node scripts/bootstrap-start-block.mjs --kind registry
    --start 46100000` or `--read` to inspect.
  - **Exit codes**: 0 ok / 1 args / 2 indexers-not-found /
    3 docker-down / 4 SQL-failed.
  - **Container name handling**: registry compose sets explicit
    `container_name: futarchy-registry-postgres`, candles uses
    default. `docker compose -p PROJECT exec postgres` is project-aware
    so it finds either correctly.

  - `tests/smoke-bootstrap-start-block.test.mjs` (new): 9 cases
    covering CLI arg validation + programmatic API contract WITHOUT
    requiring docker:
      1. CLI --help prints usage + exits 0
      2. CLI without --kind exits 1
      3. CLI with bad --kind exits 1
      4. CLI without --start exits 1
      5. CLI with negative --start exits 1
      6. CLI with valid args + daemon down exits 3 (skips when up)
      7. Programmatic: throws on startBlock=0
      8. Programmatic: throws on negative startBlock
      9. Programmatic: throws on unknown kind
    All 9 pass in 1s.

  - npm scripts: `smoke:bootstrap`, `indexers:bootstrap` in harness;
    `auto-qa:e2e:smoke:bootstrap`, `auto-qa:e2e:indexers:bootstrap`
    at root.

**Smoke summary (post-Phase 3 slice 3):**

```
[Phase 1]
  start-fork + block-clock                         ✓ ~3s
  setNextTimestamp                                 ✓ ~2.5s
  setBalance                                       ✓ ~2.5s
  impersonateAccount                               ✓ ~3s
  compose smoke                                     ⊘ skipped (daemon down)
[Phase 2]
  orchestrator dual-source                          ✓ ~3.5s
  passthrough verbatim                              ✓ ~280ms
  passthrough 500                                   ✓ ~280ms
  passthrough 502 unreachable                       ✓ ~270ms
  multi-spawn stress (3 cycles)                    ✓ ~8.2s
[Phase 3]
  detect-indexers (happy)                           ✓ ~25ms
  detect-indexers (missing-override)                ✓ ~1ms
  start-indexers contract (5 cases + 1 skip)       ✓ ~2.3s
  bootstrap-start-block contract (9 cases)         ✓ ~1s
                                       TOTAL: 25 pass + 2 skip
```

- **slice 4** (this iteration) — `tests/smoke-indexer-orchestration.test.mjs`
  (new): the FIRST test that exercises start-indexers against a live
  docker daemon. Brings up native anvil + registry indexer (via
  docker compose), waits for the indexer's GraphQL to respond to
  `{__typename}`, asserts return is `"Query"`, then tears down in
  dependency-aware order (indexer first, anvil second).

  - **Pre-flight skips (3)**: anvil not on PATH, indexer clone not
    found, or docker daemon down → skip with clear reason.
  - **Timeout**: ORCH_TIMEOUT_MS default 240s (Docker build dominates
    cold start; Spike-001 estimated 50-90s per indexer).
  - **Scope deliberately reduced** from the original "literal
    roundtrip invariant" planned for this slice. The bootstrap-vs-RESET
    race condition (see slice 5 below) needs a design pass before
    we can reliably inject `_metadatas.last_indexed_block` mid-startup.
    Shipping the orchestration smoke now lets us validate the build
    + networking end of the stack incrementally.
  - **Validated NOTHING runtime** — daemon is down on the dev machine
    today; test skips cleanly. Will go green when Docker Desktop is
    started.

  - npm script: `smoke:orchestration` in harness;
    `auto-qa:e2e:smoke:orchestration` at root.

**Smoke summary (post-Phase 3 slice 4):**

```
[Phase 1]
  start-fork + block-clock                          ✓ ~3s
  setNextTimestamp                                  ✓ ~2.5s
  setBalance                                        ✓ ~2.5s
  impersonateAccount                                ✓ ~3s
  compose smoke                                      ⊘ skipped (daemon down)
[Phase 2]
  orchestrator dual-source                           ✓ ~3.5s
  passthrough verbatim                               ✓ ~280ms
  passthrough 500                                    ✓ ~280ms
  passthrough 502 unreachable                        ✓ ~270ms
  multi-spawn stress (3 cycles)                     ✓ ~8.2s
[Phase 3]
  detect-indexers (happy)                            ✓ ~25ms
  detect-indexers (missing-override)                 ✓ ~1ms
  start-indexers contract (5 cases + 1 skip)        ✓ ~2.3s
  bootstrap-start-block contract (9 cases)          ✓ ~1s
  indexer orchestration                              ⊘ skipped (daemon down)
                                       TOTAL: 25 pass + 3 skip
```

- **slice 5** (this iteration) — `bootstrapAfterStart` + roundtrip
  test. Solved the bootstrap-vs-RESET race using the
  **restart-after-inject** approach (option mid-way between (a) and
  (c) from the design exploration):

    1. Start indexer with `RESET=true` (Checkpoint creates the
       `_metadatas` table + inserts `last_indexed_block=0`)
    2. Wait for the table to exist (poll `pg_class`)
    3. UPSERT `last_indexed_block` to `(startBlock - 1)`
    4. `docker compose restart <indexerService>` (postgres stays up)
    5. Re-await GraphQL — indexer now reads our injected value at
       startup via `getStartBlockNum()` and starts at startBlock

  This avoids needing to know the upstream `_metadatas` schema (we
  don't pre-create — we let Checkpoint do it). The wasted compute
  is bounded: between RESET and restart the indexer scans from
  configStart (~44.2M for registry) but anvil returns empty for
  pre-fork blocks, so the iterations are cheap.

  - `scripts/bootstrap-start-block.mjs`:
    - Added `bootstrapAfterStart({kind, startBlock, indexerName,
      tableTimeoutMs})` — does the wait→update→restart sequence
    - Added `awaitMetadataTable(opts, timeoutMs)` — polls pg_class
    - Added `composeRestart(composePath, project, service)` —
      restarts a single service in a project
    - `KIND_CONFIG` extended with `indexerService` (registry-checkpoint
      / checkpoint per upstream compose)

  - `tests/smoke-indexer-roundtrip.test.mjs` (new): the actual
    chain↔indexer invariant. Skips when anvil/indexer-clone/docker
    unavailable. Full flow per docstring (start anvil → start indexer
    with RESET → bootstrap → mine → assert indexer follows).
    Default timeouts: ready 240s, sync 60s. Override via
    `HARNESS_INDEXER_READY_MS` / `HARNESS_INDEXER_SYNC_MS`.

  - npm scripts: `smoke:roundtrip` in harness;
    `auto-qa:e2e:smoke:roundtrip` at root.

  - CHECKLIST.md: Phase 3 "Smoke test" item ticked with reframe
    note (we test block-following as the foundational invariant;
    Swap-event-specific tests need mock contracts on anvil — future
    work).

**Smoke summary (post-Phase 3 slice 5):**

```
[Phase 1]
  start-fork + block-clock                          ✓ ~3s
  setNextTimestamp                                  ✓ ~2.5s
  setBalance                                        ✓ ~2.5s
  impersonateAccount                                ✓ ~3s
  compose smoke                                      ⊘ skipped (daemon down)
[Phase 2]
  orchestrator dual-source                           ✓ ~3.5s
  passthrough verbatim                               ✓ ~280ms
  passthrough 500                                    ✓ ~280ms
  passthrough 502 unreachable                        ✓ ~270ms
  multi-spawn stress (3 cycles)                     ✓ ~8.2s
[Phase 3]
  detect-indexers (happy)                            ✓ ~25ms
  detect-indexers (missing-override)                 ✓ ~1ms
  start-indexers contract (5 cases + 1 skip)        ✓ ~2.3s
  bootstrap-start-block contract (9 cases)          ✓ ~1s
  indexer orchestration                              ⊘ skipped (daemon down)
  indexer roundtrip                                  ⊘ skipped (daemon down)
                                       TOTAL: 25 pass + 4 skip
```

**Phase 3 wrap-up — remaining:**

- **slice 6 — Live runtime validation** (gated on Docker Desktop
  start). All 4 docker-down skips become passes. Will likely surface
  bugs in:
  - Cold-start time (Spike-001 estimated 50-90s; actual on this
    Mac may differ)
  - `host.docker.internal` reachability from indexer container
  - Restart timing — does Checkpoint's `Container` cleanly re-read
    `getStartBlockNum()` on container restart?
  - Race between table creation and our `awaitMetadataTable` poll
- **slice 7 — Cold-start optimization** (only if Phase 7 CI wall
  time becomes problematic). Pre-warmed postgres image strategy.
- **slice 8 — Per-event invariant** (post-Phase-3): deploy a mock
  futarchy contract on anvil, fire NewProposal, assert it lands in
  the indexer's `proposals` table. Foundation for Phase 6 scenario
  replays.

**Phase 3 risks tracked:**

- Cold-start time may exceed CI tolerance (>2 min). Mitigation:
  pre-warmed postgres image with seeded schema.
- Anvil ↔ indexer RPC compat unknown until spike completes.
- Container shutdown ordering matters (indexer may loop trying to
  reach a dead anvil). `stopAll()` will need `stopOrdered()`.

### Phase 4 — Synthetic wallet + first scripted swap (UI side)

All Phase 4 slices live in the interface repo
(`interface/auto-qa/harness/PROGRESS.md` for the detailed log).
Summary of what shipped:

- slices 1+3 — wallet stub `createProvider` (in-process EIP-1193
  provider wrapping a viem account), `nStubWallets`, 8-case live
  anvil smoke, anvil dev-account quirk diagnosed and worked around
- slice 2 — contract-call surface (`scripts/contracts.mjs`) with
  ERC20/WXDAI/RATE_PROVIDER ABIs, sDAI reads + WXDAI.deposit +
  Deposit event decode validated against live Gnosis fork
- slice 4 — end-to-end roundtrip (wallet stub + Phase 3 indexer)
  PENDING; gated on Docker Desktop start

### Phase 5 — Playwright + DOM↔API assertions (UI side)

All Phase 5 slices live in the interface repo
(`interface/auto-qa/harness/PROGRESS.md` for the detailed log).
Summary of slice 1:

- **slice 1** (this iteration on the interface side) — browser-
  injection smoke landed:
  - `@playwright/test ^1.59.1` + chromium binary installed
  - `playwright.config.mjs` rewritten to real `defineConfig`
    (single chromium project, webServer auto-launches Next.js
    unless `HARNESS_NO_WEBSERVER=1`)
  - `installWalletStub` browser wrapper now returns self-executing
    JS source for `addInitScript` — wires window.ethereum +
    EIP-6963 announcement; in-page handles wallet-local methods
    + chainChanged emission; signing methods reject -32601 (slice
    2 will inline @noble/secp256k1); other methods fetch-forward
    to the configured RPC
  - `flows/wallet-injection.spec.mjs` — 6 browser tests green in
    2.4s. Resolved a CORS/null-origin gotcha by switching the
    eth_blockNumber forward test from a real http server to
    `context.route(...)` interception (chromium drops fetches from
    `about:blank` to local addresses regardless of CORS headers)
- **Phase 5 substantively COMPLETE.** The CHECKLIST goal
  ("First DOM↔API check: navigate to a proposal page, scrape
  the visible price, compare to the api response that produced
  it") is met by slice 4c v3b. Remaining: 4d (cross-protocol
  reconciliation) — more advanced bug-probe, not Phase 5
  acceptance-critical.

Phase 6 slice 1 summary (this iteration on the interface side):

- Scenario format decided. The original CHECKLIST framing was
  "JSON snapshot vs full state dump"; the actual design space
  turned out broader (JSON, executable .scenario.mjs modules,
  naming conventions, full anvil state dump). Decision: **Option
  B** — executable `.scenario.mjs` modules in
  `auto-qa/harness/scenarios/`, exporting a `Scenario` object
  with `{name, description, bugShape, route, mocks, assertions}`.
- Rationale: reuses the existing fixture vocabulary
  (makeGraphqlMockHandler, makeCandlesMockHandler,
  fakePoolBearingProposal, installWalletStub, setupSigningTunnel)
  directly. JSON would have required porting all of it into a
  JSON-interpreting shim. Phase 6's stop-here value ("first real
  bug shape replayable") is achievable today via mocked-API +
  DOM assertions. Full-stack snapshot deferred to Phase 7 chaos
  work.
- Structure landed: ADR-002 at
  `interface/auto-qa/harness/docs/ADR-002-scenario-format.md`;
  `auto-qa/harness/scenarios/` directory with README documenting
  format + naming convention (<NN>-<short-name>.scenario.mjs).
- Slice 2 lands the first scenario + wrapper spec (see below).

Phase 6 slice 2 summary (this iteration on the interface side):

- Mock-helper extraction: makeGraphqlMockHandler,
  makeCandlesMockHandler, fakeProposal, fakePoolBearingProposal,
  PROBE_* constants moved out of flows/dom-api-invariant.spec.mjs
  into a new shared module fixtures/api-mocks.mjs. Both the spec
  AND scenario files now import from there.
- First scenario captured:
  scenarios/01-stale-price-shape.scenario.mjs lifts slice 4c v3b's
  mocks + assertions into the Scenario format (ADR-002). Guards
  the PR #64 stale-price-but-API-healthy bug shape.
- Wrapper spec flows/scenarios.spec.mjs auto-discovers
  scenarios/*.scenario.mjs, dynamically imports each, and emits
  one Playwright test('<name> — <bugShape>') per scenario.
  Default wallet stub + mocks + navigation + sequential
  assertions baked in.
- Validated end-to-end: 7 tests pass when run together (6
  dom-api-invariant + 1 scenario). Phase 6's "first real bug
  shape replayable" gate is met.
- scenarios/README.md updated with a "Current scenarios" table.
  Becomes the human-readable bug-shape catalog.

Phase 7 slice 1 summary (this iteration on the interface side):

- First concrete chaos primitive landed:
  scenarios/02-registry-down.scenario.mjs mocks REGISTRY
  GraphQL → 502 Bad Gateway, asserts /companies degrades
  gracefully to "No organizations found" (the
  OrganizationsTable.jsx empty-state branch fires when both
  useAggregatorCompanies AND fetchProposalsFromAggregator
  return [] after their .catch branches handle the 502).
- Composability proof: the Phase 6 wrapper spec auto-discovered
  the new scenario without ANY code change. The Scenario
  format's `mocks: {url: handler}` works for chaos because
  Playwright's route handlers can return any HTTP status — no
  format change needed; just a different handler.
- Bug-shapes guarded: hard-crash on registry 5xx, hung-spinner
  with no terminal state, raw error envelope leaked to UI,
  silent broken state that fakes success.
- 1 new scenario (2.4s); both 01 + 02 together: 20s wall-clock
  with cold compile. UI smoke: 28 pass + 0 skip.
- Phase 7 staging: slice 2 = more chaos primitives (CANDLES
  timeout, WALLET RPC failure, mid-flight failure); slice 3 =
  CI nightly cron + artifact upload; slice 4 = full-stack
  docker-compose.

Phase 7 slice 2 (candles branch) summary (this iteration on the interface side):

- scenarios/03-candles-down.scenario.mjs: mocks REGISTRY → success
  (carousel renders our event card) + CANDLES → 502 (both bulk
  prefetch AND per-pool fallback fail). Asserts event title
  visible AND "0.00 SDAI" visible.
- Discovery: per src/utils/SubgraphPoolFetcher.js, the per-pool
  fetcher hits the SAME getSubgraphEndpoint → CANDLES URL as the
  bulk prefetcher. So a CANDLES outage takes BOTH layers down at
  once; there's no third-tier fallback. The formatter eventually
  lands on its `prices.yes !== null ? … : '0.00 SDAI'` branch and
  renders the literal "0.00 SDAI". This is a harness-level
  architecture finding worth pinning.
- Negative-companion benefit: 03 tightens the DOM↔API invariant
  on scenario 01. If someone later adds a silent default-price
  source ("if candles fails, use X instead"), 01 might still
  pass spuriously, but 03 fails because "0.00 SDAI" wouldn't
  appear anymore.
- 03 alone: 1.4s; all 3 scenarios together: 20.3s wall-clock
  with cold compile. UI smoke: 29 pass + 0 skip.
- Phase 6 slice 3 (catalog generator) is now UNBLOCKED — with
  3 scenarios, the script becomes worth writing.

Phase 6 slice 3 summary (this iteration on the interface side):

- Looped back from Phase 7 to ship Phase 6 slice 3 now that the
  ≥3-scenarios unblock condition is met.
- New: `scripts/scenarios-catalog.mjs` (~70 lines). Reads
  scenarios/*.scenario.mjs, dynamically imports each, validates
  required fields (name/description/bugShape/route), writes
  scenarios/SCENARIOS.md with a markdown table indexing the
  bug-shapes. Pipes in content are escaped so the table layout
  survives.
- npm scripts: `scenarios:catalog` in harness;
  `auto-qa:e2e:scenarios:catalog` at root.
- First generated SCENARIOS.md committed (3 scenarios indexed).
  README.md slimmed to authoring notes only — the canonical
  bug-shape index lives in the auto-generated file so PRs only
  update one place.
- Drift gate: future CI step can run the script and
  `git diff --exit-code scenarios/SCENARIOS.md` to fail builds
  where the catalog is stale. Pinned in CHECKLIST as a Phase 7
  slice 3 (CI integration) item.
- Phase 6 status: COMPLETE. All three CHECKLIST gates met
  (format decided, first scenario captured, wrapper-spec replay
  + catalog generator both in place).

Phase 7 slice 2 (partial branch) summary (this iteration on the interface side):

- 04-candles-partial.scenario.mjs: 2 events in REGISTRY, CANDLES
  returns prices for only ONE. Asserts the priced card renders
  "0.4200 SDAI" while the unpriced card falls back to "0.00 SDAI"
  AND both cards remain visible. The "API is up but my data
  isn't in the answer" shape — distinct from 03's full outage.
- Bug-shapes guarded: missing price corrupting all cards, card
  vanishing when its price is missing, formatter crashing on
  null prices, prices swapping between cards.
- Two slice-2 sub-slices DEPRIORITIZED after investigation:
  (a) WALLET RPC failure has near-zero blast radius on
  /companies (wallet stub handles auto-probe methods locally,
  not via rpcPassthrough); (b) mid-flight failure on /companies
  is DOM-indistinguishable from full failure (consumer drops
  the hook's error field). Both worth revisiting on a market
  detail page that surfaces partial loading states.
- 04 alone: 1.4s; all 4 scenarios together: 20.6s wall-clock
  with cold compile. UI smoke: 30 pass + 0 skip.
- SCENARIOS.md regenerated cleanly via the slice 3 script, now
  indexes 4 scenarios.
- Transient gotcha worth noting: first run failed with
  "Playwright Test did not expect test.describe()" — turned out
  to be a stale dev-server / test-results interaction, fixed by
  killing port 3000 and clearing test-results/.

Phase 7 slice 3a summary (this iteration on the interface side):

- **CI workflow STAGED** for promotion to `.github/workflows/`.
  Slice 3a starts the path to harness checks running in CI
  without requiring a developer to manually run anything.
- What landed in the interface repo:
  * `auto-qa/harness/ci/auto-qa-harness.yml.staged` (NEW) — the
    workflow YAML in version control under a `.staged` extension
    so GitHub Actions doesn't try to run it from this location.
  * `auto-qa/harness/ci/README.md` (NEW) — explains the staging
    dance + the promote command.
- The workflow: trigger is `workflow_dispatch` ONLY for v1
  (manual fire from GitHub Actions UI) — landing the first
  workflow file can't unexpectedly red-light unrelated PRs.
  Job: `actions/checkout@v4` → `actions/setup-node@v4` (Node 22,
  npm cache keyed on auto-qa/harness/package-lock.json) →
  `npm ci` in auto-qa/harness/ → `npm run scenarios:catalog` →
  `git diff --exit-code auto-qa/harness/scenarios/SCENARIOS.md`.
  Total runtime expected <1 min (no browser, no Next.js).
- **Why staged not live**: GitHub blocks OAuth Apps without
  `workflow` scope from creating/modifying `.github/workflows/*`
  files. The bot's token is push-scoped only. The first iteration
  tried to commit the workflow directly and the push got rejected:
  `! [remote rejected] auto-qa -> auto-qa (refusing to allow an
  OAuth App to create or update workflow
  '.github/workflows/auto-qa-harness.yml' without 'workflow'
  scope)`. Recovered via `git reset --soft HEAD~1` then
  `mv .github/workflows/auto-qa-harness.yml
  auto-qa/harness/ci/auto-qa-harness.yml.staged`,
  `rm -rf .github`, plus the new ci/README.md. The staging dance
  puts the content under code review + version control without
  needing the workflow scope, then a maintainer (or anyone with
  the right token) promotes by copying the file into
  `.github/workflows/`.
- Local validation of the workflow's logic matched what CI will
  do: `npm ci` in auto-qa/harness/ succeeded with `found 0
  vulnerabilities`; `npm run scenarios:catalog` regenerated
  SCENARIOS.md cleanly; `git diff --exit-code` returned 0
  (catalog already in sync).
- Drift-check value-add (once promoted): the CI step ensures any
  PR adding/changing a scenario also re-runs the catalog
  generator. SCENARIOS.md is the human-readable bug-shape index;
  without the drift check, it silently goes stale.
- Promote command (one-time maintainer task on interface side):
  `mkdir -p .github/workflows && cp
  auto-qa/harness/ci/auto-qa-harness.yml.staged
  .github/workflows/auto-qa-harness.yml && git add
  .github/workflows/auto-qa-harness.yml && git commit -m
  "ci: promote auto-qa harness scenarios-catalog-drift" &&
  git push`. Pushes from a workflow-scoped token (or via the
  GitHub web UI's "Add file" action) succeed where the bot's
  token can't.
- Slice 3b (next): once 3a is promoted + smoke-tested, broaden
  triggers (`schedule: '0 4 * * *'` for nightly drift sweep +
  `pull_request: paths: ['auto-qa/harness/**']` for gating
  harness-touching PRs). Edit the staged file, commit, maintainer
  re-promotes. Slice 3d: per-failure `actions/upload-artifact@v4`
  block (Playwright traces / screenshots / videos).

Phase 7 slice 3c summary (this iteration on the interface side):

- **Second CI workflow STAGED**: the heavier Playwright-scenarios
  runner. Kept as a SEPARATE workflow file from slice 3a's drift
  check so the maintainer can promote each independently and gate
  them differently.
- What landed in interface repo:
  * `auto-qa/harness/ci/auto-qa-harness-scenarios.yml.staged`
    (NEW) — second workflow YAML.
  * `auto-qa/harness/ci/README.md` updated to list both staged
    files + recommended promote order (drift check first, then
    scenarios after smoke-test).
- The workflow (`auto-qa-harness-scenarios.yml`):
  `actions/checkout@v4` → `actions/setup-node@v4` (Node 22, npm
  cache on BOTH lockfiles — root + auto-qa/harness) → `npm ci` at
  root (Next.js dev server) → `npm ci` in auto-qa/harness
  (Playwright + viem) → `actions/cache@v4` of
  `~/.cache/ms-playwright` keyed on harness lockfile hash → on
  cache miss `npx playwright install --with-deps chromium`,
  on hit `npx playwright install-deps chromium` → `npm run
  ui:full` in auto-qa/harness with
  `HARNESS_FRONTEND_RPC_URL=https://rpc.gnosischain.com`.
  Trigger is `workflow_dispatch` ONLY for v1 (mirroring slice
  3a's conservative roll-out). Timeout 20 min; expected
  wall-clock ~5-10 min cold (~2-3 min once browser cache hits).
- **Why a SEPARATE file (not a second job in slice 3a's
  workflow)**: different cost profile (drift check <1 min vs
  scenarios suite ~5-10 min) → different cadence sensible
  (drift could run on every PR, scenarios maybe nightly +
  manual); atomic promote-per-slice; reduced blast radius
  (misconfigured scenarios YAML can't red-light the drift
  check); different cache-dep paths (drift only needs harness
  lockfile, scenarios needs both).
- **Why public-RPC env**: there's no anvil in the GitHub
  runner. The wallet-signing eth_sendTransaction case
  auto-skips when `whichAnvil()` returns null; the other
  tests just need a working JSON-RPC endpoint for Wagmi to
  bootstrap (chain ID lookup, etc).
- **Browser-cache pattern** (the trickiest piece): Playwright
  caches its browser binaries in `~/.cache/ms-playwright`,
  which `actions/cache@v4` can persist across runs. Apt-level
  system deps (e.g. libnss3) aren't cached and must be
  reinstalled each run, so the two-step pattern is: cache
  miss → `playwright install --with-deps chromium` (binary +
  deps in one command); cache hit → `playwright install-deps
  chromium` (apt-only, ~10-30s). Reduces warm-cache install
  time from ~60s to ~10s without risking missing system deps.
- Promote command (one-time maintainer task on interface side,
  AFTER smoke-testing slice 3a): `cp
  auto-qa/harness/ci/auto-qa-harness-scenarios.yml.staged
  .github/workflows/auto-qa-harness-scenarios.yml && git add
  .github/workflows/auto-qa-harness-scenarios.yml && git
  commit -m "ci: promote auto-qa harness scenarios-suite" &&
  git push`.
- Local validation: harness `npm ci` succeeded; `npm run
  ui:full` was last run end-to-end during slice 3a iteration
  (30 tests, all green); YAML parses cleanly via
  `python3 -c 'import yaml; yaml.safe_load(open(...))'`.
- Slice 3b (next bot-doable, but gated on 3a smoke-test):
  triggers expansion on the slice-3a workflow file
  (`schedule: '0 4 * * *'` + `pull_request: paths:
  ['auto-qa/harness/**']`).

Phase 7 slice 3d summary (this iteration on the interface side):

- **On-failure artifact upload STAGED** as one new step appended
  to slice 3c's staged scenarios workflow (NOT a new file —
  same workflow, one more step). When the scenarios suite fails
  in CI, you NEED the trace/screenshots/video to debug; without
  this step, that payload would die in the runner's ephemeral
  filesystem.
- Edit landed at:
  `auto-qa/harness/ci/auto-qa-harness-scenarios.yml.staged`
  appending one `actions/upload-artifact@v4` step right after
  the `npm run ui:full` step.
- Step shape:
  ```
  - name: Upload Playwright artifacts on failure
    if: failure()
    uses: actions/upload-artifact@v4
    with:
      name: playwright-scenarios-results-${{ github.run_attempt }}
      path: |
        auto-qa/harness/playwright-report/
        auto-qa/harness/test-results/
      retention-days: 14
      if-no-files-found: ignore
  ```
- **Why these two paths**: `playwright.config.mjs` already
  configures the on-failure capture (`trace: retain-on-failure`,
  `screenshot: only-on-failure`, `video: retain-on-failure`)
  plus the HTML report (`outputFolder: 'playwright-report'`).
  All the bot needs is to hoist them out of the runner's
  workspace before tear-down.
- **Why `${{ github.run_attempt }}` in the artifact name**: the
  Playwright config sets `retries: 2` in CI mode. Without the
  suffix, retry #2 would clobber retry #1's artifacts (or the
  upload would fail with "name already exists"). With it, you
  get `playwright-scenarios-results-1`, `-2`, `-3` for a
  fully-retried failed run — all visible in the workflow's
  Artifacts tab.
- **Why `if-no-files-found: ignore`**: covers the corner case
  where the workflow fails BEFORE Playwright produces any
  output (e.g. `npm ci` itself fails). Without it, the upload
  step would fail too, masking the real error in the run log.
- **Why STAGED together with 3c (not a separate file)**: 3d is
  one more step in 3c's job — same workflow file, same runtime,
  same trigger. Splitting would require a second promote and a
  second smoke-test for what's effectively a feature flag on
  3c's debugging output. Promoted together, they form one
  coherent "run scenarios + capture failures" workflow.
- Local validation: `npx js-yaml@4 ...` parses the file
  cleanly; the upload-artifact step shows up at the right point
  in the parsed structure with `if: failure()` and the two
  correct paths.
- Phase 7 slice 3 status after this slice: 3a, 3c, 3d STAGED
  (waiting on maintainer promote). 3b is the only remaining
  bot-doable sub-slice (and it's gated on slice 3a being
  smoke-tested live first). Then slice 4 — full-stack
  docker-compose.

Phase 7 slice 4a-prep summary (this iteration on the api side):

- Slice 4 (full-stack docker-compose) starts with prep work
  laying the groundwork for activating the futarchy-api service
  in `auto-qa/harness/docker-compose.yml`. The compose file has
  had an api block stubbed (commented out) since Phase 0 slice
  2; this iteration tracks the prerequisites so the block can
  be uncommented in slice 4a proper.
- What landed:
  * `Dockerfile` (NEW, tracked) — 12-line node:22-alpine
    image, runs `npm ci --omit=dev`, `EXPOSE 3031`, `CMD
    ["node", "src/index.js"]`. File was sitting untracked at
    api repo root from a prior iteration; this commit just
    tracks it.
  * `.dockerignore` (NEW, tracked) — excludes node_modules,
    .env*, test-*.js + test-*.mjs, example-test-*.js, docs,
    *.md, lambda-deploy, test-checkpoint-vs-graph-node. Same
    "untracked → tracked" story as Dockerfile.
  * `auto-qa/harness/docker-compose.yml` (modified) — api
    block's port assumptions corrected. Was: `PORT: 3000` env
    + commented `ports: - "3000:3000"`. Now: `PORT: 3031`
    (informational only) + commented `ports: - "3031:3031"`.
  * Comment block above the api service expanded with a note
    explaining the port discovery (see below).
- **Real bug surfaced**: `src/index.js:25` hardcodes
  `const PORT = 3031` and never reads `process.env.PORT`. The
  original compose comment block expected `PORT: 3000` to be
  honored at runtime, but it would have been silently ignored
  (the api would still bind to 3031 inside the container,
  the compose's `ports: - "3000:3000"` would map to nothing,
  and a "why isn't the api responding?" debugging session
  would follow). Compose comment now documents the constraint
  so future contributors see it before activating the block.
- **Why fix the compose, not src/index.js**: the cross-cutting
  acceptance gate says "Production code in `src/` (both repos)
  is NEVER modified by harness work". src/index.js IS
  production code. The harness adapts to its reality, not the
  other way around.
- Block REMAINS COMMENTED OUT — uncommenting + verifying
  `docker compose build api` is slice 4a proper, not 4a-prep.
  This iteration is just the prerequisite tracking.
- CHECKLIST slice 4 expanded: 4a-prep DONE; 4a (uncomment +
  build), 4b (indexer), 4c (interface-dev mount), 4d
  (orchestrator), 4e (full `up -d` acceptance gate) sketched.
- Validation: `npx js-yaml@4 auto-qa/harness/docker-compose.yml`
  parses cleanly; the named-service tree shows `anvil` as the
  only active service (api block stays a YAML comment).

Phase 7 slice 4a summary (this iteration on the api side):

- The api block in `auto-qa/harness/docker-compose.yml` is now
  UNCOMMENTED + structurally validated. `docker compose config`
  parses cleanly with both `anvil` + `api` services active.
- **Real bug surfaced**: the original Phase 0 scaffold had
  `context: ../../..` which resolved to `/Users/kas/` (the
  parent of the api repo, NOT the repo root). Three levels up
  from `auto-qa/harness/` is one too many — should be
  `context: ../..` (api repo root, where Dockerfile +
  package.json live). This is the SECOND port/path bug
  surfaced by activating the api service (the first being the
  PORT discovery in slice 4a-prep). Fixed in this slice;
  comment block above the field documents the gotcha.
- **Why indexer dependency stays commented out**: the original
  api block had `depends_on: indexer: condition: service_started`,
  but the indexer service doesn't exist in compose yet (slice 4b
  adds it). With the dependency uncommented, `docker compose up
  api` would fail with `service "indexer" is not defined`.
  Removing the dep means the api can start without the indexer
  — request-time endpoints that proxy to CHECKPOINT_URL will
  fail until 4b lands, but `docker compose build api` and
  `up api` themselves succeed. The dep gets re-added in slice
  4b alongside the indexer service.
- **Why ports comment stays commented out**: compose-internal
  traffic uses the service name (`api:3031` from inside the
  network), so host port mapping isn't needed for the
  in-network case. The comment block tells future
  contributors how to flip it on for local debugging.
- **What WAS validated**: `docker compose config --quiet`
  succeeds; `docker compose config --services` returns
  `anvil` + `api`; build context resolves to the correct path
  per `docker compose config | grep context:`.
- **What WASN'T validated** (out of bot scope this iteration):
  the actual `docker compose build api`. The Docker daemon is
  not running on the machine the bot is on (`Cannot connect to
  the Docker daemon at unix:///Users/kas/.docker/run/docker.sock`).
  Pinned as 4a-verify in CHECKLIST — a small human step
  (start Docker Desktop, then `docker compose -f
  auto-qa/harness/docker-compose.yml build api`).
- Slice 4 is now ~17% done (4a-prep + 4a out of 4a-prep + 4a +
  4b + 4c + 4d + 4e). Next bot-doable: slice 4b (add Phase 3
  indexer service to compose) — bigger lift, decisions to make
  about Checkpoint image source.

Phase 7 slice 4b-plan summary (this iteration on the api side):

- **Big architectural finding pre-empts implementation**: the
  Phase 0 indexer stub assumed ONE service `indexer` with
  `image: TODO`. Reality, per ADR-002 + Phase 3
  implementation, is TWO indexers (registry + candles), each
  with its own postgres, each built from the sibling
  `futarchy-indexers` clone (per-service compose files at
  `futarchy-indexers/futarchy-complete/checkpoint/` and
  `futarchy-indexers/proposals-candles/checkpoint/`). The
  Phase 0 stub also used `CHECKPOINT_URL` as the api env var,
  but `src/config/endpoints.js` actually reads `REGISTRY_URL` +
  `CANDLES_URL` (third path/port bug surfaced by working
  through compose).

- **What landed (api side)**:
  * `auto-qa/harness/docs/ADR-002-indexer-bootstrap.md` —
    Status: Proposed → Accepted. Added a 2026-05 revisit note
    explaining how the decision held up through Phase 3 and
    what slice 4b-include/network-wire will do for Phase 7.
  * `auto-qa/harness/docker-compose.yml` — Phase 0 indexer
    stub block (the `image: TODO` single-service one)
    rewritten to point at ADR-002 and explain the four real
    services (registry-checkpoint + registry-postgres +
    candles-checkpoint + candles-postgres). New top-level
    `include:` block staged COMMENTED OUT, referencing both
    sibling indexer compose files; uncommenting is slice
    4b-include.
  * `auto-qa/harness/CHECKLIST.md` — slice 4b expanded into
    5 sub-slices: 4b-plan (DONE), 4b-include (uncomment),
    4b-network-wire (RPC_URL override + bridge networks),
    4b-api-env (CHECKPOINT_URL → REGISTRY_URL/CANDLES_URL +
    re-add depends_on), 4b-verify (full validation).

- **Why staged not active**: uncommenting `include:` brings in
  the four indexer services AND their networks (registry-net,
  candles-net) AND defaults RPC_URL to real Gnosis. Without
  the network bridging + env override done atomically, the
  indexers would either fail to reach anvil OR happily ingest
  from real Gnosis (defeating the harness purpose). Slice
  4b-include + 4b-network-wire are sequential, not parallel,
  but doing them one at a time risks an intermediate broken
  state. Slice 4b-plan stages the structure so the next two
  slices have a clear target.

- **Why ADR-002 wasn't already Accepted**: the ADR was written
  during Phase 3 slice 1 with status "Proposed (Phase 3 slice
  1)" assuming a future review session. That review never
  happened, but the implementation went ahead and has 25
  smoke tests behind it. Slice 4b-plan retroactively closes
  the loop: Status → Accepted, with a revisit note pointing
  at Phase 7 slice 4b's compose-include extension of the
  same decision.

- **Validation**: `docker compose config --quiet` succeeds;
  `--services` still returns just `anvil` + `api` (the
  include block is a YAML comment, no runtime delta). The
  Phase 0 `indexer:` stub block was deleted in favor of a
  redirect comment pointing at the include block + the
  per-service compose files in `futarchy-indexers`.

- Slice 4 progress: ~25% done (4a-prep + 4a + 4b-plan out of
  ~12 sub-slices total — slice 4b alone now decomposes into
  5). Next bot-doable: slice 4b-include (uncomment include
  block + add cross-network bridging) AND/OR 4b-network-wire
  (RPC_URL override).

Phase 7 slice 4b-include + 4b-api-env summary (this iteration on the api side):

- **4b-include**: uncommented the top-level `include:` block;
  `docker compose config --services` now returns 6 services:
  `anvil`, `api`, `registry-checkpoint`, `registry-postgres`,
  `checkpoint`, `postgres`.

- **Service-name reality vs Phase 0 stub assumptions**:
  registry compose uses `registry-checkpoint` +
  `registry-postgres` (prefixed); candles compose uses bare
  `checkpoint` + `postgres` (NOT `candles-checkpoint` /
  `candles-postgres` as the Phase 0 stub assumed). The
  container_names ARE prefixed (`futarchy-candles-checkpoint-1`)
  but the service names aren't. Also: candles uses
  `GNOSIS_RPC_URL`, registry uses `RPC_URL` — different env
  contracts. Both findings documented in the include-block
  comment.

- **4b-api-env**: api service env corrected from
  `CHECKPOINT_URL: http://indexer:3001/graphql` to
  `REGISTRY_URL: http://registry-checkpoint:3000/graphql` +
  `CANDLES_URL: http://checkpoint:3000/graphql` +
  `FUTARCHY_MODE: checkpoint`. Names now match
  `src/config/endpoints.js`. Wired to compose-internal service
  names + container port 3000 (the indexers `EXPOSE 3000`
  inside the network; their host ports 3001/3003 only matter
  from the host).

- **Why depends_on on indexers NOT added yet**: see
  4b-network-wire below — the indexers and api are on
  different networks (registry-net / checkpoint-net vs
  harness-net), so the api can't actually reach them yet via
  compose-internal name resolution. Adding the depends_on
  would have compose wait forever for cross-network
  healthchecks. Slice 4b-network-wire fixes this; only then
  can the depends_on be added.

- **4b-network-wire BLOCKED**: naive override attempt failed.
  Tried declaring same-name service blocks
  (`registry-checkpoint:`, `checkpoint:`) in the parent compose
  to extend the included services with `networks:
  [registry-net, harness-net]` + RPC env override. Compose
  rejected: `services.registry-checkpoint conflicts with
  imported resource`. Compose v2.34's `include:` does NOT
  allow same-name service redefinition in the parent file
  (different from `extends:` semantics). Three alternatives
  surfaced + documented:
  (a) Override-list form: `include: - path: [base.yml,
      overrides.yml]`. Compose merges base + overrides BEFORE
      include, so name collisions don't happen.
  (b) Per-service `extends:` (drop `include:`). Each indexer
      service declared here with `extends: { file: ...,
      service: ... }` plus harness overrides. ~4 service
      blocks, but no include conflict. Closest fit for
      ADR-002's wrapper leg.
  (c) Multi-file `docker compose -f base.yml -f
      overrides.yml`. Rejected: breaks the
      single-docker-compose.yml acceptance gate.
  Decision deferred to slice 4b-network-wire next iteration;
  approach (b) is the lead candidate.

- **What was learned (and pinned to memory via PROGRESS)**:
  compose v2's `include:` is for IMPORTING, not OVERRIDING.
  The conflict error is structurally equivalent to a TypeScript
  "duplicate identifier" error — there's no compose-level
  "override modifier" for included services.

- **Validation**: `docker compose config --quiet` succeeds;
  `--services` returns 6 (anvil + api + 4 indexer); api env
  shows REGISTRY_URL/CANDLES_URL/FUTARCHY_MODE in the merged
  output. The api's env contract is correct even though it
  can't actually reach the indexers across the network gap.

- Slice 4 progress: ~33% done (4a-prep + 4a + 4b-plan +
  4b-include + 4b-api-env / ~12 sub-slices total). Still 5
  bot-doable sub-slices to go in slice 4b alone before the
  full stack works.

Phase 7 slice 4b-network-wire summary (this iteration on the api side):

- Indexers wired into the harness compose via per-service
  `extends:` (approach b from the prior iteration's options
  list — closest fit for ADR-002's "wrapper service that
  delegates to it" leg).

- **What changed in compose**:
  * `include:` block REMOVED (it was rejecting same-name
    overrides).
  * Top-level `networks:` expanded with `registry-net` +
    `checkpoint-net` (not just `harness-net`).
  * Top-level `volumes:` declared with `registry-postgres-data`
    + `candles-postgres-data`. Both new top-level blocks needed
    because `extends:` only inherits service-level config.
  * 4 new service blocks: `registry-checkpoint`,
    `registry-postgres`, `checkpoint`, `postgres`. Each uses
    `extends: { file: ../../../futarchy-indexers/.../docker-compose.yml,
    service: <bare name> }` to pull in the indexer's full
    definition (build, ports, volumes, image, healthcheck).
  * The two checkpoint services get harness overrides:
      RPC_URL / GNOSIS_RPC_URL = http://anvil:8545 (override
      the included default of https://rpc.gnosischain.com so
      indexers ingest from anvil, not real Gnosis)
      RESET=${RESET:-true} (fresh DB on each harness start)
      networks: dual-homed (their own net + harness-net)
      depends_on: anvil + their respective postgres
  * api service depends_on now safely declares
    registry-checkpoint + checkpoint (service_started since
    indexers have no healthcheck).

- **Compose extends merge semantics confirmed by test**:
  * Maps (`environment`, `depends_on` long-form) MERGE —
    environment override layered cleanly on top of the
    included defaults; full env block visible in
    `docker compose config` output.
  * Sequences (`networks`, `ports`) REPLACE — must repeat
    the original network alongside `harness-net`.
  * Build context resolves to the EXTENDED file's directory,
    not the harness's. registry-checkpoint context resolves
    to `/Users/kas/futarchy-indexers/futarchy-complete/checkpoint`
    (correct), candles to
    `/Users/kas/futarchy-indexers/proposals-candles/checkpoint`
    (correct).

- **Validation**: `docker compose config --quiet` succeeds;
  `--services` returns 6 (anvil, api, postgres, checkpoint,
  registry-postgres, registry-checkpoint); merged config shows
  RPC_URL=http://anvil:8545 on registry-checkpoint and
  GNOSIS_RPC_URL=http://anvil:8545 on candles checkpoint;
  api depends_on lists all three.

- **What's still left to verify (slice 4b-verify, requires
  Docker daemon)**: actual `docker compose up -d` brings up the
  stack; the indexers can reach `http://anvil:8545` over
  harness-net; the api can resolve `http://registry-checkpoint:3000`
  + `http://checkpoint:3000` and get back GraphQL responses;
  the postgres healthchecks work end-to-end. Pinned as
  4b-verify in CHECKLIST.

- Slice 4 progress: ~42% done (6 of ~12 sub-slices total).
  Next: slice 4b-verify (daemon-required smoke test, mostly
  human) OR slice 4c (interface-dev block — Next.js dev
  server in compose).

Phase 7 slice 4c-prep summary (this iteration on the api side):

- Slice 4c (Next.js dev server in compose) starts with prep
  work surfacing + fixing FIVE bugs in the Phase 0
  `interface-dev` stub. Same pattern as slice 4a-prep: the
  stub couldn't be activated as-is; the prep slice fixes the
  stub in place (still commented) so 4c-activate becomes a
  one-step uncomment.

- **Bug catalog** (interface-dev block, Phase 0 stub vs reality):

  (i) **Path bug**: stub had
      `${INTERFACE_PATH:-../../../../interface}`. From
      `auto-qa/harness/`, four levels up = `/`. The bind mount
      would have failed at compose-up time (no `interface` dir
      at /). Corrected to `../../../interface` (= the standard
      sibling-clone layout at `/Users/kas/interface`). Same
      kind of "one too many ..s" issue as slice 4a's
      `context: ../../..` bug.

  (ii) **Port bug**: stub had `NEXT_PUBLIC_API_URL:
      http://api:3000`. The api binds to 3031 (Dockerfile
      EXPOSE 3031 + src/index.js:25 hardcoded; see slice
      4a-prep). Corrected to `http://api:3031`.

  (iii) **Missing anvil dep**: stub only had `depends_on:
      api`. But the dev server reads `NEXT_PUBLIC_RPC_URL:
      http://anvil:8545` and Wagmi needs anvil reachable
      before the page can mount. Added
      `depends_on: anvil: { condition: service_healthy }`
      alongside the api dep.

  (iv) **Bare `npm run dev` won't work in fresh container**:
      stub had `command: ["npm", "run", "dev"]`. With only
      a bind mount of the source repo (no node_modules),
      this would fail with "missing dependencies". Replaced
      with a `sh -c` script that conditionally runs
      `npm install` if node_modules is empty, then
      `exec npx next dev --hostname 0.0.0.0 --port 3000`.
      The `--hostname 0.0.0.0` is critical — `next dev`
      defaults to localhost-only binding which isn't
      reachable from outside the container; without it,
      compose-internal traffic from `api:3031` → `interface-dev:3000`
      would silently fail.

  (v) **Node version mismatch**: stub had
      `image: node:20-bookworm-slim`. The harness convention
      (per api Dockerfile + CI workflows that use node 22)
      is node:22. Standardized on `node:22-alpine` to match.

- **Top-level addition: `interface-node-modules` named
  volume**. Required to keep the container's node_modules
  separate from the host's. The host's node_modules has
  macOS/darwin binaries that wouldn't run in the Linux
  container; mounting them in via the bind would shadow
  any valid Linux installs from `npm install`. The named
  volume gives the container its own Linux-native
  node_modules tree without polluting the host.

- **Why STAGED not active**: even with all five bugs fixed,
  Next.js dev-in-container has known caveats worth a careful
  smoke test: file watching across bind mounts can be
  unreliable (chokidar polling fallback might be needed),
  HMR over the docker network has its own quirks, and the
  first-run `npm install` of ~1000+ deps can take minutes.
  Pinned as 4c-activate (one-step uncomment now that the
  stub is correct) + 4c-verify (daemon smoke + dev-loop
  validation, human task).

- **Validation**: `docker compose config --quiet` succeeds;
  `--services` still returns 6 (interface-dev block remains
  a YAML comment, no runtime delta). Top-level
  `interface-node-modules` volume is declared eagerly so
  4c-activate is purely a service-block uncomment.

- Slice 4 progress: ~50% done (7 of ~12+ sub-slices total —
  slice 4c now decomposes into 4c-prep + 4c-activate +
  potentially 4c-verify). Next: 4c-activate (uncomment) OR
  return to slice 4b-verify (daemon-required smoke).

Phase 7 slice 4c-activate summary (this iteration on the api side):

- The interface-dev block is now UNCOMMENTED.
  `docker compose config --services` returns 7 (anvil, api,
  registry-checkpoint, registry-postgres, checkpoint, postgres,
  interface-dev). Atomic one-step uncomment per slice 4c-prep's
  preparation — no edits needed to the block itself.

- **Merged config verified via `docker compose config`**:
  * depends_on: anvil (service_healthy) + api (service_started)
  * environment: NEXT_PUBLIC_RPC_URL=http://anvil:8545,
    NEXT_PUBLIC_API_URL=http://api:3031
  * image: node:22-alpine
  * command: sh -c with conditional `npm install` then
    `exec npx next dev --hostname 0.0.0.0 --port 3000`
  * volumes: bind mount of sibling interface clone via
    `${INTERFACE_PATH:-../../../interface}` + named volume
    `interface-node-modules` for Linux-isolated node_modules
  * networks: harness-net (single-homed; api + indexers reach
    it via the same network)

- **What's still pending in slice 4**:
  * 4c-verify (Docker daemon required, mostly human): bring
    up the stack and curl http://localhost:3010 to confirm
    `next dev` is reachable from the host. CHOKIDAR_USEPOLLING=true
    if HMR doesn't fire on host edits (bind-mount file
    watching across the docker FS layer is the most likely
    surprise).
  * 4d (orchestrator service): the Phase 0 stub has
    similar bugs to 4c's stub (Node 20 not 22, wrong path,
    wrong env vars, wrong port for api), AND a more
    fundamental scope issue — the orchestrator service is
    meant to "drive anvil's clock + send synthetic txs +
    run cross-layer assertions" per ARCHITECTURE.md, but
    those assertion scripts (auto-qa/harness/orchestrator/
    invariants.mjs in the architecture plan) don't exist
    yet. The existing orchestrator/ dir has services.mjs
    + stub-indexer.mjs. Slice 4d will need both compose
    wiring AND scenario script development; it's a chunkier
    sub-slice than 4a/4b/4c were.
  * 4e (`docker compose up -d` acceptance gate): trivial
    after 4c-verify + 4d.

- **What's NOT a regression**: this slice doesn't activate
  anything that wasn't already validated structurally in
  4c-prep. The Phase 0 stub bugs were fixed in 4c-prep; this
  slice just removes the comment markers. `docker compose
  build interface-dev` is implicit (the image is just
  `node:22-alpine`, no Dockerfile to build).

- Slice 4 progress: ~58% done (8 of ~13+ sub-slices total).
  Next bot-doable: slice 4d-prep (orchestrator stub fixes,
  if scope allows) OR 4d-scenarios (build the missing
  invariants.mjs assertion scripts).

Phase 7 slice 4d-prep summary (this iteration on the api side):

- Slice 4d (orchestrator service) starts with same prep
  pattern as 4a-prep + 4c-prep: surface + fix Phase 0 stub
  bugs in place, kept commented out. Plus a deeper scope
  finding that splits 4d into THREE sub-slices instead of
  the original one.

- **Bug catalog (orchestrator stub vs reality)**:

  (i) **Path bug**: stub had `../../../auto-qa/harness`.
      From `auto-qa/harness/`, three levels up = `/Users/kas/`,
      then `auto-qa/harness` on top = `/Users/kas/auto-qa/harness/`
      which doesn't exist. Bind mount would fail at compose-up.
      Corrected to `.` (the dir containing this compose file
      IS the harness dir = `/Users/kas/futarchy-api/auto-qa/harness/`).

  (ii) **Port bug**: stub had `API_URL: http://api:3000`.
      Api binds to 3031 (slice 4a-prep finding). Corrected
      to `http://api:3031`.

  (iii) **Wrong env vars**: stub had
      `CHECKPOINT_URL: http://indexer:3001/graphql`.
      `src/config/endpoints.js` reads `REGISTRY_URL` +
      `CANDLES_URL` (slice 4b-api-env discovery), and there's
      no `indexer` service — it's `registry-checkpoint` +
      `checkpoint`. Replaced with the correct two vars
      pointing at the right compose-internal services on
      port 3000 (container-internal, not host-mapped 3001/3003).

  (iv) **Node version mismatch**: stub had
      `image: node:20-bookworm-slim`. Standardized on
      `node:22-alpine` to match api Dockerfile +
      interface-dev convention.

  (v) **Bare `npm run test` won't work in fresh container**:
      bind mount has source but no node_modules. Replaced
      command with the same conditional `npm install` +
      `exec ...` pattern as interface-dev.

- **Top-level addition**: `orchestrator-node-modules` named
  volume (same pattern as `interface-node-modules`).

- **DEEPER SCOPE FINDING** — slice 4d's command needs to
  do something useful, but the assertion scripts don't exist
  yet. ARCHITECTURE.md envisions
  `auto-qa/harness/orchestrator/invariants.mjs` (cross-layer
  assertion library) and a scenario-runner that drives anvil's
  clock + sends synthetic txs + verifies per-block invariants.
  Neither exists yet. The existing `orchestrator/services.mjs`
  ASSUMES native-anvil + script-orchestrated indexers (Phase 3
  topology) — running it inside compose would conflict with
  the already-running anvil + indexers.

  Two paths forward (decision deferred to slice 4d-scenarios):
  (a) Build `orchestrator/scenario-runner.mjs` that gates on
      `HARNESS_COMPOSE=1`: in compose mode, skip spawning,
      just hit existing endpoints; in native mode, delegate
      to services.mjs. Same binary, two topologies.
  (b) Defer compose orchestrator entirely; treat compose as
      a "bring up the stack" tool, keep using the existing
      start-indexers.mjs + tests/ in native mode for actual
      orchestration work.

- **Why current command is `tail -f /dev/null`**: even with
  all stub bugs fixed, the orchestrator container needs SOME
  command. A no-op long-running placeholder lets the service
  start cleanly in the compose stack but does nothing useful.
  Replaced once 4d-scenarios builds invariants.mjs.

- **CHECKLIST: slice 4d expanded into 3 sub-slices**:
  4d-prep (DONE this iteration), 4d-scenarios (build
  invariants.mjs + scenario-runner; decide path a vs b),
  4d-activate (atomic uncomment after 4d-scenarios lands).

- **Validation**: `docker compose config --quiet` succeeds;
  `--services` still returns 7 (orchestrator block remains a
  YAML comment, no runtime delta). Top-level
  `orchestrator-node-modules` volume declared eagerly so
  4d-activate stays atomic.

- Slice 4 progress: ~62% done (9 of ~14+ sub-slices total —
  slice 4d now decomposes into 3). Next bot-doable: slice
  4d-scenarios (build the missing assertion library —
  meaningful new code, not just compose wiring) OR slice 4e
  (which is essentially the acceptance gate, blocked on
  4b-verify + 4c-verify + 4d-activate all being done).

Phase 7 slice 4d-scenarios summary (this iteration on the api side):

- **The first meaningful new code in slice 4** — not just
  compose wiring or stub fixes. The orchestrator's missing
  brain (`invariants.mjs` + `scenario-runner.mjs`) ships
  in scaffold form, with 2 starter invariants + a 6-test
  smoke suite that runs entirely offline.

- **Path picked: (a) — `HARNESS_COMPOSE=1`-gated unified
  runner**. Same binary works in both topology modes; the
  env flag selects the behavior. Compose mode hits already-
  running endpoints; native mode (not yet implemented here)
  will eventually delegate to `scripts/start-fork.mjs` +
  `scripts/start-indexers.mjs` via `services.mjs`. ADR-002's
  "wrapper service that delegates" leg.

- **What landed**:
  * `auto-qa/harness/orchestrator/invariants.mjs` (NEW) —
    the assertion library. Exports `INVARIANTS` array of
    `{ name, description, layer, check }` records and
    `runAllInvariants(ctx)` aggregator. Each `check(ctx)`
    is an async predicate that resolves with detail or
    throws. The aggregator runs all of them sequentially
    without short-circuiting (so a single broken layer
    doesn't hide downstream failures). Two starter
    invariants:
    - `apiHealth` (single-layer) — api `/health` returns
      HTTP 200
    - `apiCanReachRegistry` (api↔registry cross-layer) —
      api `/registry/graphql` proxies the `__typename`
      probe to the registry checkpoint and returns
      `{data: {__typename: "Query"}}`
  * `auto-qa/harness/orchestrator/scenario-runner.mjs`
    (NEW) — CLI entry point. Reads service URLs from env
    (`API_URL`, `REGISTRY_URL`, `CANDLES_URL`, `RPC_URL`),
    gates on `HARNESS_COMPOSE=1` (exits 2 with guidance
    pointing at start-indexers.mjs + tests/ in native
    mode), supports `HARNESS_DRY_RUN=1` for offline
    catalog dump. Exits 0 on all-pass, 1 on any-fail.
  * `auto-qa/harness/tests/smoke-scenario-runner.test.mjs`
    (NEW) — 6 tests. Brings up an in-process node:http
    fixture mimicking the api's `/health` + `/registry/graphql`
    response shapes, then exercises:
    - INVARIANTS array shape (typecheck-style assertion)
    - happy path: both invariants pass
    - failure path 1: api /health is 503 → apiHealth fails,
      apiCanReachRegistry STILL RUNS (no short-circuit)
    - failure path 2: registry typename wrong →
      apiCanReachRegistry fails with descriptive error
    - CLI dry-run exits 0 with catalog visible in stdout
    - CLI native mode exits 2 with clear error message
  * `auto-qa/harness/package.json` — 3 new scripts:
    `scenarios:dry` (dry-run; no network), `scenarios:run`
    (real run; needs compose stack up), `smoke:scenarios`
    (the smoke test).

- **What's deliberately deferred**:
  * Native mode in scenario-runner. Compose mode first
    because that's the slice 4 acceptance gate; native
    mode is a follow-up slice (4d-native or similar).
  * The other 5+ invariants per PROGRESS.md's invariant
    tables (apiCanReachCandles, rateSanity,
    probabilityBounds, candlesAggregation, chartShape,
    conservation). Each is a small additive slice on the
    now-stable INVARIANTS array — slice 4d-scenarios-more
    (or per-invariant micro-slices).

- **Validation**:
  * `npm run smoke:scenarios` → 6/6 pass (155ms total)
  * `npm run scenarios:dry` → exits 0; prints invariant
    catalog
  * Native-mode rejection prints clear pointer + exits 2
  * No new lint/typecheck issues (one stub-related TS
    warning was fixed in the same iteration)
  * `docker compose config --quiet` still passes
    (orchestrator service block still commented; runner
    is just code)

- **What this enables**:
  * Slice 4d-activate: replace the placeholder `tail -f
    /dev/null` command in the orchestrator compose block
    with `npm run scenarios:run`. Atomic uncomment now
    that the runner exists.
  * Future iterations can ADD invariants to the array
    without touching scenario-runner.mjs — clean separation
    between the assertion library (data) and the runner
    (control flow).

- Slice 4 progress: ~67% done (10 of ~15+ sub-slices total
  — slice 4d-scenarios decomposes further into per-invariant
  sub-slices over time). Next bot-doable: slice 4d-activate
  (atomic uncomment + replace placeholder command) OR slice
  4d-scenarios-more (add the next invariant — probably
  apiCanReachCandles, mirroring the registry pattern).

Phase 7 slice 4d-activate summary (this iteration on the api side):

- The orchestrator block in docker-compose.yml is now
  UNCOMMENTED. The placeholder `tail -f /dev/null` (kept
  through 4d-prep so the service could exist structurally
  before the runner did) is replaced with the real entry
  point: `node orchestrator/scenario-runner.mjs`.

- **`docker compose config --services` returns 8** — the
  full stack is now structurally complete:
    anvil, api, registry-checkpoint, registry-postgres,
    checkpoint, postgres, interface-dev, orchestrator.

- **Lifecycle behavior**: orchestrator is one-shot. Container
  starts → runs every invariant from `INVARIANTS` array
  sequentially → exits 0 (all-pass) or 1 (any-fail). Other
  services (anvil, api, indexers, interface-dev) keep
  running so you can re-run the orchestrator with
  `docker compose run --rm orchestrator` without bringing
  the stack down. This matches the eventual CI workflow
  (workflow checks orchestrator's exit code).

- **What was simplified vs slice 4d-prep**: the prep slice
  staged a conditional `npm install` in the command (same
  pattern as interface-dev). That turned out to be
  unnecessary — the harness package.json has zero runtime
  deps, and `scenario-runner.mjs` only uses Node 22 builtins
  (fetch, AbortController, http). Replaced the multi-line
  `sh -c` with a clean `["node", "orchestrator/scenario-runner.mjs"]`.
  The `orchestrator-node-modules` named volume is kept
  (currently empty) for future invariants that need viem /
  etc — they can install into it on first run.

- **Merged config verified**:
  * depends_on: anvil (service_healthy) + api/registry-
    checkpoint/checkpoint (service_started)
  * environment: RPC_URL=http://anvil:8545,
    API_URL=http://api:3031,
    REGISTRY_URL=http://registry-checkpoint:3000/graphql,
    CANDLES_URL=http://checkpoint:3000/graphql,
    FUTARCHY_MODE=checkpoint, HARNESS_COMPOSE=1
  * command: ["node", "orchestrator/scenario-runner.mjs"]
  * working_dir: /app, mounted from `.` (the harness dir)
  * single-homed on harness-net (the indexers + api are on
    harness-net via 4b-network-wire's dual-homing, so
    orchestrator can reach all of them)

- **What's left for slice 4 acceptance gate (4e)**:
  * 4b-verify (Docker daemon required, mostly human): bring
    up anvil + indexers, probe registry GraphQL works
  * 4c-verify (Docker daemon, human): bring up interface-dev,
    curl http://localhost:3010 serves the futarchy app
  * 4d-verify (NEW — Docker daemon): bring up the full
    stack with `docker compose up`, watch the orchestrator
    container's exit code. With the current 2 invariants
    (apiHealth + apiCanReachRegistry) plus a healthy stack,
    expected exit code is 0.
  * 4e (acceptance gate): single `docker compose up -d`
    works on a fresh checkout. Trivial after 4b/4c/4d-verify.

- Slice 4 progress: ~73% done (11 of ~15+ sub-slices). All
  bot-doable structural work in slice 4 is now complete
  except for slice 4d-scenarios-more (incremental: add more
  invariants). The remaining sub-slices (4b/4c/4d-verify +
  4e) all need the Docker daemon and are mostly human work.

Phase 7 slice 4d-scenarios-more (apiCanReachCandles) summary (this iteration on the api side):

- One new invariant added to the `INVARIANTS` array:
  `apiCanReachCandles` (api↔candles cross-layer). Mirrors the
  registry-probe pattern: POST `__typename` query to
  `/candles/graphql`, assert `data.__typename === 'Query'`.
  Trace: api `/candles/graphql` handler → proxyCandlesQuery
  → candles-adapter → upstream Checkpoint indexer → response
  flows back. The bare `__typename` query doesn't trigger
  any of the adapter's schema-translation branches (those
  only kick in for Pool/Candle queries), so it flows
  through cleanly.

- **Demonstrates the additive pattern**: the assertion
  library's clean separation (data: INVARIANTS; control flow:
  scenario-runner) means new invariants are pure-additive
  edits to the array. Zero changes to scenario-runner.mjs.
  Each new invariant ships with smoke-test coverage:
  expand the in-process node:http fixture, add 1-2 test
  cases for happy + failure paths.

- **What landed**:
  * `auto-qa/harness/orchestrator/invariants.mjs` — added
    `apiCanReachCandles` after `apiCanReachRegistry` (kept
    same shape; consistent ordering).
  * `auto-qa/harness/tests/smoke-scenario-runner.test.mjs` —
    fixture extended with `/candles/graphql` route +
    `candlesTypename` option; new test
    `runAllInvariants — failure: candles typename wrong`
    confirms candles failure doesn't short-circuit other
    invariants; CLI dry-run test extended to assert all 3
    invariants appear in stdout.

- **Validation**:
  * `npm run smoke:scenarios` → 7/7 pass (147ms)
  * `npm run scenarios:dry` → exits 0; lists 3 invariants
    in catalog
  * No existing smoke tests broken
  * `docker compose config --quiet` still passes; service
    list unchanged (8 services — orchestrator wiring lives
    inside the runner code, not in compose env)

- Slice 4 progress: ~75% done (12 of ~16+ sub-slices total).
  Slice 4d-scenarios-more keeps absorbing new invariants
  one at a time. Next bot-doable: another invariant from
  PROGRESS.md's tables (rateSanity is meaty — needs RPC
  access + raw eth_call/ABI; probabilityBounds needs a real
  pool to query). Or: skip to the simpler `registryDirect`
  / `candlesDirect` invariants that probe the indexers
  WITHOUT going through the api (assert the indexers are
  individually reachable from the orchestrator container,
  which validates the network bridging from slice
  4b-network-wire is correct).

Phase 7 slice 4d-scenarios-more (registryDirect + candlesDirect) summary (this iteration on the api side):

- **Two new invariants in one iteration** — both small,
  symmetrical, naturally paired:
  * `registryDirect` (orchestrator↔registry layer) — POST
    `__typename` to `ctx.registryUrl` directly, bypasses
    api passthrough entirely
  * `candlesDirect` (orchestrator↔candles layer) — same
    pattern against `ctx.candlesUrl`

- **Why these matter as a pair with the api-passthrough
  invariants**: if api↔registry passes but registryDirect
  fails (or vice versa), it's a useful debug signal — the
  api is reaching the indexer by some route the
  orchestrator can't (e.g., DNS cache, connection pool,
  cached response). The compose stack expects both routes
  to work; divergence is a regression.

- **Validates slice 4b-network-wire end-to-end** (or will,
  once the daemon-required smoke is human-run): the
  orchestrator container is single-homed on harness-net,
  but the indexers are dual-homed (registry-net +
  harness-net via the per-service `extends:` blocks).
  These two invariants are the first that EXERCISE the
  bridging — apiHealth + apiCanReachRegistry/Candles only
  test api-internal paths (api is also single-homed on
  harness-net; api↔indexer goes service-name → bridge).

- **What landed**:
  * `auto-qa/harness/orchestrator/invariants.mjs` — added
    `registryDirect` + `candlesDirect` after
    `apiCanReachCandles`. Both follow the now-stable
    invariant shape; both use `ctx.registryUrl` /
    `ctx.candlesUrl` directly (no derived path
    construction).
  * `auto-qa/harness/tests/smoke-scenario-runner.test.mjs`
    — fixture extended with `/registry-direct/graphql` +
    `/candles-direct/graphql` paths (distinguished from
    the api-passthrough versions to test them
    independently); new `fullCtx(fxUrl)` helper bundles
    the URLs cleanly; existing happy-path test renamed
    from "both invariants pass" to "all invariants pass"
    (5 of them now); two new failure-path tests verify
    direct-probe failures don't short-circuit the
    api-passthrough ones (and vice versa); CLI dry-run
    test extended to assert all 5 invariants appear in
    stdout.

- **Validation**:
  * `npm run smoke:scenarios` → 9/9 pass (167ms)
  * `npm run scenarios:dry` → exits 0; lists all 5
    invariants in catalog (3 api-passthrough + 2 direct)
  * `docker compose config --quiet` still passes;
    8-service list unchanged

- Slice 4 progress: ~80% done (13 of ~16+ sub-slices total
  — slice 4d-scenarios-more is roughly half-way through
  the planned per-invariant additions).

Phase 7 slice 4d-scenarios-more (rateSanity) summary (this iteration on the api side):

- **First chain-layer invariant**: `rateSanity`
  (orchestrator↔chain). Up to now all 5 invariants probed
  HTTP layers (api or indexer GraphQL); this one issues a
  raw JSON-RPC `eth_call` to the sDAI contract on Gnosis
  and asserts the result is sane.

- **What it does**:
  * `eth_call` to `0x89C80A4540A00b5270347E02e2E144c71da2EceD`
    (sDAI on Gnosis chain 100) with selector `0x679aefce`
    (`getRate()`)
  * Parses uint256 result via `BigInt(result)`
  * Asserts `rateBigInt >= 10n ** 18n` (rate ≥ 1.0 in real
    terms; sDAI rate should grow over time as savings accrue,
    so 1.0 is the floor)
  * Reports rate as decimal in pass message, raw hex in
    fail message

- **Why these specific values**: sDAI is an ERC-4626 yield
  token; its `getRate()` returns the current asset/share
  exchange rate. At launch it was 1.0; over time it grows
  (compound interest). A rate < 1 implies the contract is
  broken, the fork is corrupt, or someone's reading a wrong
  contract's state. Source: `src/services/rate-provider.js`
  has the same address + selector + parse pattern (the
  invariant is essentially that file's check, lifted into
  the harness).

- **What was added to invariants.mjs**:
  * Constants: `SDAI_GNOSIS_ADDRESS`, `GET_RATE_SELECTOR`,
    `ONE_E18` (BigInt literal 10n ** 18n)
  * Helper: `ethCall(rpcUrl, to, data, timeoutMs)` — does
    one POST with the standard JSON-RPC envelope, throws on
    HTTP error or RPC error
  * The invariant itself (orchestrator↔chain layer)

- **Future enhancement**: monotonicity check across calls.
  The orchestrator is currently one-shot, so monotonicity
  within a single run is trivially "≥ 1 sample". Cross-run
  monotonicity needs persistent state (file in a volume?
  indexer query?) — out of scope for this slice; pinned in
  the invariant body comment.

- **Smoke test coverage** — 3 new tests:
  * happy at 1.2 sDAI rate (default fixture value)
  * failure: rate < 1.0 (fixture set to 0.5e18)
  * failure: RPC error response (fixture set to return
    `{error: ...}` instead of `{result}`)
  * Plus the fixture extended with `/rpc` POST handler that
    serves JSON-RPC eth_call responses; `fullCtx(fxUrl)`
    helper updated to set `rpcUrl` to `${fxUrl}/rpc`

- **Validation**:
  * `npm run smoke:scenarios` → 12/12 pass (171ms — was
    9/9 before)
  * `npm run scenarios:dry` → exits 0; lists 6 invariants
    in catalog
  * `docker compose config --quiet` still passes;
    8-service list unchanged

- Slice 4 progress: ~83% done (14 of ~17 sub-slices total).
  Next bot-doable: another invariant — probabilityBounds
  (price ∈ [0, 1] for PREDICTION pools — needs a real pool
  query; can use the candles GraphQL or the api's
  /api/v1/spot-candles endpoint), candlesAggregation, or
  chartShape. Or revisit conservation (∑YES + ∑NO = ∑sDAI)
  — most architecturally interesting but needs multiple
  contract calls.

Phase 7 slice 4d-scenarios-more (anvilBlockNumber + anvilChainId) summary (this iteration on the api side):

- **Two new chain-process probes**: complement `rateSanity`
  (which validates contract STATE) with chain-PROCESS health
  checks. Naturally paired:
  * `anvilBlockNumber` — `eth_blockNumber` returns a positive
    block number (chain has state, fork loaded a real
    starting point)
  * `anvilChainId` — `eth_chainId` returns `0x64` (chain
    100 = Gnosis; catches "fork wrong chain" + "running bare
    anvil at default 31337")

- **Why split into 3 chain-layer invariants**: separation of
  concerns lets failures point at the right layer.
  - anvilBlockNumber fails → anvil isn't producing blocks /
    fork didn't load
  - anvilChainId fails → forking the wrong chain (or no
    fork at all)
  - rateSanity fails → chain is alive but contract state
    isn't what we expect
  Each failure mode is a different kind of bug; bundling them
  would obscure which one fired.

- **Refactor of the JSON-RPC mock**: the smoke fixture's
  `/rpc` handler used to return rate-shaped responses for
  ANY method. Now it parses the request body, branches on
  `method`, and returns method-appropriate responses
  (`eth_call` → rate hex, `eth_blockNumber` → blockNumberHex,
  `eth_chainId` → chainIdHex, default → method-not-mocked
  RPC error). Plus a JSON parse-error fallback for
  malformed bodies. Two new fixture options:
  `blockNumberHex` (default `0x123abc`), `chainIdHex`
  (default `0x64`).

- **Refactor of `invariants.mjs`**: introduced
  `rpcRequest(rpcUrl, method, params, timeoutMs)` as the
  generic JSON-RPC helper. `ethCall(...)` now delegates to
  `rpcRequest(..., 'eth_call', ...)`. Both `anvilBlockNumber`
  and `anvilChainId` use `rpcRequest` directly with method
  name + empty params.

- **Smoke test coverage** — 4 new tests:
  * anvilBlockNumber happy at 0x123abc (default)
  * failure: anvilBlockNumber at 0x0
  * anvilChainId happy at Gnosis (0x64)
  * failure: anvilChainId at bare anvil 0x7a69 (= 31337)

- **Validation**:
  * `npm run smoke:scenarios` → 16/16 pass (199ms — was
    12/12)
  * `npm run scenarios:dry` → exits 0; lists 8 invariants
    in catalog
  * `docker compose config --quiet` still passes;
    8-service list unchanged

- Slice 4 progress: ~88% done (15 of ~17 sub-slices total).
  4d-scenarios-more is now well past half-way through the
  planned per-invariant additions. Remaining bot-doable
  invariants (probabilityBounds, candlesAggregation,
  chartShape, conservation) all need either real pool data
  or multiple contract calls — meatier than the simple
  GraphQL/RPC probes shipped so far.

Slice 4c v3b summary (previous iteration on the interface side):

- Built directly on v3a's plumbing. Same two-endpoint mock
  setup, but candles now returns a known YES price (0.42), and
  the test asserts the formatter's exact output string
  ("0.4200 SDAI") appears in the visible DOM.
- Path traced (registry → candles → carousel → card → formatter
  → DOM):
  EventsHighlightCarousel → fetchEventHighlightData →
  fetchProposalsFromAggregator (REGISTRY) → events with
  poolAddresses → collectAndFetchPoolPrices (CANDLES) →
  attachPrefetchedPrices → carousel renders
  <EventHighlightCard prefetchedPrices=…/> →
  useLatestPoolPrices short-circuits to prefetched →
  ${prices.yes.toFixed(precision)} ${baseTokenSymbol} →
  precision=4 (YES<1) + baseTokenSymbol='SDAI' (default) →
  "0.4200 SDAI"
- Test passed first try. Runtime: 1.3s parallel, 3.8s solo;
  full 6-test suite 22.6s.
- Bug-shapes caught: stale-price-but-API-healthy (PR #64
  shape), formatter precision regressions, baseTokenSymbol
  fallback regressions.

Slice 4c v3a summary (previous iteration on the interface side):

- Splits the original 4c v3 ambition into two iterations: v3a
  proves the network reaches the candles endpoint with the right
  inputs; v3b (next) asserts the formatted DOM string. Plumbing-
  first because the candles pipeline involves a SECOND fetcher
  path (`fetchProposalsFromAggregator` from
  useAggregatorProposals.js, not useAggregatorCompanies — they
  query the same registry endpoint with different field
  selections, then the carousel side calls
  collectAndFetchPoolPrices which is the new bit).
- New fixtures: CANDLES_GRAPHQL_URL constant; PROBE_POOL_YES /
  PROBE_POOL_NO / PROBE_PROPOSAL_ADDRESS distinctive addresses;
  `fakePoolBearingProposal({...})` builds a proposal in the
  carousel-side shape with conditional_pools metadata;
  `makeCandlesMockHandler({prices, onCall})` parses the bulk
  fetcher's `pools(where: id_in: [...])` query and returns only
  the pools the test seeded.
- Test asserts the candles endpoint receives at least one POST
  whose query mentions PROBE_POOL_YES — proves the carousel
  pipeline routes our mocked proposal's metadata through to the
  bulk price fetcher.
- 1 test, 1.7s; full dom-api-invariant suite: 24.4s. UI smoke:
  25 pass + 0 skip.
- Deliberately deferred to v3b: the DOM-level price assertion.
  The carousel might render a card variant that doesn't display
  the YES price for our placeholder-address proposal; v3b will
  trace which card path renders and assert the formatter output.

Slice 4c v2 summary (previous iteration on the interface side):

- Same `flows/dom-api-invariant.spec.mjs`, fourth test added.
  Mock `metadata.chain = '999'` → flows through parseInt →
  CHAIN_CONFIG[999] is undefined → fallback `{shortName:
  \`Chain ${chainId}\`}` → row's chain cell shows "Chain 999".
- Different formatter class than 4c v1: template-literal
  interpolation branch (the dynamic-string fallback) vs the
  lookup-table branch. A regression that drops the fallback
  case (e.g., crashes on missing key) would surface here.
- Why "currency formatting" was staged as 4c v3 rather than
  shipped as v2: real currency formatters live in
  HighlightCards / EventHighlightCard, fed by
  collectAndFetchPoolPrices which hits a different endpoint
  (api.futarchy.fi/candles/graphql). Mocking that needs both
  endpoints + valid pool references; larger lift, dedicated
  iteration.
- 1 test, 1.4s. UI smoke: 24 pass + 0 skip.

Slice 4c v1 summary (previous iteration on the interface side):

- Same `flows/dom-api-invariant.spec.mjs`, third test added.
  Mock `organizations[0].metadata = JSON.stringify({chain: '10'})`
  → flows through `parseMetadata` → `parseInt('10', 10) = 10`
  → `ChainBadge.CHAIN_CONFIG[10].shortName === 'Optimism'`,
  asserted in the row's chain cell (`td.nth(4)`).
- Different formatter class than 4a (string passthrough) and
  4b (integer toString through filter logic): 4c v1 covers
  int → enum lookup with a fallback case.
- Refactor: extended `makeGraphqlMockHandler` to accept
  `orgMetadata` (defaults to `null` so existing tests are
  unaffected).
- Bug-shapes this catches: any link in
  parseMetadata → parseInt → CHAIN_CONFIG → ChainBadge that
  breaks would shift the rendered text away from "Optimism".
  E.g. CHAIN_CONFIG[10].shortName silently renamed to "Op", or
  parseInt logic dropped (would default to 100 → "Gnosis").
- 1 test, 1.4s. UI smoke: 23 pass + 0 skip.

Slice 4b summary (previous iteration on the interface side):

- Same `flows/dom-api-invariant.spec.mjs`, second test added.
  Mock 8 + 3 = 11 proposals (the 3 with
  `metadata.visibility: 'hidden'`); assert the OrgRow's Active
  cell shows "8" and the Total cell shows "11". Verifies that
  the visibility filter in `transformOrgToCard` (drops archived
  from both, drops hidden from active) maps the GraphQL payload
  to the rendered counts correctly.
- Refactor: `makeGraphqlMockHandler` now takes a `proposals`
  parameter so multiple tests share the same dispatch logic
  with different stubbed payloads. New `fakeProposal(idSuffix,
  metadataExtra)` helper builds a stub row in the shape
  useAggregatorCompanies expects.
- Bug-shape this catches: a regression in the visibility filter
  (e.g. flipping `!hidden` predicate, or counting resolved
  proposals as active) would make the active cell show "11"
  instead of "8". A `parseMetadata` regression would zero both
  cells.
- 1 test, 2.3s. UI-side smoke: 22 pass + 0 skip.

Slice 4 v1 / 4a summary (previous iteration on the interface side):

- New file `flows/dom-api-invariant.spec.mjs`. The canonical
  Phase 5 invariant **mechanism** is now wired: mock the
  futarchy app's GraphQL POSTs to
  `api.futarchy.fi/registry/graphql`, dispatch on operation
  name (aggregator / organizations / proposalentities), return
  controlled response, assert the value reaches the DOM.
- v1 deliberately scopes down to a non-numeric value (an org
  name, "HARNESS-PROBE-ORG-001") so the mechanism lands cleanly
  before chasing formatter quirks. Numeric-price assertions
  follow in 4b.
- Bonus discovery: the probe value rendered in BOTH the
  CompaniesListCarousel card AND the OrganizationsTable row,
  so the test asserts `count >= 1` to catch any future
  regression that drops one of the rendering paths.
- 1 test, 3.3s; wall-clock with warm dev server: 12.6s. UI-side
  smoke: 21 pass + 0 skip.

Slice 3b summary (previous iteration on the interface side):

- New test in `flows/app-discovery.spec.mjs`:
    1. Install wallet stub (no signing tunnel — modal-listing
       doesn't need signing)
    2. Navigate to `/companies` (Header runs in `app` config
       there; `/` is landing-only with just "Launch App")
    3. Click the "Connect Wallet" button (text-based locator;
       `.first()` because Header renders both desktop + mobile)
    4. Assert "Futarchy Harness Wallet" appears in the
       RainbowKit modal — proves the EIP-6963 announce reaches
       RainbowKit's discovery against the REAL app, not just
       a synthetic listener as in slice 1's EIP-6963 test
- Test passed first try; both 3a + 3b run in 14.3s wall-clock
  on a warm dev server (3.4s for 3b alone).
- Stretch deferred: clicking the wallet to actually connect.
  Skipped because post-click selectors are RainbowKit-version-
  sensitive; revisit during Phase 6 scenario work.

Slice 3a summary (previous iteration on the interface side):

Slice 2 summary (previous iteration on the interface side):

- In-page SIGNING_METHODS now route through a Playwright
  `exposeBinding` named `__harnessSign`, wired by
  `setupSigningTunnel(context, {privateKey, rpcUrl, chainId})`.
  Reuses viem's `signMessage` / `signTypedData` /
  `sendTransaction` in node — privateKey never enters the page.
  Chosen over the original "inline @noble/secp256k1" plan because
  the tunnel is ~30 lines vs ~30 KB of crypto/EIP-712/EIP-1559 code
  bundled as an addInitScript blob.
- `flows/wallet-signing.spec.mjs` — 3 browser tests, all green:
  `personal_sign` + recover, `eth_signTypedData_v4` + recover,
  `eth_sendTransaction` against live anvil with receipt + balance
  assertions (skips when anvil missing).
- Slice-1 fallback preserved: when `setupSigningTunnel` is not
  called, in-page stub still rejects SIGNING_METHODS with -32601.
