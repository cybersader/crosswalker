/**
 * kept-host-preservation.spec.ts — kept-host-runtime-proof
 * (.workspace/kept-host-runtime-proof-contract.md), real Obsidian.
 *
 * WHAT THIS PROVES AND WHY IT IS NOT REDUNDANT WITH THE UNIT SUITE.
 * tests/d1-pass23-am75-host-bytes.test.ts and tests/d1-pass23-c4-corrupt-region.test.ts
 * pin these same four behaviors against a vault DOUBLE (an in-memory Map standing
 * in for `app.vault`). That double is honest about what it models — reads, writes,
 * `getFileCache` — but it cannot show whether Obsidian's REAL vault adapter,
 * running inside real Electron, actually preserves a CRLF byte sequence across a
 * write it did not initiate, or whether `plugin.runImportFromRecipe` — the
 * production entry point the recipe/wizard path calls, not `generateFromRecipe`
 * directly — behaves identically once real file I/O and real indexing are in the
 * loop. This spec exercises exactly that seam: the production import entry
 * (`plugin.runImportFromRecipe`), inside a running Obsidian instance, against a
 * real WebdriverIO test-vault sandbox. It is engine-in-real-Obsidian evidence, NOT
 * a wizard click-through — no modal is opened here.
 *
 * FOUR RUNTIME DECLARATIONS (contract order):
 *   D1  CRLF host, all-skip refresh: host byte-identical, zero writes reach it
 *       (in fact zero writes reach the run's whole output surface — the same
 *       claim tests/d1-pass23-am75-host-bytes.test.ts pins with `modifyCalls`).
 *   D2  CRLF host, one row added: only the managed children lines and the
 *       permitted `produced_at` move; exact bytes elsewhere; no bare LF, no
 *       doubled CR ("CRCRLF"), and the multiline `notes: |` value survives a
 *       parse, not just a substring check.
 *   D3  Corrupt region (duplicated end marker), NO `children:` key: the
 *       scanner's own conflict is reported, the AM-76 "carries no managed
 *       Contents region" sentence is never spoken, and the host is not written.
 *   D4  Same corruption, WITH a `children:` key and a newer desired list: same
 *       refusal, and the key is not rebuilt either — no partial-key write.
 *
 * BYTES, NOT NORMALIZATION. Every before/after read below goes through
 * `app.vault.adapter.read`/`app.vault.adapter.write` — the lowest-level public
 * file API Obsidian exposes (see `tests/e2e/recipe-picker-flow.spec.ts` for
 * precedent) — never `app.vault.read`/`modify`, and never a string normalized on
 * both sides before comparison. D1 and D3/D4 assert the RAW string is identical
 * before and after; D2 asserts the raw string differs from the raw seed in
 * EXACTLY the two permitted ways and nowhere else, and separately asserts the
 * seed itself contained real `\r\n` bytes before the run touched it at all.
 *
 * WRITE INSTRUMENTATION. "Zero writes" is not inferred from byte equality alone
 * (a writer that reproduces its input byte-for-byte is not the same claim as a
 * writer that never called `modify`/`create`). Each refresh call temporarily
 * wraps `app.vault.modify`, `app.vault.create`, and `app.vault.adapter.write` to
 * record every path touched during the run, and restores the originals in a
 * `finally` block whether or not the run throws.
 *
 * NO READINESS GATE. There is deliberately no `metadataCache`/`getFileCache`
 * barrier anywhere in this file. `plugin.runImportFromRecipe(...)` is awaited,
 * and its resolution IS this import's completed fact; production itself reads
 * host content with `app.vault.read` (not `cachedRead`), so there is no cache
 * layer between a write and the next read for either the plugin or this spec to
 * lag behind. A metadata-cache barrier here would risk exactly the failure mode
 * the contract warns against — observing a PRIOR run's keys rather than this
 * one's — for no benefit, since nothing here reads the metadata cache.
 *
 * FIXTURES. Every host below is a hand-written string, synthetic and owned by
 * this repo (a fabricated MITRE-shaped id, `T1078`, used only as a plausible
 * leaf id — no corpus content). Only the `_crosswalker:` provenance block is
 * copied verbatim from a real note this spec's own first import generates,
 * because import-set ownership is what makes a note a "kept host" at all.
 *
 * Run: `DISPLAY=:0 bun run e2e -- --spec tests/e2e/kept-host-preservation.spec.ts`
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';

const BASE_D1 = 'Frameworks/Kept-Host-Preservation-D1';
const BASE_D2 = 'Frameworks/Kept-Host-Preservation-D2';
const BASE_D3 = 'Frameworks/Kept-Host-Preservation-D3';
const BASE_D4 = 'Frameworks/Kept-Host-Preservation-D4';

/** Same shape as the AM-75/C4 unit witnesses: a folder host (`T1078/`) beside a
 *  host note (`T1078.md`) that owns children via BOTH the `children:`
 *  properties key and the `## Contents` body region (`managed_links.parent`
 *  is what makes the host a children_lists parent as well as a folder host). */
