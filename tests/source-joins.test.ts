/**
 * `source.joins` — keyed lookup enrichment (Ch 46 source contract §4).
 *
 * Acceptance cases C1-C15, plus the two properties the contract asserts about
 * cost rather than about behaviour and which are therefore easy to lose
 * silently:
 *
 *   - THE PRIMARY COLLECTION STILL STREAMS. Proved by lock-step consumption,
 *     not by a comment: the primary generator is instrumented and the test
 *     fails if the stage ever runs ahead of the consumer. Buffering the primary
 *     to build a join would turn this suite red.
 *   - THE SECONDARY INDEX IS THE ONLY THING HELD. Exercised at ATT&CK's real
 *     worst case (18,570 relationship rows), with the retained-row count
 *     asserted rather than asserted-about.
 *
 * The corpora themselves are gitignored, so the fixtures are synthetic
 * reconstructions at the real shapes and the real counts.
 */

import { createHash } from 'node:crypto';
import { TFile, TFolder } from 'obsidian';
import * as XLSX from 'xlsx';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { parseXLSXFile } from '../src/import/parsers/xlsx-parser';
import { computeRecipeHash, recipeHashCanonicalInput } from '../src/generation/hash';
import { prepareSourceStage } from '../src/source';
import { SourceStageError } from '../src/source/errors';
import { validateRecipe } from '../src/validation/validator';
import type { Recipe } from '../src/render';
import type { ParsedData, SourceContainer } from '../src/types/config';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixtures — ATT&CK hop 1, at its real measured scale
// ---------------------------------------------------------------------------

const TECHNIQUE_COUNT = 800;
const MITIGATION_EDGES = 1_200;
const USES_EDGES = 17_370;
/** The contract's measured worst case: ATT&CK `relationships`, 18,570 rows. */
const RELATIONSHIP_ROWS = MITIGATION_EDGES + USES_EDGES;

function techniqueRows(count = TECHNIQUE_COUNT): Row[] {
	return Array.from({ length: count }, (_, i) => ({
		ID: `T${1000 + i}`,
		Name: `Technique ${i}`,
		'Mitigation Name': `not the join alias ${i}`,
	}));
}

/**
 * One shared relationship table holding two predicates, which is exactly why
 * `from.where` exists: indexing all 18,570 rows would return `uses` edges
 * alongside `mitigates` ones, and the contract's own worked example cannot work
 * without narrowing first.
 *
 * Techniques 0-399 get three mitigations each; the rest get none, so "no match
 * is legitimate data" is exercised at scale rather than in one hand-made row.
 */
function relationshipRows(): Row[] {
	const rows: Row[] = [];
	for (let i = 0; i < MITIGATION_EDGES; i++) {
		const technique = i % 400;
		rows.push({
			'source ID': `T${1000 + technique}`,
			'target ID': `M${1000 + (i % 44)}`,
			'mapping type': 'mitigates',
		});
	}
	for (let i = 0; i < USES_EDGES; i++) {
		rows.push({
			'source ID': `G${i % 150}`,
			'target ID': `T${1000 + (i % TECHNIQUE_COUNT)}`,
			'mapping type': 'uses',
		});
	}
	return rows;
}

function workbook(sheets: Record<string, Row[]>): SourceContainer {
	return {
		kind: 'workbook',
		sheetNames: Object.keys(sheets),
		readSheet: async (sheet: string, headerRow: number) => {
			const rows = sheets[sheet];
			if (!rows) throw new Error(`no such sheet: ${sheet}`);
			return rows.slice(headerRow);
		},
	};
}

function jsonDocument(root: unknown): SourceContainer {
	return { kind: 'json', readDocument: async () => root };
}

function attackPrimary(rows: Row[] = techniqueRows(), sheets?: Record<string, Row[]>): ParsedData {
	return {
		columns: ['ID', 'Name', 'Mitigation Name'],
		rows,
		rowCount: rows.length,
		container: workbook(sheets ?? { techniques: rows, relationships: relationshipRows() }),
	};
}

const ATTACK_HOP_1 = {
	mitigations: {
		from: { sheet: 'relationships', where: "`mapping type` = 'mitigates'" },
		on: { primary: 'ID', secondary: '`source ID`' },
		cardinality: 'many' as const,
		select: ['target ID'],
	},
};

async function drain(parsed: ParsedData, source: any) {
	const stage = await prepareSourceStage(parsed, source);
	const out: Row[] = [];
	for await (const row of stage.rows as AsyncIterable<Row>) out.push(row);
	stage.finalize();
	return { stage, out };
}

// ---------------------------------------------------------------------------
// C1 — the real case, at the real size
// ---------------------------------------------------------------------------

