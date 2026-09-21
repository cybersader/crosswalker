/**
 * full-cri-profile-import.spec.ts — opt-in corpus proof for the CRI Profile
 * v2.2 flat recipe.
 *
 * Closes acceptance case 1.14 of the 2026-08-26 template-engine contract: the
 * `CRI Profile v2.2 Diagnostic Statement` column contains dots in its NAME, so
 * before segment-level literal-key quoting every one of the 472 rows threw a
 * RenderError and every generated note was bodyless. This spec proves the
 * whole corpus now renders through the shipped engine path with zero errors
 * and zero empty bodies.
 *
 * RIGHTS — RESTRICTED SOURCE. The CRI Profile workbook is CC BY-NC-ND and is
 * held local-only under the gitignored `Frameworks/` directory. This spec is
 * deliberately written to assert STRUCTURAL FACTS ONLY: note counts, body
 * emptiness, recipe-authored section headings, render-error counts, and
 * lengths. It never asserts on, logs, or screenshots any framework prose, and
 * it takes NO screenshots at all. Every assertion message is derived from a
 * path or a count. Corpus provenance and rights posture:
 * https://cybersader.github.io/crosswalker/reference/framework-corpus/
 *
 * Run only when explicitly requested:
 *   CW_SCALE=1 DISPLAY=:0 bun run e2e -- --spec tests/e2e/full-cri-profile-import.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { readFrontmatterFromDisk, requireFrontmatterIndexed } from './helpers/vault-readiness';
import { splitCrosswalkCell } from '../../src/import/detection';

const RUN_SCALE = process.env.CW_SCALE === '1';
const describeScale = RUN_SCALE ? describe : describe.skip;

const CORPUS_PATH = path.resolve(__dirname, '..', '..', 'Frameworks', 'CRI-Profile-ver.-2.2.2026-04-27.xlsx');
const RECIPE_PATH = path.resolve(__dirname, '..', '..', 'recipes', 'import', 'cri-profile-v2-2.json');
const SOURCE_FILE_NAME = 'CRI-Profile-ver.-2.2.2026-04-27.xlsx';
const SHEET = 'CRI Profile v2.2 Structure';
const HEADER_ROW = 2;
const DESTINATION = 'Frameworks/full-cri-profile-scale';
const EXPECTED_RECORD_COUNT = 472;
const ONTOLOGY = 'cri-profile';
const CURIE_PATTERN = /^[a-z][a-z0-9_-]*:[A-Za-z0-9._\-()/]+$/;
const PROSE_COLUMN = 'CRI Profile v2.2 Diagnostic Statement';
const PATH_COLUMN = 'CRI Profile Function / Category / Subcategory';
const BODY_HEADING = '## Diagnostic statement';
const CROSSWALK_COLUMN = 'NIST CSF v2 Mapping';
const MAPPING_DESTINATION = '_crosswalker/mappings/cri-profile-to-nist-csf-2';

/** Mirror src/import/parsers/xlsx-parser.ts exactly: normKey + raw:false + defval:''. */
const normKey = (key: string): string => key.replace(/\s+/g, ' ').trim();

function loadCorpus(): { columns: string[]; rows: Record<string, string>[] } {
	const workbook = XLSX.read(readFileSync(CORPUS_PATH), { type: 'buffer' });
	const sheet = workbook.Sheets[SHEET];
	if (!sheet) throw new Error(`sheet "${SHEET}" missing from the CRI workbook`);
	const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
		range: HEADER_ROW, defval: '', blankrows: false, raw: false,
	});
	const rows = raw.map((record) => {
		const row: Record<string, string> = {};
		for (const [key, value] of Object.entries(record)) {
			row[normKey(key)] = value === null || value === undefined ? '' : String(value).trim();
		}
		return row;
	});
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key); }
	return { columns, rows };
}

function metric(name: string, value: number | string): void {
	console.log(`CW_SCALE_METRIC ${name}=${value}`);
}

async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const started = Date.now();
	const result = await operation();
	metric(name, Date.now() - started);
	return result;
}

