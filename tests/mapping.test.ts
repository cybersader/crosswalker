/**
 * mapping.test.ts — the StructureMapping model layer (shape-first workbench §3a½/§3c/§5/§7b).
 *
 * Covers:
 *   - preset schema validation (built-ins pass; a column-naming preset fails)
 *   - instantiation over REAL Phase-A detection outputs (ATT&CK + CSF shapes)
 *   - the ROUND-TRIP LAW: mapping → toRecipeRegions → fromRegions → deep-equal
 *   - corpus reconstruction of real recipes/import/*.json
 *   - lossy-field pinning (missing / materialize have no recipe surface yet)
 *   - determinism
 */

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import presetSchema from '../spec/preset.schema.json';
import csfRecipe from '../recipes/import/nist-csf-2-cprt-hierarchical.json';
import mitreRecipe from '../recipes/import/mitre-attack-technique.json';
import cisRecipe from '../recipes/import/cis-controls-v8-controls.json';

import { detectStructure } from '../src/import/detection';
import type { Detection } from '../src/import/detection';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ParsedData, ColumnInfo } from '../src/types/config';

import {
	BUILT_IN_PRESETS,
	BROWSABLE_FRAMEWORK,
	DEEP_EVERYTHING,
	getBuiltInPreset,
} from '../src/import/mapping/presets';
import { instantiate } from '../src/import/mapping/instantiate';
import { collectScalarLinkEmissions, toRecipeRegions, fromRegions, fromRecipe } from '../src/import/mapping/serialize';
import type { RecipeRegions } from '../src/import/mapping/serialize';
import type { ImportMapping } from '../src/import/mapping/types';
import { validateRecipe } from '../src/validation/validator';
import { CURRENT_RECIPE_SPEC } from '../src/import/recipe-document';

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

function rowsFrom(column: string, values: string[]): Record<string, unknown>[] {
	return values.map((v) => ({ [column]: v }));
}

// ===========================================================================
// 1. Preset schema validation
// ===========================================================================

describe('preset schema validation', () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	const validate = ajv.compile(presetSchema);

	it('every built-in preset validates against preset.schema.json', () => {
		for (const [id, preset] of Object.entries(BUILT_IN_PRESETS)) {
			const ok = validate(preset);
			expect({ id, ok, errors: validate.errors }).toEqual({ id, ok: true, errors: null });
		}
	});

	it('rejects a preset that names a column (presets must be level-agnostic)', () => {
		const bad = {
			preset: 'bad-names-a-column',
			structural: {
				// A destination binding a specific column is exactly what makes a preset NOT
				// level-agnostic; additionalProperties:false rejects it.
				every_level: { destinations: [{ primitive: 'folder', column: 'element_identifier' }] },
			},
		};
		expect(validate(bad)).toBe(false);
	});

	it('rejects a preset with an unknown top-level key', () => {
		const bad = { preset: 'x', structural: {}, columns: ['id'] };
		expect(validate(bad)).toBe(false);
	});
});

// ===========================================================================
// 2. Instantiation over real detection outputs
// ===========================================================================

