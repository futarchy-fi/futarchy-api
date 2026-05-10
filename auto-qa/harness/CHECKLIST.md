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

**Phase 5 slice 2 (signing in-page) — DONE:**

- [x] In-page SIGNING_METHODS now route through a Playwright
      `exposeBinding` named `__harnessSign`, wired by
      `setupSigningTunnel(context, {privateKey, rpcUrl, chainId})`.
      Reuses viem's `signMessage` / `signTypedData` /
      `sendTransaction` in node — privateKey never enters the page.
      Chosen over the original "inline @noble/secp256k1" plan
      because the tunnel is ~30 lines vs ~30 KB of crypto code
      (and re-implements EIP-712 hashing + EIP-1559 serialization
      that viem already gets right).
- [x] Slice-1 fallback preserved: when `setupSigningTunnel` is not
      called, the in-page stub still rejects SIGNING_METHODS with
      -32601 (verified by the existing slice-1 test).
- [x] `flows/wallet-signing.spec.mjs` — 3 browser tests, all green:
        1. personal_sign — page signs "Hello, harness!", node uses
           `recoverMessageAddress` and asserts == wallet.address
        2. eth_signTypedData_v4 — minimal EIP-712 Greeting message,
           page signs, node uses `recoverTypedDataAddress` and
           asserts == wallet.address
        3. eth_sendTransaction (live anvil; skips when missing) —
           sign + broadcast 0.5 XDAI to a fresh recipient, await
           receipt (poll loop wraps the viem-returns-hash-before-
           auto-mine-settles race), assert status=0x1, assert
           recipient balance == 0.5 XDAI

**Phase 5 slice 3 (futarchy app in the loop) — DONE:**

- [x] First test that drops `HARNESS_NO_WEBSERVER` and lets
      Playwright launch the Next.js dev server. Lives in
      `flows/app-discovery.spec.mjs`; runs via the new
      `npm run auto-qa:e2e:ui:full` (root) /
      `npm --prefix auto-qa/harness run ui:full` (harness) script.
      Cold compile + first navigation: ~20s end-to-end. Validated
      `window.ethereum` is observable in the actual futarchy
      page context with `isMetaMask + isHarness + selectedAddress`
      all set correctly.
- [x] Bug fix discovered while exercising the webServer for the
      first time: slice 1's `playwright.config.mjs` had
      `npm --prefix ../../..` which from the harness dir resolves
      to `/Users/kas/`, NOT the interface root. Corrected to
      `../../`. webServer timeout bumped from 120s to 180s for
      cold compile.
- [x] Confirm Wagmi/RainbowKit auto-discover the harness wallet
      via the EIP-6963 announcement (slice 3b). Test: navigate
      to `/companies` (Header in `app` config; landing only shows
      "Launch App"), click the "Connect Wallet" button, assert
      "Futarchy Harness Wallet" is visible in the RainbowKit
      modal's wallet list. Validated end-to-end — the EIP-6963
      announce reaches RainbowKit's discovery and our wallet
      appears in the modal. Modal-open + wallet-list-render took
      ~3.4s; full file (slice 3a + 3b) wall-clock ~14s on a
      warm dev server.
- [ ] Stretch: click "Futarchy Harness Wallet" in the modal,
      assert successful connect (account address visible in the
      header). Deferred — requires modal selectors that may be
      RainbowKit-version-sensitive; revisit during Phase 6
      scenario work when we actually need a connected wallet
      to drive a swap.

**Phase 5 slice 4 (DOM↔API invariant) — MECHANISM PROVEN:**

