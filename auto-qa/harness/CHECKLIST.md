# Forked Replay Harness — Phase Readiness Checklist

A working ledger of "are we actually done with phase N" gates. Each
phase needs ALL items checked before declaring it complete and starting
the next. Mirrored across both repos; check items off in this file in
whichever repo first satisfies them.

## Phase 0 — Scaffold

**Goal:** make the harness layout reviewable and the cross-repo split
agreed-upon, without installing heavy deps or running real services.

- [x] `auto-qa/harness/` directory created in both repos
- [x] `PROGRESS.md` mirrored across both repos with status snapshot,
      effort breakdown, phasing, invariant catalogue
- [x] `README.md` per repo explaining what lives where
- [x] `package.json` per harness with stub scripts that exit 1 with
      "TODO Phase N" message on misuse
- [x] `.gitignore` per harness covering anvil state, indexer data,
      Playwright artifacts, browser binaries, run artifacts
- [x] Root `package.json` of each repo wires `npm run auto-qa:e2e` to
      `npm --prefix auto-qa/harness run phase-status`
- [x] `docker-compose.yml` skeleton committed (server side); `docker
      compose config` validates cleanly with no warnings
- [x] `scripts/start-fork.mjs` committed (server side) with
      argument parser + help text + documented exit codes
- [x] `playwright.config.mjs` skeleton committed (UI side) — does NOT
      import `@playwright/test` yet
- [x] `fixtures/wallet-stub.mjs` committed (UI side) with the
      EIP-1193 method/event surface enumerated
- [x] `ARCHITECTURE.md` shared spec mirrored across both repos
      (`diff` reports identical)
- [x] `docs/ADR-001-foundry-vs-hardhat.md` committed (server side),
      status: Proposed
- [x] `docs/ADR-001-synpress-vs-custom-stub.md` committed (UI side),
      status: Proposed
- [x] `package-lock.json` generated in both `auto-qa/harness/`
      directories (reproducible installs)
- [ ] Both ADRs reviewed by a human and status changed from
      "Proposed" to "Accepted"
- [ ] Sister-link verified: a fresh checkout of both repos in
      `~/code/futarchy-fi/` runs `docker compose config` cleanly

**When all items above are checked → Phase 0 is complete.**

## Phase 1 — Anvil fork + block clock

**Goal:** deterministic time control over a forked Gnosis chain.

- [x] `anvil` binary discoverable on PATH (via `scripts/detect-anvil.mjs`;
      install hint emitted if missing)
- [x] `scripts/start-fork.mjs` actually launches anvil + waits for
      readiness (JSON-RPC `eth_blockNumber` polling, 30s timeout, emits
      `READY <port>` on stdout)
- [x] `scripts/block-clock.mjs` exposes `mineBlock`, `setNextTimestamp`,
      `increaseTime`, `snapshot`, `revert`, `setBalance`,
      `impersonateAccount`, `stopImpersonating`, plus `blockNumber`,
      `chainId`, `getBalance` query helpers
- [x] `docker compose -f auto-qa/harness/docker-compose.yml up -d`
      brings the anvil service up (no longer just placeholder).
      Compose config validates clean; anvil service block is real
      (`ghcr.io/foundry-rs/foundry:latest`, port 8545, healthcheck
      via `cast block-number`). Test in `tests/smoke-compose.test.mjs`
      drives `up -d` → wait healthy → block-clock smoke → `down -v`,
      and SKIPS cleanly when the docker daemon isn't reachable. Live
      runtime validation pending Docker Desktop start.
- [x] Smoke test: fork at a recent Gnosis block, mine 10 blocks, query
      `eth_blockNumber` and confirm = N+10
      (`tests/smoke-fork.test.mjs`, runs in ~3s, validated 2026-05-10)
- [x] Smoke test: snapshot → mine 5 blocks → revert → confirm at N
      (same test file, same run)

## Phase 2 — Chain ↔ api agreement (1 invariant)

**Goal:** first cross-layer assertion working end-to-end.