function recipeFor(ontology: string) {
	return {
		recipe: `khp-${ontology}`,
		source: { ontology, levels: ['group', 'leaf'] },
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: '{parent_folder}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: { frontmatter: { managed_links: { parent: { template: '{parent_id}' } } } },
			enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

const ROWS1 = [
	{ id: 'T1078', parent_folder: '', parent_id: '' },
	{ id: 'T1078.001', parent_folder: 'T1078', parent_id: 'T1078' },
];
const ROWS2 = [...ROWS1, { id: 'T1078.002', parent_folder: 'T1078', parent_id: 'T1078' }];

function parsedOf(rows: Record<string, unknown>[]) {
	return { columns: ['id', 'parent_folder', 'parent_id'], rows, rowCount: rows.length };
}

/**
 * A host as a PERSON writes it: a bare ISO date (which `formatYamlValue` would
 * quote), an apostrophe (which it would quote), a YAML comment and a blank line
 * (which it would drop), and a `|` block scalar (which the AM-75 defect folded
 * to a quoted scalar with a raw newline inside it — a changed VALUE). Nothing
 * here is built through `buildNoteContent`.
 */
function handWrittenHost(provenance: string[], children: string[], eol: string, ontologyLabel: string): string {
	const lines = [
		'---',
		'created: 2024-01-05',
		"title: Don't Panic",
		'# the user left this comment here',
		'',
		'notes: |',
		'  first line',
		'  second line',
		`curie: "${ontologyLabel}:T1078"`,
		'children:',
		...children.map((c) => `  - "[[${c}]]"`),
		...provenance,
		'---',
		'',
		'User prose above the region.',
		'',
		'<!-- crosswalker:children:start v=1 -->',
		'## Contents',
		...children.map((c) => `- [[${c}]]`),
		'<!-- crosswalker:children:end -->',
		'',
		'User prose below.',
		'',
	];
	return lines.join(eol);
}

/**
 * The note the run is entitled to produce: the original bytes, the one new link
 * added to each managed part, and `produced_at` moved. Every other byte is the
 * user's and must survive — which is what comparing against THIS string, rather
 * than a re-serialisation, actually tests.
 */
function expectedAfterOneRowAdded(before: string, after: string, eol: string): string {
	const newProducedAt = after.split(eol).find((l) => l.trim().startsWith('produced_at:'));
	expect(typeof newProducedAt).toBe('string');
	const out: string[] = [];
	for (const line of before.split(eol)) {
		if (line.trim().startsWith('produced_at:')) { out.push(newProducedAt as string); continue; }
		out.push(line);
		if (line === '  - "[[T1078.001]]"') out.push('  - "[[T1078.002]]"');
		if (line === '- [[T1078.001]]') out.push('- [[T1078.002]]');
	}
	return out.join(eol);
}

/**
 * A kept host written by hand, corrupted with a DUPLICATED end marker — the
 * shape the correction contract (C4) names. `childrenKey` controls whether the
 * frontmatter `children:` key is present, which decides whether the frontmatter
 * branch would have had anything to rebuild at all.
 */
function corruptHost(provenance: string[], childrenKey: boolean, ontologyLabel: string): string {
	const lines = ['---', 'created: 2024-01-05', "title: Don't Panic", `curie: "${ontologyLabel}:T1078"`];
	if (childrenKey) lines.push('children:', '  - "[[T1078.001]]"');
	lines.push(...provenance, '---', '', 'User prose above.', '');
	lines.push(
		'<!-- crosswalker:children:start v=1 -->',
		'## Contents',
		'- [[T1078.001]]',
		'<!-- crosswalker:children:end -->',
		'<!-- crosswalker:children:end -->',
	);
	lines.push('', 'User prose below.', '');
	return lines.join('\n');
}

/** Every corruption verdict the scanner can reach. Nothing else is acceptable. */
const CORRUPTION_CODES = [
	'unclosed-region', 'orphan-end-marker', 'inverted-region', 'duplicate-region',
	'duplicate-end-marker', 'interleaved-regions', 'nested-region', 'malformed-marker',
	'future-region-version',
];

async function wipe(base: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, dir: string) => {
		if (app.vault.getAbstractFileByPath(dir)) {
			// @ts-expect-error — internal adapter API; safe in the sandboxed test vault
			await app.vault.adapter.rmdir(dir, true).catch(() => undefined);
		}
	}, base);
}

