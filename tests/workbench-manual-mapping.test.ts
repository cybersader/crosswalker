/**
 * workbench-manual-mapping.test.ts — "Add mapping from a column" seeds the
 * column's own detected levels (deliverable D, 2026-09-14).
 *
 * The reported defect: opening the chooser and picking a packed id column
 * (values like `GV.OC-01` / `GV.OC-01.01`) produced a mapping with exactly one
 * level, the note itself. `view-model.ts`'s `eligibleRows` computes every
 * non-`name` card over the NON-leaf rows, so an all-leaf mapping left the Folder
 * card with nothing to write to and it rendered dead. Detection already
 * classified that column as a packed hierarchy with a fixed-folders proposal;
 * only the manual path ignored it.
 *
 * `addManualMapping` is private (it is what the chooser option's click handler
 * calls), reached the same way `workbench-recipe.test.ts` drives the other
 * private write paths: a narrow cast.
 */

import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ParsedData } from '../src/types/config';
import type { StructureMapping } from '../src/import/mapping/types';
import { shapeCardHint } from '../src/import/mapping/view-model';
import type { DebugLog } from '../src/utils/debug';

const debug = {
	info() {},
	trace() {},
	warn() {},
	error() {},
} as unknown as DebugLog;

interface PrivateWorkbench {
	addManualMapping(column: string): void;
	removeMapping(index: number): void;
	structuralMappingTitles(): string[];
}

function priv(wb: MappingWorkbench): PrivateWorkbench {
	return wb as unknown as PrivateWorkbench;
}

function makeWorkbench(rows: Record<string, unknown>[]): MappingWorkbench {
	const columns = rows.length ? Object.keys(rows[0]) : [];
	const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Ontologies',
		debug,
		defaultPresetId: 'browsable-framework',
		onChange: () => {},
	});
}

/**
 * A uniform packed id column (`concept_id`), same SHAPE as the user's source
 * (a dotted id that splits into levels) with invented values. `label` carries
 * separator-free single words, so it draws no structural detection at all and
 * serves as the regression pin for the unchanged branch.
 */
function packedRows(): Record<string, unknown>[] {
	const groups = ['AA', 'AB', 'AC'];
	const labels = [
		'Alpha', 'Bravo', 'Charlie', 'Delta',
		'Echo', 'Foxtrot', 'Golf', 'Hotel',
		'India', 'Juliet', 'Kilo', 'Lima',
	];
	const rows: Record<string, unknown>[] = [];
	groups.forEach((group, g) => {
		for (let i = 1; i <= 4; i++) {
			rows.push({
				concept_id: `${group}.0${i}`,
				label: labels[g * 4 + (i - 1)],
			});
		}
	});
	return rows;
}

/**
 * Three columns of strictly increasing cardinality with clean parent→child
 * agreement, which is what `detectLevelColumnChain` looks for. No column holds a
 * separator, so no packed hierarchy competes with the chain.
 */
function chainRows(): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	const tier1 = ['Govern', 'Protect'];
	for (let a = 0; a < 2; a++) {
		for (let b = 0; b < 2; b++) {
			for (let c = 0; c < 2; c++) {
				for (let d = 0; d < 2; d++) {
					rows.push({
						tier1: tier1[a],
						tier2: `${tier1[a]} area ${b + 1}`,
						tier3: `${tier1[a]} topic ${b + 1}${c + 1}`,
						detail: `Row detail ${a}${b}${c}${d}`,
					});
				}
			}
		}
	}
	return rows;
}

function addedMapping(wb: MappingWorkbench): StructureMapping {
	const mappings = wb.getMapping().mappings;
	return mappings[mappings.length - 1];
}

/** Strip every structural mapping through the workbench's own remove path. */
function removeAllStructural(wb: MappingWorkbench): void {
	for (;;) {
		const index = wb.getMapping().mappings.findIndex((m) =>
			m.levels.some((l) => l.destinations.some((d) => d.primitive === 'folder' || d.primitive === 'name' || d.primitive === 'heading'))
			|| (m.tail !== undefined && m.tail.destinations.some((d) => d.primitive === 'folder' || d.primitive === 'name' || d.primitive === 'heading')),
		);
		if (index === -1) return;
		priv(wb).removeMapping(index);
	}
}

