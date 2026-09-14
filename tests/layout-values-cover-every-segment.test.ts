/**
 * layout-values-cover-every-segment.test.ts — AM-37 and AM-38 (2026-09-01).
 *
 * THE DEFECT THIS FILE PINS. AM-33 gave a level hub its identity from the
 * layout VALUES render produced, and checked the values against the rendered
 * path before using them: `if (segs.length !== lv.length) continue`. Only the
 * folder mechanisms fed that list, so the count agreed only when every
 * directory segment came from a folder mechanism, one segment per layout entry.
 * Three shapes this project's own shipped recipes use break that:
 *
 *   - a `file` template carrying directories
 *     (`Crosswalks/CSF-to-800-53/cw-{a}-{b}.md`, six shipped recipes),
 *   - a literal separator inside a folder template
 *     (`Frameworks/{catalog.name}`, three shipped recipes),
 *   - a source cell that itself contains a separator (`IT/OT`, `2024/Q1`),
 *     which the wizard's folder templates do not force through `fs-safe`.
 *
 * On any of them the counts disagreed and the `continue` sent hub identity back
 * to parsing the note's path — the exact rule the values exist to replace,
 * reached silently, reported nowhere, and used as the identity index's lookup
 * key. AM-37 moves the recording to where segments are APPENDED, whatever
 * appends them, so the count agrees by construction; a disagreement is then a
 * bug, and the hub is refused by name instead of guessed at.
 *
 * AM-38 then collapses the two identity derivations into one. They differed:
 * the value form slugged a value whole (`slug()` maps `/` to `-`) while the
 * path form split on `/` first, so one separator inside a value produced two
 * different identities for one hub — a silent re-identification of every level
 * hub in an existing vault, with no duplicate note and no error to show for it.
 *
 * HOW THESE READ. The first group is pure `render()`, because the invariant
 * AM-37 buys is a property of render's own output: the k-th value IS the k-th
 * directory segment. The second group is pure `enrich()`, because the refusal
 * is its decision. The third group is a real import through
 * `generateFromRecipe`, because "an existing vault's hub curies do not move" is
 * a claim about what ends up in the vault, and it is asserted against the
 * released address-derived rule recomputed here rather than against a literal
 * somebody could quietly update.
 */

import { render, type Recipe, type LayoutValue } from '../src/render';
import { enrich, type EnrichNote } from '../src/generation/enrich';
import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { App } from 'obsidian';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ===========================================================================
// AM-37, at render: every directory segment carries its provenance.
// ===========================================================================

/** The directory part of a rendered primary path, split into its segments. */
function directorySegments(path: string): string[] {
	const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	return dir === '' ? [] : dir.split('/');
}

/** Render one identity and hand back both halves of the AM-37 invariant. */
function renderWithValues(recipe: Recipe, scope: Record<string, unknown>) {
	const values: LayoutValue[] = [];
	const address = render(recipe, { curie: 'x:1', scope }, undefined, values);
	return { path: address.primary.path, values, segments: directorySegments(address.primary.path) };
}

const SCOPE = {
	catalog: { name: 'NIST 800-53 r5' },
	family: { id: 'AC' },
	control: { id: 'AC-2' },
	domain: 'IT/OT',
	subject_id: 'ID.AM-01',
	object_id: 'AC-2',
};

