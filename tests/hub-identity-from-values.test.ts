/**
 * hub-identity-from-values.test.ts — AM-33 (2026-09-01): a hub's identity comes
 * from the layout VALUES, and the lookup reads the notes last.
 *
 * THE DEFECT THIS FILE PINS. A level hub's identity was
 * `${ontology}:hub/${slugPath(folderRelativeToRoot)}`, recomputed on every run
 * from the FINAL VAULT PATH of the notes that run rendered, and handed straight
 * to the identity index as a LOOKUP KEY. A path is a place, not a fact: it
 * carries the import root, it carries whatever a relocation inserted, and it
 * changes for reasons that have nothing to do with what the folder is about.
 * When the key moved, the hub that plainly existed was found by nothing, a
 * SECOND hub note was written for the same folder, and the first was orphaned
 * with the user's prose still on it. The compatibility alias could not help: it
 * too was recomputed from the current path, so it missed in precisely the case
 * its own docstring said it existed for.
 *
 * WHAT REPLACES IT. `render()` now hands out each folder mechanism's rendered
 * VALUE at the moment it produces it; the hub is minted from those values and
 * RECORDS them (`hub_levels`, `hub_values`); and the lookup is three steps,
 * values first and notes last:
 *
 *   1. the value-derived identity, through the owned index
 *   2. the legacy PATH-derived forms, which are computed from the current
 *      render and can therefore only ever match a hub that has not moved
 *   3. owned hub notes whose RECORDED values equal these values, found by
 *      READING them — the only step that survives a moved destination
 *
 * WHAT IS DELIBERATELY UNCHANGED. The value form and the root-relative path
 * form are byte-identical whenever the folder chain IS the layout chain, which
 * is the ordinary case. That coincidence is required, not incidental: AM-27
 * pins existing sets' identities, and a form that differed would re-identify
 * every hub in every existing vault. The forms diverge exactly where the path
 * stopped describing the layout — which is exactly where the old rule silently
 * minted a second hub.
 *
 * HOW THESE READ. Every scenario is a real two-run import against a vault
 * double, because what ends up in the vault is the subject. Between runs the
 * vault is edited the way a real one differs from a fresh one: a hub carrying a
 * superseded identity, a destination the user changed, a source that renamed a
 * value, and user prose on notes that must survive all of it.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ImportSetOption } from '../src/generation/import-set';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

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

const ONTOLOGY = 'hg';
const BASE = 'Frameworks';
/** A second destination, so "the rendered path moved" is a real move and not a rename. */
const MOVED_BASE = 'Imports/Frameworks';

