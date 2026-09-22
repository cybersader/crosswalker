/**
 * workbench-recipe.test.ts — the shape workbench's non-DOM integration logic.
 *
 * The DOM rendering of the workbench is covered later by e2e. This suite guards
 * the wiring the UI depends on: recipe assembly (shape mappings + the demoted
 * "all columns" frontmatter layer), the live preview render over sample rows,
 * and the legacy body bridge used at generate time. Construction and these
 * methods touch no Obsidian DOM.
 */

import { TFile, TFolder } from 'obsidian';
import { MappingWorkbench, type WorkbenchOptions } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ParsedData, ImportRecipe } from '../src/types/config';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import type { ImportMapping, StructureMapping } from '../src/import/mapping/types';
import { toSourceRefs, isConstantRef } from '../src/import/mapping/types';
import type { DebugLog } from '../src/utils/debug';
import { deriveFacetMemberships } from '../src/import/mapping/facets';
import { facetTagColumns, buildParentPlacementPreview, toFolderNotePaths } from '../src/import/mapping/view-model';
import { explainRecipeError, NOTHING_PLACED_MESSAGE } from '../src/import/mapping/diagnostics';
import { BUILT_IN_PRESETS } from '../src/import/mapping/presets';
import { findRecipeForOntologyName } from '../src/views/workspace-view-helpers';
import { generateNotes, type GenerationOptions } from '../src/generation/generation-engine';
import { render } from '../src/render';
import { validateRecipe } from '../src/validation/validator';

// A no-op DebugLog stub (the workbench only calls .info/.trace).
const debug = {
	info() {},
	trace() {},
	warn() {},
	error() {},
} as unknown as DebugLog;

function makeWorkbench(rows: Record<string, unknown>[]): MappingWorkbench {
	const columns = rows.length ? Object.keys(rows[0]) : [];
	const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Frameworks',
		debug,
		defaultPresetId: 'browsable-framework',
		onChange: () => {},
	});
}

function crosswalkRecipe(): CrosswalkerImportRecipe {
	return {
		recipe: 'synthetic-workbench-crosswalk',
		source: { ontology: 'synthetic-source', levels: ['concept'] },
		target: { layout: [{ level: 'concept', mechanism: 'file', template: '{id}.md' }] },
	} as CrosswalkerImportRecipe;
}

function crosswalkMapping(toOntology: string | null): ImportMapping {
	return {
		mappings: [{
			levels: [{
				level: 'concept',
				source: { column: 'id' },
				destinations: [
					{ primitive: 'name' },
					{ primitive: 'crosswalk', toOntology, predicate: 'is_approximate_to' },
				],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			}],
		}],
	};
}

function makeCrosswalkWorkbench(toOntology: string | null): MappingWorkbench {
	const parsedData: ParsedData = {
		columns: ['id'],
		rows: [{ id: 'SYN-001' }],
		rowCount: 1,
	};
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Frameworks',
		debug,
		defaultPresetId: 'browsable-framework',
		initialRecipe: crosswalkRecipe(),
		recipeOrigin: 'bundled',
		initialMapping: crosswalkMapping(toOntology),
		seedColumnDefaults: false,
		onChange: () => {},
	});
}

// Ragged ATT&CK ids (variadic) + a facet + a free-text column.
function attackRows(): Record<string, unknown>[] {
	const ids = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];
	const tactics = ['defense-evasion', 'execution', 'discovery'];
	// Names deliberately carry no delimiters (real ATT&CK: "Process Injection"),
	// so `name` reads as a title, not a packed hierarchy.
	const names = ['Process Injection', 'Command Interpreter', 'OS Credential Dumping', 'Application Layer', 'Obfuscated Files', 'Data Staged', 'Portable Executable', 'PowerShell', 'LSASS Memory', 'DNS'];
	return ids.map((id, i) => ({
		technique_id: id,
		name: names[i],
		tactic: tactics[i % 3],
		description: `A longer description of the technique used to test body detection and property emission for row ${i}.`,
	}));
}

describe('MappingWorkbench recipe assembly', () => {
	it('patches a bundled-origin recipe with a valid crosswalk declaration', () => {
		const recipe = makeCrosswalkWorkbench('nist-csf-2').buildRecipe() as CrosswalkerImportRecipe;
		expect(recipe.target.crosswalks).toEqual([{ column: 'id', to_ontology: 'nist-csf-2' }]);
		expect(validateRecipe(recipe).valid).toBe(true);
	});

	it('blocks Generate until the crosswalk framework is named', () => {
		expect(() => makeCrosswalkWorkbench(null).buildRecipe()).toThrow(
			'Column "id" is marked as a crosswalk but no framework is named. Pick the framework on the Crosswalks card, or turn the card off.',
		);
	});

	it('produces a recipe with a layout from the detected shapes', () => {
		const wb = makeWorkbench(attackRows());
		const recipe = wb.buildRecipe();
		expect(recipe.target.layout.length).toBeGreaterThan(0);
		// A file (leaf) entry always exists.
		expect(recipe.target.layout.some((e) => e.mechanism === 'file')).toBe(true);
	});

	it('renders a live preview over sample rows (paths + no throw)', () => {
		const wb = makeWorkbench(attackRows());
		const preview = wb.computePreview();
		expect(preview).not.toBeNull();
		expect(preview!.addresses.length).toBeGreaterThan(0);
		for (const a of preview!.addresses) {
			expect(typeof a.address.primary.path).toBe('string');
			expect(a.address.primary.path.length).toBeGreaterThan(0);
		}
	});

	it('ragged ids nest under their parent folder (tail precedes the leaf in layout)', () => {
		// Regression for the inverted-path bug found via E2E screenshot: the
		// variadic tail entry was serialized after the file leaf, so render()
		// produced "T1055.011.md/T1055" instead of "T1055/T1055.011.md".
		const wb = makeWorkbench(attackRows());
		const preview = wb.computePreview()!;
		const paths = preview.addresses.map((a) => a.address.primary.path);
		expect(paths).toContain('T1055/T1055.011.md');
		expect(paths).toContain('T1055.md');
		expect(paths.find((p) => p.includes('.md/'))).toBeUndefined();
	});

	it('nothing is dropped: non-structural columns default to frontmatter properties', () => {
		const wb = makeWorkbench(attackRows());
		const regions = wb.buildFinalRegions();
		const managed = regions.also_emit?.frontmatter?.managed ?? {};
		// `name` is not a structural source, so it lands as a managed property.
		expect(Object.keys(managed)).toContain('name');
	});

	it('returns null preview for a non-eager (streamed) source', async () => {
		async function* gen() {
			/* no rows */
		}
		const parsedData: ParsedData = { columns: ['id'], rows: gen(), rowCount: -1 };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: [],
			outputPath: '',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
		});
		expect(wb.computePreview()).toBeNull();
	});

	it('exposes a stable leaf file template and legacy body bridge', () => {
		const wb = makeWorkbench(attackRows());
		expect(wb.leafFileTemplate()).toMatch(/\.md$/);
		// The long `description` column is a body-candidate, so it defaults to the
		// note body. As the PRIMARY body column it bridges with an empty heading
		// (clean document body: H1 + prose, no '## description' section).
		expect(wb.getLegacyBodyMappings()).toEqual([{ column: 'description', heading: '' }]);
	});
});

