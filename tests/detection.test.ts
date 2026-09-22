/**
 * detection.test.ts — the structure-detection engine (shape-first wizard §2).
 *
 * Pins every threshold in the spec against the four real corpora shapes
 * (ATT&CK, NIST-CSF, CIS, SCF) plus parent-column, facet, and the edge cases.
 * The parity assertions guard the packed-hierarchy `fixed-folders` proposal
 * against `deriveIdSplitTemplates` (the engine's uniform-case inference this
 * module extends but must not diverge from in the uniform case).
 */

import { detectStructure, defaultDestinationForColumn } from '../src/import/detection';
import type { Detection } from '../src/import/detection';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { deriveIdSplitTemplates } from '../src/generation/generation-engine';
import type { ParsedData, ColumnInfo } from '../src/types/config';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeData(rows: Record<string, unknown>[]): { data: ParsedData; columns: ColumnInfo[] } {
	const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
	const data: ParsedData = { columns, rows, rowCount: rows.length };
	return { data, columns: analyzeColumns(data) };
}

function detect(rows: Record<string, unknown>[]): Detection[] {
	const { data, columns } = makeData(rows);
	return detectStructure(data, columns);
}

function packedOf(detections: Detection[], column: string) {
	const d = detections.find((x) => x.kind === 'packed-hierarchy' && x.column === column);
	return d as Extract<Detection, { kind: 'packed-hierarchy' }> | undefined;
}

function rowsFrom(column: string, values: string[]): Record<string, unknown>[] {
	return values.map((v) => ({ [column]: v }));
}

// ---------------------------------------------------------------------------
// defaultDestinationForColumn (spec §7k item 2)
// ---------------------------------------------------------------------------

describe('defaultDestinationForColumn', () => {
	const bodyDetection: Detection = {
		kind: 'body-candidate',
		column: 'description',
		avgLength: 220,
		distinctness: 0.99,
		sampleValues: ['A long prose description of the control.'],
		proposal: { destination: 'body' },
	};

	it('defaults a body-candidate column to the note body', () => {
		expect(defaultDestinationForColumn('description', [bodyDetection])).toBe('body');
	});

	it('defaults every other column to a property', () => {
		expect(defaultDestinationForColumn('name', [bodyDetection])).toBe('property');
	});

	it('defaults to property when there are no detections', () => {
		expect(defaultDestinationForColumn('description', [])).toBe('property');
	});

	it('integration: a real long-prose column is routed to body', () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({
			id: `AC-${i + 1}`,
			description:
				`Control ${i + 1}: the organization defines and manages a distinct policy. ` +
				'It reviews the policy periodically and updates it as conditions change.',
		}));
		const { data, columns } = makeData(rows);
		const detections = detectStructure(data, columns);
		expect(defaultDestinationForColumn('description', detections)).toBe('body');
		expect(defaultDestinationForColumn('id', detections)).toBe('property');
	});
});

// ---------------------------------------------------------------------------
// Packed-hierarchy — ragged (ATT&CK)
// ---------------------------------------------------------------------------

describe('packed-hierarchy — ATT&CK ragged (~40% sub-techniques)', () => {
	// 6 top-level + 4 sub-technique ids → coverage of '.' = 0.4 (0.2 ≤ x < 0.8 → ragged).
	const ids = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];

	it('classifies as ragged on "." with the right coverage', () => {
		const p = packedOf(detect(rowsFrom('technique_id', ids)), 'technique_id');
		expect(p).toBeDefined();
		expect(p!.classification).toBe('ragged');
		expect(p!.delimiter).toBe('.');
		expect(p!.coverage).toBe(0.4);
	});

	it('reports the depth histogram (6 rows · 1 part, 4 rows · 2 parts)', () => {
		const p = packedOf(detect(rowsFrom('technique_id', ids)), 'technique_id');
		expect(p!.depthHistogram).toEqual({ 1: 6, 2: 4 });
	});

	it('proposes a variadic block (prefix, drop_last), not fixed folders', () => {
		const p = packedOf(detect(rowsFrom('technique_id', ids)), 'technique_id');
		expect(p!.proposal).toEqual({
			mechanism: 'variadic-folders',
			variadic: { delimiter: '.', segment: 'prefix', drop_last: true },
		});
	});

	it('surfaces ≤5 sample values as receipts', () => {
		const p = packedOf(detect(rowsFrom('technique_id', ids)), 'technique_id');
		expect(p!.sampleValues.length).toBeLessThanOrEqual(5);
		expect(p!.sampleValues).toContain('T1055');
	});
});

