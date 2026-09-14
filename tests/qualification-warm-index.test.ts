/**
 * qualification-warm-index.test.ts — AM-24 (2026-08-31): the single
 * qualification rule carries its own precondition.
 *
 * THE DEFECT (E-B). `newSetSchemeFor` answers "which new set do we mint" from
 * whole-vault discovery, and whole-vault discovery is cache-only BY DESIGN — its
 * raw-frontmatter fallback is deliberately gated to a destination scope so it
 * never becomes a whole-vault content scan. A cold metadata cache therefore
 * shows a vault with fewer sets than it has, the rule answers "nothing
 * collides", and an unqualified set is minted straight into an occupied curie
 * space. AM-12 then correctly refuses every single row and the user sees
 * "0 notes created, N rows refused" with no cause they can act on.
 *
 * Both callers are command-palette entry points a person can fire while Obsidian
 * is still indexing, which on a large vault is a window of many seconds.
 *
 * THE RULE. The precondition lives INSIDE the function, because callers
 * forgetting it is exactly how this rule acquired three copies in the first
 * place. Count what is unread, wait once on `resolved`, RE-COUNT (the wait
 * resolves on its own timeout too, so the fact that it returned is not evidence
 * of anything), then either answer or fail closed with the indexing message.
 *
 * Cache lag read as fact is the seventh appearance of one bug in this codebase.
 * This file is where it stops for the qualification rule.
 */

import { TFile, TFolder } from 'obsidian';
import {
	VAULT_STILL_INDEXING_MESSAGE,
	VaultStillIndexingError,
	countUnindexedMarkdownFiles,
	newSetSchemeFor,
	settleVaultIndex,
} from '../src/generation/import-set';
import { SssomImportModal } from '../src/import/sssom-import-modal';
import { SSSOM_CURIE_PREFIX } from '../src/import/sssom-importer';
import type { App } from 'obsidian';
import type CrosswalkerPlugin from '../src/main';
import type { DebugLog } from '../src/utils/debug';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

const debugStub = {
	info() {}, trace() {}, warn() {}, error() {},
	currentTraceId: () => undefined,
	newTraceId: () => 'test-trace',
	withTrace: <T>(_id: string, fn: () => T): T => fn(),
} as unknown as DebugLog;

/**
 * A vault whose metadata cache can be COLD for named files.
 *
 * `getFileCache` returning null is the exact ambiguity at issue: Obsidian
 * answers null both for a file with no properties and for one it has not read
 * yet. `cold` is the set of files pretending to be the second.
 *
 * `resolved` is fired once per `on` subscription, on the next tick, mirroring
 * Obsidian's own event. `onResolve` decides what the vault looks like by the
 * time the listener runs, which is how "it warmed up while we waited" and "it is
 * still cold" are told apart.
 */
function makeVault(opts: { onResolve?: () => void } = {}) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const cold = new Set<string>();
	let subscriptions = 0;
	let unsubscribes = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				if (cold.has(file.path)) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
			on: (event: string, callback: () => void) => {
				subscriptions += 1;
				if (event === 'resolved') {
					setTimeout(() => {
						opts.onResolve?.();
						callback();
					}, 0);
				}
				return { event };
			},
			offref: () => { unsubscribes += 1; },
		},
	};
	return {
		app: app as unknown as App,
		files,
		cold,
		waits: () => subscriptions,
		unsubscribes: () => unsubscribes,
	};
}

/** One set's worth of notes, occupying the SSSOM identity space. */
function seedSssomSet(files: Map<string, string>, root: string, count = 2): string[] {
	const paths: string[] = [];
	for (let i = 1; i <= count; i += 1) {
		const path = `${root}/edge-${i}.md`;
		paths.push(path);
		files.set(path, [
			'---',
			`curie: "${SSSOM_CURIE_PREFIX}:edge-${i}"`,
			'kind: crosswalk-edge',
			'_crosswalker:',
			'  import_set:',
			'    id: iset-aaaaaa',
			'    scheme: endpoint-v1',
			'---',
			'Body.',
			'',
		].join('\n'));
	}
	return paths;
}

const ROOT = '_crosswalker/mappings/csf-to-iso27001';

// ---------------------------------------------------------------------------
// The measurement the precondition rests on.
// ---------------------------------------------------------------------------

