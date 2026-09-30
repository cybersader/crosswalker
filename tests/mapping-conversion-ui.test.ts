import type { DiscoveredImportSet } from '../src/generation/import-set';
import { TextDecoder } from 'node:util';
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, configurable: true });
import { MAPPING_TABLE_TRADE_OFF } from '../src/import/mapping-form-choice';
import { MAPPING_PRESETS } from '../src/import/recipe-registry';
import { DEFAULT_STACK_SELECTION } from '../src/import/stack/stack-model';
import { mappingKey, toDefinition, type SlotRunFact } from '../src/import/stack/stack-persistence';
import { stackSlotRows } from '../src/import/stack/installed-stacks';
import {
	conversionCanCancel,
	conversionConfirmLines,
	conversionNeedsConfirmation,
	conversionProgressText,
	conversionResultText,
	conversionSetLabel,
	conversionStateText,
	conversionTargetOf,
	convertButtonLabel,
} from '../src/import/stack/mapping-conversion-ui';
import type { ConversionResult } from '../src/mappings/mapping-conversion';

const notesSet = { id: 'iset-conv01', mapping_form: 'notes', noteCount: 12, rowCount: 0, root: 'Invented/mappings' } as DiscoveredImportSet;
const tableSet = { id: 'iset-conv02', mapping_form: 'table', noteCount: 0, rowCount: 1500, root: 'Invented/mappings' } as DiscoveredImportSet;

it('offers the other form, and names the confirmation facts for each direction', () => {
	expect(conversionTargetOf(notesSet)).toBe('table');
	expect(conversionTargetOf(tableSet)).toBe('notes');
	expect(convertButtonLabel('table')).toBe('Convert to table');
	expect(convertButtonLabel('notes')).toBe('Convert to notes');
	expect(conversionConfirmLines(notesSet, 'table')).toEqual([
		MAPPING_TABLE_TRADE_OFF,
		'Moves 12 notes to the trash after the table is verified.',
	]);
	expect(conversionConfirmLines(tableSet, 'notes')[0]).toBe('Writes 1,500 notes in Invented/mappings.');
	expect(conversionConfirmLines({ ...tableSet, root: '' }, 'notes')[0]).toBe('Writes 1,500 notes in the vault root.');
	for (const line of [...conversionConfirmLines(notesSet, 'table'), ...conversionConfirmLines(tableSet, 'notes')]) {
		expect(line).not.toContain('—');
	}
});

it('always confirms a conversion to a table and applies the stack threshold to notes', () => {
	expect(conversionNeedsConfirmation(notesSet, 'table', 1000)).toBe(true);
	expect(conversionNeedsConfirmation(tableSet, 'notes', 1000)).toBe(true);
	expect(conversionNeedsConfirmation({ rowCount: 20 }, 'notes', 1000)).toBe(false);
	expect(conversionNeedsConfirmation({ rowCount: 20 }, 'notes', 0)).toBe(true);
});

it('describes a live job, and allows cancel only before retiring', () => {
	expect(conversionStateText({ to: 'table', phase: 'writing' })).toBe('Converting to table (writing)');
	expect(conversionStateText({ to: 'notes', phase: 'verifying' })).toBe('Converting to notes (verifying)');
	expect(conversionCanCancel('writing')).toBe(true);
	expect(conversionCanCancel('verifying')).toBe(true);
	expect(conversionCanCancel('retiring')).toBe(false);
	expect(conversionProgressText({ phase: 'writing', done: 3, total: 12 })).toBe('Writing: 3 of 12');
	expect(conversionProgressText({ phase: 'verifying', done: 0, total: 0 })).toBe('Verifying...');
});

it('reports counts on success and the job reason on a stop', () => {
	const base: ConversionResult = { ok: true, setId: 'iset-conv01', from: 'notes', to: 'table', rows: 12, reviewsCarried: 2,
		targetPath: 'Invented/mappings/x.mapping-table.tsv', trashed: 12, phaseReached: 'done', warnings: [] };
	expect(conversionResultText(base, 'import set iset-conv01'))
		.toBe('Converted import set iset-conv01 to a table: 12 mappings. 2 reviews carried over. 12 old files moved to the trash.');
	expect(conversionResultText({ ...base, ok: false, reason: 'Invented reason. Finish the conversion.' }, 'x'))
		.toBe('Invented reason. Finish the conversion.');
});

it('puts a recorded mapping set on its row so the row can offer conversion, and shows a live job', () => {
	const stack = toDefinition({ ...DEFAULT_STACK_SELECTION, chosen: ['nist-csf-2', 'nist-800-53'], optionalMappings: [] },
		'stack-conv01', 'Invented conversion stack', '2026-09-30T00:00:00Z');
	const mapping = stack.mappings.find((slot) => slot.kind !== 'from-slot')!;
	const fact: SlotRunFact = { importSetId: notesSet.id, sourceDigest: 's', recipeDigest: 'r', sourceName: 'Built-in mapping' };
	const run = { stackId: stack.id, finishedAt: '2026-09-30T01:00:00Z', detail: stack.detail, slotSets: {},
		mappingSets: { [mappingKey({ ...mapping, id: mapping.presetId })]: fact } };
	const converting = { ...notesSet, converting: { to: 'table' as const, phase: 'writing' as const } };
	const rows = stackSlotRows(stack, run, new Map([[notesSet.id, converting]]));
	const row = rows.find((item) => item.mappingSet);
	expect(row?.mappingSet?.id).toBe(notesSet.id);
	expect(row?.state).toBe('set iset-conv01, 12 notes. Converting to table (writing)');
	expect(stackSlotRows(stack, run, new Map()).some((item) => item.mappingSet)).toBe(false);
	const label = MAPPING_PRESETS.find((entry) => entry.id === mapping.presetId)!.label;
	expect(conversionSetLabel({ settings: { stacks: [stack], stackRuns: [run] } } as never, notesSet.id)).toBe(`${label} (set iset-conv01)`);
	expect(conversionSetLabel({ settings: { stacks: [], stackRuns: [] } } as never, 'iset-other1')).toBe('import set iset-other1');
});
