/**
 * hub-record-clearing-and-claim-order.test.ts — AM-39 (2026-09-01), the two
 * clauses that live in the generation engine.
 *
 * CLAUSE ONE — a record that cannot be cleared is not a record.
 * `hub_levels`/`hub_values` were managed only in the sense that a run which
 * COMPUTED them overwrote them. Managed keys are otherwise read off the fresh
 * frontmatter, so a run that computed none simply omitted the keys, and
 * `mergeFrontmatter` then preserved the note's old values as though a user had
 * typed them. The note went on asserting values it no longer had, the owned
 * value index went on offering it as the hub for those values, and a later run
 * whose folder genuinely had them adopted that note, MOVED it, and restamped it
 * into a folder about something else. Declaring the two keys managed on every
 * hub write makes "no values this run" delete the claim.
 *
 * CLAUSE TWO — a refusal must leave the vault as it found it. AM-31's invariant
 * is that an identity is claimed above every write AND above the relocation. The
 * `adoptedAlias` claim was the one claim below it, which was harmless only while
 * no reachable alias moved a note. AM-33 step 3 made a moved alias the ordinary
 * case, so a hub refused as a duplicate was first physically renamed to its new
 * address and then abandoned with nothing written into it: the vault
 * rearranged by an operation that reported an error and did nothing.
 *
 * HOW THESE READ. Real imports against a vault double, with the vault edited
 * between runs the way a real one differs from a fresh one. Every seed edit
 * self-checks and throws if it did not take, so a declaration cannot pass
 * because its setup silently failed.
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

const ONT = 'hg';
const BASE = 'Frameworks';

function parsedData(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function recipe(fileTemplate = '{key}.md'): Recipe {
	return {
		recipe: 'hub-records',
		source: { ontology: ONT, levels: ['group', 'leaf'] },
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder' as const, template: '{group}' },
				{ level: 'leaf', mechanism: 'file' as const, template: fileTemplate },
			],
			enrichment: { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const },
		},
	};
}

function run(
	app: App,
	rows: Record<string, unknown>[],
	importSet: ImportSetOption,
	opts: { fileTemplate?: string } = {},
) {
	return generateFromRecipe(app, parsedData(rows), recipe(opts.fileTemplate), {
		basePath: BASE,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
	});
}

function fmOf(files: Map<string, string>, path: string): Record<string, unknown> | null {
	const text = files.get(path);
	if (text === undefined) return null;
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) return null;
	return (yaml.load(match[1]) ?? {}) as Record<string, unknown>;
}

/** The import set id the first run minted, read back off a note it wrote. */
function setIdFrom(files: Map<string, string>, path: string): string {
	const fm = fmOf(files, path) as any;
	return String(fm._crosswalker.import_set.id);
}

const ROWS = [{ key: 'T1', group: 'Ops' }, { key: 'T2', group: 'Ops' }];
const ROOT_HUB = `${BASE}/${BASE}.md`;
const OPS_HUB = `${BASE}/Ops/Ops.md`;

/**
 * Write a values record onto a note that does not compute one — a hub written
 * under a different destination, where the folder that is the root today was a
 * level folder yesterday. Self-checking: an edit that did not apply throws
 * rather than leaving a declaration to pass for the wrong reason.
 */
function seedStaleValues(files: Map<string, string>, path: string, values: string[]): void {
	const before = files.get(path)!;
	if (fmOf(files, path)!.hub_values !== undefined) throw new Error(`${path} already records values`);
	const levels = values.map(() => '  - group').join('\n');
	const listed = values.map((v) => `  - ${v}`).join('\n');
	const after = before.replace(/^kind: hub$/m, `kind: hub\nhub_levels:\n${levels}\nhub_values:\n${listed}`);
	if (after === before) throw new Error(`seed edit did not apply to ${path}`);
	files.set(path, after);
	if (!Array.isArray(fmOf(files, path)!.hub_values)) throw new Error(`seed edit did not take on ${path}`);
}

// ===========================================================================
// Clause one — the stale record is deleted, and therefore cannot be matched.
// ===========================================================================

