/**
 * visual-cri-recipe.spec.ts — show what the CRI Profile v2.2 recipe produces.
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-cri-recipe.spec.ts
 *
 * WHY A SMALL SLICE (see visual-nist-recipe.spec.ts, the reference implementation)
 *
 * `full-cri-profile-import.spec.ts` imports all 472 rows to prove the corpus renders. After
 * a large generated import Obsidian's renderer stops answering CDP long enough that
 * `saveScreenshot` either times out or SILENTLY RETURNS THE PREVIOUS FRAME — two captures
 * once came out byte-identical that way and were nearly believed. So this spec imports a
 * deliberately small slice through the identical shipped path (`runImport` +
 * `recipeOverride`, exactly as the recognized-source wizard calls it) and photographs the
 * result. Same recipe, same engine, same code path.
 *
 * WHAT THIS FRAMEWORK IS THE PROOF OF. The CRI workbook is the source whose COLUMN NAMES
 * contain dots: `CRI Profile v2.2 Diagnostic Statement`. Until 2026-08-26 the template
 * grammar split every variable path on `.` unconditionally, so that reference resolved as a
 * multi-step object traversal, threw RenderError on every row, and left all 472 generated
 * notes BODYLESS — the framework's entire substance discarded on import. Segment-level
 * literal-key quoting fixed it and the recipe now addresses the column as
 * `{['CRI Profile v2.2 Diagnostic Statement']}`. This spec exists to show a body where there
 * used to be nothing, so the diagnostic-statement section is asserted present and non-empty
 * on every note in the slice — a bodyless note is the exact regression to catch.
 *
 * RIGHTS — RESTRICTED SOURCE. The CRI Profile workbook is licensed CC BY-NC-ND and is held
 * local-only under the gitignored `Frameworks/` directory. This spec is deliberately written
 * to assert STRUCTURAL FACTS ONLY: note counts, body emptiness, recipe-authored section
 * headings, render-error counts, key presence, and lengths. It never asserts on, logs, or
 * embeds any diagnostic-statement text; every assertion message is derived from a path, a
 * count, or an identifier.
 *
 * It DOES capture screenshots, unlike `full-cri-profile-import.spec.ts`, and that is a
 * deliberate difference rather than an oversight: `test-screenshots/` is gitignored, the
 * captures never leave this machine, and the owner licenses this corpus and needs to see
 * what the recipe renders. Nothing under `test-screenshots/` may be committed or published.
 * Corpus provenance and rights posture:
 * https://cybersader.github.io/crosswalker/reference/framework-corpus/
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import criRecipe from '../../recipes/import/cri-profile-v2-2.json';
import { readFrontmatterFromDisk, resetTier2Sidecar, waitForFrontmatterIndexed, waitForVaultIndexed } from './helpers/vault-readiness';

const OUT_DIR = path.resolve(__dirname, '..', '..', 'test-screenshots');
const CORPUS = path.resolve(__dirname, '..', '..', 'Frameworks', 'CRI-Profile-ver.-2.2.2026-04-27.xlsx');
const SOURCE_FILE_NAME = 'CRI-Profile-ver.-2.2.2026-04-27.xlsx';
const SHEET = 'CRI Profile v2.2 Structure';
/**
 * Header at sheet row INDEX 2: row 0 is a banner and row 1 is blank. At index 1 every column
 * parses as `__EMPTY` and every row fails on `{Profile Id}` — while the row COUNT stays 472
 * either way, which is what makes the wrong index easy to miss.
 */
const HEADER_ROW = 2;
const DESTINATION = 'Frameworks/CRI-recipe-visual';
const EXPECTED_RECORD_COUNT = 472;
/** The column whose NAME carries the dots. Its name is a header, not framework prose. */
const PROSE_COLUMN = 'CRI Profile v2.2 Diagnostic Statement';
const PATH_COLUMN = 'CRI Profile Function / Category / Subcategory';
const BODY_HEADING = '## Diagnostic statement';