**Reframed during Phase 2 slice 1:** the api consumes a Checkpoint
indexer GraphQL endpoint (not RPC directly), so a literal
`anvil.blockNumber === api.somethingBlock` comparison defers to
Phase 3 when the local indexer joins. Phase 2's foundational
deliverable is **dual-source liveness** — orchestrator can drive
both layers in parallel and probe each via its native protocol.

- [x] Local futarchy-api launchable from the orchestrator
      (`startLocalApi` in `orchestrator/services.mjs`; spawns
      `node src/index.js` from repo root, awaits `/health` 200)
- [x] Orchestrator can hit BOTH the api endpoint AND anvil directly
      and compare values (api `/health` + `/warmer`; anvil
      `eth_chainId` + `eth_blockNumber` — see
      `tests/smoke-api-health.test.mjs`)
- [ ] First **literal** cross-layer block invariant
      `chainBlockNumber === indexerHead` — defers to Phase 3.
      Placeholder logged in `smoke-api-health.test.mjs` so the
      Phase 3 wiring point is obvious.

**Phase 2 BONUS items (added during slices 2+4, not in the original goal):**

- [x] Stub-indexer harness (`orchestrator/stub-indexer.mjs`) — pluggable
      in-process Express stub for testing the api's passthrough layer
      without a real indexer. Records call history; supports hot-swap
      responder.
- [x] Real cross-layer round-trip via passthrough — orchestrator →
      api `/registry/graphql` → stub-indexer → response, with body
      and status forwarded verbatim. Three cases pinned: 200
      passthrough, 500 propagation, 502 envelope on unreachable.
- [x] Multi-spawn robustness — 3 successive anvil+api cycles confirm
      no port leaks (each cycle's ports are REFUSED after `stop()`)
      and no orphaned processes.

## Phase 3 — Local Checkpoint indexer in-loop

**Goal:** indexer reconciles with chain after each block.

- [x] Decision made: build-from-source via the existing
      `futarchy-fi/futarchy-indexers` repo, sibling-clone next to
      `interface/`. See `docs/ADR-002-indexer-bootstrap.md`. The
      `stub-indexer` from Phase 2 is retained for fast unit-style
      cross-layer tests.
- [x] Indexer launchable from harness — implemented as `scripts/start-indexers.mjs`
      driving the existing `futarchy-indexers` composes as SEPARATE
      compose projects (`futarchy-harness-registry` +
      `futarchy-harness-candles`). Each has its own postgres + network.
      Reasoning: extends/include couldn't cleanly carry the postgres
      dependency without modifying the upstream composes; running them
      as independent projects keeps the indexer composes untouched
      while the orchestrator coordinates lifecycle. Indexers reach the
      native anvil via `host.docker.internal:<port>` (Mac/Windows) or
      `ANVIL_HOST_URL` override (Linux). Validated via 5 contract
      tests in `smoke-start-indexers.test.mjs` (skip branches for
      daemon-up). Live runtime validation pending Docker Desktop start.
- [ ] Schema migration cold-start time documented (this is the
      brittleness risk per PROGRESS.md)
- [x] Smoke test: indexer follows anvil's block height (foundational
      invariant — proves the chain↔indexer pipeline). Implemented
      in `tests/smoke-indexer-roundtrip.test.mjs`. Uses
      `bootstrapAfterStart` (UPDATE `_metadatas.last_indexed_block` →
      restart indexer) to skip the indexer past anvil's fork height,
      then mines 5 blocks on anvil and asserts the indexer follows
      within `HARNESS_INDEXER_SYNC_MS` (default 60s). Per-event
      assertions (Swap-specific, Proposal-specific) deferred to
      post-Phase-3 work that needs mock contracts deployed on anvil.
      Skips cleanly when daemon down.
- [x] **Spike resolved** — `START_BLOCK` env support: NO env, but
      `_metadatas.last_indexed_block` postgres row IS the bootstrap
      point (see `docs/spike-001-checkpoint-anvil-compat.md`).
      Pre-seed that row after `RESET=true` to skip from genesis to
      anvil's fork-block.