describe('P2 stable parent identity pairing', () => {
	const localRows = [
		{ id: 'A1', parent_id: '', name: 'Root' },
		{ id: 'A2', parent_id: 'A1', name: 'Child 2' },
		{ id: 'A3', parent_id: 'A1', name: 'Child 3' },
		{ id: 'A4', parent_id: 'A2', name: 'Child 4' },
		{ id: 'A5', parent_id: 'A2', name: 'Child 5' },
	];

	function parentWorkbench(rows: Record<string, unknown>[], sourceOntology: string): MappingWorkbench {
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		return new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			sourceOntology,
			onChange: () => {},
		});
	}

	it('pairs local parent IDs with the final link using the canonical ontology prefix', () => {
		const wb = parentWorkbench(localRows, 'nist-mini');
		const managed = wb.buildFinalRegions().also_emit?.frontmatter?.managed;
		expect(managed?.parent).toBe('[[{parent_id}]]');
		expect(managed?.parent_curie).toBe('{parent_id|optional|curie-prefix(nist-mini)}');

		const root = render({ recipe: 'p2-parent-test', source: { ontology: 'nist-mini' }, target: wb.buildFinalRegions() }, { curie: 'nist-mini:A1', scope: localRows[0] });
		expect(root.frontmatter.parent).toBeUndefined();
		expect(root.frontmatter.parent_curie).toBeUndefined();
	});

	it('uses raw CURIE identity without validating an unused ontology prefix', () => {
		const rows = localRows.map((row) => ({
			...row,
			id: `x:${row.id}`,
			parent_id: row.parent_id ? `x:${row.parent_id}` : '',
		}));
		const wb = parentWorkbench(rows, 'INVALID ONTOLOGY');
		const managed = wb.buildFinalRegions().also_emit?.frontmatter?.managed;
		expect(managed?.parent_curie).toBe('{parent_id|optional}');
	});

	it('blocks prefix derivation for an invalid canonical ontology with the exact diagnostic', () => {
		const wb = parentWorkbench(localRows, 'nist-mini');
		expect(() => wb.buildFinalRegions('NIST.INVALID')).toThrow(
			'Cannot derive parent_curie: recipe source.ontology must be a lowercase CURIE prefix (letters, digits, _ or -; first character must be a letter).',
		);
	});

	it('does not attach automatic identity to a hand-made replacement parent link', () => {
		const wb = parentWorkbench(localRows, 'nist-mini');
		const parentLevel = wb.getMapping().mappings
			.flatMap((mapping) => mapping.levels)
			.find((level) => level.destinations.some((destination) => destination.primitive === 'link' && destination.key === 'parent'));
		expect(parentLevel).toBeDefined();
		parentLevel!.destinations = parentLevel!.destinations.map((destination) =>
			destination.primitive === 'link' && destination.key === 'parent'
				? { ...destination }
				: destination,
		);
		const managed = wb.buildFinalRegions().also_emit?.frontmatter?.managed;
		expect(managed?.parent).toBe('[[{parent_id}]]');
		expect(managed?.parent_curie).toBeUndefined();
	});

	it('preserves an explicitly authored parent_curie template unchanged', () => {
		const wb = parentWorkbench(localRows, 'nist-mini');
		wb.getMapping().mappings.push({
			levels: [{
				level: 'explicit-parent-identity',
				source: { column: 'id' },
				filters: ['optional'],
				destinations: [{ primitive: 'property', key: 'parent_curie' }],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			}],
		});
		expect(wb.buildFinalRegions().also_emit?.frontmatter?.managed?.parent_curie).toBe('{id|optional}');
	});
});

