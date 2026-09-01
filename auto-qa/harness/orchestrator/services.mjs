/**
 * services.mjs — process-level helpers for the harness orchestrator.
 *
 * Phase 2 minimum surface: spawn anvil fork, spawn local futarchy-api,
 * await readiness, expose graceful shutdown.
 *
 * The orchestrator (and tests) import these helpers rather than
 * reimplementing the spawn/probe/cleanup dance per test.
 *
 * Public surface:
 *   startAnvilFork({ port, forkUrl, chainId })  → { url, child, stop() }
 *   startLocalApi({ port, env })                → { url, child, stop() }
 *   stopAll(handles)                            → graceful SIGTERM all
 *
 * All `stop()` callers wait for the child process to exit before
 * resolving — orchestrators can rely on clean teardown.
 */

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { requireAnvil } from '../scripts/detect-anvil.mjs';

// ───────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const START_FORK_PATH = new URL(
    '../scripts/start-fork.mjs',
    import.meta.url,
).pathname;

// ───────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────

async function pollHttp(url, { method = 'GET', body = null, timeoutMs = READY_TIMEOUT_MS } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const opts = { method };
            if (body) {
                opts.headers = { 'Content-Type': 'application/json' };
                opts.body = JSON.stringify(body);
            }
            const r = await fetch(url, opts);
            if (r.ok) {
                return { ok: true, elapsedMs: Date.now() - start, response: r };
            }
        } catch {
            // not ready yet
        }
        await wait(READY_POLL_MS);
    }
    return { ok: false, elapsedMs: Date.now() - start };
}

async function gracefulKill(child) {
    if (!child || child.killed || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
    });
}

// ───────────────────────────────────────────────────────────────────
// Anvil fork
// ───────────────────────────────────────────────────────────────────

/**
 * Spawn an anvil fork via start-fork.mjs.
 *
 * @param {Object}  opts
 * @param {number}  opts.port      — RPC port to bind (default 8545)
 * @param {string} [opts.forkUrl]  — RPC to fork from (default Gnosis gateway.fm)
 * @param {number} [opts.chainId]  — chain ID to report (default 100)
 * @returns {Promise<{url: string, child: ChildProcess, stop: () => Promise<void>}>}
 */
export async function startAnvilFork({
    port = 8545,
    forkUrl = process.env.FORK_URL || 'https://rpc.gnosis.gateway.fm',
    chainId = 100,
} = {}) {
    // Pre-flight: ensure foundry is on PATH so the failure mode is
    // clear instead of a dangling "anvil not found" stack trace.
    await requireAnvil();

    const args = [
        START_FORK_PATH,
        '--port', String(port),
        '--chain-id', String(chainId),
        '--fork-url', forkUrl,
    ];
    const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let resolved = false;
    const ready = new Promise((resolve, reject) => {
        const onReady = () => {
            if (resolved) return;
            resolved = true;
            resolve();
        };
        child.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString();
            if (/^READY\s+\d+/m.test(stdoutBuf)) onReady();
        });
        child.stderr.on('data', (c) => {
            process.stderr.write(`[anvil] ${c}`);
        });
        child.once('exit', (code, signal) => {
            if (!resolved) {
                reject(new Error(
                    `start-fork exited before READY (code=${code}, signal=${signal})`,
                ));
            }
        });
        const timer = setTimeout(() => {
            if (resolved) return;
            child.kill('SIGTERM');
            reject(new Error(
                `start-fork did not emit READY within ${READY_TIMEOUT_MS}ms`,
            ));
        }, READY_TIMEOUT_MS);
        timer.unref();
    });

    await ready;
    const url = `http://127.0.0.1:${port}`;
    return {
        url,
        child,
        stop: () => gracefulKill(child),
    };
}

// ───────────────────────────────────────────────────────────────────
// Local futarchy-api
// ───────────────────────────────────────────────────────────────────

/**
 * Spawn a local futarchy-api (src/index.js) as a child process.
 *
 * NOTE: src/index.js hardcodes PORT = 3031 — it does NOT read PORT
 * from env. So `port` here is the value we PROBE, and it must match
 * the hardcoded value. We expose the parameter to make it easy to
 * adapt later if the api becomes env-configurable.
 *
 * @param {Object}  opts
 * @param {number} [opts.port]  — port to probe (default 3031)
 * @param {Object} [opts.env]   — extra env vars to inject
 * @returns {Promise<{url: string, child: ChildProcess, stop: () => Promise<void>}>}
 */
export async function startLocalApi({
    port = 3031,
    env = {},
} = {}) {
    const child = spawn(
        process.execPath,
        ['src/index.js'],
        {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        },
    );

    let stdoutSeen = '';
    child.stdout.on('data', (chunk) => {
        stdoutSeen += chunk.toString();
        // Tee to our stderr (prefixed) so failures are diagnosable.
        process.stderr.write(`[api] ${chunk}`);
    });
    child.stderr.on('data', (chunk) => {
        process.stderr.write(`[api:err] ${chunk}`);
    });

    let earlyExit = null;
    child.once('exit', (code, signal) => {
        if (!earlyExit) {
            earlyExit = { code, signal };
        }
    });

    // Probe /health.
    const healthUrl = `http://127.0.0.1:${port}/health`;
    const probe = await pollHttp(healthUrl);

    if (!probe.ok) {
        await gracefulKill(child);
        if (earlyExit) {
            throw new Error(
                `futarchy-api exited before /health was reachable ` +
                    `(code=${earlyExit.code}, signal=${earlyExit.signal}). ` +
                    `Stdout tail: ${stdoutSeen.slice(-500)}`,
            );
        }
        throw new Error(
            `futarchy-api /health did not respond within ${READY_TIMEOUT_MS}ms ` +
                `at ${healthUrl}`,
        );
    }

    return {
        url: `http://127.0.0.1:${port}`,
        child,
        stop: () => gracefulKill(child),
    };
}

// ───────────────────────────────────────────────────────────────────
// Multi-service convenience
// ───────────────────────────────────────────────────────────────────

/**
 * Stop a list of service handles in parallel.
 */
export async function stopAll(handles) {
    await Promise.allSettled(handles.map((h) => h?.stop?.()));
}

/**
 * Stop service handles in dependency order — earlier handles in the
 * array are stopped FIRST. Each step waits for the previous to complete.
 *
 * Use this for stacks where ordering matters:
 *   - Indexer must stop BEFORE anvil (otherwise it loops trying to
 *     reach a dead RPC until its retry budget exhausts)
 *   - Api can stop BEFORE indexer (no retry-on-RPC-down behavior)
 *   - Stub-indexer is stop-anywhere (no upstream)
 *
 * Recommended order for the full Phase 3+ stack:
 *   stopOrdered([interfaceDev, api, indexer, anvil])
 *
 * Errors during one stop don't prevent later stops — each is wrapped
 * in try/catch and logged to stderr.
 */
export async function stopOrdered(handles) {
    for (const h of handles) {
        if (!h?.stop) continue;
        try {
            await h.stop();
        } catch (err) {
            process.stderr.write(
                `[stopOrdered] error stopping handle ${h.url || '<unknown>'}: ${err?.message}\n`,
            );
        }
    }
}
