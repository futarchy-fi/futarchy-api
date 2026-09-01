#!/usr/bin/env node
/**
 * start-indexers.mjs — bring up the two Checkpoint indexers (registry +
 * candles) via docker compose, configured to ingest from the harness
 * anvil fork.
 *
 * Per ADR-002 + Spike-001:
 *   - Indexer source lives in a sibling clone (futarchy-indexers).
 *     Discovered via scripts/detect-indexers.mjs.
 *   - Each indexer runs as its OWN compose project (registry +
 *     postgres in one project, candles + postgres in another) so the
 *     existing futarchy-indexers compose files don't need to be
 *     modified.
 *   - Env overrides drive RPC + reset + batch size:
 *       RPC_URL              → registry indexer's Gnosis RPC
 *       GNOSIS_RPC_URL       → candles indexer's Gnosis RPC
 *       RESET=true           → fresh DB on every harness start
 *       GNOSIS_BLOCK_RANGE   → per-batch eth_getLogs window
 *                              (small for harness, ~100, since anvil
 *                              only knows blocks at/after fork-block)
 *
 * Network shape:
 *   - Anvil runs natively on the host (port 8546 by default per the
 *     existing test pattern). Indexers in docker reach it via
 *     `host.docker.internal:<port>` on Mac/Windows.
 *   - Linux: the indexer container can't reach the host without an
 *     explicit `--add-host=host.docker.internal:host-gateway`. The
 *     harness will add this when ANVIL_HOST_URL is unset.
 *     (Auto-detection deferred — for now Linux users must set
 *     ANVIL_HOST_URL=http://172.17.0.1:8546 explicitly.)
 *
 * Usage:
 *   node scripts/start-indexers.mjs --anvil-port 8546
 *   node scripts/start-indexers.mjs --no-reset           # resume DB
 *   node scripts/start-indexers.mjs --stop               # tear down
 *
 * Public surface (programmatic):
 *   import { startIndexers, stopIndexers } from './start-indexers.mjs';
 *   const handle = await startIndexers({ anvilPort: 8546 });
 *   // handle = { registryUrl, candlesUrl, stop() }
 *
 * Exit codes:
 *   0 — indexers running (or stopped, in --stop mode)
 *   1 — argument validation failed
 *   2 — sibling clone not found (run detect-indexers for hint)
 *   3 — docker daemon unreachable
 *   4 — compose up failed (build error, image pull error, etc.)
 *   5 — readiness probe timed out (indexer didn't reach `head`)
 */

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { requireIndexers } from './detect-indexers.mjs';

const REGISTRY_PROJECT = 'futarchy-harness-registry';
const CANDLES_PROJECT  = 'futarchy-harness-candles';

const REGISTRY_HOST_PORT = 3003;  // matches futarchy-indexers compose
const CANDLES_HOST_PORT  = 3001;

const READY_TIMEOUT_MS = 180_000;  // first run includes Docker build
const READY_POLL_MS = 2_000;

// ───────────────────────────────────────────────────────────────────
// CLI parsing
// ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = {
        anvilPort: 8546,
        anvilHostUrl: process.env.ANVIL_HOST_URL || null,
        reset: true,
        blockRange: 100,
        stop: false,
        registryOnly: false,
        candlesOnly: false,
    };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const k = args[i];
        const v = args[i + 1];
        switch (k) {
            case '--anvil-port':     out.anvilPort = Number(v); i++; break;
            case '--anvil-host-url': out.anvilHostUrl = v; i++; break;
            case '--block-range':    out.blockRange = Number(v); i++; break;
            case '--reset':          out.reset = true; break;
            case '--no-reset':       out.reset = false; break;
            case '--stop':           out.stop = true; break;
            case '--registry-only':  out.registryOnly = true; break;
            case '--candles-only':   out.candlesOnly = true; break;
            case '-h':
            case '--help':           out.help = true; break;
            default:
                if (k?.startsWith('--')) {
                    console.error(`Unknown flag: ${k}`);
                    process.exit(1);
                }
        }
    }
    return out;
}