// ============================================================================
// B6 + B2 (2026-07-12): the single-structural-mapping guard
// (`assertSingleStructural`, serialize.ts) is real and correctly loud, but
// nothing prevented the UI from reaching the state it guards against, and
// `computePreview()` swallowed the throw into a misleading "no preview"
// state. B6 fixes the SOURCE (`addManualMapping` no longer seeds a second
// structural destination); B2 fixes the fallback (a forced/hand-authored
// two-structural mapping now surfaces as `previewError` instead of a silent
// null). `addManualMapping`/the model field are private — reached the same
// way the rest of this file drives private write paths: a narrow cast.
// ============================================================================
describe('B6 + B2: the single-structural-mapping guard (source fix + error surfacing)', () => {
	it('addManualMapping onto a workbench with an existing structural mapping produces a frontmatter-destination mapping; buildRecipe() does not throw', () => {
		const wb = makeWorkbench(attackRows());
		const before = wb.getMapping().mappings.length;
		expect(before).toBeGreaterThan(0); // the technique_id hierarchy is already structural

		(wb as unknown as { addManualMapping: (c: string) => void }).addManualMapping('name');

		const mapping = wb.getMapping();
		expect(mapping.mappings.length).toBe(before + 1);
		const added = mapping.mappings[mapping.mappings.length - 1];
		expect(added.levels).toHaveLength(1);
		// A frontmatter property, NOT a second {primitive:'name'} structural
		// destination — the natural "route this column" action when structure
		// is already spoken for.
		expect(added.levels[0].destinations).toEqual([{ primitive: 'property', key: 'name' }]);
		expect(() => wb.buildRecipe()).not.toThrow();
	});

	it('addManualMapping still seeds a structural {primitive:"name"} destination when NO structural mapping exists yet', () => {
		// Zero columns → detectStructure finds nothing → instantiate() leaves the
		// matrix empty (the "defaults law" fallback only fires when at least one
		// detection exists — see instantiate.ts), so there is nothing structural
		// to collide with.
		const parsedData: ParsedData = { columns: [], rows: [], rowCount: 0 };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: [],
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
		});
		expect(wb.getMapping().mappings).toEqual([]);

		(wb as unknown as { addManualMapping: (c: string) => void }).addManualMapping('note');

		const added = wb.getMapping().mappings[0];
		expect(added.levels[0].destinations).toEqual([{ primitive: 'name' }]);
	});

	it('computePreview() surfaces a forced two-structural-mapping state as previewError instead of a silent null (B2)', () => {
		const wb = makeWorkbench(attackRows());
		const mapping = wb.getMapping();
		expect(mapping.mappings.length).toBeGreaterThan(0);

		// Force the state the UI can no longer reach on its own after the B6 fix
		// (a hand-authored or mis-merged mapping could still slip past it) —
		// direct model manipulation, per the review's own reproduction method.
		const forced: ImportMapping = {
			...mapping,
			mappings: [
				...mapping.mappings,
				{
					levels: [
						{
							level: 'name2',
							source: { column: 'name' },
							destinations: [{ primitive: 'name' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		};
		(wb as unknown as { mapping: ImportMapping }).mapping = forced;

		expect(wb.getPreviewError()).toBeNull(); // nothing has attempted a build yet
		expect(wb.computePreview()).toBeNull();
		expect(wb.getPreviewError()).toMatch(/one recipe supports exactly one structural mapping/);
	});

	it('a mapping left with nowhere to put its notes surfaces as a translated error, not raw validator text', () => {
		// The user-reported state: one mapped id column, File names turned off, so
		// the mapping emits no folder/file/heading at all. The validator reports
		// "/source/levels must not have fewer than 1 items; /target/layout ...",
		// which names a JSON pointer the user cannot act on.
		const wb = makeWorkbench(attackRows());
		const stripped: ImportMapping = {
			mappings: [
				{
					levels: [
						{
							level: 'technique_id',
							source: { column: 'technique_id' },
							destinations: [],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		};
		(wb as unknown as { mapping: ImportMapping }).mapping = stripped;

		expect(wb.computePreview()).toBeNull();
		const raw = wb.getPreviewError();
		expect(raw).toMatch(/must NOT have fewer than 1 items/);
		// Both surfaces (preview rail + step-3 banner) render this instead.
		expect(explainRecipeError(raw!)).toBe(NOTHING_PLACED_MESSAGE);
	});
});

describe('MappingWorkbench draft rehydration (spec §7i)', () => {
	// A deliberately minimal mapping, distinct from what browsable-framework would
	// instantiate over attackRows (which adds folder/tag/link destinations). If the
	// workbench honors initialMapping it stays name-only; if it re-detects instead
	// it would balloon.
	function seededMapping(): ImportMapping {
		return {
			mappings: [
				{
					levels: [
						{
							level: 'leaf',
							source: { column: 'technique_id' },
							destinations: [{ primitive: 'name' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		};
	}

	it('seeds the model from initialMapping instead of re-instantiating from detections', () => {
		const rows = attackRows();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		const initialMapping = seededMapping();
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			initialMapping,
			onChange: () => {},
		});
		expect(wb.getMapping()).toEqual(initialMapping);
	});

	it('without initialMapping, instantiates the preset over detections (baseline differs)', () => {
		const wb = makeWorkbench(attackRows());
		// The fresh instantiation is not the minimal name-only seed — it detects the
		// packed hierarchy and facet, so the mapping is richer.
		expect(wb.getMapping()).not.toEqual(seededMapping());
	});
});

// ============================================================================
// B3 (2026-07-12): reinstantiate() must not discard the user's live
// in-session enrichment choices or hand-added mappings. `reinstantiate()` is
// private (fired internally by an evidence dismiss/use or a preset switch) —
// these tests reach it the same way the existing "Folder note" placement test
// above reaches `updateEnrichment`: a narrow private-method cast, matching
// this file's established convention for driving production write paths
// without mounting the DOM.
// ============================================================================
describe('MappingWorkbench reinstantiate() carries the user\'s live choices forward (B3)', () => {
	type PrivateWorkbench = {
		updateEnrichment: (p: { parent_note?: 'sibling' | 'folder-note' }) => void;
		dismissed: Set<string>;
		presetId: string;
		reinstantiate: () => void;
		addManualMapping: (column: string) => void;
	};

	function attackWorkbench(overrides: Partial<WorkbenchOptions> = {}): MappingWorkbench {
		const rows = attackRows();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		return new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
			...overrides,
		});
	}

	it('parent_note survives an evidence dismiss (the "In use"/"Dismiss" evidence-card buttons call reinstantiate())', () => {
		const wb = attackWorkbench();
		const priv = wb as unknown as PrivateWorkbench;
		priv.updateEnrichment({ parent_note: 'folder-note' });
		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');

		// Dismissing the tactic facet-candidate is exactly what clicking
		// "Dismiss" on that evidence card does (workbench.ts's dismiss button
		// handler: `this.dismissed.add(key); this.reinstantiate();`).
		priv.dismissed.add('facet-candidate:tactic');
		priv.reinstantiate();

		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');
	});

	it('parent_note survives a preset switch (the preset dropdown\'s change handler calls reinstantiate())', () => {
		const wb = attackWorkbench();
		const priv = wb as unknown as PrivateWorkbench;
		priv.updateEnrichment({ parent_note: 'folder-note' });
		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');

		priv.presetId = 'deep-everything';
		priv.reinstantiate();

		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');
	});

	it('the user\'s in-session enrichment choice outranks a vault default on reinstantiate', () => {
		const wb = attackWorkbench({ vaultDefaults: { parent_note: 'sibling' } });
		// The vault default applied on the fresh instantiation.
		expect(wb.getMapping().enrichment?.parent_note).toBe('sibling');

		const priv = wb as unknown as PrivateWorkbench;
		priv.updateEnrichment({ parent_note: 'folder-note' });
		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');

		// A preset switch re-applies the vault-defaults overlay first, then the
		// user's own prior choice on top — the user's live choice must win.
		priv.presetId = 'flat-and-linked';
		priv.reinstantiate();

		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');
	});

	it('a hand-added mapping (addManualMapping) survives reinstantiate(), unlike an auto-detected one', () => {
		const wb = attackWorkbench();
		const priv = wb as unknown as PrivateWorkbench;
		const before = wb.getMapping().mappings.length;

		// "description" is already a body-candidate column, not a fresh manual
		// add target, so use a column that isn't already structurally mapped —
		// any column works since addManualMapping never inspects existing
		// destinations before appending.
		priv.addManualMapping('name');
		expect(wb.getMapping().mappings.length).toBe(before + 1);

		priv.presetId = 'deep-everything';
		priv.reinstantiate();

		// The hand-added "name" mapping is still present (carried forward);
		// deep-everything's own instantiation over detections doesn't produce
		// an equivalent single-level name-only mapping for "name" on its own.
		const stillPresent = wb.getMapping().mappings.some(
			(m) => m.levels.length === 1 && m.levels[0].level === 'name' && m.levels[0].source && 'column' in m.levels[0].source && (m.levels[0].source as { column: string }).column === 'name',
		);
		expect(stillPresent).toBe(true);
	});
});

// ============================================================================
// Vault-level Connections defaults (settings § Connections,
// `CrosswalkerSettings.defaultEnrichment`). Precedence chain (highest to
// lowest): recognized built-in configuration / a resumed draft or saved
// mapping (both arrive as `initialMapping`) > vault defaults > the preset's
// own defaults > adaptive `parent_note` detection. `applyDefaultsOverlay` is
// private, so these exercise it through the constructor (and, for the reuse
// claim, note that `reinstantiate()` — the preset-switch path — calls the
// exact same private method).
// ============================================================================
describe('MappingWorkbench vault-default Connections overlay (precedence chain)', () => {
	function browsableWorkbench(overrides: Partial<WorkbenchOptions> = {}): MappingWorkbench {
		const rows = attackRows();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		return new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
			...overrides,
		});
	}

	it('with no vault defaults, the preset\'s own enrichment defaults apply unchanged (M3: parent_note is NOT one of them)', () => {
		// M3 (2026-07-12): PRESET_ENRICHMENT_DEFAULTS no longer hardcodes
		// parent_note: 'sibling' — the field stays unset here so the adaptive
		// folder-note default (preferredParentNote()) actually gets a say when
		// a defaultParentNote is supplied (see the adaptive-detection tests
		// below). No defaultParentNote is passed in this helper, so parent_note
		// stays absent entirely.
		const wb = browsableWorkbench();
		expect(wb.getMapping().enrichment).toEqual({
			children_lists: true,
			facet_notes: 'notes',
			level_hubs: 'notes',
		});
		expect(wb.getMapping().enrichment?.parent_note).toBeUndefined();
	});

	it('an empty vaultDefaults object changes nothing (same as omitting it)', () => {
		const wb = browsableWorkbench({ vaultDefaults: {} });
		expect(wb.getMapping().enrichment).toEqual({
			children_lists: true,
			facet_notes: 'notes',
			level_hubs: 'notes',
		});
	});

	it('vault defaults overlay (override) the preset\'s own defaults', () => {
		const wb = browsableWorkbench({
			vaultDefaults: { children_lists: false, parent_note: 'folder-note' },
		});
		expect(wb.getMapping().enrichment).toEqual({
			children_lists: false,   // vault default wins over the preset's `true`
			facet_notes: 'notes',    // untouched key: preset value stands
			parent_note: 'folder-note', // vault default wins over the preset's 'sibling'
			level_hubs: 'notes',
		});
	});

	it('a partial vault default only overrides the keys it sets', () => {
		const wb = browsableWorkbench({ vaultDefaults: { level_hubs: 'none' } });
		expect(wb.getMapping().enrichment).toEqual({
			children_lists: true,
			facet_notes: 'notes',
			level_hubs: 'none', // the only overridden key
		});
		// M3: neither the preset nor this vault default sets parent_note, and no
		// defaultParentNote is supplied — it stays absent (no adaptive fallback
		// to run without one).
		expect(wb.getMapping().enrichment?.parent_note).toBeUndefined();
	});

	it('vault defaults never apply when initialMapping is supplied (a resumed draft or recognized recipe outranks vault defaults)', () => {
		const initialMapping: ImportMapping = {
			mappings: [],
			enrichment: { children_lists: true, parent_note: 'sibling' },
		};
		const wb = browsableWorkbench({
			initialMapping,
			vaultDefaults: { children_lists: false, parent_note: 'folder-note', level_hubs: 'notes' },
		});
		// Byte-identical to the seeded mapping — the vault default overlay never ran.
		expect(wb.getMapping()).toEqual(initialMapping);
	});

	it('adaptive parent_note detection only fires when NEITHER a vault default nor the preset supplied one', () => {
		// An empty-detection source (no columns) instantiates to `{ mappings: [] }`
		// with no enrichment attached at all (instantiate.ts: enrichment only
		// stamps on when the matrix is non-empty) — the one reachable case where
		// the preset genuinely leaves parent_note unset, so the adaptive fallback
		// is exercised for real rather than shadowed by a preset default.
		const parsedData: ParsedData = { columns: [], rows: [], rowCount: 0 };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: [],
			outputPath: '',
			debug,
			defaultPresetId: 'browsable-framework',
			// Sets an enrichment object without touching parent_note, so the
			// adaptive step below has something non-empty to attach onto.
			vaultDefaults: { children_lists: true },
			defaultParentNote: { value: 'folder-note', reason: 'test adaptive default' },
			onChange: () => {},
		});
		expect(wb.getMapping().enrichment).toEqual({ children_lists: true, parent_note: 'folder-note' });
	});

	it('adaptive parent_note detection is skipped when a vault default already set it', () => {
		const parsedData: ParsedData = { columns: [], rows: [], rowCount: 0 };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: [],
			outputPath: '',
			debug,
			defaultPresetId: 'browsable-framework',
			vaultDefaults: { parent_note: 'sibling' },
			defaultParentNote: { value: 'folder-note', reason: 'test adaptive default' },
			onChange: () => {},
		});
		expect(wb.getMapping().enrichment).toEqual({ parent_note: 'sibling' });
	});
});

// ============================================================================
// M3 (2026-07-12): PRESET_ENRICHMENT_DEFAULTS no longer hardcodes
// parent_note: 'sibling' on every built-in preset — that out-voted the
// documented "folder-note is the default outright" decision
// (`preferredParentNote()`, view-model.ts) on every fresh import, since
// `applyDefaultsOverlay()` only falls back to the adaptive default when the
// preset left `parent_note` unset. These pin the fixed precedence chain:
// preset defaults no longer carry an opinion > vault default (when set) >
// adaptive folder-note detection (when a vault default did NOT set it).
// ============================================================================
describe('M3: preset enrichment defaults no longer hardcode parent_note', () => {
	function workbenchWithPreset(presetId: string, overrides: Partial<WorkbenchOptions> = {}): MappingWorkbench {
		const rows = attackRows();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		return new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: presetId,
			onChange: () => {},
			...overrides,
		});
	}

	it('every built-in preset leaves parent_note unset on a fresh instantiation (the dead-code guard now actually fires)', () => {
		for (const presetId of Object.keys(BUILT_IN_PRESETS)) {
			const wb = workbenchWithPreset(presetId);
			expect(wb.getMapping().enrichment?.parent_note).toBeUndefined();
		}
	});

	it('a fresh workbench with no vault default resolves parent_note via the adaptive folder-note path', () => {
		const wb = workbenchWithPreset('browsable-framework', {
			defaultParentNote: { value: 'folder-note', reason: 'test adaptive default' },
		});
		expect(wb.getMapping().enrichment?.parent_note).toBe('folder-note');
	});

	it('a fresh workbench with an explicit vault default of sibling resolves parent_note to sibling', () => {
		const wb = workbenchWithPreset('browsable-framework', {
			vaultDefaults: { parent_note: 'sibling' },
			defaultParentNote: { value: 'folder-note', reason: 'should be out-voted by the vault default' },
		});
		expect(wb.getMapping().enrichment?.parent_note).toBe('sibling');
	});
});

describe('MappingWorkbench facet display names (spec §7k, item 3)', () => {
	// Original-case (not tagsafe) facet values, so we can assert casing survives.
	function attackRowsOriginalCase(): Record<string, unknown>[] {
		const ids = ['T1055', 'T1059', 'T1003', 'T1071', 'T1027', 'T1005', 'T1055.011', 'T1059.001', 'T1003.001', 'T1071.004'];
		const tactics = ['Defense Evasion', 'Execution', 'Discovery'];
		return ids.map((id, i) => ({
			technique_id: id,
			name: `Technique ${i}`,
			tactic: tactics[i % 3],
			description: `A longer description of the technique for row ${i}, long enough to read as a body candidate rather than a title.`,
		}));
	}

	it('deriveFacetMemberships over the workbench mapping keeps ORIGINAL-case names', () => {
		const rows = attackRowsOriginalCase();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
		});
		// The tactic column is a facet (low cardinality) → a tag destination.
		const memberships = deriveFacetMemberships(wb.getMapping(), { tactic: 'Defense Evasion' });
		const tacticFacet = memberships.find((m) => m.namespace === 'tactic');
		expect(tacticFacet).toBeDefined();
		// The hub display name must be the raw value, NOT the tagsafe "defense-evasion".
		expect(tacticFacet!.value).toBe('Defense Evasion');
	});
});