/**
 * Profile ids chosen to exercise what a reader should be able to see.
 *
 * - The sheet carries all four profile levels in ONE table (F=Function, C=Category,
 *   S=Subcategory, DS=Diagnostic Statement) and the recipe emits one note per row, so the
 *   slice contains all four levels. That is not cosmetic: the four `tier_*` facets are blank
 *   on the 154 non-DS rows, so the F/C/S rows are the ones that prove the engine OMITS an
 *   empty managed key instead of writing it, and the DS rows are the ones that prove the
 *   facet is written when present.
 * - `GV.RM-05.02`, `ID.RA-08.01`, `PR.AA-03.02` and `DE.AE-02.01` are four of the seven rows
 *   in the corpus whose diagnostic statement carries an embedded CRLF. The engine writes LF,
 *   which is what a Markdown file should contain, so a verbatim comparison that does not
 *   normalize line endings reports prose loss where nothing was lost. Including them here
 *   keeps the comparison honest on the shape that fooled it once.
 * - Ids run `GV.OC-01.01`-style: dotted at two levels, so the file template is exercised on
 *   the deepest identifier shape the source produces.
 */
const WANTED = [
	'GV',           // F — no tier facets
	'GV.OC',        // C — no tier facets
	'GV.OC-01',     // S — no tier facets
	'GV.OC-01.01',  // DS
	'GV.RM-05.02',  // DS, embedded CRLF
	'ID',           // F
	'ID.AM',        // C
	'ID.AM-01',     // S
	'ID.AM-01.01',  // DS
	'ID.RA-08.01',  // DS, embedded CRLF
	'PR.AA-03.02',  // DS, embedded CRLF
	'DE.AE-02.01',  // DS, embedded CRLF
];

/** The subset above whose `Level` is DS, i.e. the rows that must carry tier facets. */
const DS_IDS = ['GV.OC-01.01', 'GV.RM-05.02', 'ID.AM-01.01', 'ID.RA-08.01', 'PR.AA-03.02', 'DE.AE-02.01'];
/** The subset whose tier facets are blank at source, so the keys must be absent. */
const NON_DS_IDS = ['GV', 'GV.OC', 'GV.OC-01', 'ID', 'ID.AM', 'ID.AM-01'];

/** Mirror src/import/parsers/xlsx-parser.ts exactly: normKey + raw:false + defval:''. */
const normKey = (key: string): string => key.replace(/\s+/g, ' ').trim();

interface SheetRow { [column: string]: string }

