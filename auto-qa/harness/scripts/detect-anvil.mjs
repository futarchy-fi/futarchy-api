#!/usr/bin/env node
/**
 * detect-anvil.mjs — find anvil/cast/forge on PATH, return structured info.
 *
 * Used by start-fork.mjs and the orchestrator to fail fast with a clear
 * install hint when the Foundry toolchain is missing or out-of-date.
 *
 * Public surface:
 *
 *   import { detectAnvil, requireAnvil, MIN_VERSION } from './detect-anvil.mjs';
 *
 *   const info = await detectAnvil();
 *   //   { found: true, anvil: { path, version, commit }, cast: {...}, forge: {...} }
 *   //   OR
 *   //   { found: false, reason: 'anvil not on PATH', installHint: '...' }
 *
 *   await requireAnvil();   // throws with installHint if not found
 *
 * Run directly:
 *
 *   node scripts/detect-anvil.mjs
 *   node scripts/detect-anvil.mjs --json
 */

import { spawnSync } from 'node:child_process';

// Minimum Foundry version we've validated. Bump after testing on a
// newer version + verifying our spawn args still work.
export const MIN_VERSION = { major: 1, minor: 0, patch: 0 };

const INSTALL_HINT =
    "Install Foundry:\n" +
    "  curl -L https://foundry.paradigm.xyz | bash\n" +
    "  foundryup\n" +
    "Then ensure ~/.foundry/bin is on your PATH.";

function which(bin) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

function getVersion(binPath) {
    if (!binPath) return null;
    const r = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) return null;

    // Output shape (anvil 1.5.0):
    //   anvil Version: 1.5.0-stable
    //   Commit SHA: 1c57854462289b2e71ee7654cd6666217ed86ffd
    //   Build Timestamp: ...
    //   Build Profile: maxperf
    const out = r.stdout || '';
    const versionMatch = out.match(/Version:\s*([\d.]+)(?:-(\w+))?/);
    const commitMatch  = out.match(/Commit SHA:\s*([a-f0-9]+)/i);
    if (!versionMatch) return null;

    const [_, ver, channel] = versionMatch;
    const [major, minor, patch] = ver.split('.').map(Number);
    return {
        version: ver,
        channel: channel || 'release',
        commit: commitMatch ? commitMatch[1] : null,
        major, minor, patch,
    };
}

function meetsMinimum(v) {
    if (!v) return false;
    if (v.major > MIN_VERSION.major) return true;
    if (v.major < MIN_VERSION.major) return false;
    if (v.minor > MIN_VERSION.minor) return true;
    if (v.minor < MIN_VERSION.minor) return false;
    return v.patch >= MIN_VERSION.patch;
}

/**
 * @returns {{
 *   found: boolean,
 *   reason?: string,
 *   installHint?: string,
 *   anvil?: { path: string, version: string, commit: string|null, channel: string, meetsMinimum: boolean },
 *   cast?: { path: string, version: string },
 *   forge?: { path: string, version: string }
 * }}
 */
export async function detectAnvil() {
    const anvilPath = which('anvil');
    if (!anvilPath) {
        return {
            found: false,
            reason: 'anvil not on PATH',
            installHint: INSTALL_HINT,
        };
    }

    const anvilVer = getVersion(anvilPath);
    if (!anvilVer) {
        return {
            found: false,
            reason: `anvil at ${anvilPath} ran but did not return parseable --version output`,
            installHint: INSTALL_HINT,
        };
    }

    const meets = meetsMinimum(anvilVer);
    if (!meets) {
        return {
            found: false,
            reason: `anvil ${anvilVer.version} is below required minimum ` +
                `${MIN_VERSION.major}.${MIN_VERSION.minor}.${MIN_VERSION.patch}`,
            installHint: 'Run `foundryup` to upgrade.',
            anvil: { path: anvilPath, ...anvilVer, meetsMinimum: false },
        };
    }

    const castPath = which('cast');
    const forgePath = which('forge');
    const castVer = getVersion(castPath);
    const forgeVer = getVersion(forgePath);

    return {
        found: true,
        anvil: { path: anvilPath, ...anvilVer, meetsMinimum: true },
        cast:  castPath  ? { path: castPath,  ...castVer  } : null,
        forge: forgePath ? { path: forgePath, ...forgeVer } : null,
    };
}

/**
 * Like detectAnvil but throws with the install hint if not found.
 */
export async function requireAnvil() {
    const info = await detectAnvil();
    if (!info.found) {
        const err = new Error(`[harness] ${info.reason}\n${info.installHint}`);
        err.code = 'ANVIL_NOT_FOUND';
        err.detectInfo = info;
        throw err;
    }
    return info;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
    const json = process.argv.includes('--json');
    const info = await detectAnvil();
    if (json) {
        console.log(JSON.stringify(info, null, 2));
        process.exit(info.found ? 0 : 2);
    }
    if (info.found) {
        console.log(`✓ anvil  ${info.anvil.version}  ${info.anvil.path}`);
        if (info.cast)  console.log(`✓ cast   ${info.cast.version}  ${info.cast.path}`);
        if (info.forge) console.log(`✓ forge  ${info.forge.version}  ${info.forge.path}`);
        process.exit(0);
    } else {
        console.error(`✗ ${info.reason}`);
        console.error(`\n${info.installHint}`);
        process.exit(2);
    }
}
