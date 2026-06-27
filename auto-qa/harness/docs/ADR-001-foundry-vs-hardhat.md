# ADR-001: Foundry/anvil vs Hardhat for the harness fork

**Status:** Proposed (Phase 0 slice 5)
**Date:** 2026-05-10
**Deciders:** TBD

## Context

The Forked Replay Harness (see `../PROGRESS.md`) needs a long-lived local node
that forks Gnosis Chain (chainId 100) at an arbitrary historical block, then
replays a futarchy proposal lifecycle while the orchestrator drives the block
clock and the indexer/api/frontend reconcile against it. The fork must speak
standard Ethereum JSON-RPC so the unmodified `futarchy-api` (ethers v6) can
point at it without code changes, and it must support deterministic time
control plus account/state manipulation to inject synthetic traders.

## Decision

**Use Foundry/anvil as the harness fork.**

Anvil wins on the dimensions that dominate this harness: cold-start time,
fork-RPC throughput per replayed transaction, JSON-RPC ergonomics
(single binary, no Node project bootstrap), and CI footprint. Hardhat's one
genuine advantage — constant-time `hardhat_mine` for huge empty-block jumps
— does not match our workload, which mines real historical traffic block-by-
block with cross-layer assertions in between, so the bottleneck is per-tx
execution + RPC roundtrips, not bulk empty-block production. Anvil is also
the de-facto standard the wider Gnosis tooling targets, and the rest of the
shop is already half-Foundry-shaped (see `swapr/` patterns and the Gnosis
docs explicitly recommending Foundry).

## Comparison