describe('OPEN BUG (spec §7o): buildRecipe() drops mapping.enrichment', () => {
	// Repro shape mirrors tests/e2e/visual-graph.spec.ts: 12 rows, dotted (ragged)
	// ids so a packed-hierarchy structural mapping is elected, `;`-joined
	// multi-value tactic cells so the facet caps stay satisfied (7 atoms < the
	// cardinality cap), driven with ZERO workbench interaction (defaultPresetId
	// only — no columnDests overrides).
	function attackRepro12(): Record<string, unknown>[] {
		const rows: { technique_id: string; name: string; tactic: string }[] = [
			{ technique_id: 'T1055', name: 'Process Injection', tactic: 'Defense Evasion; Privilege Escalation' },
			{ technique_id: 'T1055.001', name: 'DLL Injection', tactic: 'Defense Evasion; Privilege Escalation' },
			{ technique_id: 'T1055.011', name: 'EWM Injection', tactic: 'Defense Evasion; Privilege Escalation' },
			{ technique_id: 'T1059', name: 'Command and Scripting Interpreter', tactic: 'Execution' },
			{ technique_id: 'T1059.001', name: 'PowerShell', tactic: 'Execution' },
			{ technique_id: 'T1059.003', name: 'Windows Command Shell', tactic: 'Execution' },
			{ technique_id: 'T1071', name: 'Application Layer Protocol', tactic: 'Command and Control' },
			{ technique_id: 'T1071.001', name: 'Web Protocols', tactic: 'Command and Control' },
			{ technique_id: 'T1547', name: 'Boot or Logon Autostart Execution', tactic: 'Persistence; Privilege Escalation' },
			{ technique_id: 'T1547.001', name: 'Registry Run Keys / Startup Folder', tactic: 'Persistence; Privilege Escalation' },
			{ technique_id: 'T1003', name: 'OS Credential Dumping', tactic: 'Credential Access' },
			{ technique_id: 'T1486', name: 'Data Encrypted for Impact', tactic: 'Impact' },
		];
		// `description` gives every row a body-candidate column, matching the real
		// fixture's shape (avoids `name` being misread as the body column).
		return rows.map((r) => ({ ...r, description: 'x'.repeat(80) }));
	}

	function reproWorkbench(): MappingWorkbench {
		const rows = attackRepro12();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		return new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'GraphTest-e2e',
			debug,
			defaultPresetId: 'browsable-framework',
			onChange: () => {},
		});
	}

	it('sanity: instantiate() DOES stamp enrichment onto the mapping (not the bug)', () => {
		const wb = reproWorkbench();
		// M3 (2026-07-12): parent_note is no longer one of browsable-framework's
		// hardcoded enrichment defaults — see the M3 describe block below.
		expect(wb.getMapping().enrichment).toEqual({
			children_lists: true,
			facet_notes: 'notes',
			level_hubs: 'notes',
		});
	});

	it('buildRecipe() carries target.enrichment through (spec §7o root cause, fixed)', () => {
		// Root cause (found 2026-07-11, generation-engine.ts/generation surface
		// investigation of spec §7o): MappingWorkbench.buildFinalRegions() in
		// src/import/workbench.ts computed `const base = toRecipeRegions(this.mapping)`
		// (which DOES carry `base.enrichment`, per the sanity test above and
		// serialize.ts's toRecipeRegions), but its final `return` reconstructed a
		// brand-new RecipeRegions literal — `{ layout, also_emit }` or `{ layout }`
		// — that never copied `base.enrichment` across. `enrichmentEnabled` in
		// generateNotes (`!!recipe.target.enrichment`) was therefore always false
		// on the wizard/workbench path, so Pass 1.5 (children lists + facet hub
		// notes + edgeCount) never ran — regardless of whether facetsForRow was
		// wired correctly (it was; see the facet-display-names describe block
		// above and generate-notes-enrichment.test.ts).
		//
		// Fixed in buildFinalRegions()'s return statement: `if (base.enrichment)
		// regions.enrichment = base.enrichment;` before returning.
		//
		// Verified end-to-end (headless, outside this file) with that patch
		// applied: generateNotes on this exact 12-row fixture produces 17 created
		// files (12 leaf + 5 facet hubs meeting HUB_MIN_MEMBERS=2: Defense Evasion,
		// Privilege Escalation, Execution, Command and Control, Persistence) and
		// edgeCount 15.
		const wb = reproWorkbench();
		const recipe = wb.buildRecipe();
		expect(recipe.target.enrichment).toEqual({
			children_lists: true,
			facet_notes: 'notes',
			level_hubs: 'notes',
		});
	});

	// -------------------------------------------------------------------------
	// Folder-note placement — the 2026-07-11 repro (visual-report-and-graph.spec.ts):
	// explicitly selecting "Folder note" in the Connections card's placement
	// chooser did not relocate a ragged parent (T1078.md stayed a sibling of
	// T1078/, no error, no deviation). Driven end-to-end through the REAL
	// wizard path — MappingWorkbench + the private `updateEnrichment` the
	// radio's `change` handler calls + `buildRecipe()` + `generateNotes` over a
	// stateful in-memory vault — per the testing lesson pinned above: never
	// hand-supply what the UI derives (the mapping, the preset enrichment
	// defaults, the rendered paths all come from real instantiate()/render()).
	//
	// Root cause turned out to be TWO independent bugs, both fixed:
	//   1. src/generation/enrich.ts's computeRelocations gated folder-note
	//      eligibility on `childrenByParentCurie` (parent WIKILINK edges). A
	//      plain packed/ragged hierarchy with no separate parent-id column —
	//      attackRepro12 above is exactly this shape; ATT&CK sub-technique ids
	//      self-encode the hierarchy via the dot delimiter — never produces a
	//      `parent` link, so the candidate set was always empty and relocation
	//      silently never fired. Fixed: eligibility is now PATH-STRUCTURAL
	//      (mirrors the workbench preview's own `toFolderNotePaths`, exercised
	//      above), independent of link edges.
	//   2. src/import/mapping/serialize.ts's toRecipeRegions let a tail's own
	//      (possibly stale) `placement` out-vote an explicit top-level
	//      `mapping.enrichment.parent_note` — see mapping.test.ts's "STALE
	//      tail.placement" test for that fix in isolation. Not the trigger for
	//      THIS repro (a fresh instantiate() never stamps tail.placement — see
	//      the "sanity" test above), but a real latent bug on any round-tripped
	//      mapping (draft resume, the recognized-recipe fast path).
	function makeStatefulVault() {
		const files = new Map<string, string>();
		const folders = new Set<string>(['']);
		const getAbstractFileByPath = (path: string) => {
			if (files.has(path)) return new TFile(path);
			if (folders.has(path)) return new TFolder(path);
			return null;
		};
		const app = {
			vault: {
				// generateNotes resolves existing notes by identity, which reads the
				// vault markdown list. This double has no pre-existing notes.
				getMarkdownFiles: () => [],
				getAbstractFileByPath,
				create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
				modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
				read: async (file: { path: string }) => files.get(file.path) ?? '',
				createFolder: async (path: string) => { folders.add(path); },
				rename: async (file: { path: string }, newPath: string) => {
					const content = files.get(file.path);
					if (content !== undefined) { files.delete(file.path); files.set(newPath, content); }
				},
				delete: async (file: { path: string }) => { files.delete(file.path); },
			},
			metadataCache: {
				getFileCache: () => ({ frontmatter: {} }),
			},
		};
		return { app: app as unknown as import('obsidian').App, files };
	}

	/** Drive generateNotes exactly as import-wizard.ts's doGenerate() does for the workbench path. */
	async function generateViaWorkbench(wb: MappingWorkbench, basePath: string) {
		const { app, files } = makeStatefulVault();
		const parsedData: ParsedData = { columns: Object.keys(attackRepro12()[0]), rows: attackRepro12(), rowCount: attackRepro12().length };
		const config: Partial<ImportRecipe> = {
			name: 'shape-workbench',
			mapping: { hierarchy: [], frontmatter: [], links: [], body: wb.getLegacyBodyMappings() },
		};
		const options: GenerationOptions = {
			basePath,
			overwriteMode: 'replace',
			createFolders: true,
			recipeOverride: wb.buildRecipe(),
			facetsForRow: (row: Record<string, unknown>) => deriveFacetMemberships(wb.getMapping(), row),
		};
		const result = await generateNotes(app, parsedData, config, options, debug);
		return { files, result };
	}

	it('explicit "Folder note" placement relocates every ragged parent: no stray siblings remain', async () => {
		const wb = reproWorkbench();
		// The private `updateEnrichment` is the exact function the placement
		// chooser's radio `change` handler calls (workbench.ts) — this IS the
		// production code path, not a hand-supplied substitute for it.
		(wb as unknown as { updateEnrichment: (p: { parent_note: string }) => void }).updateEnrichment({ parent_note: 'folder-note' });
		expect(wb.buildRecipe().target.enrichment?.parent_note).toBe('folder-note');

		const { files, result } = await generateViaWorkbench(wb, 'GraphTest-e2e');
		expect(result.errors).toEqual([]);

		// Every ragged parent (>=1 child nested under its own basename folder)
		// relocates; every childless leaf (T1547 has one child, T1003/T1486 have
		// none) follows the same rule.
		for (const parentId of ['T1055', 'T1059', 'T1071', 'T1547']) {
			expect(files.has(`GraphTest-e2e/${parentId}/${parentId}.md`)).toBe(true);
			expect(files.has(`GraphTest-e2e/${parentId}.md`)).toBe(false);
		}
		// Childless leaves stay siblings (nothing to nest under).
		expect(files.has('GraphTest-e2e/T1003.md')).toBe(true);
		expect(files.has('GraphTest-e2e/T1486.md')).toBe(true);
	});

	it('explicit "Sibling" placement is honored: no relocation even though colliding folders exist', async () => {
		const wb = reproWorkbench();
		// browsable-framework's preset default is already 'sibling' (see the
		// sanity test above), but click it explicitly — mirrors a user who
		// changes their mind back after trying "Folder note".
		(wb as unknown as { updateEnrichment: (p: { parent_note: string }) => void }).updateEnrichment({ parent_note: 'sibling' });
		expect(wb.buildRecipe().target.enrichment?.parent_note).toBe('sibling');

		const { files, result } = await generateViaWorkbench(wb, 'GraphTest-e2e');
		expect(result.errors).toEqual([]);

		for (const parentId of ['T1055', 'T1059', 'T1071', 'T1547']) {
			expect(files.has(`GraphTest-e2e/${parentId}.md`)).toBe(true);
			expect(files.has(`GraphTest-e2e/${parentId}/${parentId}.md`)).toBe(false);
		}
	});
});

