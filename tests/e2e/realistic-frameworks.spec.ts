/**
 * realistic-frameworks.spec.ts — real-world-shaped framework integration test
 *
 * Validates the full pipeline (import → projection → query → closure)
 * against synthetic-but-structurally-correct fixtures modeled on real
 * compliance frameworks. Catches the real-world data patterns the synthetic
 * mini-fixtures don't cover:
 *
 *   - Volume — 22 NIST AC controls, 25 CSF subcategories, 15 ISO clauses,
 *     19 MITRE techniques, 30 crosswalk edges
 *   - Hierarchy — parent_curie populated for enhancements / sub-categories
 *     / sub-techniques
 *   - Special characters in CURIEs:
 *       parens (NIST AC-2(1), AC-2(11), AC-2(13))
 *       dotted IDs (CSF GV.OC-01; ISO A.5.1; MITRE T1078.001)
 *   - Real CSV quirks — embedded commas in RFC-4180 quoted fields, em-dashes,
 *     long descriptions
 *   - Multi-framework vault — NIST + CSF + ISO + MITRE + crosswalks coexisting
 *   - Cross-ontology projection — ontologies table populated for all
 *   - Cross-framework crosswalk queries
 *   - Closure across crosswalk graph
 *
 * Run: bun run e2e -- --spec tests/e2e/realistic-frameworks.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { readFrontmatterFromDisk, requireFrontmatterIndexed, resetTier2Sidecar } from './helpers/vault-readiness';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import Papa from 'papaparse';

// ---------------------------------------------------------------------------
// Fixture loading helpers (Node-side; fixture data is loaded once per spec
// then passed into executeObsidian as a serialized argument)
// ---------------------------------------------------------------------------

function loadFixtureCsv(filename: string): { columns: string[]; rows: Record<string, string>[] } {
	const path = pathResolve(__dirname, '..', '..', 'tools', 'fixtures', 'realistic', filename);
	const text = readFileSync(path, 'utf8');
	const result = Papa.parse<Record<string, string>>(text, {
		header: true,
		skipEmptyLines: true,
		dynamicTyping: false,
	});
	if (result.errors.length > 0) {
		throw new Error(`CSV parse errors in ${filename}: ${result.errors.map((e) => e.message).join('; ')}`);
	}
	const columns = result.meta.fields ?? [];
	return { columns, rows: result.data };
}

// ---------------------------------------------------------------------------
// Recipe builders — generic concept-note + crosswalk-edge recipes for each
// framework's structural shape
// ---------------------------------------------------------------------------

function conceptRecipe(ontology: string, basePath: string) {
	return {
		recipe: `${ontology}-concept`,
		source: { ontology, levels: ['c'] },
		target: {
			layout: [{ level: 'c', mechanism: 'file' as const, template: '{id|fs-safe}.md' }],
			also_emit: {
				frontmatter: {
					managed: { title: '{title}' },
				},
			},
		},
	};
}

function crosswalkRecipe(name: string) {
	return {
		recipe: name,
		source: { ontology: 'nist-olir', levels: ['m'] },
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
						match_type: '{match_type}',
						mapping_justification: '{mapping_justification}',
						mapping_provider: '{mapping_provider}',
					},
				},
			},
		},
	};
}

const NIST_DIR = 'Frameworks/realistic-test/NIST-800-53-AC';
const CSF_DIR = 'Frameworks/realistic-test/NIST-CSF-2.0';
const ISO_DIR = 'Frameworks/realistic-test/ISO-27001-2022';
const MITRE_DIR = 'Frameworks/realistic-test/MITRE-ATTACK';
const CROSSWALK_DIR = 'Crosswalks/realistic-test';

describe('Crosswalker plugin — realistic framework fixtures (integration)', function () {
	this.timeout(180000);

	// Load all fixtures Node-side once; pass into executeObsidian as args.
	const nist = loadFixtureCsv('nist-800-53-ac-family.csv');
	const csf = loadFixtureCsv('nist-csf-2.0-govern-identify.csv');
	const iso = loadFixtureCsv('iso27001-2022-subset.csv');
	const mitre = loadFixtureCsv('mitre-attack-persistence-subset.csv');
	const crosswalk = loadFixtureCsv('csf-to-800-53-crosswalk.csv');

	before(async () => {
		// Clean prior test output. CONDITION: every destination is gone from the
		// vault index before the imports start.
		const stillPresent = await browser.executeObsidian(async ({ app }, dirs) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			for (const dir of dirs) {
				const folder = app.vault.getAbstractFileByPath(dir);
				if (folder) {
					// @ts-expect-error - internal trash API
					await app.vault.trash(folder, false);
				}
			}
			const deadline = Date.now() + 8000;
			while (dirs.some((dir) => app.vault.getAbstractFileByPath(dir)) && Date.now() < deadline) await sleep(50);
			return dirs.filter((dir) => app.vault.getAbstractFileByPath(dir));
		}, [NIST_DIR, CSF_DIR, ISO_DIR, MITRE_DIR, CROSSWALK_DIR]);
		expect(stillPresent).toEqual([]);

		// Empty Tier 2 tables, not just a closed handle (triage 2026-08-24 §5.3).
		// The projection declaration asserts absolute counts, so stale rows from
		// an earlier spec would either mask a failure or fake a pass.
		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);
		expect(reset.counts.concepts).toBe(0);
		expect(reset.counts.mappings).toBe(0);
	});

	// -------------------------------------------------------------------------
	// 1. NIST 800-53 r5 AC family — special chars in CURIEs (parens), hierarchy
	// -------------------------------------------------------------------------
	it('imports NIST 800-53 AC family with parens-CURIE special chars + hierarchy', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error
				const plugin = app.plugins.plugins['crosswalker'];
				const parsedData = {
					columns: args.columns,
					rows: args.rows,
					rowCount: args.rows.length,
					source: { type: 'csv' as const },
					headerRow: 0,
				};
				return plugin.runImportFromRecipe(parsedData, args.recipe, {
					basePath: args.dir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
					sourceFileName: 'nist-800-53-ac-family.csv',
				});
			},
			{
				columns: nist.columns,
				rows: nist.rows,
				recipe: conceptRecipe('nist', NIST_DIR),
				dir: NIST_DIR,
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(nist.rows.length); // 22 controls

		// Verify a special-char CURIE survived: AC-2(1) — has parens.
		// Empirically (verified 2026-05-06) Obsidian + the bundled engine
		// preserve hyphens AND parens in filenames; actual filename is
		// AC-2(1).md. The CURIE pattern admits this shape. (fs-safe filter
		// behavior with hyphens is a separate investigation; not blocking.)
		// WRITER CONTRACT → read the generated note from disk (triage §5.2); no
		// indexing wait is needed at all for this class of assertion.
		const fm = await readFrontmatterFromDisk(`${NIST_DIR}/AC-2(1).md`) as Record<string, any> | null;

		expect(fm).toBeTruthy();
		expect(fm!.curie).toBe('nist:AC-2(1)');
		expect(fm!.title).toContain('Automated System Account Management');
		// Validation strict mode passed → CURIE pattern admits parens
	});

	// -------------------------------------------------------------------------
	// 2. NIST CSF 2.0 GOVERN+IDENTIFY — dotted IDs + 3-level hierarchy
	// -------------------------------------------------------------------------
	it('imports NIST CSF 2.0 subset with dotted IDs (GV.OC-01)', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error
				const plugin = app.plugins.plugins['crosswalker'];
				const parsedData = {
					columns: args.columns,
					rows: args.rows,
					rowCount: args.rows.length,
					source: { type: 'csv' as const },
					headerRow: 0,
				};
				return plugin.runImportFromRecipe(parsedData, args.recipe, {
					basePath: args.dir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
			},
			{
				columns: csf.columns,
				rows: csf.rows,
				recipe: conceptRecipe('nist-csf', CSF_DIR),
				dir: CSF_DIR,
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(csf.rows.length); // 25 entries

		// Verify dotted-CURIE survived: GV.OC-01 → filename keeps hyphen +
		// dots, so actual filename is GV.OC-01.md
		// WRITER CONTRACT → read from disk, not the metadata cache (triage §5.2).
		const fm = await readFrontmatterFromDisk(`${CSF_DIR}/GV.OC-01.md`) as Record<string, any> | null;

		expect(fm).toBeTruthy();
		expect(fm!.curie).toBe('nist-csf:GV.OC-01');
	});

	// -------------------------------------------------------------------------
	// 3. ISO 27001:2022 — dotted IDs + UTF-8 (em-dashes)
	// -------------------------------------------------------------------------
	it('imports ISO 27001:2022 subset with dotted IDs (A.5.1) + em-dashes in titles', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error
				const plugin = app.plugins.plugins['crosswalker'];
				const parsedData = {
					columns: args.columns,
					rows: args.rows,
					rowCount: args.rows.length,
					source: { type: 'csv' as const },
					headerRow: 0,
				};
				return plugin.runImportFromRecipe(parsedData, args.recipe, {
					basePath: args.dir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
			},
			{
				columns: iso.columns,
				rows: iso.rows,
				recipe: conceptRecipe('iso27001', ISO_DIR),
				dir: ISO_DIR,
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(iso.rows.length); // 15

		// Verify dotted CURIE: A.5.1 → fs-safe filename A.5.1.md (dots survive)
		// WRITER CONTRACT → read from disk, not the metadata cache (triage §5.2).
		const fm = await readFrontmatterFromDisk(`${ISO_DIR}/A.5.1.md`) as Record<string, any> | null;

		expect(fm).toBeTruthy();
		expect(fm!.curie).toBe('iso27001:A.5.1');
	});

	// -------------------------------------------------------------------------
	// 4. MITRE ATT&CK — dotted technique IDs (T1078.001) + sub-technique hierarchy
	// -------------------------------------------------------------------------
	it('imports MITRE ATT&CK Persistence subset with dotted technique IDs (T1078.001)', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error
				const plugin = app.plugins.plugins['crosswalker'];
				const parsedData = {
					columns: args.columns,
					rows: args.rows,
					rowCount: args.rows.length,
					source: { type: 'csv' as const },
					headerRow: 0,
				};
				return plugin.runImportFromRecipe(parsedData, args.recipe, {
					basePath: args.dir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
			},
			{
				columns: mitre.columns,
				rows: mitre.rows,
				recipe: conceptRecipe('mitre-attack', MITRE_DIR),
				dir: MITRE_DIR,
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(mitre.rows.length); // 19

		// Verify dotted CURIE: T1078.001 → fs-safe filename T1078.001.md
		// WRITER CONTRACT → read from disk, not the metadata cache (triage §5.2).
		const fm = await readFrontmatterFromDisk(`${MITRE_DIR}/T1078.001.md`) as Record<string, any> | null;

		expect(fm).toBeTruthy();
		expect(fm!.curie).toBe('mitre-attack:T1078.001');
	});

	// -------------------------------------------------------------------------
	// 5. CSF → 800-53 + ISO crosswalk import — STRM enforced; SSSOM envelope
	// -------------------------------------------------------------------------
	it('imports CSF → 800-53 + ISO OLIR crosswalk with STRM predicates + SSSOM envelope', async () => {
		const result = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error
				const plugin = app.plugins.plugins['crosswalker'];
				const parsedData = {
					columns: args.columns,
					rows: args.rows,
					rowCount: args.rows.length,
					source: { type: 'csv' as const },
					headerRow: 0,
				};
				return plugin.runImportFromRecipe(parsedData, args.recipe, {
					basePath: args.dir,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
				});
			},
			{
				columns: crosswalk.columns,
				rows: crosswalk.rows,
				recipe: crosswalkRecipe('realistic-csf-to-800-53-iso'),
				dir: CROSSWALK_DIR,
			},
		);

		expect(result.success).toBe(true);
		expect(result.created.length).toBe(crosswalk.rows.length); // 30
	});

	// -------------------------------------------------------------------------
	// 6. Multi-framework projection — Tier 2 populated for ALL ontologies
	// -------------------------------------------------------------------------
	it('projects all frameworks into Tier 2; ontologies table populated for each', async () => {
		// CONDITION: every note written by declarations 1-5 is indexed with
		// readable `_crosswalker` frontmatter. `src/tier2/projector.ts` fails the
		// entire full projection closed on the first file it cannot read, which is
		// how this declaration and the four downstream of it all reported empty
		// results in the 2026-08-22 run (triage §5.2).
		await requireFrontmatterIndexed({ pathPrefixes: NIST_DIR, expectedCount: nist.rows.length, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: CSF_DIR, expectedCount: csf.rows.length, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: ISO_DIR, expectedCount: iso.rows.length, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: MITRE_DIR, expectedCount: mitre.rows.length, requireKeys: ['_crosswalker'] });
		await requireFrontmatterIndexed({ pathPrefixes: CROSSWALK_DIR, expectedCount: crosswalk.rows.length, requireKeys: ['_crosswalker'] });

		const result = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		expect(result.success).toBe(true);
		expect(result.counts.concepts).toBeGreaterThanOrEqual(70); // ~22 + 25 + 15 + 19 = 81
		expect(result.counts.mappings).toBeGreaterThanOrEqual(30); // 30 crosswalk edges
		expect(result.counts.ontologies).toBeGreaterThanOrEqual(4); // nist + nist-csf + iso27001 + mitre-attack

		// Verify ontologies table contains all expected IDs
		const ontologies = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = await handle.db.exec({
				sql: 'SELECT id FROM ontologies ORDER BY id',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return rows.map((r: unknown[]) => String(r[0]));
		});

		expect(ontologies).toContain('nist');
		expect(ontologies).toContain('nist-csf');
		expect(ontologies).toContain('iso27001');
		expect(ontologies).toContain('mitre-attack');
	});

	// -------------------------------------------------------------------------
	// 7. Cross-framework crosswalk query — direct edges between two ontologies
	// -------------------------------------------------------------------------
	it('queryCrosswalk between nist-csf and nist returns CSF→800-53 edges', async () => {
		const edges = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryCrosswalk('nist-csf', 'nist');
		});

		// At least the CSF→800-53 edges from the fixture (excluding ISO targets)
		expect(edges.length).toBeGreaterThanOrEqual(15);
		// All edges are nist-csf → nist
		for (const e of edges) {
			expect(e.subject_id.startsWith('nist-csf:')).toBe(true);
			expect(e.object_id.startsWith('nist:')).toBe(true);
		}
		// All predicates are STRM-valid (would have failed validation otherwise)
		const validStrm = ['is_equivalent_to', 'is_broader_than', 'is_narrower_than', 'is_approximate_to', 'intersects_with', 'no_relationship'];
		for (const e of edges) {
			expect(validStrm).toContain(e.predicate_id);
		}
	});

	// -------------------------------------------------------------------------
	// 8. Cross-framework closure — chains via the crosswalk graph
	// -------------------------------------------------------------------------
	it('queryClosure from nist-csf:GV.OC-01 reaches nist + iso27001 ontologies', async () => {
		const closure = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryClosure('nist-csf:GV.OC-01');
		});

		// GV.OC-01 has direct edges to nist:PM-1 + iso27001:A.5.1 in the fixture
		const targets = closure.map((c: any) => c.target_curie);
		expect(targets).toContain('nist:PM-1');
		expect(targets).toContain('iso27001:A.5.1');
	});

	// -------------------------------------------------------------------------
	// 9. Re-projection idempotency on realistic data
	// -------------------------------------------------------------------------
	it('re-running projection on realistic data is idempotent', async () => {
		const before = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const c = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM concepts', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const m = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM mappings', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			return { concepts: Number(c), mappings: Number(m) };
		});

		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		});

		const after = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const c = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM concepts', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			const m = (await handle.db.exec({ sql: 'SELECT COUNT(*) FROM mappings', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])[0][0];
			return { concepts: Number(c), mappings: Number(m) };
		});

		expect(after.concepts).toBe(before.concepts);
		expect(after.mappings).toBe(before.mappings);
	});
});