| Concern | Foundry/anvil | Hardhat (`hardhat node`) | Winner |
|---|---|---|---|
| Fork freshness (arbitrary archive block) | `--fork-url $RPC --fork-block-number N` — first-class, lazy state fetch, on-disk cache via `--fork-cache-path` | `hardhat node --fork $RPC --fork-block-number N` — works, identical model, also caches | Tie |
| Block-clock control | `evm_setNextBlockTimestamp`, `evm_mine`, `anvil_setBlockTimestampInterval`, `anvil_mine(n)` | Same RPC names plus `hardhat_mine(n)`; constant-time for empty blocks | Hardhat (narrowly, only matters for huge gaps) |
| Performance (per-tx replay throughput) | Rust core, faster cold start (~sub-second), faster `eth_call` and signed-tx execution; linear `anvil_mine` is fine for our 1-block-at-a-time loop | Node/V8 core; mainnet-fork throughput improved in v2.8+ but still slower per-tx; known JS-heap pressure on long runs (need `--max-old-space-size`) | **Anvil** |
| Account impersonation | `anvil_impersonateAccount`, `anvil_stopImpersonatingAccount`, `anvil_autoImpersonateAccount` | `hardhat_impersonateAccount`, `hardhat_stopImpersonatingAccount` | Tie |
| State manipulation | `anvil_setBalance`, `anvil_setStorageAt`, `anvil_setCode`, `anvil_setNonce`, plus snapshot/revert | `hardhat_setBalance`, `hardhat_setStorageAt`, `hardhat_setCode`, `hardhat_setNonce`, plus snapshots | Tie |
| CI footprint | Single static Rust binary (~30-60 MB), `foundryup` or direct GitHub release download, no `node_modules` for the fork itself | Requires Node + a Hardhat project + ~hundreds of MB of `node_modules` (`hardhat`, `@nomicfoundation/hardhat-network-helpers`, …) just to run the node | **Anvil** |
| Cold start | Sub-second to a few seconds; reported CI regressions exist (foundry #7631) but baseline is fast | Several seconds to spin up Node + load Hardhat config + JIT warm-up | **Anvil** |
| JSON-RPC compatibility (`eth_*`) | Standard `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, etc.; ethers v6 client works untouched | Standard `eth_*`; ethers v6 client works untouched | Tie |
| Long-run memory stability | Steady leak under prolonged replay even with `--prune-history` (foundry #6017); manageable via periodic `anvil` restart between scenarios | Documented heap-out-of-memory under load (hardhat #3471); also manageable but worse default ceiling | **Anvil** |
| Repo conventions | `swapr/` already uses Foundry-adjacent patterns; Gnosis Chain docs explicitly recommend Foundry; ethers v6 in futarchy-api is RPC-client-only and orthogonal | `index/` uses Hardhat for unit tests, but those are contract-only (`ProportionalLiquidityHook.test.js`) — different concern | **Anvil** |
| Operational ergonomics | One CLI flag set, easy to wrap in `docker-compose` (`ghcr.io/foundry-rs/foundry`) | Requires a `hardhat.config.{js,ts}` checked in just to run the node | **Anvil** |

## Consequences

**Positive**

- Fastest path to a working Phase 1: `anvil --fork-url $GNOSIS_ARCHIVE_RPC --fork-block-number $BLOCK --chain-id 100 --no-mining --port 8545 --host 0.0.0.0` is a one-liner the orchestrator can shell out to.
- No spurious Node/Hardhat dep tree inside `auto-qa/harness/` — the harness `package.json` stays slim and bound to orchestrator/test-runner deps only.
- `docker-compose.yml` (Phase 1 slice 2) can use the official `ghcr.io/foundry-rs/foundry` image, no custom Dockerfile.
- `cast` ships with the same toolchain — useful for ad-hoc debugging during scenario authoring.
- Aligns with Gnosis Chain's own recommended dev environment.

**Negative**

- We give up `hardhat_mine`'s constant-time bulk mining. Mitigation: our scenarios mine real historical blocks one at a time anyway (so we can run cross-layer assertions between blocks); the only time we'd want a huge empty jump is to skip dead time, which we'll handle with `evm_setNextBlockTimestamp` + a single `evm_mine` rather than mining N empty blocks.
- Requires the Foundry toolchain in CI. Mitigation: pin a specific anvil version via `foundryup --install <ver>` or a SHA-pinned binary download; document in the harness `README.md` once Phase 1 lands.
- Anvil's prolonged-replay memory creep (foundry #6017) is real. Mitigation: restart anvil between scenarios; for very long single-scenario replays, snapshot/revert (`evm_snapshot` / `evm_revert`) at scenario boundaries instead of letting one process accumulate.

**Risks**

- Gnosis-archive RPC providers (drpc, Chainstack, Dwellir) rate-limit; large lazy-fetch storms during a fresh fork can stall the harness. Mitigation: warm `--fork-cache-path` per-block-pin, commit the cache as a CI artifact for the canonical replay blocks.
- Anvil regressions land regularly (e.g. CI slowdowns in #7631). Mitigation: pin the toolchain version in the harness `README.md` and bump explicitly with a smoke test rather than tracking `nightly`.
- If a future invariant truly needs constant-time mining of millions of blocks (very unlikely for futarchy proposal windows, which are days, not years), we'll need to rethink — but that's a reversible decision.

## CLI commands the harness will use

```bash
# Start the fork (Phase 1)
anvil \
  --fork-url $GNOSIS_ARCHIVE_RPC \
  --fork-block-number $BLOCK \
  --chain-id 100 \
  --no-mining \
  --host 0.0.0.0 --port 8545 \
  --fork-cache-path .anvil-cache/$BLOCK

# Block-clock primitives (Phase 1 orchestrator)
cast rpc evm_setNextBlockTimestamp $TS
cast rpc evm_mine
cast rpc anvil_mine 1               # mine N blocks if needed

# Synthetic traders (Phase 4)
cast rpc anvil_impersonateAccount $ADDR
cast rpc anvil_setBalance $ADDR 0xde0b6b3a7640000   # 1 xDAI
cast rpc anvil_setStorageAt $TOKEN $SLOT $VAL       # fixture funding via storage poke

# Scenario boundaries (Phase 6)
cast rpc evm_snapshot
cast rpc evm_revert $SNAP_ID
```

## Alternatives considered

- **reth** (`reth node --dev` / `reth --chain gnosis`) — Excellent execution-layer perf and trace API parity, but no first-class fork-from-block mode comparable to `anvil --fork-url`; we'd be reimplementing fork plumbing. Revisit if/when reth ships an "anvil mode" we can lean on.
- **geth `--dev`** — Pure dev mode, no fork-from-archive; would force us to seed historical state by hand. Hard pass.
- **ganache** — Sunsetted by ConsenSys in 2023; no maintenance, no Cancun/Prague support, no Gnosis specifics. Hard pass.
- **Tenderly virtual TestNets** — Closest hosted equivalent; great DX for ad-hoc work but adds an external dependency, per-seat cost, and network egress to every harness run, which conflicts with the README's "no network calls to mainnet RPCs during a harness run" constraint. Keep as a debugging escape hatch, not the harness substrate.

## Sources

- foundry #5499 — `anvil_mine` linear vs `hardhat_mine` constant-time
- foundry #6017 — anvil prolonged-replay memory growth
- foundry #7631 — anvil CI slow-start regressions (version-pin watch item)
- hardhat #3471 — hardhat node heap pressure under load
- Gnosis Chain docs — Foundry recommended for chainId 100
- Nomic Foundation blog — `hardhat_mine` constant-time mining
