# Spike-001: Checkpoint indexer ↔ anvil compatibility

**Status:** Complete
**Date:** 2026-05-10
**Investigator:** harness research agent (Opus 4.7)

## Scope

Resolve the four open questions in
`docs/ADR-002-indexer-bootstrap.md` blocking Phase 3 slice 4. Sources
inspected:

- Local clones at `/Users/kas/futarchy-indexers/futarchy-complete/checkpoint/`
  and `/Users/kas/futarchy-indexers/proposals-candles/checkpoint/`.
- Patched files committed in those subdirs
  (`scripts/patch-graphnode-style.js`, `controller-patched.js`,
  `resolvers-patched.js`).
- The published `@snapshot-labs/checkpoint@0.1.0-beta.68` package
  (and the latest `0.1.0-beta.70` for regression check), fetched via
  `npm pack` and extracted to `/tmp/checkpoint-pkg/`.

Both indexers pin `^0.1.0-beta.68`
(`futarchy-complete/checkpoint/package.json:17`,
`proposals-candles/checkpoint/package.json:13`), so beta.68 is the
authoritative version.

---

## Question 1 — `START_BLOCK` support

**Answer:** **No env override exists in the published Checkpoint package
or in either indexer's user code.** The starting block is ALWAYS read
from the in-process `CheckpointConfig.sources[].start` literal. However,
**bootstrap by pre-seeding the postgres `_metadatas` table IS supported
and is the cleanest workaround.**

### Evidence

1. **`Container.getStartBlockNum()` is the only call site that decides
   where indexing begins**
   (`/tmp/checkpoint-pkg/package/dist/src/container.js:335-340`):

   ```js
   async getStartBlockNum() {
       const start = this.getConfigStartBlock();           // <- min(sources.start)
       const lastBlock = (await this.store.getMetadataNumber(
           this.indexerName,
           checkpoints_1.MetadataId.LastIndexedBlock
       )) ?? 0;
       const nextBlock = lastBlock + 1;
       return nextBlock > start ? nextBlock : start;
   }
   ```

   `getConfigStartBlock()` (line 329-334) returns
   `Math.min(...sources.map(s => s.start))`. There is no env var read
   anywhere on this path.

2. **The user-side `config.ts` files hardcode the start blocks**
   - `futarchy-complete/checkpoint/src/config.ts:6-14` —
     `AGGREGATOR_START_BLOCK = 44220000`, `CREATOR_START_BLOCK = 44220000`,
     `PROPOSAL_FACTORY_START_BLOCK = 44220000`. These are TS module
     constants, **not** read from `process.env`.
   - `proposals-candles/checkpoint/src/config.ts:29,38,79,88` —
     `start: 40620030` (Gnosis), `start: 23419000` (Mainnet). Literals.

3. **`MetadataId.LastIndexedBlock` is the documented pivot**
   (`/tmp/checkpoint-pkg/package/dist/src/stores/checkpoints.js:74-80`):

   ```js
   var MetadataId;
   (function (MetadataId) {
       MetadataId["LastIndexedBlock"] = "last_indexed_block";
       ...
   })(MetadataId ...);
   ```

   Stored in the `_metadatas` table (line 42), keyed by
   `(id='last_indexed_block', indexer=<indexerName>)` with the value as
   a `varchar(128)` parsed via `parseInt` in `getMetadataNumber`
   (line 254-258).

### Implication for the harness

We have **two viable paths** for the harness, ordered by my
recommendation:

**(A) Postgres bootstrap row (recommended).** After `RESET=true`
finishes (which calls `Container.reset()` at `container.js:298-302`,
inserting `LastIndexedBlock = 0`), the harness orchestrator runs an
init container or one-shot SQL against the postgres sidecar:

```sql
INSERT INTO _metadatas (id, indexer, value)
VALUES ('last_indexed_block', 'gnosis', '46099999')
ON CONFLICT (id, indexer) DO UPDATE SET value = EXCLUDED.value;
```

Then `npm run dev` starts; `getStartBlockNum()` returns
`46099999 + 1 = 46100000` (matching the anvil fork height).