function printHelp() {
    process.stdout.write(`start-indexers.mjs — Forked Replay Harness

Brings up registry + candles Checkpoint indexers via docker compose,
configured to ingest from the harness anvil fork.

Usage:
  node scripts/start-indexers.mjs [options]

Options:
  --anvil-port <n>          Native anvil port to point indexers at (default 8546)
  --anvil-host-url <url>    Full URL override (default http://host.docker.internal:<port>;
                            on Linux set http://172.17.0.1:<port>)
  --block-range <n>         GNOSIS_BLOCK_RANGE for indexers (default 100)
  --reset                   Force fresh DB (default — harness always resets)
  --no-reset                Resume from last DB state
  --stop                    Bring down both indexer projects
  --registry-only           Only manage the registry indexer
  --candles-only            Only manage the candles indexer
  -h, --help                Show this help

Phase 3 slice 2 — does NOT yet wait for the indexer to reach anvil's
head. That's slice 3 (psql last_indexed_block injection + readiness
probe). For now, --no-reset returns immediately after compose up;
--reset waits for the indexer to start indexing (reach block 1+).
`);
}

// ───────────────────────────────────────────────────────────────────
// Docker availability check
// ───────────────────────────────────────────────────────────────────

function dockerAvailable() {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

// ───────────────────────────────────────────────────────────────────
// Compose helpers
// ───────────────────────────────────────────────────────────────────

function composeEnvFor(opts, kind) {
    const url = opts.anvilHostUrl || `http://host.docker.internal:${opts.anvilPort}`;
    const env = {
        ...process.env,
        RESET: opts.reset ? 'true' : 'false',
        GNOSIS_BLOCK_RANGE: String(opts.blockRange),
    };
    if (kind === 'registry') {
        env.RPC_URL = url;
    } else {
        env.GNOSIS_RPC_URL = url;
    }
    return env;
}

function composeUp(composePath, project, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'docker',
            ['compose', '-f', composePath, '-p', project, 'up', '-d', '--build'],
            { stdio: ['ignore', 'pipe', 'pipe'], env },
        );
        let stderrBuf = '';
        child.stdout.on('data', (c) => process.stderr.write(`[${project}] ${c}`));
        child.stderr.on('data', (c) => {
            stderrBuf += c.toString();
            process.stderr.write(`[${project}:err] ${c}`);
        });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`compose up failed (code=${code}): ${stderrBuf.slice(-500)}`));
        });
    });
}

function composeDown(composePath, project) {
    return new Promise((resolve) => {
        const child = spawn(
            'docker',
            ['compose', '-f', composePath, '-p', project, 'down', '-v', '--timeout', '5'],
            { stdio: 'ignore' },
        );
        child.on('exit', () => resolve()); // best-effort
    });
}