/**
 * Seeds a fresh kept host by running the REAL production import once, then
 * lifts the `_crosswalker:` provenance block from the generated HOST note
 * (verbatim, via the adapter — no `buildNoteContent`), and returns the owning
 * import set id. Both reads use `app.vault.adapter.read`, never `vault.read`.
 */
async function seedProvenance(base: string, ontology: string): Promise<{ setId: string; provenance: string[] }> {
	const host = `${base}/T1078.md`;
	const out = await browser.executeObsidian(async ({ app, obsidian }, args) => {
		// @ts-expect-error — internal API
		const plugin = app.plugins.plugins['crosswalker'];
		const first = await plugin.runImportFromRecipe(args.parsed, args.recipe, {
			basePath: args.base, overwriteMode: 'replace', createFolders: true,
			sourceFileName: `${args.ontology}.csv`, importSet: 'new',
		});
		// @ts-expect-error — internal adapter API
		const hostRaw: string = await app.vault.adapter.read(args.host);
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(hostRaw);
		const fm = match ? obsidian.parseYaml(match[1]) : null;
		const setId = (fm as any)?._crosswalker?.import_set?.id;

		const normalized = hostRaw.replace(/\r\n/g, '\n');
		const lines = normalized.split('\n');
		const start = lines.indexOf('_crosswalker:');
		const provenance = [lines[start]];
		for (let i = start + 1; i < lines.length; i++) {
			if (lines[i] === '---') break;
			provenance.push(lines[i]);
		}
		return { errors: first.errors ?? [], setId, provenance };
	}, { base, recipe: recipeFor(ontology), parsed: parsedOf(ROWS1), host, ontology });

	expect(out.errors).toEqual([]);
	expect(typeof out.setId).toBe('string');
	return { setId: out.setId, provenance: out.provenance };
}

interface RefreshOutcome {
	seededRaw: string;
	errors: unknown[];
	conflicts: Array<{ path: string; code: string; detail: string }>;
	warnings: Array<{ message: string }>;
	writes: string[];
	afterRaw: string;
	childrenAfter: unknown;
}

/**
 * Writes `hostText` verbatim onto the kept host via the adapter, instruments
 * every write reachable during the refresh (`modify`, `create`,
 * `adapter.write` — restored in `finally` regardless of outcome), runs the
 * REAL production refresh (`overwriteMode: 'skip'`, the owning import set),
 * and returns the raw before/after bytes plus every path written.
 */