describe('AM-39: a hub run that computes no values REMOVES the record it cannot compute', () => {
	it('the root hub records no values at all, so it is the case that needs clearing', async () => {
		// The enabling fact. `valuesByFolder` starts one segment below the import
		// root, so the destination folder's own hub is a hub that every run writes
		// and no run computes values for. Any record it carries is stale by
		// construction.
		const { app, files } = makeApp();
		const result = await run(app, ROWS, 'new');
		expect(result.errors).toEqual([]);
		expect(fmOf(files, ROOT_HUB)!.kind).toBe('hub');
		expect(fmOf(files, ROOT_HUB)!.hub_values).toBeUndefined();
		// While the level hub below it does record them.
		expect(fmOf(files, OPS_HUB)!.hub_values).toEqual(['Ops']);
	});

	it('deletes a stale hub_values a previous scheme left on the note', async () => {
		// THE defect. Pre-AM-39 the merge preserved this record as if a user had
		// written it, because the fresh frontmatter simply had no such key and
		// managed keys are read off the fresh frontmatter.
		const { app, files } = makeApp();
		await run(app, ROWS, 'new');
		const setId = setIdFrom(files, ROOT_HUB);
		seedStaleValues(files, ROOT_HUB, ['Ops']);

		const second = await run(app, ROWS, { id: setId, scheme: 'endpoint-v1' } as unknown as ImportSetOption);
		expect(second.errors).toEqual([]);
		expect(fmOf(files, ROOT_HUB)!.hub_values).toBeUndefined();
		expect(fmOf(files, ROOT_HUB)!.hub_levels).toBeUndefined();
	});

	it('leaves a user key on the same note completely alone while doing it', async () => {
		// The clause is "these two keys are managed", not "unrecognised keys are
		// swept". A merge that cleared more than it owns would pass the
		// declaration above and quietly delete a reviewer's annotation.
		const { app, files } = makeApp();
		await run(app, ROWS, 'new');
		const setId = setIdFrom(files, ROOT_HUB);
		seedStaleValues(files, ROOT_HUB, ['Ops']);
		files.set(ROOT_HUB, files.get(ROOT_HUB)!.replace(/^kind: hub$/m, 'kind: hub\nowner: a reviewer'));

		await run(app, ROWS, { id: setId, scheme: 'endpoint-v1' } as unknown as ImportSetOption);
		expect(fmOf(files, ROOT_HUB)!.owner).toBe('a reviewer');
		expect(fmOf(files, ROOT_HUB)!.hub_values).toBeUndefined();
	});

	it('the cleared note can no longer be matched by values, so nothing adopts it', async () => {
		// The consequence the clause exists for. With the stale record standing, a
		// folder whose values are ['Ops'] and whose own hub is gone matches the
		// ROOT hub at step 3 — which moves it out of the destination folder and
		// restamps it as the Ops hub. Cleared, step 3 sees nothing and the Ops hub
		// is minted where it belongs.
		const { app, files } = makeApp();
		await run(app, ROWS, 'new');
		const setId = setIdFrom(files, ROOT_HUB);
		const set = { id: setId, scheme: 'endpoint-v1' } as unknown as ImportSetOption;
		seedStaleValues(files, ROOT_HUB, ['Ops']);
		await run(app, ROWS, set);

		// The user deletes the Ops hub, so steps 1 and 2 have nothing to find and
		// step 3 is the only lookup left.
		files.delete(OPS_HUB);
		const third = await run(app, ROWS, set);

		expect(third.errors).toEqual([]);
		// The root hub stayed where it is, under the identity it has.
		expect(files.has(ROOT_HUB)).toBe(true);
		expect(fmOf(files, ROOT_HUB)!.curie).toBe(`${ONT}:hub/_root`);
		// And the Ops hub was minted rather than stolen from the root.
		expect(files.has(OPS_HUB)).toBe(true);
		expect(fmOf(files, OPS_HUB)!.curie).toBe(`${ONT}:hub/ops`);
	});
});

// ===========================================================================
// Clause two — the alias claim happens above the move.
// ===========================================================================

