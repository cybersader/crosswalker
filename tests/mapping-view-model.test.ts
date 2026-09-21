/**
 * mapping-view-model.test.ts — the view-coherence law's pure operations (spec §3a½/§7a).
 *
 * Covers the writes a coarse view performs on the one ImportMapping (card
 * toggles, row merge/split, add/remove destination) and the reads the views
 * render from it (shape-card summary incl. the honest `mixed` state, preset-drift
 * detection for the Custom label). Every function must be pure — asserted by
 * checking the input is never mutated.
 */

import { detectStructure } from '../src/import/detection';
import type { Detection } from '../src/import/detection';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ParsedData } from '../src/types/config';

import { BROWSABLE_FRAMEWORK, DEEP_EVERYTHING } from '../src/import/mapping/presets';
import { instantiate } from '../src/import/mapping/instantiate';
import { toRecipeRegions, fromRegions } from '../src/import/mapping/serialize';
import type { StructureMapping, ImportMapping } from '../src/import/mapping/types';
import {
	deriveShapeCards,
	toggleDestinationAcrossMapping,
	addDestination,
	setCrosswalkTarget,
	removeDestination,
	mergeRows,
	splitRow,
	splitIntoLevels,
	isUnmodifiedPreset,
	structuralEqual,
	shapeCardHint,
	blockedPlacingToggle,
	hasPlacingDestination,
	NO_PLACE_TO_LAND,
} from '../src/import/mapping/view-model';
import { explainRecipeError, NOTHING_PLACED_MESSAGE } from '../src/import/mapping/diagnostics';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function detect(rows: Record<string, unknown>[]): Detection[] {
	const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
	const data: ParsedData = { columns, rows, rowCount: rows.length };
	return detectStructure(data, analyzeColumns(data));
}

function rowsFrom(column: string, values: string[]): Record<string, unknown>[] {
	return values.map((v) => ({ [column]: v }));
}

// Uniform two-delimiter CSF ids → fixed folder levels + a leaf.
const CSF = ['GV.OC-01', 'GV.OC-02', 'DE.AE-02', 'DE.AE-03', 'PR.AA-05', 'ID.AM-01'];
// Ragged ATT&CK ids → variadic tail + leaf.
const ATTACK = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];

function csfMapping(): StructureMapping {
	return instantiate(BROWSABLE_FRAMEWORK, detect(rowsFrom('element_identifier', CSF))).mappings[0];
}

/**
 * A single-level, leaf-only mapping — exactly what `instantiate.leafLevel` and
 * the workbench's first manual "add mapping from a column" produce when nothing
 * about the column was detected as a packed hierarchy. Every non-name card has
 * ZERO eligible rows here, which is the state that used to render as a dead
 * "Off" checkbox with no explanation.
 */