describe('D1: manual add of a packed column with NO structural mapping seeds the detected levels', () => {
	it('produces folder levels plus a name leaf, so the Folder card is available', () => {
		const wb = makeWorkbench(packedRows());
		removeAllStructural(wb);
		expect(priv(wb).structuralMappingTitles()).toEqual([]);

		priv(wb).addManualMapping('concept_id');
		const added = addedMapping(wb);

		// More than one level: the defect produced exactly one.
		expect(added.levels.length).toBeGreaterThan(1);

		const leaf = added.levels[added.levels.length - 1];
		const nonLeaf = added.levels.slice(0, -1);
		expect(nonLeaf.length).toBeGreaterThan(0);
		for (const level of nonLeaf) {
			expect(level.destinations.some((d) => d.primitive === 'folder')).toBe(true);
		}
		expect(leaf.destinations).toContainEqual({ primitive: 'name' });

		// The user-visible symptom: the Folder card is actionable (no "why this
		// card is dead" hint) instead of reading "Not available".
		expect(shapeCardHint(added, 'folder')).toBeNull();
	});
});

describe('D2: manual add of a packed column WITH a structural mapping seeds the same levels, unrouted', () => {
	it('keeps the level count, clears non-leaf destinations, and routes the leaf to a property', () => {
		const wb = makeWorkbench(packedRows());
		const structuralBefore = priv(wb).structuralMappingTitles().length;
		expect(structuralBefore).toBe(1);
		const autoLevelCount = wb.getMapping().mappings[0].levels.length;

		priv(wb).addManualMapping('concept_id');
		const added = addedMapping(wb);

		expect(added.levels).toHaveLength(autoLevelCount);
		expect(added.levels.length).toBeGreaterThan(1);
		for (const level of added.levels.slice(0, -1)) {
			expect(level.destinations).toEqual([]);
		}
		expect(added.levels[added.levels.length - 1].destinations).toEqual([
			{ primitive: 'property', key: 'concept_id' },
		]);

		// No second structural mapping was created, and the recipe still builds.
		expect(priv(wb).structuralMappingTitles()).toHaveLength(structuralBefore);
		expect(() => wb.buildRecipe()).not.toThrow();
	});
});

describe('D3: a column with no structural detection keeps the original leaf-only seed', () => {
	it('routes to a frontmatter property when a structural mapping already exists', () => {
		const wb = makeWorkbench(packedRows());
		expect(priv(wb).structuralMappingTitles().length).toBe(1);

		priv(wb).addManualMapping('label');
		const added = addedMapping(wb);

		expect(added.levels).toHaveLength(1);
		expect(added.levels[0].destinations).toEqual([{ primitive: 'property', key: 'label' }]);
	});

	it('seeds a file name when no structural mapping exists', () => {
		const wb = makeWorkbench(packedRows());
		removeAllStructural(wb);
		expect(priv(wb).structuralMappingTitles()).toEqual([]);

		priv(wb).addManualMapping('label');
		const added = addedMapping(wb);

		expect(added.levels).toHaveLength(1);
		expect(added.levels[0].destinations).toEqual([{ primitive: 'name' }]);
	});
});

describe('D4: a level-column chain is seeded only from its LAST column', () => {
	it('the last chain column brings the whole chain', () => {
		const wb = makeWorkbench(chainRows());
		const structuralBefore = priv(wb).structuralMappingTitles().length;

		priv(wb).addManualMapping('tier3');
		const added = addedMapping(wb);

		// The chain columns become folder levels, topped by the leaf; the SHALLOWEST
		// chain column leads, which is what proves the whole chain came in.
		expect(added.levels.length).toBeGreaterThan(1);
		expect(added.levels[0].source).toEqual({ column: 'tier1' });
		expect(priv(wb).structuralMappingTitles()).toHaveLength(structuralBefore);
		expect(() => wb.buildRecipe()).not.toThrow();
	});

	it('a middle chain column stays leaf-only (picking it must not drag the chain in)', () => {
		const wb = makeWorkbench(chainRows());

		priv(wb).addManualMapping('tier2');
		const added = addedMapping(wb);

		expect(added.levels).toHaveLength(1);
	});
});
