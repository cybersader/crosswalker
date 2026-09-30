import type { DiscoveredImportSet } from '../src/generation/import-set';
import { importMappingSlots, mappingCompletionText, reconnectMappings, waitForIndexedDestination, type MappingRunDependencies, type CompletedMapping } from '../src/import/stack/stack-run';
import { MAPPING_PRESETS } from '../src/import/recipe-registry';
import { readCtidJson } from '../src/import/stack/mapping-readers';
import { planStack } from '../src/import/stack/stack-plan';
import { summarizeUnresolvedEndpoints, type UnresolvedEndpoint } from '../src/generation/edge-endpoints';
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
	const source = JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
		{ capability_id: 'AC-01', attack_object_id: 'T1234', mapping_type: 'mitigates' },
		{ capability_id: 'AC-01', attack_object_id: 'T1234', mapping_type: 'mitigates' },
	] });
	const parsed = readCtidJson(source, 'nist-800-53');
	const plan = planStack({ slots: [], mappings: [{ id: mapping.id, label: mapping.label,
		root: '_crosswalker/mappings/nist-800-53-to-mitre-attack', mode: 'new', form: 'notes', notes: { count: parsed.rows.length, exact: true } }] });
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => sets,
		readBytes: async () => Buffer.from(source),
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
	expect(plan.mappings[0].notes.exact).toBe(true);
	expect(plan.mappings[0].notes.count).toBe(completed[0].noteCount);
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

// Slice 3 of the mapping table form. Synthetic ids only.
const TABLE_ROOT = '_crosswalker/mappings/nist-800-53-to-mitre-attack';
const tableSet = (id: string, rowCount: number): DiscoveredImportSet => ({ ...set(id, 0), mapping_form: 'table', rowCount,
	paths: [`${TABLE_ROOT}/nist-800-53-to-mitre-attack.mapping-table.tsv`] });
const tableOutcome = (rows: number, extra: Record<string, number> = {}) => ({
	generation: { success: true, created: [], upToDate: [], skipped: [], errors: [], duration: 0, orphansChecked: false },
	folder: TABLE_ROOT, summary: [], unresolved: [], parse: { header: {}, rows: [], warnings: [], errors: [] },
	source: 'nist-800-53', target: 'mitre-attack', mappingForm: 'table' as const,
	tablePath: `${TABLE_ROOT}/nist-800-53-to-mitre-attack.mapping-table.tsv`, rowsWritten: rows, ...extra,
});
const syntheticCtid = () => Buffer.from(JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
	{ capability_id: 'ZZ-01', attack_object_id: 'T9001', mapping_type: 'mitigates' },
	{ capability_id: 'ZZ-02', attack_object_id: 'T9002', mapping_type: 'mitigates' },
] }));

it('imports a CTID mapping as a new table set and records rows, not notes', async () => {
	let sets: DiscoveredImportSet[] = [];
	const forms: Array<string | undefined> = [];
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => sets, readBytes: async () => syntheticCtid(),
		importRows: async (_tsv, options) => {
			forms.push(options.mappingForm);
			expect(options.importSet).toBe('new-set-qualified');
			sets = [tableSet('iset-tbl001', 2)];
			return tableOutcome(2);
		},
	};
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/synthetic.json', name: 'synthetic.json' } as TFile;
	const completed = await importMappingSlots([mapping], [{ source: { path: file.path, name: file.name, peeks: [] }, mapping,
		table: '$.mapping_objects[*]', headerRow: 0 }], new Map([[file.path, file]]), dependencies, [],
	new Map([[mapping.id, { mode: 'new' as const, form: 'table' as const }]]));
	expect(forms).toEqual(['table']);
	expect(completed).toMatchObject([{ setId: 'iset-tbl001', form: 'table', noteCount: 0, rowCount: 2, upToDate: 0 }]);
	expect(completed[0].reviewCarried).toBeUndefined();
});

