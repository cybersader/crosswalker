#!/usr/bin/env node
/**
 * Crosswalker local serve — interactive menu for docs + plugin development.
 *
 *   bun run serve              — interactive menu
 *   bun run serve docs         — docs dev server (Astro HMR)
 *   bun run serve preview      — build docs + serve dist
 *   bun run serve build        — docs build only
 *   bun run serve plugin       — plugin watch build → test-vault
 *   bun run serve both         — docs dev + plugin watch in parallel
 *   bun run serve tailscale    — docs dev shared via Tailscale
 *   bun run serve cloudflare   — docs dev shared via Cloudflare Tunnel
 *   bun run serve test         — docs playwright test:local
 *   bun run serve check-mdx    — lightweight MDX syntax check (~2s)
 */

import { spawn, execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const docsDir = resolve(repoRoot, 'docs');

const DOCS_PORT = 4321;
const isWindows = process.platform === 'win32';

let mode = process.argv[2] || 'interactive';
const children = [];

function log(msg) { console.log(`  ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function run(cmd, opts = {}) {
  try { return execSync(cmd, { stdio: 'pipe', timeout: 30000, shell: true, ...opts }).toString().trim(); }
  catch { return ''; }
}

function hasCmd(name) {
  if (isWindows) {
    return !!run(`where ${name} 2>nul`);
  }
  return !!run(`which ${name} 2>/dev/null`);
}

// Rollup ships its native binary as a per-platform optional dep. If docs/node_modules
// was installed on a different OS (e.g. WSL → Windows), the wrong binary is present and
// astro dev crashes with "Cannot find module @rollup/rollup-<platform>". We detect and
// force a clean reinstall when that happens.
function rollupNativePkg() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return '@rollup/rollup-win32-x64-msvc';
  if (platform === 'win32' && arch === 'arm64') return '@rollup/rollup-win32-arm64-msvc';
  if (platform === 'linux' && arch === 'x64') return '@rollup/rollup-linux-x64-gnu';
  if (platform === 'linux' && arch === 'arm64') return '@rollup/rollup-linux-arm64-gnu';
  if (platform === 'darwin' && arch === 'x64') return '@rollup/rollup-darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return '@rollup/rollup-darwin-arm64';
  return null;
}

function ensureDocsDeps() {
  const nodeModules = resolve(docsDir, 'node_modules');
  let needsInstall = false;
  let needsNuke = false;

  if (!existsSync(nodeModules)) {
    needsInstall = true;
  } else {
    // Check for cross-platform contamination (rollup native binary mismatch)
    const expectedRollup = rollupNativePkg();
    if (expectedRollup && !existsSync(resolve(nodeModules, expectedRollup))) {
      log(`docs/node_modules is missing ${expectedRollup} — likely installed on a different OS.`);
      needsNuke = true;
      needsInstall = true;
    }
  }

  if (needsNuke) {
    log('Removing stale docs/node_modules...');
    rmSync(nodeModules, { recursive: true, force: true });
    // Lockfile may also pin wrong-OS optional deps — remove it too for a fully clean install
    const lock = resolve(docsDir, 'bun.lock');
    if (existsSync(lock)) {
      log('Removing docs/bun.lock...');
      rmSync(lock, { force: true });
    }
  }

  if (needsInstall) {
    log('Installing docs/ dependencies (bun install)...');
    execSync('bun install', { cwd: docsDir, stdio: 'inherit', shell: true });
    log('✅ docs dependencies installed.');
  }
}

function getTailscale() {
  if (hasCmd('tailscale')) return 'tailscale';
  if (hasCmd('tailscale.exe')) return 'tailscale.exe';
  return null;
}

function hasCloudflared() {
  return hasCmd('cloudflared') || !!run('bun x cloudflared --version 2>/dev/null');
}

function track(child) { children.push(child); return child; }

function cleanup() {
  for (const c of children) { try { c.kill(); } catch {} }
  const ts = getTailscale();
  if (ts) run(`${ts} serve off 2>/dev/null`);
}

async function prompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ts = getTailscale();
  const cf = hasCloudflared();
  const docsOk = existsSync(docsDir);

  console.log('\n━━━ Crosswalker local serve ━━━\n');
  console.log(`  1) Docs dev server          ${docsOk ? `http://localhost:${DOCS_PORT}` : '(docs/ not found)'}   HMR`);
  console.log(`  2) Docs preview (built)     ${docsOk ? `http://localhost:${DOCS_PORT}` : '(docs/ not found)'}`);
  console.log(`  3) Docs build only          → docs/dist`);
  console.log(`  4) Plugin dev (watch)       → test-vault`);
  console.log(`  5) Docs + plugin dev        both in parallel`);
  console.log(`  6) Share docs (Tailscale)   ${ts ? 'tailnet only' : '(not installed)'}`);
  console.log(`  7) Share docs (Cloudflare)  ${cf ? 'public URL' : '(cloudflared not found)'}`);
  console.log(`  8) Docs e2e tests           playwright test:local`);
  console.log(`  9) Validate docs MDX syntax ~2s, catches silent MDX bugs\n`);

  return new Promise((res) => {
    rl.question('  Choose [1-9]: ', (a) => {
      rl.close();
      const map = {
        '1': 'docs',
        '2': 'preview',
        '3': 'build',
        '4': 'plugin',
        '5': 'both',
        '6': 'tailscale',
        '7': 'cloudflare',
        '8': 'test',
        '9': 'check-mdx',
      };
      res(map[a.trim()] || 'docs');
    });
  });
}

function startDocsDev() {
  ensureDocsDeps();
  log('Starting docs dev server (Astro HMR)...');
  const child = track(spawn('bun', ['x', 'astro', 'dev', '--host', '0.0.0.0', '--port', String(DOCS_PORT)], {
    cwd: docsDir,
    stdio: 'inherit',
    shell: isWindows,
  }));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n  ❌ Docs dev server exited with code ${code}`);
      cleanup();
      process.exit(code);
    }
  });
  return child;
}

