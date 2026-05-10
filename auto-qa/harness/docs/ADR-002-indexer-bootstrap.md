# ADR-002: Local Checkpoint indexer bootstrap strategy

**Status:** Accepted (Phase 3 implemented; revisited in Phase 7 slice 4b)
**Date:** 2026-05-10 (proposed); 2026-05-10 (accepted via Phase 3 implementation)
**Deciders:** harness author (sole maintainer at this point)

> **2026-05 revisit (Phase 7 slice 4b-plan)**: The decision held up
> through Phase 3 implementation. `scripts/start-indexers.mjs` brings
> up the per-indexer compose projects against a sibling
> `futarchy-indexers` clone discovered by
> `scripts/detect-indexers.mjs`. 25 smoke tests pass on this
> infrastructure.
>
> Phase 7 slice 4 needs the SAME indexer source visible from the
> harness's unified `docker-compose.yml`. Sub-slice 4b adds a
> top-level `include:` of the sibling indexer compose files (the
> "include" leg of this ADR's "include OR wrapper" decision).
> Network wiring (RPC_URL → http://anvil:8545 instead of
> http://host.docker.internal:8546) is its own sub-slice (4b-network-wire).

## Context

Phase 3 of the Forked Replay Harness needs a local Checkpoint indexer
that ingests events from the harness anvil fork. The api consumes the
indexer via `REGISTRY_URL` and `CANDLES_URL` (default `localhost:3003`
and `localhost:3001` per `src/config/endpoints.js`). Three deployment
shapes were considered:

1. **Use a published Checkpoint image** — pull a generic
   `snapshot-labs/checkpoint` image and inject our schema/handlers at
   runtime
2. **Build from source via the existing `futarchy-fi/futarchy-indexers`
   repo** — sibling-clone the repo and reuse its docker-compose
3. **Stub it out forever** — keep using `orchestrator/stub-indexer.mjs`
   from Phase 2 for cross-layer tests; never wire a real indexer

## Decision

**Pick option 2: build from source via the existing `futarchy-indexers`
repo, mounted as a sibling clone next to `interface/` (similar to how
ARCHITECTURE.md plans for interface).** The harness's compose file
includes either a top-level `include:` of the indexer's compose file, or
a wrapper service that delegates to it.

The `stub-indexer` (Phase 2) remains valuable for fast unit-style
integration tests where we don't care about the indexer's actual
indexing logic — just the api↔upstream wire format. The real indexer
is for Phase 3+ end-to-end scenarios.

### Why not the published image (option 1)

There IS no generic published Checkpoint image we can drop in. The
existing `futarchy-indexers` repo doesn't pull from GHCR or Docker Hub
— each subdir (`futarchy-complete/checkpoint/`,
`proposals-candles/checkpoint/`) ships its own `Dockerfile` and `build:
.` reference in compose. Patches like
`resolvers-patched.js`/`controller-patched.js` are mounted from the
repo verbatim and would have no analog in a generic image.

### Why not stub-only (option 3)

The whole point of Phase 3 is **proving indexer↔chain agreement** —
that the indexer correctly observes events anvil produces, transforms
them per its handlers, and exposes them via GraphQL with the same
shape the api expects. Stubbing the indexer trades all of that
fidelity for speed. We need both.

## Comparison

| Concern | Published image | Build-from-source | Stub-only |
|---|---|---|---|
| Fidelity to production | low (would need rebuild for schema/handler drift) | **high** (uses the same Dockerfile + repo state production runs) | none |
| Cold-start time | ~10s (image cached) | **~60-120s** first run (build + DB init + RESET=true) | ~50ms |
| CI footprint | image pull only | repo clone + build cache + postgres image | none |
| Catches real indexer bugs | no | **yes** | no |
| Schema drift visibility | hidden | **forced into our face** | hidden |
| Unblocks Phase 6 (scenarios) | partial | **fully** | no |
| Maintenance | divergence accumulates silently | **single source of truth** (their compose IS our compose) | requires hand-coded test fixtures |
| **Verdict** | rejected | **chosen** | retained for fast-path tests only |

## Consequences

### Positive

- Zero divergence risk between harness and production indexer behavior
- New indexer features (schema additions, handler changes) automatically
  flow into the harness on every `git pull` of futarchy-indexers
- The harness inherits both compose files (registry + candles) and
  their patches without re-implementation
- Schema migration cold-start is exercised on every test run — if it
  ever breaks, we catch it immediately

### Negative

- **First-run latency**: `RESET=true docker compose up --build` takes
  60-120s for the registry checkpoint and similar for candles. CI runs
  must either accept this on every job OR cache the postgres data
  volume between runs.
- **Postgres volume**: each indexer ships its own PG container. The
  harness compose now spans 4+ containers (anvil, registry-checkpoint
  + its postgres, candles-checkpoint + its postgres) plus the api.
  Image pull + volume mgmt becomes the dominant time cost.
- **Sibling clone discipline**: `~/futarchy-indexers/` must be checked
  out at a known-good commit. We pin in `ARCHITECTURE.md` and add a
  smoke that verifies the clone exists before running indexer tests.
- **No bootstrap shortcut yet**: we need to research whether the
  indexer accepts a `START_BLOCK` env to skip from genesis to
  anvil's fork height (otherwise it'll try to scan blocks that never
  existed on our fork). See "Open questions" below.

### Risks

- **Indexer start-block skew**: anvil's fork starts at block N (say
  46100000). The indexer, told to track Gnosis, will try to start
  from genesis (or its own configured start). It will fail to fetch
  blocks 0..N-1 because anvil only knows block N forward. **Mitigation
  candidates**: (a) pass the fork block via a `START_BLOCK` env if the
  indexer respects it; (b) hand-craft a `last_indexed_block` row in
  the postgres init.sql; (c) use a Mainnet RPC for back-history and
  switch to anvil only for new blocks (but this defeats the purpose of
  forking). Spike needed before slice 4.