describe('instantiation — packed hierarchy (real detections)', () => {
	// ATT&CK-shaped: ~40% sub-techniques → ragged '.' → variadic tail.
	const attack = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];
	// CSF-shaped: uniform two-delimiter → fixed folders.
	const csf = ['GV.OC-01', 'GV.OC-02', 'DE.AE-02', 'DE.AE-03', 'PR.AA-05', 'ID.AM-01'];

	it('ragged ATT&CK → a mapping with a variadic tail + a leaf name level', () => {
		const detections = detect(rowsFrom('technique_id', attack));
		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);

		expect(mapping.mappings.length).toBe(1);
		const m = mapping.mappings[0];
		expect(m.tail).toBeDefined();
		expect(m.tail!.delimiter).toBe('.');
		expect(m.tail!.naming).toBe('prefix');
		expect(m.tail!.destinations).toEqual([{ primitive: 'folder' }]);
		// preset tail policy applied
		expect(m.tail!.max_depth).toBe(6);
		expect(m.tail!.on_overflow).toBe('truncate');
		// leaf carries a name destination
		const leaf = m.levels.find((l) => l.destinations.some((d) => d.primitive === 'name'));
		expect(leaf).toBeDefined();
		expect(leaf!.source).toEqual({ column: 'technique_id' });
	});

	it('uniform CSF → fixed folder levels + a leaf, in order (spec §3 set naming carried)', () => {
		const detections = detect(rowsFrom('element_identifier', csf));
		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);

		expect(mapping.mappings.length).toBe(1);
		const levels = mapping.mappings[0].levels;
		expect(levels.length).toBe(3);
		expect(levels[0].destinations).toEqual([{ primitive: 'folder' }]);
		expect(levels[0].source).toEqual({ column: 'element_identifier', part: 0 });
		// The prefix(D,i) template reads back as a set level: naming 'prefix' and
		// the whole delimiter set, no legacy single delimiter.
		expect(levels[0].naming).toBe('prefix');
		expect(levels[0].delimiters).toBe('.-');
		expect(levels[0].delimiter).toBeUndefined();
		expect(levels[1].destinations).toEqual([{ primitive: 'folder' }]);
		expect(levels[1].naming).toBe('prefix');
		expect(levels[1].delimiters).toBe('.-');
		expect(levels[2].destinations).toEqual([{ primitive: 'name' }]);
		expect(mapping.mappings[0].tail).toBeUndefined();
	});

	it('a prefix(.-,0) fixed-folders proposal instantiates with naming prefix + the set', () => {
		const mapping = instantiate(BROWSABLE_FRAMEWORK, [
			{
				kind: 'packed-hierarchy',
				column: 'element_identifier',
				delimiter: '.',
				coverage: 1,
				depthHistogram: { 2: 6 },
				classification: 'uniform',
				sampleValues: ['GV.OC-01'],
				proposal: {
					mechanism: 'fixed-folders',
					templates: ['{element_identifier|prefix(.-,0)}'],
				},
			},
		]);
		const level = mapping.mappings[0].levels[0];
		expect(level.naming).toBe('prefix');
		expect(level.delimiters).toBe('.-');
		expect(level.delimiter).toBeUndefined();
		expect(level.source).toEqual({ column: 'element_identifier', part: 0 });
	});

	it('a split(.,0) proposal still instantiates to a legacy single-delimiter part level', () => {
		const mapping = instantiate(BROWSABLE_FRAMEWORK, [
			{
				kind: 'packed-hierarchy',
				column: 'scf_id',
				delimiter: '-',
				coverage: 1,
				depthHistogram: { 2: 6 },
				classification: 'uniform',
				sampleValues: ['GOV-01'],
				proposal: {
					mechanism: 'fixed-folders',
					templates: ['{scf_id|split(.,0)}'],
				},
			},
		]);
		const level = mapping.mappings[0].levels[0];
		expect(level.naming).toBe('part');
		expect(level.delimiter).toBe('.');
		expect(level).not.toHaveProperty('delimiters');
	});

	it('deep-everything puts folder + nested tag on every structural level', () => {
		const detections = detect(rowsFrom('element_identifier', csf));
		const mapping = instantiate(DEEP_EVERYTHING, detections);
		const level0 = mapping.mappings[0].levels[0];
		expect(level0.destinations).toEqual([
			{ primitive: 'folder' },
			{ primitive: 'tag', namespace: 'element-identifier' },
		]);
	});

	it('matrix is never empty when any detection exists', () => {
		// A title-only detection produces no structural/facet/link mapping on its own,
		// but the defaults law still yields a non-empty matrix.
		const titleOnly: Detection[] = [
			{ kind: 'title-candidate', column: 'name', distinctness: 1, sampleValues: ['Alpha', 'Beta'] },
		];
		const mapping = instantiate(BROWSABLE_FRAMEWORK, titleOnly);
		expect(mapping.mappings.length).toBeGreaterThan(0);
		expect(mapping.mappings[0].levels.length).toBeGreaterThan(0);
	});

	it('empty detections → empty matrix (nothing to instantiate)', () => {
		expect(instantiate(BROWSABLE_FRAMEWORK, [])).toEqual({ mappings: [] });
	});
});

// ===========================================================================
// 2b. Single-structural constraint (spec §7g) — one structural winner, losers demoted
// ===========================================================================