describe('C1 — ATT&CK hop 1 over an 18,570-row secondary', () => {
	it('binds mitigation identifiers, indexes only the narrowed edges, and stays inside the stage budget', async () => {
		const started = Date.now();
		const { stage, out } = await drain(attackPrimary(), { joins: ATTACK_HOP_1 });
		const elapsed = Date.now() - started;

		expect(out).toHaveLength(TECHNIQUE_COUNT);
		// The unnarrowed secondary is the contract's measured worst case.
		expect(relationshipRows()).toHaveLength(RELATIONSHIP_ROWS);
		expect(RELATIONSHIP_ROWS).toBe(18_570);
		// The index holds ONLY the narrowed secondary: from.where dropped 17,370
		// `uses` edges before a single row was retained. Without it, the join
		// would return the wrong edges as well as holding 15x the memory.
		expect(stage.joins).toHaveLength(1);
		expect(stage.joins[0].indexedRowCount).toBe(MITIGATION_EDGES);
		expect(stage.joins[0].distinctKeyCount).toBe(400);

		const enriched = out[0];
		expect(enriched.ID).toBe('T1000');
		expect(Array.isArray(enriched.mitigations)).toBe(true);
		// Techniques 0-399 each carry three `mitigates` edges (i, i+400, i+800).
		expect(enriched.mitigations).toEqual(['M1000', 'M1004', 'M1008']);

		// Techniques 400+ have no mitigation edge. Absence of a relation is
		// DATA: the alias is simply not there, and nothing errored.
		expect(out[400].mitigations).toBeUndefined();
		expect('mitigations' in out[400]).toBe(false);

		// The whole stage evaluated RELATIONSHIP_ROWS predicates + MITIGATION_EDGES
		// secondary keys + TECHNIQUE_COUNT primary keys inside the 5,000 ms budget.
		expect(elapsed).toBeLessThan(5000);
	}, 60_000);

	it('leaves the primary row object untouched, so a second run sees clean input', async () => {
		const rows = techniqueRows(10);
		const parsed = attackPrimary(rows, { techniques: rows, relationships: relationshipRows() });
		const { out } = await drain(parsed, { joins: ATTACK_HOP_1 });
		expect(out[0]).not.toBe(rows[0]);
		expect('mitigations' in rows[0]).toBe(false);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// C2-C6 — cardinality and the key contract
// ---------------------------------------------------------------------------

describe('cardinality (C2, C3, C4) and keys (C5, C6)', () => {
	const primary = (): ParsedData => ({
		columns: ['ID', 'blank'],
		rows: [{ ID: 'A', blank: '' }, { ID: 'B', blank: '' }, { ID: 'ZZ', blank: '' }],
		rowCount: 3,
		container: workbook({
			lookup: [
				{ key: 'A', name: 'a-one', 'Field With Spaces': 'spaced value' },
				{ key: 'A', name: 'a-two', 'Field With Spaces': 'x' },
				{ key: 'A', name: 'a-three', 'Field With Spaces': 'y' },
				{ key: 'B', name: 'b-only', 'Field With Spaces': 'z' },
			],
		}),
	});

	const join = (over: Record<string, unknown>) => ({
		joins: {
			hit: {
				from: { sheet: 'lookup' },
				on: { primary: 'ID', secondary: 'key' },
				...over,
			},
		},
	});

	it('C2 — cardinality "one" with 3 matches names the row, alias, key and count', async () => {
		await expect(drain(primary(), join({ cardinality: 'one' }))).rejects.toThrow(
			/cardinality "one" but 3 rows matched key "A".*row 1/s,
		);
		const err = await drain(primary(), join({ cardinality: 'one' })).catch((e) => e);
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).declaration).toBe('source.joins.hit');
		expect((err as SourceStageError).row).toBe(1);
	});

	it('C3 — cardinality "many" with exactly 1 match still binds a list', async () => {
		const { out } = await drain(primary(), join({ cardinality: 'many', select: ['name'] }));
		// Output shape must not depend on how many rows happened to match.
		expect(out[1].hit).toEqual(['b-only']);
		expect(Array.isArray(out[1].hit)).toBe(true);
	});

	it('C4 — zero matches leaves the alias ABSENT in both cardinalities, with no error', async () => {
		const many = await drain(primary(), join({ cardinality: 'many', select: ['name'] }));
		expect('hit' in many.out[2]).toBe(false);

		const single = primary();
		single.rows = [{ ID: 'ZZ', blank: '' }];
		single.rowCount = 1;
		const one = await drain(single, join({ cardinality: 'one' }));
		expect('hit' in one.out[0]).toBe(false);
	});

	it('binds the whole matched row for "one", or just the selected fields', async () => {
		const only = primary();
		only.rows = [{ ID: 'B', blank: '' }];
		only.rowCount = 1;

		const whole = await drain(only, join({ cardinality: 'one' }));
		expect(whole.out[0].hit).toEqual({ key: 'B', name: 'b-only', 'Field With Spaces': 'z' });

		const narrowed = await drain(only, join({ cardinality: 'one', select: ['name'] }));
		expect(narrowed.out[0].hit).toEqual({ name: 'b-only' });
	});

	it('C5 — an undefined primary key aborts, naming the row', async () => {
		const parsed = primary();
		const err = await drain(parsed, {
			joins: {
				hit: {
					from: { sheet: 'lookup' },
					on: { primary: '$string(ID) & missingcol', secondary: 'key' },
					cardinality: 'one',
				},
			},
		}).catch((e) => e);
		// A reference to a name the collection does not have is caught earlier
		// still, at preflight, which is the stronger guarantee.
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).message).toContain('unknown field "missingcol"');
	});

	it('C5 — an undefined primary key on a heterogeneous collection aborts at the row', async () => {
		// `sometimes` exists in the union (row 2 has it) but not on row 1, so
		// preflight passes and the per-row guard is the one that must fire.
		const parsed: ParsedData = {
			columns: [],
			rows: [{ ID: 'A' }, { ID: 'B', sometimes: 'A' }],
			rowCount: 2,
			container: workbook({ lookup: [{ key: 'A', name: 'a' }] }),
		};
		const err = await drain(parsed, {
			joins: {
				hit: { from: { sheet: 'lookup' }, on: { primary: 'sometimes', secondary: 'key' }, cardinality: 'one' },
			},
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).message).toMatch(/key is undefined.*row 1/s);
		expect((err as SourceStageError).declaration).toBe('source.joins.hit.on.primary');
	});

	it('C6 — a primary key that trims to empty aborts', async () => {
		const parsed = primary();
		parsed.rows = [{ ID: 'A', blank: '   ' }];
		parsed.rowCount = 1;
		const err = await drain(parsed, {
			joins: {
				hit: { from: { sheet: 'lookup' }, on: { primary: 'blank', secondary: 'key' }, cardinality: 'one' },
			},
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).message).toContain('key is empty after trimming');
	});

	it('a non-scalar key aborts rather than stringifying an object into a bucket', async () => {
		const parsed: ParsedData = {
			columns: ['ID', 'nested'],
			rows: [{ ID: 'A', nested: { a: 1 } }],
			rowCount: 1,
			container: workbook({ lookup: [{ key: 'A' }] }),
		};
		const err = await drain(parsed, {
			joins: {
				hit: { from: { sheet: 'lookup' }, on: { primary: 'nested', secondary: 'key' }, cardinality: 'one' },
			},
		}).catch((e) => e);
		expect((err as SourceStageError).message).toContain('a key must be a single scalar');
	});

	it('an undefined SECONDARY key aborts at index-build time, naming the secondary row', async () => {
		const parsed: ParsedData = {
			columns: ['ID'],
			rows: [{ ID: 'A' }],
			rowCount: 1,
			container: workbook({ lookup: [{ key: 'A' }, { key: '' }] }),
		};
		const err = await drain(parsed, {
			joins: {
				hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
			},
		}).catch((e) => e);
		expect((err as SourceStageError).declaration).toBe('source.joins.hit.on.secondary');
		expect((err as SourceStageError).row).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// C7, C8 — the collision policy: never shadow, never merge, never rename
// ---------------------------------------------------------------------------

describe('collision policy (C7, C8)', () => {
	// `lookup` is a real lowercase column here, so it can actually collide with
	// an alias: the alias pattern is lowercase, so an alias can never collide
	// with a Capitalized spreadsheet header, only with a JSON-style key.
	const parsed = (): ParsedData => ({
		columns: ['ID', 'Name', 'lookup'],
		rows: [{ ID: 'A', Name: 'primary name', lookup: 'a real column' }],
		rowCount: 1,
		container: workbook({ lookup: [{ key: 'A', Name: 'SECONDARY NAME' }] }),
	});

	it('C7 — an alias equal to an existing column is refused at preflight', async () => {
		const err = await prepareSourceStage(parsed(), {
			joins: {
				lookup: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
			},
		} as any).catch((e) => e);
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).message).toContain('collides with a column');
	});

	it('C7 — a colliding secondary FIELD never shadows the primary column', async () => {
		const { out } = await drain(parsed(), {
			joins: {
				matched: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
			},
		});
		// The row gained exactly ONE key. `Name` still means the primary's Name.
		expect(out[0].Name).toBe('primary name');
		expect(out[0].lookup).toBe('a real column');
		expect((out[0].matched as Row).Name).toBe('SECONDARY NAME');
		expect(Object.keys(out[0]).sort()).toEqual(['ID', 'Name', 'lookup', 'matched']);
	});

	it('C8 — a capitalized alias is rejected by the schema and by the stage', async () => {
		const recipe = recipeWithJoins({
			Mitigation: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
		} as any);
		expect(validateRecipe(recipe).valid).toBe(false);

		const err = await prepareSourceStage(parsed(), {
			joins: {
				Mitigation: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
			},
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('is not a legal name');
	});

	it('a reserved render-scope name is refused', async () => {
		const err = await prepareSourceStage(parsed(), {
			joins: {
				curie: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
			},
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('is reserved');
	});
});

// ---------------------------------------------------------------------------
// C9, C10 — the secondary collection itself
// ---------------------------------------------------------------------------

describe('locating the secondary collection (C9, C10)', () => {
	it('C9 — from.where that admits zero secondary rows is an error', async () => {
		const parsed = attackPrimary(techniqueRows(3));
		const err = await prepareSourceStage(parsed, {
			joins: {
				mitigations: {
					from: { sheet: 'relationships', where: "`mapping type` = 'nothing-matches-this'" },
					on: { primary: 'ID', secondary: '`source ID`' },
					cardinality: 'many',
					select: ['target ID'],
				},
			},
		} as any).catch((e) => e);
		expect(err).toBeInstanceOf(SourceStageError);
		expect((err as SourceStageError).declaration).toBe('source.joins.mitigations.from.where');
		expect((err as SourceStageError).message).toContain('excluded every row');
	}, 60_000);

	it('an empty secondary sheet is an error, not an empty result', async () => {
		const parsed: ParsedData = {
			columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1, container: workbook({ lookup: [] }),
		};
		const err = await prepareSourceStage(parsed, {
			joins: { hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('can never match');
	});

	it('C10 — a CSV source carrying joins fails naming the format limitation', async () => {
		const parsed: ParsedData = {
			columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1, container: { kind: 'flat' },
		};
		const err = await prepareSourceStage(parsed, {
			joins: { hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('single-collection source such as CSV');
	});

	it('a source with no container at all fails loud rather than finding nothing', async () => {
		const err = await prepareSourceStage(
			{ columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1 },
			{ joins: { hit: { from: { sheet: 'x' }, on: { primary: 'ID', secondary: 'k' }, cardinality: 'one' } } } as any,
		).catch((e) => e);
		expect((err as SourceStageError).message).toContain('did not record which container');
	});

	it('an unknown sheet lists the sheets that DO exist', async () => {
		const parsed = attackPrimary(techniqueRows(2));
		const err = await prepareSourceStage(parsed, {
			joins: { hit: { from: { sheet: 'relationship' }, on: { primary: 'ID', secondary: 'k' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('is not in this workbook');
		expect((err as SourceStageError).message).toContain('relationships');
	});

	it('honours from.header_row so a secondary sheet with a banner is readable', async () => {
		const parsed: ParsedData = {
			columns: ['ID'],
			rows: [{ ID: 'A' }],
			rowCount: 1,
			container: workbook({ lookup: [{ key: 'banner' }, { key: 'A', name: 'real' }] }),
		};
		const { out } = await drain(parsed, {
			joins: {
				hit: {
					from: { sheet: 'lookup', header_row: 1 },
					on: { primary: 'ID', secondary: 'key' },
					cardinality: 'one',
					select: ['name'],
				},
			},
		});
		expect(out[0].hit).toEqual({ name: 'real' });
	});

	it('resolves a sibling array of the same JSON document (the CPRT shape)', async () => {
		const root = {
			response: {
				elements: {
					elements: [
						{ element_identifier: 'GV.OC-01', element_type: 'subcategory' },
						{ element_identifier: 'GV.OC-02', element_type: 'subcategory' },
					],
					relationships: [
						{ source_element_identifier: 'GV.OC-01', dest_element_identifier: 'EX1', relationship_identifier: 'projection' },
						{ source_element_identifier: 'GV.OC-01', dest_element_identifier: 'EX2', relationship_identifier: 'projection' },
						{ source_element_identifier: 'GV.OC-02', dest_element_identifier: 'IGNORED', relationship_identifier: 'reference' },
					],
				},
			},
		};
		const parsed: ParsedData = {
			columns: ['element_identifier', 'element_type'],
			rows: root.response.elements.elements as Row[],
			rowCount: 2,
			container: jsonDocument(root),
		};
		const { out } = await drain(parsed, {
			joins: {
				examples: {
					from: {
						iterator: '$.response.elements.relationships[*]',
						where: "relationship_identifier = 'projection'",
					},
					on: { primary: 'element_identifier', secondary: 'source_element_identifier' },
					cardinality: 'many',
					select: ['dest_element_identifier'],
				},
			},
		});
		expect(out[0].examples).toEqual(['EX1', 'EX2']);
		// The `reference` edge was excluded before indexing, so GV.OC-02 has no
		// relation at all rather than the wrong one.
		expect('examples' in out[1]).toBe(false);
	});

	it('refuses header_row beside an iterator instead of ignoring it', async () => {
		const root = { rows: [{ k: 'A' }] };
		const parsed: ParsedData = {
			columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1, container: jsonDocument(root),
		};
		const err = await prepareSourceStage(parsed, {
			joins: {
				hit: {
					from: { iterator: '$.rows[*]', header_row: 1 },
					on: { primary: 'ID', secondary: 'k' },
					cardinality: 'one',
				},
			},
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('header_row applies to a sheet');
	});

	it('refuses a sheet against a JSON document and an iterator against a workbook', async () => {
		const jsonParsed: ParsedData = {
			columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1, container: jsonDocument({ rows: [] }),
		};
		const a = await prepareSourceStage(jsonParsed, {
			joins: { hit: { from: { sheet: 'x' }, on: { primary: 'ID', secondary: 'k' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((a as SourceStageError).message).toContain('names a sheet, but the source is a json');

		const sheetParsed: ParsedData = {
			columns: ['ID'], rows: [{ ID: 'A' }], rowCount: 1, container: workbook({ lookup: [{ k: 'A' }] }),
		};
		const b = await prepareSourceStage(sheetParsed, {
			joins: { hit: { from: { iterator: '$.x[*]' }, on: { primary: 'ID', secondary: 'k' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((b as SourceStageError).message).toContain('names an iterator, but the source is a workbook');
	});
});

// ---------------------------------------------------------------------------
// C11, C12 — schema-level cardinality/select coupling
// ---------------------------------------------------------------------------

describe('schema (C11, C12)', () => {
	const withJoin = (join: unknown) => recipeWithJoins({ hit: join } as any);

	it('C11 — "many" without select is rejected', () => {
		const r = validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many',
		}));
		expect(r.valid).toBe(false);
	});

	it('C12 — "many" with two select fields is rejected', () => {
		const r = validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' },
			cardinality: 'many', select: ['a', 'b'],
		}));
		expect(r.valid).toBe(false);
	});

	it('"many" with exactly one select field validates', () => {
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' },
			cardinality: 'many', select: ['a'],
		})).valid).toBe(true);
	});

	it('"one" validates with and without select', () => {
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one',
		})).valid).toBe(true);
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one', select: ['a', 'b'],
		})).valid).toBe(true);
	});

	it('cardinality is required, and "first" does not exist', () => {
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' },
		})).valid).toBe(false);
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'first',
		})).valid).toBe(false);
	});

	it('from names a sheet XOR an iterator', () => {
		expect(validateRecipe(withJoin({
			from: { sheet: 'lookup', iterator: '$.a[*]' },
			on: { primary: 'ID', secondary: 'key' }, cardinality: 'one',
		})).valid).toBe(false);
		expect(validateRecipe(withJoin({
			from: {}, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one',
		})).valid).toBe(false);
	});

	it('an empty joins object is not a declaration', () => {
		expect(validateRecipe(recipeWithJoins({} as any)).valid).toBe(false);
	});

	it('every shipped recipe still validates', () => {
		// The whole additive claim in one assertion: nothing already on disk
		// changed meaning.
		const fs = require('node:fs') as typeof import('node:fs');
		const path = require('node:path') as typeof import('node:path');
		for (const dir of ['recipes/import', 'recipes/starter']) {
			const abs = path.resolve(__dirname, '..', dir);
			for (const name of fs.readdirSync(abs).filter((f) => f.endsWith('.json'))) {
				const recipe = JSON.parse(fs.readFileSync(path.join(abs, name), 'utf8'));
				expect({ name, valid: validateRecipe(recipe).valid }).toEqual({ name, valid: true });
			}
		}
	});
});

// ---------------------------------------------------------------------------
// C14, C15 — independence and determinism
// ---------------------------------------------------------------------------

describe('independence and determinism (C14, C15)', () => {
	const twoSheets = (): ParsedData => ({
		columns: ['ID'],
		rows: [{ ID: 'A' }],
		rowCount: 1,
		container: workbook({
			owners: [{ key: 'A', who: 'alice' }],
			tags: [{ key: 'A', label: 'x' }, { key: 'A', label: 'y' }, { key: 'A', label: 'z' }],
		}),
	});

	it('C14 — two aliases over two sheets bind independently', async () => {
		const { stage, out } = await drain(twoSheets(), {
			joins: {
				owner: { from: { sheet: 'owners' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one', select: ['who'] },
				labels: { from: { sheet: 'tags' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many', select: ['label'] },
			},
		});
		expect(out[0].owner).toEqual({ who: 'alice' });
		expect(out[0].labels).toEqual(['x', 'y', 'z']);
		expect(stage.joins.map((j) => j.alias)).toEqual(['owner', 'labels']);
	});

	it('C15 — a "many" list is in secondary-collection order, identically across runs', async () => {
		const first = await drain(twoSheets(), {
			joins: { labels: { from: { sheet: 'tags' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many', select: ['label'] } },
		});
		const second = await drain(twoSheets(), {
			joins: { labels: { from: { sheet: 'tags' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many', select: ['label'] } },
		});
		expect(first.out[0].labels).toEqual(['x', 'y', 'z']);
		expect(second.out[0].labels).toEqual(first.out[0].labels);
	});

	it('refuses a select field that appears on no secondary row', async () => {
		// Absence of a field ON A ROW is data; absence FROM THE COLLECTION is a
		// defect, one level down from the reference preflight.
		const err = await prepareSourceStage(twoSheets(), {
			joins: { labels: { from: { sheet: 'tags' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many', select: ['lable'] } },
		} as any).catch((e) => e);
		expect((err as SourceStageError).message).toContain('select names "lable"');
	});

	it('keeps a "many" list when a matched row simply lacks the field', async () => {
		const parsed: ParsedData = {
			columns: ['ID'],
			rows: [{ ID: 'A' }],
			rowCount: 1,
			container: workbook({ tags: [{ key: 'A', label: 'x' }, { key: 'A' }, { key: 'A', label: 'z' }] }),
		};
		const { out } = await drain(parsed, {
			joins: { labels: { from: { sheet: 'tags' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'many', select: ['label'] } },
		});
		expect(out[0].labels).toEqual(['x', 'z']);
	});
});

// ---------------------------------------------------------------------------
// Streaming — the property that is easiest to lose and hardest to notice
// ---------------------------------------------------------------------------

describe('the primary collection still streams', () => {
	/**
	 * An instrumented primary. `produced` counts rows the generator has yielded;
	 * the consumer counts rows it has received. If any stage buffered the
	 * primary to build the join, `produced` would race to the end while
	 * `consumed` sat at 0, and the lock-step assertion below would fail.
	 *
	 * `columns` is published so the G2 preflight needs no sampling and the
	 * relationship is exact rather than "within the sample window".
	 */
	function instrumentedPrimary(count: number) {
		const state = { produced: 0, maxInFlight: 0, consumed: 0 };
		async function* gen() {
			for (let i = 0; i < count; i++) {
				state.produced += 1;
				state.maxInFlight = Math.max(state.maxInFlight, state.produced - state.consumed);
				yield { ID: `T${1000 + (i % 400)}`, Name: `row ${i}` };
			}
		}
		const parsed: ParsedData = {
			columns: ['ID', 'Name'],
			rows: gen(),
			rowCount: -1,
			container: workbook({ relationships: relationshipRows() }),
		};
		return { parsed, state };
	}

	it('consumes the primary in lock-step while a 18,570-row secondary is indexed', async () => {
		const { parsed, state } = instrumentedPrimary(5000);
		const stage = await prepareSourceStage(parsed, { joins: ATTACK_HOP_1 } as any);

		// Preflight built the whole index and has NOT touched the primary yet.
		expect(state.produced).toBe(0);
		expect(stage.joins[0].indexedRowCount).toBe(MITIGATION_EDGES);

		let enriched = 0;
		for await (const row of stage.rows as AsyncIterable<Row>) {
			state.consumed += 1;
			if (Array.isArray(row.mitigations)) enriched += 1;
			// The generator is never more than one row ahead of the consumer.
			// A buffering implementation reaches 5000 here on the first pass.
			expect(state.produced - state.consumed).toBeLessThanOrEqual(1);
		}
		expect(state.consumed).toBe(5000);
		expect(state.maxInFlight).toBeLessThanOrEqual(1);
		expect(enriched).toBe(5000);
	}, 120_000);

	it('holds nothing but the secondary index: memory does not scale with the primary', async () => {
		// Same join, two primaries three orders of magnitude apart. The retained
		// row count is a property of the SECONDARY only, which is the entire
		// memory story the contract accepts.
		const small = await prepareSourceStage(instrumentedPrimary(10).parsed, { joins: ATTACK_HOP_1 } as any);
		const large = await prepareSourceStage(instrumentedPrimary(50_000).parsed, { joins: ATTACK_HOP_1 } as any);
		expect(large.joins[0].indexedRowCount).toBe(small.joins[0].indexedRowCount);
		expect(large.joins[0].distinctKeyCount).toBe(small.joins[0].distinctKeyCount);
	}, 120_000);

	it('the where predicate still runs first, so a discarded row costs no lookup', async () => {
		const parsed: ParsedData = {
			columns: ['ID', 'keep'],
			rows: [{ ID: 'A', keep: 'y' }, { ID: 'A', keep: '' }],
			rowCount: 2,
			container: workbook({ lookup: [{ key: 'A', name: 'a' }] }),
		};
		const { stage, out } = await drain(parsed, {
			where: "keep != ''",
			joins: { hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one', select: ['name'] } },
		});
		expect(out).toHaveLength(1);
		expect(out[0].hit).toEqual({ name: 'a' });
		expect(stage.excludedCount).toBe(1);
	});

	it('F1 — a where naming a join alias is an unknown reference, because where runs first', async () => {
		const parsed: ParsedData = {
			columns: ['ID'],
			rows: [{ ID: 'A' }],
			rowCount: 1,
			container: workbook({ lookup: [{ key: 'A', name: 'a' }] }),
		};
		const err = await prepareSourceStage(parsed, {
			where: "$exists(hit)",
			joins: { hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' } },
		} as any).catch((e) => e);
		expect((err as SourceStageError).declaration).toBe('source.where');
		expect((err as SourceStageError).message).toContain('unknown field "hit"');
	});
});

// ---------------------------------------------------------------------------
// F3 — recipe hash participation
// ---------------------------------------------------------------------------

describe('F3 — joins participate in the recipe hash', () => {
	const target = { layout: [{ level: 'technique', mechanism: 'file', template: '{ID}.md' }] };

	it('adding joins changes the hash', () => {
		const without = computeRecipeHash(target, { where: undefined, joins: undefined });
		const with1 = computeRecipeHash(target, { joins: ATTACK_HOP_1 });
		const with2 = computeRecipeHash(target, {
			joins: { ...ATTACK_HOP_1, mitigations: { ...ATTACK_HOP_1.mitigations, cardinality: 'one' } },
		});
		expect(with1).not.toBe(without);
		expect(with2).not.toBe(with1);
	});

	it('omitting joins leaves the canonical string without the key at all', () => {
		// NEVER `?? null`: injecting "source_joins":null would make every
		// already-generated note in every vault read as recipe-drifted.
		const canonical = recipeHashCanonicalInput(target, undefined);
		expect(canonical).not.toContain('source_joins');
		expect(canonical).toBe(recipeHashCanonicalInput(target, { where: undefined, joins: undefined }));
	});
});

// ---------------------------------------------------------------------------
// Engine level — a joined value reaches the note, with zero template change
// ---------------------------------------------------------------------------

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['', 'Out']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: TFile, content: string) => { files.set(file.path, content); },
			read: async (file: TFile) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		fileManager: { renameFile: jest.fn() },
		metadataCache: { getFileCache: () => null },
	};
	return { app: app as any, files };
}

function recipeWithJoins(joins: Record<string, unknown>, managed?: Record<string, string>): Recipe {
	return {
		recipe: 'attack-joins-test',
		source: { ontology: 'mitre-attack', levels: ['technique'], joins } as any,
		target: {
			layout: [{ level: 'technique', mechanism: 'file', template: '{ID}.md', kind: 'concept' }],
			also_emit: { frontmatter: { managed: managed ?? { title: '{Name}' } } },
		},
	};
}

const OPTIONS = {
	basePath: 'Out',
	importSet: { id: 'iset-join01' },
	overwriteMode: 'replace' as const,
	createFolders: true,
	curiePrefix: 'attack',
	curieLocalPart: (row: Record<string, unknown>) => String(row.ID),
};

function xlsxPayload(primaryName: string, joinedLabel: string): ArrayBuffer {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		wb,
		XLSX.utils.aoa_to_sheet([['ID', 'Name'], ['T1548', primaryName]]),
		'Primary',
	);
	XLSX.utils.book_append_sheet(
		wb,
		XLSX.utils.aoa_to_sheet([['key', 'label'], ['T1548', joinedLabel]]),
		'Lookup',
	);
	return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('engine level — the alias lands in the note through the frozen grammar', () => {
	it('C13 — a "one" join is addressed by dotted traversal and by literal-key quoting', async () => {
		const { app, files } = makeApp();
		const parsed: ParsedData = {
			columns: ['ID', 'Name'],
			rows: [{ ID: 'T1548', Name: 'Abuse Elevation Control Mechanism' }],
			rowCount: 1,
			container: workbook({
				mitigations: [{ key: 'T1548', name: 'Privileged Account Management', 'Mitigation Name': 'spaced key value' }],
			}),
		};
		const recipe = recipeWithJoins(
			{ mitigation: { from: { sheet: 'mitigations' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' } },
			{ mitigation: '{mitigation.name}', spaced: "{mitigation.['Mitigation Name']}" },
		);
		const result = await generateFromRecipe(app, parsed, recipe, OPTIONS as any);
		expect(result.errors).toEqual([]);
		const note = files.get('Out/T1548.md') ?? '';
		expect(note).toContain('mitigation: Privileged Account Management');
		expect(note).toContain('spaced: spaced key value');
	});

	it('an XLSX join and emitted source hash both come from the first captured bytes after the File changes', async () => {
		const payloadA = xlsxPayload('Primary A', 'Joined from A');
		const payloadB = xlsxPayload('Primary A', 'Joined from B');
		let read = 0;
		const file = {
			name: 'mutable.xlsx',
			type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			size: payloadA.byteLength,
			lastModified: 0,
			arrayBuffer: jest.fn(async () => [payloadA, payloadB][Math.min(read++, 1)].slice(0)),
		} as unknown as File & { arrayBuffer: jest.Mock };
		const parsed = await parseXLSXFile(file, { sheet: 'Primary' });
		const recipe = recipeWithJoins(
			{ lookup: { from: { sheet: 'Lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' } },
			{ title: '{Name}', joined: '{lookup.label}' },
		);
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed, recipe, OPTIONS as any);
		expect(result.errors).toEqual([]);
		const note = files.get('Out/T1548.md') ?? '';
		expect(note).toContain('title: Primary A');
		expect(note).toContain('joined: Joined from A');
		expect(note).not.toContain('Joined from B');
		const expectedDigest = `sha256-${createHash('sha256').update(new Uint8Array(payloadA)).digest('hex')}`;
		expect(note).toContain(`source_hash: ${expectedDigest}`);
		expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
	});

	it('a "many" join lands as a YAML array with no template change', async () => {
		const { app, files } = makeApp();
		const rows = techniqueRows(2);
		const parsed = attackPrimary(rows, { techniques: rows, relationships: relationshipRows() });
		const recipe = recipeWithJoins(ATTACK_HOP_1 as any, { title: '{Name}', mitigations: '{mitigations}' });
		const result = await generateFromRecipe(app, parsed, recipe, OPTIONS as any);
		expect(result.errors).toEqual([]);
		const note = files.get('Out/T1000.md') ?? '';
		expect(note).toContain('mitigations:');
		expect(note).toContain('- M1000');
		expect(note).toContain('- M1004');
		expect(note).toContain('- M1008');
	}, 60_000);

	it('a preflight failure writes nothing and reports the declaration', async () => {
		const { app, files } = makeApp();
		const rows = techniqueRows(2);
		const parsed = attackPrimary(rows, { techniques: rows, relationships: relationshipRows() });
		const recipe = recipeWithJoins({
			mitigations: {
				from: { sheet: 'relationships', where: "`mapping type` = 'mitigates'" },
				on: { primary: 'IDD', secondary: '`source ID`' },
				cardinality: 'many',
				select: ['target ID'],
			},
		} as any);
		const result = await generateFromRecipe(app, parsed, recipe, OPTIONS as any);
		expect(result.success).toBe(false);
		expect(files.size).toBe(0);
		expect(result.errors[0].declaration).toBe('source.joins.mitigations.on.primary');
		expect(result.errors[0].row).toBe(0);
	}, 60_000);

	it('a per-row cardinality violation aborts the run rather than skipping the row', async () => {
		const { app } = makeApp();
		const parsed: ParsedData = {
			columns: ['ID', 'Name'],
			rows: [{ ID: 'A', Name: 'a' }],
			rowCount: 1,
			container: workbook({ lookup: [{ key: 'A', v: '1' }, { key: 'A', v: '2' }] }),
		};
		const recipe = recipeWithJoins({
			hit: { from: { sheet: 'lookup' }, on: { primary: 'ID', secondary: 'key' }, cardinality: 'one' },
		} as any);
		const result = await generateFromRecipe(app, parsed, recipe, OPTIONS as any);
		expect(result.success).toBe(false);
		expect(result.errors[0].declaration).toBe('source.joins.hit');
		expect(result.errors[0].message).toContain('2 rows matched');
	});
});