// ---------------------------------------------------------------------------
// Packed-hierarchy — uniform two delimiters (NIST-CSF)
// ---------------------------------------------------------------------------

describe('packed-hierarchy — NIST-CSF uniform ("." then "-")', () => {
	const ids = ['GV.OC-01', 'GV.OC-02', 'DE.AE-02', 'DE.AE-03', 'PR.AA-05', 'ID.AM-01'];

	it('classifies uniform with primary delimiter "." and the set-depth histogram', () => {
		const p = packedOf(detect(rowsFrom('element_identifier', ids)), 'element_identifier');
		expect(p!.classification).toBe('uniform');
		expect(p!.delimiter).toBe('.');
		expect(p!.coverage).toBe(1);
		// The histogram stays keyed on the primary single delimiter (unchanged
		// behaviour): every sample splits on "." into 2 parts.
		expect(p!.depthHistogram).toEqual({ 2: 6 });
	});

	it('proposes cumulative prefix(.-,i) levels over the delimiter set (spec §3, A1)', () => {
		const p = packedOf(detect(rowsFrom('element_identifier', ids)), 'element_identifier');
		expect(p!.proposal).toEqual({
			mechanism: 'fixed-folders',
			templates: ['{element_identifier|prefix(.-,0)}', '{element_identifier|prefix(.-,1)}'],
		});
		// Divergence guard (spec §3): with two or more qualifying delimiters the
		// detection now emits prefix(D,i) over the set, while the engine mirror
		// still emits one split(d,0) per delimiter. Same depth, different naming.
		expect(deriveIdSplitTemplates('element_identifier', ids)).toEqual([
			'{element_identifier|split(.,0)}',
			'{element_identifier|split(-,0)}',
		]);
		// The set order follows the delimiters' first occurrence in the longest id.
		expect(p!.delimiter).toBe('.');
	});
});

// ---------------------------------------------------------------------------
// Packed-hierarchy — CIS (ragged on ".") and SCF (uniform on "-")
// ---------------------------------------------------------------------------

describe('packed-hierarchy — CIS ragged on "."', () => {
	const ids = ['1', '1.1', '1.2', '2', '2.3', '3', '3.1', '4'];

	it('classifies ragged with a mixed depth histogram', () => {
		const p = packedOf(detect(rowsFrom('cis_id', ids)), 'cis_id');
		expect(p!.classification).toBe('ragged');
		expect(p!.delimiter).toBe('.');
		expect(p!.coverage).toBe(0.5);
		expect(p!.depthHistogram).toEqual({ 1: 4, 2: 4 });
		expect(p!.proposal).toEqual({
			mechanism: 'variadic-folders',
			variadic: { delimiter: '.', segment: 'prefix', drop_last: true },
		});
	});
});

describe('packed-hierarchy — SCF uniform on "-"', () => {
	const ids = ['GOV-01', 'GOV-02', 'AST-01', 'AST-02', 'IAC-01', 'IAC-10'];

	it('classifies uniform with a single fixed level, matching deriveIdSplitTemplates', () => {
		const p = packedOf(detect(rowsFrom('scf_id', ids)), 'scf_id');
		expect(p!.classification).toBe('uniform');
		expect(p!.delimiter).toBe('-');
		expect(p!.proposal).toEqual({ mechanism: 'fixed-folders', templates: ['{scf_id|split(-,0)}'] });
		expect((p!.proposal as { templates: string[] }).templates).toEqual(deriveIdSplitTemplates('scf_id', ids));
	});
});

// ---------------------------------------------------------------------------
// Packed-hierarchy — multi-delimiter set (spec §3): uniform depth-4 and ragged
// ---------------------------------------------------------------------------