describe('single-structural constraint (spec §7g)', () => {
	/** Exactly the mappings that carry a structural destination (folder/name/heading). */
	function structuralMappings(m: ImportMapping) {
		const isStructural = (p: string) => p === 'folder' || p === 'name' || p === 'heading';
		return m.mappings.filter(
			(s) =>
				s.levels.some((l) => l.destinations.some((d) => isStructural(d.primitive))) ||
				(s.tail !== undefined && s.tail.destinations.some((d) => isStructural(d.primitive))),
		);
	}

	// A fixture with BOTH a level-column-chain (function → category) AND a packed id
	// (the NIST-CSF shape). The chain columns are plain labels (no delimiters) so the
	// only structural signals are the chain and the packed id — exactly two, of which
	// exactly one must survive.
	const csfHierarchical: Record<string, unknown>[] = [
		{ id: 'G.1', function: 'Gov', category: 'Ctx' },
		{ id: 'G.2', function: 'Gov', category: 'Ctx' },
		{ id: 'G.3', function: 'Gov', category: 'Ctx' },
		{ id: 'G.4', function: 'Gov', category: 'Risk' },
		{ id: 'G.5', function: 'Gov', category: 'Risk' },
		{ id: 'G.6', function: 'Gov', category: 'Risk' },
		{ id: 'I.1', function: 'Ident', category: 'Asset' },
		{ id: 'I.2', function: 'Ident', category: 'Asset' },
		{ id: 'I.3', function: 'Ident', category: 'Asset' },
		{ id: 'I.4', function: 'Ident', category: 'Assess' },
		{ id: 'I.5', function: 'Ident', category: 'Assess' },
		{ id: 'I.6', function: 'Ident', category: 'Assess' },
	];

	it('chain + packed id → exactly one structural mapping (the packed id wins; chain demoted)', () => {
		const detections = detect(csfHierarchical);
		// Sanity: the fixture really does surface BOTH structural signals.
		expect(detections.some((d) => d.kind === 'level-column-chain')).toBe(true);
		expect(detections.some((d) => d.kind === 'packed-hierarchy' && d.column === 'id')).toBe(true);

		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);
		const structural = structuralMappings(mapping);
		expect(structural.length).toBe(1);

		// The winner is the packed id (a per-row-unique leaf), NOT the function/
		// category chain (whose deepest column repeats). Its leaf keeps the whole id.
		const winner = structural[0];
		const leaf = winner.levels.find((l) => l.destinations.some((d) => d.primitive === 'name'));
		expect(leaf).toBeDefined();
		expect(leaf!.source).toEqual({ column: 'id' });
		// The folder level splits the packed id, not a chain column.
		const folderLevel = winner.levels.find((l) => l.destinations.some((d) => d.primitive === 'folder'));
		expect(folderLevel!.source).toEqual({ column: 'id', part: 0 });
	});

	it('demoted chain contributes NO folder/file (its columns fall to the per-column layer)', () => {
		const detections = detect(csfHierarchical);
		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);
		// No structural mapping is sourced from a chain-only column (function).
		const fromChainColumn = mapping.mappings.some((s) =>
			s.levels.some(
				(l) =>
					l.destinations.some((d) => d.primitive === 'folder' || d.primitive === 'name') &&
					JSON.stringify(l.source).includes('function'),
			),
		);
		expect(fromChainColumn).toBe(false);
	});

	it('two packed-uniform detections → the earlier column wins (CIS id beats parent)', () => {
		// CIS shape: `id` (CIS-1, CIS-1.1) AND `parent` (CIS-1) are BOTH packed-uniform
		// on '-'. Tie on rank + coverage → source order elects `id`.
		const cis: Record<string, unknown>[] = [
			{ id: 'CIS-1', parent: '' },
			{ id: 'CIS-1.1', parent: 'CIS-1' },
			{ id: 'CIS-1.2', parent: 'CIS-1' },
			{ id: 'CIS-2', parent: '' },
			{ id: 'CIS-2.1', parent: 'CIS-2' },
			{ id: 'CIS-3', parent: '' },
		];
		const detections = detect(cis);
		const packed = detections.filter((d) => d.kind === 'packed-hierarchy');
		expect(packed.length).toBeGreaterThanOrEqual(2); // both id and parent detected

		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);
		const structural = structuralMappings(mapping);
		expect(structural.length).toBe(1);
		const leaf = structural[0].levels.find((l) => l.destinations.some((d) => d.primitive === 'name'));
		expect(leaf!.source).toEqual({ column: 'id' });
	});

	it('uniform beats ragged: a uniform packed id is elected over a ragged packed id', () => {
		// Two independent packed columns: `uid` uniform on '-' (fixed folders), `rid`
		// ragged on '.' (variadic tail). Uniform (rank 1) beats ragged (rank 2). The
		// `title` column is a concept title that suppresses the edge-file
		// classification (two id-like columns would otherwise read as a crosswalk).
		const rows: Record<string, unknown>[] = [
			{ uid: 'AC-1', rid: 'X1', title: 'Alpha policy and procedures definition' },
			{ uid: 'AC-2', rid: 'X2', title: 'Beta account management controls' },
			{ uid: 'AU-1', rid: 'X3.1', title: 'Gamma audit logging requirements' },
			{ uid: 'AU-2', rid: 'X4', title: 'Delta event review procedures list' },
			{ uid: 'CM-1', rid: 'X5.2', title: 'Epsilon configuration baseline policy' },
			{ uid: 'CM-2', rid: 'X6', title: 'Zeta change control workflow steps' },
			{ uid: 'IA-1', rid: 'X7.3', title: 'Eta identity verification standards' },
			{ uid: 'IA-2', rid: 'X8', title: 'Theta multifactor enforcement rules' },
		];
		const detections = detect(rows);
		const uid = detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'uid');
		const rid = detections.find((d) => d.kind === 'packed-hierarchy' && d.column === 'rid');
		expect(uid && uid.kind === 'packed-hierarchy' && uid.classification).toBe('uniform');
		expect(rid && rid.kind === 'packed-hierarchy' && rid.classification).toBe('ragged');

		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);
		const structural = structuralMappings(mapping);
		expect(structural.length).toBe(1);
		// The uniform `uid` won: a fixed folder + leaf, no variadic tail.
		expect(structural[0].tail).toBeUndefined();
		const leaf = structural[0].levels.find((l) => l.destinations.some((d) => d.primitive === 'name'));
		expect(leaf!.source).toEqual({ column: 'uid' });
	});

	it('toRecipeRegions throws loudly on a hand-built mapping with two structural mappings', () => {
		const twoStructural: ImportMapping = {
			mappings: [
				{
					levels: [
						{ level: 'a', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
				{
					levels: [
						{ level: 'b', source: { column: 'parent' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		};
		expect(() => toRecipeRegions(twoStructural)).toThrow(/exactly one structural mapping/);
		expect(() => toRecipeRegions(twoStructural)).toThrow(/a, b/); // names both offenders
	});

	it('toRecipeRegions allows one structural mapping + unlimited metadata-only mappings', () => {
		const oneStructuralManyMeta: ImportMapping = {
			mappings: [
				{
					levels: [
						{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
				{ levels: [{ level: 'tactic', source: { column: 'tactic' }, destinations: [{ primitive: 'tag', namespace: 'tactic' }], naming: 'part', missing: 'skip', materialize: false }] },
				{ levels: [{ level: 'parent', source: { column: 'parent' }, destinations: [{ primitive: 'link', key: 'parent', direction: 'parent-on-child' }], naming: 'part', missing: 'skip', materialize: false }] },
				{ levels: [{ level: 'title', source: { column: 'title' }, destinations: [{ primitive: 'alias' }], naming: 'part', missing: 'skip', materialize: false }] },
			],
		};
		expect(() => toRecipeRegions(oneStructuralManyMeta)).not.toThrow();
	});
});

describe('scalar-link serialization trace', () => {
	it('matches serialized templates, preserves order and excludes list-valued links', () => {
		const mapping: ImportMapping = {
			mappings: [
				{ levels: [{ level: 'first', source: { column: 'parent_a' }, destinations: [{ primitive: 'link', key: 'parent', predicate: 'skos:broader', direction: 'parent-on-child' }], naming: 'part', missing: 'skip', materialize: false }] },
				{ levels: [{ level: 'second', source: [{ column: 'prefix' }, { column: 'parent_b' }], join: ':', destinations: [{ primitive: 'link', key: 'parent', predicate: 'skos:broader', direction: 'parent-on-child' }], naming: 'part', missing: 'skip', materialize: false }] },
				{ levels: [{ level: 'related', source: { column: 'related' }, destinations: [{ primitive: 'link', key: 'related', predicate: 'skos:related', direction: 'peer', list: true }], naming: 'part', missing: 'skip', materialize: false }] },
			],
		};
		const trace = collectScalarLinkEmissions(mapping);
		const regions = toRecipeRegions(mapping);
		expect(trace).toHaveLength(2);
		expect(trace[0]).toEqual(expect.objectContaining({
			key: 'parent', template: '[[{parent_a}]]', sourceColumns: ['parent_a'],
			predicate: 'skos:broader', mappingIndex: 0, levelIndex: 0, destinationIndex: 0,
		}));
		expect(trace[1]).toEqual(expect.objectContaining({
			key: 'parent', sourceColumns: ['prefix', 'parent_b'], mappingIndex: 1,
		}));
		expect(trace[1].template).toBe(regions.also_emit?.frontmatter?.managed?.parent);
	});
});

describe('instantiation — facet + parent-column', () => {
	const rows: Record<string, unknown>[] = [];
	const tactics = ['recon', 'access', 'execution', 'persistence', 'evasion', 'impact'];
	for (let i = 0; i < 200; i++) rows.push({ id: String(i), tactic: tactics[i % 6], parent_id: i > 0 ? String(i - 1) : '' });

	it('facet detection → a tag mapping; parent detection → a link mapping', () => {
		const detections = detect(rows);
		const mapping = instantiate(BROWSABLE_FRAMEWORK, detections);
		const kinds = mapping.mappings.flatMap((m) => m.levels.flatMap((l) => l.destinations.map((d) => d.primitive)));
		expect(kinds).toContain('tag');
		expect(kinds).toContain('link');
	});
});

// ===========================================================================
// 3. The round-trip law
// ===========================================================================

/** Assert fromRegions(toRecipeRegions(m)) deep-equals m. */
function assertRoundTrip(m: ImportMapping): void {
	const regions = toRecipeRegions(m);
	const back = fromRegions(regions);
	expect(back).toEqual(m);
}

describe('round-trip law: mapping → regions → mapping', () => {
	it('N8 round-trips nested lineage sources and source.nest', () => {
		const mapping: ImportMapping = {
			mappings: [{ levels: [
				{ level: 'group', source: { column: '_cw.ancestors.group.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
				{ level: 'control', source: { column: '_cw.ancestors.control.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
				{ level: 'part', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
			] }],
			nest: [
				{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note', identity: 'global', carry: ['title'] },
				{ level: 'control', id: '{id}', children: 'parts', leaf: 'folder-note', identity: 'global', carry: ['title'] },
				{ level: 'part', id: '{id}', identity: 'global', carry: ['name'] },
			],
		};
		assertRoundTrip(mapping);
		expect(fromRegions(toRecipeRegions(mapping)).mappings[0].levels[0].source)
			.toEqual({ column: '_cw.ancestors.group.id' });
	});

	it('keeps mappings without nest unchanged and omits the region', () => {
		const mapping: ImportMapping = { mappings: [{ levels: [
			{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
		] }] };
		const before = JSON.stringify(mapping);
		const regions = toRecipeRegions(mapping);
		expect(regions.nest).toBeUndefined();
		expect(JSON.stringify(mapping)).toBe(before);
		expect(fromRegions(regions)).toEqual(mapping);
	});

	it('drops folder-note leaf when a non-leaf level gains a file name', () => {
		const mapping: ImportMapping = {
			mappings: [{ levels: [
				{ level: 'group', source: { column: '_cw.ancestors.group.id' }, destinations: [{ primitive: 'folder' }, { primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
				{ level: 'part', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
			] }],
			nest: [
				{ level: 'group', id: '{id}', children: 'parts', leaf: 'folder-note', identity: 'global' },
				{ level: 'part', id: '{id}', identity: 'global' },
			],
		};
		const regions = toRecipeRegions(mapping);
		expect(regions.nest?.[0].leaf).toBeUndefined();
		const { nest, ...target } = regions;
		const validation = validateRecipe({
			recipe: 'test:nested-leaf-consistency',
			spec_version: CURRENT_RECIPE_SPEC,
			source: { ontology: 'test', levels: ['group', 'part'], nest },
			target,
		});
		expect(validation.valid).toBe(true);
	});

	it('uniform fixed levels (two folders + a leaf file)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'id', part: 0 }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						{ level: 'level-2', source: { column: 'id', part: 0 }, delimiter: '-', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						{ level: 'leaf', source: { column: 'id' }, filters: ['fs-safe'], destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		});
	});

	it('merged range (the CSF prefix trick — one folder from parts [0,1])', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'prefix', source: { column: 'tid', part: [0, 1] }, delimiter: '.', join: '.', destinations: [{ primitive: 'folder' }], naming: 'joined', missing: 'skip', materialize: false },
						{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		});
	});

	it('ragged tail (variadic block)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
					tail: {
						source: { column: 'tid' },
						delimiter: '.',
						drop_last: true,
						destinations: [{ primitive: 'folder' }],
						naming: 'prefix',
						max_depth: 6,
						on_overflow: 'truncate',
					},
				},
			],
		});
	});

	it('multi-destination row (folder + property + tag off one source)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'level-1',
							source: { column: 'id', part: 0 },
							delimiter: '.',
							destinations: [
								{ primitive: 'folder' },
								{ primitive: 'property', key: 'fn' },
								{ primitive: 'tag', namespace: 'fn' },
							],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		});
	});

	it('link + facet mappings (no layout, two standalone mappings)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'tactic', source: { column: 'tactic' }, destinations: [{ primitive: 'tag', namespace: 'tactic' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
				{
					levels: [
						{ level: 'parent', source: { column: 'parent' }, destinations: [{ primitive: 'link', key: 'parent', direction: 'parent-on-child' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		});
	});

	it('alias + property on a standalone source', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'title',
							source: { column: 'title' },
							filters: ['trim'],
							destinations: [{ primitive: 'property', key: 'title' }, { primitive: 'alias' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		});
	});

	// Pass 1.5 — a list-valued (multi-value) link destination serializes to
	// also_emit.frontmatter.managed_links and reconstructs with list: true.
	it('list-valued link (multi-value `related`) round-trips to managed_links', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'Related Controls',
							source: { column: 'Related Controls' },
							destinations: [{ primitive: 'link', key: 'related', direction: 'parent-on-child', list: true }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		});
	});

	it('X3 crosswalk destination uses the compact default and round-trips', () => {
		const mapping: ImportMapping = {
			mappings: [{
				levels: [{
					level: 'NIST CSF v2 Mapping',
					source: { column: 'NIST CSF v2 Mapping' },
					destinations: [{
						primitive: 'crosswalk',
						toOntology: 'nist-csf-2',
						predicate: 'is_approximate_to',
					}],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			}],
		};
		const regions = toRecipeRegions(mapping);
		expect(regions.crosswalks).toEqual([{ column: 'NIST CSF v2 Mapping', to_ontology: 'nist-csf-2' }]);
		expect(fromRegions(regions)).toEqual(mapping);
	});

	it('X3 crosswalk destination round-trips every optional field', () => {
		assertRoundTrip({
			mappings: [{
				levels: [{
					level: 'Maps to framework',
					source: { column: 'Maps to framework' },
					destinations: [{
						primitive: 'crosswalk',
						toOntology: 'target-framework',
						predicate: 'is_broader_than',
						split: [',', '\n'],
						qualifier: 'strip',
						mappingSetId: 'synthetic-map-set',
					}],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			}],
		});
	});

	it('skips an unnamed crosswalk destination and leaves existing recipes unchanged', () => {
		const unnamed: ImportMapping = {
			mappings: [{
				levels: [{
					level: 'Maps to framework',
					source: { column: 'Maps to framework' },
					destinations: [{ primitive: 'crosswalk', toOntology: null, predicate: 'is_approximate_to' }],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			}],
		};
		expect(toRecipeRegions(unnamed)).toEqual({ layout: [] });
		const existing = toRecipeRegions({
			mappings: [{
				levels: [{
					level: 'leaf',
					source: { column: 'id' },
					destinations: [{ primitive: 'name' }],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			}],
		});
		expect(existing).toEqual({ layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] });
		expect(existing).not.toHaveProperty('crosswalks');
	});

	it('attaches a canonical crosswalk entry to an existing whole-column level', () => {
		const mapping: ImportMapping = {
			mappings: [{
				levels: [{
					level: 'leaf',
					source: { column: 'id' },
					destinations: [
						{ primitive: 'name' },
						{ primitive: 'crosswalk', toOntology: 'target-framework', predicate: 'is_approximate_to' },
					],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			}],
		};
		expect(fromRegions(toRecipeRegions(mapping))).toEqual(mapping);
	});

	// Pass 1.5 — the batch enrichment block round-trips through target.enrichment.
	it('enrichment block round-trips (children_lists + facet_notes + parent_note)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
			enrichment: { children_lists: true, facet_notes: 'notes', parent_note: 'sibling' },
		});
	});

	// A tail's placement is the more specific, wizard-facing knob (variadic-split
	// design §4); it round-trips symmetrically when the mapping's top-level
	// enrichment.parent_note already agrees with it (the shape a real wizard
	// selection produces — see the promotion test below for the one-way case).
	it('tail `placement` round-trips (folder-note) alongside a matching top-level enrichment.parent_note', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false }],
					tail: { source: { column: 'tid' }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'prefix', placement: 'folder-note' },
				},
			],
			enrichment: { parent_note: 'folder-note' },
		});
	});

	// ConstantRef (spec §7f) — literal sources round-trip exactly.
	it('constant property value (CIS `level: "control"` shape)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'control',
							source: { constant: 'control' },
							destinations: [{ primitive: 'property', key: 'level' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		});
	});

	it('constant folder level (a literal `Frameworks/` path prefix)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'root',
							source: { constant: 'Frameworks' },
							destinations: [{ primitive: 'folder' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
						{
							level: 'leaf',
							source: { column: 'id' },
							destinations: [{ primitive: 'name' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		});
	});

	// B7 (2026-07-12 pre-merge review): `AlsoEmit.frontmatter.user_preserve`
	// was declared on the recipe-regions shape but `toRecipeRegions`/
	// `fromRegions` never wrote/read it -- a round-tripped mapping silently
	// lost the field. `ImportMapping.userPreserve` is also_emit-scoped (not
	// per-level), so it round-trips independently of the structural shape.
	it('userPreserve round-trips (also_emit.frontmatter.user_preserve)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
			userPreserve: ['reviewer', '*notes*'],
		});
	});

	it('userPreserve round-trips alongside managed frontmatter + tags', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{
							level: 'leaf',
							source: { column: 'id' },
							destinations: [
								{ primitive: 'name' },
								{ primitive: 'property', key: 'status' },
								{ primitive: 'tag', namespace: 'status' },
							],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
			userPreserve: ['review_status', 'creator_id'],
		});
	});
});

// ===========================================================================
// 3b. Delimiter-set levels — part() / prefix()
// ===========================================================================

describe('delimiter-set levels (part/prefix)', () => {
	/** A CSF-shaped leaf level, reused so each case only states what it is about. */
	const leaf = {
		level: 'leaf',
		source: { column: 'element_identifier' },
		destinations: [{ primitive: 'name' as const }],
		naming: 'part' as const,
		missing: 'skip' as const,
		materialize: false,
	};

	it('round-trips a multi-delimiter part level', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'element_identifier', part: 0 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						{ level: 'level-2', source: { column: 'element_identifier', part: 1 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						leaf,
					],
				},
			],
		});
	});

	it('round-trips a prefix level on a FIXED level (today silently dropped)', () => {
		assertRoundTrip({
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'element_identifier', part: 0 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'prefix', missing: 'skip', materialize: false },
						{ level: 'level-2', source: { column: 'element_identifier', part: 1 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'prefix', missing: 'skip', materialize: false },
						leaf,
					],
				},
			],
		});
	});

	it('emits prefix() for the two CSF folder levels', () => {
		const regions = toRecipeRegions({
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'element_identifier', part: 0 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'prefix', missing: 'skip', materialize: false },
						{ level: 'level-2', source: { column: 'element_identifier', part: 1 }, delimiters: '.-', destinations: [{ primitive: 'folder' }], naming: 'prefix', missing: 'skip', materialize: false },
					],
				},
			],
		});
		expect(regions.layout.map((e) => e.template)).toEqual([
			'{element_identifier|prefix(.-,0)}',
			'{element_identifier|prefix(.-,1)}',
		]);
	});

	// A3 — the whole point of gating on `delimiters`: a legacy single-delimiter
	// level must serialize to the same bytes it did before part()/prefix() existed,
	// so no existing recipe's hash moves.
	it('A3 — a single-delimiter part level still emits split(), byte-identical', () => {
		const regions = toRecipeRegions({
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'id', part: 0 }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						{ level: 'level-2', source: { column: 'id', part: [0, 1] }, delimiter: '.', join: '.', destinations: [{ primitive: 'folder' }], naming: 'joined', missing: 'skip', materialize: false },
						{ level: 'leaf', source: { column: 'id' }, filters: ['fs-safe'], destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		});
		expect(regions.layout.map((e) => e.template)).toEqual([
			'{id|split(.,0)}',
			'{id|split(.,0)}.{id|split(.,1)}',
			'{id|fs-safe}.md',
		]);
	});

	it('escapes , and ) in the delimiter set and reads them back', () => {
		const m: ImportMapping = {
			mappings: [
				{
					levels: [
						{ level: 'level-1', source: { column: 'id', part: 0 }, delimiters: ',)', destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
						{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					],
				},
			],
		};
		expect(toRecipeRegions(m).layout[0].template).toBe('{id|part(\\,\\),0)}');
		expect(fromRegions(toRecipeRegions(m))).toEqual(m);
	});

	it('merges consecutive part() indices on one column into a range', () => {
		const regions: RecipeRegions = {
			layout: [
				{ level: 'pfx', mechanism: 'folder', template: '{tid|part(.-,0)}.{tid|part(.-,1)}' },
				{ level: 'leaf', mechanism: 'file', template: '{tid}.md' },
			],
		};
		const level = fromRegions(regions).mappings[0].levels[0];
		expect(level.source).toEqual({ column: 'tid', part: [0, 1] });
		expect(level.delimiters).toBe('.-');
		expect(level.join).toBe('.');
		// A merged range is `joined`, exactly as the split() form already reads.
		expect(level.naming).toBe('joined');
		// …and re-serializes to the template it came from.
		expect(toRecipeRegions(fromRegions(regions)).layout[0].template).toBe(regions.layout[0].template);
	});

	it('source signature separates levels that differ only by delimiter set', () => {
		const shared: RecipeRegions = {
			layout: [{ level: 'l1', mechanism: 'folder', template: '{id|part(.-,0)}' }],
			also_emit: { frontmatter: { managed: { family: '{id|part(.-,0)}' } } },
		};
		const differing: RecipeRegions = {
			layout: [{ level: 'l1', mechanism: 'folder', template: '{id|part(.-,0)}' }],
			also_emit: { frontmatter: { managed: { family: '{id|part(.,0)}' } } },
		};
		// Same set → the property regroups onto the structural level.
		expect(fromRegions(shared).mappings.length).toBe(1);
		expect(fromRegions(shared).mappings[0].levels[0].destinations).toEqual([
			{ primitive: 'folder' },
			{ primitive: 'property', key: 'family' },
		]);
		// Different set → a separate standalone mapping, not a silent merge.
		expect(fromRegions(differing).mappings.length).toBe(2);
	});

	it('a single-character set parsed from part() stays a set, so it round-trips exactly', () => {
		const regions: RecipeRegions = {
			layout: [{ level: 'l1', mechanism: 'folder', template: '{id|part(.,0)}' }],
		};
		const back = fromRegions(regions);
		expect(back.mappings[0].levels[0].delimiters).toBe('.');
		expect(back.mappings[0].levels[0].delimiter).toBeUndefined();
		expect(toRecipeRegions(back).layout[0].template).toBe('{id|part(.,0)}');
	});
});

