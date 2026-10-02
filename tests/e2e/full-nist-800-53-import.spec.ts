/**
 * full-nist-800-53-import.spec.ts — opt-in full-corpus import scale proof
 *
 * This spec is intentionally excluded from normal E2E cost by an environment
 * gate. It parses and imports the tracked 1 MB NIST SP 800-53 Rev. 5 catalog,
 * writes 1,189 real notes through the same bundled-recipe path used by the
 * recognized-source wizard, projects them into Tier 2, times representative
 * queries, and captures visual evidence.
 *
 * Run only when explicitly requested:
 *   CW_SCALE=1 DISPLAY=:0 bun run e2e -- --spec tests/e2e/full-nist-800-53-import.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import {
	readFrontmatterFromDisk,
	requireFrontmatterIndexed,
	resetTier2Sidecar,
} from './helpers/vault-readiness';

const RUN_SCALE = process.env.CW_SCALE === '1';
const describeScale = RUN_SCALE ? describe : describe.skip;

const CORPUS_PATH = path.resolve(__dirname, '..', '..', 'Frameworks', 'NIST_SP-800-53_rev5_catalog_load.csv');
const RECIPE_PATH = path.resolve(__dirname, '..', '..', 'recipes', 'import', 'nist-800-53-flat.json');
const SOURCE_FILE_NAME = 'NIST_SP-800-53_rev5_catalog_load.csv';
const DESTINATION = 'Frameworks/full-nist-800-53-scale';
const EXPECTED_RECORD_COUNT = 1189;
const ONTOLOGY = 'nist-800-53';
const CURIE_PATTERN = /^[a-z][a-z0-9_-]*:[A-Za-z0-9._\-()/]+$/;
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'test-screenshots');

interface CorpusRow {
	identifier: string;
	name: string;
	control_text: string;
	discussion: string;
	related: string;
	[key: string]: string;
}

function loadCorpus(): { columns: string[]; rows: CorpusRow[] } {
	const parsed = Papa.parse<CorpusRow>(readFileSync(CORPUS_PATH, 'utf8'), {
		header: true,
		skipEmptyLines: true,
		dynamicTyping: false,
		transformHeader: (header) => header.trim(),
	});
	if (parsed.errors.length > 0) {
		throw new Error(`Full NIST CSV parse errors: ${parsed.errors.map((error) => `${error.code}: ${error.message}`).join('; ')}`);
	}
	return { columns: parsed.meta.fields ?? Object.keys(parsed.data[0] ?? {}), rows: parsed.data };
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

describeScale('Crosswalker plugin — full NIST SP 800-53 Rev. 5 import scale proof', function () {
	this.timeout(10 * 60_000);

	it('imports, indexes, and proves bodies, headings and related links across all 1,189 records', async () => {
		const specStarted = Date.now();
		mkdirSync(SCREENSHOT_DIR, { recursive: true });

		const corpus = loadCorpus();
		const recipe = JSON.parse(readFileSync(RECIPE_PATH, 'utf8'));
		expect(corpus.rows.length).toBe(EXPECTED_RECORD_COUNT);
		expect(new Set(corpus.rows.map((row) => row.identifier)).size).toBe(EXPECTED_RECORD_COUNT);
		expect(recipe.recipe).toBe('nist-800-53-r5-flat');
		expect(recipe.source.ontology).toBe(ONTOLOGY);
		metric('parsed_record_count', corpus.rows.length);

		// The E2E seed contains nine managed mini-framework notes. Remove the seed's
		// Frameworks root in this isolated sandbox so the full Tier 2 projection can
		// make an exact generated-count assertion rather than a >= assertion.
		const cleanup = await browser.executeObsidian(async ({ app }, destinationRoot) => {
			const root = app.vault.getAbstractFileByPath(destinationRoot);
			if (root) {
				// @ts-expect-error - internal trash API, isolated E2E vault only
				await app.vault.trash(root, false);
			}
			const deadline = Date.now() + 20_000;
			while (app.vault.getAbstractFileByPath(destinationRoot) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return !app.vault.getAbstractFileByPath(destinationRoot);
		}, 'Frameworks');
		expect(cleanup).toBe(true);

		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);
		expect(reset.counts.concepts).toBe(0);
		expect(reset.counts.mappings).toBe(0);

		// This mirrors ImportWizard.buildWorkbenchConfig() + recipeOverride: the
		// recognized-source wizard uses generateNotes(), with the complete bundled
		// recipe controlling paths/frontmatter and its leaf template controlling the
		// stable CURIE stem. Calling runImport exercises that shipped path directly.
		const config = {
			name: 'shape-workbench',
			mapping: {
				hierarchy: [],
				frontmatter: [],
				links: [],
				body: [],
				filename: { template: '{identifier|fs-safe}.md', sanitize: true },
			},
		};
		const parsedData = {
			columns: corpus.columns,
			rows: corpus.rows,
			rowCount: corpus.rows.length,
			source: { type: 'csv' as const },
			headerRow: 0,
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

		expect(generation.success).toBe(true);
		expect(generation.errors).toEqual([]);
		expect(generation.created.length).toBe(EXPECTED_RECORD_COUNT);
		expect(generation.skipped).toEqual([]);
		metric('generated_note_count', generation.created.length);
		metric('generation_engine_duration_ms', generation.duration);

		const indexed = await requireFrontmatterIndexed({
			pathPrefixes: DESTINATION,
			expectedCount: EXPECTED_RECORD_COUNT,
			requireKeys: ['curie', '_crosswalker'],
			timeoutMs: 120_000,
			pollMs: 100,
		});
		metric('metadata_index_settle_ms', indexed.waitedMs);
		expect(indexed.total).toBe(EXPECTED_RECORD_COUNT);

		const samplePaths = [
			`${DESTINATION}/AC-1.md`,
			`${DESTINATION}/AC-2(1).md`,
			`${DESTINATION}/SR-11(3).md`,
		];
		for (const notePath of samplePaths) {
			const frontmatter = await readFrontmatterFromDisk(notePath) as Record<string, any> | null;
			expect(frontmatter).toBeTruthy();
			expect(frontmatter!._crosswalker).toBeTruthy();
			expect(typeof frontmatter!.curie).toBe('string');
			expect(frontmatter!.curie).toMatch(CURIE_PATTERN);
			expect(frontmatter!._crosswalker.recipe.id).toBe('nist-800-53-r5-flat');
			expect(frontmatter!._crosswalker.source_ref.file).toBe(SOURCE_FILE_NAME);
		}
		const enhancement = await readFrontmatterFromDisk(`${DESTINATION}/AC-2(1).md`) as Record<string, any> | null;
		expect(enhancement!.curie).toBe('nist-800-53:AC-2(1)');
		expect(enhancement!.control_id).toBe('AC-2(1)');
		expect(enhancement!.title).toBe('Account Management | Automated System Account Management');

		const bodyProof = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const stripFrontmatter = (markdown: string): string => {
				const normalized = markdown.replace(/\r\n/g, '\n');
				if (!normalized.startsWith('---\n')) return normalized.trim();
				const closing = normalized.indexOf('\n---\n', 4);
				return closing < 0 ? normalized.trim() : normalized.slice(closing + 5).trim();
			};
			const missingFiles: string[] = [];
			const emptyBodies: string[] = [];
			const missingControlText: string[] = [];
			const missingSections: string[] = [];
			const wordCounts: number[] = [];
			const characterCounts: number[] = [];
			let enhancementBody = '';
			// `related` proof (2026-08-26). Three failure modes the per-item chain
			// exists to prevent, counted across all 1,189 notes rather than sampled:
			// a dangling `[[SC-37.]]` (terminal period kept), a literal `[[[None]]]`
			// (sentinel not rejected), and a "## Related controls" heading on a
			// control that has no relations (empty region not omitted).
			const relatedLinkArtifacts: string[] = [];
			const relatedSentinels: string[] = [];
			const emptyRelatedSections: string[] = [];
			let relatedLinkTotal = 0;

			for (const row of args.rows) {
				const notePath = `${args.destination}/${row.identifier}.md`;
				const file = app.vault.getAbstractFileByPath(notePath);
				if (!file || !(file instanceof obsidian.TFile)) {
					missingFiles.push(notePath);
					continue;
				}
				const body = stripFrontmatter(await app.vault.read(file));
				if (body.length === 0) emptyBodies.push(notePath);
				if (!body.includes(row.control_text.trim())) missingControlText.push(notePath);
				if (!body.includes('## Control') || (row.discussion.trim() !== '' && !body.includes('## Discussion'))) missingSections.push(notePath);
				wordCounts.push(body.match(/\S+/g)?.length ?? 0);
				characterCounts.push(body.length);

				const links = body.match(/\[\[[^\]]*\]\]/g) ?? [];
				relatedLinkTotal += links.length;
				for (const link of links) {
					const target = link.slice(2, -2);
					if (target.trim() === '' || /[.\s]$/.test(target)) relatedLinkArtifacts.push(`${notePath}: ${link}`);
					if (target.includes('None')) relatedSentinels.push(`${notePath}: ${link}`);
				}
				const hasRelated = body.includes('## Related controls');
				const expectsRelated = row.related
					.split(',')
					.map((piece) => piece.trim().replace(/[.\s]+$/, ''))
					.some((piece) => piece !== '' && piece !== '[None]');
				if (hasRelated !== expectsRelated) emptyRelatedSections.push(notePath);

				if (row.identifier === 'AC-2(1)') enhancementBody = body;
			}

			const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
			return {
				missingFiles,
				emptyBodies,
				missingControlText,
				missingSections,
				relatedLinkArtifacts,
				relatedSentinels,
				emptyRelatedSections,
				relatedLinkTotal,
				enhancementBody,
				wordCountTotal: sum(wordCounts),
				wordCountAverage: sum(wordCounts) / wordCounts.length,
				wordCountMin: Math.min(...wordCounts),
				wordCountMax: Math.max(...wordCounts),
				characterCountTotal: sum(characterCounts),
				characterCountAverage: sum(characterCounts) / characterCounts.length,
				characterCountMin: Math.min(...characterCounts),
				characterCountMax: Math.max(...characterCounts),
			};
		}, { rows: corpus.rows, destination: DESTINATION });
		expect(bodyProof.missingFiles).toEqual([]);
		expect(bodyProof.emptyBodies).toEqual([]);
		expect(bodyProof.missingControlText).toEqual([]);
		expect(bodyProof.missingSections).toEqual([]);
		const enhancementSource = corpus.rows.find((row) => row.identifier === 'AC-2(1)')!;
		// The note's first line is now recipe-owned. `target.auto_heading` (schema
		// SchemaVer 1.8.0) is set to `{name}` in recipes/import/nist-800-53-flat.json,
		// so the note opens on the descriptive control name instead of restating the
		// identifier its own filename already carries -- the redundancy this asserted
		// before. This assertion is deliberately changed alongside that recipe edit:
		// the previous `startsWith('# AC-2(1)')` was correct only while the engine,
		// not the recipe, owned the heading.
		//
		// The expected heading is derived from the corpus row rather than hardcoded,
		// and the second assertion states the actual point: whatever the heading is,
		// it is not the identifier again.
		//
		// Since the 2026-08-27 managed body regions slice the body opens with the
		// region boundary, so the heading is line 1 INSIDE the region rather than
		// line 1 of the file body. Both lines are pinned: the boundary must be
		// present, and the note must still open on the descriptive control name.
		const enhancementHeading = `# ${enhancementSource.name.trim()}`;
		const enhancementLines = bodyProof.enhancementBody.split('\n');
		expect(enhancementLines[0]).toBe('<!-- crosswalker:body:start v=1 -->');
		expect(enhancementLines[1]).toBe(enhancementHeading);
		expect(bodyProof.enhancementBody.trimEnd().endsWith('<!-- crosswalker:body:end -->')).toBe(true);
		expect(enhancementHeading).not.toContain('AC-2(1)');
		expect(bodyProof.enhancementBody).toContain('## Control');
		expect(bodyProof.enhancementBody).toContain(enhancementSource.control_text.trim());
		expect(bodyProof.enhancementBody).toContain(enhancementSource.discussion.trim());

		// `related` is emitted from one chain into two sinks: the `related_curies`
		// CURIE array (queryable) and the "## Related controls" body links (clickable).
		// Both were blocked until the engine could transform each item of a list.
		expect(bodyProof.relatedLinkArtifacts).toEqual([]);
		expect(bodyProof.relatedSentinels).toEqual([]);
		expect(bodyProof.emptyRelatedSections).toEqual([]);
		// NIST prose carries no `[[` of its own (verified across all 1,189 rows), so
		// every wikilink in the corpus is one this chain emitted.
		expect(bodyProof.relatedLinkTotal).toBe(3397);
		metric('related_body_links_total', bodyProof.relatedLinkTotal);

		// Negative control. AC-2(1)'s `related` cell is the literal `[None]` sentinel
		// that 541 of the 1,189 rows carry. `reject` empties it, the empty-list rule
		// omits the property, and omit_if_empty omits the section — so this note gets
		// neither, rather than the `[[[None]]]` that made this column unemittable.
		expect(enhancementSource.related.trim()).toBe('[None]');
		expect(bodyProof.enhancementBody).not.toContain('## Related controls');
		expect(enhancement!.related_curies).toBeUndefined();

		// Positive control. AC-1's cell ends in a terminal period, which 646 rows do;
		// `trim(.)` strips it, so the last link is `[[SI-12]]` and not `[[SI-12.]]`.
		const policySource = corpus.rows.find((row) => row.identifier === 'AC-1')!;
		const policyRelated = policySource.related
			.split(',')
			.map((piece) => piece.trim().replace(/[.\s]+$/, ''))
			.filter((piece) => piece !== '' && piece !== '[None]');
		expect(policySource.related.trim().endsWith('.')).toBe(true);
		expect(policyRelated.length).toBeGreaterThan(1);
		const policyBody = await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!file || !(file instanceof obsidian.TFile)) return '';
			return await app.vault.read(file);
		}, `${DESTINATION}/AC-1.md`);
		expect(policyBody).toContain('## Related controls');
		for (const relatedId of policyRelated) {
			expect(policyBody).toContain(`- [[${relatedId}]]`);
		}
		const policyFm = await readFrontmatterFromDisk(`${DESTINATION}/AC-1.md`) as Record<string, any> | null;
		expect(policyFm!.related_curies).toEqual(
			policyRelated.map((relatedId) => `${ONTOLOGY}:${relatedId}`),
		);
		metric('body_word_count_total', bodyProof.wordCountTotal);
		metric('body_words_per_note_average', bodyProof.wordCountAverage.toFixed(2));
		metric('body_words_per_note_min', bodyProof.wordCountMin);
		metric('body_words_per_note_max', bodyProof.wordCountMax);
		metric('body_character_count_total', bodyProof.characterCountTotal);
		metric('body_characters_per_note_average', bodyProof.characterCountAverage.toFixed(2));
		metric('body_characters_per_note_min', bodyProof.characterCountMin);
		metric('body_characters_per_note_max', bodyProof.characterCountMax);


		metric('total_spec_ms', Date.now() - specStarted);
	});

	/**
 	 * Force the reading-view preview to render its whole document.
 	 *
 	 * Obsidian renders preview sections lazily, driven by an IntersectionObserver.
 	 * Measured on 2026-08-27: after the 1,189-note import the Obsidian renderer
 	 * stops producing frames -- `browser.execute` still returns, but every
 	 * `saveScreenshot` times out and `.markdown-preview-view` stays EMPTY
 	 * (previewCount=1, zero h1, zero h2). With no frames there are no
 	 * intersection callbacks, so the lazy renderer never fires. `rerender(true)`
 	 * asks Obsidian to rebuild the document synchronously instead of waiting for
 	 * visibility, which makes the DOM assertions below meaningful even while the
 	 * compositor is stalled. It does NOT fix screenshot capture, which needs a
 	 * real frame; the captures are soft for exactly that reason.
 	 */
	async function forcePreviewRender(): Promise<void> {
		try {
			await browser.executeObsidian(async ({ app }) => {
				const view = app.workspace.getActiveViewOfType(
					// @ts-expect-error - MarkdownView is on the obsidian module at runtime
					(window as any).require('obsidian').MarkdownView,
				);
				// @ts-expect-error - previewMode is undocumented internal API
				const preview = view?.previewMode;
				if (preview?.rerender) preview.rerender(true);
				for (const element of document.querySelectorAll<HTMLElement>('.markdown-preview-section')) {
					element.style.contentVisibility = 'visible';
				}
			});
		} catch {
			// Diagnostic nudge only -- never fail the proof on it.
		}
	}

	// Visual capture is a SEPARATE test on purpose, matching the staging the CSF
	// 2.0 and MITRE scale proofs already use: a chromedriver renderer stall while
	// capturing must not invalidate the 1,189-note corpus proof above.
	//
	// Readiness is a `browser.pause` plus a bounded poll, NOT a `waitUntil` gated
	// on `[data-property-key="control_id"]`. That gate was the pre-existing reason
	// this capture never produced evidence: whether the properties panel renders
	// in READING view is an Obsidian display setting, not a fact about the
	// generated note, so the condition could never become true regardless of what
	// the import produced. Properties-panel presence is now recorded as a metric
	// instead of gating the capture. The MITRE spec, which captures successfully,
	// already uses the pause approach.
	//
	// The CONTENT assertions below stay hard -- the rendered H1 must be the
	// descriptive control name, and every "Related controls" item must be a
	// RESOLVED internal link. Only the readiness mechanism changed.
	it('captures the recipe-owned heading and the resolved related links', async () => {
		const corpus = loadCorpus();
		const enhancementSource = corpus.rows.find((row) => row.identifier === 'AC-2(1)')!;
		const policySource = corpus.rows.find((row) => row.identifier === 'AC-1')!;
		const policyRelated = policySource.related
			.split(',')
			.map((piece) => piece.trim().replace(/[.\s]+$/, ''))
			.filter((piece) => piece !== '' && piece !== '[None]');

		const shot = async (stage: string, name: string): Promise<void> => {
			try {
				await browser.saveScreenshot(path.join(SCREENSHOT_DIR, name));
				metric(`capture_${stage}`, 'ok');
			} catch (error) {
				metric(`capture_${stage}`, `FAILED:${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`);
			}
		};

		// Stage 0 -- liveness probe. A bare screenshot with no prior `execute`
		// distinguishes "the renderer is wedged" from "the readiness condition was
		// unsatisfiable", which the 2026-08-26 runs could not tell apart.
		await browser.pause(2000);
		await shot('0_liveness', 'nist-stage-0-liveness.png');

		// Stage A -- AC-2(1): proves the recipe-owned H1. `target.auto_heading` is
		// `{name}`, so line 1 must be the descriptive control name, NOT the
		// identifier the filename already carries.
		await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!file || !(file instanceof obsidian.TFile)) throw new Error(`missing note ${notePath}`);
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'preview' }, active: true });
		}, `${DESTINATION}/AC-2(1).md`);
		await forcePreviewRender();
		await browser.pause(3000);

		const headingRender = await browser.execute(() => {
			const previews = [...document.querySelectorAll<HTMLElement>('.markdown-preview-view')];
			const h1s: string[] = [];
			for (const preview of previews) {
				preview.scrollTop = 0;
				for (const heading of preview.querySelectorAll<HTMLElement>('h1')) h1s.push(heading.innerText.trim());
			}
			return {
				previewCount: previews.length,
				h1Texts: h1s,
				hasControlIdProperty: document.querySelector('[data-property-key="control_id"]') !== null,
				h2Texts: previews.flatMap((preview) =>
					[...preview.querySelectorAll<HTMLElement>('h2')].map((heading) => heading.innerText.trim())),
			};
		});
		metric('ac_2_1_preview_count', headingRender.previewCount);
		metric('ac_2_1_properties_panel_in_reading_view', String(headingRender.hasControlIdProperty));
		metric('ac_2_1_rendered_h2_sections', JSON.stringify(headingRender.h2Texts));
		// HARD assertion: the RENDERED first heading is the descriptive control name
		// and is not a restatement of the identifier the filename already carries.
		expect(headingRender.h1Texts).toContain(enhancementSource.name.trim());
		expect(enhancementSource.name.trim()).not.toContain('AC-2(1)');
		// The body sections must still be the ones the recipe authored.
		expect(headingRender.h2Texts).toContain('Control');
		expect(headingRender.h2Texts).toContain('Discussion');
		// AC-2(1) is the `[None]` negative control: no related section at all.
		expect(headingRender.h2Texts).not.toContain('Related controls');
		await shot('a_heading', 'nist-body-ac-2-1.png');

		// Stage B -- AC-1: proves the `related` chain renders as RESOLVED internal
		// links. Obsidian marks a link that points nowhere `is-unresolved`, so a
		// link that renders but targets no note fails here.
		await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!file || !(file instanceof obsidian.TFile)) throw new Error(`missing note ${notePath}`);
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'preview' }, active: true });
		}, `${DESTINATION}/AC-1.md`);
		await forcePreviewRender();
		await browser.pause(3000);

		// Diagnostic BEFORE the assertion, so a failure says which of the two things
		// happened: the renderer produced nothing at all (the documented post-import
		// stall, in which case every count below is 0), or it produced the document
		// but not this section (which would be a real content regression).
		const previewState = await browser.execute(() => {
			const previews = [...document.querySelectorAll<HTMLElement>('.markdown-preview-view')];
			const h1 = previews.flatMap((p) => [...p.querySelectorAll<HTMLElement>('h1')]);
			const h2 = previews.flatMap((p) => [...p.querySelectorAll<HTMLElement>('h2')]);
			return {
				previewCount: previews.length,
				h1Count: h1.length,
				h2Count: h2.length,
				h2Texts: h2.map((h) => h.innerText.trim()),
				textLength: previews.reduce((n, p) => n + p.innerText.length, 0),
				commentLeak: previews.some((p) => p.innerText.includes('crosswalker:body:')),
			};
		});
		metric('ac_1_preview_count', previewState.previewCount);
		metric('ac_1_preview_h1_count', previewState.h1Count);
		metric('ac_1_preview_h2_count', previewState.h2Count);
		metric('ac_1_preview_h2_texts', JSON.stringify(previewState.h2Texts));
		metric('ac_1_preview_text_length', previewState.textLength);
		metric('ac_1_preview_marker_leaked_as_text', String(previewState.commentLeak));
		const relatedShape = await browser.execute(() => {
			const previews = [...document.querySelectorAll<HTMLElement>('.markdown-preview-view')];
			for (const preview of previews) {
				const h2 = [...preview.querySelectorAll<HTMLElement>('h2')]
					.find((h) => h.innerText.trim() === 'Related controls');
				if (!h2) continue;
				const sibs: string[] = [];
				let n: Element | null = h2.nextElementSibling;
				for (let i = 0; i < 6 && n; i += 1) { sibs.push(n.tagName); n = n.nextElementSibling; }
				const parent = h2.parentElement;
				const parentSibs: string[] = [];
				let m: Element | null = parent?.nextElementSibling ?? null;
				for (let i = 0; i < 4 && m; i += 1) { parentSibs.push(`${m.tagName}.${m.className}`); m = m.nextElementSibling; }
				return {
					parent: `${parent?.tagName}.${parent?.className}`,
					siblings: sibs,
					parentSiblings: parentSibs,
					ulTotal: preview.querySelectorAll('ul').length,
					internalLinkTotal: preview.querySelectorAll('a.internal-link').length,
				};
			}
			return null;
		});
		metric('ac_1_related_h2_shape', JSON.stringify(relatedShape));
		// Whatever else happens, the region markers must never render as visible text.
		expect(previewState.commentLeak).toBe(false);

		// Deterministic proof (2026-10-02). The live reading view virtualizes a
		// long document and can omit its tail, so the old walk over the live
		// preview DOM was nondeterministic at corpus scale. Instead: take the
		// note's `## Related controls` section from the file, render exactly that
		// section with Obsidian's own MarkdownRenderer into a detached element,
		// and check each rendered internal link against the metadata cache's
		// link resolution. No lazily rendered tail is involved.
		const relatedRender = await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const empty = { found: false, internalLinks: 0, unresolved: 0, listItems: 0, linkTexts: [] as string[], cacheUnresolved: -1 };
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!file || !(file instanceof obsidian.TFile)) return empty;
			const text = await app.vault.read(file);
			const at = text.indexOf('## Related controls');
			if (at === -1) return empty;
			const rest = text.slice(at);
			const nextHeading = rest.slice(1).search(/\n#{1,2} |\n<!-- crosswalker:body:end/);
			const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
			const host = document.createElement('div');
			const component = new obsidian.Component();
			component.load();
			try {
				await obsidian.MarkdownRenderer.render(app, section, host, notePath, component);
				const list = host.querySelector('ul');
				if (!list) return empty;
				const anchors = [...list.querySelectorAll<HTMLElement>('a.internal-link')];
				const unresolved = anchors.filter((anchor) => {
					const target = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
					return !app.metadataCache.getFirstLinkpathDest(target.split('#')[0], notePath);
				}).length;
				const cacheUnresolved = Object.keys(app.metadataCache.unresolvedLinks[notePath] ?? {}).length;
				return {
					found: true,
					internalLinks: anchors.length,
					unresolved,
					listItems: list.querySelectorAll('li').length,
					linkTexts: anchors.map((anchor) => (anchor.textContent ?? '').trim()),
					cacheUnresolved,
				};
			} finally {
				component.unload();
			}
		}, `${DESTINATION}/AC-1.md`);
		metric('ac_1_related_cache_unresolved', relatedRender.cacheUnresolved);
		// Best effort, for the capture only: bring the section into view if the
		// live preview rendered it.
		await browser.execute(() => {
			const heading = [...document.querySelectorAll<HTMLElement>('.markdown-preview-view h2')]
				.find((h) => h.innerText.trim() === 'Related controls');
			heading?.scrollIntoView({ block: 'start' });
		});
		metric('ac_1_related_section_rendered', String(relatedRender.found));
		metric('ac_1_related_internal_links_rendered', relatedRender.internalLinks);
		metric('ac_1_related_unresolved_links', relatedRender.unresolved);
		expect(policyRelated.length).toBeGreaterThan(1);
		expect(relatedRender.found).toBe(true);
		expect(relatedRender.listItems).toBe(policyRelated.length);
		// Every item is an internal link, and none of them is unresolved. A link
		// that renders but points nowhere is the failure this proof exists to catch.
		expect(relatedRender.internalLinks).toBe(policyRelated.length);
		expect(relatedRender.unresolved).toBe(0);
		expect(relatedRender.cacheUnresolved).toBe(0);
		expect(relatedRender.linkTexts).toEqual(policyRelated);
		await shot('b_related_links', 'nist-body-ac-1-related-links.png');

		// Stage C -- framework tree. LAST and SOFT: expanding the explorer over
		// ~1,189 generated nav items is a known renderer-stall risk, and this
		// capture is context, not proof. revealLeaf() and
		// file-explorer:reveal-active-file are deliberately NOT called.
		try {
			await browser.executeObsidian(async ({ app }) => {
				// @ts-expect-error - internal split API
				app.workspace.leftSplit.expand();
			});
			await browser.pause(3000);
			metric('file_explorer_expand', 'ok');
		} catch (error) {
			metric('file_explorer_expand', `FAILED:${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`);
		}
		await shot('c_framework_tree', 'full-nist-framework-tree.png');
	});

	// Tier 2 projection runs LAST, after the visual capture, and that ordering is
	// load-bearing rather than cosmetic. Measured on 2026-08-27: projecting 1,189
	// concepts (~18.6 s of sqlite-wasm work inside the Obsidian renderer process)
	// leaves the renderer unable to service any further WebDriver command --
	// `Timed out receiving message from renderer` on every subsequent screenshot
	// and `browser.execute`, for minutes, with no recovery. That is what cost the
	// captures on 2026-08-26 and was misattributed to revealLeaf(), which had
	// already been removed. Nothing about this projection depends on the captures,
	// and nothing about the captures depends on the projection, so running the
	// visual stage first costs nothing and preserves the evidence. Every
	// assertion below is unchanged from when it lived in the first test.
	it('projects into Tier 2 and serves concept queries', async () => {
		const projection = await timed('tier2_projection_wall_ms', () => browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - Crosswalker E2E API
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runProjection();
		}));
		expect(projection.success).toBe(true);
		expect(projection.errors).toEqual([]);
		expect(projection.counts.concepts).toBe(EXPECTED_RECORD_COUNT);
		expect(projection.counts.mappings).toBe(0);
		metric('projected_concept_count', projection.counts.concepts);

		const conceptsCold = await timed('query_concepts_cold_ms', () => browser.executeObsidian(async ({ app }, ontology) => {
			// @ts-expect-error - Crosswalker E2E API
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryConcepts(ontology);
		}, ONTOLOGY));
		expect(conceptsCold.length).toBe(EXPECTED_RECORD_COUNT);
		expect(conceptsCold.some((concept: any) => concept.curie === 'nist-800-53:AC-2(1)')).toBe(true);

		const conceptsWarm = await timed('query_concepts_warm_ms', () => browser.executeObsidian(async ({ app }, ontology) => {
			// @ts-expect-error - Crosswalker E2E API
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.queryConcepts(ontology);
		}, ONTOLOGY));
		expect(conceptsWarm.length).toBe(EXPECTED_RECORD_COUNT);
	});
});