describe('AM-39: a hub refused as a duplicate is not relocated first', () => {
	/**
	 * TWO folders whose identities meet on one string, produced entirely by the
	 * product from ordinary source cells.
	 *
	 *   - a cell reading `Frameworks/Ops` renders two directories, so the deeper
	 *     folder's value-derived identity is `hg:hub/frameworks/ops`;
	 *   - the sibling folder `Ops` sits directly under the import root, so its
	 *     superseded FULL-VAULT-PATH alias is that same string.
	 *
	 * Folders are processed in path order, so the deeper folder claims the string
	 * as its own current identity BEFORE the shallow one tries to adopt it as an
	 * alias. The adoption must then be refused - and the note it landed on, which
	 * is the deeper folder's own hub sitting at its own address, must still be
	 * there afterwards.
	 */
	const CONTESTED = `${ONT}:hub/frameworks/ops`;
	const DEEP_ROWS = [{ key: 'T1', group: 'Frameworks/Ops' }, { key: 'T2', group: 'Ops' }];
	const DEEP_HUB = `${BASE}/Frameworks/Ops/Ops.md`;

	async function seeded() {
		const { app, files } = makeApp();
		const first = await run(app, DEEP_ROWS, 'new');
		expect(first.errors).toEqual([]);
		// The fixture is only interesting if it really built the collision.
		if (fmOf(files, DEEP_HUB)?.curie !== CONTESTED) {
			throw new Error(`fixture did not produce ${CONTESTED} at ${DEEP_HUB}`);
		}
		if (fmOf(files, OPS_HUB)?.curie !== `${ONT}:hub/ops`) throw new Error('fixture did not produce the sibling hub');
		const setId = setIdFrom(files, ROOT_HUB);
		// The user deletes the sibling hub, so step 1 misses and the alias lookup
		// is the only step left - which is the moved-alias case AM-33 step 2 and
		// step 3 both make ordinary.
		files.delete(OPS_HUB);
		return { app, files, set: { id: setId, scheme: 'endpoint-v1' } as unknown as ImportSetOption };
	}

	it('leaves the note the alias landed on exactly where it was', async () => {
		// THE defect. `applyHubRelocation` ran above the claim, so the refused hub
		// first renamed this note out of its own folder and into the sibling's
		// address, then abandoned it: one hub note wearing another hub's address,
		// moved by an operation that reported an error and wrote nothing.
		const { app, files, set } = await seeded();
		await run(app, DEEP_ROWS, set);

		expect(files.has(DEEP_HUB)).toBe(true);
		expect(fmOf(files, DEEP_HUB)!.curie).toBe(CONTESTED);
	});

	it('does not leave a hub note at the address the refused move was headed for', async () => {
		// The other half of "the vault is as it was found": nothing appears at the
		// desired address either, because the refusal wrote nothing.
		const { app, files, set } = await seeded();
		await run(app, DEEP_ROWS, set);
		expect(fmOf(files, OPS_HUB)?.kind).not.toBe('hub');
	});

	it('says which identity is contested and where the other claim came from', async () => {
		// The refusal is reported, not swallowed. A silent one leaves the user
		// with a missing index note and no way to find out why.
		const { app, files, set } = await seeded();
		const result = await run(app, DEEP_ROWS, set);
		const said = result.errors.map((e) => e.message).join('\n');
		expect(said).toContain(CONTESTED);
		expect(said).toContain(DEEP_HUB);
	});

	it('an uncontested alias is still adopted, and still relocated', async () => {
		// The control. An implementation that refused every alias would pass all
		// three declarations above and break the reconciliation AM-33 step 2
		// exists for.
		const { app, files } = makeApp();
		const first = await run(app, ROWS, 'new');
		expect(first.errors).toEqual([]);
		const setId = setIdFrom(files, ROOT_HUB);

		// A pre-AM-33 hub: the full-vault-path identity, no recorded values, and
		// dragged somewhere else by the user.
		const text = files.get(OPS_HUB)!
			.replace(`curie: "${ONT}:hub/ops"`, `curie: "${CONTESTED}"`)
			.replace(/^hub_levels:\n(?:  - .*\n)+/m, '')
			.replace(/^hub_values:\n(?:  - .*\n)+/m, '');
		if (text === files.get(OPS_HUB)) throw new Error('seed edit did not apply');
		files.delete(OPS_HUB);
		files.set(`${BASE}/Ops/Dragged.md`, text);

		const second = await run(app, ROWS, { id: setId, scheme: 'endpoint-v1' } as unknown as ImportSetOption);
		expect(second.errors).toEqual([]);
		expect(files.has(`${BASE}/Ops/Dragged.md`)).toBe(false);
		expect(fmOf(files, OPS_HUB)!.curie).toBe(`${ONT}:hub/ops`);
	});
});
