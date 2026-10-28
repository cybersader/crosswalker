/**
 * detection-taxonomy.test.ts — the Phase A2 detection taxonomy additions
 * (shape-first wizard spec §7d). Pins the five new detection kinds against the
 * real corpora shapes they target (CPRT/SCF level-column chains, CPRT
 * row-type discriminator, SSSOM/crosswalk edge files, multi-value link columns,
 * long-text body columns), plus negatives and the two explicit suppression
 * rules. Kept in a sibling file so the 17 pinned Phase A tests in
 * detection.test.ts stay untouched.
 */

import { detectStructure } from '../src/import/detection';
import type { Detection } from '../src/import/detection';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
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

function findKind<K extends Detection['kind']>(detections: Detection[], kind: K): Extract<Detection, { kind: K }> | undefined {
	return detections.find((d) => d.kind === kind) as Extract<Detection, { kind: K }> | undefined;
}

// ---------------------------------------------------------------------------
// Fixtures — CPRT / SCF level-column chains
// ---------------------------------------------------------------------------

/** CPRT-shaped: function → category → subcategory as three columns (n:1 chains). */
const cprtChainRows: Record<string, unknown>[] = (() => {
	const spec: [string, string, string][] = [
		['Govern', 'Oversight', 'Roles'],
		['Govern', 'Oversight', 'Responsibilities'],
		['Govern', 'Risk', 'Strategy'],
		['Govern', 'Risk', 'Tolerance'],
		['Identify', 'Assets', 'Inventory'],
		['Identify', 'Assets', 'Software'],
		['Identify', 'Improvement', 'Lessons'],
		['Identify', 'Improvement', 'Tests'],
	];
	const rows: Record<string, unknown>[] = [];
	let n = 0;
	for (const [fn, cat, sub] of spec) {
		for (let k = 0; k < 2; k++) {
			n++;
			rows.push({
				control_id: `c${String(n).padStart(3, '0')}`,
				function: fn,
				category: cat,
				subcategory: sub,
				name: `Control ${n}`,
			});
		}
	}
	return rows;
})();

/** SCF-shaped: domain → control as two level columns. */
const scfChainRows: Record<string, unknown>[] = (() => {
	const spec: [string, string][] = [
		['Governance', 'Policies'],
		['Governance', 'Roles'],
		['Asset management', 'Inventory'],
		['Asset management', 'Ownership'],
		['Access control', 'Authentication'],
		['Access control', 'Authorization'],
	];
	const rows: Record<string, unknown>[] = [];
	let n = 0;
	for (const [domain, control] of spec) {
		for (let k = 0; k < 2; k++) {
			n++;
			rows.push({ scf_ref: `r${String(n).padStart(3, '0')}`, scf_domain: domain, scf_control: control });
		}
	}
	return rows;
})();

describe('level-column-chain — CPRT function/category/subcategory', () => {
	it('detects the ordered chain parent→child (fewer→more distinct)', () => {
		const chain = findKind(detect(cprtChainRows), 'level-column-chain');
		expect(chain).toBeDefined();
		expect(chain!.columns).toEqual(['function', 'category', 'subcategory']);
	});

	it('reports per-column cardinalities and per-pair FD agreements', () => {
		const chain = findKind(detect(cprtChainRows), 'level-column-chain')!;
		expect(chain.cardinalities).toEqual({ function: 2, category: 4, subcategory: 8 });
		expect(chain.agreements).toEqual([1, 1]); // clean n:1 both hops
	});

	it('proposes one fixed folder level per column', () => {
		const chain = findKind(detect(cprtChainRows), 'level-column-chain')!;
		expect(chain.proposal).toEqual({
			mechanism: 'fixed-folders',
			templates: ['{function}', '{category}', '{subcategory}'],
		});
	});

	it('surfaces ≤5 rendered path receipts', () => {
		const chain = findKind(detect(cprtChainRows), 'level-column-chain')!;
		expect(chain.sampleValues.length).toBeLessThanOrEqual(5);
		expect(chain.sampleValues).toContain('Govern / Oversight / Roles');
	});

	it('SUPPRESSION: chained columns are excluded from facet + title candidacy (spec §7d)', () => {
		const detections = detect(cprtChainRows);
		for (const col of ['function', 'category', 'subcategory']) {
			expect(detections.find((d) => d.kind === 'facet-candidate' && d.column === col)).toBeUndefined();
			expect(detections.find((d) => d.kind === 'title-candidate' && d.column === col)).toBeUndefined();
		}
	});
});

