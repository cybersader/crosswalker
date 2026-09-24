import { TFile, TFolder } from 'obsidian';
import nistNested from '../recipes/import/nist-800-53-nested.json';
import criNested from '../recipes/import/cri-profile-v2-2-nested.json';
import { importSssom } from '../src/import/sssom-importer';
import { generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import { edgeEndpointIndex, resolveEdgeEndpoints } from '../src/generation/edge-endpoints';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (value: string) => unknown };

function vault() {
	const files = new Map<string, string>();
	const folders = new Set(['']);
	const modified: string[] = [];
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path)!;
		files.delete(file.path);
		files.set(to, text);
		file.path = to;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
			create: async (path: string, text: string) => { files.set(path, text); return new TFile(path); },
			modify: async (file: { path: string }, text: string) => { modified.push(file.path); files.set(file.path, text); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (!text) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text);
				return { frontmatter: match ? yaml.load(match[1]) : undefined };
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files, modified };
}
const base = 'Frameworks/Synthetic';
function recipe(implied = true, hubs = false): Recipe {
	return {
		recipe: 'synthetic-implied',
		source: { ontology: 'synthetic', levels: ['family', 'control'] },
		target: {
			layout: [
				{ level: 'family', mechanism: 'folder', template: '{family}', ...(implied ? { implied_concept: true } : {}) },
				{ level: 'control', mechanism: 'file', template: '{id}.md' },
			],
			...(hubs ? { enrichment: { level_hubs: 'notes' } } : {}),
		},
	};
}
function data(rows: Array<{ family: string; id: string }> = [{ family: 'ZZ', id: 'ZZ-1' }, { family: 'YY', id: 'YY-1' }]): ParsedData {
	return { columns: ['family', 'id'], rows, rowCount: rows.length };
}
function fm(text: string): any {
	return yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as any;
}
function run(app: any, rec: Recipe, parsed: ParsedData, mode: 'skip' | 'replace', importSet: any) {
	return generateFromRecipe(app, parsed, rec, { basePath: base, overwriteMode: mode,
		createFolders: true, sourceFileName: 'synthetic.csv', importSet,
		curieLocalPart: (row: Record<string, unknown>) => String(row.id) });
}

