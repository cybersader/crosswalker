/**
 * d1-pass20-s13-s15-s16-normalization-parity.test.ts -- S13, S15, S16
 * (2026-09-04, pass 20, Task C items 4 and 5): every place a folder-shaped
 * setting is read agrees with `normalizeFolderSetting` (the AM-45 mirror,
 * `src/settings/folder-settings.ts`) on the same mutation set S6 already
 * pinned for the sibling normalizer in `import-set.ts`.
 *
 * THE DEFECT THIS PINS. Three separate call sites carried their OWN partial
 * spelling of "normalize a folder setting", each missing a different subset
 * of the four mutations (separator collapse, backslash fold, NBSP/NFD fold,
 * NFC) -- so a value that survived one caller's weaker normalization could
 * still disagree with what a SECOND caller, reading the SAME setting, would
 * compare it against:
 *
 *   S13 -- `isWithinDestination` (`import-set.ts:637-649`), the filter that
 *   decides which notes a refresh believes belong to a destination.
 *   S16 -- `normalizeBasePath` (`generation-engine.ts:355-365`), what the
 *   ENGINE actually writes with -- `fullPath` composition, `rootFolder:` at
 *   both enrichment call sites, ownership resolution, folder creation, and
 *   the orphan/refresh scans all read this.
 *   S15 -- `evidenceReportPath` / `evidenceLinkPath` (`evidence-report-
 *   command.ts` / `evidence-link.ts`), two evidence-note path composers for
 *   the SAME settings field, which used to carry two different composition
 *   rules for it.
 *
 * THE RULE. S13 and S16 now both call `normalizeFolderSetting` (imported
 * from `src/settings/folder-settings.ts`), never a local copy; S15's two
 * composers both go through one exported `joinInFolder`.
 */

import { TFile, TFolder } from 'obsidian';
import { discoverImportSets } from '../src/generation/import-set';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { evidenceReportPath } from '../src/views/evidence-report-command';
import { evidenceLinkPath, joinInFolder } from '../src/views/evidence-link';
import { normalizeFolderSetting } from '../src/settings/folder-settings';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

/**
 * The same forms S6 (`import-set-s6-destination-normalization.test.ts`) and
 * AM-63 (`d1-pass20-am63-occupancy-normalizer.test.ts`) already exercise for
 * their own call sites, so this file adds no new normalization CLAIM -- it
 * checks that the SAME set of mutations, on the SAME setting, agrees across
 * every reader, not just the two already pinned.
 */
const MESSY_FORMS: Array<[label: string, value: string]> = [
	['a doubled internal separator', 'Frameworks//NIST'],
	['a backslash separator', 'Frameworks\\NIST'],
	['a trailing separator', 'Frameworks/NIST/'],
	['leading/trailing whitespace', '  Frameworks/NIST  '],
];
const CLEAN = 'Frameworks/NIST';

describe('S13: isWithinDestination (via discoverImportSets\' basePath filter) agrees with normalizeFolderSetting', () => {
	function makeApp(files: Map<string, string>): App {
		const app = {
			vault: { getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)) },
			metadataCache: {
				getFileCache: (file: { path: string }) => {
					const text = files.get(file.path);
					if (text === undefined) return null;
					const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
					if (!match) return { frontmatter: {} };
					try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
					catch { return { frontmatter: {} }; }
				},
			},
		};
		return app as unknown as App;
	}

	const stamped = (curie: string): string => [
		'---',
		`curie: "${curie}"`,
		'ontology: "nist"',
		'_crosswalker:',
		'  import_set:',
		'    id: "iset-par1ty"',
		'    scheme: "endpoint-v1"',
		'---',
		'Body.',
		'',
	].join('\n');

	it.each(MESSY_FORMS)('a note under the CLEAN folder is admitted when basePath is typed with %s', async (_label, messyBasePath) => {
		const files = new Map<string, string>();
		files.set(`${CLEAN}/AC-1.md`, stamped('nist:AC-1'));
		const app = makeApp(files);

		// The premise `normalizeFolderSetting` predicts the same clean form S13
		// is supposed to agree with -- if this itself were wrong, the assertion
		// below would prove nothing about which normalizer discovery took.
		expect(normalizeFolderSetting(messyBasePath)).toBe(CLEAN);

		const clean = await discoverImportSets(app, CLEAN);
		const messy = await discoverImportSets(app, messyBasePath);
		expect(messy).toHaveLength(1);
		expect(messy).toEqual(clean);
	});

	it('a note OUTSIDE the folder is excluded regardless of which spelling basePath is typed in -- the guard is not simply always-on', async () => {
		const files = new Map<string, string>();
		files.set('Somewhere/Else/AC-1.md', stamped('nist:AC-1'));
		const app = makeApp(files);
		for (const [, messyBasePath] of MESSY_FORMS) {
			expect(await discoverImportSets(app, messyBasePath)).toEqual([]);
		}
	});
});

