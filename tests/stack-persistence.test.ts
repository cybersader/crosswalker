import type { DiscoveredImportSet } from '../src/generation/import-set';
import { TextDecoder } from 'node:util';
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, configurable: true });
import { MAPPING_PRESETS } from '../src/import/recipe-registry';
import { DEFAULT_STACK_SELECTION, frameworkSlots, stackRecipeHash } from '../src/import/stack/stack-model';
import { checkpointFrameworkOutcome, deleteStackRecord, fromDefinition, importStackDefinition, mappingKey, normalizeStackRuns,
	normalizeStacks, replaceStackDefinition, slotRunChoices, toDefinition, type SlotRunFact } from '../src/import/stack/stack-persistence';
import { refreshRootProblem } from '../src/import/import-wizard';
import { stackSlotRows } from '../src/import/stack/installed-stacks';
import { importMappingSlots, type MappingRunDependencies } from '../src/import/stack/stack-run';

const selection = { ...DEFAULT_STACK_SELECTION, chosen: ['cri-profile', 'nist-800-53'], optionalMappings: [] };
const stack = toDefinition(selection, 'stack-abc123', 'Invented stack', '2026-09-23T00:00:00Z');
const fact: SlotRunFact = { importSetId: 'iset-synthetic', sourceDigest: 'source-a', recipeDigest: 'recipe-a', sourceName: 'invented.csv' };
const run = { stackId: stack.id, finishedAt: '2026-09-23T01:00:00Z', detail: stack.detail,
	slotSets: { [stack.slots[0].presetId]: fact }, mappingSets: {} };

it('round trips definitions separately from run facts, reminting imported identity', () => {
	expect(normalizeStacks([stack, { ...stack, id: 'bad' }])).toEqual([stack]);
	expect(normalizeStackRuns([run, { ...run, stackId: 'stack-missing' }], [stack])).toEqual([run]);
	expect(toDefinition(fromDefinition(stack), stack.id, stack.label, stack.createdAt)).toEqual(stack);
	const imported = importStackDefinition(JSON.stringify(stack), [stack], () => 0.5);
	expect(imported.id).not.toBe(stack.id);
	expect({ ...imported, id: stack.id, createdAt: stack.createdAt }).toEqual(stack);
	expect(imported).not.toHaveProperty('slotSets');
	expect(() => importStackDefinition('{bad', [])).toThrow('JSON syntax');
	expect(() => importStackDefinition(JSON.stringify({ ...stack, slots: [] }), [])).toThrow('invalid slots');
});

it('deletes settings records only without touching a mock vault or discovered sets', () => {
	const vault = { modify: jest.fn(), delete: jest.fn(), getMarkdownFiles: jest.fn() };
	const discovered = [{ id: fact.importSetId }];
	const result = deleteStackRecord([stack], [run], stack.id);
	expect(result).toEqual({ stacks: [], stackRuns: [] });
	expect(discovered).toEqual([{ id: fact.importSetId }]);
	expect(vault.modify).not.toHaveBeenCalled();
	expect(vault.delete).not.toHaveBeenCalled();
	expect(vault.getMarkdownFiles).not.toHaveBeenCalled();
});

it('preselects skip only for unchanged facts and offers refresh only with the same recipe', () => {
	expect(slotRunChoices(fact, true, 'source-a', 'recipe-a')).toEqual({ choices: ['skip', 'refresh', 'new'], selected: 'skip' });
	expect(slotRunChoices(fact, true, 'source-b', 'recipe-a')).toEqual({ choices: ['refresh', 'new'], selected: 'new' });
	expect(slotRunChoices(fact, true, 'source-a', 'recipe-b').choices).toEqual(['new']);
	expect(slotRunChoices(fact, false, 'source-a', 'recipe-a').message).toBe('Set iset-synthetic is no longer in this vault. Import as a new set.');
	expect(slotRunChoices(fact, true, undefined, 'recipe-a')).toEqual({ choices: ['skip'], selected: 'skip', message: 'Kept as imported. Drop the file again to refresh.' });
	const chosen = frameworkSlots(selection).find((item) => item.ontology === 'cri-profile')!;
	expect(stackRecipeHash(chosen, 'max')).not.toBe(stackRecipeHash(chosen, 'top-levels'));
});

it('rejects refresh without a single stored root using the wizard reason', () => {
	const reason = refreshRootProblem({ root: null });
	expect(reason).toContain('notes are spread across more than one folder');
	expect(refreshRootProblem({ root: 'Frameworks/Synthetic' })).toBeNull();
	expect(slotRunChoices(fact, true, 'source-b', 'recipe-a', reason)).toEqual({
		choices: ['new'], selected: 'new', message: reason,
	});
});