- [x] **Spike resolved** — anvil RPC compatibility: COMPLETE.
      Checkpoint only calls `eth_chainId`, `eth_blockNumber`,
      `eth_getBlockByNumber`, `eth_getLogs` — all standard, all
      supported by anvil. No blockers for build-from-source.

## Phase 4 — Synthetic wallet + first scripted swap

**Goal:** real on-chain mutation, full chain↔indexer↔api check.

- [x] `eth_subscribe` shim spike completed —
      `interface/auto-qa/harness/docs/spike-002-eth-subscribe-shim.md`.
      Decision: **reject with -32601** (mirrors anvil's actual HTTP
      behavior; viem/Wagmi watchers already poll over HTTP transports;
      `useWaitForTransactionReceipt` hard-codes `poll: true`). No
      shim infrastructure needed. Already implemented in
      `fixtures/wallet-stub.mjs::SUBSCRIPTION_METHODS`.
- [x] `installWalletStub` complete (in-process core in Phase 4,
      browser-injection wrapper in Phase 5 slice 1). The in-process
      `createProvider` is verified by 8-case node:test in
      `tests/smoke-wallet-stub.test.mjs` (5s runtime). The
      browser-injection wrapper returns self-executing JS source
      for Playwright `addInitScript`, validated by 6-case
      `flows/wallet-injection.spec.mjs` (2.4s, all green).
- [x] `nStubWallets(N)` derives canonical anvil dev addresses from
      the foundry mnemonic (verified: 0xf39F…, 0x7099…, 0x3C44…).
      Returns `{address, privateKey}` per account; rejects n<1.
- [/] First scripted swap PARTIAL: tx submit/sign/mine flow works
      (receipt status 0x1, sender debited correctly including gas),
      but cross-layer indexer↔api reconciliation pending Phase 3's
      indexer up + Docker Desktop.

**Phase 4 BONUS items (slice 2 — contract-call surface):**

- [x] `scripts/contracts.mjs` — viem-based helpers: `readContract`,
      `writeContract`, `getReceipt`, `parseEventLogs`, `publicClient`.
      ABI fragments for ERC20, WXDAI (WETH9 pattern), RATE_PROVIDER.
      Address constants for sDAI, sDAI_RATE_PROVIDER, WXDAI sourced
      from production code.
- [x] `tests/smoke-contract-calls.test.mjs` — exercises real Gnosis
      contracts on the fork: reads sDAI symbol/decimals/totalSupply
      (62.4M sDAI live state) + sDAI rate provider getRate (1.239
      live), writes WXDAI.deposit(1 ETH), parses Deposit event, and
      asserts +1 WXDAI on the wallet. Validates the full read+write+
      event-decode surface needed for Phase 6 scenarios.
- [x] **Discovery via slice 2**: WXDAI follows the WETH9 pattern —
      `deposit()` emits `Deposit(dst, wad)`, NOT ERC20 `Transfer`.
      Topic hash `0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c`
      = `keccak256("Deposit(address,uint256)")`. Pinned in WXDAI_ABI
      and the smoke test header. Production code doesn't assume
      Transfer from WXDAI (verified — no false bug surfaced).

**Phase 4 ANVIL DEV-ACCOUNT QUIRK (resolved in slice 3)**: Anvil's
"10000 ETH" auto-funding for dev addresses on a fork (0xf39F, 0x7099,
…) is a LAZY view — the underlying fork state is whatever the address
has on Gnosis (~0). On first incoming tx, the lazy 10000 ETH vanishes
and the true fork balance materializes. So sending to dev[1] reads as
recipient going from 10000 → 0, NOT 10000 → 10001. Verified in
`scripts/debug-balance-quirk.mjs` across 4 recipient kinds: dev[1]
anomalous, vanity/fresh/low addresses all correct. **Fix**: tests use
freshly-generated addresses as recipients; documented in
`tests/smoke-wallet-stub.test.mjs` header. Sender behavior is unaffected.