Pros: zero patches to indexer code, works for both indexers
identically, idempotent.

Cons: must run **after** `checkpoint.reset()` and **before**
`checkpoint.start()`. The current docker-compose `command:
"npx checkpoint generate && npm run dev"` does both inside the same
container, so the seed has to be a `depends_on:
service_completed_successfully` init container OR a small wrapper
script that the harness mounts in.

**(B) Patch the user `config.ts` at harness build time.** Mount a
TS file that reads `process.env.START_BLOCK` and overrides the
`start:` literals:

```ts
const startOverride = process.env.START_BLOCK
    ? Number(process.env.START_BLOCK)
    : undefined;
const sources = [
  { ..., start: startOverride ?? AGGREGATOR_START_BLOCK },
  ...
];
```

Pros: no postgres surgery; survives `RESET=true` cleanly.
Cons: forks the indexer source — exactly the divergence ADR-002
explicitly rejected. Not recommended unless option (A) hits a snag.

**Note about template sources:** Templates (Organization,
ProposalMetadata, AlgebraPool, UniswapV3Pool) get their `startBlock`
from the parent contract's event block at runtime
(`container.js:83-108`, `executeTemplate` is called by writers and
persisted to `_template_sources`). They will naturally start at the
fork height because the event triggering them must occur on the
forked chain. The bootstrap row only affects the top-level
`config.sources`.

---

## Question 2 — `GNOSIS_BLOCK_RANGE` meaning

**Answer:** It is the **per-batch `eth_getLogs` window** (the
"preload step"), measured in blocks. It is **not** a total scan budget.
It controls how many blocks the indexer asks the RPC for per
`getLogsForSources` call during the bulk-sync preload phase.

### Evidence