- **Postgres init.sql immutability**: each indexer ships its own
  `init.sql` mounted into postgres. We don't want to fork those for
  the harness. Override candidates: (a) wrap the mount path via env;
  (b) docker-compose `depends_on` + a one-shot init container that
  rewrites `last_indexed_block`; (c) accept full bootstrap and live
  with the cold-start latency.

- **Container teardown order**: stopping anvil before the indexer
  flushes can leave the indexer in a "trying to fetch from a dead
  RPC" loop until its retry budget exhausts. The orchestrator's
  `stopAll()` must order shutdown carefully (indexer first).

## Implementation sketch (chosen path)

### Directory layout

```
~/code/futarchy-fi/
  futarchy-api/          ← harness lives here
    auto-qa/harness/
      docker-compose.yml ← extends with indexer service
  interface/             ← sibling, for Phase 5
  futarchy-indexers/     ← sibling, for Phase 3+
    futarchy-complete/checkpoint/   ← registry indexer
    proposals-candles/checkpoint/   ← candles indexer
```

### Compose extension

The harness `docker-compose.yml` adds:

```yaml
services:
    registry-indexer:
        extends:
            file: ${INDEXERS_PATH:-../../../../futarchy-indexers}/futarchy-complete/checkpoint/docker-compose.yml
            service: registry-checkpoint
        environment:
            RPC_URL: http://anvil:8545
            RESET: "true"  # harness always starts fresh
        depends_on:
            anvil:
                condition: service_healthy
        networks: [harness-net]

    candles-indexer:
        extends:
            file: ${INDEXERS_PATH:-../../../../futarchy-indexers}/proposals-candles/checkpoint/docker-compose.yml
            service: checkpoint
        environment:
            GNOSIS_RPC_URL: http://anvil:8545
            RESET: "true"
        depends_on:
            anvil:
                condition: service_healthy
        networks: [harness-net]
```

(Plus their two postgres siblings extended the same way.)

### Service helper

`orchestrator/services.mjs` adds:

```js
export async function startLocalIndexers({ reset = true } = {}) { ... }
```

with a readiness probe (poll `http://localhost:3003/graphql` and
`http://localhost:3001/graphql` for HTTP 200 on a trivial query
like `{ __typename }`).

### Smoke test (`tests/smoke-indexer-roundtrip.test.mjs`, slice 5)

1. Bring up anvil + indexers + api
2. Wait for indexers to reach `head == anvil.blockNumber` (with timeout)
3. Fire a known event on anvil (e.g., a Swap on a watched pool)
4. Mine a block
5. Poll the indexer's GraphQL until the event appears (or timeout)
6. Query the api passthrough at `/candles/graphql` for the same data
7. Assert the event is present in BOTH sources

This is **the** Phase 3 invariant and the foundation of every later
phase.

## Alternatives considered

- **Vendor the indexer source into auto-qa/harness**: rejected — would
  duplicate ~200 files and force harness commits on every indexer
  change. Sibling clone keeps the boundary clean.
- **Run indexers on a remote testnet (Chiado)**: rejected — defeats
  determinism; we want to control the chain via anvil.
- **Build indexer images in CI and push to GHCR**: deferred to Phase 7.
  For now `build: .` per compose is fine; revisit when CI runtime
  becomes a bottleneck.
- **Use `snapshot-labs/checkpoint` published image with our schema
  bind-mounted**: rejected — the patches in
  `resolvers-patched.js`/`controller-patched.js` overwrite files inside
  `node_modules/@snapshot-labs/checkpoint/dist/`, which only works
  against a specific version. Reproducing that mount setup
  with a generic image would re-implement the existing repo's
  Dockerfile.

## Open questions

These need spike work before later slices:

1. **`START_BLOCK` / `START_FROM_LATEST` env support** — does
   `@snapshot-labs/checkpoint` accept a starting-block override? If yes,
   slice 3 wires `START_BLOCK = anvil.fork-block`. If no, we need
   custom bootstrap (init container or postgres init.sql override).

2. **GNOSIS_BLOCK_RANGE** — registry checkpoint has a
   `GNOSIS_BLOCK_RANGE=10000` default. Combined with start-block, this
   determines the cold-start scan budget. Tune for the harness.

3. **Anvil RPC compatibility** — does the Checkpoint indexer use any
   non-standard RPC methods that anvil doesn't implement? (e.g. `trace_*`
   calls for log retrieval.) Spike: try pointing the registry indexer
   at anvil and see what errors surface in the first 30 seconds.

4. **Schema migration warm-up time on M-class CI runners** — how
   fast does the postgres init + checkpoint table generation actually
   complete on cold cache? If >2 min, we need pre-warmed image strategy.
