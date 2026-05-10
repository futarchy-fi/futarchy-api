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
- [ ] **3c — full scenarios run in CI**: separate job that
      runs the actual Playwright scenarios suite (needs
      browser install + Next.js dev server). Heavier; gate
      behind `workflow_dispatch` first, then maybe nightly.
- [ ] **3d — per-failure artifact upload**: Playwright already
      captures trace / screenshot / video per
      `playwright.config.mjs`'s `retain-on-failure` settings.
      The CI step that uploads those as workflow artifacts is
      the remaining work — small `actions/upload-artifact@v4`
      block conditional on failure.

**Phase 7 slice 4 — TODO (full-stack):**

- [ ] Single docker-compose `up -d` brings the full 5-service
      stack cleanly on a fresh checkout

## Acceptance gates (cross-cutting)

These don't belong to one phase but must hold throughout:

- [ ] Production code in `src/` (both repos) is NEVER modified by
      harness work
- [ ] No real mainnet RPC calls during a harness run
- [ ] Harness package.json deps are isolated from root deps (no
      pollution of the production install)
