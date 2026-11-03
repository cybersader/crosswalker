/**
 * recognized-defaults.test.ts — the recognized-source fast path's curated
 * defaults (spec §7m): `recognizedDestination` (suggestedFolder) and
 * `honestEnrichment` (the honesty-gated recommendedEnrichment hint).
 *
 * Both are pure functions exported from import-wizard.ts specifically so
 * they're unit-testable without mounting the wizard's DOM.
 */

import { recognizedDestination, resolveDestinationDefault, honestEnrichment, shouldAutoApplyRecognizedMatch } from '../src/import/import-wizard';
import { RECIPE_REGISTRY, libraryRegistryEntry, summarizeRecipeShapes, type RecipeRegistryEntry } from '../src/import/recipe-registry';

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
			levelHubs: false,
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

describe('recognizedDestination: evidence link folder setting (2026-10-28)', () => {
	// Bulk evidence link imports must land where the single-link command writes:
	// the user's evidence link folder setting, not the registry's curated folder.
	it('a junction-note recipe lands in the evidence link folder when one is given', () => {
		const e = entry('evidence-junction-notes');
		expect(e.routingKind).toBe('junction-note');
		expect(recognizedDestination(e, 'Ontologies', 'Audit/Links')).toBe('Audit/Links');
	});

	it('a junction-note recipe keeps its curated folder when no evidence folder is given', () => {
		const e = entry('evidence-junction-notes');
		expect(recognizedDestination(e, 'Ontologies')).toBe(e.suggestedFolder);
	});

	it('a crosswalk-edge recipe ignores the evidence folder and keeps its curated folder', () => {
		const e = entry('olir-crosswalk-edge');
		expect(e.routingKind).toBe('crosswalk-edge');
		expect(recognizedDestination(e, 'Ontologies', 'Audit/Links')).toBe(e.suggestedFolder);
	});

	it('a concept recipe is unaffected by the evidence folder', () => {
		const e = entry('cis-controls-v8-flat');
		expect(recognizedDestination(e, 'Ontologies', 'Audit/Links')).toBe(recognizedDestination(e, 'Ontologies'));
	});

	it('resolveDestinationDefault passes the evidence folder through for a junction-note recipe', () => {
		const e = entry('evidence-junction-notes');
		expect(resolveDestinationDefault('Ontologies', 'evidence.csv', e, 'Audit/Links')).toBe('Audit/Links');
	});
});

describe('honestEnrichment (spec §7m curated defaults — honest handling)', () => {
	it('previous recipes retain their inert hints; linked defaults declare their enrichment', () => {
		for (const e of RECIPE_REGISTRY) {
			if (e.id.endsWith('-linked')) expect(honestEnrichment(e)).toEqual(e.recipe.target.enrichment);
			else expect(honestEnrichment(e)).toBeUndefined();
		}
	});

	it('turns children_lists on only when the recipe already emits a parent link', () => {
		expect(honestEnrichment(fakeEntry({ childrenLists: true, hasParentLink: false }))).toBeUndefined();
		expect(honestEnrichment(fakeEntry({ childrenLists: true, hasParentLink: true }))).toEqual({
			children_lists: true,
		});
	});

	it.each(['mitre-f3-technique-linked', 'nist-csf-2-cprt-linked'])('preserves live enrichment for a saved library copy of %s', (id) => {
		const builtIn = entry(id);
		const recipe = JSON.parse(JSON.stringify(builtIn.recipe)) as typeof builtIn.recipe;
		recipe.recipe = 'team-copy';
		recipe.metadata = { ...recipe.metadata, based_on: {
			recipe: id, hash: 'test-hash', spec_version: recipe.spec_version ?? 'https://crosswalker.dev/spec/recipe.schema.json',
		} };
		const saved = libraryRegistryEntry(recipe);
		expect(saved.origin).toBe('user');
		expect(honestEnrichment(saved)).toEqual(builtIn.recipe.target.enrichment);
	});

	it('keeps the pre-slice effective enrichment for every previously shipped registry entry', () => {
		for (const e of RECIPE_REGISTRY.filter((item) => !['mitre-f3-technique-linked', 'nist-csf-2-cprt-linked'].includes(item.id))) {
			const shapes = summarizeRecipeShapes(e);
			const implied = e.recipe.target.layout.some((level) => level.mechanism === 'folder' && level.implied_concept);
			const children = e.recommendedEnrichment.childrenLists && (shapes.includes('links') || implied);
			const hubs = e.recommendedEnrichment.levelHubs && e.recipe.target.enrichment?.level_hubs === 'notes';
			const facets = e.recommendedEnrichment.facetNotes === 'notes' && shapes.includes('tags');
			const previous = !children && !hubs && !facets ? undefined : {
				...(e.recipe.target.enrichment?.facet_source ? { facet_source: e.recipe.target.enrichment.facet_source } : {}),
				...(children ? { children_lists: true } : {}),
				...(hubs ? { level_hubs: 'notes' } : {}),
				...(facets ? { facet_notes: 'notes' } : {}),
			};
			expect({ id: e.id, enrichment: honestEnrichment(e) }).toEqual({ id: e.id, enrichment: previous });
		}
	});

	it('gates folder-only children lists on declared folder index notes', () => {
		const previous = entry('nist-csf-2-cprt-hierarchical');
		const hinted = { ...previous, recommendedEnrichment: {
			...previous.recommendedEnrichment, childrenLists: true, levelHubs: true,
		} };
		expect(honestEnrichment(hinted)).toBeUndefined();
		const withHubs = { ...hinted, recipe: { ...hinted.recipe, target: {
			...hinted.recipe.target, enrichment: { children_lists: true, level_hubs: 'notes' as const },
		} } };
		expect(honestEnrichment(withHubs)).toEqual({ children_lists: true, level_hubs: 'notes' });
		const withoutFolders = { ...withHubs, recipe: { ...withHubs.recipe, target: {
			...withHubs.recipe.target, layout: withHubs.recipe.target.layout.filter((level) => level.mechanism === 'file'),
		} } };
		expect(honestEnrichment(withoutFolders)).toEqual({ level_hubs: 'notes' });
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
