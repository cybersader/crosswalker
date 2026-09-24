import type { DiscoveredImportSet } from '../src/generation/import-set';
import { importMappingSlots, reconnectMappings, waitForIndexedDestination, type MappingRunDependencies, type CompletedMapping } from '../src/import/stack/stack-run';
import { MAPPING_PRESETS } from '../src/import/recipe-registry';
import type { App, TFile } from 'obsidian';
import { TextDecoder } from 'node:util';
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, configurable: true });

const set = (id: string, noteCount: number): DiscoveredImportSet => ({ id, noteCount, root: '_crosswalker/mappings/nist-800-53-to-mitre-attack',
	paths: [], sources: [], recipeIds: [], ontologyPrefixes: [], scheme: 'endpoint-v1' });

it('imports a CTID mapping as a new set and explicitly reconnects only its stored set id', async () => {
	let sets: DiscoveredImportSet[] = [];
	const calls: Array<{ id: string | 'new-set-qualified'; root: string | undefined }> = [];
	const logs: string[] = [];
	const dependencies: MappingRunDependencies = {
		log: (stage, slot) => logs.push(`${stage}:${slot}`),
		listSets: async () => sets,
		readBytes: async () => Buffer.from(JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
			{ capability_id: 'AC-01', attack_object_id: 'T1234', mapping_type: 'mitigates' },
		] })),
		importRows: async (tsv, options) => {
			calls.push({ id: options.importSet === 'new-set-qualified' ? 'new-set-qualified' : options.importSet.id, root: options.outputFolder });
			if (options.importSet === 'new-set-qualified') sets = [set('iset-abcdef', 1)];
			expect(tsv).toContain('nist-800-53:AC-1\tskos:relatedMatch\tmitre-attack:T1234');
			return { generation: { success: true, created: ['edge.md'], skipped: [], errors: [] }, folder: '_crosswalker/mappings/nist-800-53-to-mitre-attack', summary: [], unresolved: [], parse: { header: {}, rows: [], warnings: [], errors: [] }, source: 'nist-800-53', target: 'mitre-attack' };
		},
	};
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/ctid.json', name: 'ctid.json' } as TFile;
	const candidates = [{ source: { path: file.path, name: file.name, peeks: [] }, mapping, table: '$.mapping_objects[*]', headerRow: 0 }];
	const completed = await importMappingSlots([mapping], candidates, new Map([[file.path, file]]), dependencies);
	expect(completed.map((item) => item.setId)).toEqual(['iset-abcdef']);
	expect(logs).toEqual(['mapping:80053-attack']);
	await reconnectMappings(completed, dependencies);
	expect(calls).toEqual([{ id: 'new-set-qualified', root: undefined }, { id: 'iset-abcdef', root: '_crosswalker/mappings/nist-800-53-to-mitre-attack' }]);
	sets = [];
	await expect(reconnectMappings(completed, dependencies)).rejects.toThrow('no longer available');
	expect(calls).toHaveLength(2);
});

it('records a successful mapping set and reports exact duplicate source rows', async () => {
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/synthetic.json', name: 'synthetic.json' } as TFile;
	let sets: DiscoveredImportSet[] = [];
	const records: CompletedMapping[] = [];
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => sets,
		readBytes: async () => Buffer.from(JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
			{ capability_id: 'AC-01', attack_object_id: 'T1234', mapping_type: 'mitigates' },
			{ capability_id: 'AC-01', attack_object_id: 'T1234', mapping_type: 'mitigates' },
		] })),
		importRows: async (tsv) => {
			expect(tsv.split('\n').filter((line) => line.startsWith('nist-800-53:'))).toHaveLength(1);
			sets = [set('iset-deduped', 1)];
			return { generation: { success: true, created: ['edge.md'], skipped: [], errors: [] },
				folder: '_crosswalker/mappings/nist-800-53-to-mitre-attack', summary: [], unresolved: [],
				parse: { header: {}, rows: [], warnings: [], errors: [] }, source: 'nist-800-53', target: 'mitre-attack' };
		},
		onCompleted: (record) => { records.push(record); },
	};
	const completed = await importMappingSlots([mapping], [{ source: { path: file.path, name: file.name, peeks: [] }, mapping,
		table: '$.mapping_objects[*]', headerRow: 0 }], new Map([[file.path, file]]), dependencies);
	expect(completed).toMatchObject([{ setId: 'iset-deduped', duplicateRowsSkipped: 1, noteCount: 1 }]);
	expect(records).toEqual(completed);
});