// ===========================================================================
// 4. Lossy-field pinning (known spec gaps)
// ===========================================================================

describe('lossy fields (no recipe surface — pinned so the gap stays visible)', () => {
	it('per-level `missing` and `materialize` do NOT survive serialization', () => {
		const m: ImportMapping = {
			mappings: [
				{
					levels: [
						{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'error', materialize: true },
					],
				},
			],
		};
		const back = fromRegions(toRecipeRegions(m));
		const leaf = back.mappings[0].levels[0];
		// TODO(architect): wire a recipe surface for per-level missing policy + materialize.
		expect(leaf.missing).toBe('skip');
		expect(leaf.materialize).toBe(false);
	});

	it('row filters do NOT survive serialization', () => {
		const m: ImportMapping = {
			mappings: [
				{ levels: [{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false }] },
			],
			filters: [{ column: 'status', op: 'equals', value: 'active' }],
		};
		const back = fromRegions(toRecipeRegions(m));
		// TODO(architect): recipes have no row-filter region yet.
		expect(back.filters).toBeUndefined();
	});

});

// ===========================================================================
// 4b. tail.placement → enrichment.parent_note promotion (no longer lossy)
// ===========================================================================

// `parent_note` (sibling|folder-note) shipped as a real engine behavior
// (2026-07-10 batch-enrichment design, folder-note relocation chunk). The
// recipe has exactly ONE global `target.enrichment.parent_note` scope, so a
// tail's `placement` — set without an explicit top-level `enrichment` block,
// e.g. by a preset/detection that only knows about the tail — PROMOTES to
// that global scope on serialization. This is a one-way widening (a NEW
// top-level `enrichment` field appears that wasn't in the input), so it is
// intentionally NOT exercised via `assertRoundTrip` (which asserts exact
// symmetry) — see the symmetric case in the round-trip law section above for
// how a wizard-authored mapping (tail.placement + a matching top-level
// enrichment.parent_note) round-trips exactly.
describe('tail.placement promotes to the recipe global enrichment.parent_note', () => {
	it('a tail-only placement (no top-level enrichment) sets target.enrichment.parent_note', () => {
		const m: ImportMapping = {
			mappings: [
				{
					levels: [{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false }],
					tail: { source: { column: 'tid' }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'prefix', placement: 'folder-note' },
				},
			],
		};
		const regions = toRecipeRegions(m);
		expect(regions.enrichment).toEqual({ parent_note: 'folder-note' });

		const back = fromRegions(regions);
		expect(back.mappings[0].tail!.placement).toBe('folder-note');
	});

	// Precedence (2026-07-11 fix): when a tail carries a STALE placement that
	// disagrees with the mapping's top-level enrichment.parent_note, the
	// top-level value — the knob the workbench UI's placement chooser writes
	// via `updateEnrichment` — always wins. This is exactly the shape a
	// round-tripped mapping can end up in: `fromRegions` stamps `tail.placement`
	// from whatever `enrichment.parent_note` a PRIOR serialization carried (the
	// promotion tested above, in reverse), and a later UI click only patches
	// `mapping.enrichment` (by design — see `updateEnrichment` in workbench.ts),
	// leaving the tail's own placement stale. Before this fix, the stale tail
	// value silently out-voted the user's fresh top-level choice on every
	// `toRecipeRegions` call — found via the 2026-07-11 folder-note placement
	// repro (visual-report-and-graph.spec.ts), though the ROOT cause of that
	// specific repro turned out to be a separate defect in
	// generation/enrich.ts's relocation eligibility (path-structural now,
	// previously gated on parent-link edges that a plain packed hierarchy never
	// produces). This precedence fix is a second, independently real bug this
	// investigation surfaced: it only bites a round-tripped mapping, not a
	// fresh instantiation (no built-in preset stamps `tail.placement`).
	it('a STALE tail.placement never overrides an explicit top-level enrichment.parent_note', () => {
		const m: ImportMapping = {
			mappings: [
				{
					levels: [{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false }],
					// Stale: a prior round trip stamped this from an earlier 'sibling' config.
					tail: { source: { column: 'tid' }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'prefix', placement: 'sibling' },
				},
			],
			// Fresh: the user just clicked "Folder note" in the placement chooser.
			enrichment: { parent_note: 'folder-note' },
		};
		const regions = toRecipeRegions(m);
		expect(regions.enrichment?.parent_note).toBe('folder-note');
	});

	// Symmetric case: a tail's placement still fills the gap when the
	// top-level enrichment block doesn't specify parent_note at all (the
	// escape-hatch role — see the promotion test above).
	it('tail.placement still fills in when enrichment.parent_note is unspecified (escape hatch preserved)', () => {
		const m: ImportMapping = {
			mappings: [
				{
					levels: [{ level: 'leaf', source: { column: 'tid' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false }],
					tail: { source: { column: 'tid' }, delimiter: '.', destinations: [{ primitive: 'folder' }], naming: 'prefix', placement: 'folder-note' },
				},
			],
			enrichment: { children_lists: true }, // present, but no parent_note opinion
		};
		const regions = toRecipeRegions(m);
		expect(regions.enrichment?.parent_note).toBe('folder-note');
	});
});

// ===========================================================================
// 5. Corpus reconstruction of real recipes
// ===========================================================================

/** Compare serialized regions to a recipe's own target regions (order-tolerant on managed). */
function assertReSerializesEquivalent(recipe: { target: RecipeRegions }): void {
	const mapping = fromRecipe(recipe as { target: RecipeRegions });
	const regions = toRecipeRegions(mapping);
	expect(regions.layout).toEqual(recipe.target.layout);
	const originalManaged = recipe.target.also_emit?.frontmatter?.managed ?? {};
	const roundManaged = regions.also_emit?.frontmatter?.managed ?? {};
	expect(roundManaged).toEqual(originalManaged);
}

describe('corpus — real recipes reconstruct + re-serialize equivalently', () => {
	it('nist-csf-2-cprt-hierarchical (folder / folder / file + merged managed properties)', () => {
		const mapping = fromRecipe(csfRecipe as unknown as { target: RecipeRegions });
		// Structural mapping present with three layout-derived levels.
		const structural = mapping.mappings[0];
		expect(structural.levels.length).toBe(3);
		expect(structural.levels[0].destinations.some((d) => d.primitive === 'folder')).toBe(true);
		// The function/category managed props re-group onto their folder levels (shared source).
		expect(structural.levels[0].destinations.some((d) => d.primitive === 'property')).toBe(true);
		assertReSerializesEquivalent(csfRecipe as unknown as { target: RecipeRegions });
	});

	it('mitre-attack-technique (single file leaf + standalone managed properties)', () => {
		const mapping = fromRecipe(mitreRecipe as unknown as { target: RecipeRegions });
		const structural = mapping.mappings[0];
		expect(structural.levels[0].destinations).toEqual([{ primitive: 'name' }]);
		// REPINNED 2026-08-26 (was `external_references.0.external_id`). The recipe was
		// deliberately retargeted from a STIX bundle shape to the tracked
		// Frameworks/enterprise-attack-v16.1.xlsx `techniques` sheet, whose id column is
		// `ID`. No STIX bundle is tracked by this project, so the old binding could never
		// have matched a file the repo actually has; the xlsx binding is E2E-verified on
		// all 656 techniques (tests/e2e/full-mitre-attack-import.spec.ts) and documented
		// at length in that recipe's $comment. Only the source COLUMN moved: the layout
		// mechanism, the one-file-per-technique shape, and the T1548.md filenames are
		// unchanged, which is why the round-trip half of this test never went red.
		expect(structural.levels[0].source).toEqual({ column: 'ID' });
		assertReSerializesEquivalent(mitreRecipe as unknown as { target: RecipeRegions });
	});

	it('cis-controls-v8-controls (leaf with a trim|fs-safe filter chain + a constant property)', () => {
		const recipe = cisRecipe as unknown as { target: RecipeRegions };
		const mapping = fromRecipe(recipe);
		expect(mapping.mappings[0].levels[0].filters).toEqual(['trim', 'fs-safe']);
		// The constant managed value ("level": "control", no {template}) reconstructs as a
		// ConstantRef source (spec §7f), not a column reference.
		const levelMapping = mapping.mappings.find((m) =>
			m.levels.some((l) => l.destinations.some((d) => d.primitive === 'property' && d.key === 'level')),
		);
		expect(levelMapping).toBeDefined();
		expect(levelMapping!.levels[0].source).toEqual({ constant: 'control' });
		// Layout (the single file leaf) round-trips exactly.
		const regions = toRecipeRegions(mapping);
		expect(regions.layout).toEqual(recipe.target.layout);
		// FULL FIDELITY (spec §7f): every managed value now round-trips exactly — the
		// constant `level: "control"` is no longer flattened to a `{control}` reference.
		const originalManaged = recipe.target.also_emit!.frontmatter!.managed!;
		const roundManaged = regions.also_emit!.frontmatter!.managed!;
		expect(roundManaged).toEqual(originalManaged);
	});
});

// ===========================================================================
// 5b. B7 (2026-07-12 pre-merge review) — fromRecipe → toRecipeRegions
//     round-trip for a hand-authored recipe carrying user_preserve. The
//     original probe: fromRecipe({...user_preserve: ['reviewer','*notes*']})
//     → toRecipeRegions(...) produced also_emit.frontmatter.user_preserve
//     === undefined.
// ===========================================================================

describe('user_preserve survives fromRecipe → toRecipeRegions (B7)', () => {
	it('a hand-authored recipe carrying user_preserve re-emits it verbatim', () => {
		const recipe = {
			target: {
				layout: [
					{ level: 'leaf', mechanism: 'file' as const, template: '{id}.md' },
				],
				also_emit: {
					frontmatter: {
						managed: { status: '{status}' },
						user_preserve: ['reviewer', '*notes*'],
					},
				},
			},
		};
		const mapping = fromRecipe(recipe);
		expect(mapping.userPreserve).toEqual(['reviewer', '*notes*']);

		const regions = toRecipeRegions(mapping);
		expect(regions.also_emit?.frontmatter?.user_preserve).toEqual(['reviewer', '*notes*']);
	});
});

// ===========================================================================
// 6. Determinism
// ===========================================================================

describe('determinism', () => {
	const csf = ['GV.OC-01', 'GV.OC-02', 'DE.AE-02', 'DE.AE-03', 'PR.AA-05', 'ID.AM-01'];

	it('instantiate is deterministic (same inputs → deep-equal)', () => {
		const detections = detect(rowsFrom('element_identifier', csf));
		expect(instantiate(BROWSABLE_FRAMEWORK, detections)).toEqual(instantiate(BROWSABLE_FRAMEWORK, detections));
	});

	it('toRecipeRegions is deterministic', () => {
		const detections = detect(rowsFrom('element_identifier', csf));
		const m = instantiate(getBuiltInPreset('deep-everything')!, detections);
		expect(toRecipeRegions(m)).toEqual(toRecipeRegions(m));
	});
});