## Phase 5 — Playwright + DOM↔API assertions

**Goal:** frontend in the loop; UI consistency catches.

**Phase 5 slice 1 (browser-injection smoke) — DONE:**

- [x] `@playwright/test ^1.59.1` installed in
      `interface/auto-qa/harness/`
- [x] chromium browser binary provisioned (`npx playwright install
      chromium` — ~92 MiB headless shell + ffmpeg)
- [x] `playwright.config.mjs` rewritten to use real `defineConfig`
      (was a placeholder); single `chromium` project (firefox/webkit
      deferred to Phase 7); `webServer` auto-launches Next.js dev
      unless `HARNESS_NO_WEBSERVER=1` (slice 1 opts out — slice 3
      will be the first run that exercises the dev server)
- [x] Wallet stub injected via `context.addInitScript(installWalletStub({…}))`
      BEFORE page navigation — validated against `about:blank` only
      in slice 1 (no Wagmi/RainbowKit yet; that's slice 3)
- [x] `flows/wallet-injection.spec.mjs` — 6 browser tests, all green
      (2.4s):
        1. window.ethereum exposes address/chain/MetaMask flag
        2. wallet_switchEthereumChain emits chainChanged
        3. eth_subscribe rejected -32601 (per Spike-002)
        4. signing methods rejected -32601 (slice 2 will enable)
        5. EIP-6963 announcement fires (RainbowKit auto-discovery)
        6. eth_blockNumber forwards to configured RPC (intercepted
           via `context.route` — about:blank's null origin blocks
           direct fetch even with permissive CORS)
- [x] npm scripts wired: `ui` / `ui:ui` / `ui:report` in harness;
      `auto-qa:e2e:ui` and `auto-qa:e2e:ui:ui` at interface root

**Phase 5 slice 2 (signing in-page) — TODO:**

- [ ] Inline @noble/secp256k1 in the browser stub so
      `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`
      work against `window.ethereum` (currently return -32601)
- [ ] Browser test: sign a personal_sign message, verify recoverable
      address matches `eth_accounts[0]`
- [ ] Browser test: send a 1-XDAI tx via `eth_sendTransaction`,
      decode receipt, assert sender debited

**Phase 5 slice 3 (futarchy app in the loop) — TODO:**

- [ ] First test that drops `HARNESS_NO_WEBSERVER` and lets
      Playwright launch the Next.js dev server
- [ ] Confirm Wagmi/RainbowKit auto-discover the harness wallet
      via the EIP-6963 announcement and "Connect" surfaces it

**Phase 5 slice 4 (DOM↔API invariant) — TODO:**

- [ ] First DOM↔API check: navigate to a proposal page, scrape the
      visible price, compare to the api response that produced it

## Phase 6 — Scenario library

**Goal:** first "real bug shape" replayable.

- [ ] Scenario capture format decided (JSON snapshot vs full state dump)
- [ ] First scenario captured: a settled historical proposal (block
      range + tx list + expected end-state)
- [ ] Replay framework in orchestrator: feed scenario → drive harness
      → assert end-state matches

## Phase 7 — Chaos injection + nightly CI

**Goal:** production-shape resilience signal.

- [ ] Chaos library: kill indexer mid-replay, return 502 from api,
      RPC fault injection
- [ ] Single docker-compose `up -d` brings the full 5-service stack
      cleanly on a fresh checkout
- [ ] CI workflow (nightly cron): runs at least one scenario end-to-end
      with artifact capture on failure
- [ ] Per-failure artifacts: anvil state dump, indexer logs, api
      logs, Playwright trace + screenshots + video

## Acceptance gates (cross-cutting)

These don't belong to one phase but must hold throughout:

- [ ] Production code in `src/` (both repos) is NEVER modified by
      harness work
- [ ] No real mainnet RPC calls during a harness run
- [ ] Harness package.json deps are isolated from root deps (no
      pollution of the production install)