function startDocsPreview() {
  ensureDocsDeps();
  log('Building docs site...');
  const build = spawn('bun', ['x', 'astro', 'build'], { cwd: docsDir, stdio: 'inherit', shell: isWindows });
  return new Promise((res, rej) => {
    build.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`docs build failed (exit ${code})`));
      log('Starting docs preview server...');
      track(spawn('bun', ['x', 'astro', 'preview', '--host', '0.0.0.0', '--port', String(DOCS_PORT)], {
        cwd: docsDir,
        stdio: 'inherit',
        shell: isWindows,
      }));
      res();
    });
  });
}

function runDocsBuild() {
  ensureDocsDeps();
  log('Building docs site → docs/dist...');
  return new Promise((res, rej) => {
    const p = spawn('bun', ['x', 'astro', 'build'], { cwd: docsDir, stdio: 'inherit', shell: isWindows });
    p.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`docs build failed (exit ${code})`));
      log('✅ Build complete.');
      res();
    });
  });
}

function startPluginDev() {
  log('Starting plugin watch build → test-vault...');
  return track(spawn('bun', ['run', 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
  }));
}

async function tailscaleServe(port) {
  const ts = getTailscale();
  if (!ts) { log('Tailscale not found.'); return; }
  run(`${ts} serve off 2>/dev/null`);
  spawn(ts, ['serve', String(port)], { stdio: 'ignore' });
  await sleep(2000);
  const status = run(`${ts} serve status 2>/dev/null`);
  const url = status.match(/(https:\/\/[^\s]+)/)?.[1];
  const ip = run(`${ts} ip -4 2>/dev/null`);
  console.log('');
  if (url) log(`🔗 ${url}`);
  if (ip) log(`Direct: http://${ip}:${port} (tailnet only)`);
  if (!url && !ip) log(`🔗 http://localhost:${port}`);
}

function startCloudflareTunnel(port) {
  log('Starting Cloudflare Tunnel...');
  return track(spawn('bun', ['x', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`], {
    stdio: 'inherit',
    shell: isWindows,
  }));
}

function runDocsTests() {
  ensureDocsDeps();
  log('Running docs playwright tests (test:local)...');
  return track(spawn('bun', ['run', 'test:local'], {
    cwd: docsDir,
    stdio: 'inherit',
    shell: isWindows,
  }));
}

function runCheckMdx() {
  ensureDocsDeps();
  log('Running lightweight MDX syntax check...');
  return track(spawn('bun', ['scripts/check-mdx.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
  }));
}

async function main() {
  if (mode === 'interactive') mode = await prompt();
  console.log(`\n  Mode: ${mode}\n`);

  if (mode === 'docs') {
    startDocsDev();
    console.log(`\n  ✅ Docs dev at http://localhost:${DOCS_PORT}\n  Press Ctrl+C to stop.\n`);
  } else if (mode === 'preview') {
    await startDocsPreview();
    console.log(`\n  ✅ Docs preview at http://localhost:${DOCS_PORT}\n  Press Ctrl+C to stop.\n`);
  } else if (mode === 'build') {
    await runDocsBuild();
    process.exit(0);
  } else if (mode === 'plugin') {
    startPluginDev();
    console.log('\n  ✅ Plugin watch → test-vault/.obsidian/plugins/crosswalker/\n  Press Ctrl+C to stop.\n');
  } else if (mode === 'both') {
    startDocsDev();
    await sleep(500);
    startPluginDev();
    console.log(`\n  ✅ Docs at http://localhost:${DOCS_PORT} + plugin watch → test-vault\n  Press Ctrl+C to stop both.\n`);
  } else if (mode === 'tailscale') {
    startDocsDev();
    await sleep(3000);
    console.log(`\n  ✅ Docs dev at http://localhost:${DOCS_PORT}`);
    await tailscaleServe(DOCS_PORT);
    console.log('\n  Press Ctrl+C to stop.\n');
  } else if (mode === 'cloudflare') {
    startDocsDev();
    await sleep(3000);
    startCloudflareTunnel(DOCS_PORT);
  } else if (mode === 'test') {
    const p = runDocsTests();
    p.on('exit', (code) => process.exit(code ?? 0));
  } else if (mode === 'check-mdx') {
    const p = runCheckMdx();
    p.on('exit', (code) => process.exit(code ?? 0));
  } else {
    log(`Unknown mode: ${mode}`);
    process.exit(1);
  }

  process.on('SIGINT', () => { console.log('\n  Stopping...'); cleanup(); console.log('  Done.'); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  await new Promise(() => {});
}

main().catch((e) => { console.error(`  Error: ${e.message}`); cleanup(); process.exit(1); });
