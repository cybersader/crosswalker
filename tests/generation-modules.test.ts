/**
 * generation-modules.test.ts — Jest unit tests for v0.1.3 modules
 *
 * Covers:
 *   - legacy-recipe-shim — translates v0.1.0 ImportRecipe → Ch 22 Recipe
 *   - frontmatter-merge — managed/user_preserve merge semantics
 *   - provenance — _crosswalker block conforms to spec/tier1.schema.json
 *
 * Each module is a pure function; tests assert correct mapping rules,
 * idempotency, edge cases, and round-trip determinism.
 */

import { legacyConfigToRecipe } from '../src/generation/legacy-recipe-shim';
import { mergeFrontmatter, computeDeclaredManagedKeys, computeManagedKeys } from '../src/generation/frontmatter-merge';
import { buildProvenance } from '../src/generation/provenance';
import {
	buildConfigFromWizardState,
	buildNoteData,
	buildNoteContent,
	composeDocumentBody,
	renderedBodyRegionsToMarkdown,
	normalizeTagList,
	normalizeAliasList,
} from '../src/generation/generation-engine';
import type { ImportRecipe as LegacyImportRecipe, MappingConfig } from '../src/types/config';

// ---------------------------------------------------------------------------
// legacy-recipe-shim
// ---------------------------------------------------------------------------