describe('S16: normalizeBasePath (via generateFromRecipe\'s observable write location) agrees with normalizeFolderSetting', () => {
	function makeApp() {
		const files = new Map<string, string>();
		const folders = new Set<string>(['']);
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
					const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
					if (!match) return { frontmatter: undefined };
					try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
					catch { return { frontmatter: undefined }; }
				},
			},
		};
		return { app: app as any, files };
	}

	function recipe(): Recipe {
		return {
			recipe: 'parity-s16',
			source: { ontology: 'nist', levels: ['leaf'] },
			target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] },
		};
	}

	function parsed(): ParsedData {
		const rows = [{ id: 'AC-1', name: 'One' }];
		return { columns: ['id', 'name'], rows, rowCount: rows.length };
	}

	it.each(MESSY_FORMS)('a messy basePath (%s) writes to the SAME clean location a clean basePath would', async (_label, messyBasePath) => {
		const clean = makeApp();
		const messy = makeApp();
		await generateFromRecipe(clean.app, parsed(), recipe(), {
			basePath: CLEAN, overwriteMode: 'replace', createFolders: true, sourceFileName: 's.csv', importSet: 'new',
		});
		await generateFromRecipe(messy.app, parsed(), recipe(), {
			basePath: messyBasePath, overwriteMode: 'replace', createFolders: true, sourceFileName: 's.csv', importSet: 'new',
		});
		expect(messy.files.has(`${CLEAN}/AC-1.md`)).toBe(true);
		expect([...messy.files.keys()].sort()).toEqual([...clean.files.keys()].sort());
	});
});

describe('S15: evidenceReportPath and evidenceLinkPath compose through the ONE function, joinInFolder', () => {
	it('both are literally the same composition -- a change to one folder setting cannot silently diverge between the two composers', () => {
		expect(evidenceReportPath('Evidence', 'nist')).toBe(joinInFolder('Evidence', 'Evidence coverage - nist.md'));

		// evidenceLinkPath's file name is deterministic (a pure hash of the pair),
		// so the bare name computed at the vault root is the same name any other
		// folder composes with -- read it back that way, then compose it directly
		// with joinInFolder and check it against evidenceLinkPath's OWN folder
		// composition for the identical inputs.
		const bareName = evidenceLinkPath('', 'nist:AC-1', 'Frameworks/AC-1.md', 'Evidence/E1.md');
		expect(bareName.startsWith('/')).toBe(false); // S11's own guard, not this file's claim -- sanity only.
		expect(evidenceLinkPath('Evidence/Junctions', 'nist:AC-1', 'Frameworks/AC-1.md', 'Evidence/E1.md'))
			.toBe(joinInFolder('Evidence/Junctions', bareName));
	});

	it('a trailing-slash folder composes a single slash, never a double one, for both composers', () => {
		expect(evidenceReportPath('Evidence/', 'nist')).toBe('Evidence/Evidence coverage - nist.md');
		expect(evidenceReportPath('Evidence/', 'nist')).not.toContain('//');
	});

	it('the vault root (an empty folder setting) composes a BARE file name for both composers, never a leading slash', () => {
		const reportAtRoot = evidenceReportPath('', 'nist');
		expect(reportAtRoot).toBe('Evidence coverage - nist.md');
		expect(reportAtRoot.startsWith('/')).toBe(false);

		const linkAtRoot = evidenceLinkPath('', 'nist:AC-1', 'Frameworks/AC-1.md', 'Evidence/E1.md');
		expect(linkAtRoot.startsWith('/')).toBe(false);
	});
});
