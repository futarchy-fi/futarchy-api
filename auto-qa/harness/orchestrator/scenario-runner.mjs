#!/usr/bin/env node
/**
 * scenario-runner.mjs — entry point for the harness orchestrator
 * container (Phase 7 slice 4d).
 *
 * Reads service URLs from env, runs the cross-layer invariant
 * battery from invariants.mjs, exits with code 0 if all pass or 1
 * if any fail.
 *
 * Two topology modes (gated on HARNESS_COMPOSE):
 *
 *   compose mode (HARNESS_COMPOSE=1):
 *     The full stack (anvil + api + indexers) is already up via
 *     `docker compose -f auto-qa/harness/docker-compose.yml up -d`.
 *     This script just hits the existing compose-internal endpoints.
 *
 *   native mode (HARNESS_COMPOSE unset):
 *     The stack is brought up by the existing
 *     `scripts/start-fork.mjs` + `scripts/start-indexers.mjs` flow.
 *     Native mode delegates to those scripts; not yet implemented
 *     here (slice 4d-scenarios deliberately scopes to compose mode
 *     first; native-mode wrapper is a follow-up slice).
 *
 * Dry-run mode (HARNESS_DRY_RUN=1):
 *     Print the registered invariant catalog and exit 0 without
 *     making any network calls. Useful for offline structural
 *     validation (the bot uses this to verify the runner before
 *     compose is up).
 *
 * Usage:
 *   HARNESS_COMPOSE=1 HARNESS_DRY_RUN=1 \
 *     node auto-qa/harness/orchestrator/scenario-runner.mjs
 *
 *   HARNESS_COMPOSE=1 \
 *     API_URL=http://localhost:3031 \
 *     REGISTRY_URL=http://localhost:3003/graphql \
 *     node auto-qa/harness/orchestrator/scenario-runner.mjs
 */

import { runAllInvariants, INVARIANTS } from './invariants.mjs';

const ctx = {
    apiUrl: process.env.API_URL ?? 'http://localhost:3031',
    registryUrl: process.env.REGISTRY_URL ?? 'http://localhost:3003/graphql',
    candlesUrl: process.env.CANDLES_URL ?? 'http://localhost:3001/graphql',
    rpcUrl: process.env.RPC_URL ?? 'http://localhost:8545',
};

const composeMode = process.env.HARNESS_COMPOSE === '1';
const dryRun = process.env.HARNESS_DRY_RUN === '1';

function log(...args) {
    console.log('[scenario-runner]', ...args);
}

log(`mode=${composeMode ? 'compose' : 'native'}  dry-run=${dryRun}`);
log('ctx:', ctx);
log(`invariants registered: ${INVARIANTS.length}`);

if (!composeMode) {
    console.error(
        '[scenario-runner] native mode not yet supported by this entry point.\n' +
        '  Use scripts/start-fork.mjs + scripts/start-indexers.mjs + tests/ directly.\n' +
        '  Slice 4d-native (future) will wrap them.'
    );
    process.exit(2);
}

if (dryRun) {
    log('--- invariant catalog ---');
    for (const inv of INVARIANTS) {
        console.log(`  - ${inv.name.padEnd(24)}  [${inv.layer}]  ${inv.description}`);
    }
    log('dry-run complete; no network calls made; exiting 0.');
    process.exit(0);
}

log('running invariants…');
const { pass, results } = await runAllInvariants(ctx);

for (const r of results) {
    const icon = r.ok ? 'PASS' : 'FAIL';
    const detail = r.ok ? r.detail : r.error;
    console.log(`  [${icon}] ${r.name.padEnd(24)} [${r.layer}]  ${detail}`);
}

const passCount = results.filter(r => r.ok).length;
log(`${passCount}/${results.length} invariants passed`);

process.exit(pass ? 0 : 1);