describe('legacyConfigToRecipe', () => {
	const sampleLegacy: LegacyImportRecipe = {
		name: 'nist-test',
		version: '1.0',
		source: { type: 'csv' },
		transforms: {},
		mapping: {
			hierarchy: [
				{ column: 'family', level: 1 },
				{ column: 'control_id', level: 2 },
			],
			frontmatter: [
				{ column: 'control_name', key: 'title' },
				{ column: 'family', key: 'family_id' },
			],
			body: [],
			links: [],
			filename: { template: '{control_id}', sanitize: true },
		},
		output: { basePath: 'Frameworks/NIST', overwriteMode: 'skip', createFolders: true },
	};

	it('produces a Ch 22 Recipe shape', () => {
		const r = legacyConfigToRecipe(sampleLegacy);
		expect(r.recipe).toBe('nist-test');
		expect(r.source?.ontology).toBe('nist-test');
		expect(r.target.layout.length).toBe(3); // 2 hierarchy + 1 file leaf
	});

	it('translates hierarchy levels to ordered folder mechanisms', () => {
		const r = legacyConfigToRecipe(sampleLegacy);
		expect(r.target.layout[0]).toMatchObject({
			mechanism: 'folder',
			template: '{family}',
		});
		expect(r.target.layout[1]).toMatchObject({
			mechanism: 'folder',
			template: '{control_id}',
		});
	});

	it('sorts hierarchy by level even when input is out of order', () => {
		const config = {
			...sampleLegacy,
			mapping: {
				...sampleLegacy.mapping!,
				hierarchy: [
					{ column: 'control_id', level: 5 },
					{ column: 'family', level: 1 },
					{ column: 'subfamily', level: 3 },
				],
			},
		};
		const r = legacyConfigToRecipe(config);
		const folderTemplates = r.target.layout
			.filter((e) => e.mechanism === 'folder')
			.map((e) => e.template);
		expect(folderTemplates).toEqual(['{family}', '{subfamily}', '{control_id}']);
	});

	it('appends a file mechanism using the filename column', () => {
		const r = legacyConfigToRecipe(sampleLegacy);
		const leaf = r.target.layout[r.target.layout.length - 1];
		expect(leaf.mechanism).toBe('file');
		expect(leaf.template).toBe('{control_id}.md');
	});

	it('translates frontmatter mappings into optional also_emit.frontmatter.managed templates', () => {
		const r = legacyConfigToRecipe(sampleLegacy);
		expect(r.target.also_emit?.frontmatter?.managed).toEqual({
			title: '{control_name|optional}',
			family_id: '{family|optional}',
		});
	});

	it('handles configs without hierarchy (flat output)', () => {
		const config = { ...sampleLegacy, mapping: { ...sampleLegacy.mapping!, hierarchy: [] } };
		const r = legacyConfigToRecipe(config);
		expect(r.target.layout.length).toBe(1); // just the leaf
		expect(r.target.layout[0].mechanism).toBe('file');
	});

	it('falls back to first frontmatter column when filename config is absent', () => {
		const config = {
			...sampleLegacy,
			mapping: { ...sampleLegacy.mapping!, filename: undefined as any },
		};
		const r = legacyConfigToRecipe(config);
		const leaf = r.target.layout[r.target.layout.length - 1];
		expect(leaf.template).toBe('{control_name}.md');
	});

	it('respects an explicit filename template, ensuring .md suffix', () => {
		const config = {
			...sampleLegacy,
			mapping: {
				...sampleLegacy.mapping!,
				filename: { template: '{control_id}-{family}', sanitize: true },
			},
		};
		const r = legacyConfigToRecipe(config);
		const leaf = r.target.layout[r.target.layout.length - 1];
		expect(leaf.template).toBe('{control_id}-{family}.md');
	});

	it('produces structurally-identical output for identical input (purity)', () => {
		const a = JSON.stringify(legacyConfigToRecipe(sampleLegacy));
		const b = JSON.stringify(legacyConfigToRecipe(sampleLegacy));
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// frontmatter-merge
// ---------------------------------------------------------------------------

describe('mergeFrontmatter + computeManagedKeys', () => {
	it('overwrites managed keys', () => {
		const existing = { title: 'Old Title', family_id: 'old' };
		const managed = { title: 'New Title', family_id: 'new' };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.title).toBe('New Title');
		expect(result.family_id).toBe('new');
	});

	it('preserves user keys NOT in the managed set', () => {
		const existing = { title: 'Old', reviewer: 'alice', status: 'approved' };
		const managed = { title: 'New' };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.reviewer).toBe('alice');
		expect(result.status).toBe('approved');
		expect(result.title).toBe('New');
	});

	it('always overwrites _crosswalker provenance + curie', () => {
		const existing = {
			curie: 'old:CURIE',
			_crosswalker: { spec_version: 'old' },
			user_field: 'preserved',
		};
		const managed = {
			curie: 'new:CURIE',
			_crosswalker: { spec_version: 'new' },
		};
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.curie).toBe('new:CURIE');
		expect((result._crosswalker as Record<string, unknown>).spec_version).toBe('new');
		expect(result.user_field).toBe('preserved');
	});

	it('honors user_preserve patterns (exact match)', () => {
		const existing = { reviewer: 'alice' };
		const managed = { reviewer: 'recipe-default' };
		const keys = computeManagedKeys(managed, ['reviewer']);
		const result = mergeFrontmatter(existing, managed, keys);
		// reviewer is user_preserve → existing value wins
		expect(result.reviewer).toBe('alice');
	});

	it('honors user_preserve patterns (glob)', () => {
		const existing = { user_notes: 'hand-written', user_status: 'in-review' };
		const managed = { user_notes: 'recipe-default', user_status: 'pending' };
		const keys = computeManagedKeys(managed, ['user_*']);
		const result = mergeFrontmatter(existing, managed, keys);
		expect(result.user_notes).toBe('hand-written');
		expect(result.user_status).toBe('in-review');
	});

	it('clears a declared parent_curie when the source becomes empty', () => {
		const existing = { parent_curie: 'x:OLD', user_note: 'keep' };
		const managed = { curie: 'x:ROOT' };
		const declared = computeDeclaredManagedKeys({ managed: { parent_curie: '{parent_id|optional}' } });
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed, [], declared));
		expect(result).not.toHaveProperty('parent_curie');
		expect(result.user_note).toBe('keep');
	});

	it('clears a declared predicate_modifier when a mapping becomes positive', () => {
		const existing = { predicate_modifier: 'NOT', user_note: 'keep' };
		const managed = { kind: 'crosswalk-edge' };
		const declared = computeDeclaredManagedKeys({ managed: { predicate_modifier: '{predicate_modifier|optional}' } });
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed, [], declared));
		expect(result).not.toHaveProperty('predicate_modifier');
		expect(result.user_note).toBe('keep');
	});

	it('clears declared managed links while user_preserve can retain declared empty keys', () => {
		const existing = { related: ['[[Old]]'], reviewer: 'alice' };
		const managed = {};
		const declared = computeDeclaredManagedKeys({
			managed: { reviewer: '{reviewer|optional}' },
			managed_links: { related: { template: '{related|optional}' } },
		});
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed, ['reviewer'], declared));
		expect(result).not.toHaveProperty('related');
		expect(result.reviewer).toBe('alice');
	});

	it('produces identical output for identical input (purity)', () => {
		const existing = { title: 'X' };
		const managed = { title: 'Y', family: 'AC' };
		const a = JSON.stringify(mergeFrontmatter(existing, managed, computeManagedKeys(managed)));
		const b = JSON.stringify(mergeFrontmatter(existing, managed, computeManagedKeys(managed)));
		expect(a).toBe(b);
	});

	it('idempotent: merge(merge(x, y)) === merge(x, y) for the same managed set', () => {
		const existing = { reviewer: 'alice' };
		const managed = { title: 'AC-2' };
		const keys = computeManagedKeys(managed);

		const once = mergeFrontmatter(existing, managed, keys);
		const twice = mergeFrontmatter(once, managed, keys);
		expect(twice).toEqual(once);
	});
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

