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
	removeDestination,
	mergeRows,
	splitRow,
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
