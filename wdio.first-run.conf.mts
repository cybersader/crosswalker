import type { Options } from '@wdio/types';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config as baseConfig } from './wdio.conf.mts';

/**
 * First-run UX harness. Uses a vault fixture with no notes and no Crosswalker
 * data.json while preserving the shared E2E seed/config for every other spec.
 *
 * Run:
 *   DISPLAY=:0 bun x wdio run wdio.first-run.conf.mts
 */
const baseCapabilities = baseConfig.capabilities as WebdriverIO.Capabilities[];

export const config: Options.Testrunner = {
	...baseConfig,
	specs: ['./tests/e2e/first-run.spec.ts', './tests/e2e/first-run-stack.spec.ts'],
	// The base config excludes this spec, because in the shared seeded vault it
	// tests the opposite of what it is for. This is the config that owns it, so
	// the inherited exclusion has to be cleared or there is nothing left to run.
	exclude: [],
	capabilities: baseCapabilities.map((capability) => ({
		...capability,
		'wdio:obsidianOptions': {
			...((capability as Record<string, unknown>)['wdio:obsidianOptions'] as Record<string, unknown>),
			vault: path.resolve('./tests/e2e/first-run-vault'),
		},
	})),
	onComplete: async function (...args: unknown[]) {
		await rm(path.resolve('./tests/e2e/first-run-vault/.obsidian/plugins'), { recursive: true, force: true });
		if (typeof baseConfig.onComplete === 'function') {
			await (baseConfig.onComplete as (...hookArgs: unknown[]) => Promise<void>).apply(this, args);
		}
	},
};