describe('buildProvenance', () => {
	const VERSION = '0.1.0';

	it('produces spec/tier1.schema.json provenance_block shape', () => {
		const result = buildProvenance(
			{ sourceFile: 'NIST.csv', recipeId: 'nist-all-folders' },
			VERSION,
		);
		expect(result.spec_version).toBe('https://crosswalker.dev/spec/tier1.schema.json');
		expect((result.source_ref as Record<string, unknown>).file).toBe('NIST.csv');
		expect(typeof result.produced_at).toBe('string');
		expect((result.producer as Record<string, unknown>).kind).toBe('plugin-engine');
		expect((result.producer as Record<string, unknown>).version).toBe(VERSION);
		expect((result.recipe as Record<string, unknown>).id).toBe('nist-all-folders');
	});

	it('falls back to curie:unknown when no source_ref keys provided', () => {
		const result = buildProvenance({}, VERSION);
		expect((result.source_ref as Record<string, unknown>).curie).toBe('unknown:_');
	});

	it('omits recipe block when no recipeId provided', () => {
		const result = buildProvenance({ sourceFile: 'X.csv' }, VERSION);
		expect(result.recipe).toBeUndefined();
	});

	it('includes optional fields when provided', () => {
		const result = buildProvenance(
			{
				sourceFile: 'NIST.csv',
				sourceVersion: 'rev 5',
				sourceHash: 'sha256-abc',
				recipeId: 'r1',
				recipeHash: 'sha256-def',
				conceptCid: 'sha256-xyz',
			},
			VERSION,
		);
		expect((result.source_ref as Record<string, unknown>).version).toBe('rev 5');
		expect((result.source_ref as Record<string, unknown>).source_hash).toBe('sha256-abc');
		expect((result.recipe as Record<string, unknown>).hash).toBe('sha256-def');
		expect(result.concept_cid).toBe('sha256-xyz');
	});

	it('produces a valid ISO 8601 timestamp', () => {
		const result = buildProvenance({}, VERSION);
		const ts = result.produced_at as string;
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		// Round-trip: parsing the ISO string yields a valid Date
		expect(Number.isFinite(new Date(ts).getTime())).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildConfigFromWizardState — wizard → ImportRecipe partial
// ---------------------------------------------------------------------------

describe('buildConfigFromWizardState', () => {
	it('emits no filename template when no column is marked as title', () => {
		// Regression for the 2026-05-11 wizard "0 pages generated" bug:
		// Previous fallback set template: "{{row}}" which was a stale Mustache
		// syntax leftover. The template engine threw on every row because `row`
		// isn't a column. Now: omit `filename` so the legacy-recipe-shim falls
		// through to first-frontmatter-column.
		const columnConfigs = new Map([
			['Control ID', { useAs: 'frontmatter', outputKey: 'control_id' }],
			['Control Family', { useAs: 'hierarchy', outputKey: 'control_family' }],
		]);
		const result = buildConfigFromWizardState(columnConfigs, ['Control Family', 'Control ID']);
		expect(result.mapping?.filename).toBeUndefined();
	});

	it('uses the title column with single-brace syntax when one is picked', () => {
		const columnConfigs = new Map([
			['Control ID', { useAs: 'title', outputKey: 'control_id' }],
			['Description', { useAs: 'body', outputKey: 'description' }],
		]);
		const result = buildConfigFromWizardState(columnConfigs, ['Control ID', 'Description']);
		expect(result.mapping?.filename?.template).toBe('{Control ID}');
		expect(result.mapping?.filename?.sanitize).toBe(true);
	});

	it('legacy-recipe-shim filename fallback chain resolves when no title column is picked', () => {
		// End-to-end: wizard state with no title → shim resolves to first
		// frontmatter column → render() will succeed for any row that has
		// that column populated.
		const columnConfigs = new Map([
			['Control ID', { useAs: 'frontmatter', outputKey: 'control_id' }],
		]);
		const partial = buildConfigFromWizardState(columnConfigs, ['Control ID']);
		const recipe = legacyConfigToRecipe({
			name: 'test',
			version: '1.0',
			source: { type: 'csv', path: 'x.csv' },
			...partial,
		} as LegacyImportRecipe);
		// The leaf file entry should have a non-empty template
		const fileEntries = recipe.target.layout.filter((e) => e.mechanism === 'file');
		expect(fileEntries.length).toBeGreaterThan(0);
		expect(fileEntries[0].template).toBe('{Control ID}.md');
	});
});

describe('buildNoteContent: YAML quoting of link values (graph-connectivity regression)', () => {
	// An unquoted `[[T1078]]` parses as a nested YAML array, so Obsidian indexes
	// no link at all and the graph shows nothing connected (found 2026-07-10 on
	// the first real graph test of a workbench import).
	const { buildNoteContent } = jest.requireActual('../src/generation/generation-engine');

	it('quotes wikilink property values so Obsidian indexes them as links', () => {
		const out = buildNoteContent({ parent: '[[T1078]]' }, '');
		expect(out).toContain('parent: "[[T1078]]"');
	});

	it('quotes other YAML-structural leading characters', () => {
		const out = buildNoteContent({ a: '- leading dash', b: '{brace}', c: '*star' }, '');
		expect(out).toContain('a: "- leading dash"');
		expect(out).toContain('b: "{brace}"');
		expect(out).toContain('c: "*star"');
	});

	it('leaves plain strings unquoted', () => {
		const out = buildNoteContent({ title: 'Default Accounts' }, '');
		expect(out).toContain('title: Default Accounts');
	});
});

// ---------------------------------------------------------------------------
// Tags + aliases emission (spec §7k item 3 — the connectedness mandate)
// ---------------------------------------------------------------------------

describe('normalizeTagList', () => {
	it('strips leading # and de-dupes, preserving first-seen order', () => {
		expect(
			normalizeTagList(['#tactic/persistence', 'tactic/persistence', 'tactic/defense-evasion']),
		).toEqual(['tactic/persistence', 'tactic/defense-evasion']);
	});

	it('trims and drops empty values', () => {
		expect(normalizeTagList([' facet/a ', '', '   ', '#'])).toEqual(['facet/a']);
	});

	it('is deterministic (same input → deep-equal output)', () => {
		const input = ['#a', 'b', 'a'];
		expect(normalizeTagList(input)).toEqual(normalizeTagList(input));
	});
});

describe('normalizeAliasList', () => {
	it('trims, drops empties, de-dupes', () => {
		expect(normalizeAliasList(['AC-2', ' AC-2 ', '', 'Account management'])).toEqual([
			'AC-2',
			'Account management',
		]);
	});
});

describe('tags/aliases → YAML block array via buildNoteContent', () => {
	it('renders a tags array as a block list, one bare tag per line', () => {
		const tags = normalizeTagList(['#tactic/persistence', 'tactic/persistence', 'tactic/defense-evasion']);
		const out = buildNoteContent({ tags }, '');
		expect(out).toContain('tags:');
		expect(out).toContain('  - tactic/persistence');
		expect(out).toContain('  - tactic/defense-evasion');
		// De-duped: persistence appears exactly once.
		expect(out.match(/- tactic\/persistence/g)?.length).toBe(1);
		// No leading '#' leaked into the frontmatter values.
		expect(out).not.toContain('#tactic');
	});

	it('renders an aliases array as a block list', () => {
		const aliases = normalizeAliasList(['AC-2', 'Account management']);
		const out = buildNoteContent({ aliases }, '');
		expect(out).toContain('aliases:');
		expect(out).toContain('  - AC-2');
		expect(out).toContain('  - Account management');
	});
});

// ---------------------------------------------------------------------------
// Re-import merge for tags/aliases (union — user-added tags survive)
// ---------------------------------------------------------------------------

describe('mergeFrontmatter: tags/aliases union on re-import', () => {
	it('preserves a user-added tag while re-applying every recipe tag', () => {
		const existing = { tags: ['tactic/persistence', 'user/favorite'] };
		const managed = { tags: ['tactic/persistence', 'tactic/defense-evasion'] };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		// Recipe tags first (in recipe order), then the user extra; de-duped.
		expect(result.tags).toEqual([
			'tactic/persistence',
			'tactic/defense-evasion',
			'user/favorite',
		]);
	});

	it('unions aliases the same way', () => {
		const existing = { aliases: ['AC-2', 'my-nickname'] };
		const managed = { aliases: ['AC-2', 'Account management'] };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.aliases).toEqual(['AC-2', 'Account management', 'my-nickname']);
	});

	it('uses recipe tags verbatim when the note has none yet', () => {
		const existing = { title: 'X' };
		const managed = { tags: ['a', 'b'] };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.tags).toEqual(['a', 'b']);
	});

	it('coerces a scalar existing tag value into the union', () => {
		const existing = { tags: 'user/solo' };
		const managed = { tags: ['recipe/one'] };
		const result = mergeFrontmatter(existing, managed, computeManagedKeys(managed));
		expect(result.tags).toEqual(['recipe/one', 'user/solo']);
	});

	it('is idempotent: merge(merge(x, y)) === merge(x, y) with tags present', () => {
		const existing = { tags: ['tactic/persistence', 'user/favorite'] };
		const managed = { tags: ['tactic/persistence', 'tactic/defense-evasion'] };
		const keys = computeManagedKeys(managed);
		const once = mergeFrontmatter(existing, managed, keys);
		const twice = mergeFrontmatter(once, managed, keys);
		expect(twice).toEqual(once);
	});
});

// ---------------------------------------------------------------------------
// composeDocumentBody — H1 title + prose (spec §7k item 2)
// ---------------------------------------------------------------------------

describe('renderedBodyRegionsToMarkdown', () => {
	it('assembles append and section regions with one blank line between regions', () => {
		expect(
			renderedBodyRegionsToMarkdown([
				{ position: 'append', content: 'Intro' },
				{ position: 'section', heading: 'Discussion', headingDepth: 2, content: '> Detail' },
				{ position: 'section', heading: 'Empty', headingDepth: 3, content: '' },
			]),
		).toBe('Intro\n\n## Discussion\n\n> Detail\n\n### Empty');
	});
});

describe('composeDocumentBody', () => {
	it('prepends an H1 title and a blank line before the body', () => {
		expect(composeDocumentBody('AC-2: Account management', 'Manages accounts.')).toBe(
			'# AC-2: Account management\n\nManages accounts.',
		);
	});

	it('returns the body unchanged when there is no title', () => {
		expect(composeDocumentBody('', 'body only')).toBe('body only');
	});

	it('returns the body unchanged when there is no body content', () => {
		expect(composeDocumentBody('A title', '   ')).toBe('   ');
	});

	it('is deterministic', () => {
		expect(composeDocumentBody('t', 'b')).toBe(composeDocumentBody('t', 'b'));
	});
});

// ---------------------------------------------------------------------------
// buildNoteData — body columns become prose body, never a property
// ---------------------------------------------------------------------------

describe('buildNoteData: body destination', () => {
	const options = { basePath: 'Frameworks/NIST', overwriteMode: 'skip' as const, createFolders: true };

	function mappingWith(body: MappingConfig['body']): MappingConfig {
		return {
			hierarchy: [],
			frontmatter: [{ column: 'name', key: 'title' }],
			links: [],
			body,
			filename: { template: '{id}', sanitize: true },
		};
	}

	const row = {
		id: 'AC-2',
		name: 'Account management',
		description: 'The organization manages information system accounts. It reviews them.',
	};

	it('routes a body column to prose in the body, not to a frontmatter property', () => {
		const note = buildNoteData(row, 1, mappingWith([{ column: 'description' }]), options, '', []);
		expect(note.body).toContain('The organization manages information system accounts.');
		// The body column must NOT leak into frontmatter as a property.
		expect(note.frontmatter).not.toHaveProperty('description');
		// A headless body mapping emits plain prose (no `## ` section heading).
		expect(note.body).not.toContain('## ');
	});

	it('emits a `## Section` heading when the body mapping carries one', () => {
		const note = buildNoteData(row, 1, mappingWith([{ column: 'description', heading: 'Description' }]), options, '', []);
		expect(note.body).toContain('## Description');
		expect(note.body).toContain('The organization manages information system accounts.');
		expect(note.frontmatter).not.toHaveProperty('description');
	});

	it('is deterministic (same row → byte-identical body)', () => {
		const a = buildNoteData(row, 1, mappingWith([{ column: 'description' }]), options, '', []);
		const b = buildNoteData(row, 1, mappingWith([{ column: 'description' }]), options, '', []);
		expect(a.body).toBe(b.body);
	});
});

describe('render: empty managed values are omitted, not emitted as broken links', () => {
	const { render } = jest.requireActual('../src/render');

	it('omits a parent key whose template renders to an empty wikilink', () => {
		const recipe = {
			recipe: 'r',
			target: {
				layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed: { parent: '[[{parent}]]', title: '{name}' } } },
			},
		};
		const rootAddr = render(recipe, { curie: 'x:CIS-1', scope: { id: 'CIS-1', parent: '', name: 'Root' } });
		expect(rootAddr.frontmatter.parent).toBeUndefined();
		expect(rootAddr.frontmatter.title).toBe('Root');
		const childAddr = render(recipe, { curie: 'x:CIS-1.1', scope: { id: 'CIS-1.1', parent: 'CIS-1', name: 'Child' } });
		expect(childAddr.frontmatter.parent).toBe('[[CIS-1]]');
	});
});