describe('MappingWorkbench recognized-recipe seed (spec §7m)', () => {
	// A recipe-seeded workbench (seedColumnDefaults: false) must emit EXACTLY the
	// recipe — no auto-added per-column properties. Here the seed maps only
	// technique_id → file name; `name`/`tactic`/`description` must NOT appear.
	function nameOnlyMapping(): ImportMapping {
		return {
			mappings: [
				{
					levels: [
						{
							level: 'leaf',
							source: { column: 'technique_id' },
							destinations: [{ primitive: 'name' }],
							naming: 'part',
							missing: 'skip',
							materialize: false,
						},
					],
				},
			],
		};
	}

	it('emits exactly the seeded recipe when seedColumnDefaults is false', () => {
		const rows = attackRows();
		const columns = Object.keys(rows[0]);
		const parsedData: ParsedData = { columns, rows, rowCount: rows.length };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			initialMapping: nameOnlyMapping(),
			seedColumnDefaults: false,
			onChange: () => {},
		});
		const managed = wb.buildFinalRegions().also_emit?.frontmatter?.managed ?? {};
		// No incidental per-column properties were injected.
		expect(Object.keys(managed)).not.toContain('name');
		expect(Object.keys(managed)).not.toContain('tactic');
		expect(Object.keys(managed)).not.toContain('description');
	});

	it('still auto-seeds per-column properties by default (seedColumnDefaults omitted)', () => {
		const wb = makeWorkbench(attackRows());
		const managed = wb.buildFinalRegions().also_emit?.frontmatter?.managed ?? {};
		expect(Object.keys(managed)).toContain('name');
	});
});