function parsed(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function recipe(opts: { level?: string; template?: string } = {}): Recipe {
	const level = opts.level ?? 'group';
	return {
		recipe: 'hub-values',
		source: { ontology: ONTOLOGY, levels: [level, 'leaf'] },
		target: {
			layout: [
				{ level, mechanism: 'folder' as const, template: opts.template ?? '{group}' },
				{ level: 'leaf', mechanism: 'file' as const, template: '{key}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'none', level_hubs: 'notes' },
		},
	};
}

function run(
	app: App,
	rows: Record<string, unknown>[],
	importSet: ImportSetOption,
	opts: { basePath?: string; level?: string; template?: string } = {},
) {
	return generateFromRecipe(app, parsed(rows), recipe(opts), {
		basePath: opts.basePath ?? BASE,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
	});
}

/** Parsed frontmatter of one note, or null when it has none. */
function fmOf(files: Map<string, string>, path: string): Record<string, unknown> | null {
	const text = files.get(path);
	if (text === undefined) return null;
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) return null;
	return (yaml.load(match[1]) ?? {}) as Record<string, unknown>;
}

/** Every note in the vault whose `kind` is `hub`, by path. */
function hubPaths(files: Map<string, string>): string[] {
	return [...files.keys()].filter((path) => fmOf(files, path)?.kind === 'hub').sort();
}

/**
 * The import root's own hub. It exists in every one of these vaults, it has no
 * layout values (nothing rendered it — it is the destination), and it is named
 * explicitly in each expectation rather than filtered out, so a run that lost it
 * or duplicated it cannot pass.
 */
const rootHub = (base: string): string => `${base}/${base.split('/').pop()}.md`;

/** The import set id the first run minted, read back off a note it wrote. */
function setIdFrom(files: Map<string, string>, path: string): string {
	const fm = fmOf(files, path) as any;
	return String(fm._crosswalker.import_set.id);
}

const PROSE = 'A reviewer wrote this on the hub and it must survive.';

/** Put user prose on a note, below whatever managed content it carries. */
function addProse(files: Map<string, string>, path: string): void {
	files.set(path, `${files.get(path)!}\n\n${PROSE}\n`);
}

/**
 * Make a hub look like one an older Crosswalker wrote: its identity superseded
 * (the pre-F-4 form derived from the FULL vault path), and optionally with the
 * recorded values stripped, which is what a vault predating AM-33 actually holds.
 */
function supersedeHubIdentity(
	files: Map<string, string>,
	path: string,
	oldCurie: string,
	opts: { dropValues?: boolean } = {},
): void {
	let text = files.get(path)!;
	const fm = fmOf(files, path)!;
	text = text.replace(`curie: "${String(fm.curie)}"`, `curie: "${oldCurie}"`);
	if (opts.dropValues) {
		text = text.replace(/^hub_levels:\n(?:  - .*\n)+/m, '').replace(/^hub_values:\n(?:  - .*\n)+/m, '');
	}
	// A seed edit that silently did nothing would leave every declaration below
	// passing for the wrong reason — the hub would simply still carry the identity
	// this run computes. Refused rather than trusted.
	if (text === files.get(path)) throw new Error(`seed edit did not apply to ${path}`);
	files.set(path, text);
	if (String(fmOf(files, path)!.curie) !== oldCurie) throw new Error(`seed edit did not take on ${path}`);
	if (opts.dropValues && fmOf(files, path)!.hub_values !== undefined) {
		throw new Error(`recorded values still present on ${path}`);
	}
}

const ROWS = [{ key: 'T1', group: 'Ops' }, { key: 'T2', group: 'Ops' }];

// ---------------------------------------------------------------------------
// The enabling fact: a hub records what it is about.
// ---------------------------------------------------------------------------

describe('AM-33: a level hub records the layout values it was minted from', () => {
	it('writes hub_levels and hub_values beside the identity', async () => {
		// Without this the only record of what a hub is ABOUT is the folder it
		// happens to sit in, so "does this hub already exist" has to be recomputed
		// from an address on every run — which is the whole defect.
		const { app, files } = makeApp();
		const result = await run(app, ROWS, 'new');
		expect(result.errors).toEqual([]);

		const fm = fmOf(files, `${BASE}/Ops/Ops.md`)!;
		expect(fm.kind).toBe('hub');
		expect(fm.curie).toBe(`${ONTOLOGY}:hub/ops`);
		expect(fm.hub_levels).toEqual(['group']);
		expect(fm.hub_values).toEqual(['Ops']);
	});

	it('records the VALUE as the layout rendered it, not the slug the identity uses', async () => {
		// The identity is slugged and therefore many-to-one; the recorded value is
		// not. Recording the slug would throw away the only fact that can still
		// answer "which folder is this hub about" after a derivation improves.
		const { app, files } = makeApp();
		await run(app, [{ key: 'T1', group: 'Access Control' }, { key: 'T2', group: 'Access Control' }], 'new');

		const fm = fmOf(files, `${BASE}/Access Control/Access Control.md`)!;
		expect(fm.curie).toBe(`${ONTOLOGY}:hub/access-control`);
		expect(fm.hub_values).toEqual(['Access Control']);
	});
});

// ---------------------------------------------------------------------------
// Step 2: the computed legacy forms, and the exact case they can answer.
// ---------------------------------------------------------------------------

describe('AM-33 step 2: a legacy path-form hub is still adopted when the LAYOUT has not moved', () => {
	it('adopts a pre-AM-33 hub the user renamed, with no second hub and no lost prose', async () => {
		// The vaults that already exist. Their hubs carry an address-derived
		// identity and no recorded values at all, so step 3 cannot see them and
		// step 2 is the whole of their coverage. AM-27's pinning rule is what makes
		// this non-negotiable: an existing vault must not have every hub
		// re-identified underneath it.
		//
		// The hub is RENAMED here rather than left where it was, deliberately. A
		// pre-AM-33 hub sitting at exactly the address this run wants is adopted by
		// the address branch whether step 2 exists or not, so a test built that way
		// would pass with step 2 deleted and prove nothing about it. Renaming the
		// note empties the address and leaves the legacy identity as the only thing
		// that can still answer — which is the case step 2 is FOR: the layout is
		// unchanged, so the form computed from it is still the form the hub carries.
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		expect(first.errors).toEqual([]);
		const hubPath = `${BASE}/Ops/Ops.md`;
		const renamed = `${BASE}/Ops/Ops team.md`;
		const setId = setIdFrom(files, hubPath);
		addProse(files, hubPath);
		supersedeHubIdentity(files, hubPath, `${ONTOLOGY}:hub/frameworks/ops`, { dropValues: true });
		files.set(renamed, files.get(hubPath)!);
		files.delete(hubPath);

		const second = await run(app, ROWS, { id: setId });

		expect(second.errors).toEqual([]);
		expect(hubPaths(files)).toEqual([rootHub(BASE), hubPath].sort());
		expect(fmOf(files, hubPath)!.curie).toBe(`${ONTOLOGY}:hub/ops`);
		expect(files.get(hubPath)).toContain(PROSE);
	});

	it('adopts a pre-AM-33 hub that never moved at all', async () => {
		// The commoner half of the same vault, kept separate because TWO independent
		// mechanisms answer it — step 2's computed legacy form, and the address
		// branch beneath it — and either alone is enough. That redundancy is worth
		// having and worth stating: this declaration only goes red when both are
		// removed, so it is a property test, not a probe of one mechanism. The
		// renamed case above is the probe.
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		expect(first.errors).toEqual([]);
		const hubPath = `${BASE}/Ops/Ops.md`;
		const setId = setIdFrom(files, hubPath);
		addProse(files, hubPath);
		supersedeHubIdentity(files, hubPath, `${ONTOLOGY}:hub/frameworks/ops`, { dropValues: true });

		const second = await run(app, ROWS, { id: setId });

		expect(second.errors).toEqual([]);
		expect(hubPaths(files)).toEqual([rootHub(BASE), hubPath].sort());
		expect(fmOf(files, hubPath)!.curie).toBe(`${ONTOLOGY}:hub/ops`);
		expect(files.get(hubPath)).toContain(PROSE);
	});
});

// ---------------------------------------------------------------------------
// Step 3: the notes, read. The step that survives a move.
// ---------------------------------------------------------------------------

describe('AM-33 step 3: a hub whose recorded identity AND whose path both moved', () => {
	/**
	 * The setup both declarations below share. A vault whose hub carries a
	 * superseded identity (the full-vault-path form), still records its values,
	 * and whose destination the user then changed — so every form this run can
	 * COMPUTE misses, and only the note's own statement can answer.
	 */
	async function movedLegacyHub(level?: string) {
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		expect(first.errors).toEqual([]);
		const oldHub = `${BASE}/Ops/Ops.md`;
		const setId = setIdFrom(files, oldHub);
		addProse(files, oldHub);
		supersedeHubIdentity(files, oldHub, `${ONTOLOGY}:hub/frameworks/ops`);

		const second = await run(app, ROWS, { id: setId }, { basePath: MOVED_BASE, level });
		return { files, second, oldHub, newHub: `${MOVED_BASE}/Ops/Ops.md` };
	}

	it('finds the hub by the values it recorded, and does not mint a second one', async () => {
		// THE defect, end to end. Step 1 asks the index for the value form and the
		// index holds the superseded one; step 2 recomputes the address forms from a
		// destination that has changed, so both miss. Before step 3 existed, that
		// was the end of the search: a new hub was created at the new address and
		// the old one was left behind holding the reviewer's prose.
		const { files, second, oldHub, newHub } = await movedLegacyHub();

		expect(second.errors).toEqual([]);
		expect(hubPaths(files)).toEqual([rootHub(MOVED_BASE), newHub].sort());
		expect(files.has(oldHub)).toBe(false);
		expect(files.get(newHub)).toContain(PROSE);
	});

	it('restamps it with the value-derived identity and keeps the recorded values', async () => {
		// Adoption is not merely "left alone": the superseded identity is claimed
		// and replaced by the one this run mints, so the vault converges instead of
		// accumulating one identity per era.
		const { files, newHub } = await movedLegacyHub();

		// The prose is what says this is the note that was found, not a fresh one
		// written at the same address — a mint would carry the same curie and the
		// same values, so without it this declaration could not tell them apart.
		expect(files.get(newHub)).toContain(PROSE);
		const fm = fmOf(files, newHub)!;
		expect(fm.curie).toBe(`${ONTOLOGY}:hub/ops`);
		expect(fm.hub_values).toEqual(['Ops']);
	});

	it('proves every computed form really did miss, so the two above are not vacuous', async () => {
		// If either address form still matched, both declarations would pass for the
		// wrong reason. The recorded identity is neither the value form
		// (`hg:hub/ops`) nor either form computable from the NEW destination
		// (`hg:hub/ops`, `hg:hub/imports/frameworks/ops`).
		const { app, files } = makeApp();
		await run(app, ROWS, 'new');
		const oldHub = `${BASE}/Ops/Ops.md`;
		supersedeHubIdentity(files, oldHub, `${ONTOLOGY}:hub/frameworks/ops`);

		const recorded = String(fmOf(files, oldHub)!.curie);
		expect(recorded).toBe(`${ONTOLOGY}:hub/frameworks/ops`);
		expect(recorded).not.toBe(`${ONTOLOGY}:hub/ops`);
		expect(recorded).not.toBe(`${ONTOLOGY}:hub/imports/frameworks/ops`);
	});

	it('does not re-mint the hub when the layout LEVEL is renamed', async () => {
		// The key is the values alone. Renaming a level (`group` -> `family`) is a
		// change to how the source is DESCRIBED, not to which folder the hub is
		// about; keying on the level names too would orphan every hub in the vault
		// the first time someone tidied their layout.
		const { files, second, oldHub, newHub } = await movedLegacyHub('family');

		expect(second.errors).toEqual([]);
		expect(hubPaths(files)).toEqual([rootHub(MOVED_BASE), newHub].sort());
		expect(files.has(oldHub)).toBe(false);
		expect(files.get(newHub)).toContain(PROSE);
		// The names are still recorded, updated to what the layout now calls them.
		expect(fmOf(files, newHub)!.hub_levels).toEqual(['family']);
	});
});

// ---------------------------------------------------------------------------
// The other half: a value the SOURCE renamed is a different hub.
// ---------------------------------------------------------------------------

describe('AM-33: a renamed VALUE is genuinely a new identity', () => {
	it('mints a new hub and leaves the old one exactly as it was', async () => {
		// The amendment's own rule, and the boundary that keeps step 3 from becoming
		// a machine that adopts anything. `Ops` and `Operations` are two facts about
		// the source, so they are two hubs; the old one reconciles as an honest
		// orphan through orphan reporting rather than being silently absorbed.
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		expect(first.errors).toEqual([]);
		const oldHub = `${BASE}/Ops/Ops.md`;
		const setId = setIdFrom(files, oldHub);
		addProse(files, oldHub);
		const before = files.get(oldHub)!;

		const second = await run(app, [{ key: 'T1', group: 'Operations' }, { key: 'T2', group: 'Operations' }], { id: setId });

		expect(second.errors).toEqual([]);
		const newHub = `${BASE}/Operations/Operations.md`;
		expect(hubPaths(files)).toEqual([rootHub(BASE), newHub, oldHub].sort());
		// Untouched: not moved, not restamped, not merged into.
		expect(files.get(oldHub)).toBe(before);
		const fm = fmOf(files, newHub)!;
		expect(fm.curie).toBe(`${ONTOLOGY}:hub/operations`);
		expect(fm.hub_values).toEqual(['Operations']);
	});
});

// ---------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------

describe('AM-33: an ordinary re-import is still a re-import', () => {
	it('re-imports an unchanged source into one hub, keeping prose and identity', async () => {
		// A lookup that answered "found" too eagerly, or too rarely, would break
		// this. It is the case every user actually runs.
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		const hubPath = `${BASE}/Ops/Ops.md`;
		const setId = setIdFrom(files, hubPath);
		addProse(files, hubPath);

		const second = await run(app, ROWS, { id: setId });

		expect(first.errors).toEqual([]);
		expect(second.errors).toEqual([]);
		expect(hubPaths(files)).toEqual([rootHub(BASE), hubPath].sort());
		expect(fmOf(files, hubPath)!.curie).toBe(`${ONTOLOGY}:hub/ops`);
		expect(files.get(hubPath)).toContain(PROSE);
	});
});