it('routes a table-set refresh with the table form and reports reviews carried and rows dropped', async () => {
	const forms: Array<string | undefined> = [];
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => [tableSet('iset-tbl002', 2)], readBytes: async () => syntheticCtid(),
		importRows: async (_tsv, options) => {
			forms.push(options.mappingForm);
			expect(options).toMatchObject({ importSet: { id: 'iset-tbl002' }, outputFolder: TABLE_ROOT, overwriteMode: 'replace' });
			return tableOutcome(2, { reviewCarried: 1, rowsDropped: 1 });
		},
	};
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/synthetic.json', name: 'synthetic.json' } as TFile;
	const completed = await importMappingSlots([mapping], [{ source: { path: file.path, name: file.name, peeks: [] }, mapping,
		table: '$.mapping_objects[*]', headerRow: 0 }], new Map([[file.path, file]]), dependencies, [],
	new Map([[mapping.id, { mode: 'refresh' as const, setId: 'iset-tbl002', folder: TABLE_ROOT, form: 'table' as const }]]));
	expect(completed).toMatchObject([{ setId: 'iset-tbl002', form: 'table', rowCount: 2, reviewCarried: 1, rowsDropped: 1 }]);
	// Reconnect reads the form from the discovered set, not from the record.
	await reconnectMappings([{ ...completed[0], form: undefined }], dependencies);
	expect(forms).toEqual(['table', 'table']);
});

it('surfaces the importer refusal when a table run is refused', async () => {
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), listSets: async () => [], readBytes: async () => syntheticCtid(),
		importRows: async () => ({ ...tableOutcome(0), generation: { success: false, created: [], upToDate: [], skipped: [],
			errors: [{ row: -1, message: 'Import set iset-tbl003 stores its mappings as notes. Convert the set instead of refreshing it as a table.' }],
			duration: 0, orphansChecked: false } }),
	};
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/synthetic.json', name: 'synthetic.json' } as TFile;
	await expect(importMappingSlots([mapping], [{ source: { path: file.path, name: file.name, peeks: [] }, mapping,
		table: '$.mapping_objects[*]', headerRow: 0 }], new Map([[file.path, file]]), dependencies, [],
	new Map([[mapping.id, { mode: 'refresh' as const, setId: 'iset-tbl003', folder: TABLE_ROOT, form: 'table' as const }]])))
		.rejects.toThrow('stores its mappings as notes. Convert the set');
});

it('says a table kept its unlinked rows instead of claiming edge notes were kept', () => {
	const endpoints: UnresolvedEndpoint[] = [{ curie: 'zz-onto:ZZ-1', cause: 'not in vault' } as UnresolvedEndpoint];
	expect(summarizeUnresolvedEndpoints(endpoints)[0]).toBe('1 mapping endpoint could not link to concepts in this vault. The edge notes were kept.');
	expect(summarizeUnresolvedEndpoints(endpoints, 0, 'table')[0]).toBe('1 mapping endpoint could not link to concepts in this vault. Their rows were kept in the mapping table.');
});

it('reports only tables written when every separately imported mapping set is a table', () => {
	const base = { label: 'Invented', folder: 'zz', unresolved: [], tsv: '' };
	const table: CompletedMapping = { ...base, id: 'map-t', setId: 'iset-t', noteCount: 0, form: 'table', rowCount: 12 };
	const notes: CompletedMapping = { ...base, id: 'map-n', setId: 'iset-n', noteCount: 5, upToDate: 2, form: 'notes' };
	expect(mappingCompletionText([table, { ...table, id: 'map-t2' }])).toBe('2 mapping tables written. ');
	expect(mappingCompletionText([table, notes])).toBe('3 separately imported mapping notes created or updated; 2 separately imported mapping notes already up to date. 1 mapping table written. ');
	expect(mappingCompletionText([{ ...notes, form: undefined }])).toBe('3 separately imported mapping notes created or updated; 2 separately imported mapping notes already up to date. ');
});