// ============================================================================
// M9 (2026-07-12): toggling the Tags shape card off didn't reconcile
// `enrichment.facet_notes` — turning off the last tag-emitting destination
// left the Connections card's "Create hub notes for" select showing a stale
// value with nothing left to group by. `toggleShapeCard` is the private
// method both the checkbox and the whole-card click handler call.
// ============================================================================
describe('M9: the Tags shape-card toggle reconciles enrichment.facet_notes', () => {
	/** Locates the facet mapping by its SOURCE column (stable across a toggle
	 *  off — the mapping stays in place with an empty destinations array,
	 *  unlike locating it by "currently has a tag destination", which breaks
	 *  the moment the card is off). */
	function toggleTagCard(wb: MappingWorkbench, column: string, on: boolean): void {
		const mapping = wb.getMapping();
		const mi = mapping.mappings.findIndex((m) =>
			m.levels.some((l) => {
				const ref = toSourceRefs(l.source)[0];
				return !isConstantRef(ref) && ref.column === column;
			}),
		);
		expect(mi).toBeGreaterThanOrEqual(0);
		(wb as unknown as {
			toggleShapeCard: (mi: number, m: StructureMapping, primitive: 'tag', on: boolean) => void;
		}).toggleShapeCard(mi, mapping.mappings[mi], 'tag', on);
	}

	it('turning off the last tag-emitting destination clears an orphaned "hub notes" selection', () => {
		const wb = makeWorkbench(attackRows());
		// browsable-framework already turns Tags on for the tactic facet and
		// defaults facet_notes to 'notes' (M3 tests above pin this baseline).
		expect(wb.getMapping().enrichment?.facet_notes).toBe('notes');
		expect(facetTagColumns(wb.getMapping())).toEqual(['tactic']);

		toggleTagCard(wb, 'tactic', false);

		expect(facetTagColumns(wb.getMapping())).toEqual([]);
		expect(wb.getMapping().enrichment?.facet_notes).toBe('none');
	});

	it('leaves facet_notes untouched when it was already "none" (nothing orphaned to reconcile)', () => {
		const wb = makeWorkbench(attackRows());
		(wb as unknown as { updateEnrichment: (p: { facet_notes: string }) => void })
			.updateEnrichment({ facet_notes: 'none' });
		expect(wb.getMapping().enrichment?.facet_notes).toBe('none');

		toggleTagCard(wb, 'tactic', false);

		expect(wb.getMapping().enrichment?.facet_notes).toBe('none');
	});

	it('turning Tags back on does not itself restore facet_notes (only the toggle-off reconciles; re-enabling is a separate user choice)', () => {
		const wb = makeWorkbench(attackRows());
		toggleTagCard(wb, 'tactic', false);
		expect(wb.getMapping().enrichment?.facet_notes).toBe('none');

		toggleTagCard(wb, 'tactic', true);

		expect(facetTagColumns(wb.getMapping())).toEqual(['tactic']);
		expect(wb.getMapping().enrichment?.facet_notes).toBe('none');
	});
});