- [x] First DOM↔API mechanism proof — `flows/dom-api-invariant.spec.mjs`
      intercepts the futarchy app's GraphQL POSTs to
      `https://api.futarchy.fi/registry/graphql`, dispatches on the
      embedded operation (aggregator / organizations /
      proposalentities), returns a probe org name
      "HARNESS-PROBE-ORG-001", and asserts the probe value renders
      in the DOM. The probe surfaces in TWO independent rendering
      paths (CompaniesListCarousel card + OrganizationsTable row),
      so any future regression that renames the data field will
      light up here. Test: 3.3s; wall-clock with warm dev server:
      12.6s. **The canonical Phase 5 invariant mechanism (mock API →
      assert DOM reflects it) is now wired and working.**
- [x] Sub-slice 4b — first NUMERIC value through the mock →
      DOM-cell pipeline. Mock the `proposalentities` GraphQL response
      with 8 active + 3 hidden proposals; assert the OrgRow's active
      cell shows "8" and total cell shows "11". Verifies that the
      visibility-filter logic in `transformOrgToCard` (drops
      archived from both, drops hidden from active) maps the API
      payload to the rendered counts correctly. Test: 2.3s; both
      slice 4 tests together: 15s wall-clock warm.
- [x] Sub-slice 4c v1 — first ENUM-mapping formatter through the
      pipeline. Mock `organizations[0].metadata = {chain: '10'}` →
      `parseMetadata` → `parseInt('10', 10) = 10` →
      `ChainBadge.CHAIN_CONFIG[10].shortName === 'Optimism'`
      rendered in the row's chain cell. Verifies a different
      formatter class than 4b (string passthrough vs integer
      toString vs int → enum mapping). Test: 1.4s.
- [x] Sub-slice 4c v2 — chain enum FALLBACK formatter
      (TEMPLATE LITERAL branch). Mock `metadata.chain = '999'`
      → `parseInt → 999` → not in `CHAIN_CONFIG` → fallback
      `{shortName: \`Chain ${chainId}\`}` → row's chain cell
      shows "Chain 999". Different formatter class than v1's
      lookup-table branch — covers the dynamic-template branch
      that catches a different bug shape (a regression that
      drops the fallback would crash or render empty here, not
      in v1). Test: 1.4s.
- [x] Sub-slice 4c v3a — candles pipeline plumbing.
      Mocks both endpoints (`api.futarchy.fi/registry/graphql` AND
      `api.futarchy.fi/candles/graphql`), seeds the registry
      response with a proposal whose `metadata.conditional_pools.{yes,no}.address`
      matches our probe addresses, and asserts the candles endpoint
      gets POSTed with at least one of those addresses. Proves the
      `EventsHighlightCarousel` →
      `fetchProposalsFromAggregator` →
      `collectAndFetchPoolPrices` → `fetchPoolsBatch` chain
      reaches the network with the right inputs. Test: 1.7s.
      Foundation for v3b (DOM-level price assertion).
- [x] Sub-slice 4c v3b — DOM-level currency formatter
      assertion. **THE CANONICAL PHASE 5 INVARIANT, WIRED.**
      Mock candles to return YES=0.42 → flows through
      `fetchProposalsFromAggregator` → `collectAndFetchPoolPrices`
      → `attachPrefetchedPrices` (mutates `event.prefetchedPrices`)
      → carousel renders `<EventHighlightCard prefetchedPrices=…/>`
      → `useLatestPoolPrices` short-circuits to prefetched →
      `${prices.yes.toFixed(precision)} ${baseTokenSymbol}` →
      DOM string "0.4200 SDAI" (precision=4 because YES<1
      triggers the high-precision branch; baseTokenSymbol='SDAI'
      because metadata.currencyTokens unset). Card variant
      detection traced via reading
      `EventsHighlightCarousel.jsx` (default `useNewCard=false`
      → renders `EventHighlightCard`, NOT `HighlightCards`).
      Test: 1.3s (when warm); full 6-test
      dom-api-invariant suite: 22.6s wall-clock with cold
      Next.js compile.
- [ ] Sub-slice 4d — cross-protocol price reconciliation
      (Algebra / CoW / Sushi) mock — when multiple sources should
      agree, mock each to slightly-different values and assert the
      UI flags the divergence (or picks the right canonical
      source).
