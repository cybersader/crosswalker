/**
 * Crosswalk-column detection tests for the deep-reification import wave.
 * Fixtures are synthetic and exercise offers only: detection never selects.
 */

import {
	detectStructure,
	splitCrosswalkCell,
	type Detection,
} from '../src/import/detection';
import {
	entriesByOntology,
	ontologyForHeader,
	RECIPE_REGISTRY,
} from '../src/import/recipe-registry';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ColumnInfo, ParsedData } from '../src/types/config';

function makeData(rows: Record<string, unknown>[]): { data: ParsedData; columns: ColumnInfo[] } {
	const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
	const data: ParsedData = { columns, rows, rowCount: rows.length };
	return { data, columns: analyzeColumns(data) };
}

function detect(rows: Record<string, unknown>[]): Detection[] {
	const { data, columns } = makeData(rows);
	return detectStructure(data, columns);
}

function findKind<K extends Detection['kind']>(
	detections: Detection[],
	kind: K,
): Extract<Detection, { kind: K }> | undefined {
	return detections.find((d) => d.kind === kind) as Extract<Detection, { kind: K }> | undefined;
}

function criTrapRows(): Record<string, unknown>[] {
	return Array.from({ length: 10 }, (_, index) => {
		const n = String(index + 1).padStart(2, '0');
		return {
			'Profile Id': `GV.OC-${n}.01`,
			Title: `Synthetic profile statement ${n}`,
			'NIST CSF v2 Mapping': 'GV.OC-01.01 (CRI Modified)\nGV.OC-02.01',
		};
	});
}

describe('crosswalk-column detection', () => {
	it('X1 preserves the CRI overlap trap as a crosswalk offer and suppresses link-shaped duplicates', () => {
		const detections = detect(criTrapRows());
		const crosswalk = findKind(detections, 'crosswalk-column');

		expect(crosswalk).toBeDefined();
		expect(crosswalk).toMatchObject({
			column: 'NIST CSF v2 Mapping',
			idColumn: 'Profile Id',
			targetOntology: 'nist-csf-2',
			idShapeRate: 1,
			selfMatchRate: 1,
			avgValuesPerCell: 2,
			qualifierSample: '(CRI Modified)',
			proposal: { mechanism: 'crosswalk-edges', predicate: 'is_approximate_to' },
		});
		expect(detections.find((d) => d.kind === 'multi-value-link' && d.column === 'NIST CSF v2 Mapping')).toBeUndefined();
		expect(detections.find((d) => d.kind === 'parent-column' && d.column === 'NIST CSF v2 Mapping')).toBeUndefined();
	});

	it('X4 drops None atoms and tolerates empty cells', () => {
		const rows = criTrapRows();
		rows[0]['NIST CSF v2 Mapping'] = 'None';
		rows[1]['NIST CSF v2 Mapping'] = '';
		const crosswalk = findKind(detect(rows), 'crosswalk-column');

		expect(crosswalk).toBeDefined();
		expect(crosswalk!.targetOntology).toBe('nist-csf-2');
		expect(crosswalk!.avgValuesPerCell).toBe(1.7778);
		expect(crosswalk!.sampleValues).toContain('None');
	});

	it('X5 offers an unnamed foreign ontology when ids are not ours', () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `SRC${String(index + 1).padStart(3, '0')}`,
			'Maps to ISO 27001': 'A.5.1, A.5.2',
		}));
		const crosswalk = findKind(detect(rows), 'crosswalk-column');

		expect(crosswalk).toMatchObject({
			column: 'Maps to ISO 27001',
			targetOntology: null,
			idShapeRate: 1,
			selfMatchRate: 0,
			avgValuesPerCell: 2,
		});
	});

	it('keeps a genuine intra-ontology related list as multi-value-link only', () => {
		const ids = Array.from({ length: 8 }, (_, index) => `SRC${String(index + 1).padStart(3, '0')}`);
		const rows = ids.map((id, index) => ({
			id,
			related: `${ids[(index + 1) % ids.length]}, ${ids[(index + 2) % ids.length]}`,
		}));
		const detections = detect(rows);

		expect(detections.find((d) => d.kind === 'crosswalk-column' && d.column === 'related')).toBeUndefined();
		expect(detections.find((d) => d.kind === 'multi-value-link' && d.column === 'related')).toBeDefined();
	});

	it('does not classify columns inside an SSSOM edge file', () => {
		const rows = [
			{ subject_id: 'SRC-1', predicate_id: 'skos:exactMatch', object_id: 'DST-1', justification: 'manual' },
			{ subject_id: 'SRC-2', predicate_id: 'skos:closeMatch', object_id: 'DST-2', justification: 'manual' },
			{ subject_id: 'SRC-3', predicate_id: 'skos:exactMatch', object_id: 'DST-3', justification: 'manual' },
			{ subject_id: 'SRC-4', predicate_id: 'skos:relatedMatch', object_id: 'DST-4', justification: 'manual' },
			{ subject_id: 'SRC-5', predicate_id: 'skos:exactMatch', object_id: 'DST-5', justification: 'manual' },
		];
		const detections = detect(rows);
		const edge = findKind(detections, 'edge-file');

		expect(edge).toBeDefined();
		expect(detections.find((d) => d.kind === 'crosswalk-column' && d.column === edge!.subjectColumn)).toBeUndefined();
		expect(detections.find((d) => d.kind === 'crosswalk-column' && d.column === edge!.objectColumn)).toBeUndefined();
	});

	it('does not fire for prose', () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `SRC${String(index + 1).padStart(3, '0')}`,
			description: `This synthetic description explains row ${index + 1} in plain language.`,
		}));

		expect(findKind(detect(rows), 'crosswalk-column')).toBeUndefined();
	});
});

describe('crosswalk recognition data and atomization', () => {
	it('matches ontology aliases in declaration order', () => {
		expect(ontologyForHeader('NIST CSF v2 Mapping', RECIPE_REGISTRY)?.ontology).toBe('nist-csf-2');
		expect(ontologyForHeader('Related ATT&CK techniques', RECIPE_REGISTRY)?.ontology).toBe('mitre-attack');
		expect(ontologyForHeader('Description', RECIPE_REGISTRY)).toBeNull();
	});

	it('groups recipes that share one ontology', () => {
		const grouped = entriesByOntology(RECIPE_REGISTRY);
		expect(grouped.get('nist-csf-2')?.map((entry) => entry.id)).toEqual([
			'nist-csf-2-cprt-hierarchical',
			'nist-csf-2-cprt',
			'nist-csf-2-flat',
		]);
	});

	it('uses an id-pattern fallback when the header is generic', () => {
		const rows = [
			{ id: 'SRC001', Ref: 'T1055, T1059.001' },
			{ id: 'SRC002', Ref: 'T1055, T1059.001' },
			{ id: 'SRC003', Ref: 'T1055, T1059.001' },
		];
		expect(findKind(detect(rows), 'crosswalk-column')?.targetOntology).toBe('mitre-attack');
	});

	it('exports atomization with aligned qualifiers and dropped sentinels', () => {
		expect(splitCrosswalkCell('GV.OC-01 (CRI Modified)\nNone; GV.OC-02, N/A; -')).toEqual({
			atoms: ['GV.OC-01', 'GV.OC-02'],
			qualifiers: ['(CRI Modified)', null],
		});
	});

	it('supplies empty recognition defaults on every other registry entry', () => {
		for (const entry of RECIPE_REGISTRY) {
			expect(Array.isArray(entry.ontologyAliases)).toBe(true);
			expect(entry.idPattern === null || typeof entry.idPattern === 'string').toBe(true);
		}
	});
});