// ============================================================================
// Connections helpers (mapping/view-model.ts, spec §7k) — the pure logic
// behind the workbench's Connections card: facetTagColumns (the facet-hubs
// label) and the sibling/folder-note placement mini-trees.
// ============================================================================

describe('facetTagColumns (spec §7k)', () => {
	it('returns the browsable-framework preset facet column for a ragged ATT&CK-shaped mapping', () => {
		const wb = makeWorkbench(attackRows());
		expect(facetTagColumns(wb.getMapping())).toEqual(['tactic']);
	});

	it('returns an empty list when no mapping carries a tag destination', () => {
		const mapping: ImportMapping = {
			mappings: [
				{
					levels: [
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
		};
		expect(facetTagColumns(mapping)).toEqual([]);
	});
});

describe('buildParentPlacementPreview / toFolderNotePaths (variadic-split design §4)', () => {
	it('sibling preview keeps a parent note beside its children folder', () => {
		const { sibling } = buildParentPlacementPreview(['Techniques/T1055.md', 'Techniques/T1055/T1055.011.md']);
		// The connected PAIR (parent note + its matching folder) carries the
		// accent relation for the highlight overlay; the child is marked too.
		expect(sibling).toMatchObject([
			{ depth: 0, label: 'Techniques', isFile: false },
			{ depth: 1, label: 'T1055.md', isFile: true, relation: 'parent' },
			{ depth: 1, label: 'T1055', isFile: false, relation: 'parent' },
			{ depth: 2, label: 'T1055.011.md', isFile: true, relation: 'child' },
		]);
	});

	it('toFolderNotePaths relocates a leaf whose stem matches an existing folder', () => {
		const paths = toFolderNotePaths(['Techniques/T1055.md', 'Techniques/T1055/T1055.011.md', 'Techniques/T1548.md']);
		expect(paths).toEqual([
			'Techniques/T1055/T1055.md', // relocated — T1055 has a children folder
			'Techniques/T1055/T1055.011.md',
			'Techniques/T1548.md', // childless leaf, untouched
		]);
	});

	it('folder-note preview nests the relocated parent note inside its own folder', () => {
		const { folderNote } = buildParentPlacementPreview(['Techniques/T1055.md', 'Techniques/T1055/T1055.011.md']);
		expect(folderNote).toMatchObject([
			{ depth: 0, label: 'Techniques', isFile: false },
			{ depth: 1, label: 'T1055', isFile: false, relation: 'parent' },
			{ depth: 2, label: 'T1055.md', isFile: true, relation: 'parent' },
			{ depth: 2, label: 'T1055.011.md', isFile: true, relation: 'child' },
		]);
	});

	it('is a no-op when no id in the sample is ragged (nothing to relocate)', () => {
		const paths = ['A.md', 'B.md', 'C.md'];
		expect(toFolderNotePaths(paths)).toEqual(paths);
	});
});

// ============================================================================
// findRecipeForOntologyName — the "Import again" heuristic (workspace-view-helpers.ts,
// spec §7n item 3). Installed-ontology folder name -> bundled recipe, best-effort.
// ============================================================================

describe('findRecipeForOntologyName', () => {
	const registry = [
		{ id: 'nist-csf-2-cprt-hierarchical', label: 'NIST CSF 2.0 (CPRT export, nested)', ontology: 'nist-csf-2' },
		{ id: 'mitre-attack-technique-flat', label: 'MITRE ATT&CK techniques', ontology: 'mitre-attack' },
		{ id: 'cis-controls-v8-controls', label: 'CIS Controls v8 (controls)', ontology: 'cis-v8' },
	];

	it('matches a punctuated folder name against a normalized ontology id', () => {
		const match = findRecipeForOntologyName('NIST-CSF-2.0', registry);
		expect(match?.id).toBe('nist-csf-2-cprt-hierarchical');
	});

	it('matches regardless of extra folder-name words', () => {
		const match = findRecipeForOntologyName('MITRE ATT&CK (Techniques)', registry);
		expect(match?.id).toBe('mitre-attack-technique-flat');
	});

	it('returns null for an unrecognizable folder name', () => {
		expect(findRecipeForOntologyName('My custom notes', registry)).toBeNull();
	});

	it('returns null for an empty folder name', () => {
		expect(findRecipeForOntologyName('', registry)).toBeNull();
	});

	it('prefers the more specific (longer) ontology id on ambiguous ties', () => {
		const ambiguous = [
			{ id: 'a', label: 'A', ontology: 'cis' },
			{ id: 'b', label: 'B', ontology: 'cis-v8' },
		];
		const match = findRecipeForOntologyName('CIS-v8', ambiguous);
		expect(match?.id).toBe('b');
	});
});