async function seedAndRefresh(
	base: string,
	ontology: string,
	host: string,
	hostText: string,
	rows: Record<string, unknown>[],
	setId: string,
): Promise<RefreshOutcome> {
	return browser.executeObsidian(async ({ app, obsidian }, args) => {
		// @ts-expect-error — internal adapter API
		await app.vault.adapter.write(args.host, args.hostText);
		// @ts-expect-error — internal adapter API
		const seededRaw: string = await app.vault.adapter.read(args.host);

		// @ts-expect-error — internal API
		const plugin = app.plugins.plugins['crosswalker'];
		const writes: string[] = [];
		const origModify = app.vault.modify.bind(app.vault);
		const origCreate = app.vault.create.bind(app.vault);
		// @ts-expect-error — internal adapter API
		const origAdapterWrite = app.vault.adapter.write.bind(app.vault.adapter);
		let second: any;
		try {
			(app.vault as any).modify = async (file: any, ...rest: unknown[]) => {
				writes.push(file.path);
				return origModify(file, ...(rest as [string]));
			};
			(app.vault as any).create = async (path: any, ...rest: unknown[]) => {
				writes.push(path);
				return origCreate(path, ...(rest as [string]));
			};
			// @ts-expect-error — internal adapter API
			app.vault.adapter.write = async (path: any, ...rest: unknown[]) => {
				writes.push(path);
				return origAdapterWrite(path, ...rest);
			};
			second = await plugin.runImportFromRecipe(args.parsed, args.recipe, {
				basePath: args.base, overwriteMode: 'skip', createFolders: true,
				sourceFileName: `${args.ontology}-refresh.csv`, importSet: { id: args.setId },
			});
		} finally {
			(app.vault as any).modify = origModify;
			(app.vault as any).create = origCreate;
			// @ts-expect-error — internal adapter API
			app.vault.adapter.write = origAdapterWrite;
		}

		// @ts-expect-error — internal adapter API
		const afterRaw: string = await app.vault.adapter.read(args.host);
		const afterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(afterRaw);
		const afterFm = afterMatch ? (obsidian.parseYaml(afterMatch[1]) as any) : null;

		return {
			seededRaw,
			errors: second.errors ?? [],
			conflicts: second.conflicts ?? [],
			warnings: second.warnings ?? [],
			writes,
			afterRaw,
			childrenAfter: afterFm?.children ?? null,
		};
	}, {
		base, ontology, host, hostText,
		recipe: recipeFor(ontology), parsed: parsedOf(rows), setId,
	});
}

