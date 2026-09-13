import type { Options } from '@wdio/types';
import path from 'path';
import { killOrphanedTestProcesses } from './tests/e2e/helpers/process-hygiene';

/**
 * WebdriverIO + wdio-obsidian-service config.
 *
 * Drives real Obsidian against `tests/e2e/seed-vault/` with the Crosswalker
 * plugin loaded. Spec discovery: `tests/e2e/**\/*.spec.ts`.
 *
 * Workflow:
 *   1. `onPrepare` kills orphaned obsidian/chromedriver/esbuild processes left
 *      by a prior crashed run, then builds the root plugin distribution with
 *      one retry for the esbuild-service `goroutine`/deadlock flake.
 *   2. wdio-obsidian-service copies the immutable seed into a temporary sandbox,
 *      then installs the complete three-file plugin distribution (`main.js`,
 *      `manifest.json`, and `styles.css`) from `plugins: ['.']` into that copy.
 *   3. Each spec runs against the isolated sandbox; the tracked seed is never
 *      mutated by a test run.
 *
 * Verify locally: `bun run e2e`
 *
 * Docs: https://github.com/jesse-r-s-hines/wdio-obsidian-service
 */

const REPO_ROOT = path.resolve('.');

/**
 * Purpose-built E2E seed: small deterministic state, zero duplicate canonical
 * identities, no accumulated generated outputs, and no Tier 2 sidecar. Copying
 * the development vault caused 42 of 52 triaged failures through unrelated
 * identity collisions, metadata-indexing races, and renderer timeouts.
 */
const E2E_SEED_VAULT = path.resolve('./tests/e2e/seed-vault');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build the plugin, retrying once if the esbuild-service deadlock flake
 *  signature ("goroutine ... deadlock" — a Go-runtime panic from esbuild's
 *  persistent build service) shows up in the output. On retry, first kills
 *  any esbuild-service process left orphaned by the failed attempt. */
async function buildPluginWithRetry(): Promise<void> {
	const { execSync } = await import('child_process');
	const attempt = (): { ok: boolean; output: string } => {
		try {
			const output = execSync('bun run build', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 5 * 60_000 });
			process.stdout.write(output);
			return { ok: true, output };
		} catch (err: any) {
			const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
			process.stdout.write(output);
			return { ok: false, output };
		}
	};

	console.log('Building root plugin distribution for the isolated E2E vault…');
	let result = attempt();
	if (!result.ok && /goroutine|deadlock/i.test(result.output)) {
		console.warn('[wdio.onPrepare] detected esbuild-service deadlock signature in build output — killing orphaned esbuild processes and retrying build once');
		const killed = killOrphanedTestProcesses(REPO_ROOT);
		console.warn(`[wdio.onPrepare] killed ${killed.length} orphaned process(es) before retry: ${killed.map((p) => `pid=${p.pid}`).join(', ') || '(none found)'}`);
		await sleep(1000);
		result = attempt();
	}
	if (!result.ok) {
		throw new Error('Plugin build failed (after retry, if attempted). See build output above.');
	}
}
export const config: Options.Testrunner = {
  runner: 'local',
  framework: 'mocha',

  specs: ['./tests/e2e/**/*.spec.ts'],

  // first-run.spec.ts owns its own vault fixture and its own config
  // (wdio.first-run.conf.mts, vault tests/e2e/first-run-vault/). Its entire
  // purpose is to observe what someone sees with NOTHING set up, so running it
  // against this seeded vault tests the opposite of what it is for -- and it
  // fails, because the seed already contains frameworks it asserts are absent.
  // Run it with: bun x wdio run wdio.first-run.conf.mts
  exclude: ['./tests/e2e/first-run.spec.ts'],

  // One Obsidian instance at a time keeps the test vault deterministic
  maxInstances: 1,

  capabilities: [{
    browserName: 'obsidian',
    browserVersion: 'latest',
    'wdio:obsidianOptions': {
      installerVersion: 'earliest', // matches manifest.json minAppVersion
      vault: E2E_SEED_VAULT,
      // obsidian-launcher copies the seed first, then installs the production
      // build from the repo root into the sandbox's plugin directory.
      plugins: ['.'],
    },
  }],

  services: ['obsidian'],
  reporters: ['obsidian'],

  // Where wdio-obsidian-service caches downloaded Obsidian builds
  cacheDir: path.resolve('.obsidian-cache'),

  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  logLevel: 'warn',

  onPrepare: async function () {
    // (a) process hygiene — kill orphaned obsidian/chromedriver/esbuild
    // processes from a previous crashed/force-killed run before we start.
    const orphans = killOrphanedTestProcesses(REPO_ROOT);
    if (orphans.length > 0) {
      console.warn(`[wdio.onPrepare] killed ${orphans.length} orphaned process(es) from a prior run:`);
      for (const o of orphans) {
        console.warn(`  pid=${o.pid} ppid=${o.ppid} cmd=${o.cmd.slice(0, 160)}`);
      }
    }

    // (b) build the plugin, with one retry on the esbuild deadlock flake.
    // The immutable seed needs no source-vault cleanup.
    await buildPluginWithRetry();
  },

  afterTest: async function (_test: any, _context: any, { error }: any) {
    if (error) {
      const ts = Date.now();
      await browser.saveScreenshot(`./test-results/failure-${ts}.png`);
    }
  },
};
