/**
 * recognized-defaults.test.ts — the recognized-source fast path's curated
 * defaults (spec §7m): `recognizedDestination` (suggestedFolder) and
 * `honestEnrichment` (the honesty-gated recommendedEnrichment hint).
 *
 * Both are pure functions exported from import-wizard.ts specifically so
 * they're unit-testable without mounting the wizard's DOM.
 */

import { recognizedDestination, honestEnrichment, shouldAutoApplyRecognizedMatch } from '../src/import/import-wizard';
import { RECIPE_REGISTRY, type RecipeRegistryEntry } from '../src/import/recipe-registry';

function entry(id: string): RecipeRegistryEntry {
	const e = RECIPE_REGISTRY.find((r) => r.id === id);
	if (!e) throw new Error(`no registry entry for ${id}`);
	return e;
}

/** A synthetic registry entry so the honesty gate can be exercised in both
 *  directions (live and not-live) without depending on the current shape of
 *  the bundled recipes, which — per recipe-registry's own doc comment — are
 *  ALL not-live today (none emit tags or a parent wikilink yet). */
function fakeEntry(overrides: {
	childrenLists?: boolean;
	facetNotes?: 'none' | 'tags-only' | 'notes';
	facetField?: string;
	hasTagEmit?: boolean;
	hasParentLink?: boolean;
}): RecipeRegistryEntry {
	const managed: Record<string, string> = { title: '{title}' };
	if (overrides.hasParentLink) managed.parent = '[[{parent_id}]]';
	return {
		id: 'fake-recipe',
		label: 'Fake recipe',
		description: 'A synthetic recipe for testing the honesty gate.',
		ontology: 'fake',
		levels: [],
		routingKind: 'concept',
		suggestedFolder: 'Frameworks/Fake',
		recommendedEnrichment: {
			childrenLists: overrides.childrenLists ?? false,
			facetNotes: overrides.facetNotes ?? 'none',
			facetField: overrides.facetField,
			rationale: 'synthetic fixture',
		},
		signatureColumns: ['id'],
		requiredColumns: ['id'],
		structuralDepth: 1,
		recipe: {
			recipe: 'fake-recipe',
			target: {
				layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
				also_emit: {
					tags: overrides.hasTagEmit ? ['facet/{facet_col|tagsafe}'] : undefined,
					frontmatter: { managed },
				},
			},
		} as unknown as RecipeRegistryEntry['recipe'],
	};
}

describe('recognizedDestination (spec §7m)', () => {
	it('uses the registry suggestedFolder when no plugin-wide default is set', () => {
		const e = entry('cis-controls-v8-flat');
		expect(recognizedDestination(e, '')).toBe(e.suggestedFolder);
	});

	it('re-parents the curated folder under an explicit plugin-wide default', () => {
		// This used to assert that the plugin-wide default won outright, which
		// threw the curated folder away AND flattened the import into the shared
		// root. The global default is the PARENT of the per-import root, never the
		// destination itself (owner rule, 2026-07-11). See destination-default.test.ts.
		const e = entry('cis-controls-v8-flat');
		expect(recognizedDestination(e, 'My vault path')).toBe('My vault path/CIS Controls v8');
	});

	it('trims whitespace-only global defaults back to the suggestedFolder', () => {
		const e = entry('scf-2026-flat');
		expect(recognizedDestination(e, '   ')).toBe(e.suggestedFolder);
	});

	it('returns null for the generic single-segment fallback, so the caller derives from the file name', () => {
		const generic = { ...entry('scf-2026-flat'), suggestedFolder: 'Frameworks' };
		expect(recognizedDestination(generic, 'Ontologies')).toBeNull();
	});
});

describe('honestEnrichment (spec §7m curated defaults — honest handling)', () => {
	it('every bundled recipe today is not-live, so the hint stays off (matches the registry doc comment)', () => {
		for (const e of RECIPE_REGISTRY) {
			expect(honestEnrichment(e)).toBeUndefined();
		}
	});

	it('turns children_lists on only when the recipe already emits a parent link', () => {
		expect(honestEnrichment(fakeEntry({ childrenLists: true, hasParentLink: false }))).toBeUndefined();
		expect(honestEnrichment(fakeEntry({ childrenLists: true, hasParentLink: true }))).toEqual({
			children_lists: true,
		});
	});

	it('turns facet_notes "notes" on only when the recipe already emits a tag destination', () => {
		expect(honestEnrichment(fakeEntry({ facetNotes: 'notes', hasTagEmit: false }))).toBeUndefined();
		expect(honestEnrichment(fakeEntry({ facetNotes: 'notes', hasTagEmit: true }))).toEqual({
			facet_notes: 'notes',
		});
	});

	it('never turns on "tags-only" or "none" facet hints, even with a live tag emit (nothing to gate on)', () => {
		expect(honestEnrichment(fakeEntry({ facetNotes: 'tags-only', hasTagEmit: true }))).toBeUndefined();
		expect(honestEnrichment(fakeEntry({ facetNotes: 'none', hasTagEmit: true }))).toBeUndefined();
	});

	it('combines both when both are live', () => {
		expect(
			honestEnrichment(fakeEntry({ childrenLists: true, hasParentLink: true, facetNotes: 'notes', hasTagEmit: true })),
		).toEqual({ children_lists: true, facet_notes: 'notes' });
	});
});

describe('shouldAutoApplyRecognizedMatch (settings § Suggestions, "Skip the recognized-source card on exact matches")', () => {
	it('a 100% match auto-advances when the setting is on', () => {
		expect(shouldAutoApplyRecognizedMatch(true, 100)).toBe(true);
	});

	it('a 95% match never auto-advances, even with the setting on', () => {
		expect(shouldAutoApplyRecognizedMatch(true, 95)).toBe(false);
	});

	it('a 100% match never auto-advances when the setting is off (the default)', () => {
		expect(shouldAutoApplyRecognizedMatch(false, 100)).toBe(false);
	});

	it('a 95% match never auto-advances when the setting is off', () => {
		expect(shouldAutoApplyRecognizedMatch(false, 95)).toBe(false);
	});
});