1. **The variable is consumed by patch #5 in
   `scripts/patch-graphnode-style.js`** (lines 296-305 in both
   indexers' copies) — patches `Container` constructor to:

   ```js
   const perChainRange =
       process.env[indexerName.toUpperCase() + '_BLOCK_RANGE'];
   if (perChainRange) {
       this.preloadStep = parseInt(perChainRange, 10);
       console.log('[' + indexerName + '] block range override: ' + this.preloadStep);
   }
   ```

   So `addIndexer('gnosis', ...)` produces a container that reads
   `GNOSIS_BLOCK_RANGE`; `addIndexer('mainnet', ...)` reads
   `MAINNET_BLOCK_RANGE`. The compose file passes
   `MAINNET_BLOCK_RANGE=50000` for the same reason
   (`proposals-candles/checkpoint/docker-compose.yml:16`).

2. **`preloadStep` is the per-iteration window in
   `Container.preload()`**
   (`/tmp/checkpoint-pkg/package/dist/src/container.js:147-149`):

   ```js
   while (currentBlock <= this.preloadEndBlock) {
       const endBlock = Math.min(currentBlock + this.preloadStep,
                                  this.preloadEndBlock);
       checkpoints = await this.indexer
           .getProvider()
           .getCheckpointsRange(currentBlock, endBlock);
       ...
   }
   ```

   `getCheckpointsRange` calls `getLogsForSources(currentBlock,
   endBlock, …)` (provider.js:336-354), which issues an `eth_getLogs`
   spanning `endBlock - currentBlock` blocks per request.

3. **The default is 1000** (vanilla checkpoint) or 5000 (after the
   futarchy patch, `container.js #1` adjusts
   `BLOCK_PRELOAD_START_RANGE = 5000`).
   `GNOSIS_BLOCK_RANGE=10000` in the registry compose
   (`futarchy-complete/checkpoint/docker-compose.yml:16`) overrides
   this to 10k blocks per call — chosen because the production Gnosis
   RPC (Gateway.fm) supports 10k-block windows.

### Implication for the harness

For the harness, anvil happily handles arbitrarily large
`eth_getLogs` windows over its forked range (no rate-limit logic, no
`-32603 range too large` errors). Set
`GNOSIS_BLOCK_RANGE=100` (or even smaller) once the bootstrap row puts
us at the fork height — the only blocks we'll scan are those the test
mines, so a tiny window minimizes per-batch RPC chatter and shortens
end-to-end latency for the smoke roundtrip in
`tests/smoke-indexer-roundtrip.test.mjs`. There is no upper-bound risk
since anvil is in-memory.

---

## Question 3 — Anvil RPC compatibility

**Methods Checkpoint calls during a normal EVM sync:**

| RPC method | Source | Frequency |
|---|---|---|
| `eth_chainId` | `provider.js:33` (`getChainId` for `getNetworkIdentifier`) | once per `validateStore` call (start) |
| `eth_blockNumber` | `provider.js:37` (`getBlockNumber` for `getLatestBlockNumber`) | every 50 blocks (`CHECK_LATEST_BLOCK_INTERVAL`) plus startup |
| `eth_getBlockByNumber` | `provider.js:41,53` (viem `client.getBlock({ blockNumber })`) | once per block processed (for `parentHash` and timestamp) |
| `eth_getLogs` | `provider.js:263-275` (raw `fetch`, `method: 'eth_getLogs'`) | once per preload range and once per indexed block (by `blockHash`) |

That is the **complete** set. Verified by
`grep -rn "method:" /tmp/checkpoint-pkg/package/dist/src/providers/`
which returns exactly two matches in `evm/`: line 264 (`POST` HTTP
method, not RPC) and line 272 (`eth_getLogs`). All other RPC traffic
goes through `viem.createPublicClient({ transport: http(...) })`
(provider.js:22-26), and the only viem methods invoked are
`getChainId`, `getBlockNumber`, and `getBlock` — each of which maps
1:1 to the standard JSON-RPC method named above. There are **no
calls to** `trace_*`, `debug_*`, `eth_subscribe`, `eth_newFilter`,
`eth_getFilterLogs`, `net_*`, `engine_*`, or `admin_*` in any of
`provider.js`, `indexer.js`, or `helpers.js` (the starknet provider
is not loaded for EVM indexers — `evm.EvmIndexer` is selected
explicitly in both `index.ts` files).

The futarchy patches (`patch-graphnode-style.js`) add **no new RPC
methods** — every change is either to caching, batching, retry, or
`eth_getLogs` parameter shape.

**Anvil supports all four** of these methods natively (they are
pure-EVM standard methods; foundry implements them in
`anvil/src/eth/api.rs`). Verified against Foundry docs and the
project knowledge of anvil's RPC surface in the futarchy harness
codebase.

**Beta.70 regression check:** diffing
`/tmp/checkpoint-pkg/package/dist/src/providers/evm/provider.js`
between beta.68 and beta.70 shows no new RPC methods — only refactors
(extract `fetchBlock`, add `getChainId` helper) and a new
`state_retention_blocks` config knob. Safe to upgrade the package
within the `^0.1.0-beta.68` semver range without re-running this
spike.

### Gaps

**None for the EVM indexer path.** Anvil is a drop-in RPC
replacement. The only behavioral subtlety is that anvil's `eth_chainId`
returns whatever the fork's chain ID is (e.g. `100` for a Gnosis fork),
which is exactly what Checkpoint expects (it stores
`evm_<chainId>` as the `network_identifier` metadata; if the harness
forks Gnosis at chain 100, `getNetworkIdentifier()` returns
`evm_100` matching production — `validateStore` at container.js:363
will not trip the `hasNetworkChanged` branch).

---

## Question 4 — Cold-start time

### Postgres init

- **`init.sql` is trivially small in both indexers**
  (`futarchy-complete/checkpoint/init.sql`: 2 lines,
  `proposals-candles/checkpoint/init.sql`: 1 line). Both contents:
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (registry adds a
  comment line). On a `postgres:15-alpine` cold container, this is
  ~1-3 seconds after the entrypoint reaches `pg_isready`.
- **Healthcheck in compose** is `pg_isready` every 5s with 5 retries
  (both `docker-compose.yml` files, identical). First successful
  ready typically lands by 6-12s.

### Schema generation (`npx checkpoint generate`)

This step is run **at Docker image build time** for both indexers,
not at runtime:

- `futarchy-complete/checkpoint/Dockerfile:20` — `RUN npx checkpoint generate`
- `proposals-candles/checkpoint/Dockerfile:7` — `RUN npx checkpoint generate`

…**EXCEPT** the registry's `command:` re-runs it on container start
(`futarchy-complete/checkpoint/docker-compose.yml:11`):
`command: sh -c "npx checkpoint generate && npm run dev"`. The
proposals-candles compose just runs `npm start` so it relies entirely
on the build-time generation.

What `npx checkpoint generate` actually does
(`/tmp/checkpoint-pkg/package/dist/src/bin/index.js:52-79`):

1. Reads `src/schema.gql` (53 lines for registry, 80 lines for
   candles — both sub-2KB).
2. Calls `extendSchema` then `GqlEntityController` constructor.
3. Calls `codegen()` to write `.checkpoint/models.ts`.
4. Calls `controller.generateSchema()` and writes
   `.checkpoint/schema.gql`.

This is pure in-memory transformation of <100 schema lines. Wall
time: **<1 second** on any modern hardware. (Verified by code
inspection of `codegen.js` — no I/O beyond reading the schema
file and writing two output files.)

### Postgres entity table creation (`checkpoint.reset()`)

When the indexer process starts with `RESET=true`, `index.ts` calls
`checkpoint.reset()` which:

1. **`store.createStore()`** — creates 4 internal tables `_blocks`,
   `_checkpoints`, `_metadatas`, `_template_sources` if they do not
   exist (`stores/checkpoints.js:115-158`). Idempotent via
   `hasTable` checks.
2. **For each container**: `container.reset()` — writes 0 to
   `_metadatas.last_indexed_block` and `1` to `schema_version`,
   deletes any existing rows from `_blocks` (`container.js:298-302`).
3. **`entityController.createEntityStores()`** — for each entity in
   the user schema (4 in registry, 5 in candles, plus
   `_metadatas`/`_checkpoints` extensions), runs `dropTableIfExists`
   then `createTable` with all columns indexed and an `EXCLUDE USING
   GIST (id WITH =, _indexer WITH =, block_range WITH &&)` constraint
   (`controller-patched.js:152-196`, identical to vanilla).

Per-entity table creation is one DDL statement plus one ALTER for the
exclusion constraint. With ~5 entities and the `btree_gist` extension
enabled (line 154-156 of controller), this completes in **~1-3
seconds** per indexer on local docker.

### `RESET=true` vs normal start

- **`RESET=true`** branch in `index.ts:74-77` (registry) and
  `index.ts:115-118` (candles): drops and recreates ALL entity
  tables and zeroes the metadata. Adds the entity-table cost above.
- **Normal start**: `validateStore()` runs the same network/start/
  config/schema checks (`container.js:363-422`). If anything has
  changed AND `resetOnConfigChange: true`, it auto-resets. The
  candles indexer explicitly sets `resetOnConfigChange: false`
  (`proposals-candles/checkpoint/src/index.ts:43`) to avoid
  multi-hour resyncs in production. The registry indexer does not
  set it (defaults to `undefined` / falsy), so the same applies.
- The `npx checkpoint generate` re-run (registry only, runtime) adds
  a redundant ~1s — harmless, will not be a hot-path cost.

### Expected first-run wall time on M-class CI runners

Working assumptions: GitHub Actions `macos-14` (M1) or `ubuntu-latest`
on a 4-vCPU runner, no Docker layer cache.

| Phase | Time |
|---|---|
| `docker compose pull` (postgres:15-alpine, ~85MB) | ~3-5s |
| `docker compose build` (Node 22-alpine + `npm install --ignore-scripts` for ~50 deps) | **~30-60s cold, ~5s with layer cache** |
| Apply `patch-graphnode-style.js` patches | <1s |
| `npx checkpoint generate` (build time) | <1s |
| Postgres container start to `pg_isready` | ~6-12s |
| Indexer container start, `npx checkpoint generate` (registry runtime), connect to PG | ~3-5s |
| `checkpoint.reset()` — create internal tables, drop/create entity tables | ~2-4s |
| Bootstrap SQL injection (Option A) — single `INSERT … ON CONFLICT` | <1s |
| `checkpoint.start()` to first `eth_blockNumber` call against anvil | ~1-2s |

**Total cold first-run estimate: 50-90 seconds** for one indexer
(registry OR candles). Running both in parallel: ~90-120s
wall-clock dominated by the npm install and image build step.

This matches the ADR-002 "Negative" entry of "60-120s" almost exactly.

**Caching levers** if CI footprint becomes painful:

1. **Docker layer cache for the npm install** (the by-far dominant
   cost) — `actions/cache` keyed on `package-lock.json` hash, restore
   to `~/.npm`. Likely cuts first-run by 20-40s.
2. **Pre-built indexer images pushed to GHCR** by a
   nightly workflow (the option ADR-002 deferred to Phase 7).
3. **Reuse the postgres data volume across CI jobs** if `RESET=true`
   is dropped — but that contradicts harness determinism, so
   probably not worth it.

The 2-minute warm-up is acceptable for periodic CI runs. For a tight
inner-loop dev experience the harness should default to `stub-indexer`
(per ADR-002 "stub-only retained for fast-path tests") and only spin
up the real indexers under the `--full-stack` flag.

---

## Recommendation for ADR-002 update

**Resolved (no further work):**

- **Open question 1 (`START_BLOCK`).** The answer is "no env, but
  pre-seeded `_metadatas.last_indexed_block` works cleanly". Update
  the ADR to specify Option (A): a one-shot init container (or
  init-step inside `orchestrator/services.mjs::startLocalIndexers`)
  that, after `checkpoint.reset()` completes and before
  `checkpoint.start()` runs, executes the `INSERT … ON CONFLICT`
  shown above with `value = anvil.forkBlockNumber - 1`. Document
  that templates auto-pick-up at runtime so no template seeding is
  needed.
- **Open question 2 (`GNOSIS_BLOCK_RANGE`).** It is the per-batch
  `eth_getLogs` window. Set `GNOSIS_BLOCK_RANGE=100` (and
  `MAINNET_BLOCK_RANGE=100` if/when the candles indexer is wired)
  in the harness compose. Document the env-var convention
  `${INDEXER_NAME_UPPER}_BLOCK_RANGE` for future chains.
- **Open question 3 (Anvil RPC).** Compatibility is **complete** for
  the EVM path — no `trace_*` or other non-standard methods are used.
  No risk. Strike the "Spike: try pointing the registry indexer at
  anvil and see what errors surface" task; that empirical check is
  no longer required (though running it once during slice 4 won't
  hurt).

**Still needs empirical work (do during slice 4):**

- **Open question 4 (cold-start time).** The 50-90s estimate is from
  code inspection only. Slice 4 should add a benchmark that records
  wall-clock for `RESET=true docker compose up --build` cold and
  warm. If cold first-run on the GitHub Actions runner exceeds
  120s, revisit the GHCR pre-build option.

**New consideration surfaced by the spike:**

- **Bootstrap row order matters.** The init step that writes
  `last_indexed_block` MUST run AFTER the indexer's
  `checkpoint.reset()` completes (which itself zeros that row),
  otherwise the seed is wiped. Two patterns work:
  1. Don't pass `RESET=true`. Instead the init container does the
     `_metadatas` insert AND creates the four `_*` tables itself
     (matching the schema in `stores/checkpoints.js:122-153`).
     Also pre-creates the entity tables — cumbersome and brittle to
     schema changes.
  2. Pass `RESET=true`, then have a small wrapper script in the
     indexer container that polls for `_metadatas` to exist with
     `last_indexed_block=0`, runs the bootstrap UPDATE, and execs
     the original `npm run dev`. This is cleaner and still
     compose-only (no surgery to user code).

  Recommend pattern (2). Add a new "Implementation sketch" subsection
  to ADR-002 covering the wrapper script.
