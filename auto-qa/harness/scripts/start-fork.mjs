#!/usr/bin/env node
/**
 * start-fork.mjs — anvil fork launcher for the Forked Replay Harness.
 *
 * Phase 1: real subprocess spawn + readiness probe + signal forwarding.
 *
 * Usage:
 *   node scripts/start-fork.mjs \
 *       --fork-url <RPC URL> \
 *       --fork-block <number|"latest"> \
 *       --port 8545 \
 *       --chain-id 100 \
 *       --accounts 10 \
 *       --balance 10000
 *
 * Environment fallbacks:
 *   FORK_URL         default: https://rpc.gnosis.gateway.fm
 *   FORK_BLOCK       default: latest
 *   ANVIL_PORT       default: 8545
 *   ANVIL_CHAIN_ID   default: 100
 *
 * Behavior:
 *   - Spawns anvil with the resolved options.
 *   - Streams anvil's stdout/stderr to this process's stderr (prefixed).
 *   - Polls eth_blockNumber via JSON-RPC until success or 30s timeout.
 *   - On success, emits exactly one line on stdout: "READY <port>".
 *     Orchestrators should await this line to know the fork is up.
 *   - Forwards SIGINT/SIGTERM to anvil for clean shutdown.
 *   - Exits with anvil's exit code when anvil exits.
 *
 * Exit codes:
 *   0 — anvil exited cleanly
 *   1 — argument validation failed
 *   2 — anvil binary not found on PATH
 *   3 — fork URL unreachable / anvil failed to start
 *   4 — readiness probe timed out (30s)
 *   <n> — anvil's own exit code if it crashes
 */

import { spawn } from 'node:child_process';
import { requireAnvil } from './detect-anvil.mjs';

const DEFAULTS = {
    forkUrl: process.env.FORK_URL || 'https://rpc.gnosis.gateway.fm',
    forkBlock: process.env.FORK_BLOCK || 'latest',
    port: Number(process.env.ANVIL_PORT) || 8545,
    chainId: Number(process.env.ANVIL_CHAIN_ID) || 100,
    accounts: 10,
    balance: 10_000,
};

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 250;

function parseArgs(argv) {
    const out = { ...DEFAULTS };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const k = args[i];
        const v = args[i + 1];
        switch (k) {
            case '--fork-url':       out.forkUrl = v; i++; break;
            case '--fork-block':     out.forkBlock = v; i++; break;
            case '--port':           out.port = Number(v); i++; break;
            case '--chain-id':       out.chainId = Number(v); i++; break;
            case '--accounts':       out.accounts = Number(v); i++; break;
            case '--balance':        out.balance = Number(v); i++; break;
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
    process.stdout.write(`start-fork.mjs — Forked Replay Harness

Usage:
  node scripts/start-fork.mjs [options]

Options:
  --fork-url <url>       RPC URL to fork from (env FORK_URL, default ${DEFAULTS.forkUrl})
  --fork-block <n>       Block to fork at (env FORK_BLOCK, default ${DEFAULTS.forkBlock})
  --port <n>             Port for anvil to listen on (env ANVIL_PORT, default ${DEFAULTS.port})
  --chain-id <n>         Chain ID anvil reports (env ANVIL_CHAIN_ID, default ${DEFAULTS.chainId})
  --accounts <n>         Pre-funded test accounts (default ${DEFAULTS.accounts})
  --balance <ETH>        Initial balance per test account (default ${DEFAULTS.balance})
  -h, --help             Show this help and exit
`);
}

function buildAnvilArgs(opts) {
    const args = [
        '--host', '0.0.0.0',
        '--port', String(opts.port),
        '--fork-url', opts.forkUrl,
        '--chain-id', String(opts.chainId),
        '--accounts', String(opts.accounts),
        '--balance', String(opts.balance),
        '--no-mining',                       // we drive blocks via evm_mine
    ];
    if (opts.forkBlock && opts.forkBlock !== 'latest') {
        args.push('--fork-block-number', String(opts.forkBlock));
    }
    return args;
}

async function probeReady(port) {
    const url = `http://127.0.0.1:${port}`;
    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < READINESS_TIMEOUT_MS) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_blockNumber',
                    params: [],
                }),
            });
            if (r.ok) {
                const j = await r.json();
                if (j.result) {
                    return { ready: true, blockNumber: j.result };
                }
            }
        } catch (err) {
            lastError = err;
        }
        await new Promise(res => setTimeout(res, READINESS_POLL_INTERVAL_MS));
    }
    return {
        ready: false,
        elapsedMs: Date.now() - start,
        lastError: lastError?.message || 'no response from anvil',
    };
}

const opts = parseArgs(process.argv);

if (opts.help) {
    printHelp();
    process.exit(0);
}

let anvilInfo;
try {
    anvilInfo = await requireAnvil();
} catch (err) {
    console.error(err.message);
    process.exit(2);
}

console.error(
    `[start-fork] anvil ${anvilInfo.anvil.version} at ${anvilInfo.anvil.path}`,
);
console.error(
    `[start-fork] forking ${opts.forkUrl} @ ${opts.forkBlock} → ` +
        `localhost:${opts.port} (chain ${opts.chainId})`,
);

const anvilArgs = buildAnvilArgs(opts);
const child = spawn(anvilInfo.anvil.path, anvilArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
});

// Stream anvil output through our stderr so the orchestrator's stdout
// stays clean for the "READY" line.
child.stdout.on('data', (chunk) => {
    process.stderr.write(`[anvil] ${chunk}`);
});
child.stderr.on('data', (chunk) => {
    process.stderr.write(`[anvil:err] ${chunk}`);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[start-fork] received ${signal}, forwarding to anvil…`);
    if (!child.killed) child.kill(signal);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
    if (signal) {
        console.error(`[start-fork] anvil exited via ${signal}`);
        process.exit(0);
    }
    console.error(`[start-fork] anvil exited with code ${code}`);
    process.exit(code ?? 0);
});

// Probe readiness in parallel with the spawn.
const probe = await probeReady(opts.port);
if (!probe.ready) {
    console.error(
        `[start-fork] readiness probe FAILED after ${probe.elapsedMs}ms ` +
            `(${probe.lastError})`,
    );
    if (!child.killed) child.kill('SIGTERM');
    process.exit(4);
}

console.error(
    `[start-fork] anvil ready (block ${parseInt(probe.blockNumber, 16)}). ` +
        `Press Ctrl-C to shut down.`,
);
// THE ready signal — orchestrator parses this line.
process.stdout.write(`READY ${opts.port}\n`);
