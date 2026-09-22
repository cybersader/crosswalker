import fixture from './fixtures/oscal-mini.json';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { detectStructure } from '../src/import/detection';
import { instantiate } from '../src/import/mapping/instantiate';
import { getBuiltInPreset } from '../src/import/mapping/presets';
import type { ParsedData, SourceContainer } from '../src/types/config';

function jsonData(rows: Record<string, unknown>[], iterator = '$.catalog.groups[*]'): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	const container = {
		kind: 'json',
		iterator,
		readDocument: async () => ({ rows }),
	} as SourceContainer;
	return { columns, rows, rowCount: rows.length, container };
}

function nestedDetection(data: ParsedData) {
	return detectStructure(data, analyzeColumns(data), data.container)
		.find((entry) => entry.kind === 'nested-records');
}

describe('nested-record detection', () => {
	it('detects the OSCAL mini chain with global identities', () => {
		const groups = fixture.catalog.groups as unknown as Record<string, unknown>[];
		const detection = nestedDetection(jsonData(groups));
		expect(detection?.proposal).toEqual({
			mechanism: 'nested-levels',
			levels: ['group', 'control', 'part'],
			identities: ['global', 'global', 'global'],
		});
		expect(detection?.chain.map((entry) => entry.field)).toEqual(['controls', 'parts']);
		expect(detection?.sampleValues).toHaveLength(5);
	});

	it('uses path identity when child ids repeat under different parents', () => {
		const groups = [{
			id: 'g1',
			controls: [
				{ id: 'c1', parts: [{ id: 'statement' }, { id: 'guidance' }] },
				{ id: 'c2', parts: [{ id: 'statement' }, { id: 'guidance' }] },
			],
		}] as Record<string, unknown>[];
		const detection = nestedDetection(jsonData(groups));
		expect(detection?.proposal.identities).toEqual(['global', 'global', 'path']);
		expect(detection?.chain[1].repeatsUnderParents).toBe(true);
	});

	it('does not fire for flat JSON or CSV-shaped data', () => {
		const flat = jsonData([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }]);
		expect(nestedDetection(flat)).toBeUndefined();
		const csv: ParsedData = { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 };
		expect(nestedDetection(csv)).toBeUndefined();
	});

	it('makes nested records the structural winner over a packed id', () => {
		const groups = (fixture.catalog.groups as unknown as Record<string, unknown>[])
			.map((group, index) => ({ ...group, id: `group-${index + 1}` }));
		const data = jsonData(groups);
		const detections = detectStructure(data, analyzeColumns(data), data.container);
		expect(detections.some((entry) => entry.kind === 'packed-hierarchy')).toBe(true);
		const mapping = instantiate(getBuiltInPreset('browsable-framework')!, detections);
		expect(mapping.nest?.map((entry) => entry.level)).toEqual(['group', 'control', 'part']);
		expect(mapping.mappings.filter((entry) =>
			entry.levels.some((level) => level.destinations.some((destination) =>
				destination.primitive === 'folder' || destination.primitive === 'name')),
		)).toHaveLength(1);
	});
});