describeScale('Crosswalker plugin — CRI Profile v2.2 flat recipe corpus proof (restricted source)', function () {
	this.timeout(10 * 60_000);

	it('imports all 472 rows with zero render errors and zero bodyless notes', async () => {
		const specStarted = Date.now();

		const corpus = loadCorpus();
		const recipe = JSON.parse(readFileSync(RECIPE_PATH, 'utf8'));
		expect(corpus.rows.length).toBe(EXPECTED_RECORD_COUNT);
		expect(new Set(corpus.rows.map((row) => row['Profile Id'])).size).toBe(EXPECTED_RECORD_COUNT);
		expect(recipe.recipe).toBe('cri-profile-v2-2-flat');
		expect(recipe.source.ontology).toBe(ONTOLOGY);
		// The dotted column name is the whole reason this spec exists: its
		// presence in the header is what used to make the recipe unrenderable.
		expect(corpus.columns).toContain(PROSE_COLUMN);
		expect(PROSE_COLUMN.includes('.')).toBe(true);
		// Every row carries prose, so a bodyless note can only be an engine fault.
		expect(corpus.rows.filter((row) => (row[PROSE_COLUMN] ?? '').length > 0).length).toBe(EXPECTED_RECORD_COUNT);
		metric('parsed_record_count', corpus.rows.length);
		const expectedCrosswalkEdgeCount = corpus.rows.reduce(
			(total, row) => total + splitCrosswalkCell(row[CROSSWALK_COLUMN] ?? '').atoms.length,
			0,
		);
		metric('expected_crosswalk_edge_count', expectedCrosswalkEdgeCount);

		const cleanup = await browser.executeObsidian(async ({ app }, destinationRoots) => {
			for (const destinationRoot of destinationRoots) {
				const root = app.vault.getAbstractFileByPath(destinationRoot);
				if (root) {
					// @ts-expect-error - internal trash API, isolated E2E vault only
					await app.vault.trash(root, false);
				}
			}
			const deadline = Date.now() + 20_000;
			while (destinationRoots.some((root) => app.vault.getAbstractFileByPath(root)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return destinationRoots.every((root) => !app.vault.getAbstractFileByPath(root));
		}, ['Frameworks', MAPPING_DESTINATION]);
		expect(cleanup).toBe(true);

		// Mirrors ImportWizard.buildWorkbenchConfig() + recipeOverride exactly as
		// the other scale proofs do: the bundled recipe controls paths, frontmatter
		// and body; the leaf template controls the stable CURIE stem.
		const config = {
			name: 'shape-workbench',
			mapping: {
				hierarchy: [], frontmatter: [], links: [], body: [],
				filename: { template: '{Profile Id|fs-safe}.md', sanitize: true },
			},
		};
		const parsedData = {
			columns: corpus.columns,
			rows: corpus.rows,
			rowCount: corpus.rows.length,
			source: { type: 'xlsx' as const },
			headerRow: HEADER_ROW,
		};

		const generation = await timed('generation_wall_ms', () => browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - Crosswalker E2E API
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImport(args.parsedData, args.config, {
					basePath: args.destination,
					overwriteMode: 'replace',
					createFolders: true,
					strictValidation: true,
					sourceFileName: args.sourceFileName,
					recipeOverride: args.recipe,
				});
			},
			{ parsedData, config, destination: DESTINATION, sourceFileName: SOURCE_FILE_NAME, recipe },
		));

		// Error COUNT is asserted, and the error list is only ever compared to an
		// empty array — a failure message would print an engine message, never a
		// framework prose excerpt.
		expect(generation.errors.length).toBe(0);
		expect(generation.success).toBe(true);
		expect(generation.created.length).toBe(EXPECTED_RECORD_COUNT);
		expect(generation.skipped).toEqual([]);
		expect(generation.crosswalkEdges).toEqual({
			created: expectedCrosswalkEdgeCount,
			sets: [expect.stringMatching(/^iset-[a-z0-9]{6}$/)],
		});
		metric('generated_note_count', generation.created.length);
		metric('generated_crosswalk_edge_count', generation.crosswalkEdges.created);
		metric('render_error_count', generation.errors.length);
		metric('generation_engine_duration_ms', generation.duration);

		const indexed = await requireFrontmatterIndexed({
			pathPrefixes: DESTINATION,
			expectedCount: EXPECTED_RECORD_COUNT,
			requireKeys: ['curie', '_crosswalker'],
			timeoutMs: 120_000,
			pollMs: 100,
		});
		expect(indexed.total).toBe(EXPECTED_RECORD_COUNT);
		metric('metadata_index_settle_ms', indexed.waitedMs);
		const indexedEdges = await requireFrontmatterIndexed({
			pathPrefixes: MAPPING_DESTINATION,
			expectedCount: expectedCrosswalkEdgeCount,
			requireKeys: ['curie', 'subject_id', 'predicate_id', 'object_id', '_crosswalker'],
			timeoutMs: 120_000,
			pollMs: 100,
		});
		expect(indexedEdges.total).toBe(expectedCrosswalkEdgeCount);
		metric('crosswalk_metadata_index_settle_ms', indexedEdges.waitedMs);

		// Frontmatter shape check on one note, by KEY PRESENCE and by value SHAPE.
		// No source value is asserted literally except the row's own identifier,
		// which is a bare identifier and not framework prose.
		const firstId = corpus.rows[0]['Profile Id'];
		const sample = await readFrontmatterFromDisk(`${DESTINATION}/${firstId}.md`) as Record<string, any> | null;
		expect(sample).toBeTruthy();
		expect(typeof sample!.curie).toBe('string');
		expect(sample!.curie).toMatch(CURIE_PATTERN);
		expect(sample!.profile_id).toBe(firstId);
		expect(sample!.sector).toBe('financial-services');
		expect(sample!._crosswalker.recipe.id).toBe('cri-profile-v2-2-flat');
		expect(sample!._crosswalker.source_ref.file).toBe(SOURCE_FILE_NAME);

		const proof = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const stripFrontmatter = (markdown: string): string => {
				const normalized = markdown.replace(/\r\n/g, '\n');
				if (!normalized.startsWith('---\n')) return normalized.trim();
				const closing = normalized.indexOf('\n---\n', 4);
				return closing < 0 ? normalized.trim() : normalized.slice(closing + 5).trim();
			};
			// Every accumulator below is a COUNT or a PATH. Nothing derived from
			// framework prose leaves this callback.
			const missingFiles: string[] = [];
			const emptyBodies: string[] = [];
			const missingProseSection: string[] = [];
			const proseNotVerbatim: string[] = [];
			const headingNotFirstLine: string[] = [];
			const missingRegion: string[] = [];
			const headingNotThePath: string[] = [];
			const bodyCharacterCounts: number[] = [];
			const frontmatterKeyUnion = new Set<string>();
			const frontmatterKeyCounts: Record<string, number> = {};

			// The note body now opens with the managed-region boundary (2026-08-27
			// managed body regions). Structural claims about "the first line" are
			// claims about the first line INSIDE the region, so read through it.
			// Falls back to the raw body when no region is present, so a note that
			// somehow lost its boundary is still checked rather than skipped.
			const regionOf = (text: string): string => {
				const s = text.indexOf('<!-- crosswalker:body:start');
				const e = text.indexOf('<!-- crosswalker:body:end -->');
				if (s === -1 || e === -1) return text;
				const nl = text.indexOf('\n', s);
				return nl === -1 ? text : text.slice(nl + 1, e);
			};
			for (const row of args.rows) {
				const notePath = `${args.destination}/${row.profileId}.md`;
				const file = app.vault.getAbstractFileByPath(notePath);
				if (!file || !(file instanceof obsidian.TFile)) { missingFiles.push(notePath); continue; }
				const raw = await app.vault.read(file);
				const body = stripFrontmatter(raw);
				if (body.length === 0) emptyBodies.push(notePath);
				if (!body.includes(args.bodyHeading)) missingProseSection.push(notePath);
				// Verbatim check: the rendered body must contain the source cell.
				// Only the BOOLEAN result is retained.
				//
				// BOTH sides are line-ending normalized, and that is a correctness
				// requirement of the comparison rather than a loosening of it. 7 of the
				// 472 diagnostic-statement cells carry an embedded CRLF (measured
				// 2026-08-27: GV.RM-05.02, ID.RA-08.01, ID.RA-08.02, ID.IM-04.08,
				// PR.AA-03.02, PR.AT-02.07, DE.AE-02.01). The engine writes LF, which is
				// what a Markdown file should contain, and `stripFrontmatter` above
				// normalizes what it reads back -- so comparing a normalized body against
				// an un-normalized source flagged those 7 as prose loss when nothing had
				// been lost. Verified independently at the render() layer, where all 472
				// bodies contain their source cell byte-for-byte.
				const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
				if (!normalizeEol(body).includes(normalizeEol(row.prose))) proseNotVerbatim.push(notePath);
				// auto_heading proof, by structure not content: line 1 is an H1 and
				// its text equals the source path column.
				if (body.indexOf('<!-- crosswalker:body:start') === -1) missingRegion.push(notePath);
				const firstLine = regionOf(body).split('\n')[0];
				if (!firstLine.startsWith('# ')) headingNotFirstLine.push(notePath);
				if (firstLine.slice(2).trim() !== normalizeEol(row.pathText).trim()) headingNotThePath.push(notePath);
				bodyCharacterCounts.push(body.length);

				const cache = app.metadataCache.getFileCache(file);
				const frontmatter = cache?.frontmatter ?? {};
				for (const key of Object.keys(frontmatter)) {
					frontmatterKeyUnion.add(key);
					frontmatterKeyCounts[key] = (frontmatterKeyCounts[key] ?? 0) + 1;
				}
			}

			const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
			return {
				missingFiles, emptyBodies, missingProseSection, proseNotVerbatim,
				headingNotFirstLine, headingNotThePath, missingRegion,
				frontmatterKeys: Array.from(frontmatterKeyUnion).sort(),
				frontmatterKeyCounts,
				bodyCharacterMin: Math.min(...bodyCharacterCounts),
				bodyCharacterMax: Math.max(...bodyCharacterCounts),
				bodyCharacterTotal: sum(bodyCharacterCounts),
			};
		}, {
			rows: corpus.rows.map((row) => ({
				profileId: row['Profile Id'],
				prose: row[PROSE_COLUMN].trim(),
				pathText: row[PATH_COLUMN].trim(),
			})),
			destination: DESTINATION,
			bodyHeading: BODY_HEADING,
		});

		const edgeProof = await browser.executeObsidian(async ({ app }, args) => {
			const conceptSetIds = new Set<string>();
			for (const file of app.vault.getMarkdownFiles()) {
				if (!file.path.startsWith(`${args.conceptRoot}/`)) continue;
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				const id = fm?._crosswalker?.import_set?.id;
				if (typeof id === 'string') conceptSetIds.add(id);
			}
			const edgeSetIds = new Set<string>();
			let edgeCount = 0;
			let invalidOwnerCount = 0;
			let sourceFileMismatchCount = 0;
			for (const file of app.vault.getMarkdownFiles()) {
				if (!file.path.startsWith(`${args.mappingRoot}/`)) continue;
				edgeCount += 1;
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				if (fm?._crosswalker?.import_set?.ontology !== 'sssom') invalidOwnerCount += 1;
				if (fm?._crosswalker?.source_ref?.file !== args.sourceFileName) sourceFileMismatchCount += 1;
				const id = fm?._crosswalker?.import_set?.id;
				if (typeof id === 'string') edgeSetIds.add(id);
			}
			return {
				edgeCount,
				invalidOwnerCount,
				sourceFileMismatchCount,
				conceptSetCount: conceptSetIds.size,
				edgeSetCount: edgeSetIds.size,
				sharedSetCount: [...edgeSetIds].filter((id) => conceptSetIds.has(id)).length,
			};
		}, {
			conceptRoot: DESTINATION,
			mappingRoot: MAPPING_DESTINATION,
			sourceFileName: SOURCE_FILE_NAME,
		});
		expect(edgeProof).toEqual({
			edgeCount: expectedCrosswalkEdgeCount,
			invalidOwnerCount: 0,
			sourceFileMismatchCount: 0,
			conceptSetCount: 1,
			edgeSetCount: 1,
			sharedSetCount: 0,
		});

		// THE acceptance case: was 472 bodyless notes, must now be zero.
		expect(proof.missingFiles.length).toBe(0);
		expect(proof.emptyBodies.length).toBe(0);
		expect(proof.missingProseSection.length).toBe(0);
		expect(proof.proseNotVerbatim.length).toBe(0);
		// auto_heading: every note opens on an H1 whose text is the source path.
		expect(proof.headingNotFirstLine.length).toBe(0);
		// Every generated note carries the managed-body boundary, or a person's
		// prose in it would be unprotected on the next re-import.
		expect(proof.missingRegion).toEqual([]);
		expect(proof.headingNotThePath.length).toBe(0);
		expect(proof.frontmatterKeys).not.toEqual(expect.arrayContaining([
			'subject_id', 'predicate_id', 'object_id', 'mapping_justification',
		]));

		metric('bodyless_note_count', proof.emptyBodies.length);
		metric('notes_missing_prose_section', proof.missingProseSection.length);
		metric('notes_whose_prose_is_not_verbatim', proof.proseNotVerbatim.length);
		metric('notes_without_h1_first_line', proof.headingNotFirstLine.length);
		metric('body_characters_min', proof.bodyCharacterMin);
		metric('body_characters_max', proof.bodyCharacterMax);
		metric('body_characters_total', proof.bodyCharacterTotal);
		metric('frontmatter_keys', JSON.stringify(proof.frontmatterKeys));
		metric('frontmatter_key_row_counts', JSON.stringify(proof.frontmatterKeyCounts));

		// The tier facets are blank on the 154 non-DS rows and the engine omits
		// rather than writing an empty key, so their presence count must equal the
		// DS row count. This pins the "empty value omitted" behaviour on real data.
		const dsRowCount = corpus.rows.filter((row) => row['Level'] === 'DS').length;
		expect(proof.frontmatterKeyCounts['tier_1']).toBe(dsRowCount);
		metric('ds_row_count', dsRowCount);

		metric('total_spec_ms', Date.now() - specStarted);
	});
});
