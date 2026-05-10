#!/usr/bin/env node
/**
 * start-fork.mjs — anvil fork launcher for the Forked Replay Harness.
 *
 * Phase 0 SCAFFOLD ONLY. This script parses arguments and prints help
 * but does NOT yet launch anvil. The actual subprocess + readiness
 * polling lands in Phase 1.
 *
 * Usage (eventual):
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
 * Exit codes:
 *   0 — fork running, ready for connections
 *   1 — argument validation failed
 *   2 — anvil binary not found on PATH
 *   3 — fork URL unreachable
 *   4 — readiness probe timed out
 */

const DEFAULTS = {
    forkUrl: process.env.FORK_URL || 'https://rpc.gnosis.gateway.fm',
    forkBlock: process.env.FORK_BLOCK || 'latest',
    port: Number(process.env.ANVIL_PORT) || 8545,
    chainId: Number(process.env.ANVIL_CHAIN_ID) || 100,
    accounts: 10,
    balance: 10_000,
};

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

Phase 0 scaffold; does not launch anvil yet.

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

Phase 1 will add:
  - anvil binary discovery + version check
  - subprocess launch with the resolved options
  - readiness probe (cast block-number polling until <30s)
  - SIGINT/SIGTERM forwarding to clean shutdown
  - structured stdout: emit "READY <port>\\n" on the parent's stdout
    once polling succeeds, so the orchestrator can await it
`);
}

const opts = parseArgs(process.argv);

if (opts.help) {
    printHelp();
    process.exit(0);
}

console.log('[start-fork] Phase 0 scaffold — would launch anvil with:');
console.log(JSON.stringify(opts, null, 2));
console.log('[start-fork] TODO Phase 1: actually spawn anvil subprocess.');
process.exit(0);