- [ ] Sub-slice: cross-protocol price reconciliation (Algebra / CoW /
      Sushi) mock — when multiple sources should agree, mock each to
      slightly-different values and assert the UI flags the
      divergence (or picks the right canonical source).

## Phase 6 — Scenario library

**Goal:** first "real bug shape" replayable.

**Phase 6 slice 1 (scenario format) — DONE:**

- [x] Scenario capture format decided (was originally framed as
      "JSON snapshot vs full state dump"; the design space turned
      out broader). Decision: **executable `.scenario.mjs` modules
      in `auto-qa/harness/scenarios/`** — full ADR at
      `interface/auto-qa/harness/docs/ADR-002-scenario-format.md`.
      Reuses the existing fixture vocabulary (mock factories,
      wallet stub, signing tunnel) instead of porting it into a
      JSON-interpreting shim. Full-stack snapshot (Option D)
      deferred to Phase 7 chaos work.
- [x] `auto-qa/harness/scenarios/` directory created with
      `README.md` documenting the format + naming convention
      (`<NN>-<short-name>.scenario.mjs`).

**Phase 6 slice 2 (first scenario + runner) — DONE:**

- [x] Mock-helper extraction: `makeGraphqlMockHandler`,
      `makeCandlesMockHandler`, `fakeProposal`,
      `fakePoolBearingProposal`, and the PROBE_* constants moved
      from `flows/dom-api-invariant.spec.mjs` into a new shared
      module `fixtures/api-mocks.mjs`. The original spec file now
      imports from there. Both `dom-api-invariant.spec.mjs` AND
      scenario files reuse the same fixture vocabulary.