describe('implied concept notes', () => {
	it('creates notes without an enrichment block and holds them byte-identical on Skip', async () => {
		const { app, files, modified } = vault();
		const first = await run(app, recipe(), data(), 'replace', 'new');
		expect(first.errors).toEqual([]);
		const path = `${base}/ZZ/ZZ.md`;
		expect(files.has(path)).toBe(true);
		expect(fm(files.get(path)!).curie).toBe('synthetic:ZZ');
		expect(fm(files.get(path)!).implied_values).toEqual(['ZZ']);
		expect(fm(files.get(path)!).kind).toBeUndefined();
		expect(files.get(path)).toContain('[[ZZ-1]]');
		expect(fm(files.get(`${base}/ZZ/ZZ-1.md`)!).parent_curie).toBe('synthetic:ZZ');
		const snapshot = new Map(files);
		const modifiedBefore = modified.length;
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const second = await run(app, recipe(), data(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
		expect(second.created).toEqual([]);
		expect(files).toEqual(snapshot);
		expect(modified).toHaveLength(modifiedBefore);
	});
	it('A2: byte-identical Replace keeps the implied note and its produced_at without writing', async () => {
		const { app, files, modified } = vault();
		await run(app, recipe(), data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const before = files.get(path)!;
		const writes = modified.filter((changed) => changed === path).length;
		const result = await run(app, recipe(), data(), 'replace', { id: setId });
		expect(result.errors).toEqual([]);
		expect(files.get(path)).toBe(before);
		expect(modified.filter((changed) => changed === path)).toHaveLength(writes);
	});
	it('leaves a removed implied concept as an orphan', async () => {
		const { app, files } = vault();
		await run(app, recipe(), data(), 'replace', 'new');
		const setId = fm(files.get(`${base}/ZZ/ZZ.md`)!)._crosswalker.import_set.id;
		const refreshed = await run(app, recipe(), data([{ family: 'YY', id: 'YY-1' }]), 'skip', { id: setId });
		expect(refreshed.orphans?.map((o: any) => o.curie)).toContain('synthetic:ZZ');
	});
	it('keeps a pre-feature hub byte-identical under Skip and names Replace', async () => {
		const { app, files } = vault();
		await run(app, recipe(false, true), data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const before = files.get(path)!;
		const setId = fm(before)._crosswalker.import_set.id;
		const refreshed = await run(app, recipe(true, true), data(), 'skip', { id: setId });
		expect(refreshed.errors).toEqual([]);
		expect(files.get(path)).toBe(before);
		expect(refreshed.orphans ?? []).toEqual([]);
		expect((refreshed.warnings ?? []).map((w: any) => w.message).join('\n')).toContain('Replace');
		expect((refreshed.warnings ?? []).filter((w: any) => w.message.includes('index note from before concept identity'))).toHaveLength(1);
	});
	it('uses singular grammar for one skipped legacy folder note', async () => {
		const { app, files } = vault();
		const rows = data([{ family: 'ZZ', id: 'ZZ-1' }]);
		await run(app, recipe(false, true), rows, 'replace', 'new');
		const setId = fm(files.get(`${base}/ZZ/ZZ.md`)!)._crosswalker.import_set.id;
		const result = await run(app, recipe(true, true), rows, 'skip', { id: setId });
		expect((result.warnings ?? []).map((w: any) => w.message).join('\n')).toContain('1 folder holds');
	});
	it('does not re-identify a half-recorded implied note during Skip', async () => {
		const { app, files } = vault();
		await run(app, recipe(), data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		files.set(path, files.get(path)!.replace(/^implied_levels:.*\n/m, ''));
		const before = files.get(path);
		const setId = fm(before!)._crosswalker.import_set.id;
		const refreshed = await run(app, recipe(), data(), 'skip', { id: setId });
		expect(files.get(path)).toBe(before);
		expect(refreshed.orphans ?? []).toEqual([]);
		expect((refreshed.warnings ?? []).map((w: any) => w.message).join('\n')).toContain('recorded identity could not be read');
	});
	it('lets a population row own the implied identity instead', async () => {
		const { app, files } = vault();
		const result = await run(app, recipe(), data([{ family: 'ZZ', id: 'ZZ' }, { family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		expect(result.errors).toEqual([]);
		const owners = [...files.values()].filter((text) => fm(text).curie === 'synthetic:ZZ');
		expect(owners).toHaveLength(1);
		expect(fm(owners[0]).implied_level).toBeUndefined();
	});
	it('refuses two source identities for the same rendered folder', async () => {
		const { app, files } = vault();
		const rec = recipe();
		rec.target.layout[0].implied_concept = { identity: '{id}' };
		const result = await run(app, rec, data([{ family: 'ZZ', id: 'AA' }, { family: 'ZZ', id: 'BB' }]), 'replace', 'new');
		expect(result.errors).toEqual([]);
		expect(files.has(`${base}/ZZ/ZZ.md`)).toBe(false);
		expect((result.warnings ?? []).map((w: any) => w.message).join('\n')).toContain('disagree about its identity');
	});
	it('rejects a legacy identity derivation before writing', async () => {
		const { app, files } = vault();
		const result = await run(app, recipe(), data(), 'replace', {
			id: 'iset-abc123', scheme: 'endpoint-v1', ontology: 'synthetic',
			destination: base, derivation: 'filename-stem-v1',
		});
		expect(result.errors.map((e: any) => e.message).join('\n')).toContain('legacy rule');
		expect(files.size).toBe(0);
	});
	it('does not adopt a misplaced implied note in a sibling folder', async () => {
		const { app, files } = vault();
		await run(app, recipe(), data(), 'replace', 'new');
		const original = `${base}/ZZ/ZZ.md`;
		const misplaced = `${base}/YY/ZZ.md`;
		const setId = fm(files.get(original)!)._crosswalker.import_set.id;
		const text = files.get(original)!;
		files.delete(original);
		files.set(misplaced, text);
		const refreshed = await run(app, recipe(), data(), 'skip', { id: setId });
		expect(files.get(misplaced)).toBe(text);
		expect((refreshed.warnings ?? []).map((w: any) => w.message).join('\n')).toContain(misplaced);
	});
	it('refreshes implied notes in place while preserving user fields and prose', async () => {
		const { app, files } = vault();
		const original = await run(app, recipe(), data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const first = files.get(path)!;
		files.set(path, first.replace('title: ZZ\n', 'title: ZZ\nreviewer: Invented reviewer\n') + '\nUser prose survives.\n');
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const pathsBefore = [...files.keys()].sort();
		const result = await run(app, recipe(), data(), 'replace', { id: setId });
		expect(original.created).toContain(path);
		// Row writes remain in result.created under the existing result contract;
		// no new vault files or newly created implied notes are allowed here.
		expect([...files.keys()].sort()).toEqual(pathsBefore);
		expect(result.created).not.toContain(path);
		expect(result.moved ?? []).toEqual([]);
		expect(result.orphans ?? []).toEqual([]);
		expect(files.get(path)).toContain('User prose survives.');
		expect(fm(files.get(path)!).reviewer).toBe('Invented reviewer');
		expect(fm(files.get(path)!).children).toEqual(['[[ZZ-1]]']);
	});
	it('refuses a different import set owning one implied identity without blocking siblings', async () => {
		const { app, files } = vault();
		await run(app, recipe(false), data([{ family: 'ZZ', id: 'ZZ' }]), 'replace', 'new');
		const previous = files.get(`${base}/ZZ/ZZ.md`)!;
		const result = await run(app, recipe(), data(), 'replace', 'new');
		expect(result.errors.map((error: any) => error.message).join('\n')).toContain('synthetic:ZZ');
		expect(files.get(`${base}/ZZ/ZZ.md`)).toBe(previous);
		expect(files.has(`${base}/YY/YY.md`)).toBe(true);
	});
	it('resolves mapping endpoints to the implied note by stamped CURIE', async () => {
		const { app, files } = vault();
		await run(app, recipe(), data(), 'replace', 'new');
		const { index } = await edgeEndpointIndex(app);
		const resolved = resolveEdgeEndpoints(index, {
			subject_id: 'synthetic:ZZ-1', object_id: 'synthetic:YY', predicate_id: 'maps_to',
		});
		expect(resolved.object_note).toBe(`[[${base}/YY/YY|YY]]`);
		expect(resolved.unresolved).toEqual([]);
		expect(files.has(`${base}/YY/YY.md`)).toBe(true);
	});
	it('respects explicit parent and children controls', async () => {
		const { app, files } = vault();
		const rec = recipe();
		rec.target.enrichment = { parent_links: false, children_lists: false };
		await run(app, rec, data(), 'replace', 'new');
		const parent = fm(files.get(`${base}/ZZ/ZZ.md`)!);
		const child = fm(files.get(`${base}/ZZ/ZZ-1.md`)!);
		expect(parent.children).toEqual([]);
		expect(child.parent_curie).toBeUndefined();
		expect(child.parent).toBeUndefined();
	});
	it.each(['flag removed', 'parent links disabled'] as const)('removes only engine-owned stale parent fields when %s', async (change) => {
		const { app, files } = vault();
		await run(app, recipe(), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const child = `${base}/ZZ/ZZ-1.md`;
		const initial = fm(files.get(child)!);
		expect(initial.parent_curie).toBe('synthetic:ZZ');
		expect(initial._crosswalker_managed_keys).toEqual(['parent', 'parent_curie']);
		files.set(child, files.get(child)!.replace('curie: "synthetic:ZZ-1"\n', 'curie: "synthetic:ZZ-1"\nreviewer: Invented reviewer\n'));
		const rec = recipe(change !== 'flag removed');
		if (change === 'parent links disabled') rec.target.enrichment = { parent_links: false };
		const result = await run(app, rec, data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', { id: initial._crosswalker.import_set.id });
		expect(result.errors).toEqual([]);
		const current = fm(files.get(child)!);
		expect(current.parent).toBeUndefined();
		expect(current.parent_curie).toBeUndefined();
		expect(current._crosswalker_managed_keys).toBeUndefined();
		expect(current.reviewer).toBe('Invented reviewer');
		if (change === 'flag removed') expect(result.orphans?.map((orphan: any) => orphan.curie)).toContain('synthetic:ZZ');
	});
	it('preserves a user-added parent when the engine never patched that note', async () => {
		const { app, files } = vault();
		await run(app, recipe(false), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const child = `${base}/ZZ/ZZ-1.md`;
		const initial = fm(files.get(child)!);
		expect(initial._crosswalker_managed_keys).toBeUndefined();
		files.set(child, files.get(child)!.replace('curie: "synthetic:ZZ-1"\n',
			'curie: "synthetic:ZZ-1"\nparent: "[[User parent]]"\nparent_curie: "synthetic:USER"\n'));
		const result = await run(app, recipe(false), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace',
			{ id: initial._crosswalker.import_set.id });
		expect(result.errors).toEqual([]);
		expect(fm(files.get(child)!).parent).toBe('[[User parent]]');
		expect(fm(files.get(child)!).parent_curie).toBe('synthetic:USER');
		expect(fm(files.get(child)!)._crosswalker_managed_keys).toBeUndefined();
	});
	it('wizard refresh removes only recorded engine parent fields after disabling implied notes', async () => {
		const { app, files } = vault();
		const rows = data([{ family: 'ZZ', id: 'ZZ-1' }]);
		await run(app, recipe(), rows, 'replace', 'new');
		const child = `${base}/ZZ/ZZ-1.md`;
		const setId = fm(files.get(child)!)._crosswalker.import_set.id;
		expect(fm(files.get(child)!)._crosswalker_managed_keys).toEqual(['parent', 'parent_curie']);
		const config = { name: 'synthetic-implied', mapping: {
			hierarchy: [], frontmatter: [], links: [], body: [],
			filename: { template: '{id}.md', sanitize: true },
		} };
		const result = await generateNotes(app, rows, config as any,
			{ basePath: base, createFolders: true, overwriteMode: 'replace',
				sourceFileName: 'synthetic.csv', importSet: { id: setId }, recipeOverride: recipe(false) });
		expect(result.errors).toEqual([]);
		expect(fm(files.get(child)!).parent).toBeUndefined();
		expect(fm(files.get(child)!).parent_curie).toBeUndefined();
		expect(fm(files.get(child)!)._crosswalker_managed_keys).toBeUndefined();
	});
	it('creates a root home note, not a redundant family hub, when hubs are enabled', async () => {
		const { app, files } = vault();
		const result = await run(app, recipe(true, true), data(), 'replace', 'new');
		expect(result.errors).toEqual([]);
		const home = [...files.entries()].find(([, text]) => fm(text).kind === 'hub' && fm(text).hub_level === undefined && fm(text).curie?.includes('hub/'));
		expect(home).toBeDefined();
		expect(home![1]).toContain('[[ZZ]]');
		expect(home![1]).toContain('[[YY]]');
		expect(fm(files.get(`${base}/ZZ/ZZ.md`)!).implied_level).toBe('family');
		expect([...files.values()].filter((text) => fm(text).curie === 'synthetic:hub/ZZ')).toHaveLength(0);
	});
	it.each(['none', 'notes'] as const)('removing the implied flag leaves the concept orphaned with hubs %s', async (hubs) => {
		const { app, files } = vault();
		const withFlag = recipe(true, hubs === 'notes');
		await run(app, withFlag, data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const original = files.get(path)!;
		const setId = fm(original)._crosswalker.import_set.id;
		const withoutFlag = recipe(false, hubs === 'notes');
		const held = await run(app, withoutFlag, data(), 'skip', { id: setId });
		expect(held.errors).toEqual([]);
		expect(files.get(path)).toBe(original);
		expect(held.orphans?.map((orphan: any) => orphan.curie)).toContain('synthetic:ZZ');
		if (hubs === 'notes') {
			const replaced = await run(app, withoutFlag, data(), 'replace', { id: setId });
			expect(replaced.errors).toEqual([]);
			expect(files.get(path)).toBe(original);
			expect(fm(files.get(path)!).implied_level).toBe('family');
			expect(fm(files.get(path)!).kind).toBeUndefined();
			expect(fm(files.get(path)!).hub_values).toBeUndefined();
			expect(replaced.orphans?.map((orphan: any) => orphan.curie)).toContain('synthetic:ZZ');
			expect((replaced.warnings ?? []).map((w: any) => w.message).join(' ')).toContain('Turn the implied concept level back on');
		}
	});
	it('a population row takes an observed implied identity in place, preserving user data', async () => {
		const { app, files, modified } = vault();
		await run(app, recipe(true, true), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		files.set(path, files.get(path)!.replace('title: ZZ\n', 'title: ZZ\nreviewer: Invented reviewer\n') + '\nUser prose survives.\n');
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const rows = data([{ family: 'ZZ', id: 'ZZ' }, { family: 'ZZ', id: 'ZZ-1' }]);
		const result = await run(app, recipe(true, true), rows, 'replace', { id: setId });
		expect(result.errors).toEqual([]);
		expect(result.conflicts ?? []).toEqual([]);
		expect(result.orphans ?? []).toEqual([]);
		expect((result.warnings ?? []).map((warning: any) => warning.message).join(' ')).not.toContain('Duplicate');
		const note = fm(files.get(path)!);
		expect(note.curie).toBe('synthetic:ZZ');
		expect(note.kind).toBeUndefined();
		expect(note.hub_levels).toBeUndefined();
		expect(note.hub_values).toBeUndefined();
		expect(note.implied_level).toBeUndefined();
		expect(note.implied_levels).toBeUndefined();
		expect(note.implied_values).toBeUndefined();
		expect(note.reviewer).toBe('Invented reviewer');
		expect(files.get(path)).toContain('User prose survives.');
		expect([...files.values()].filter((text) => fm(text).curie === 'synthetic:ZZ')).toHaveLength(1);
		const bytes = files.get(path)!;
		const writes = modified.filter((changed) => changed === path).length;
		const again = await run(app, recipe(true, true), rows, 'replace', { id: setId });
		expect(again.errors).toEqual([]);
		expect(again.orphans ?? []).toEqual([]);
		expect(files.get(path)).toBe(bytes);
		expect(modified.filter((changed) => changed === path)).toHaveLength(writes);
	});
	it('Skip with a new population row keeps the existing implied note without a duplicate claim', async () => {
		const { app, files, modified } = vault();
		await run(app, recipe(true, true), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const before = files.get(path)!;
		const writes = modified.filter((changed) => changed === path).length;
		const setId = fm(before)._crosswalker.import_set.id;
		const result = await run(app, recipe(true, true), data([
			{ family: 'ZZ', id: 'ZZ' }, { family: 'ZZ', id: 'ZZ-1' },
		]), 'skip', { id: setId });
		expect(result.errors).toEqual([]);
		expect(result.orphans ?? []).toEqual([]);
		expect(files.get(path)).toBe(before);
		expect(modified.filter((changed) => changed === path)).toHaveLength(writes);
	});
	it('refuses a population-row takeover at another path without moving the implied note', async () => {
		const { app, files } = vault();
		await run(app, recipe(), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const original = files.get(path)!;
		const setId = fm(original)._crosswalker.import_set.id;
		const moved = recipe();
		moved.target.layout[1].template = '{id}-row.md';
		const result = await run(app, moved, data([{ family: 'ZZ', id: 'ZZ' }]), 'replace', { id: setId });
		expect(result.errors.map((error: any) => error.message).join(' ')).toContain('Duplicate identity');
		expect(files.get(path)).toBe(original);
		expect(files.has(`${base}/ZZ/ZZ-row.md`)).toBe(false);
	});
	it('row takeover does not re-adopt its former implied identity as a hub when the flag is removed', async () => {
		const { app, files } = vault();
		await run(app, recipe(true, true), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const result = await run(app, recipe(false, true), data([
			{ family: 'ZZ', id: 'ZZ' }, { family: 'ZZ', id: 'ZZ-1' },
		]), 'replace', { id: setId });
		expect(result.errors).toEqual([]);
		expect(result.orphans ?? []).toEqual([]);
		expect(fm(files.get(path)!).curie).toBe('synthetic:ZZ');
		expect(fm(files.get(path)!).kind).toBeUndefined();
		expect(fm(files.get(path)!).implied_level).toBeUndefined();
	});
	it('wizard generation also transitions an implied concept to a row at its recorded identity', async () => {
		const { app, files } = vault();
		await run(app, recipe(true, true), data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const config = { name: 'synthetic-implied', mapping: {
			hierarchy: [], frontmatter: [], links: [], body: [],
			filename: { template: '{id}.md', sanitize: true },
		} };
		const result = await generateNotes(app, data([{ family: 'ZZ', id: 'ZZ' }, { family: 'ZZ', id: 'ZZ-1' }]),
			config as any, { basePath: base, createFolders: true, overwriteMode: 'replace',
				sourceFileName: 'synthetic.csv', importSet: { id: setId }, recipeOverride: recipe(true, true) });
		expect(result.errors).toEqual([]);
		expect(result.conflicts ?? []).toEqual([]);
		expect(result.orphans ?? []).toEqual([]);
		expect(fm(files.get(path)!).curie).toBe('synthetic:ZZ');
		expect(fm(files.get(path)!).implied_level).toBeUndefined();
	});
	it('A8: top-level refresh orphans enhancements but keeps implied families and their direct children', async () => {
		const { app, files } = vault();
		const rows = [
			{ identifier: 'ZZ-1', name: 'Invented control', control_text: 'Invented text', discussion: '', related: '' },
			{ identifier: 'ZZ-1(1)', name: 'Invented enhancement', control_text: 'Invented enhancement text', discussion: '', related: '' },
			{ identifier: 'YY-1', name: 'Invented second control', control_text: 'Invented text', discussion: '', related: '' },
		];
		const parsed: ParsedData = { columns: Object.keys(rows[0]), rows, rowCount: rows.length };
		const options = (importSet: any, overwriteMode: 'replace' | 'skip') => ({
			basePath: base, createFolders: true, overwriteMode, importSet,
			curieLocalPart: (row: Record<string, unknown>) => String(row.identifier),
		});
		const maximal = await generateFromRecipe(app, parsed, nistNested as Recipe, options('new', 'replace'));
		expect(maximal.errors).toEqual([]);
		const families = [`${base}/ZZ/ZZ.md`, `${base}/YY/YY.md`];
		const before = families.map((path) => [path, fm(files.get(path)!).children] as const);
		const setId = fm(files.get(families[0])!)._crosswalker.import_set.id;
		const topLevels = {
			...(nistNested as Recipe),
			source: { ...(nistNested as Recipe).source, where: '$not($contains(identifier, "("))' },
		};
		for (const mode of ['replace', 'skip'] as const) {
			const result = await generateFromRecipe(app, parsed, topLevels, options({ id: setId }, mode));
			expect(result.errors).toEqual([]);
			expect(result.orphansChecked).toBe(true);
			expect(result.orphans?.map((orphan: any) => orphan.curie)).toContain('nist-800-53:ZZ-1(1)');
			expect(result.orphans?.filter((orphan: any) => ['nist-800-53:ZZ', 'nist-800-53:YY'].includes(orphan.curie))).toEqual([]);
			for (const [path, children] of before) {
				expect(files.has(path)).toBe(true);
				expect(fm(files.get(path)!).children).toEqual(children);
			}
		}
	});
	it('A5: row-hosted CRI levels produce no implied notes or extra files when flagged', async () => {
		const source = criNested as Recipe;
		const flagged: Recipe = {
			...source,
			target: { ...source.target, layout: source.target.layout.map((entry) =>
				['function', 'category'].includes(entry.level) ? { ...entry, implied_concept: true } : { ...entry }) },
		};
		const ids = [
			['GV', 'F'], ['GV.OC', 'C'], ['GV.OC-01', 'S'], ['GV.OC-01.01', 'DS'],
		] as const;
		const rows = ids.map(([id, Level]) => ({
			'Profile Id': id, Level, 'Outline Id': id,
			'CRI Profile Function / Category / Subcategory': 'Invented / Category / Subcategory',
			'CRI Profile v2.2 Diagnostic Statement': 'Invented statement',
			'NIST CSF v2 Mapping': '', 'Tier-1': '', 'Tier-2': '', 'Tier-3': '', 'Tier-4': '',
		}));
		const parsed: ParsedData = { columns: Object.keys(rows[0]), rows, rowCount: rows.length };
		const bareVault = vault();
		const flaggedVault = vault();
		const options = { basePath: base, createFolders: true, overwriteMode: 'replace' as const,
			importSet: 'new' as const, curieLocalPart: (row: Record<string, unknown>) => String(row['Profile Id']) };
		const bare = await generateFromRecipe(bareVault.app, parsed, source, options);
		const withFlag = await generateFromRecipe(flaggedVault.app, parsed, flagged, options);
		expect(bare.errors).toEqual([]);
		expect(withFlag.errors).toEqual([]);
		expect([...flaggedVault.files.keys()].sort()).toEqual([...bareVault.files.keys()].sort());
		expect([...flaggedVault.files.values()].filter((text) => fm(text).implied_level !== undefined)).toEqual([]);
		expect(flaggedVault.files.size).toBe(bareVault.files.size);
		for (const text of flaggedVault.files.values()) {
			expect(fm(text).curie).toBeDefined();
		}
	});
	it('A13: real SSSOM import links a family-level mapping endpoint to its implied note', async () => {
		const { app, files } = vault();
		const parsed: ParsedData = {
			columns: ['identifier', 'name', 'control_text', 'discussion', 'related'],
			rows: [{ identifier: 'ZZ-1', name: 'Invented control', control_text: 'Invented text', discussion: '', related: '' }],
			rowCount: 1,
		};
		const framework = await generateFromRecipe(app, parsed, nistNested as Recipe, {
			basePath: 'Frameworks/Invented NIST', overwriteMode: 'replace', createFolders: true,
			importSet: 'new', curieLocalPart: (row) => String(row.identifier),
		});
		expect(framework.errors).toEqual([]);
		const family = 'Frameworks/Invented NIST/ZZ/ZZ.md';
		expect(fm(files.get(family)!).curie).toBe('nist-800-53:ZZ');
		const csfRecipe: Recipe = { recipe: 'synthetic-csf', source: { ontology: 'nist-csf-2', levels: ['outcome'] },
			target: { layout: [{ level: 'outcome', mechanism: 'file', template: '{id}.md' }] } };
		const outcome = await generateFromRecipe(app, {
			columns: ['id'], rows: [{ id: 'GV.OC-01' }], rowCount: 1,
		}, csfRecipe, { basePath: 'Frameworks/Invented CSF', overwriteMode: 'replace', createFolders: true,
			importSet: 'new', curieLocalPart: (row) => String(row.id) });
		expect(outcome.errors).toEqual([]);
		const mapping = await importSssom(app,
			'subject_id\tpredicate_id\tobject_id\tmapping_justification\n' +
			'nist-csf-2:GV.OC-01\tskos:exactMatch\tnist-800-53:ZZ\tInvented mapping',
			null, null, { runTier2Projection: false, overwriteMode: 'replace' });
		expect(mapping.parse.errors).toEqual([]);
		expect(mapping.generation?.errors).toEqual([]);
		expect(mapping.generation?.created).toHaveLength(1);
		expect(mapping.unresolved).toEqual([]);
		const edge = fm(files.get(mapping.generation!.created[0])!);
		expect(edge.object_id).toBe('nist-800-53:ZZ');
		expect(edge.object_note).toBe('[[Frameworks/Invented NIST/ZZ/ZZ|ZZ]]');
		expect(edge.subject_note).toBe('[[Frameworks/Invented CSF/GV.OC-01|GV.OC-01]]');
	});
	it('keeps a middle concept parent and parent_curie while updating its children without an implied level', async () => {
		const { app, files } = vault();
		const chain: Recipe = { recipe: 'synthetic-parent-chain', source: { ontology: 'synthetic', levels: ['concept'] },
			target: {
				layout: [{ level: 'concept', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed: { parent_curie: '{parent_curie}' },
					managed_links: { parent: { template: '{parent_id}' } } } },
				enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling' },
			} };
		const rows = [
			{ id: 'ROOT', parent_id: '', parent_curie: '' },
			{ id: 'MID', parent_id: 'ROOT', parent_curie: 'synthetic:ROOT' },
			{ id: 'LEAF', parent_id: 'MID', parent_curie: 'synthetic:MID' },
		];
		const result = await generateFromRecipe(app,
			{ columns: Object.keys(rows[0]), rows, rowCount: rows.length }, chain,
			{ basePath: base, overwriteMode: 'replace', createFolders: true,
				importSet: 'new', curieLocalPart: (row) => String(row.id), strictValidation: false });
		expect(result.errors).toEqual([]);
		const middle = fm(files.get(`${base}/MID.md`)!);
		expect(middle.children).toEqual(['[[LEAF]]']);
		expect(middle.parent).toEqual(['[[ROOT]]']);
		expect(middle.parent_curie).toBe('synthetic:ROOT');
		expect(middle._crosswalker_managed_keys).toBeUndefined();
		const setId = middle._crosswalker.import_set.id;
		const refreshed = await generateFromRecipe(app,
			{ columns: Object.keys(rows[0]), rows, rowCount: rows.length }, chain,
			{ basePath: base, overwriteMode: 'replace', createFolders: true,
				importSet: { id: setId }, curieLocalPart: (row) => String(row.id), strictValidation: false });
		expect(refreshed.errors).toEqual([]);
		expect(fm(files.get(`${base}/MID.md`)!).parent).toEqual(['[[ROOT]]']);
		expect(fm(files.get(`${base}/MID.md`)!).parent_curie).toBe('synthetic:ROOT');
		expect(fm(files.get(`${base}/MID.md`)!)._crosswalker_managed_keys).toBeUndefined();
	});
	it('A21: unflagged, unenriched import retains its complete byte output', async () => {
		const { app, files } = vault();
		const rec = recipe(false);
		expect(rec.target.enrichment).toBeUndefined();
		expect(rec.target.layout.every((entry) => entry.implied_concept === undefined)).toBe(true);
		const generated = await run(app, rec, data([{ family: 'ZZ', id: 'ZZ-1' }]), 'replace', 'new');
		expect(generated.errors).toEqual([]);
		// Normalize only nondeterministic mint/time fields; snapshot retains every
		// file path and every other byte, including frontmatter ordering and body.
		const output = [...files.entries()].sort(([a], [b]) => a.localeCompare(b))
			.map(([path, content]) => [path, content
				.replace(/iset-[a-z0-9]{6}/g, '<set-id>')
				.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<timestamp>')]);
		expect(output).toMatchSnapshot();
	});
	it('adopts a pre-feature hub on Replace without losing prose', async () => {
		const { app, files } = vault();
		await run(app, recipe(false, true), data(), 'replace', 'new');
		const path = `${base}/ZZ/ZZ.md`;
		expect(fm(files.get(path)!).kind).toBe('hub');
		files.set(path, files.get(path)! + '\nUser prose.\n');
		const setId = fm(files.get(path)!)._crosswalker.import_set.id;
		const refreshed = await run(app, recipe(true, true), data(), 'replace', { id: setId });
		expect(refreshed.errors).toEqual([]);
		expect(fm(files.get(path)!).curie).toBe('synthetic:ZZ');
		expect(fm(files.get(path)!).kind).toBeUndefined();
		expect(fm(files.get(path)!).hub_values).toBeUndefined();
		expect(files.get(path)).toContain('User prose.');
		expect(refreshed.orphans ?? []).toEqual([]);
	});
});