describe('packed-hierarchy — CRI-shaped uniform depth-4 over the {.-} set (synthetic values)', () => {
	// Synthetic GV.OC-01.01-shaped ids (never real workbook rows): function,
	// category, subcategory, sub-subcategory. 100% depth-4 agreement.
	const ids = [
		'GV.OC-01.01', 'GV.OC-01.02', 'GV.OC-02.01', 'GV.OC-02.02',
		'GV.ID-01.01', 'GV.ID-01.02', 'GV.ID-02.01', 'GV.RA-01.01',
		'DE.AE-01.01', 'DE.AE-01.02', 'DE.AE-02.01', 'DE.CM-01.01',
		'PR.AA-01.01', 'PR.AA-01.02', 'PR.AA-02.01', 'PR.AT-01.01',
	];

	it('proposes three prefix(.-,i) folder levels with the untouched column as leaf (A2)', () => {
		const p = packedOf(detect(rowsFrom('element_identifier', ids)), 'element_identifier');
		expect(p!.classification).toBe('uniform');
		expect(p!.proposal).toEqual({
			mechanism: 'fixed-folders',
			templates: [
				'{element_identifier|prefix(.-,0)}',
				'{element_identifier|prefix(.-,1)}',
				'{element_identifier|prefix(.-,2)}',
			],
		});
		// Histogram stays keyed on the primary single delimiter: 3 parts on ".".
		expect(p!.depthHistogram).toEqual({ 3: ids.length });
	});
});

describe('packed-hierarchy — ragged mixes keep the pre-existing single-delimiter output', () => {
	it('a shallow ragged mix classifies ragged (variadic), never prefix levels (A4, detection half)', () => {
		// '.' covers only 3/4 values → the whole detection goes ragged before any
		// set logic runs; the variadic proposal must be byte-identical to today's.
		const ids = ['GV', 'GV.OC', 'GV.OC-01', 'GV.OC-01.01'];
		const p = packedOf(detect(rowsFrom('element_identifier', ids)), 'element_identifier');
		expect(p).toBeDefined();
		expect(p!.classification).toBe('ragged');
		expect(p!.proposal).toEqual({
			mechanism: 'variadic-folders',
			variadic: { delimiter: '.', segment: 'prefix', drop_last: true },
		});
	});

	it('two qualifying delimiters with a ragged set-depth fall back to the per-delimiter splits', () => {
		// Both '.' and '-' qualify (100% coverage), '-' alone is uniform
		// (one '-' per value), but the set-depth disagrees (17×3 vs 3×4 < 90%),
		// so the multi-delimiter branch falls back to today's split() templates.
		const ids: string[] = [];
		for (let i = 0; i < 17; i++) ids.push(`AB.CD-E${String(i).padStart(2, '0')}`);
		for (let i = 0; i < 3; i++) ids.push(`AB.CD-E0.0${i}`);
		const p = packedOf(detect(rowsFrom('element_identifier', ids)), 'element_identifier');
		expect(p).toBeDefined();
		expect(p!.classification).toBe('uniform'); // '-' alone is still uniform
		expect(p!.proposal).toEqual({
			mechanism: 'fixed-folders',
			templates: ['{element_identifier|split(.,0)}', '{element_identifier|split(-,0)}'],
		});
	});
});

// ---------------------------------------------------------------------------
// Parent-column
// ---------------------------------------------------------------------------