- [x] First scenario captured —
      `scenarios/01-stale-price-shape.scenario.mjs` — lifts
      slice 4c v3b's mocks + assertions into the Scenario format
      defined by ADR-002. Guards the PR #64 stale-price-but-API-
      healthy class (mocked candles GraphQL → "0.4200 SDAI" via
      EventHighlightCard's prefetched-price short-circuit).
- [x] Wrapper spec `flows/scenarios.spec.mjs` auto-discovers
      every `*.scenario.mjs`, dynamically imports each, and emits
      one Playwright `test()` per scenario titled
      "<name> — <bugShape>". Default wallet stub installed for
      each; mocks applied via `context.route`; assertions run
      sequentially. Top-level `await` for the imports so
      Playwright sees the full test list at collection time.
- [x] `scenarios/README.md` updated with a "Current scenarios"
      table indexing the captured scenarios.

**Phase 6 slice 3 (catalog generator) — DONE:**

- [x] `scripts/scenarios-catalog.mjs` (~70 lines): reads every
      `scenarios/*.scenario.mjs`, dynamically imports each,
      validates required fields (`name` / `description` /
      `bugShape` / `route`), and writes
      `scenarios/SCENARIOS.md` with a markdown table indexing
      the captured bug-shapes. Pipes in `bugShape` /
      `description` are escaped so table layout survives.
- [x] npm scripts wired: `scenarios:catalog` in harness;
      `auto-qa:e2e:scenarios:catalog` at root.
- [x] First generated `SCENARIOS.md` committed (3 scenarios:
      `01-stale-price-shape`, `02-registry-down`,
      `03-candles-down`). The README's per-file notes table
      was slimmed down to authoring notes only — the canonical
      bug-shape index lives in the auto-generated file.
- [x] Drift gate: a future CI step can `npm run auto-qa:e2e:scenarios:catalog`
      then `git diff --exit-code scenarios/SCENARIOS.md` to fail
      builds where the catalog is out of date with the scenarios
      directory. Worth wiring as part of Phase 7 slice 3 (CI
      integration).

## Phase 7 — Chaos injection + nightly CI

**Goal:** production-shape resilience signal.

**Phase 7 slice 1 (first chaos primitive) — DONE:**

- [x] Chaos library — first concrete primitive landed via the
      Phase 6 scenario format. `scenarios/02-registry-down.scenario.mjs`
      mocks REGISTRY GraphQL → 502 Bad Gateway, asserts /companies
      degrades to "No organizations found" (the
      `OrganizationsTable.jsx` empty-state branch). Demonstrates
      that the existing scenario infrastructure composes with
      chaos primitives — no format change needed; chaos
      handlers reuse `mocks: {url: handler}` with handlers that
      return 5xx instead of 200. Test: 2.4s.
      Bug-shapes guarded: hard-crash on registry 5xx, hung-spinner
      with no terminal state, raw error envelope leaked to UI,
      silent broken state that fakes success.

**Phase 7 slice 2 (more chaos primitives) — IN PROGRESS:**

- [x] CANDLES network failure — `scenarios/03-candles-down.scenario.mjs`
      mocks REGISTRY healthy + CANDLES → 502. Asserts the carousel
      still renders our event but the price formatter degrades
      to "0.00 SDAI" via the `prices.yes !== null ? … : '0.00 SDAI'`
      fallback. Discovery while writing this: the per-pool fallback
      fetcher (`poolFetcher.fetch` inside `useLatestPoolPrices`)
      hits the SAME `getSubgraphEndpoint` → CANDLES URL as the
      bulk prefetcher, so a CANDLES outage takes BOTH layers down
      at once. Test: 1.4s.
- [x] CANDLES partial success — `scenarios/04-candles-partial.scenario.mjs`
      mocks REGISTRY with TWO events (different pool addresses);
      CANDLES returns prices for ONE event's pools, omits the other.
      Asserts the priced card renders "0.4200 SDAI" while the
      unpriced card falls back to "0.00 SDAI" AND both cards
      remain visible. Bug-shapes guarded: one missing price
      corrupting all, card disappearing when its price is missing,
      prices swapping between cards. Test: 1.4s.
- [~] WALLET RPC failure — investigated and **deprioritized**:
      the wallet stub handles `eth_chainId` / `eth_accounts` /
      `wallet_switchEthereumChain` LOCALLY (not via
      `rpcPassthrough`), so wagmi/RainbowKit's auto-probe surface
      doesn't actually hit `rpcUrl`. On `/companies` (no swap, no
      message-sign) the wallet's RPC URL has near-zero blast
      radius. Revisit when a scenario needs to drive a real swap
      where the wallet's RPC failure matters.