describe('level-column-chain — SCF domain/control', () => {
	it('detects a two-column chain', () => {
		const chain = findKind(detect(scfChainRows), 'level-column-chain');
		expect(chain).toBeDefined();
		expect(chain!.columns).toEqual(['scf_domain', 'scf_control']);
		expect(chain!.cardinalities).toEqual({ scf_domain: 3, scf_control: 6 });
		expect(chain!.agreements).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// Fixtures — CPRT row-type discriminator (mixed levels as rows)
// ---------------------------------------------------------------------------

const cprtDiscriminatorRows: Record<string, unknown>[] = [
	{ level: 'function', name: 'Govern', detail: '', ref: '' },
	{ level: 'function', name: 'Identify', detail: '', ref: '' },
	{ level: 'category', name: 'Oversight', detail: 'Category description one', ref: '' },
	{ level: 'category', name: 'Risk management', detail: 'Category description two', ref: '' },
	{ level: 'subcategory', name: 'Roles', detail: 'Assign roles and duties', ref: 'PM-1' },
	{ level: 'subcategory', name: 'Duties', detail: 'Separate incompatible duties', ref: 'AC-5' },
];

describe('row-type-discriminator — CPRT mixed-level file', () => {
	it('flags the discriminator column with a material fill-pattern divergence', () => {
		const disc = findKind(detect(cprtDiscriminatorRows), 'row-type-discriminator');
		expect(disc).toBeDefined();
		expect(disc!.column).toBe('level');
		expect(disc!.maxJaccardDistance).toBeGreaterThanOrEqual(0.3);
	});

	it('carries per-value row counts + fill-sets as evidence', () => {
		const disc = findKind(detect(cprtDiscriminatorRows), 'row-type-discriminator')!;
		const byValue = new Map(disc.values.map((v) => [v.value, v]));
		expect(byValue.get('function')!.rowCount).toBe(2);
		expect(byValue.get('subcategory')!.rowCount).toBe(2);
		// subcategory rows fill strictly more columns than function rows.
		expect(byValue.get('subcategory')!.filledColumns.length).toBeGreaterThan(
			byValue.get('function')!.filledColumns.length,
		);
	});

	it('proposes a UI flag only (no auto recipe yet)', () => {
		const disc = findKind(detect(cprtDiscriminatorRows), 'row-type-discriminator')!;
		expect(disc.proposal.mechanism).toBe('flag-for-ui');
	});
});

// ---------------------------------------------------------------------------
// Fixtures — SSSOM / crosswalk edge file
// ---------------------------------------------------------------------------

const sssomRows: Record<string, unknown>[] = [
	{ subject_id: 'NIST-AC-1', predicate_id: 'skos:exactMatch', object_id: 'CIS-1.1', justification: 'manual' },
	{ subject_id: 'NIST-AC-2', predicate_id: 'skos:closeMatch', object_id: 'CIS-1.2', justification: 'manual' },
	{ subject_id: 'NIST-AU-2', predicate_id: 'skos:exactMatch', object_id: 'CIS-8.2', justification: 'manual' },
	{ subject_id: 'NIST-CM-3', predicate_id: 'skos:relatedMatch', object_id: 'CIS-4.1', justification: 'manual' },
	{ subject_id: 'NIST-IA-4', predicate_id: 'skos:exactMatch', object_id: 'CIS-5.3', justification: 'manual' },
];

describe('edge-file — SSSOM/crosswalk', () => {
	it('classifies the file as relationships with subject/object/predicate guesses', () => {
		const edge = findKind(detect(sssomRows), 'edge-file');
		expect(edge).toBeDefined();
		expect(edge!.subjectColumn).toBe('subject_id');
		expect(edge!.objectColumn).toBe('object_id');
		expect(edge!.predicateColumn).toBe('predicate_id');
		expect(edge!.subjectConfidence).toBe(1);
		expect(edge!.objectConfidence).toBe(1);
		expect(edge!.predicateConfidence).toBe(1);
	});

	it('surfaces ≤5 subject|predicate|object tuples as receipts', () => {
		const edge = findKind(detect(sssomRows), 'edge-file')!;
		expect(edge.sampleValues.length).toBeLessThanOrEqual(5);
		expect(edge.sampleValues).toContain('NIST-AC-1 | skos:exactMatch | CIS-1.1');
	});

	it('SUPPRESSION: no packed-hierarchy folder proposal on the claimed id columns (spec §7d)', () => {
		const detections = detect(sssomRows);
		expect(detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'subject_id')).toBeUndefined();
		expect(detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'object_id')).toBeUndefined();
		// Scoped: the predicate column is NOT an id column it claims, so its packed
		// signal is untouched — proving suppression is targeted, not blanket.
		expect(detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'predicate_id')).toBeDefined();
	});
});

describe('edge-file — NOT fired for a self-referential hierarchy', () => {
	const hierarchyRows: Record<string, unknown>[] = [
		{ id: 'N1', parent_id: '', name: 'Root' },
		{ id: 'N2', parent_id: 'N1', name: 'Child A' },
		{ id: 'N3', parent_id: 'N1', name: 'Child B' },
		{ id: 'N4', parent_id: 'N2', name: 'Grandchild' },
	];

	it('an id + parent_id pair is a hierarchy (parent-column), not a crosswalk', () => {
		const detections = detect(hierarchyRows);
		expect(findKind(detections, 'edge-file')).toBeUndefined();
		expect(detections.find((d) => d.kind === 'parent-column' && d.column === 'parent_id')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Fixtures — multi-value link column
// ---------------------------------------------------------------------------

const multiValueRows: Record<string, unknown>[] = (() => {
	const ids = ['T1001', 'T1002', 'T1003', 'T1004', 'T1005', 'T1006', 'T1007', 'T1008'];
	return ids.map((id, i) => ({
		technique_id: id,
		name: `Technique ${i + 1}`,
		related: `${ids[(i + 1) % ids.length]}, ${ids[(i + 2) % ids.length]}`,
	}));
})();

describe('multi-value-link — related column referencing an id set', () => {
	it('detects list-split values hitting the id column, > 1 value per cell', () => {
		const link = findKind(detect(multiValueRows), 'multi-value-link');
		expect(link).toBeDefined();
		expect(link!.column).toBe('related');
		expect(link!.idColumn).toBe('technique_id');
		expect(link!.matchRate).toBe(1);
		expect(link!.avgValuesPerCell).toBe(2);
		expect(link!.proposal).toEqual({
			parentColumn: 'related',
			idColumn: 'technique_id',
			frontmatterKey: 'related',
			predicate: 'skos:related',
			split: [','],
		});
	});

	// The recipe must split and rejoin on what the source used, or a CSV export
	// writes `T1002,T1003` back for a source that said `T1002;T1003`.
	it('records the delimiter the cells use, most frequent first', () => {
		const semicolon = multiValueRows.map((r) => ({ ...r, related: String(r.related).replace(', ', ';') }));
		expect(findKind(detect(semicolon), 'multi-value-link')!.proposal).toMatchObject({ split: [';'] });
		const mixed = semicolon.map((r, i) => (i < 2 ? { ...r, related: String(r.related).replace(';', ',') } : r));
		expect(findKind(detect(mixed), 'multi-value-link')!.proposal).toMatchObject({ split: [';', ','] });
	});

	it('is distinct from single-value parent-column (raw multi-value cells do not match)', () => {
		const detections = detect(multiValueRows);
		expect(detections.find((d) => d.kind === 'parent-column' && d.column === 'related')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Fixtures — body candidate (long text)
// ---------------------------------------------------------------------------

const proseBodyRows: Record<string, unknown>[] = [
	{ code: 'AC-1', description: 'The organization develops and disseminates an access control policy. It reviews the policy annually and updates it.' },
	{ code: 'AU-2', description: 'The information system generates audit records for defined events. Administrators review them regularly.' },
	{ code: 'CM-3', description: 'Configuration changes follow a documented change control process. Each change is reviewed before implementation.' },
	{ code: 'IA-4', description: 'The organization manages information system identifiers. It prevents reuse of identifiers for a defined period.' },
];

const LOREM =
	'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure';
const longBodyRows: Record<string, unknown>[] = [0, 1, 2, 3].map((i) => ({
	code: `X-${i}`,
	notes: `${LOREM} ${i}`,
}));

describe('body-candidate — long-text columns', () => {
	it('fires on the medium-length prose branch (≥80 chars + sentence punctuation)', () => {
		const body = findKind(detect(proseBodyRows), 'body-candidate');
		expect(body).toBeDefined();
		expect(body!.column).toBe('description');
		expect(body!.avgLength).toBeGreaterThanOrEqual(80);
		expect(body!.proposal).toEqual({ destination: 'body' });
	});

	it('fires on the pure-length branch (≥200 chars, no sentence punctuation)', () => {
		const body = findKind(detect(longBodyRows), 'body-candidate');
		expect(body).toBeDefined();
		expect(body!.column).toBe('notes');
		expect(body!.avgLength).toBeGreaterThanOrEqual(200);
	});

	it('does not flag a short code column as body', () => {
		const detections = detect(proseBodyRows);
		expect(detections.find((d) => d.kind === 'body-candidate' && d.column === 'code')).toBeUndefined();
	});

	it('id guard: a low-cardinality facet with hyphens is never a packed hierarchy', () => {
		// "defense-evasion" repeated across rows is a facet; its hyphen must not
		// read as a level delimiter (its pieces became folder levels appended to
		// the real hierarchy's paths).
		const rows = Array.from({ length: 12 }, (_, i) => ({
			technique_id: i < 8 ? `T10${55 + i}` : `T10${47 + i}.00${i - 7}`,
			tactic: ['defense-evasion', 'privilege-escalation', 'initial-access'][i % 3],
		}));
		const detections = detect(rows);
		expect(
			detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'tactic'),
		).toBeUndefined();
		expect(
			detections.find((d) => d.kind === 'facet-candidate' && d.column === 'tactic'),
		).toBeDefined();
	});

	it('prose guard: sentence periods are never read as hierarchy delimiters', () => {
		// Regression for the E2E-screenshot bug (2026-07-06): the description
		// column's sentences classified as a ragged packed hierarchy, and the
		// preview grew folders named with full sentences. Ids do not contain
		// spaces; prose must produce a body candidate, never a structural one.
		const detections = detect(proseBodyRows);
		expect(
			detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'description'),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Negatives — random columns produce none of the new kinds
// ---------------------------------------------------------------------------

describe('negatives — random columns yield none of the new detection kinds', () => {
	const randomRows: Record<string, unknown>[] = [
		{ alpha: 'ktwm', beta: 'green', gamma: 'north', delta: 'apple' },
		{ alpha: 'brfp', beta: 'amber', gamma: 'south', delta: 'mango' },
		{ alpha: 'ldcx', beta: 'coral', gamma: 'east', delta: 'guava' },
		{ alpha: 'mnvq', beta: 'plum', gamma: 'west', delta: 'lemon' },
	];

	const newKinds: Detection['kind'][] = [
		'level-column-chain',
		'row-type-discriminator',
		'edge-file',
		'multi-value-link',
		'body-candidate',
	];

	it('produces zero of the five new kinds', () => {
		const detections = detect(randomRows);
		for (const kind of newKinds) {
			expect(detections.find((d) => d.kind === kind)).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Phase A regression — an existing corpus fixture is unchanged by the additions
// ---------------------------------------------------------------------------

describe('Phase A regression — ATT&CK single-column produces only its packed detection', () => {
	const ids = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];

	it('no new kind piggybacks on a single packed id column', () => {
		const detections = detect(ids.map((v) => ({ technique_id: v })));
		expect(detections.length).toBe(1);
		expect(detections[0].kind).toBe('packed-hierarchy');
	});
});

// ---------------------------------------------------------------------------
// Determinism — new kinds are byte-stable
// ---------------------------------------------------------------------------

describe('determinism — new detection kinds', () => {
	it('CPRT chain fixture → deep-equal, byte-identical output', () => {
		const a = detect(cprtChainRows);
		const b = detect(cprtChainRows);
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('SSSOM edge fixture → deep-equal, byte-identical output', () => {
		const a = detect(sssomRows);
		const b = detect(sssomRows);
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('multi-value + body fixtures → byte-identical output', () => {
		expect(JSON.stringify(detect(multiValueRows))).toBe(JSON.stringify(detect(multiValueRows)));
		expect(JSON.stringify(detect(proseBodyRows))).toBe(JSON.stringify(detect(proseBodyRows)));
	});
});
