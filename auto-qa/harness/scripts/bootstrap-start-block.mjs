#!/usr/bin/env node
/**
 * bootstrap-start-block.mjs — pre-seed `_metadatas.last_indexed_block`
 * so the Checkpoint indexer skips from genesis to anvil's fork block.
 *
 * Per Spike-001 (`docs/spike-001-checkpoint-anvil-compat.md`):
 *
 *   `Container.getStartBlockNum()` reads
 *     `_metadatas.last_indexed_block` from postgres at indexer start
 *   and returns `max(configStart, lastBlock + 1)`. Pre-seeding this
 *   row to (forkBlock - 1) makes the indexer start exactly at
 *   forkBlock — matching what anvil knows about.
 *
 * This script runs the SQL via `docker compose exec postgres psql`,
 * so no host psql install is required.
 *
 * Usage:
 *   node scripts/bootstrap-start-block.mjs --kind registry --start 46100000
 *   node scripts/bootstrap-start-block.mjs --kind candles  --start 46100000
 *   node scripts/bootstrap-start-block.mjs --read   --kind registry
 *
 * Public surface (programmatic):
 *   await bootstrapStartBlock({ kind: 'registry', startBlock: 46100000 });
 *   const v = await readStartBlock({ kind: 'registry' });
 *
 * The `kind` argument selects the indexer:
 *   'registry' → futarchy-harness-registry compose project,
 *                postgres service "registry-postgres",
 *                indexer row "gnosis"
 *   'candles'  → futarchy-harness-candles  compose project,
 *                postgres service "postgres",
 *                indexer row "gnosis"
 *
 * Exit codes:
 *   0 — success
 *   1 — argument validation failed
 *   2 — sibling indexer clone not found
 *   3 — docker daemon unreachable / postgres not running
 *   4 — SQL execution failed
 */

import { spawn, spawnSync } from 'node:child_process';
import { requireIndexers } from './detect-indexers.mjs';

// Per the futarchy-indexers user code, both indexers register their
// Gnosis source under the name 'gnosis'. The candles indexer also
// registers 'mainnet' but the harness doesn't fork mainnet, so we
// bootstrap only 'gnosis' here.
const DEFAULT_INDEXER_NAME = 'gnosis';

const KIND_CONFIG = {
    registry: {
        project: 'futarchy-harness-registry',
        postgresService: 'registry-postgres',  // service name from compose
        composeKey: 'registry',                // key in detect-indexers result
    },
    candles: {
        project: 'futarchy-harness-candles',
        postgresService: 'postgres',
        composeKey: 'candles',
    },
};