- [~] Mid-flight failure — investigated and **deprioritized for
      `/companies`**: traced through `useAggregatorCompanies` +
      `CompaniesPage.jsx` (the consumer drops the hook's `error`
      field) — partial-success on REGISTRY's three-query pipeline
      lands at the same DOM state as full failure ("No
      organizations found"). Indistinguishable from scenario 02;
      no new bug shape captured. Re-evaluate when a scenario
      reaches a page that surfaces partial loading states (e.g.
      a market detail page).

**Phase 7 slice 3 (CI integration) — IN PROGRESS:**

- [x] **3a — first CI workflow STAGED for promotion.**
      `auto-qa/harness/ci/auto-qa-harness.yml.staged` (NEW)
      contains the workflow YAML in version control. Job:
      `scenarios-catalog-drift` — checkout, setup Node 22, `npm
      ci` in `auto-qa/harness/`, run the catalog generator,
      `git diff --exit-code scenarios/SCENARIOS.md`. Trigger
      is `workflow_dispatch` ONLY for v1 so landing it can't
      unexpectedly red-light unrelated PRs. Total runtime
      expected <1 min.

      **Why staged not live**: GitHub blocks OAuth Apps
      without `workflow` scope from creating/modifying
      `.github/workflows/*` files. The staging dance puts the
      content under code review without a workflow-scoped
      token, then a maintainer (or anyone with the right token)
      promotes the file by copying it into
      `.github/workflows/`. See
      `auto-qa/harness/ci/README.md` for the promote command.

- [ ] **3a-promote** — maintainer task: copy
      `auto-qa/harness/ci/auto-qa-harness.yml.staged` into
      `.github/workflows/auto-qa-harness.yml` + commit + push.
      One-time setup; subsequent edits to the staged file can
      be re-promoted the same way (or just edited directly in
      `.github/workflows/` if the contributor has workflow
      scope).
- [ ] **3b — promote triggers**: after smoke-testing 3a
      manually, add `schedule: '0 4 * * *'` (nightly drift
      sweep) and `pull_request: paths: ['auto-qa/harness/**']`
      (gate harness-touching PRs without adding noise to
      unrelated PRs).
- [x] **3c — full scenarios run in CI: STAGED.**
      `auto-qa/harness/ci/auto-qa-harness-scenarios.yml.staged`
      (NEW, on interface side) is a SEPARATE workflow file (not
      just a job in 3a's file) so the maintainer can promote
      each independently. Job: `scenarios-suite` — checkout,
      setup Node 22 with cache on BOTH lockfiles (root for
      Next.js, harness for Playwright), `npm ci` at root +
      harness, cache + install Chromium binaries
      (`actions/cache@v4` keyed on harness lockfile +
      `npx playwright install --with-deps chromium` on miss /
      `install-deps chromium` on hit), then `npm run ui:full`
      in harness with
      `HARNESS_FRONTEND_RPC_URL=https://rpc.gnosischain.com`
      (no anvil in CI; eth_sendTransaction case auto-skips).
      Trigger is `workflow_dispatch` ONLY for v1, mirroring
      slice 3a's conservative roll-out. Timeout 20 min;
      expected wall-clock ~5-10 min cold (~2-3 min warm cache).
- [ ] **3c-promote** — maintainer task: copy the staged
      scenarios workflow into `.github/workflows/`. Independent
      of 3a-promote (different workflow file), but the README
      recommends promoting + smoke-testing 3a first since it's
      cheaper.
- [x] **3d — per-failure artifact upload: STAGED.** Added an
      `actions/upload-artifact@v4` step to the slice-3c
      scenarios workflow file (not a new file — same staged
      workflow, just one more step). Conditional on
      `if: failure()`. Captures both
      `auto-qa/harness/playwright-report/` (HTML report) and
      `auto-qa/harness/test-results/` (per-test trace zip,
      screenshot, video — already produced by
      `playwright.config.mjs`'s `retain-on-failure` settings).
      Artifact name uses `${{ github.run_attempt }}` so each
      retry's artifacts stay distinct (`retries: 2` in CI).
      `retention-days: 14`; `if-no-files-found: ignore` for
      green runs with no artifacts. Promotes together with
      slice 3c (same staged file).

**Phase 7 slice 4 — IN PROGRESS (full-stack):**

- [x] **4a-prep — futarchy-api Dockerfile + .dockerignore
      tracked.** Both files were sitting untracked in the api
      repo root (created in a prior iteration). Now committed
      so the compose api block can reference them. Dockerfile
      uses `node:22-alpine` + `npm ci --omit=dev` +
      `EXPOSE 3031` + `CMD ["node", "src/index.js"]`.
      .dockerignore excludes node_modules, .env*, test-*.js,
      docs, lambda-deploy, test-checkpoint-vs-graph-node.
      Compose api block updated: PORT env documented as
      informational (src/index.js:25 hardcodes `const PORT =
      3031` and does NOT read process.env.PORT), and the
      commented `ports:` mapping changed from `3000:3000` to
      `3031:3031` to match Dockerfile EXPOSE + actual bind.
      Block remains commented; activating it is slice 4a.
- [x] **4a — compose api block UNCOMMENTED + structurally
      verified.** `docker compose config` parses cleanly
      with both `anvil` + `api` services active. Build
      context corrected from `../../..` (which resolved to
      `/Users/kas/`, ABOVE the api repo root — a Phase 0
      scaffold bug surfaced by this slice) to `../..`
      (correct: api repo root where Dockerfile +
      package.json live). Indexer dependency commented
      out so api doesn't fail to start before slice 4b
      adds the indexer service; api will start fine, but
      request-time endpoints that proxy to CHECKPOINT_URL
      will fail until indexer exists.
- [ ] **4a-verify — human build smoke test:**
      `docker compose -f auto-qa/harness/docker-compose.yml
      build api` (requires running Docker daemon). Expected
      output: builds the node:22-alpine image, runs
      `npm ci --omit=dev` against the api's
      package-lock.json (~1.2 MB), tags as
      `futarchy-replay-harness-api`. First build will pull
      ~50 MB node:22-alpine + run a multi-minute npm
      install; subsequent builds use the layer cache and
      complete in ~10s if package-lock.json hasn't changed.
- [x] **4b-plan — ADR-002 status update + indexer compose
      strategy.** ADR-002 moved Proposed → Accepted (Phase 3
      already implemented build-from-source via sibling
      `futarchy-indexers` clone; 25 smoke tests pass on it).
      The Phase 0 indexer stub assumed ONE service `indexer`
      with `image: TODO`; reality per ADR-002 is TWO indexers
      (registry + candles), each with its own postgres, each
      built from `futarchy-indexers/*/checkpoint/`. Compose
      stub block rewritten to reflect this. New top-level
      `include:` block staged (commented out) referencing the
      two sibling indexer compose files — uncommenting is
      slice 4b-include.
- [x] **4b-include — top-level `include:` UNCOMMENTED**
      pulling in both sibling indexer compose files.
      `docker compose config --services` now returns 6:
      `anvil`, `api`, `registry-checkpoint`,
      `registry-postgres`, `checkpoint`, `postgres`.
      Service-name reality (different from Phase 0 stub
      assumptions): registry compose uses `registry-checkpoint`
      + `registry-postgres`, but candles compose uses bare
      `checkpoint` + `postgres` (no `candles-` prefix on
      service names; container_names are prefixed but service
      names aren't). Candles also uses `GNOSIS_RPC_URL` not
      `RPC_URL` — different env var contract.
- [x] **4b-api-env — api service env corrected from
      `CHECKPOINT_URL` to `REGISTRY_URL` + `CANDLES_URL` +
      `FUTARCHY_MODE: checkpoint`.** Names now match
      `src/config/endpoints.js`. Wired to compose-internal
      service names + container port 3000 (the indexers
      EXPOSE 3000 inside the network; their host ports
      3001/3003 only matter from the host). The api's
      depends_on on the indexer services is intentionally
      NOT added yet — see 4b-network-wire below.
- [x] **4b-network-wire — indexers wired via per-service
      `extends:` (approach b).** Dropped `include:`; replaced
      with 4 `extends:` blocks (registry-checkpoint,
      registry-postgres, checkpoint, postgres) each pulling
      their definition from the sibling futarchy-indexers
      compose files. The two checkpoint services get harness
      overrides layered on top:
        - environment: RPC_URL/GNOSIS_RPC_URL=http://anvil:8545
          (override the included default of
          https://rpc.gnosischain.com so indexers ingest from
          our anvil fork, not real Gnosis); RESET=true (fresh
          DB on each harness start)
        - networks: dual-homed (registry-net OR checkpoint-net,
          plus harness-net) so the api can reach them via
          compose service name
        - depends_on: anvil + their respective postgres (with
          service_healthy on postgres so the indexer doesn't
          start before its DB)
      Top-level `networks:` and `volumes:` re-declared
      (registry-net, checkpoint-net, registry-postgres-data,
      candles-postgres-data) because `extends:` only inherits
      service-level config, not top-level keys. Api service
      depends_on now safely includes registry-checkpoint +
      checkpoint (service_started, since indexers have no
      healthcheck).
- [ ] **4b-verify — full smoke test.**
      `docker compose config --services` returns 6 (currently
      passes); `docker compose build api` still succeeds
      (4a-verify supersession). Daemon-required smoke:
      `docker compose up -d anvil registry-checkpoint` and
      probe `curl -s http://localhost:3003/graphql` for
      `{__typename}`. Will reveal whether the bridge approach
      works end-to-end.
- [x] **4c-prep — fixed FIVE bugs in the interface-dev stub
      while keeping it commented out.** Bugs surfaced + fixed:
      (i) path was `../../../../interface` (4 levels up = `/`);
      corrected to `../../../interface` (= /Users/kas/interface).
      (ii) `NEXT_PUBLIC_API_URL` pointed at `http://api:3000`
      but api binds to 3031 — same port discovery as slice
      4a-prep. (iii) Missing `depends_on: anvil` (Wagmi reads
      NEXT_PUBLIC_RPC_URL → http://anvil:8545). (iv) Bare
      `npm run dev` won't work in fresh container (bind mount
      provides source but no node_modules); replaced with a
      conditional `npm install` + `next dev --hostname 0.0.0.0`
      shell script (the `--hostname 0.0.0.0` is critical
      because next dev defaults to localhost-only binding).
      (v) Image was node:20-bookworm-slim; standardized on
      node:22-alpine to match the api Dockerfile + CI
      workflows. Also added a top-level `interface-node-modules`
      named volume to keep Linux node_modules separate from
      the host's macOS-binary tree.
- [x] **4c-activate — interface-dev block UNCOMMENTED.**
      `docker compose config --services` now returns 7
      (anvil, api, registry-checkpoint, registry-postgres,
      checkpoint, postgres, interface-dev). Merged config
      verified: depends_on (anvil healthy + api started),
      env (NEXT_PUBLIC_RPC_URL → http://anvil:8545,
      NEXT_PUBLIC_API_URL → http://api:3031), command (sh -c
      conditional npm install + `next dev --hostname 0.0.0.0
      --port 3000`), bind mount of sibling interface clone
      + named-volume isolation for node_modules.
- [ ] **4c-verify — daemon-required smoke** (human task):
      `docker compose -f auto-qa/harness/docker-compose.yml
      up -d interface-dev` (will pull node:22-alpine, run
      `npm install` of ~1000+ deps on first run — multi-
      minute), then `curl -s http://localhost:3010` should
      return the futarchy app HTML once `next dev` finishes
      compiling. Bind-mount file watching + HMR over the
      docker network are the most likely sources of
      surprise; CHOKIDAR_USEPOLLING=true env var is the
      standard fallback if HMR doesn't fire on host edits.
- [x] **4d-prep — fixed FIVE bugs in the orchestrator stub
      while keeping it commented out** + decomposed slice 4d
      into 3 sub-slices below. Bugs surfaced + fixed:
      (i) path was `../../../auto-qa/harness` (resolves to
      `/Users/kas/auto-qa/harness/` which doesn't exist);
      corrected to `.` (the dir containing this compose file
      IS the harness dir). (ii) `API_URL: http://api:3000`
      should be `http://api:3031` (slice 4a-prep finding).
      (iii) `CHECKPOINT_URL: http://indexer:3001/graphql`
      uses the wrong env var AND non-existent service;
      replaced with `REGISTRY_URL: http://registry-checkpoint:3000/graphql`
      + `CANDLES_URL: http://checkpoint:3000/graphql` per
      src/config/endpoints.js (slice 4b-api-env discovery).
      (iv) Image was node:20-bookworm-slim; standardized
      on node:22-alpine. (v) Bare `npm run test` won't work
      in fresh container; replaced with the same conditional
      install pattern as interface-dev. Also added
      `HARNESS_COMPOSE: "1"` env signal + a no-op
      `tail -f /dev/null` placeholder command (the assertion
      scripts don't exist yet — see 4d-scenarios below).
      Top-level `orchestrator-node-modules` volume declared
      eagerly so 4d-activate stays atomic.
- [x] **4d-scenarios (slice 1: scaffold + 2 starter
      invariants)**. Picked path (a): `HARNESS_COMPOSE=1`-
      gated unified runner. New files:
      `orchestrator/invariants.mjs` (assertion library —
      INVARIANTS array + `runAllInvariants(ctx)` aggregator;
      first two invariants: `apiHealth` → api `/health` 200,
      `apiCanReachRegistry` → api `/registry/graphql`
      proxies `__typename` probe to registry checkpoint),
      `orchestrator/scenario-runner.mjs` (CLI entry point;
      reads service URLs from env, supports `HARNESS_DRY_RUN=1`
      for offline catalog dump, exits 2 in native mode with
      a pointer to start-indexers.mjs + tests/), and
      `tests/smoke-scenario-runner.test.mjs` (6 tests:
      INVARIANTS shape; runAllInvariants happy path against
      in-process node:http fixture; 2 failure paths
      verifying no short-circuit; CLI dry-run; CLI native-
      mode rejection). New npm scripts: `scenarios:dry`,
      `scenarios:run`, `smoke:scenarios`. All 6 tests
      green; dry-run validated.
- [ ] **4d-scenarios-more — add remaining invariants** (per
      PROGRESS.md's invariant tables). Now 30 invariants:
      6 api-internal + 21 indexer probes + 3 chain-layer.
      `apiSpotCandlesHappyPath` added this slice — first
      api data-PLANE check (vs the prior api probes that
      were validation-only or pure passthroughs). Calls
      /api/v1/spot-candles?ticker=… expecting 200 + JSON
      with `spotCandles` array. Walks the api's full
      data plane (request → validation → fetchSpotCandles
      → spotCache → response transform → JSON write);
      catches downstream-throw 500s, response-shape
      regressions (renamed/dropped spotCandles field),
      and status-code regressions that bypass
      apiSpotCandlesValidates (which only tests the
      400-error path). 85 smoke tests green. Still to
      add: probabilityBounds, candlesAggregation
      (Candle.volume = sum of contained Swap amounts
      within period), chartShape (api unified-chart vs
      indexer raw), conservation, cross-run
      monotonicity on rateSanity.
- [x] **4d-activate — orchestrator block UNCOMMENTED.**
      Replaced the `tail -f /dev/null` placeholder with
      `node orchestrator/scenario-runner.mjs`. Dropped the
      conditional `npm install` (harness has zero runtime
      deps; node:22-alpine ships fetch). Lifecycle is
      one-shot: container starts, runs invariants, exits 0
      on all-pass or 1 on any-fail; other services keep
      running. `docker compose config --services` returns
      8: anvil + api + 4 indexer services + interface-dev +
      orchestrator. Merged config verified: 4 depends_on
      (anvil healthy + api/registry-checkpoint/checkpoint
      started), env (RPC_URL, API_URL, REGISTRY_URL,
      CANDLES_URL, FUTARCHY_MODE, HARNESS_COMPOSE=1),
      command (node orchestrator/scenario-runner.mjs).
- [ ] **4d-activate — uncomment orchestrator block.** Atomic
      one-step uncomment after 4d-scenarios decision lands.
      Adds 8th service to compose stack.
- [ ] **4e — single `docker compose up -d`** brings the full
      stack cleanly on a fresh checkout. The slice 4 acceptance
      gate.

## Acceptance gates (cross-cutting)

These don't belong to one phase but must hold throughout:

- [ ] Production code in `src/` (both repos) is NEVER modified by
      harness work
- [ ] No real mainnet RPC calls during a harness run
- [ ] Harness package.json deps are isolated from root deps (no
      pollution of the production install)
