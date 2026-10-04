/**
 * sidecar-phase-2-projection.spec.ts — Phase 2 projector E2E
 *
 * Verifies the projector reads Tier 1 frontmatter and writes Tier 2 rows:
 *   1. plugin.runProjection() returns a result with counts
 *   2. Imports a 3-row concept fixture, projects, asserts concepts table populated
 *   3. Imports 3 crosswalk-edge rows, projects, asserts mappings populated
 *   4. Imports 2 junction notes, projects, asserts junction_notes populated
 *   5. Re-running projection on unchanged vault is idempotent (same row counts)
 *   6. Files without _crosswalker block are skipped silently
 *
 * Run: bun run e2e -- --spec tests/e2e/sidecar-phase-2-projection.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { requireFrontmatterIndexed, resetTier2Sidecar } from './helpers/vault-readiness';

const TEST_DIR = 'Frameworks/v0-1-5-phase-2-test';
const CROSSWALK_DIR = 'Crosswalks/v0-1-5-phase-2-test';
const JUNCTION_DIR = 'Evidence/v0-1-5-phase-2-test';

const conceptRecipe = {
	recipe: 'phase-2-concept',
	source: { ontology: 'phase2', levels: ['c'] },
	target: {
		layout: [
			{ level: 'c', mechanism: 'file' as const, template: '{id}.md' },
		],
		also_emit: {
			frontmatter: {
				managed: { title: '{title}', family: '{family}' },
			},
		},
	},
};

const conceptParsed = {
	columns: ['id', 'title', 'family'],
	rows: [
		{ id: 'AC-1', title: 'Policy and Procedures', family: 'AC' },
		{ id: 'AC-2', title: 'Account Management', family: 'AC' },
		{ id: 'AU-1', title: 'Audit Policy', family: 'AU' },
	],
	rowCount: 3,
	source: { type: 'csv' as const },
	headerRow: 0,
};

const crosswalkRecipe = {
	recipe: 'phase-2-crosswalk',
	source: { ontology: 'phase2-olir', levels: ['m'] },
	target: {
		layout: [
			{
				level: 'm',
				mechanism: 'file' as const,
				template: 'cw-{subject_id|slug}-{object_id|slug}.md',
				kind: 'crosswalk-edge' as const,
			},
		],
		also_emit: {
			frontmatter: {
				managed: {
					subject_id: '{subject_id}',
					predicate_id: '{predicate_id}',
					object_id: '{object_id}',
				},
			},
		},
	},
};

const crosswalkParsed = {
	columns: ['subject_id', 'predicate_id', 'object_id'],
	rows: [
		{ subject_id: 'phase2-csf:PR.AC-01', predicate_id: 'is_equivalent_to', object_id: 'phase2:AC-2' },
		{ subject_id: 'phase2-csf:ID.AM-01', predicate_id: 'is_broader_than', object_id: 'phase2:CM-8' },
		{ subject_id: 'phase2-iso:A.9.2.1', predicate_id: 'is_equivalent_to', object_id: 'phase2:AC-2' },
	],
	rowCount: 3,
	source: { type: 'csv' as const },
	headerRow: 0,
};

const junctionRecipe = {
	recipe: 'phase-2-junction',
	source: { ontology: 'phase2-evidence', levels: ['e'] },
	target: {
		layout: [
			{
				level: 'e',
				mechanism: 'file' as const,
				template: 'jn-{subject|slug}-{object|slug}.md',
				kind: 'junction-note' as const,
			},
		],
		also_emit: {
			frontmatter: {
				managed: {
					subject: '[[{subject}]]',
					predicate: '{predicate}',
					object: '[[{object}]]',
					coverage: '{coverage}',
				},
			},
		},
	},
};

const junctionParsed = {
	columns: ['subject', 'predicate', 'object', 'coverage'],
	rows: [
		{ subject: 'Frameworks/AC-2', predicate: 'covers', object: 'Evidence/MFA-Policy', coverage: 'partial' },
		{ subject: 'Frameworks/AU-1', predicate: 'evidences', object: 'Evidence/Audit-Run', coverage: 'full' },
	],
	rowCount: 2,
	source: { type: 'csv' as const },
	headerRow: 0,
};

describe('Crosswalker plugin — v0.1.5 Phase 2 projector', function () {
	this.timeout(120000);

	before(async () => {
		// Clean prior test output. CONDITION: the folders are gone from the vault
		// index before we import, so the fixture counts below mean this run only.
		const stillPresent = await browser.executeObsidian(async ({ app }, dirs) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			for (const dir of dirs) {
				const folder = app.vault.getAbstractFileByPath(dir);
				if (folder) {
					// @ts-expect-error - internal trash API
					await app.vault.trash(folder, false);
				}
			}
			const deadline = Date.now() + 5000;
			while (dirs.some((dir) => app.vault.getAbstractFileByPath(dir)) && Date.now() < deadline) await sleep(50);
			return dirs.filter((dir) => app.vault.getAbstractFileByPath(dir));
		}, [TEST_DIR, CROSSWALK_DIR, JUNCTION_DIR]);
		expect(stillPresent).toEqual([]);

		// Start from an EMPTY Tier 2 database, not just a closed handle (triage
		// 2026-08-24 §5.3). The old hook nulled `plugin.tier2Handle` and stopped
		// there, so the exact-count assertions below ran against rows another
		// spec had projected. See resetTier2Sidecar() for why the file itself
		// cannot simply be deleted (OPFS sahpool VFS).
		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);
		expect(reset.counts.concepts).toBe(0);
		expect(reset.counts.mappings).toBe(0);
		expect(reset.counts.junction_notes).toBe(0);

		// Import the three fixtures via runImportFromRecipe
		await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				await plugin.runImportFromRecipe(args.conceptParsed, args.conceptRecipe, {
					basePath: args.testDir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
				await plugin.runImportFromRecipe(args.crosswalkParsed, args.crosswalkRecipe, {
					basePath: args.crosswalkDir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
				await plugin.runImportFromRecipe(args.junctionParsed, args.junctionRecipe, {
					basePath: args.junctionDir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
			},
			{
				conceptParsed,
				conceptRecipe,
				crosswalkParsed,
				crosswalkRecipe,
				junctionParsed,
				junctionRecipe,
				testDir: TEST_DIR,
				crosswalkDir: CROSSWALK_DIR,
				junctionDir: JUNCTION_DIR,
			},
		);

		// CONDITION: every fixture note exists AND has readable frontmatter with a
		// `_crosswalker` block. `src/tier2/projector.ts` fails the whole full
		// projection closed when any Markdown file has no metadata-cache entry,
		// so a 500ms sleep here is what turned six downstream declarations into
		// "zero rows" results that said nothing about the projector.
		await requireFrontmatterIndexed({ pathPrefixes: TEST_DIR, expectedCount: 3, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: CROSSWALK_DIR, expectedCount: 3, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: JUNCTION_DIR, expectedCount: 2, requireKeys: ['_crosswalker'] });
	});

	it('plugin.runProjection() returns a result with counts', async () => {
		const result = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			if (typeof plugin.runProjection !== 'function') {
				return { error: 'plugin.runProjection not exposed' };
			}
			return plugin.runProjection();
		});

		if ((result as { error?: string }).error) {
			throw new Error(`runProjection not exposed: ${(result as { error: string }).error}`);
		}

		expect(result.success).toBe(true);
		expect(result.counts).toBeTruthy();
		expect(typeof result.counts.concepts).toBe('number');
		expect(typeof result.counts.mappings).toBe('number');
		expect(typeof result.counts.junction_notes).toBe('number');
		expect(typeof result.counts.ontologies).toBe('number');
	});

	it('projects concept-note files into concepts table', async () => {
		const rows = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const result = await handle.db.exec({
				sql: "SELECT curie, title, ontology_id FROM concepts WHERE ontology_id = 'phase2' ORDER BY curie",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return result.map((r: unknown[]) => ({
				curie: String(r[0]),
				title: String(r[1]),
				ontology_id: String(r[2]),
			}));
		});

		expect(rows.length).toBe(3);
		expect(rows[0].curie).toBe('phase2:AC-1');
		expect(rows[0].title).toBe('Policy and Procedures');
		expect(rows[1].curie).toBe('phase2:AC-2');
		expect(rows[2].curie).toBe('phase2:AU-1');
	});

	it('projects crosswalk-edge files into mappings table', async () => {
		const rows = await browser.executeObsidian(async ({ app }, dir) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const result = await handle.db.exec({
				sql: "SELECT subject_id, predicate_id, object_id FROM mappings WHERE source_path LIKE $like ORDER BY subject_id",
				bind: { $like: dir + '/%' },
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return result.map((r: unknown[]) => ({
				subject_id: String(r[0]),
				predicate_id: String(r[1]),
				object_id: String(r[2]),
			}));
		}, CROSSWALK_DIR);

		expect(rows.length).toBe(3);
		const subjects = rows.map((r) => r.subject_id).sort();
		expect(subjects).toContain('phase2-csf:PR.AC-01');
		expect(subjects).toContain('phase2-csf:ID.AM-01');
		expect(subjects).toContain('phase2-iso:A.9.2.1');
		// All STRM-valid predicates
		for (const r of rows) {
			expect(['is_equivalent_to', 'is_broader_than', 'is_narrower_than', 'is_approximate_to', 'intersects_with', 'no_relationship']).toContain(r.predicate_id);
		}
	});

	it('projects junction-note files into junction_notes table', async () => {
		const rows = await browser.executeObsidian(async ({ app }, dir) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const result = await handle.db.exec({
				sql: "SELECT subject, predicate, object, coverage FROM junction_notes WHERE vault_path LIKE $like ORDER BY subject",
				bind: { $like: dir + '/%' },
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return result.map((r: unknown[]) => ({
				subject: String(r[0]),
				predicate: String(r[1]),
				object: String(r[2]),
				coverage: String(r[3]),
			}));
		}, JUNCTION_DIR);

		expect(rows.length).toBe(2);
		const predicates = rows.map((r) => r.predicate).sort();
		expect(predicates).toContain('covers');
		expect(predicates).toContain('evidences');
	});

	it('upserts ontologies for the phase2 prefixes', async () => {
		const ontologies = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const result = await handle.db.exec({
				sql: "SELECT id FROM ontologies WHERE id LIKE 'phase2%' ORDER BY id",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return result.map((r: unknown[]) => String(r[0]));
		});

		// Should have phase2 (concepts) + phase2-csf + phase2-iso (crosswalk subjects) + phase2-evidence (junctions)
		expect(ontologies).toContain('phase2');
		expect(ontologies.length).toBeGreaterThanOrEqual(2);
	});

	it('re-running projection is idempotent — counts unchanged', async () => {
		const before = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const concepts = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM concepts', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const mappings = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM mappings', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const junctions = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM junction_notes', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			return { concepts: Number(concepts), mappings: Number(mappings), junctions: Number(junctions) };
		});

		// Re-run projection
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		const after = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const concepts = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM concepts', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const mappings = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM mappings', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const junctions = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM junction_notes', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			return { concepts: Number(concepts), mappings: Number(mappings), junctions: Number(junctions) };
		});

		expect(after.concepts).toBe(before.concepts);
		expect(after.mappings).toBe(before.mappings);
		expect(after.junctions).toBe(before.junctions);
	});

	it('skips files without _crosswalker block', async () => {
		// Create a regular .md file (not Crosswalker-produced)
		await browser.executeObsidian(async ({ app }) => {
			const path = 'phase-2-not-crosswalker.md';
			const existing = app.vault.getAbstractFileByPath(path);
			// @ts-expect-error - check for TFile
			if (existing) await app.vault.trash(existing, false);
			await app.vault.create(path, '# Just a note\n\nNot a Crosswalker file.\n');
		});
		// CONDITION: the new plain note has a metadata-cache entry. The projector
		// fails closed on files it cannot read from the cache, so without this
		// the declaration could report a projection failure instead of a skip.
		const indexed = await browser.executeObsidian(async ({ app }, path) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const deadline = Date.now() + 15_000;
			for (;;) {
				const file = app.vault.getMarkdownFiles().find((candidate) => candidate.path === path);
				if (file && app.metadataCache.getFileCache(file) !== null) return true;
				if (Date.now() >= deadline) return false;
				await sleep(100);
			}
		}, 'phase-2-not-crosswalker.md');
		expect(indexed).toBe(true);

		// Re-run projection
		const result = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		// Skipped count should be > 0 (at least our regular .md file)
		expect(result.counts.skipped).toBeGreaterThan(0);
		expect(result.success).toBe(true);
	});
});