describe('what "the vault has not been read yet" means', () => {
	it('counts a file the cache has not reached as unindexed', () => {
		const { app, files, cold } = makeVault();
		seedSssomSet(files, ROOT).forEach((p) => cold.add(p));
		expect(countUnindexedMarkdownFiles(app)).toBe(2);
	});

	it('counts a file with no properties as READ, because that is a fact about it', () => {
		// The whole ambiguity in one assertion: an empty note is not a pending one.
		const { app, files } = makeVault();
		files.set('Plain.md', 'Just prose.\n');
		expect(countUnindexedMarkdownFiles(app)).toBe(0);
	});

	it('waits once and then RE-COUNTS rather than trusting that the wait meant anything', async () => {
		// `resolved` fires per pass and the wait also resolves on its own timeout,
		// so the number has to be taken again afterwards.
		const vault = makeVault({ onResolve: () => vault.cold.clear() });
		const paths = seedSssomSet(vault.files, ROOT);
		paths.forEach((p) => vault.cold.add(p));

		expect(await settleVaultIndex(vault.app)).toBe(0);
		expect(vault.waits()).toBe(1);
		expect(vault.unsubscribes()).toBe(1);
	});

	it('does not wait at all when the vault is already read', async () => {
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT);
		expect(await settleVaultIndex(vault.app)).toBe(0);
		expect(vault.waits()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The rule itself, which is the thing that must not answer from a cold vault.
// ---------------------------------------------------------------------------

describe('AM-24: the qualification rule refuses to answer from a half-read vault', () => {
	it('fails closed with the indexing message when the vault is still cold after the wait', async () => {
		const vault = makeVault(); // resolved fires, but nothing warms.
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));

		await expect(newSetSchemeFor(vault.app, SSSOM_CURIE_PREFIX)).rejects.toBeInstanceOf(VaultStillIndexingError);
		expect(vault.waits()).toBe(1);
	});

	it('says so in the one shared wording, so no window invents its own', async () => {
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));
		await expect(newSetSchemeFor(vault.app, SSSOM_CURIE_PREFIX)).rejects.toThrow(VAULT_STILL_INDEXING_MESSAGE);
	});

	it('never answers "new" about a vault it could not see', async () => {
		// THE defect, stated as the property. The occupying set is invisible to a
		// cold cache, so the pre-AM-24 rule minted endpoint-v1 into its curie space
		// and every row was then refused with no cause the user could act on.
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));

		const answer = await newSetSchemeFor(vault.app, SSSOM_CURIE_PREFIX).catch((err) => err);

		expect(answer).not.toBe('new');
		expect(answer).toBeInstanceOf(Error);
	});

	it('answers correctly once the wait actually warms the cache', async () => {
		// The wait is not decoration: this is the same vault as the test above,
		// answered after indexing finishes, and the answer is the one that keeps the
		// two releases apart.
		const vault = makeVault({ onResolve: () => vault.cold.clear() });
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));

		expect(await newSetSchemeFor(vault.app, SSSOM_CURIE_PREFIX)).toBe('new-set-qualified');
	});

	it('still answers plainly on a warm empty vault', async () => {
		// The control. A precondition that refused everything would pass every test
		// above and break the first import in the product.
		const vault = makeVault();
		expect(await newSetSchemeFor(vault.app, SSSOM_CURIE_PREFIX)).toBe('new');
		expect(vault.waits()).toBe(0);
	});

	it('checks BEFORE the shortcut branches, not inside the one that reads the vault', async () => {
		// A source with no ontology prefix short-circuits to `new` without ever
		// consulting discovery. If the precondition sat below that branch, the
		// function would sometimes check and sometimes not, which is a contract no
		// caller can state - and the caller cannot tell which branch it hit.
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));

		await expect(newSetSchemeFor(vault.app, null)).rejects.toBeInstanceOf(VaultStillIndexingError);
	});
});

// ---------------------------------------------------------------------------
// The entry point the finding named, driven end to end.
// ---------------------------------------------------------------------------

describe('AM-24: the caller cannot forget what the rule refuses to run without', () => {
	function modal(app: App) {
		const plugin = {
			settings: {},
			debug: debugStub,
			runProjection: null,
			precomputeClosure: null,
		} as unknown as CrosswalkerPlugin;
		return new SssomImportModal(app, plugin) as unknown as {
			detectedSource: string | null;
			detectedTarget: string | null;
			importSetChoice: unknown;
			selectedImportSet(): Promise<unknown>;
		};
	}

	it('the crosswalk import refuses rather than minting into a space it could not see', async () => {
		// The scenario in the finding: run the SSSOM import during startup
		// indexing on a large vault. It reached the rule through a command palette
		// entry point that carried no precondition of its own.
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT).forEach((p) => vault.cold.add(p));
		const sssom = modal(vault.app);
		sssom.detectedSource = 'csf';
		sssom.detectedTarget = 'iso27001';
		sssom.importSetChoice = null;

		await expect(sssom.selectedImportSet()).rejects.toThrow(VAULT_STILL_INDEXING_MESSAGE);
	});

	it('and answers normally once the vault is read', async () => {
		const vault = makeVault();
		seedSssomSet(vault.files, ROOT);
		const sssom = modal(vault.app);
		sssom.detectedSource = 'csf';
		sssom.detectedTarget = 'iso27001';
		sssom.importSetChoice = null;

		expect(await sssom.selectedImportSet()).toBe('new-set-qualified');
	});
});
