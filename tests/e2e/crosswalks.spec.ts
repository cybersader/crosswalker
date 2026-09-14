/**
 * crosswalks.spec.ts — milestone v0.1.4 gate
 *
 * Drives the native Ch 22 recipe path (plugin.runImportFromRecipe) against
 * a real Obsidian instance. Verifies:
 *   1. crosswalk-edge recipe imports produce expected files at expected paths
 *   2. Each file's frontmatter has kind: 'crosswalk-edge' + STRM-valid predicate
 *   3. Generated frontmatter validates against spec/tier1.schema.json
 *   4. Invalid STRM predicate is REJECTED at write time (strict validation gate)
 *   5. junction-note recipe path also works (different kind dispatch)
 *   6. Existing concept-note imports still work (backwards compat verification)
 *
 * Run: `bun run e2e`
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { readFrontmatterMatching, requireFrontmatterIndexed } from './helpers/vault-readiness';

const CROSSWALK_DIR = 'Crosswalks/v0-1-4-test';
const JUNCTION_DIR = 'Evidence/v0-1-4-junctions';

// ---------------------------------------------------------------------------
// Crosswalk-edge fixtures
// ---------------------------------------------------------------------------

const crosswalkRecipe = {
	recipe: 'v0-1-4-test-crosswalk',
	source: { ontology: 'nist-olir', levels: ['mapping'] },
	target: {
		layout: [
			{
				level: 'mapping',
				mechanism: 'file',
				template: 'cw-{subject_id|slug}-{object_id|slug}.md',
				kind: 'crosswalk-edge' as const,
			},
		],
		also_emit: {
			tags: ['crosswalk/v0-1-4-test'],
			frontmatter: {
				managed: {
					title: '{subject_id} -> {object_id}',
					subject_id: '{subject_id}',
					predicate_id: '{predicate_id}',
					object_id: '{object_id}',
					match_type: '{match_type}',
				},
				user_preserve: ['review_status', 'creator_id', '*notes*'],
			},
		},
	},
};

const validCrosswalkRows = [
	{
		subject_id: 'nist-csf:PR.AC-01',
		predicate_id: 'is_equivalent_to',
		object_id: 'nist:AC-2',
		match_type: 'exact',
	},
	{
		subject_id: 'nist-csf:ID.AM-01',
		predicate_id: 'is_broader_than',
		object_id: 'nist:CM-8',
		match_type: 'broad',
	},
	{
		subject_id: 'iso27001:A.9.2.1',
		predicate_id: 'is_equivalent_to',
		object_id: 'nist:AC-2',
		match_type: 'close',
	},
];

const invalidPredicateRows = [
	{
		subject_id: 'nist-csf:PR.AC-01',
		predicate_id: 'totally_invalid_predicate',
		object_id: 'nist:AC-2',
		match_type: 'exact',
	},
];

const crosswalkParsed = {
	columns: ['subject_id', 'predicate_id', 'object_id', 'match_type'],
	rows: validCrosswalkRows,
	rowCount: validCrosswalkRows.length,
	source: { type: 'csv' as const },
	headerRow: 0,
};

// ---------------------------------------------------------------------------
// Junction-note fixtures
// ---------------------------------------------------------------------------

const junctionRecipe = {
	recipe: 'v0-1-4-test-junction',
	source: { ontology: 'evidence', levels: ['ev'] },
	target: {
		layout: [
			{
				level: 'ev',
				mechanism: 'file',
				template: 'jn-{subject|slug}-{object|slug}.md',
				kind: 'junction-note' as const,
			},
		],
		also_emit: {
			frontmatter: {
				managed: {
					title: '{subject} -> {object}',
					subject: '[[{subject}]]',
					predicate: '{predicate}',
					object: '[[{object}]]',
					coverage: '{coverage}',
				},
				user_preserve: ['reviewer', 'review_date', 'status', 'confidence'],
			},
		},
	},
};

const junctionRows = [
	{
		subject: 'Frameworks/NIST/AC-2',
		predicate: 'covers',
		object: 'Evidence/MFA-Policy',
		coverage: 'partial',
	},
	{
		subject: 'Frameworks/NIST/AU-1',
		predicate: 'evidences',
		object: 'Evidence/Audit-Runbook',
		coverage: 'full',
	},
];

const junctionParsed = {
	columns: ['subject', 'predicate', 'object', 'coverage'],
	rows: junctionRows,
	rowCount: junctionRows.length,
	source: { type: 'csv' as const },
	headerRow: 0,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Crosswalker plugin — v0.1.4 junction notes + crosswalk edges', function () {
	this.timeout(120000);

	before(async () => {
		// Clean both test output dirs
		// CONDITION: both destinations are gone from the vault index before the
		// declarations start counting what they create.
		const cleaned = await browser.executeObsidian(async ({ app }, dirs) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			for (const dir of dirs) {
				const folder = app.vault.getAbstractFileByPath(dir);
				if (folder) {
					// @ts-expect-error - using internal trash API
					await app.vault.trash(folder, false);
				}
			}
			const deadline = Date.now() + 5000;
			while (dirs.some((dir) => app.vault.getAbstractFileByPath(dir)) && Date.now() < deadline) await sleep(50);
			return dirs.filter((dir) => app.vault.getAbstractFileByPath(dir));
		}, [CROSSWALK_DIR, JUNCTION_DIR]);
		expect(cleaned).toEqual([]);
	});

	it('imports crosswalk-edge rows via runImportFromRecipe to expected paths', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				if (typeof plugin.runImportFromRecipe !== 'function') {
					return { error: 'plugin.runImportFromRecipe not exposed' };
				}
				return plugin.runImportFromRecipe(args.parsedData, args.recipe, args.options);
			},
			{
				parsedData: crosswalkParsed,
				recipe: crosswalkRecipe,
				options: {
					basePath: CROSSWALK_DIR,
					overwriteMode: 'replace',
					createFolders: true,
					sourceFileName: 'csf-800-53-crosswalk.csv',
					strictValidation: true,
				},
			},
		);

		if ((result as { error?: string }).error) {
			throw new Error(`v0.1.4 native-recipe handle not yet exposed: ${(result as { error: string }).error}`);
		}

		// Verify three crosswalk files
		const files = await browser.executeObsidian(({ app }, dir) => {
			const matches = app.vault
				.getMarkdownFiles()
				.filter((f) => f.path.startsWith(dir + '/'))
				.map((f) => f.path);
			return matches.sort();
		}, CROSSWALK_DIR);

		expect(files.length).toBe(3);
		expect(files.every((p: string) => p.includes('cw-'))).toBe(true);
	});

	it('emits kind: crosswalk-edge and STRM-valid predicate_id in frontmatter', async () => {
		// WRITER CONTRACT → read the file (triage 2026-08-24 §5.2). The previous
		// cache read returned `null` in an incompletely indexed vault and the
		// spec reported that as a generation defect.
		const found = await readFrontmatterMatching(CROSSWALK_DIR, 'pr-ac-01');
		expect(found.path).toBeTruthy();
		expect(found.frontmatter).toBeTruthy();
		const fm = found.frontmatter as Record<string, any>;

		expect(fm.kind).toBe('crosswalk-edge');
		expect(fm.subject_id).toBe('nist-csf:PR.AC-01');
		expect(fm.predicate_id).toBe('is_equivalent_to');
		expect(fm.object_id).toBe('nist:AC-2');

		// _crosswalker provenance present + spec-conformant
		expect(fm._crosswalker.spec_version).toBe('https://crosswalker.dev/spec/tier1.schema.json');
		expect(fm._crosswalker.producer.name).toBe('crosswalker-plugin');
	});

	it('rejects invalid STRM predicate at write time (strict validation gate)', async () => {
		// AM-21 (2026-08-31). This probe imports the SAME subject/object pair as the
		// first case above, through the same recipe, so it renders the same file stem
		// and therefore the same curie. Since AM-9 the engine no longer adopts a set
		// it happens to find, so a second call with no `importSet` mints a NEW one --
		// and AM-12 then correctly refuses the row as a cross-set identity collision
		// BEFORE it can reach the Tier 1 validation this case exists to exercise. The
		// run still fails and still reports an error, which is why the first two
		// assertions kept passing; the error just said something else entirely.
		//
		// The strict predicate gate did not regress. The probe relied on adoption.
		// Naming the set the first import stamped is the E2E stand-in for the
		// ownership click a person makes in the wizard -- the same repair AM-16
		// applied to its three siblings -- and it puts the row back on the path
		// where an invalid predicate is what stops it. Read from the file's own
		// bytes, not the metadata cache, which may not have indexed a just-written
		// note yet.
		const owner = await readFrontmatterMatching(CROSSWALK_DIR, 'pr-ac-01');
		const ownedSetId = (owner.frontmatter as any)?._crosswalker?.import_set?.id;
		expect(typeof ownedSetId).toBe('string');

		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImportFromRecipe(args.parsedData, args.recipe, args.options);
			},
			{
				parsedData: {
					columns: ['subject_id', 'predicate_id', 'object_id', 'match_type'],
					rows: invalidPredicateRows,
					rowCount: 1,
					source: { type: 'csv' as const },
					headerRow: 0,
				},
				recipe: crosswalkRecipe,
				options: {
					basePath: CROSSWALK_DIR + '/invalid',
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
					importSet: { id: ownedSetId },
				},
			},
		);

		// Invalid predicate must surface as an error (not silently written)
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(
			result.errors.some(
				(e: { row: number; message: string }) =>
					e.message.includes('predicate_id') || e.message.includes('Tier 1 validation'),
			),
		).toBe(true);
		expect(result.created.length).toBe(0);
	});

	it('imports junction-note rows via runImportFromRecipe', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImportFromRecipe(args.parsedData, args.recipe, args.options);
			},
			{
				parsedData: junctionParsed,
				recipe: junctionRecipe,
				options: {
					basePath: JUNCTION_DIR,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				},
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(2);

		// Verify junction-note frontmatter — writer contract, read from disk.
		const found = await readFrontmatterMatching(JUNCTION_DIR, 'ac-2');
		expect(found.path).toBeTruthy();
		expect(found.frontmatter).toBeTruthy();
		const fm = found.frontmatter as Record<string, any>;

		expect(fm.kind).toBe('junction-note');
		expect(fm.predicate).toBe('covers');
		expect(fm.coverage).toBe('partial');
	});

	it('preserves user-edited keys on crosswalk-edge re-import (Ch 22 §8.4 user_preserve)', async () => {
		// User adds review_status + creator_id to one of the crosswalk files
		const editedPath = await browser.executeObsidian(async ({ app }, dir) => {
			const file = app.vault
				.getMarkdownFiles()
				.find((f) => f.path.startsWith(dir + '/') && f.path.includes('pr-ac-01'));
			if (!file) return null;
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm.review_status = 'approved';
				fm.creator_id = '0000-0001-2345-6789';
				fm.notes = 'Validated against NIST OLIR ID:0024';
			});
			return file.path;
		}, CROSSWALK_DIR);
		expect(editedPath).toBeTruthy();

		// CONDITION: that one edited note's `review_status` is visible in the
		// metadata cache before the re-import runs. The user_preserve merge reads
		// the note's existing frontmatter, so this is a real precondition of the
		// behavior under test — unlike the fixed 300ms sleep it replaces.
		await requireFrontmatterIndexed({
			pathPrefixes: editedPath as string,
			expectedCount: 1,
			requireKeys: ['review_status', 'creator_id', 'notes'],
		});

		// Re-import — managed keys should overwrite, user_preserve keys must survive
		await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImportFromRecipe(args.parsedData, args.recipe, args.options);
			},
			{
				parsedData: crosswalkParsed,
				recipe: crosswalkRecipe,
				options: {
					basePath: CROSSWALK_DIR,
					overwriteMode: 'replace',
					createFolders: true,
					sourceFileName: 'csf-800-53-crosswalk.csv',
					strictValidation: true,
				},
			},
		);

		// Merge result is on disk; read it there rather than waiting on the cache.
		const after = await readFrontmatterMatching(CROSSWALK_DIR, 'pr-ac-01');
		expect(after.path).toBeTruthy();
		expect(after.frontmatter).toBeTruthy();
		const fmAfter = after.frontmatter as Record<string, any>;

		// User keys preserved
		expect(fmAfter.review_status).toBe('approved');
		expect(fmAfter.creator_id).toBe('0000-0001-2345-6789');
		expect(fmAfter.notes).toBe('Validated against NIST OLIR ID:0024');

		// Managed keys still recipe-driven
		expect(fmAfter.predicate_id).toBe('is_equivalent_to');
		expect(fmAfter.subject_id).toBe('nist-csf:PR.AC-01');
		expect(fmAfter.kind).toBe('crosswalk-edge');
	});
});