describe('AM-37: render records one value per rendered DIRECTORY SEGMENT', () => {
	it('a file template carrying directories records them, and never the file itself', () => {
		// The shipped crosswalk shape. Pre-AM-37 `applyFile` appended the whole
		// rendered template as one string and recorded nothing, so two directories
		// existed that no value described and the hub pass fell back to the path.
		const recipe: Recipe = {
			recipe: 'crosswalk',
			source: { ontology: 'cw', levels: ['mapping'] },
			target: {
				layout: [{
					level: 'mapping',
					mechanism: 'file',
					template: 'Crosswalks/CSF-to-800-53/cw-{subject_id|slug}-{object_id|slug}.md',
				}],
			},
		};
		const { path, values, segments } = renderWithValues(recipe, SCOPE);

		expect(path).toBe('Crosswalks/CSF-to-800-53/cw-id-am-01-ac-2.md');
		expect(values.map((v) => v.value)).toEqual(['Crosswalks', 'CSF-to-800-53']);
		expect(values.map((v) => v.value)).toEqual(segments);
		// The file name is not a directory and must not be recorded as one, or
		// every hub chain would gain a level that is a note, not a folder.
		expect(values.map((v) => v.value)).not.toContain('cw-id-am-01-ac-2.md');
	});

	it('a literal separator inside a folder template records BOTH segments', () => {
		// `Frameworks/{catalog.name}` — three shipped recipes. The literal's
		// rendered text is its value; there is nothing else it could be.
		const recipe: Recipe = {
			recipe: 'list-view',
			source: { ontology: 'nist', levels: ['catalog', 'family', 'control'] },
			target: {
				layout: [
					{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
					{ level: 'family', mechanism: 'folder', template: '{family.id}' },
					{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
				],
			},
		};
		const { path, values, segments } = renderWithValues(recipe, SCOPE);

		expect(path).toBe('Frameworks/NIST 800-53 r5/AC/AC-2.md');
		expect(values.map((v) => v.value)).toEqual(['Frameworks', 'NIST 800-53 r5', 'AC']);
		expect(values.map((v) => v.value)).toEqual(segments);
		// The level name is descriptive and REPEATS when one entry produced
		// several segments. Stated so nobody reads `hub_levels` as a set.
		expect(values.map((v) => v.level)).toEqual(['catalog', 'catalog', 'family']);
	});

	it('a source cell containing a separator records both segments too', () => {
		// The wizard shape: `legacyConfigToRecipe` builds folder templates as a
		// bare `{column}` with no `fs-safe`, and real cells contain `IT/OT`,
		// `2024/Q1`, `N/A`. Obsidian makes two folders out of that, so the layout
		// produced two values whether or not anybody meant it to.
		const recipe: Recipe = {
			recipe: 'wizard',
			source: { ontology: 'w', levels: ['domain', 'leaf'] },
			target: {
				layout: [
					{ level: 'domain', mechanism: 'folder', template: '{domain}' },
					{ level: 'leaf', mechanism: 'file', template: '{control.id}.md' },
				],
			},
		};
		const { path, values, segments } = renderWithValues(recipe, SCOPE);

		expect(path).toBe('IT/OT/AC-2.md');
		expect(values.map((v) => v.value)).toEqual(['IT', 'OT']);
		expect(values.map((v) => v.value)).toEqual(segments);
	});

	it('a value is never itself a path', () => {
		// The property that makes AM-38's single derivation safe: no value can
		// contain a separator, so slugging a value and slugging a path segment are
		// the same operation on the same bytes. Asserted directly rather than
		// inferred, because it is the whole reason the two forms cannot diverge.
		const recipe: Recipe = {
			recipe: 'mixed',
			source: { ontology: 'm', levels: ['catalog', 'domain', 'leaf'] },
			target: {
				layout: [
					{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
					{ level: 'domain', mechanism: 'folder', template: '{domain}' },
					{ level: 'leaf', mechanism: 'file', template: 'Controls/{control.id}.md' },
				],
			},
		};
		const { path, values, segments } = renderWithValues(recipe, SCOPE);

		expect(path).toBe('Frameworks/NIST 800-53 r5/IT/OT/Controls/AC-2.md');
		expect(values.every((v) => !v.value.includes('/'))).toBe(true);
		expect(values.map((v) => v.value)).toEqual(segments);
		expect(values).toHaveLength(segments.length);
	});

	it('the invariant holds elementwise across every shape at once', () => {
		// One assertion for the guarantee the docstring makes: the k-th value is
		// BYTE-identical to the k-th segment, and the list is exactly that deep.
		// Every consumer's right to treat a mismatch as a bug rests on this line.
		const shapes: { recipe: Recipe; label: string }[] = [
			{
				label: 'folders only',
				recipe: {
					recipe: 'a', source: { ontology: 'a', levels: ['family', 'control'] },
					target: {
						layout: [
							{ level: 'family', mechanism: 'folder', template: '{family.id}' },
							{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
						],
					},
				},
			},
			{
				label: 'file with directories only',
				recipe: {
					recipe: 'b', source: { ontology: 'b', levels: ['control'] },
					target: {
						layout: [{ level: 'control', mechanism: 'file', template: 'A/B/C/{control.id}.md' }],
					},
				},
			},
			{
				label: 'no directories at all',
				recipe: {
					recipe: 'c', source: { ontology: 'c', levels: ['control'] },
					target: { layout: [{ level: 'control', mechanism: 'file', template: '{control.id}.md' }] },
				},
			},
			{
				label: 'literal and cell separators together',
				recipe: {
					recipe: 'd', source: { ontology: 'd', levels: ['catalog', 'domain', 'control'] },
					target: {
						layout: [
							{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
							{ level: 'domain', mechanism: 'folder', template: '{domain}' },
							{ level: 'control', mechanism: 'file', template: 'Leaf/{control.id}.md' },
						],
					},
				},
			},
		];
		for (const shape of shapes) {
			const { values, segments } = renderWithValues(shape.recipe, SCOPE);
			expect([shape.label, values.map((v) => v.value)]).toEqual([shape.label, segments]);
		}
	});

	it('a variadic folder level still agrees, one value per emitted segment', () => {
		// Fixed and variadic folders share one sink, which is the stated reason
		// the recording lives there. A regression that split only the fixed path
		// would be invisible without this.
		const recipe: Recipe = {
			recipe: 'variadic',
			target: {
				layout: [
					{ level: 'root', mechanism: 'folder', template: 'Techniques' },
					{ level: 'technique', mechanism: 'folder', template: '{id}', variadic: { delimiter: '.' } },
					{ level: 'technique', mechanism: 'file', template: '{id|fs-safe}.md' },
				],
			},
		} as unknown as Recipe;
		const { path, values, segments } = renderWithValues(recipe, { id: 'T1055.011.003' });
		expect(path).toBe('Techniques/T1055/T1055.011/T1055.011.003.md');
		expect(values.map((v) => v.value)).toEqual(segments);
		expect(segments.length).toBeGreaterThan(1);
	});
});

// ===========================================================================
// AM-37, at enrich: a disagreement is refused, never quietly answered by the
// path rule.
// ===========================================================================

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };

/** Two leaf notes under one folder chain, with whatever values the caller states. */
function batch(dir: string, values: LayoutValue[] | undefined, root: string): EnrichNote[] {
	return ['A', 'B'].map((id) => ({
		path: `${root}/${dir}/${id}.md`,
		curie: `${ONT}:${id}`,
		frontmatter: {},
		facets: [],
		...(values ? { layoutValues: values } : {}),
	}));
}

const hubCuriesOf = (result: ReturnType<typeof enrich>): string[] =>
	result.levelHubs.notes.map((h) => h.curie).sort();

/**
 * AM-66 (2026-09-04). THE WRITE SET THIS FIXTURE MEANS: every note in the batch.
 *
 * No batch below is a kept row - each is a live import writing every note it
 * hands over - so the write set is every path. Stated rather than left to
 * `enrich()` to infer: AM-65 made the fact required because, while it was
 * optional, an omitted write set silently meant "everything is writable", which
 * is true for THIS fixture and false for a kept-row one, so the one default
 * served one caller and quietly broke the other with nothing in the output naming
 * the omission. Assertions are unchanged.
 */
const writable = (...notes: EnrichNote[]): Set<string> => new Set(notes.map((n) => n.path));

describe('AM-37: a values/segments disagreement refuses the hub, and says so', () => {
	const ROOT = 'Frameworks';

	it('writes no hub note for the folder past the disagreement, but keeps the aligned one above it', () => {
		// AM-44 (2026-09-02) sharpened this from an arity check (mark the WHOLE
		// chain) to an elementwise one (mark from the first disagreeing INDEX
		// down, for this row's chain only). `values[0] = "Ops"` agrees with
		// `segs[0] = "Ops"`, so "Ops" is aligned and gets its hub; the chain only
		// disagrees at index 1 (`Team`, which nothing recorded a value for), so
		// only "Ops/Team" is refused. One malformed cell no longer refuses a
		// folder thousands of clean rows describe perfectly — see
		// `hub-refusal-elementwise-am44.test.ts` for the dedicated coverage.
		const notes = batch('Ops/Team', [{ level: 'group', value: 'Ops' }], ROOT);
		const result = enrich(
			notes,
			{ ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) },
		);
		expect(hubCuriesOf(result)).toEqual([`${ONT}:hub/_root`, `${ONT}:hub/ops`]);
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/ops/team`);
	});

	it('names the refused folder, says it will not guess, and does not blame the user', () => {
		// The user can do nothing about this and must not be told to. The copy
		// names the folder, states that the notes themselves were written, and
		// asks for a report — an actionable message rather than a raw internal.
		// Only ONE folder is named under AM-44 (see the sibling declaration): the
		// aligned "Ops" is not a deviation at all.
		const notes = batch('Ops/Team', [{ level: 'group', value: 'Ops' }], ROOT);
		const result = enrich(
			notes,
			{ ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) },
		);
		expect(result.deviations).toHaveLength(1);
		const said = result.deviations.join('\n');
		expect(said).not.toContain('Frameworks/Ops"');
		expect(said).toContain('Frameworks/Ops/Team');
		expect(said).toContain('will not guess');
		expect(said).toContain('The notes themselves were written normally.');
	});

	it('refuses rather than silently reverting to the address rule', () => {
		// The distinction the amendment is about. A run that fell back would
		// produce the SAME hub curies as a run that never had values at all, and
		// would report nothing. This asserts both halves: the fallback run does
		// produce them, and the disagreeing run neither produces them nor stays
		// quiet.
		const fellBackNotes = batch('Ops/Team', undefined, ROOT);
		const fellBack = enrich(fellBackNotes, {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...fellBackNotes),
		});
		expect(hubCuriesOf(fellBack)).toEqual([`${ONT}:hub/_root`, `${ONT}:hub/ops`, `${ONT}:hub/ops/team`]);
		expect(fellBack.deviations).toEqual([]);

		const refusedNotes = batch('Ops/Team', [{ level: 'group', value: 'Ops' }], ROOT);
		const refused = enrich(refusedNotes, {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...refusedNotes),
		});
		expect(hubCuriesOf(refused)).not.toEqual(hubCuriesOf(fellBack));
		expect(refused.deviations.length).toBeGreaterThan(0);
	});

	it('an ABSENT list is the documented fallback; an EMPTY one is a statement and is checked', () => {
		// `!lv` means "this caller collects no values", which is a fact about the
		// caller. `[]` means "this layout produced no directories", which is a
		// claim about the layout and can be wrong. Reading the second as the first
		// is how the fallback would grow back.
		const absentNotes = batch('Ops', undefined, ROOT);
		const absent = enrich(absentNotes, {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...absentNotes),
		});
		expect(hubCuriesOf(absent)).toContain(`${ONT}:hub/ops`);
		expect(absent.deviations).toEqual([]);

		const emptyNotes = batch('Ops', [], ROOT);
		const empty = enrich(emptyNotes, {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...emptyNotes),
		});
		expect(hubCuriesOf(empty)).not.toContain(`${ONT}:hub/ops`);
		expect(empty.deviations.length).toBeGreaterThan(0);
	});

	it('an aligned chain is untouched by any of this', () => {
		// The control. A refusal that fired on the ordinary case would pass every
		// declaration above and destroy the feature.
		const values: LayoutValue[] = [
			{ level: 'group', value: 'Ops' },
			{ level: 'team', value: 'Team' },
		];
		const alignedNotes = batch('Ops/Team', values, ROOT);
		const result = enrich(alignedNotes, {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...alignedNotes),
		});
		expect(result.deviations).toEqual([]);
		expect(hubCuriesOf(result)).toEqual([`${ONT}:hub/_root`, `${ONT}:hub/ops`, `${ONT}:hub/ops/team`]);
	});

	it('a folder HOSTED by an existing note is not refused: it reads no path to begin with', () => {
		// The refusal's stated scope. A hosted folder takes its host note's curie,
		// so nothing is being derived from an address and there is nothing to
		// refuse; dropping its Contents list would be a loss with no matching
		// risk.
		const notes: EnrichNote[] = [
			// `Ops.md` hosts the `Ops` folder by basename.
			{ path: `${ROOT}/Ops.md`, curie: `${ONT}:Ops`, frontmatter: {}, facets: [], layoutValues: [] },
			{ path: `${ROOT}/Ops/A.md`, curie: `${ONT}:A`, frontmatter: {}, facets: [], layoutValues: [] },
			{ path: `${ROOT}/Ops/B.md`, curie: `${ONT}:B`, frontmatter: {}, facets: [], layoutValues: [] },
		];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });
		// The Ops folder's Contents list survives, keyed on its host note.
		expect([...result.levelHubs.hostedChildrenByPath.keys()]).toContain(`${ROOT}/Ops.md`);
		// And no synthetic hub was minted for it under a path-derived identity.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/ops`);
	});
});

// ===========================================================================
// AM-38: one derivation, and the pinning proven on the shipped shapes.
// ===========================================================================

/**
 * The RELEASED rule, recomputed here: a hub's curie is the ontology prefix plus
 * its folder path relative to the import root, each segment slugged.
 *
 * Written out rather than imported so this file states the identity an existing
 * vault actually holds, independently of whatever the module currently
 * computes. A test that asked the implementation what the old answer was could
 * not detect the implementation changing it.
 */
function releasedHubCurie(ontology: string, folder: string, root: string): string {
	const rel = folder === root ? '' : (folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder);
	if (rel === '') return `${ontology}:hub/_root`;
	const slugOne = (s: string): string =>
		s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
			.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return `${ontology}:hub/${rel.split('/').map(slugOne).join('/')}`;
}

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path);
		files.delete(file.path);
		if (text !== undefined) files.set(to, text);
		file.path = to;
	};
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
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as unknown as App, files };
}