it('drops only stale or malformed fact keys and prunes removed slots without moving the stack', () => {
	const another = { ...stack, id: 'stack-zzzzzz', label: 'Other stack' };
	const corrupted = { ...run, slotSets: { ...run.slotSets, obsolete: fact, [stack.slots[1].presetId]: { sourceDigest: 'partial' } },
		mappingSets: { obsolete: fact } };
	const normalized = normalizeStackRuns([corrupted], [stack]);
	expect(normalized).toEqual([run]);
	const next = { ...stack, slots: stack.slots.filter((slot) => slot.presetId !== stack.slots[0].presetId), label: 'Renamed' };
	const replaced = replaceStackDefinition([stack, another], [run], next);
	expect(replaced.stacks.map((item) => item.id)).toEqual([stack.id, another.id]);
	expect(replaced.stacks[0].label).toBe('Renamed');
	expect(replaced.stackRuns[0].slotSets).toEqual({});
});

it('checkpoints the first confirmed framework fact before a second slot fails', async () => {
	const facts: Record<string, SlotRunFact> = {};
	const outcomes = [{ ok: true, importSetId: 'iset-first' }, { ok: false, importSetId: null }];
	for (const [index, outcome] of outcomes.entries()) {
		if (!outcome.ok) break;
		await checkpointFrameworkOutcome(outcome, `source-${index}`, 'recipe-a', 'invented.csv', async (saved) => {
			await Promise.resolve(); facts[`slot-${index}`] = saved;
		});
	}
	expect(facts).toEqual({ 'slot-0': { importSetId: 'iset-first', sourceDigest: 'source-0',
		recipeDigest: 'recipe-a', sourceName: 'invented.csv' } });
	expect(await checkpointFrameworkOutcome(outcomes[1], 'source-1', 'recipe-a', 'invented.csv',
		async () => { throw new Error('Failed slot cannot save a fact'); })).toBe(false);
});

it('refreshes only the explicitly chosen mapping set and checkpoints its fact', async () => {
	const mapping = MAPPING_PRESETS.find((item) => item.id === '80053-attack')!;
	const file = { path: 'Sources/invented-mapping.json', name: 'invented-mapping.json' };
	const target = '_crosswalker/mappings/nist-800-53-to-mitre-attack';
	const calls: Array<{ id: string; folder?: string }> = [];
	const checkpoints: string[] = [];
	const dependencies: MappingRunDependencies = {
		log: jest.fn(), readBytes: async () => Buffer.from(JSON.stringify({ metadata: { attack_version: '16.1' },
			mapping_objects: [{ capability_id: 'ZZ-01', attack_object_id: 'T9999', mapping_type: 'mitigates' }] })),
		listSets: async () => [{ id: 'iset-stored', root: target, noteCount: 1, paths: [], sources: [],
			recipeIds: [], ontologyPrefixes: [], scheme: 'endpoint-v1' }],
		importRows: async (_tsv, options) => {
			calls.push({ id: typeof options.importSet === 'string' ? options.importSet : options.importSet.id,
				folder: options.outputFolder });
			return { generation: { success: true, created: ['edge.md'], skipped: [], errors: [] },
				folder: target, source: 'nist-800-53', target: 'mitre-attack', unresolved: [], summary: [],
				parse: { header: {}, rows: [], warnings: [], errors: [] } };
		},
		onCompleted: async (item) => { checkpoints.push(item.setId); },
	};
	const candidate = { mapping, source: { path: file.path, name: file.name, peeks: [] },
		table: '$.mapping_objects[*]', headerRow: 0 };
	const result = await importMappingSlots([mapping], [candidate], new Map([[file.path, file as never]]),
		dependencies, [], new Map([[mapping.id, { mode: 'refresh', setId: 'iset-stored', folder: target }]]));
	expect(calls).toEqual([{ id: 'iset-stored', folder: target }]);
	expect(result[0].setId).toBe('iset-stored');
	expect(checkpoints).toEqual(['iset-stored']);
});

it('renders stored-id states, and a from-slot mapping has no fact or independent choice', async () => {
	const fromSlot = MAPPING_PRESETS.find((item) => item.kind === 'from-slot')!;
	const key = mappingKey(fromSlot);
	expect(run.mappingSets).not.toHaveProperty(key);
	const known = new Map([[fact.importSetId, { id: fact.importSetId, noteCount: 3 } as DiscoveredImportSet]]);
	const rows = stackSlotRows(stack, run, known);
	expect(rows.find((row) => row.label === fromSlot.label)?.state).toMatch(/^Comes with .*\. Not tracked separately\.$/);
	expect(rows.find((row) => row.label === fromSlot.label)?.state).not.toContain('Refresh');
	expect(rows.some((row) => row.state === 'set iset-synthetic, 3 notes')).toBe(true);
	expect(rows.some((row) => row.state === 'Not imported yet')).toBe(true);
	expect(stackSlotRows(stack, run, new Map()).some((row) =>
		row.state === 'Set iset-synthetic is no longer in this vault. Import as a new set.')).toBe(true);
	const dependencies: MappingRunDependencies = { log: jest.fn(), listSets: jest.fn(async () => []),
		readBytes: jest.fn(), importRows: jest.fn() };
	expect(await importMappingSlots([fromSlot], [], new Map(), dependencies,
		[], new Map([[fromSlot.id, { mode: 'refresh', setId: fact.importSetId }]]))).toEqual([]);
	expect(dependencies.importRows).not.toHaveBeenCalled();
});
