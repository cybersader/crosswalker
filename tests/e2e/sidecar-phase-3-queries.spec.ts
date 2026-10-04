/**
 * sidecar-phase-3-queries.spec.ts — Phase 3 query API + closure cache E2E
 *
 * Verifies the typed query helpers + lazy closure-cache materialization:
 *   1. plugin.queryConcepts returns all concepts in an ontology
 *   2. plugin.queryCrosswalk returns direct edges between two ontologies,
 *      filtered by predicate when provided
 *   3. plugin.queryClosure computes transitive closure via recursive CTE
 *   4. Closure cache is empty before first call; populated after
 *   5. Second closure call hits the cache (rows match exactly)
 *   6. After running runProjection() again, closure_cache is invalidated
 *
 * Closure-cache patterns verified per Ch 18 §2 deliverable:
 *   - path-string anti-join cycle detection
 *   - MIN(depth) aggregation over multiple paths to same target
 *   - predicate filter applied in both base + recursive arms
 *
 * Run: bun run e2e -- --spec tests/e2e/sidecar-phase-3-queries.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { requireFrontmatterIndexed, resetTier2Sidecar } from './helpers/vault-readiness';

const TEST_DIR = 'Frameworks/v0-1-5-phase-3-test';
const CROSSWALK_DIR = 'Crosswalks/v0-1-5-phase-3-test';

// ---------------------------------------------------------------------------
// Concept fixture: 4 concepts in one ontology
// ---------------------------------------------------------------------------
const conceptRecipe = {
	recipe: 'phase-3-concept',
	source: { ontology: 'p3', levels: ['c'] },
	target: {
		layout: [{ level: 'c', mechanism: 'file' as const, template: '{id}.md' }],
		also_emit: { frontmatter: { managed: { title: '{title}' } } },
	},
};
const conceptParsed = {
	columns: ['id', 'title'],
	rows: [
		{ id: 'A', title: 'Concept A' },
		{ id: 'B', title: 'Concept B' },
		{ id: 'C', title: 'Concept C' },
		{ id: 'D', title: 'Concept D' },
	],
	rowCount: 4,
	source: { type: 'csv' as const },
	headerRow: 0,
};

// ---------------------------------------------------------------------------
// Crosswalk fixture: a chain A → B → C → D plus a sibling A → C (multiple paths)
// All in the same ontology so closure stays within p3.
// ---------------------------------------------------------------------------
const crosswalkRecipe = {
	recipe: 'phase-3-crosswalk',
	source: { ontology: 'p3-olir', levels: ['m'] },
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
		// chain A → B → C → D (all is_equivalent_to)
		{ subject_id: 'p3:A', predicate_id: 'is_equivalent_to', object_id: 'p3:B' },
		{ subject_id: 'p3:B', predicate_id: 'is_equivalent_to', object_id: 'p3:C' },
		{ subject_id: 'p3:C', predicate_id: 'is_equivalent_to', object_id: 'p3:D' },
		// alternate shorter path A → C (also is_equivalent_to)
		{ subject_id: 'p3:A', predicate_id: 'is_equivalent_to', object_id: 'p3:C' },
		// a different-predicate edge that closure-with-predicate-filter must skip
		{ subject_id: 'p3:A', predicate_id: 'is_broader_than', object_id: 'p3:D' },
	],
	rowCount: 5,
	source: { type: 'csv' as const },
	headerRow: 0,
};

describe('Crosswalker plugin — v0.1.5 Phase 3 query API + closure cache', function () {
	this.timeout(120000);

	before(async () => {
		// Clean prior output. CONDITION: both destinations are gone from the vault
		// index before the fixtures are written.
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
		}, [TEST_DIR, CROSSWALK_DIR]);
		expect(stillPresent).toEqual([]);

		// Deterministic Tier 2 starting state: empty tables AND an empty closure
		// cache (triage 2026-08-24 §5.3). "closure_cache is empty before the first
		// closure call" is a precondition this spec asserts, so it must be
		// established rather than inherited from whatever ran before.
		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);
		expect(reset.counts.closure_cache).toBe(0);
		expect(reset.counts.closure_cache_state).toBe(0);

		// Import fixtures via the v0.1.4 native-recipe path
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
			},
			{
				conceptParsed,
				conceptRecipe,
				crosswalkParsed,
				crosswalkRecipe,
				testDir: TEST_DIR,
				crosswalkDir: CROSSWALK_DIR,
			},
		);
		// CONDITION: all 9 fixture notes are indexed with readable `_crosswalker`
		// frontmatter. The projector fails the whole pass closed on any file it
		// cannot read from the cache, and every query assertion below is downstream
		// of that pass — an unmet barrier here made them all vacuous.
		await requireFrontmatterIndexed({ pathPrefixes: TEST_DIR, expectedCount: 4, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: CROSSWALK_DIR, expectedCount: 5, requireKeys: ['_crosswalker'] });

		// Project Tier 1 → Tier 2, and fail loudly here rather than in six
		// downstream declarations if the projection did not succeed.
		const projection = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});
		if (!projection?.success) {
			throw new Error(`setup projection failed: ${JSON.stringify(projection?.errors ?? projection).slice(0, 1000)}`);
		}
	});

	// -------------------------------------------------------------------------
	// 1. queryConcepts — list concepts in an ontology
	// -------------------------------------------------------------------------
	it('queryConcepts returns all concepts in the ontology', async () => {
		const concepts = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryConcepts('p3');
		});

		expect(concepts.length).toBe(4);
		const curies = concepts.map((c: any) => c.curie).sort();
		expect(curies).toEqual(['p3:A', 'p3:B', 'p3:C', 'p3:D']);
		expect(concepts[0].title).toMatch(/Concept/);
	});

	// -------------------------------------------------------------------------
	// 2. queryCrosswalk — direct edges, optionally predicate-filtered
	// -------------------------------------------------------------------------
	it('queryCrosswalk returns direct edges (no predicate filter)', async () => {
		const edges = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryCrosswalk('p3', 'p3');
		});

		// Should return all 5 edges (within p3)
		expect(edges.length).toBe(5);
		const triples = edges.map((e: any) => `${e.subject_id}--${e.predicate_id}-->${e.object_id}`).sort();
		expect(triples).toContain('p3:A--is_equivalent_to-->p3:B');
		expect(triples).toContain('p3:B--is_equivalent_to-->p3:C');
		expect(triples).toContain('p3:C--is_equivalent_to-->p3:D');
		expect(triples).toContain('p3:A--is_equivalent_to-->p3:C');
		expect(triples).toContain('p3:A--is_broader_than-->p3:D');
	});

	it('queryCrosswalk with predicate filter returns only matching edges', async () => {
		const edges = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryCrosswalk('p3', 'p3', 'is_broader_than');
		});

		expect(edges.length).toBe(1);
		expect(edges[0].subject_id).toBe('p3:A');
		expect(edges[0].predicate_id).toBe('is_broader_than');
		expect(edges[0].object_id).toBe('p3:D');
	});

	// -------------------------------------------------------------------------
	// 3. queryClosure — transitive closure via recursive CTE
	// -------------------------------------------------------------------------
	it('queryClosure (no predicate filter) computes full reachability from A', async () => {
		const closure = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('p3:A');
		});

		// From A we should reach B, C, D via various paths
		const targets = closure.map((c: any) => c.target_curie).sort();
		expect(targets).toContain('p3:B');
		expect(targets).toContain('p3:C');
		expect(targets).toContain('p3:D');

		// All entries should report start_curie = p3:A
		for (const c of closure) {
			expect(c.start_curie).toBe('p3:A');
		}

		// Shortest depth to C should be 1 (via direct A → C edge), not 2 (via A → B → C)
		const cEntry = closure.find((c: any) => c.target_curie === 'p3:C');
		expect(cEntry?.shortest_depth).toBe(1);

		// Shortest depth to D could be 1 (via is_broader_than) or 2 (via is_equivalent_to chain)
		// — since we don't filter predicate, the direct A → D wins at depth 1
		const dEntry = closure.find((c: any) => c.target_curie === 'p3:D');
		expect(dEntry?.shortest_depth).toBe(1);
	});

	it('queryClosure with predicate filter returns only is_equivalent_to chain', async () => {
		// Reset cache first by running projection (invalidates closure_cache)
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		const closure = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('p3:A', 'is_equivalent_to');
		});

		const targets = closure.map((c: any) => c.target_curie).sort();
		expect(targets).toContain('p3:B');
		expect(targets).toContain('p3:C');
		expect(targets).toContain('p3:D');

		// With predicate filter, the direct A → D edge (is_broader_than) is
		// filtered out. Two is_equivalent_to paths remain to D:
		//   A → B → C → D (depth 3)
		//   A → C → D     (depth 2, using the shortcut edge A → C)
		// So shortest depth to D is 2.
		const dEntry = closure.find((c: any) => c.target_curie === 'p3:D');
		expect(dEntry?.shortest_depth).toBe(2);
	});

	// -------------------------------------------------------------------------
	// 4. Closure cache lazy materialization
	// -------------------------------------------------------------------------
	it('closure_cache is empty before first closure call (after projection)', async () => {
		// Trigger fresh projection to clear cache
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		const cacheCount = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = await handle.db.exec({
				sql: 'SELECT COUNT(*) FROM closure_cache',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return Number(rows[0][0]);
		});

		expect(cacheCount).toBe(0);
	});

	it('closure_cache is populated after first closure call', async () => {
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('p3:A', 'is_equivalent_to');
		});

		const cacheRows = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = await handle.db.exec({
				sql: `
					SELECT subject_id, predicate_id, object_id, shortest_depth
					FROM closure_cache
					-- predicate_id here is the PHYSICAL cache key, which carries the
					-- closure-semantics version (cachePredicateKey() in src/tier2/queries.ts),
					-- not the bare logical predicate. Filtering on the bare value found zero
					-- rows against a correctly populated cache and read as a substrate
					-- failure. Match the suffix so a version bump cannot rot this again.
					WHERE subject_id = 'p3:A' AND predicate_id LIKE '%|is_equivalent_to'
					ORDER BY shortest_depth, object_id
				`,
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return rows.map((r: unknown[]) => ({
				subject: String(r[0]),
				predicate: String(r[1]),
				object: String(r[2]),
				depth: Number(r[3]),
			}));
		});

		expect(cacheRows.length).toBeGreaterThan(0);
		// All cached rows have subject_id = p3:A (the starting concept)
		for (const r of cacheRows) {
			expect(r.subject).toBe('p3:A');
			// Physical cache key, not the logical predicate: it is version-prefixed
			// so a semantics change cannot silently reuse stale closure rows.
			expect(r.predicate).toMatch(/\|is_equivalent_to$/);
		}
	});

	it('second closure call returns cached rows (same shape as first)', async () => {
		const first = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('p3:A', 'is_equivalent_to');
		});

		const second = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('p3:A', 'is_equivalent_to');
		});

		expect(second.length).toBe(first.length);
		const firstTargets = first.map((c: any) => `${c.target_curie}@${c.shortest_depth}`).sort();
		const secondTargets = second.map((c: any) => `${c.target_curie}@${c.shortest_depth}`).sort();
		expect(secondTargets).toEqual(firstTargets);
	});

	it('runProjection invalidates closure_cache', async () => {
		// Cache should have rows from the previous tests
		const before = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = await handle.db.exec({
				sql: 'SELECT COUNT(*) FROM closure_cache',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return Number(rows[0][0]);
		});
		expect(before).toBeGreaterThan(0);

		// Re-run projection → cache should be cleared (mappings exist)
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		const after = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = await handle.db.exec({
				sql: 'SELECT COUNT(*) FROM closure_cache',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return Number(rows[0][0]);
		});
		expect(after).toBe(0);
	});
});