function parsedData(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

/** Every hub note in the vault: its path, and the curie it carries. */
function hubsInVault(files: Map<string, string>): { path: string; curie: string; values: unknown }[] {
	const out: { path: string; curie: string; values: unknown }[] = [];
	for (const [path, text] of files) {
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		if (!match) continue;
		let fm: Record<string, unknown>;
		try { fm = (yaml.load(match[1]) ?? {}) as Record<string, unknown>; } catch { continue; }
		if (fm.kind !== 'hub') continue;
		out.push({ path, curie: String(fm.curie), values: fm.hub_values });
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe('AM-38: the value form and the released address form are the same string', () => {
	const BASE = 'Frameworks';

	async function importShipped(layout: Recipe['target']['layout'], rows: Record<string, unknown>[]) {
		const { app, files } = makeApp();
		const recipe: Recipe = {
			recipe: 'shipped-shape',
			source: { ontology: ONT, levels: ['catalog', 'family', 'control'] },
			target: { layout, enrichment: HUB_CONFIG },
		};
		const result = await generateFromRecipe(app, parsedData(rows), recipe, {
			basePath: BASE,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'source.csv',
			importSet: 'new',
		});
		return { result, files };
	}

	const ROWS = [
		{ id: 'AC-2', family: 'AC', catalog: 'NIST 800-53 r5' },
		{ id: 'AC-3', family: 'AC', catalog: 'NIST 800-53 r5' },
	];

	it('`Frameworks/{catalog.name}` — the literal folder shape — keeps every hub curie it already had', () => {
		// Three shipped recipes use this. The literal renders a directory nothing
		// used to record a value for, so pass-13 lost the count check on it and
		// pass-12 read the identity off the path. This asserts the identity that
		// comes out NOW equals the one the released build wrote, folder by folder.
		return importShipped(
			[
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog}' },
				{ level: 'family', mechanism: 'folder', template: '{family}' },
				{ level: 'control', mechanism: 'file', template: '{id}.md' },
			],
			ROWS,
		).then(({ result, files }) => {
			expect(result.errors).toEqual([]);
			const hubs = hubsInVault(files);
			// The chain the literal produces really is deeper than the layout has
			// folder entries, which is the condition the defect needed.
			expect(hubs.map((h) => h.path)).toEqual([
				'Frameworks/Frameworks.md',
				'Frameworks/Frameworks/Frameworks.md',
				'Frameworks/Frameworks/NIST 800-53 r5/AC/AC.md',
				'Frameworks/Frameworks/NIST 800-53 r5/NIST 800-53 r5.md',
			]);
			for (const hub of hubs) {
				const folder = hub.path.slice(0, hub.path.lastIndexOf('/'));
				expect([hub.path, hub.curie]).toEqual([hub.path, releasedHubCurie(ONT, folder, BASE)]);
			}
			// And nothing was refused on the way.
			expect(result.warnings ?? []).toEqual([]);
		});
	});

	it('a file template carrying directories keeps its hub curies too', () => {
		// The other shipped shape, six recipes. Its directories are rendered by a
		// `file` entry, which recorded nothing at all before AM-37.
		return importShipped(
			[{ level: 'control', mechanism: 'file', template: 'Crosswalks/CSF-to-800-53/{id}.md' }],
			ROWS,
		).then(({ result, files }) => {
			expect(result.errors).toEqual([]);
			const hubs = hubsInVault(files);
			expect(hubs.map((h) => h.path)).toEqual([
				'Frameworks/Crosswalks/CSF-to-800-53/CSF-to-800-53.md',
				'Frameworks/Crosswalks/Crosswalks.md',
				'Frameworks/Frameworks.md',
			]);
			for (const hub of hubs) {
				const folder = hub.path.slice(0, hub.path.lastIndexOf('/'));
				expect([hub.path, hub.curie]).toEqual([hub.path, releasedHubCurie(ONT, folder, BASE)]);
			}
			expect(result.warnings ?? []).toEqual([]);
		});
	});

	it('a value with an internal separator derives one identity through BOTH inputs', () => {
		// `slug()` collapses `/` to `-`; `slugPath()` splits on it. Under two
		// derivations `IT/OT` was `hub/it-ot` from the values and `hub/it/ot` from
		// the path, and the value form won — renaming a hub an existing vault
		// already had, with no duplicate and no error to notice it by.
		return importShipped(
			[
				{ level: 'catalog', mechanism: 'folder', template: '{catalog}' },
				{ level: 'control', mechanism: 'file', template: '{id}.md' },
			],
			[{ id: 'A', catalog: 'IT/OT' }, { id: 'B', catalog: 'IT/OT' }],
		).then(({ result, files }) => {
			expect(result.errors).toEqual([]);
			const hubs = hubsInVault(files);
			const curies = hubs.map((h) => h.curie).sort();
			expect(curies).toContain(`${ONT}:hub/it`);
			expect(curies).toContain(`${ONT}:hub/it/ot`);
			// The form the two-derivation code produced. It must not appear.
			expect(curies).not.toContain(`${ONT}:hub/it-ot`);
			for (const hub of hubs) {
				const folder = hub.path.slice(0, hub.path.lastIndexOf('/'));
				expect([hub.path, hub.curie]).toEqual([hub.path, releasedHubCurie(ONT, folder, BASE)]);
			}
		});
	});

	it('the values a hub records are the segments themselves, one per level of its chain', () => {
		// What makes the byte-compatibility above a property rather than a
		// coincidence: the recorded values ARE the folder names, so slugging them
		// and slugging the path cannot disagree.
		return importShipped(
			[
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog}' },
				{ level: 'family', mechanism: 'folder', template: '{family}' },
				{ level: 'control', mechanism: 'file', template: '{id}.md' },
			],
			ROWS,
		).then(({ files }) => {
			const deepest = hubsInVault(files)
				.find((h) => h.path === 'Frameworks/Frameworks/NIST 800-53 r5/AC/AC.md')!;
			expect(deepest.values).toEqual(['Frameworks', 'NIST 800-53 r5', 'AC']);
		});
	});
});