describe('Kept-host preservation — real production import entry, real Obsidian (AM-75 / C4)', function () {
	this.timeout(180_000);

	before(async () => {
		await Promise.all([wipe(BASE_D1), wipe(BASE_D2), wipe(BASE_D3), wipe(BASE_D4)]);
	});

	it('D1 — CRLF kept host, all-skip refresh: byte-identical host, zero writes anywhere in this run', async () => {
		const HOST = `${BASE_D1}/T1078.md`;
		const { setId, provenance } = await seedProvenance(BASE_D1, 'khp-d1');
		const host = handWrittenHost(provenance, ['T1078.001'], '\r\n', 'khp-d1');

		const result = await seedAndRefresh(BASE_D1, 'khp-d1', HOST, host, ROWS1, setId);

		// The seed is truly CRLF before the run ever sees it: every newline is a
		// CRLF pair, no bare LF anywhere, and the adapter round-trips it exactly.
		expect(result.seededRaw).toBe(host);
		expect(result.seededRaw.replace(/\r\n/g, '')).not.toContain('\n');

		expect(result.errors).toEqual([]);
		// Not "no write reached the host" alone — no write reached ANYTHING this
		// run could have touched, matching the unit witness's `modifyCalls`/
		// `createCalls` both-empty assertion for the same all-skip shape.
		expect(result.writes).toEqual([]);
		expect(result.afterRaw).toBe(host);
	});

	it('D2 — CRLF kept host, one row added: only managed lines + produced_at move; no bare LF, no doubled CR, multiline intact', async () => {
		const HOST = `${BASE_D2}/T1078.md`;
		const { setId, provenance } = await seedProvenance(BASE_D2, 'khp-d2');
		const host = handWrittenHost(provenance, ['T1078.001'], '\r\n', 'khp-d2');

		const result = await seedAndRefresh(BASE_D2, 'khp-d2', HOST, host, ROWS2, setId);

		expect(result.seededRaw).toBe(host);
		expect(result.seededRaw.replace(/\r\n/g, '')).not.toContain('\n');

		expect(result.errors).toEqual([]);
		expect(result.writes).toContain(HOST);

		const after = result.afterRaw;
		// No bare LF once every CRLF pair is stripped, and no doubled CR either
		// ("CRCRLF") — the note stayed CRLF end to end.
		expect(after.replace(/\r\n/g, '')).not.toContain('\n');
		expect(after).not.toContain('\r\r');
		expect(after).toBe(expectedAfterOneRowAdded(host, after, '\r\n'));

		// The user's own properties, one at a time, so a failure names which.
		expect(after).toContain('created: 2024-01-05');
		expect(after).not.toContain('created: "2024-01-05"');
		expect(after).toContain("title: Don't Panic");
		expect(after).toContain('# the user left this comment here');
		expect(after).toContain('notes: |\r\n  first line\r\n  second line');
	});

	it('D3 — corrupt region, NO children key: the parser\'s own verdict is reported and the host is not written', async () => {
		const HOST = `${BASE_D3}/T1078.md`;
		const { setId, provenance } = await seedProvenance(BASE_D3, 'khp-d3');
		const host = corruptHost(provenance, false, 'khp-d3');

		const result = await seedAndRefresh(BASE_D3, 'khp-d3', HOST, host, ROWS2, setId);

		expect(result.seededRaw).toBe(host);
		expect(result.errors).toEqual([]);

		const hostConflicts = result.conflicts.filter((c) => c.path === HOST);
		expect(hostConflicts).toHaveLength(1);
		expect(CORRUPTION_CODES).toContain(hostConflicts[0].code);
		expect(hostConflicts[0].code).toBe('duplicate-end-marker');
		expect(hostConflicts[0].detail.length).toBeGreaterThan(20);

		// AM-76's "carries no managed Contents region" claim must never be spoken
		// about a note the scanner could not read — that is the C4 defect itself.
		const missingRegionVoices = result.warnings.map((w) => w.message).filter((m) => m.includes('no managed Contents region'));
		expect(missingRegionVoices).toEqual([]);

		expect(result.writes).not.toContain(HOST);
		expect(result.afterRaw).toBe(host);
	});

	it('D4 — corrupt region, WITH children key and a newer desired list: same refusal, no partial children-key write', async () => {
		const HOST = `${BASE_D4}/T1078.md`;
		const { setId, provenance } = await seedProvenance(BASE_D4, 'khp-d4');
		const host = corruptHost(provenance, true, 'khp-d4');

		// ROWS2 gives this run a newer desired children list (T1078.001 AND
		// T1078.002) than the stale `children:` key the host already carries.
		const result = await seedAndRefresh(BASE_D4, 'khp-d4', HOST, host, ROWS2, setId);

		expect(result.seededRaw).toBe(host);
		expect(result.errors).toEqual([]);

		const hostConflicts = result.conflicts.filter((c) => c.path === HOST);
		expect(hostConflicts).toHaveLength(1);
		expect(CORRUPTION_CODES).toContain(hostConflicts[0].code);
		expect(hostConflicts[0].code).toBe('duplicate-end-marker');

		const missingRegionVoices = result.warnings.map((w) => w.message).filter((m) => m.includes('no managed Contents region'));
		expect(missingRegionVoices).toEqual([]);

		expect(result.writes).not.toContain(HOST);
		expect(result.afterRaw).toBe(host);
		// The stale key had only T1078.001 in hand; the run had T1078.002 to add
		// and did not — not even that half of the pair moved.
		expect(result.childrenAfter).toEqual(['[[T1078.001]]']);
	});
});