it('checkpoints each confirmed mapping set so a later failed slot cannot duplicate it on retry', async () => {
	let sets: DiscoveredImportSet[] = [];
	const records: CompletedMapping[] = [];
	const imported: string[] = [];
	const mappings = MAPPING_PRESETS.filter((item) => item.id === '80053-attack' || item.id === 'cri-80053');
	const file = { path: 'Sources/ctid.json', name: 'ctid.json' } as TFile;
	const candidates = [{ source: { path: file.path, name: file.name, peeks: [] }, mapping: mappings[0], table: '$.mapping_objects[*]', headerRow: 0 }];
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => sets,
		readBytes: async () => Buffer.from(JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
			{ capability_id: 'ZZ-01', attack_object_id: 'T9999', mapping_type: 'mitigates' },
		] })),
		importRows: async (_tsv, options) => {
			imported.push(String(options.importSet));
			sets = [set('iset-first', 1)];
			return { generation: { success: true, created: ['edge.md'], skipped: [], errors: [] },
				folder: '_crosswalker/mappings/nist-800-53-to-mitre-attack', summary: [], unresolved: [],
				parse: { header: {}, rows: [], warnings: [], errors: [] }, source: 'nist-800-53', target: 'mitre-attack' };
		},
		onCompleted: (record) => { records.push(record); },
	};
	await expect(importMappingSlots(mappings, candidates, new Map([[file.path, file]]), dependencies, records))
		.rejects.toThrow('no recognized source file');
	expect(records.map((item) => item.setId)).toEqual(['iset-first']);
	await expect(importMappingSlots(mappings, candidates, new Map([[file.path, file]]), dependencies, records))
		.rejects.toThrow('no recognized source file');
	expect(imported).toHaveLength(1);
});

it('waits for every note written to a framework destination, not one resolved event', async () => {
	const notes = [{ path: 'Frameworks/Invented/ZZ/ZZ.md' }, { path: 'Frameworks/Invented/ZZ/ZZ-1.md' }, { path: 'Other/Cold.md' }];
	const cache = new Set([notes[0].path]);
	const app = {
		vault: { getMarkdownFiles: () => notes },
		metadataCache: { getFileCache: (file: { path: string }) => cache.has(file.path) ? {} : null },
	} as unknown as App;
	setTimeout(() => cache.add(notes[1].path), 20);
	await expect(waitForIndexedDestination(app, 'Frameworks/Invented', 300)).resolves.toBe(0);
	// The cold note in another destination is still cold; only the slot's
	// freshly written notes are the wait's responsibility.
	await expect(waitForIndexedDestination(app, 'Other', 20)).resolves.toBe(1);
});

it('skips an unscoped index wait instead of polling an unrelated vault root', async () => {
	const app = {
		vault: { getMarkdownFiles: jest.fn(() => [{ path: 'Cold.md' }]) },
		metadataCache: { getFileCache: jest.fn(() => null) },
	} as unknown as App;
	await expect(waitForIndexedDestination(app, ' ', 5)).resolves.toBe(0);
	expect(app.vault.getMarkdownFiles).not.toHaveBeenCalled();
});

it('does not silently skip a missing required mapping file', async () => {
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const dependencies: MappingRunDependencies = { log: jest.fn(), listSets: async () => [], readBytes: jest.fn(), importRows: jest.fn() };
	await expect(importMappingSlots([mapping], [], new Map(), dependencies)).rejects.toThrow('no recognized source file');
	expect(dependencies.importRows).not.toHaveBeenCalled();
});