async function probeGraphQL(url) {
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{__typename}' }),
        });
        if (r.ok) {
            const j = await r.json();
            // checkpoint may return errors during early init; treat any
            // 200 with parseable JSON as "ready to accept queries".
            return { ok: true, body: j };
        }
        return { ok: false, status: r.status };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function awaitReady(name, url, timeoutMs = READY_TIMEOUT_MS) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        last = await probeGraphQL(url);
        if (last.ok) return { ok: true, elapsedMs: Date.now() - start };
        await wait(READY_POLL_MS);
    }
    return {
        ok: false,
        elapsedMs: Date.now() - start,
        reason: `${name} GraphQL did not respond within ${timeoutMs}ms ` +
            `(last: ${last?.error || `status ${last?.status}`})`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────

/**
 * Start the indexer stack. Returns a handle for cleanup.
 *
 * @param {Object} opts — see CLI flags above for shape.
 * @returns {Promise<{
 *   registryUrl?: string,
 *   candlesUrl?: string,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startIndexers(opts = {}) {
    const merged = {
        anvilPort: 8546,
        anvilHostUrl: null,
        reset: true,
        blockRange: 100,
        registryOnly: false,
        candlesOnly: false,
        ...opts,
    };

    if (!dockerAvailable()) {
        const err = new Error(
            '[harness] docker daemon not reachable (start Docker Desktop)',
        );
        err.code = 'DOCKER_DOWN';
        throw err;
    }

    const indexers = await requireIndexers();
    const handles = [];

    if (!merged.candlesOnly) {
        const env = composeEnvFor(merged, 'registry');
        await composeUp(indexers.registry.compose, REGISTRY_PROJECT, env);
        handles.push({
            kind: 'registry',
            compose: indexers.registry.compose,
            project: REGISTRY_PROJECT,
        });
    }
    if (!merged.registryOnly) {
        const env = composeEnvFor(merged, 'candles');
        await composeUp(indexers.candles.compose, CANDLES_PROJECT, env);
        handles.push({
            kind: 'candles',
            compose: indexers.candles.compose,
            project: CANDLES_PROJECT,
        });
    }

    const registryUrl = merged.candlesOnly ? undefined
        : `http://127.0.0.1:${REGISTRY_HOST_PORT}/graphql`;
    const candlesUrl  = merged.registryOnly ? undefined
        : `http://127.0.0.1:${CANDLES_HOST_PORT}/graphql`;

    return {
        registryUrl,
        candlesUrl,
        async stop() { return stopIndexers(handles); },
    };
}

/**
 * Bring down all indexer projects launched by startIndexers.
 *
 * If called with no argument, tears down the well-known projects
 * (REGISTRY_PROJECT + CANDLES_PROJECT) regardless of whether this
 * process started them. Useful for cleanup after a crash.
 */
export async function stopIndexers(handles) {
    if (!handles) {
        const indexers = await requireIndexers();
        handles = [
            { kind: 'registry', compose: indexers.registry.compose, project: REGISTRY_PROJECT },
            { kind: 'candles',  compose: indexers.candles.compose,  project: CANDLES_PROJECT  },
        ];
    }
    // Stop in reverse-start order (candles first), best-effort.
    for (const h of handles.reverse()) {
        await composeDown(h.compose, h.project);
    }
}

// ───────────────────────────────────────────────────────────────────
// CLI entry
// ───────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
    const opts = parseArgs(process.argv);

    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    if (opts.stop) {
        if (!dockerAvailable()) {
            console.error('✗ docker daemon not reachable');
            process.exit(3);
        }
        console.error('[start-indexers] stopping both projects…');
        await stopIndexers();
        console.error('[start-indexers] done');
        process.exit(0);
    }

    try {
        const handle = await startIndexers(opts);
        if (handle.registryUrl) {
            // Optional readiness wait — controlled by env to keep CLI
            // fast for "spawn and forget" usage. Set HARNESS_WAIT=1 to
            // poll until the indexers respond to GraphQL.
            if (process.env.HARNESS_WAIT === '1') {
                console.error(`[start-indexers] waiting for ${handle.registryUrl}…`);
                const r = await awaitReady('registry', handle.registryUrl);
                if (!r.ok) {
                    console.error(`✗ ${r.reason}`);
                    process.exit(5);
                }
                console.error(`[start-indexers] registry ready in ${r.elapsedMs}ms`);
            }
            console.error(`✓ registry: ${handle.registryUrl}`);
        }
        if (handle.candlesUrl) {
            if (process.env.HARNESS_WAIT === '1') {
                console.error(`[start-indexers] waiting for ${handle.candlesUrl}…`);
                const r = await awaitReady('candles', handle.candlesUrl);
                if (!r.ok) {
                    console.error(`✗ ${r.reason}`);
                    process.exit(5);
                }
                console.error(`[start-indexers] candles ready in ${r.elapsedMs}ms`);
            }
            console.error(`✓ candles:  ${handle.candlesUrl}`);
        }
        // Print machine-parseable output on stdout.
        console.log(JSON.stringify({
            registryUrl: handle.registryUrl,
            candlesUrl:  handle.candlesUrl,
        }));
        process.exit(0);
    } catch (err) {
        if (err.code === 'INDEXERS_NOT_FOUND') {
            console.error(err.message);
            process.exit(2);
        }
        if (err.code === 'DOCKER_DOWN') {
            console.error(`✗ ${err.message}`);
            process.exit(3);
        }
        console.error(`✗ ${err.message}`);
        process.exit(4);
    }
}