describe('parent-column', () => {
	const rows = [
		{ id: 'A1', parent_id: '', name: 'Root one', decoy: 'xkcd' },
		{ id: 'A2', parent_id: 'A1', name: 'Child two', decoy: 'qwff' },
		{ id: 'A3', parent_id: 'A1', name: 'Child three', decoy: 'zzpp' },
		{ id: 'A4', parent_id: 'A2', name: 'Grandchild four', decoy: 'mmnb' },
		{ id: 'A5', parent_id: 'A2', name: 'Grandchild five', decoy: 'ooii' },
	];

	it('detects parent_id referencing the id column at the right match rate', () => {
		const detections = detect(rows);
		const parent = detections.find((d) => d.kind === 'parent-column' && d.column === 'parent_id') as
			| Extract<Detection, { kind: 'parent-column' }>
			| undefined;
		expect(parent).toBeDefined();
		expect(parent!.idColumn).toBe('id');
		expect(parent!.matchRate).toBe(1); // all 4 non-empty parent_id values are ids
		expect(parent!.parentIdentityMode).toBe('source-prefix');
		expect(parent!.proposal).toEqual({
			parentColumn: 'parent_id',
			idColumn: 'id',
			frontmatterKey: 'parent',
			predicate: 'skos:broader',
		});
	});

	it('uses raw CURIE mode only when every value in the bounded 500-value sample is a CURIE', () => {
		const rows = Array.from({ length: 502 }, (_, i) => ({
			id: `x:${i}`,
			parent_id: i === 0 ? '' : i === 501 ? 'LOCAL' : `x:${i - 1}`,
		}));
		const parent = detect(rows).find(
			(d): d is Extract<Detection, { kind: 'parent-column' }> =>
				d.kind === 'parent-column' && d.column === 'parent_id',
		);
		expect(parent?.parentIdentityMode).toBe('raw-curie');

		rows[5].parent_id = 'LOCAL';
		const contradicted = detect(rows).find(
			(d): d is Extract<Detection, { kind: 'parent-column' }> =>
				d.kind === 'parent-column' && d.column === 'parent_id',
		);
		expect(contradicted?.parentIdentityMode).toBe('source-prefix');
	});

	it('does NOT flag the decoy random-string column as a parent', () => {
		const detections = detect(rows);
		const decoyParent = detections.find((d) => d.kind === 'parent-column' && d.column === 'decoy');
		expect(decoyParent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Facet-candidate
// ---------------------------------------------------------------------------

describe('facet-candidate', () => {
	const tactics = ['recon', 'access', 'execution', 'persistence', 'evasion', 'impact'];
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < 200; i++) {
		// Every 7th row is multi-value ("a, b"), both atoms already within the 6.
		const t = i % 7 === 0 ? `${tactics[i % 6]}, ${tactics[(i + 1) % 6]}` : tactics[i % 6];
		rows.push({ id: String(i), tactic: t });
	}

	it('detects a 6-value column over 200 rows as a facet (cardinality 6)', () => {
		const detections = detect(rows);
		const facet = detections.find((d) => d.kind === 'facet-candidate' && d.column === 'tactic') as
			| Extract<Detection, { kind: 'facet-candidate' }>
			| undefined;
		expect(facet).toBeDefined();
		expect(facet!.cardinality).toBe(6);
		expect(facet!.proposal).toEqual({
			column: 'tactic',
			tagTemplate: 'tactic/{tactic|tagsafe}',
			multiValue: true,
		});
	});

	it('does not flag the numeric unique id column as a facet', () => {
		const detections = detect(rows);
		expect(detections.find((d) => d.kind === 'facet-candidate' && d.column === 'id')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Title-candidate
// ---------------------------------------------------------------------------

describe('title-candidate', () => {
	it('flags a high-distinctness non-numeric column', () => {
		const rows = [
			{ code: 'AC-1', name: 'Access control policy' },
			{ code: 'AU-2', name: 'Audit events' },
			{ code: 'CM-3', name: 'Configuration change control' },
			{ code: 'IA-4', name: 'Identifier management' },
		];
		const detections = detect(rows);
		const title = detections.find((d) => d.kind === 'title-candidate' && d.column === 'name') as
			| Extract<Detection, { kind: 'title-candidate' }>
			| undefined;
		expect(title).toBeDefined();
		expect(title!.distinctness).toBe(1);
		// The packed id column is identity, not a title candidate.
		expect(detections.find((d) => d.kind === 'title-candidate' && d.column === 'code')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	it('empty column → no detections', () => {
		const rows = Array.from({ length: 5 }, () => ({ empty: '' }));
		expect(detect(rows)).toEqual([]);
	});

	it('all-identical column → no detections', () => {
		const rows = Array.from({ length: 6 }, () => ({ status: 'active' }));
		expect(detect(rows)).toEqual([]);
	});

	it('delimiter-free ids → no packed-hierarchy detection', () => {
		const rows = rowsFrom('name', ['Policy', 'Accounts', 'Flow', 'Governance']);
		const detections = detect(rows);
		expect(detections.every((d) => d.kind !== 'packed-hierarchy')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
	const rows = [
		{ id: 'GV.OC-01', parent: 'GV.OC-01', tactic: 'recon', name: 'Governance one' },
		{ id: 'GV.OC-02', parent: 'GV.OC-01', tactic: 'access', name: 'Governance two' },
		{ id: 'DE.AE-02', parent: 'GV.OC-01', tactic: 'recon', name: 'Detection two' },
		{ id: 'DE.AE-03', parent: 'DE.AE-02', tactic: 'impact', name: 'Detection three' },
	];

	it('same input twice → deep-equal, byte-identical output', () => {
		const a = detect(rows);
		const b = detect(rows);
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