function leafOnlyMapping(column = 'profile_id'): StructureMapping {
	return {
		levels: [{
			level: column,
			source: { column },
			destinations: [{ primitive: 'name' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}],
	};
}

/** A mapping with no leaf at all (the manual "route this column" default). */
function propertyOnlyMapping(column = 'owner'): StructureMapping {
	return {
		levels: [{
			level: column,
			source: { column },
			destinations: [{ primitive: 'property', key: column }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}],
	};
}

// ===========================================================================
// 1. Shape-card summary derivation
// ===========================================================================

describe('crosswalk destination controls', () => {
	function x1Rows(): Record<string, unknown>[] {
		return Array.from({ length: 8 }, (_, index) => ({
			'Profile Id': `GV.OC-${String(index + 1).padStart(2, '0')}.01`,
			'NIST CSF v2 Mapping': 'GV.OC-01.01 (Synthetic note)\nGV.OC-02.01',
		}));
	}

	function x5Rows(): Record<string, unknown>[] {
		return Array.from({ length: 6 }, (_, index) => ({
			id: `SRC${String(index + 1).padStart(3, '0')}`,
			'Maps to ISO 27001': 'A.5.1, A.5.2',
		}));
	}

	it('instantiates X1 and X5 crosswalk offers under every preset', () => {
		const x1 = instantiate(BROWSABLE_FRAMEWORK, detect(x1Rows())).mappings.find((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		const x5 = instantiate(DEEP_EVERYTHING, detect(x5Rows())).mappings.find((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		expect(x1?.levels[0].destinations).toContainEqual({
			primitive: 'crosswalk',
			toOntology: 'nist-csf-2',
			predicate: 'is_approximate_to',
		});
		expect(x5?.levels[0].destinations).toContainEqual({
			primitive: 'crosswalk',
			toOntology: null,
			predicate: 'is_approximate_to',
		});
	});

	it('derives, toggles, and configures a crosswalk destination immutably', () => {
		const original = propertyOnlyMapping('Maps to framework');
		const added = addDestination(original, 0, 'crosswalk');
		expect(deriveShapeCards(added).crosswalk).toBe('on');
		expect(deriveShapeCards(csfMapping()).crosswalk).toBe('off');
		expect(added.levels[0].destinations).toContainEqual({
			primitive: 'crosswalk',
			toOntology: null,
			predicate: 'is_approximate_to',
		});

		const configured = setCrosswalkTarget(added, 0, {
			toOntology: 'iso-27001',
			predicate: 'is_equivalent_to',
		});
		expect(configured).not.toBe(added);
		expect(configured.levels[0]).not.toBe(added.levels[0]);
		expect(configured.levels[0].destinations).toContainEqual({
			primitive: 'crosswalk',
			toOntology: 'iso-27001',
			predicate: 'is_equivalent_to',
		});
		expect(added.levels[0].destinations).toContainEqual({
			primitive: 'crosswalk',
			toOntology: null,
			predicate: 'is_approximate_to',
		});
		expect(toggleDestinationAcrossMapping(configured, 'crosswalk', false).levels[0].destinations)
			.not.toContainEqual(expect.objectContaining({ primitive: 'crosswalk' }));
	});

	it('explains when no level reads one real column', () => {
		expect(shapeCardHint(propertyOnlyMapping(), 'crosswalk')).toBeNull();
		const noColumn: StructureMapping = {
			levels: [{
				level: 'combined',
				source: [{ column: 'left' }, { column: 'right' }],
				destinations: [{ primitive: 'property', key: 'combined' }],
				naming: 'joined',
				missing: 'skip',
				materialize: false,
			}],
		};
		expect(shapeCardHint(noColumn, 'crosswalk')).toBe(
			'Crosswalks need a level that reads one column. This mapping has none.',
		);
	});
});

describe('deriveShapeCards', () => {
	it('browsable CSF → folders on, file names on, everything else off', () => {
		const cards = deriveShapeCards(csfMapping());
		expect(cards.folder).toBe('on');
		expect(cards.name).toBe('on');
		expect(cards.tag).toBe('off');
		expect(cards.property).toBe('off');
		expect(cards.link).toBe('off');
		expect(cards.heading).toBe('off');
	});

	it('deep-everything CSF → folders AND tags on across interior levels', () => {
		const m = instantiate(DEEP_EVERYTHING, detect(rowsFrom('element_identifier', CSF))).mappings[0];
		const cards = deriveShapeCards(m);
		expect(cards.folder).toBe('on');
		expect(cards.tag).toBe('on');
		expect(cards.name).toBe('on');
	});

	it('ragged ATT&CK → folders on (from the tail), file names on', () => {
		const m = instantiate(BROWSABLE_FRAMEWORK, detect(rowsFrom('technique_id', ATTACK))).mappings[0];
		const cards = deriveShapeCards(m);
		expect(cards.folder).toBe('on');
		expect(cards.name).toBe('on');
	});

	it('reports a genuinely divergent row set as mixed, never a wrong binary', () => {
		const m = csfMapping();
		// Remove folder from just the FIRST interior level → folder now on some, not all.
		const edited = removeDestination(m, 0, 'folder');
		expect(deriveShapeCards(edited).folder).toBe('mixed');
	});
});

// ===========================================================================
// 2. Card toggles (coarse write across a mapping)
// ===========================================================================

describe('toggleDestinationAcrossMapping', () => {
	it('turning Tags on adds a tag to every interior level; card reads on', () => {
		const before = csfMapping();
		const after = toggleDestinationAcrossMapping(before, 'tag', true);
		expect(deriveShapeCards(after).tag).toBe('on');
		// Input is never mutated (purity).
		expect(deriveShapeCards(before).tag).toBe('off');
	});

	it('turning Folders off removes folders across the mapping; card reads off', () => {
		const after = toggleDestinationAcrossMapping(csfMapping(), 'folder', false);
		expect(deriveShapeCards(after).folder).toBe('off');
	});

	it('a card toggle round-trips back to the same state', () => {
		const base = csfMapping();
		const on = toggleDestinationAcrossMapping(base, 'property', true);
		expect(deriveShapeCards(on).property).toBe('on');
		const off = toggleDestinationAcrossMapping(on, 'property', false);
		expect(deriveShapeCards(off).property).toBe('off');
		// Round-trip preserves the rest of the mapping (structural equality with base).
		expect(structuralEqual(off, base)).toBe(true);
	});

	it('toggled-on destinations still serialize (the write stays recipe-valid)', () => {
		const after = toggleDestinationAcrossMapping(csfMapping(), 'tag', true);
		const regions = toRecipeRegions({ mappings: [after] });
		expect(regions.also_emit?.tags?.length ?? 0).toBeGreaterThan(0);
	});
});

// ===========================================================================
// 2b. A card that cannot be turned on says why (no silent no-ops)
// ===========================================================================

describe('shapeCardHint', () => {
	it('a leaf-only single-level mapping reports Folders as unavailable, with a cause and an action', () => {
		const m = leafOnlyMapping();
		expect(deriveShapeCards(m).folder).toBe('off');
		const hint = shapeCardHint(m, 'folder');
		expect(hint).not.toBeNull();
		expect(hint).toContain('one level');
		expect(hint).toContain('separator');
		expect(hint).toContain('Map a column whose values split that way');
	});

	it('every non-name card on that mapping is unavailable, not merely off', () => {
		const m = leafOnlyMapping();
		for (const primitive of ['folder', 'tag', 'heading', 'link', 'property'] as const) {
			expect(shapeCardHint(m, primitive)).not.toBeNull();
		}
	});

	it('builds the worked example from a real sample value when one is supplied', () => {
		const hint = shapeCardHint(leafOnlyMapping(), 'folder', { sampleValue: 'GV.OC-01.01' });
		expect(hint).toContain('GV.OC-01.01 splits into GV, then GV.OC, then GV.OC-01, then GV.OC-01.01');
	});

	it('falls back to a generic example when the sample value has no separator', () => {
		const hint = shapeCardHint(leafOnlyMapping(), 'folder', { sampleValue: 'Governance' });
		expect(hint).toContain('GV.OC-01 splits into GV, then GV.OC, then GV.OC-01');
	});

	it('File names is unavailable on a mapping with no leaf row, and points at the matrix', () => {
		const m = propertyOnlyMapping();
		expect(deriveShapeCards(m).name).toBe('off');
		const hint = shapeCardHint(m, 'name');
		expect(hint).not.toBeNull();
		expect(hint).toContain('Arrange levels');
	});

	it('is null for every card a real preset mapping can actually carry', () => {
		const m = csfMapping();
		expect(shapeCardHint(m, 'folder')).toBeNull();
		expect(shapeCardHint(m, 'tag')).toBeNull();
		expect(shapeCardHint(m, 'name')).toBeNull();
	});

	it('the unavailable cards are exactly the toggles that would do nothing', () => {
		const m = leafOnlyMapping();
		// The silent no-op this hint replaces: the write returns the mapping unchanged.
		const after = toggleDestinationAcrossMapping(m, 'folder', true);
		expect(structuralEqual(after, m)).toBe(true);
		expect(deriveShapeCards(after).folder).toBe('off');
		expect(shapeCardHint(m, 'folder')).not.toBeNull();

		const nameOn = toggleDestinationAcrossMapping(propertyOnlyMapping(), 'name', true);
		expect(structuralEqual(nameOn, propertyOnlyMapping())).toBe(true);
		expect(shapeCardHint(propertyOnlyMapping(), 'name')).not.toBeNull();
	});
});

// ===========================================================================
// 2c. Never leave the import with nowhere to put its notes
// ===========================================================================

describe('blockedPlacingToggle', () => {
	it('blocks turning File names off when it is the only thing placing notes', () => {
		const mapping: ImportMapping = { mappings: [leafOnlyMapping()] };
		expect(blockedPlacingToggle(mapping, 0, 'name', false)).toBe(NO_PLACE_TO_LAND);
	});

	it('allows it once the same mapping also has folders', () => {
		// A browsable preset keeps its folder levels when the leaf name goes away.
		const mapping: ImportMapping = { mappings: [csfMapping()] };
		expect(blockedPlacingToggle(mapping, 0, 'name', false)).toBeNull();
	});

	it('allows it when another mapping still places notes (the two-structural fix)', () => {
		const mapping: ImportMapping = { mappings: [csfMapping(), leafOnlyMapping()] };
		expect(blockedPlacingToggle(mapping, 1, 'name', false)).toBeNull();
		// And unticking BOTH cards on the first mapping stays possible.
		const noFolders: ImportMapping = {
			mappings: [toggleDestinationAcrossMapping(csfMapping(), 'folder', false), leafOnlyMapping()],
		};
		expect(blockedPlacingToggle(noFolders, 0, 'name', false)).toBeNull();
	});

	it('never blocks turning a card ON, or touching a non-placing card', () => {
		const mapping: ImportMapping = { mappings: [leafOnlyMapping()] };
		expect(blockedPlacingToggle(mapping, 0, 'name', true)).toBeNull();
		expect(blockedPlacingToggle(mapping, 0, 'tag', false)).toBeNull();
		expect(blockedPlacingToggle(mapping, 0, 'property', false)).toBeNull();
	});

	it('is a no-op on an out-of-range mapping index', () => {
		expect(blockedPlacingToggle({ mappings: [leafOnlyMapping()] }, 7, 'name', false)).toBeNull();
	});

	it('hasPlacingDestination sees folder, name and one file, not metadata', () => {
		expect(hasPlacingDestination(leafOnlyMapping())).toBe(true);
		expect(hasPlacingDestination(csfMapping())).toBe(true);
		expect(hasPlacingDestination(propertyOnlyMapping())).toBe(false);
		expect(hasPlacingDestination(toggleDestinationAcrossMapping(propertyOnlyMapping(), 'heading', true))).toBe(true);
	});
});

// ===========================================================================
// 2d. The empty-layout validator error, in plain language
// ===========================================================================

describe('explainRecipeError', () => {
	it('translates both halves of the empty-layout error', () => {
		expect(explainRecipeError('/source/levels: must NOT have fewer than 1 items')).toBe(NOTHING_PLACED_MESSAGE);
		expect(explainRecipeError('/target/layout: must NOT have fewer than 1 items')).toBe(NOTHING_PLACED_MESSAGE);
	});

	it('translates the joined message the recipe builder actually throws', () => {
		// Verbatim from `buildRecipe()` on a mapping with no placing destination.
		const joined = '/source/levels: must NOT have fewer than 1 items; /target/layout: must NOT have fewer than 1 items';
		expect(explainRecipeError(joined)).toBe(NOTHING_PLACED_MESSAGE);
	});

	it('is insensitive to the validator\'s casing of NOT', () => {
		expect(explainRecipeError('/target/layout must not have fewer than 1 items')).toBe(NOTHING_PLACED_MESSAGE);
	});

	it('names a cause and an action, and leaks no validator vocabulary', () => {
		expect(NOTHING_PLACED_MESSAGE).toContain('No column is set to place notes in the vault');
		expect(NOTHING_PLACED_MESSAGE).toContain('turn on File names, Folders, or One file');
		expect(NOTHING_PLACED_MESSAGE).not.toMatch(/\/source|\/target|items|schema|debug log/);
	});

	it('leaves an unrelated error untouched so the caller keeps its own wording', () => {
		expect(explainRecipeError('Two mappings both shape the vault')).toBeNull();
		expect(explainRecipeError('/target/layout/0/template: must be string')).toBeNull();
		expect(explainRecipeError('must NOT have fewer than 1 items')).toBeNull();
	});
});

// ===========================================================================
// 3. Add / remove a single destination (matrix ⊕ + chip remove)
// ===========================================================================

describe('addDestination / removeDestination', () => {
	it('adds a property destination to one level and is idempotent on (primitive,key)', () => {
		const m = csfMapping();
		const once = addDestination(m, 0, { primitive: 'property', key: 'category' });
		const twice = addDestination(once, 0, { primitive: 'property', key: 'category' });
		const count = (mm: StructureMapping) =>
			mm.levels[0].destinations.filter((d) => d.primitive === 'property').length;
		expect(count(once)).toBe(1);
		expect(count(twice)).toBe(1);
		expect(count(m)).toBe(0); // input untouched
	});

	it('removes a keyed destination by primitive + key', () => {
		const m = addDestination(csfMapping(), 0, { primitive: 'property', key: 'category' });
		const removed = removeDestination(m, 0, 'property', 'category');
		expect(removed.levels[0].destinations.some((d) => d.primitive === 'property')).toBe(false);
	});
});

// ===========================================================================
// 4. Merge / split matrix rows
// ===========================================================================

describe('mergeRows / splitRow', () => {
	it('merges two consecutive folder levels into one joined range, then splits back', () => {
		const m = csfMapping(); // levels: [part0 folder, part0(-) folder, leaf name]
		expect(m.levels.length).toBe(3);
		const merged = mergeRows(m, 0);
		expect(merged.levels.length).toBe(2);
		expect(merged.levels[0].naming).toBe('joined');

		const split = splitRow(merged, 0);
		expect(split.levels.length).toBe(3);
		// input never mutated
		expect(m.levels.length).toBe(3);
	});

	it('merge is a no-op on the last level or an out-of-range index', () => {
		const m = csfMapping();
		expect(mergeRows(m, m.levels.length - 1)).toBe(m);
		expect(mergeRows(m, 99)).toBe(m);
	});

	it('split is a no-op on an unsplittable (single-part) source', () => {
		const m = csfMapping();
		// The leaf is a whole-column source — nothing to split.
		const leafIndex = m.levels.length - 1;
		expect(splitRow(m, leafIndex)).toBe(m);
	});

	it('a merged range serializes to one joined folder template (recipe-valid)', () => {
		const merged = mergeRows(csfMapping(), 0);
		const regions = toRecipeRegions({ mappings: [merged] });
		const back = fromRegions(regions);
		// Round-trips through the recipe layer (the merged row is representable).
		expect(back.mappings[0].levels.length).toBe(merged.levels.length);
	});
});

// ===========================================================================
// 4b. Split one row into N levels (spec §4.3, acceptance A2/A4/A7/A9)
// ===========================================================================

/**
 * One structural row on a packed column: what the "Split into levels" panel
 * opens on (spec §4.1). It places folders AND names the note, so the leaf of a
 * split has destinations worth keeping.
 */
function packedOneRowMapping(column = 'id'): StructureMapping {
	return {
		levels: [{
			level: 'level-1',
			source: { column },
			destinations: [{ primitive: 'folder' }, { primitive: 'name' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}],
	};
}

/**
 * The A2 panel settings: `GV.OC-01.01` on `.` and `-`, four levels deep. `naming`
 * covers the NON-LEAF rows only, so it is `depth - 1` long (spec §4.3 step 1).
 */
const A2_OPTS = {
	delimiters: '.-',
	depth: 4,
	naming: ['prefix', 'prefix', 'prefix'] as ('part' | 'prefix')[],
	missing: 'skip' as const,
};

describe('splitIntoLevels', () => {
	it('A2: one structural row becomes depth rows, folders on every non-leaf', () => {
		const m = packedOneRowMapping();
		const out = splitIntoLevels(m, 0, A2_OPTS);

		expect(out.levels.length).toBe(4);
		for (let i = 0; i < 3; i++) {
			expect(out.levels[i].level).toBe(`level-${i + 1}`);
			expect(out.levels[i].source).toEqual([{ column: 'id', part: i }]);
			expect(out.levels[i].delimiters).toBe('.-');
			expect(out.levels[i].naming).toBe('prefix');
			expect(out.levels[i].missing).toBe('skip');
			expect(out.levels[i].materialize).toBe(false);
			expect(out.levels[i].destinations).toEqual([{ primitive: 'folder' }]);
		}
		// The leaf is the untouched column and keeps the split row's destinations.
		expect(out.levels[3].level).toBe('level-4');
		expect(out.levels[3].source).toEqual([{ column: 'id' }]);
		expect(out.levels[3].delimiters).toBeUndefined();
		expect(out.levels[3].naming).toBe('part');
		expect(out.levels[3].destinations).toEqual([{ primitive: 'folder' }, { primitive: 'name' }]);

		// Pure: the input is never mutated.
		expect(m.levels.length).toBe(1);
		expect(m.levels[0].delimiters).toBeUndefined();
	});

	it('A4: the leaf is the untouched column, so a row short a level keeps its full id', () => {
		const leaf = splitIntoLevels(packedOneRowMapping(), 0, A2_OPTS).levels[3];
		// Nothing about the leaf addresses a piece, so `missing: skip` on the folder
		// levels can drop a level without ever emptying the note name.
		expect(leaf.source).toEqual([{ column: 'id' }]);
		expect(leaf.delimiters).toBeUndefined();
		expect(leaf.missing).toBe('skip');
	});

	it('re-splitting from a folder row replaces the whole run, so applying twice is idempotent', () => {
		const first = splitIntoLevels(packedOneRowMapping(), 0, A2_OPTS);
		const second = splitIntoLevels(first, 1, { ...A2_OPTS, depth: 3, naming: ['prefix', 'prefix'] });

		expect(second.levels.length).toBe(3);
		expect(second.levels.map((l) => l.level)).toEqual(['level-1', 'level-2', 'level-3']);
		expect(second.levels.map((l) => l.source)).toEqual([
			[{ column: 'id', part: 0 }],
			[{ column: 'id', part: 1 }],
			[{ column: 'id' }],
		]);
		// The run's leaf destinations carry through the second apply unchanged.
		expect(second.levels[2].destinations).toEqual([{ primitive: 'folder' }, { primitive: 'name' }]);
	});

	it('re-splitting from the run leaf finds the same run', () => {
		const first = splitIntoLevels(packedOneRowMapping(), 0, A2_OPTS);
		const second = splitIntoLevels(first, 3, { ...A2_OPTS, depth: 3, naming: ['prefix', 'prefix'] });

		expect(second.levels.length).toBe(3);
		expect(second.levels.map((l) => l.source)).toEqual([
			[{ column: 'id', part: 0 }],
			[{ column: 'id', part: 1 }],
			[{ column: 'id' }],
		]);
		expect(second.levels[2].destinations).toEqual([{ primitive: 'folder' }, { primitive: 'name' }]);
	});

	it('rows from other sources before and after the run are untouched', () => {
		const split = splitIntoLevels(packedOneRowMapping(), 0, A2_OPTS);
		const leading: StructureMapping['levels'][number] = {
			level: 'root',
			source: { constant: 'Frameworks' },
			destinations: [{ primitive: 'folder' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		};
		const trailing: StructureMapping['levels'][number] = {
			level: 'facet',
			source: { column: 'family' },
			destinations: [{ primitive: 'tag', namespace: 'family' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		};
		const mixed: StructureMapping = { levels: [leading, ...split.levels, trailing] };

		// Index 2 is the second piece of the run, so the run (indices 1..4, the three
		// part rows plus their whole-column leaf) goes.
		const out = splitIntoLevels(mixed, 2, { ...A2_OPTS, depth: 3, naming: ['prefix', 'prefix'] });
		expect(out.levels.length).toBe(5);
		expect(out.levels[0]).toEqual(leading);
		expect(out.levels[4]).toEqual(trailing);
		expect(out.levels.slice(1, 4).map((l) => l.source)).toEqual([
			[{ column: 'id', part: 0 }],
			[{ column: 'id', part: 1 }],
			[{ column: 'id' }],
		]);
		// New ids never collide with the rows left in place.
		expect(new Set(out.levels.map((l) => l.level)).size).toBe(5);
	});

	it('a non-structural split row produces non-leaf rows with no destinations', () => {
		const m: StructureMapping = {
			levels: [{
				level: 'level-1',
				source: { column: 'id' },
				destinations: [{ primitive: 'name' }],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			}],
		};
		const out = splitIntoLevels(m, 0, { ...A2_OPTS, depth: 3, naming: ['prefix', 'prefix'] });
		expect(out.levels.length).toBe(3);
		expect(out.levels[0].destinations).toEqual([]);
		expect(out.levels[1].destinations).toEqual([]);
		expect(out.levels[2].destinations).toEqual([{ primitive: 'name' }]);
		expect(out.levels[2].source).toEqual([{ column: 'id' }]);
	});

	it('invalid input returns the same mapping object', () => {
		const m = packedOneRowMapping();
		expect(splitIntoLevels(m, -1, A2_OPTS)).toBe(m);
		expect(splitIntoLevels(m, 99, A2_OPTS)).toBe(m);
		expect(splitIntoLevels(m, 0, { ...A2_OPTS, depth: 1 })).toBe(m);
		expect(splitIntoLevels(m, 0, { ...A2_OPTS, delimiters: '' })).toBe(m);

		const constantOnly: StructureMapping = {
			levels: [{
				level: 'root',
				source: { constant: 'Frameworks' },
				destinations: [{ primitive: 'folder' }],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			}],
		};
		expect(splitIntoLevels(constantOnly, 0, A2_OPTS)).toBe(constantOnly);
	});

	it('A9: merging two split rows keeps the delimiter set and joins on its first character', () => {
		const out = splitIntoLevels(packedOneRowMapping(), 0, A2_OPTS);
		const merged = mergeRows(out, 1);

		expect(merged.levels.length).toBe(3);
		const row = merged.levels[1];
		expect(row.naming).toBe('joined');
		expect(row.delimiters).toBe('.-');
		expect(row.join).toBe('.');
		expect(row.source).toEqual({ column: 'id', part: [1, 2] });
		// No single delimiter was invented for the merged row.
		expect(row.delimiter).toBeUndefined();
	});

	it('an existing single-delimiter merge is unchanged by the set fallback', () => {
		// Legacy shape: `delimiter`, no `delimiters`. The join must still come from
		// the single delimiter, and no set may appear out of nowhere.
		const legacy = (level: string, part: number): StructureMapping['levels'][number] => ({
			level,
			source: { column: 'id', part },
			delimiter: '.',
			destinations: [{ primitive: 'folder' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		});
		const merged = mergeRows({ levels: [legacy('level-1', 0), legacy('level-2', 1)] }, 0);
		expect(merged.levels[0].delimiters).toBeUndefined();
		expect(merged.levels[0].delimiter).toBe('.');
		expect(merged.levels[0].join).toBe('.');
	});

	it('A7: split levels survive serialize → parse', () => {
		// One structural destination per row, which is what the recipe layout can
		// represent one-to-one (fromRegions builds a LevelRule per layout entry).
		const m: StructureMapping = {
			levels: [
				{
					level: 'folders',
					source: { column: 'id' },
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
		};
		const out = splitIntoLevels(m, 0, { ...A2_OPTS, depth: 3, naming: ['prefix', 'prefix'] });
		expect(out.levels.length).toBe(4);

		const back = fromRegions(toRecipeRegions({ mappings: [out] })).mappings[0];
		expect(back.levels.length).toBe(out.levels.length);
		expect(back.levels.map((l) => l.level)).toEqual(out.levels.map((l) => l.level));
		expect(back.levels.map((l) => l.delimiters)).toEqual(['.-', '.-', undefined, undefined]);
		expect(back.levels.map((l) => l.naming)).toEqual(['prefix', 'prefix', 'part', 'part']);
		expect(back.levels.map((l) => l.destinations)).toEqual(out.levels.map((l) => l.destinations));
		// The ONE documented normalization: `parseStructuralTemplate` returns a bare
		// PartRef for a single-interpolation template, so a one-element source array
		// comes back unwrapped. Nothing else about the level changes.
		expect(back.levels.map((l) => l.source)).toEqual([
			{ column: 'id', part: 0 },
			{ column: 'id', part: 1 },
			{ column: 'id' },
			{ column: 'id' },
		]);
	});
});

// ===========================================================================
// 5. Preset drift — the Custom label
// ===========================================================================

describe('isUnmodifiedPreset', () => {
	const detections = detect(rowsFrom('element_identifier', CSF));

	it('a freshly instantiated preset is unmodified', () => {
		const current = instantiate(BROWSABLE_FRAMEWORK, detections);
		expect(isUnmodifiedPreset(current, BROWSABLE_FRAMEWORK, detections)).toBe(true);
	});

	it('any edit flips it to modified (the Custom label trigger)', () => {
		const current = instantiate(BROWSABLE_FRAMEWORK, detections);
		const edited: ImportMapping = {
			mappings: [toggleDestinationAcrossMapping(current.mappings[0], 'tag', true), ...current.mappings.slice(1)],
		};
		expect(isUnmodifiedPreset(edited, BROWSABLE_FRAMEWORK, detections)).toBe(false);
	});

	it('a different preset is detected as modified relative to this one', () => {
		const current = instantiate(DEEP_EVERYTHING, detections);
		expect(isUnmodifiedPreset(current, BROWSABLE_FRAMEWORK, detections)).toBe(false);
	});
});

// ===========================================================================
// 6. structuralEqual
// ===========================================================================

describe('structuralEqual', () => {
	it('is key-order independent', () => {
		expect(structuralEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
	});
	it('distinguishes different arrays and values', () => {
		expect(structuralEqual([1, 2, 3], [1, 2])).toBe(false);
		expect(structuralEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(structuralEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});
});

describe('markPlacementRelations: the connector overlay roles', () => {
	const { buildParentPlacementPreview } = jest.requireActual('../src/import/mapping/view-model');
	const paths = [
		'Frameworks/T1078.md',
		'Frameworks/T1078/T1078.001.md',
		'Frameworks/T1078/T1078.002.md',
		'Frameworks/T1003.md',
	];

	it('sibling tree: parent beside its folder, children inside, loner unmarked', () => {
		const { sibling } = buildParentPlacementPreview(paths);
		const byLabel = (l: string) => sibling.find((n: { label: string }) => n.label === l);
		expect(byLabel('T1078.md').relation).toBe('parent');
		const parentIdx = sibling.indexOf(byLabel('T1078.md'));
		expect(byLabel('T1078.001.md').relation).toBe('child');
		expect(byLabel('T1078.001.md').relationParentIndex).toBe(parentIdx);
		expect(byLabel('T1078.002.md').relation).toBe('child');
		expect(byLabel('T1003.md').relation).toBeUndefined();
	});

	it('folder-note tree: relocated parent inside its own folder is the parent', () => {
		const { folderNote } = buildParentPlacementPreview(paths);
		// Relocation preview: T1078.md now lives at Frameworks/T1078/T1078.md.
		const files = folderNote.filter((n: { isFile: boolean }) => n.isFile);
		const parent = files.find((n: { label: string; relation?: string }) => n.label === 'T1078.md');
		expect(parent.relation).toBe('parent');
		const children = files.filter((n: { relation?: string }) => n.relation === 'child');
		expect(children.map((n: { label: string }) => n.label).sort()).toEqual(['T1078.001.md', 'T1078.002.md']);
	});
});

describe('preferredParentNote: adaptive default from installed plugins', () => {
	const { preferredParentNote } = jest.requireActual('../src/import/mapping/view-model');

	it('folder-note with a plugin-specific reason when a folder-notes plugin is enabled', () => {
		const r = preferredParentNote(new Set(['dataview', 'folder-notes']));
		expect(r.value).toBe('folder-note');
		expect(r.reason).toContain('folder notes');
	});

	it('matches fuzzy folder-note plugin ids', () => {
		expect(preferredParentNote(['some-folder-note-thing']).value).toBe('folder-note');
		expect(preferredParentNote(['waypoint']).value).toBe('folder-note');
	});

	it('folder-note outright even without a folder-notes plugin (owner default)', () => {
		const r = preferredParentNote(new Set(['dataview', 'templater-obsidian']));
		expect(r.value).toBe('folder-note');
		expect(r.reason).toBeUndefined();
	});
});

describe('detectWaypointPlugin: gates the Waypoint-marker toggle (2026-07-11 ICSB audit §4)', () => {
	const { detectWaypointPlugin } = jest.requireActual('../src/import/mapping/view-model');

	it('true when Waypoint is enabled', () => {
		expect(detectWaypointPlugin(new Set(['dataview', 'waypoint']))).toBe(true);
	});

	it('true on a fuzzy Waypoint fork id, case-insensitive', () => {
		expect(detectWaypointPlugin(['My-Waypoint-Fork'])).toBe(true);
	});

	it('false when no Waypoint-style plugin is enabled — including other folder-note plugins', () => {
		expect(detectWaypointPlugin(new Set(['dataview', 'folder-notes']))).toBe(false);
		expect(detectWaypointPlugin([])).toBe(false);
	});
});
