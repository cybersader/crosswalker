/**
 * crosswalk-predicate-gate.test.ts — AM-21 (2026-08-31): the strict Tier 1
 * validation gate, asserted where it cannot be knocked out by an ownership
 * decision.
 *
 * WHY THIS FILE EXISTS. `tests/e2e/crosswalks.spec.ts` has asserted since v0.1.4
 * that a crosswalk row carrying a predicate outside the closed STRM enum is
 * REFUSED at write time and reported to the user. That probe went red in pass 8,
 * and the diagnosis was NOT a regression in the gate: the spec imported the same
 * subject/object pair twice with no import set named, and once AM-9 stopped the
 * engine adopting whatever set it found at the destination, the second call
 * minted a new one — so AM-12 refused the row as a cross-set identity collision
 * BEFORE it could reach validation. `success: false` and `errors.length > 0`
 * both still held; the run simply failed for a different reason.
 *
 * That is the failure mode this file removes. An E2E probe reaching a gate
 * through a whole import pipeline can stop reaching it without stopping being
 * green, and the assertion silently starts measuring something else. Here the
 * row is driven straight through `generateFromRecipe` into an empty vault, so
 * the only thing that can refuse it is the predicate.
 *
 * `tests/validation-strm-enum.test.ts` pins the enum itself against the schema.
 * This pins the ENGINE's behaviour around it: refuse, write nothing, and say
 * which field was wrong.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

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
		metadataCache: { getFileCache: () => null },
	};
	return { app: app as any, files };
}

const DIR = 'Crosswalks/strm';

/** The same recipe shape the v0.1.4 E2E gate drives. */
const RECIPE: Recipe = {
	recipe: 'strm-gate',
	source: { ontology: 'nist-olir', levels: ['mapping'] },
	target: {
		layout: [{
			level: 'mapping',
			mechanism: 'file',
			template: 'cw-{subject_id|slug}-{object_id|slug}.md',
			kind: 'crosswalk-edge' as const,
		}],
		also_emit: {
			frontmatter: {
				managed: {
					title: '{subject_id} -> {object_id}',
					subject_id: '{subject_id}',
					predicate_id: '{predicate_id}',
					object_id: '{object_id}',
				},
			},
		},
	},
};

function rows(predicate: string): ParsedData {
	const row = { subject_id: 'nist-csf:PR.AC-01', predicate_id: predicate, object_id: 'nist:AC-2' };
	return { columns: Object.keys(row), rows: [row], rowCount: 1 };
}

function run(app: any, predicate: string) {
	return generateFromRecipe(app, rows(predicate), RECIPE, {
		basePath: DIR,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'crosswalk.csv',
		strictValidation: true,
		importSet: 'new',
	});
}

describe('the strict Tier 1 gate on a crosswalk edge', () => {
	it('writes the edge when the predicate is one of the closed STRM set', async () => {
		// The control. Without it, a gate that refused EVERYTHING would pass the
		// case below, and the whole file would be measuring nothing.
		const { app, files } = makeApp();
		const result = await run(app, 'is_equivalent_to');
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(1);
		expect([...files.keys()][0]).toContain('cw-');
		expect(files.get(result.created[0])).toContain('predicate_id: is_equivalent_to');
	});

	it('refuses a predicate outside the enum, writes nothing, and names the field', async () => {
		const { app, files } = makeApp();
		const result = await run(app, 'totally_invalid_predicate');

		expect(result.created).toEqual([]);
		expect(files.size).toBe(0);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);

		// The user has to be able to tell WHICH field was wrong. "Tier 1
		// validation failed" alone sends them to read a schema.
		const said = result.errors.map((e) => e.message).join('\n');
		expect(said).toContain('Tier 1 validation');
		expect(said).toContain('predicate_id');

		// And it must be the validation gate that stopped it, not an ownership
		// refusal that happened to produce an error of its own. This is the exact
		// confusion that let the E2E probe go on passing while measuring the wrong
		// thing.
		expect(said).not.toContain('identity collision');
		expect(said).not.toContain('Address collision');
	});

	it('refuses row by row: a bad predicate does not take a good one down with it', async () => {
		const { app, files } = makeApp();
		const data: ParsedData = {
			columns: ['subject_id', 'predicate_id', 'object_id'],
			rows: [
				{ subject_id: 'nist-csf:PR.AC-01', predicate_id: 'totally_invalid_predicate', object_id: 'nist:AC-2' },
				{ subject_id: 'nist-csf:ID.AM-01', predicate_id: 'is_broader_than', object_id: 'nist:CM-8' },
			],
			rowCount: 2,
		};
		const result = await generateFromRecipe(app, data, RECIPE, {
			basePath: DIR,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'crosswalk.csv',
			strictValidation: true,
			importSet: 'new',
		});
		expect(result.errors).toHaveLength(1);
		expect(result.created).toHaveLength(1);
		expect(files.size).toBe(1);
		expect(files.get(result.created[0])).toContain('predicate_id: is_broader_than');
	});

	it('warns instead of refusing only when strict validation is switched off', async () => {
		// The gate is a setting, and the setting has to still mean something. If
		// non-strict also refused, "strict" would be a no-op and the case above
		// would be pinning the wrong cause.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, rows('totally_invalid_predicate'), RECIPE, {
			basePath: DIR,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'crosswalk.csv',
			strictValidation: false,
			importSet: 'new',
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(1);
		expect(files.size).toBe(1);
	});
});
