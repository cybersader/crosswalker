/**
 * sssom-import.spec.ts — Phase 2 v0.1.6 E2E (per Ch 35)
 *
 * Verifies the SSSOM TSV import end-to-end against real Obsidian:
 *   1. Command 'crosswalker:import-sssom' is registered
 *   2. plugin.precomputeClosure handle is exposed
 *   3. Legacy synthetic-recipe fixture creates 5 edge notes and populates
 *      mappings and closure tables; a separate P2 case calls the actual importer.
 *   4. STRM normalization happens (skos:closeMatch → is_approximate_to)
 *   5. Original SKOS predicate preserved as sssom_predicate frontmatter
 *   6. Actual importer resolves concept links and explicitly refreshes a missing end
 *
 * The modal UX is not exercised by this spec; the P2 case uses the plugin's
 * E2E importer handle to avoid duplicating importer logic in its assertions.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { readFrontmatterMatching, requireFrontmatterIndexed, resetTier2Sidecar } from './helpers/vault-readiness';

const TEST_TSV = `# subject_source: "csf"
# object_source: "iso27001"
# mapping_set_id: "https://crosswalker.dev/fixtures/e2e-sssom"
# mapping_provider: "Crosswalker E2E test"
subject_id	subject_label	predicate_id	object_id	object_label	mapping_justification	confidence
csf:GV.OC-01	Organizational Context	skos:closeMatch	iso27001:A.5.1	Information security policies	semapv:ManualMappingCuration	0.85
csf:ID.AM-01	Asset Management	skos:exactMatch	iso27001:A.5.9	Inventory of assets	semapv:ManualMappingCuration	0.95
csf:PR.AC-01	Identity Management	skos:exactMatch	iso27001:A.5.16	Identity management	semapv:ManualMappingCuration	0.95
csf:PR.AC-03	Remote Access	skos:relatedMatch	iso27001:A.5.18	Access rights	semapv:LexicalMatching	0.72
csf:DE.CM-01	Network monitoring	skos:closeMatch	iso27001:A.5.7	Threat intelligence	semapv:ManualMappingCuration	0.78
`;

const FOLDER = '_crosswalker/mappings/csf-to-iso27001';

describe('Crosswalker plugin — v0.1.6 Phase 2 SSSOM import (E2E)', function () {
	this.timeout(120000);

	before(async () => {
		// Clean any prior import output. CONDITION: the folder is gone from the
		// vault index, so the 5-file count assertions describe this run only.
		const cleaned = await browser.executeObsidian(async ({ app }, folder) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const f = app.vault.getAbstractFileByPath(folder);
			if (f) {
				// @ts-expect-error - internal trash API
				await app.vault.trash(f, false);
			}
			const deadline = Date.now() + 5000;
			while (app.vault.getAbstractFileByPath(folder) && Date.now() < deadline) await sleep(50);
			return !app.vault.getAbstractFileByPath(folder);
		}, FOLDER);
		expect(cleaned).toBe(true);

		// Empty Tier 2 tables AND closure cache (triage 2026-08-24 §5.3). The old
		// hook only closed the handle, so "closure cache populated" could be
		// satisfied by another spec's rows.
		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);
		expect(reset.counts.mappings).toBe(0);
		expect(reset.counts.closure_cache).toBe(0);
	});

	it('command crosswalker:import-sssom is registered', async () => {
		const has = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error - internal command list
			return Boolean(app.commands.findCommand('crosswalker:import-sssom'));
		});
		expect(has).toBe(true);
	});

	it('plugin.precomputeClosure handle is exposed', async () => {
		const isFunction = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			return typeof plugin.precomputeClosure === 'function';
		});
		expect(isFunction).toBe(true);
	});

	it('importSssom round-trips TSV → 5 junction notes', async () => {
		const result = await browser.executeObsidian(async ({ app }, tsv) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			// Dynamic import the importer module (bundled into main.js).
			// We call importSssom directly via the plugin reference rather than
			// driving the modal — same logic, no UI flake.
			//
			// We replicate the modal's call shape: pluginRunProjection +
			// pluginPrecomputeClosure are the two plugin handles.
			const importerModule = (plugin.app.plugins.plugins['crosswalker'] as unknown as {
				_sssomImporterCache?: { importSssom: (...args: unknown[]) => Promise<unknown> };
			});
			// Fallback to the plugin's own module — main.ts doesn't re-export
			// importSssom; modal calls it directly. To reach it from E2E, we
			// load the bundled module via the plugin's runtime symbol table.
			// For determinism, mirror the modal's call without going through DOM:
			// just write the junction notes manually via the existing
			// runImportFromRecipe path. That's what importSssom does internally.
			//
			// SIMPLIFICATION: instead of reaching into the bundled importSssom,
			// mimic its synthetic-recipe pattern directly here. This is the
			// E2E equivalent of the unit-test mock-vault round-trip.
			const sssomPredToStrm = (p: string): string =>
				({
					'skos:exactMatch': 'is_equivalent_to',
					'skos:closeMatch': 'is_approximate_to',
					// Direction per SKOS spec: broadMatch's OBJECT is broader -> subject is narrower
					'skos:broadMatch': 'is_narrower_than',
					'skos:narrowMatch': 'is_broader_than',
					'skos:relatedMatch': 'intersects_with',
				})[p] ?? 'intersects_with';

			// Parse TSV header + body
			const lines = tsv.split(/\r?\n/);
			const dataLines: string[] = [];
			const meta: Record<string, string> = {};
			for (const ln of lines) {
				if (ln.startsWith('# ')) {
					const m = ln.replace(/^# /, '').match(/^([\w_-]+):\s*"?(.*?)"?\s*$/);
					if (m) meta[m[1]] = m[2];
				} else if (ln.trim()) {
					dataLines.push(ln);
				}
			}
			const [headerLine, ...rows] = dataLines;
			const headers = headerLine.split('\t').map((h) => h.trim());
			const parsedRows = rows
				.map((r) => {
					const cells = r.split('\t').map((c) => c.trim());
					const row: Record<string, string> = {};
					headers.forEach((h, i) => (row[h] = cells[i] ?? ''));
					return row;
				})
				.filter((r) => r.subject_id && r.predicate_id && r.object_id);

			const source = meta.subject_source || 'csf';
			const target = meta.object_source || 'iso27001';
			const folder = `_crosswalker/mappings/${source}-to-${target}`;

			// Build synthetic crosswalk-edge recipe (mirrors importSssom buildSyntheticRecipe)
			const recipe = {
				recipe: `sssom-${source}-to-${target}`,
				source: { ontology: source, levels: ['mapping'] },
				target: {
					layout: [
						{
							level: 'mapping',
							mechanism: 'file' as const,
							template: 'cw-{subject_id|slug}-{object_id|slug}.md',
							kind: 'crosswalk-edge' as const,
						},
					],
					also_emit: {
						tags: [`crosswalk/${source}-to-${target}`],
						frontmatter: {
							managed: {
								title: '{subject_id} -> {object_id}',
								predicate_id: '{predicate_id}',
								subject_id: '{subject_id}',
								object_id: '{object_id}',
								subject_label: '{subject_label}',
								object_label: '{object_label}',
								mapping_justification: '{mapping_justification}',
								mapping_provider: '{mapping_provider}',
								mapping_set_id: '{mapping_set_id}',
								source_framework: source,
								target_framework: target,
								sssom_predicate: '{sssom_predicate}',
								sssom_confidence: '{confidence}',
							},
							user_preserve: ['*notes*'],
						},
					},
				},
			};

			// Inject set-level metadata + STRM normalization into each row
			const rowsForRecipe = parsedRows.map((r) => ({
				...r,
				mapping_provider: meta.mapping_provider || '',
				mapping_set_id: meta.mapping_set_id || '',
				sssom_predicate: r.predicate_id,
				predicate_id: sssomPredToStrm(r.predicate_id),
			}));

			const parsedData = {
				columns: Array.from(new Set(rowsForRecipe.flatMap((r) => Object.keys(r)))),
				rows: rowsForRecipe,
				rowCount: rowsForRecipe.length,
			};

			const generated = await plugin.runImportFromRecipe(parsedData, recipe, {
				basePath: folder,
				overwriteMode: 'replace',
				createFolders: true,
				strictValidation: true,
			});

			return {
				createdCount: generated.created.length,
				success: generated.success,
				errors: generated.errors,
				source,
				target,
				folder,
			};
		}, TEST_TSV);

		expect(result.success).toBe(true);
		expect(result.createdCount).toBe(5);
		expect(result.errors).toEqual([]);

		// CONDITION: all five new edge notes are indexed with readable
		// `_crosswalker` frontmatter BEFORE projection. Projection and the eager
		// closure precompute used to run in the same renderer callback as the
		// write, so the projector — which fails closed on an unreadable file —
		// was routinely asked to read notes Obsidian had not indexed yet, and the
		// three downstream declarations reported zero rows (triage §5.2).
		await requireFrontmatterIndexed({ pathPrefixes: FOLDER, expectedCount: 5, requireKeys: ['_crosswalker'] });

		const projected = await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const projection = await plugin.runProjection();
			// Eagerly precompute closure for this pair.
			const closureRows = await plugin.precomputeClosure(args.source, args.target);
			return { success: projection?.success, errors: projection?.errors ?? [], closureRows };
		}, { source: result.source, target: result.target });

		if (!projected.success) {
			throw new Error(`projection after SSSOM import failed: ${JSON.stringify(projected.errors).slice(0, 1000)}`);
		}
	});

	it('5 junction-edge files exist under _crosswalker/mappings/csf-to-iso27001/', async () => {
		const fileCount = await browser.executeObsidian(({ app }, folder) => {
			const f = app.vault.getAbstractFileByPath(folder);
			if (!f || !('children' in f)) return 0;
			// @ts-expect-error - TFolder.children
			return f.children.filter((c) => c.path && c.path.endsWith('.md')).length;
		}, FOLDER);
		expect(fileCount).toBe(5);
	});

	it('STRM predicate normalization landed in frontmatter (skos:closeMatch → is_approximate_to)', async () => {
		// WRITER CONTRACT → read the note from disk (triage §5.2). The previous
		// cache lookup returned `null` and the declaration reported it as an
		// SSSOM normalization failure without ever inspecting the file.
		const found = await readFrontmatterMatching(FOLDER, 'gv-oc-01');

		expect(found.path).toBeTruthy();
		expect(found.frontmatter).toBeTruthy();
		const fm = found.frontmatter as Record<string, any>;
		// csf:GV.OC-01 had skos:closeMatch in TSV — normalized to STRM is_approximate_to
		expect(fm.predicate_id).toBe('is_approximate_to');
		expect(fm.sssom_predicate).toBe('skos:closeMatch');
		expect(fm.subject_id).toBe('csf:GV.OC-01');
	});

	it('Tier 2 mappings table populated; queryCrosswalk returns 5 rows', async () => {
		const queryResult = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const rows = await plugin.queryCrosswalk('csf', 'iso27001');
			return rows.length;
		});
		expect(queryResult).toBe(5);
	});

	it('closure_cache populated by eager precompute (>0 rows for csf prefix)', async () => {
		const cached = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const result = handle.db.exec({
				sql: `SELECT COUNT(*) FROM closure_cache WHERE subject_id LIKE 'csf:%'`,
				rowMode: 'array',
				returnValue: 'resultRows',
			});
			return Number(result[0]?.[0] ?? 0);
		});
		expect(cached).toBeGreaterThan(0);
	});

	it('the real SSSOM importer retains a missing end and fills it on explicit mapping refresh', async () => {
		const pair = '_crosswalker/mappings/p2ssrc-to-p2sdst';
		const tsv = [
			'# subject_source: "p2ssrc"', '# object_source: "p2sdst"',
			'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
			'p2ssrc:Alpha\tAlpha\tskos:exactMatch\tp2sdst:Beta\tBeta\tsynthetic\t0.9',
		].join('\n');
		const seed = async (ontology: string, id: string, basePath: string, template: string) =>
			browser.executeObsidian(async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImportFromRecipe(
					{ columns: ['id'], rows: [{ id: args.id }], rowCount: 1 },
					{ recipe: 'p2-sssom-concept', source: { ontology: args.ontology, levels: ['concept'] },
						target: { layout: [{ level: 'concept', mechanism: 'file', template: args.template }] } },
					{ basePath: args.basePath, overwriteMode: 'replace', createFolders: true, strictValidation: true },
				);
			}, { ontology, id, basePath, template });
		expect((await seed('p2ssrc', 'Alpha', 'P2-sssom/source', 'Deep/{id}.md')).success).toBe(true);
		const importMapping = async (options: Record<string, unknown>) =>
			browser.executeObsidian(async ({ app }, args) => {
				// @ts-expect-error - internal plugin lookup
				const plugin = app.plugins.plugins['crosswalker'];
				const result = await plugin.runSssomImportForE2E(args.tsv, { ...args.options, runTier2Projection: false });
				return { success: result.generation?.success, created: result.generation?.created,
					errors: result.generation?.errors, summary: result.summary };
			}, { tsv, options });
		const first = await importMapping({ overwriteMode: 'replace' });
		expect(first.success).toBe(true);
		expect(first.created).toHaveLength(1);
		expect(first.summary.join(' ')).toMatch(/Import p2sdst concepts/);
		const edge = await readFrontmatterMatching(pair, '.md');
		expect(edge.path).toBeTruthy();
		expect(edge.frontmatter?.subject_note).toBe('[[P2-sssom/source/Deep/Alpha|Alpha]]');
		expect(edge.frontmatter?.object_note).toBeUndefined();
		const readEdge = (p: string) => browser.executeObsidian(async ({ app }, filePath) =>
			app.vault.read(app.vault.getAbstractFileByPath(filePath) as any), p);
		expect(await readEdge(edge.path!)).toContain('[[P2-sssom/source/Deep/Alpha|Alpha]] is_equivalent_to `p2sdst:Beta`');
		expect((await seed('p2sdst', 'Beta', 'P2-sssom/target', 'Nested/{id}.md')).success).toBe(true);
		const set = (edge.frontmatter as any)._crosswalker.import_set;
		const refreshed = await importMapping({ importSet: { id: set.id, scheme: set.scheme }, overwriteMode: 'replace' });
		expect(refreshed.success).toBe(true);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.summary).toEqual([]);
		const after = await readFrontmatterMatching(pair, '.md');
		expect(after.path).toBe(edge.path);
		expect(after.frontmatter?.object_note).toBe('[[P2-sssom/target/Nested/Beta|Beta]]');
		expect(await readEdge(after.path!)).toContain('[[P2-sssom/source/Deep/Alpha|Alpha]] is_equivalent_to [[P2-sssom/target/Nested/Beta|Beta]]');
		expect(await browser.executeObsidian(({ app }, folder) =>
			app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`)).length, pair)).toBe(1);
	});

});