// ───────────────────────────────────────────────────────────────────
// CLI parsing
// ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = {
        kind: null,
        startBlock: null,
        indexerName: DEFAULT_INDEXER_NAME,
        read: false,
    };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const k = args[i];
        const v = args[i + 1];
        switch (k) {
            case '--kind':           out.kind = v; i++; break;
            case '--start':          out.startBlock = Number(v); i++; break;
            case '--indexer-name':   out.indexerName = v; i++; break;
            case '--read':           out.read = true; break;
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

function validate(opts) {
    if (opts.help) return null;
    if (!opts.kind) return 'missing required --kind <registry|candles>';
    if (!KIND_CONFIG[opts.kind]) {
        return `--kind must be one of: ${Object.keys(KIND_CONFIG).join(', ')}`;
    }
    if (!opts.read) {
        if (opts.startBlock === null) return 'missing required --start <block>';
        if (!Number.isInteger(opts.startBlock) || opts.startBlock < 0) {
            return '--start must be a non-negative integer';
        }
    }
    return null;
}

function printHelp() {
    process.stdout.write(`bootstrap-start-block.mjs — Forked Replay Harness

Pre-seed the Checkpoint indexer's last_indexed_block so it starts
indexing at exactly the anvil fork height (not from genesis).

Usage:
  node scripts/bootstrap-start-block.mjs --kind <registry|candles> --start <block>
  node scripts/bootstrap-start-block.mjs --kind <registry|candles> --read

Options:
  --kind <kind>         Which indexer postgres to seed: registry or candles
  --start <block>       Block to seed (writes lastBlock = start - 1 so the
                        next mined block is "start")
  --read                Print the current last_indexed_block instead of
                        writing
  --indexer-name <s>    Indexer name in the _metadatas table
                        (default: ${DEFAULT_INDEXER_NAME})
  -h, --help            Show this help

Requires the corresponding indexer compose project to be UP (run
\`node scripts/start-indexers.mjs\` first).
`);
}

// ───────────────────────────────────────────────────────────────────
// Docker availability
// ───────────────────────────────────────────────────────────────────

function dockerAvailable() {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

// ───────────────────────────────────────────────────────────────────
// SQL execution via docker compose exec postgres psql
// ───────────────────────────────────────────────────────────────────

function execPsql(opts, sql) {
    const cfg = KIND_CONFIG[opts.kind];
    const composePath = opts.composePath; // pre-resolved
    const dbName = opts.kind === 'registry' ? 'checkpoint_registry' : 'checkpoint_candles';

    return new Promise((resolve, reject) => {
        const child = spawn(
            'docker',
            [
                'compose',
                '-f', composePath,
                '-p', cfg.project,
                'exec', '-T',
                cfg.postgresService,
                'psql', '-U', 'checkpoint', '-d', dbName,
                '-v', 'ON_ERROR_STOP=1', '-A', '-t',
                '-c', sql,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(
                `psql exited ${code} for kind=${opts.kind}: ${stderr.slice(-300)}`,
            ));
        });
    });
}

// ───────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────

/**
 * Pre-seed the indexer's last_indexed_block.
 *
 * @param {Object} opts
 * @param {'registry'|'candles'} opts.kind
 * @param {number} opts.startBlock — the FIRST block we want indexed.
 *     We write `lastBlock = startBlock - 1` so the indexer's next
 *     scan begins at startBlock.
 * @param {string} [opts.indexerName] — defaults to 'gnosis'
 * @returns {Promise<{written: number}>}
 */
export async function bootstrapStartBlock({
    kind,
    startBlock,
    indexerName = DEFAULT_INDEXER_NAME,
}) {
    if (!KIND_CONFIG[kind]) throw new Error(`unknown kind: ${kind}`);
    if (!Number.isInteger(startBlock) || startBlock < 1) {
        throw new Error('startBlock must be a positive integer');
    }

    const indexers = await requireIndexers();
    const composePath = indexers[KIND_CONFIG[kind].composeKey].compose;

    const lastBlock = startBlock - 1;
    // varchar(128) — quote as text to dodge SQL number-type quirks.
    const sql = `
        INSERT INTO _metadatas (id, indexer, value)
        VALUES ('last_indexed_block', '${indexerName}', '${lastBlock}')
        ON CONFLICT (id, indexer) DO UPDATE SET value = EXCLUDED.value;
    `.replace(/\s+/g, ' ').trim();

    if (!dockerAvailable()) {
        const err = new Error('docker daemon not reachable');
        err.code = 'DOCKER_DOWN';
        throw err;
    }

    await execPsql({ kind, composePath }, sql);
    return { written: lastBlock };
}

/**
 * Read the current last_indexed_block.
 *
 * @param {Object} opts
 * @param {'registry'|'candles'} opts.kind
 * @param {string} [opts.indexerName] — defaults to 'gnosis'
 * @returns {Promise<number|null>}
 */
export async function readStartBlock({
    kind,
    indexerName = DEFAULT_INDEXER_NAME,
}) {
    if (!KIND_CONFIG[kind]) throw new Error(`unknown kind: ${kind}`);

    const indexers = await requireIndexers();
    const composePath = indexers[KIND_CONFIG[kind].composeKey].compose;

    if (!dockerAvailable()) {
        const err = new Error('docker daemon not reachable');
        err.code = 'DOCKER_DOWN';
        throw err;
    }

    const sql =
        `SELECT value FROM _metadatas ` +
        `WHERE id='last_indexed_block' AND indexer='${indexerName}' LIMIT 1`;

    const out = await execPsql({ kind, composePath }, sql);
    if (!out) return null;
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
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
    const err = validate(opts);
    if (err) {
        console.error(`✗ ${err}`);
        printHelp();
        process.exit(1);
    }

    try {
        if (opts.read) {
            const v = await readStartBlock({
                kind: opts.kind,
                indexerName: opts.indexerName,
            });
            console.log(JSON.stringify({
                kind: opts.kind,
                indexer: opts.indexerName,
                lastIndexedBlock: v,
            }, null, 2));
            process.exit(0);
        }
        const r = await bootstrapStartBlock({
            kind: opts.kind,
            startBlock: opts.startBlock,
            indexerName: opts.indexerName,
        });
        console.error(
            `✓ ${opts.kind}: wrote last_indexed_block=${r.written} ` +
                `(next scan begins at ${opts.startBlock})`,
        );
        process.exit(0);
    } catch (e) {
        if (e.code === 'INDEXERS_NOT_FOUND') {
            console.error(e.message);
            process.exit(2);
        }
        if (e.code === 'DOCKER_DOWN') {
            console.error(`✗ ${e.message}`);
            process.exit(3);
        }
        console.error(`✗ ${e.message}`);
        process.exit(4);
    }
}