function loadCorpus(): { columns: string[]; rows: SheetRow[] } {
	const workbook = XLSX.read(readFileSync(CORPUS), { type: 'buffer' });
	const sheet = workbook.Sheets[SHEET];
	if (!sheet) throw new Error(`sheet "${SHEET}" missing from the CRI workbook`);
	const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
		range: HEADER_ROW, defval: '', blankrows: false, raw: false,
	});
	const rows = raw.map((record) => {
		const row: SheetRow = {};
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

describe('Visual — the CRI Profile v2.2 recipe (restricted source)', function () {
	this.timeout(180_000);

	let rows: SheetRow[] = [];
	let columns: string[] = [];

	before(() => {
		mkdirSync(OUT_DIR, { recursive: true });
		const corpus = loadCorpus();
		columns = corpus.columns;
		expect(corpus.rows.length).toBe(EXPECTED_RECORD_COUNT);
		// The dotted column name is the whole reason this spec exists: its presence in the
		// header is what used to make the recipe unrenderable.
		expect(corpus.columns).toContain(PROSE_COLUMN);
		expect(PROSE_COLUMN.includes('.')).toBe(true);
		const byId = new Map(corpus.rows.map((row) => [row['Profile Id'], row]));
		rows = WANTED.map((id) => byId.get(id)).filter((row): row is SheetRow => Boolean(row));
	});

	it('imports a small slice through the shipped recipe path', async () => {
		expect(rows.length).toBe(WANTED.length);
		// Every row in the slice carries prose at source, so a bodyless note downstream can
		// only be an engine fault. Length only; the text itself is never surfaced.
		expect(rows.filter((row) => (row[PROSE_COLUMN] ?? '').length > 0).length).toBe(WANTED.length);

		// Import-set discovery correctly refuses a half-indexed vault. Wait for the
		// startup cache pass before invoking the product path, rather than retrying
		// an import that may already have written notes.
		const readiness = await waitForVaultIndexed({ timeoutMs: 60_000 });
		expect(readiness.ready).toBe(true);

		const generation = await browser.executeObsidian(
			async ({ app }, args) => {
				// @ts-expect-error - Crosswalker E2E API
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImport(
					{
						columns: args.columns,
						rows: args.rows,
						rowCount: args.rows.length,
						source: { type: 'xlsx' },
						headerRow: args.headerRow,
					},
					{
						name: 'shape-workbench',
						mapping: {
							hierarchy: [], frontmatter: [], links: [], body: [],
							filename: { template: '{Profile Id|fs-safe}.md', sanitize: true },
						},
					},
					{
						basePath: args.destination,
						overwriteMode: 'replace',
						createFolders: true,
						strictValidation: true,
						sourceFileName: args.sourceFileName,
						recipeOverride: args.recipe,
					},
				);
			},
			{
				columns, rows, destination: DESTINATION, sourceFileName: SOURCE_FILE_NAME,
				recipe: criRecipe, headerRow: HEADER_ROW,
			},
		);

		// The literal-key regression showed up as a RenderError PER ROW, so the error count is
		// the primary signal. Only the count and an empty-array comparison are asserted, so a
		// failure message can print an engine message but never a CRI prose excerpt.
		expect(generation.errors.length).toBe(0);
		expect(generation.success).toBe(true);
		expect(generation.created.length).toBe(WANTED.length);

		await waitForFrontmatterIndexed({
			pathPrefixes: DESTINATION,
			requireKeys: ['profile_id', 'curie'],
			expectedCount: WANTED.length,
		});

		await resetTier2Sidecar();
	});

	it('captures a diagnostic-statement note — the one that used to render bodyless', async () => {
		// No revealLeaf() and no file-explorer:reveal-active-file. Both wedge the renderer
		// after a generated import, and a wedged renderer returns the PREVIOUS frame rather
		// than failing, which is how two captures came out byte-identical.
		await browser.executeObsidian(async ({ app }, target) => {
			const file = app.vault.getAbstractFileByPath(target);
			// @ts-expect-error - internal leaf API
			await app.workspace.getLeaf(true).openFile(file);
		}, `${DESTINATION}/GV.OC-01.01.md`);

		await browser.pause(1200);
		await browser.saveScreenshot(path.join(OUT_DIR, 'cri-recipe-diagnostic-statement.png'));

		const frontmatter = await readFrontmatterFromDisk(`${DESTINATION}/GV.OC-01.01.md`) as Record<string, any> | null;
		expect(frontmatter).toBeTruthy();
		expect(frontmatter!.profile_id).toBe('GV.OC-01.01');
		expect(frontmatter!.level).toBe('DS');
		expect(frontmatter!.sector).toBe('financial-services');
	});

	it('captures a subcategory note, which carries no tier facets', async () => {
		await browser.executeObsidian(async ({ app }, target) => {
			const file = app.vault.getAbstractFileByPath(target);
			// @ts-expect-error - internal leaf API
			await app.workspace.getLeaf(true).openFile(file);
		}, `${DESTINATION}/GV.OC-01.md`);

		await browser.pause(1200);
		await browser.saveScreenshot(path.join(OUT_DIR, 'cri-recipe-subcategory.png'));
	});

	it('proves the diagnostic-statement section exists and is non-empty on every note', async () => {
		// THE ACCEPTANCE CASE. Every accumulator below is a COUNT or a PATH; the source prose is
		// passed IN so containment can be checked and only booleans come back out.
		const proof = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const stripFrontmatter = (markdown: string): string => {
				const normalized = markdown.replace(/\r\n/g, '\n');
				if (!normalized.startsWith('---\n')) return normalized.trim();
				const closing = normalized.indexOf('\n---\n', 4);
				return closing < 0 ? normalized.trim() : normalized.slice(closing + 5).trim();
			};
			// Both sides are line-ending normalized, and that is a correctness requirement of the
			// comparison rather than a loosening of it: several diagnostic-statement cells carry an
			// embedded CRLF, the engine writes LF, and comparing a normalized body against an
			// un-normalized source flagged those rows as prose loss when nothing had been lost.
			const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			const missingFiles: string[] = [];
			const emptyBodies: string[] = [];
			const missingProseSection: string[] = [];
			const proseNotVerbatim: string[] = [];
			const sectionBodyEmpty: string[] = [];
			const headingNotFirstLine: string[] = [];
			const missingRegion: string[] = [];
			const headingNotThePath: string[] = [];
			const bodyCharacterCounts: number[] = [];

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
				const notePath = `${args.destination}/${row.id}.md`;
				const file = app.vault.getAbstractFileByPath(notePath);
				if (!file || !(file instanceof obsidian.TFile)) { missingFiles.push(notePath); continue; }
				const body = stripFrontmatter(await app.vault.read(file));
				if (body.length === 0) emptyBodies.push(notePath);
				const headingAt = body.indexOf(args.bodyHeading);
				if (headingAt < 0) { missingProseSection.push(notePath); }
				else if (body.slice(headingAt + args.bodyHeading.length).trim().length === 0) {
					// A heading with nothing under it is the exact shape of the old regression:
					// the section existed, the value did not.
					sectionBodyEmpty.push(notePath);
				}
				if (!normalizeEol(body).includes(normalizeEol(row.prose))) proseNotVerbatim.push(notePath);
				// auto_heading proof, by structure not content: line 1 is an H1 and its text equals
				// the source path column. Only the boolean result is retained.
				if (body.indexOf('<!-- crosswalker:body:start') === -1) missingRegion.push(notePath);
				const firstLine = regionOf(body).split('\n')[0];
				if (!firstLine.startsWith('# ')) headingNotFirstLine.push(notePath);
				if (firstLine.slice(2).trim() !== normalizeEol(row.pathText).trim()) headingNotThePath.push(notePath);
				bodyCharacterCounts.push(body.length);
			}

			// Tier facets: present on DS rows, absent on the rest. Key PRESENCE only.
			const dsMissingTier: string[] = [];
			const nonDsHasTier: string[] = [];
			for (const id of args.dsIds) {
				const file = app.vault.getAbstractFileByPath(`${args.destination}/${id}.md`);
				if (!file || !(file instanceof obsidian.TFile)) continue;
				const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				if (!Object.prototype.hasOwnProperty.call(frontmatter, 'tier_1')) dsMissingTier.push(id);
			}
			for (const id of args.nonDsIds) {
				const file = app.vault.getAbstractFileByPath(`${args.destination}/${id}.md`);
				if (!file || !(file instanceof obsidian.TFile)) continue;
				const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				if (Object.prototype.hasOwnProperty.call(frontmatter, 'tier_1')) nonDsHasTier.push(id);
			}

			return {
				missingFiles, emptyBodies, missingProseSection, proseNotVerbatim, sectionBodyEmpty,
				headingNotFirstLine, headingNotThePath, missingRegion, dsMissingTier, nonDsHasTier,
				bodyCharacterMin: bodyCharacterCounts.length ? Math.min(...bodyCharacterCounts) : 0,
			};
		}, {
			rows: rows.map((row) => ({
				id: row['Profile Id'],
				prose: (row[PROSE_COLUMN] ?? '').trim(),
				pathText: (row[PATH_COLUMN] ?? '').trim(),
			})),
			destination: DESTINATION,
			bodyHeading: BODY_HEADING,
			dsIds: DS_IDS,
			nonDsIds: NON_DS_IDS,
		});

		// Was 472 bodyless notes across the corpus; must now be zero here.
		expect(proof.missingFiles).toEqual([]);
		expect(proof.emptyBodies).toEqual([]);
		expect(proof.missingProseSection).toEqual([]);
		expect(proof.sectionBodyEmpty).toEqual([]);
		expect(proof.proseNotVerbatim).toEqual([]);
		// auto_heading: every note opens on an H1 whose text is the source path.
		expect(proof.headingNotFirstLine).toEqual([]);
		expect(proof.missingRegion).toEqual([]);
		expect(proof.headingNotThePath).toEqual([]);
		expect(proof.dsMissingTier).toEqual([]);
		expect(proof.nonDsHasTier).toEqual([]);
		expect(proof.bodyCharacterMin).toBeGreaterThan(0);
	});
});
