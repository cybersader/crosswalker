import { TFile, TFolder } from 'obsidian';

import richFixture from './fixtures/portable-import-recipe-rich.json';
import crosswalkRecipe from '../recipes/import/crosswalk-edge.json';
import {
	canonicalToMapping,
	diagnoseEditableMapping,
	loadRecipeDocument,
	patchRecipeDocument,
	recipesSemanticallyEqual,
	serializeCanonicalRecipe,
} from '../src/import/recipe-document';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import type { ImportMapping } from '../src/import/mapping/types';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { DebugLog } from '../src/utils/debug';
import type { ParsedData, ImportRecipe } from '../src/types/config';
import { generateNotes } from '../src/generation/generation-engine';
import { computeRecipeDocumentDigest, computeRecipeHash } from '../src/generation/hash';
import { render } from '../src/render';
import { validateRecipe } from '../src/validation/validator';

const rich = richFixture as unknown as CrosswalkerImportRecipe;
const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;

function loadRich() {
	const loaded = loadRecipeDocument(rich, { origin: 'bundled' });
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) throw new Error(loaded.diagnostics.map((d) => d.message).join('; '));
	return loaded.document;
}

function richRow(): Record<string, unknown> {
	return {
		edge_id: 'CW.1',
		title: 'Account management equivalence',
		subject_id: 'nist:AC-2',
		predicate_id: 'is_equivalent_to',
		object_id: 'iso27001:A.9.2.1',
		subject_group: 'Access control',
		mapping_justification: 'semapv:ManualMappingCuration',
		mapping_provider: 'Portable fixture',
		related: 'nist:AC-3; iso27001:A.9.2.2',
		description: 'Primary body text.',
		discussion: 'Line one\nLine two',
		example: 'const edge = true;',
		items: 'one\ntwo',
	};
}

describe('RecipeDocument canonical preservation boundary', () => {
	it('canonical load → document → no-op patch preserves semantic equality and canonical bytes', () => {
		const document = loadRich();
		const patched = patchRecipeDocument(document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;

		expect(patched.dirty).toBe(false);
		expect(patched.recipe.recipe).toBe(rich.recipe);
		expect(recipesSemanticallyEqual(patched.recipe, rich)).toBe(true);
		expect(serializeCanonicalRecipe(patched.recipe)).toBe(serializeCanonicalRecipe(rich));
	});

	it('a no-op patch without ancestry does not mint an id, ancestry, or digest', () => {
		const withoutAncestry = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
		delete withoutAncestry.metadata?.based_on;
		const loaded = loadRecipeDocument(withoutAncestry, { origin: 'bundled' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(false);
		expect(patched.recipe.recipe).toBe(withoutAncestry.recipe);
		expect(patched.recipe.metadata?.based_on).toBeUndefined();
	});

	it('preserves an existing ancestor digest and opaque canonical fields through no-op serialization', () => {
		const withDigest = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe & Record<string, unknown>;
		withDigest.$comment = 'Opaque author note';
		withDigest.metadata!.based_on!.recipe_document_digest = `sha256-${'2'.repeat(64)}`;
		(withDigest.query as Record<string, unknown>).opaque_extension = { keep: ['first', 'second'] };
		const loaded = loadRecipeDocument(withDigest, { origin: 'bundled' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(false);
		expect(patched.recipe.metadata?.based_on?.recipe_document_digest).toBe(`sha256-${'2'.repeat(64)}`);

		const reparsed = JSON.parse(serializeCanonicalRecipe(patched.recipe)) as CrosswalkerImportRecipe & Record<string, unknown>;
		expect(reparsed.$comment).toBe('Opaque author note');
		expect(reparsed.metadata?.based_on?.recipe_document_digest).toBe(`sha256-${'2'.repeat(64)}`);
		expect((reparsed.query as Record<string, unknown>).opaque_extension).toEqual({ keep: ['first', 'second'] });
	});

	it('a dirty fresh document keeps its id and does not mint ancestry', () => {
		const fresh = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
		delete fresh.metadata?.based_on;
		const loaded = loadRecipeDocument(fresh, { origin: 'fresh' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const mapping = JSON.parse(JSON.stringify(loaded.document.mapping)) as ImportMapping;
		mapping.enrichment = { ...(mapping.enrichment ?? {}), parent_note: 'folder-note' };

		const patched = patchRecipeDocument(loaded.document, { mapping });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(true);
		expect(patched.recipe.recipe).toBe(fresh.recipe);
		expect(patched.recipe.metadata?.based_on).toBeUndefined();
	});

	it('preserves prefixed multi-column templates in the bundled crosswalk recipe', () => {
		const loaded = loadRecipeDocument(crosswalkRecipe, { origin: 'bundled' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(false);
		expect(patched.recipe.recipe).toBe('olir-crosswalk-edge');
		expect(patched.recipe.target.layout[0].template).toBe(
			'cw-{subject_id|slug}--{object_id|slug}.md',
		);
		const address = render(patched.recipe as never, {
			curie: 'xwalk:e2e',
			scope: {
				subject_id: 'e2e:SOURCE',
				strm_predicate: 'is_equivalent_to',
				object_id: 'e2e:TARGET',
				subject_group: 'Source',
				object_group: 'Target',
				source_framework: 'Source framework',
				target_framework: 'Target framework',
				match_confidence: '0.95',
				mapping_justification: 'Manual review',
				mapping_provider: 'Portable test',
				mapping_set_id: '',
				predicate_modifier: '',
				sssom_predicate: 'skos:exactMatch',
			},
		});
		expect(address.frontmatter.match_confidence).toBe(0.95);
	});

	it('preserves canonical array order when emissions belong to different mapping levels', () => {
		const ordered = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
		ordered.target.also_emit!.aliases = ['{title}', '{edge_id}'];
		ordered.target.also_emit!.body = [
			{ template: '{title}', position: 'append' },
			{ template: '{edge_id}', position: 'section', heading: 'Identifier' },
		];
		const loaded = loadRecipeDocument(ordered, { origin: 'bundled' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(false);
		expect(patched.recipe.target.also_emit?.aliases).toEqual(['{title}', '{edge_id}']);
		expect(patched.recipe.target.also_emit?.body).toEqual(loaded.document.original.target.also_emit?.body);
	});

	it('keeps source levels synchronized with edited layout levels', () => {
		const document = loadRich();
		const mapping = JSON.parse(JSON.stringify(document.mapping)) as ImportMapping;
		mapping.mappings[0].levels[0].level = 'collection';

		const patched = patchRecipeDocument(document, { mapping });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.recipe.source.levels).toEqual(['collection', 'edge']);
		expect(patched.recipe.target.layout[0].level).toBe('collection');
	});

	it('one mapping edit changes only its owned region and preserves deferred canonical fields', () => {
		const document = loadRich();
		const mapping = JSON.parse(JSON.stringify(document.mapping)) as ImportMapping;
		const titleRule = mapping.mappings
			.flatMap((structure) => structure.levels)
			.find((level) => level.destinations.some((dest) => dest.primitive === 'property' && dest.key === 'title'))!;
		const titleDest = titleRule.destinations.find(
			(dest): dest is Extract<typeof dest, { primitive: 'property' }> => dest.primitive === 'property' && dest.key === 'title',
		)!;
		titleDest.key = 'display_title';

		const patched = patchRecipeDocument(document, { mapping });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;

		expect(patched.dirty).toBe(true);
		expect(patched.recipe.target.layout).toEqual(document.original.target.layout);
		expect(patched.recipe.target.also_emit?.frontmatter?.managed?.display_title).toBe('{title}');
		expect(patched.recipe.target.also_emit?.frontmatter?.managed?.title).toBeUndefined();
		expect(patched.recipe.target.graph_edges).toEqual(document.original.target.graph_edges);
		expect(patched.recipe.target.linkStyle).toBe('shortest');
		expect(patched.recipe.query).toEqual(document.original.query);
		expect(patched.recipe.target.layout.at(-1)?.kind).toBe('crosswalk-edge');
	});

	it('customization creates deterministic ancestry from the normalized original and never mutates it', () => {
		const document = loadRich();
		const before = serializeCanonicalRecipe(document.original);
		const originalDigest = computeRecipeDocumentDigest(document.original);
		const originalEffectiveHash = computeRecipeHash(document.original.target, document.original.source);
		const mapping = JSON.parse(JSON.stringify(document.mapping)) as ImportMapping;
		mapping.enrichment = { ...(mapping.enrichment ?? {}), parent_note: 'folder-note' };

		const patched = patchRecipeDocument(document, { mapping });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;

		expect(patched.recipe.recipe).toBe('portable-contract-rich-custom');
		expect(patched.recipe.metadata?.based_on).toEqual({
			recipe: 'portable-contract-rich',
			hash: originalEffectiveHash,
			recipe_document_digest: originalDigest,
			spec_version: 'https://crosswalker.dev/spec/recipe.schema.json',
		});
		expect(patched.recipe.metadata?.based_on?.recipe_document_digest).not.toBe(
			computeRecipeDocumentDigest(patched.recipe),
		);
		expect(validateRecipe(patched.recipe).valid).toBe(true);
		expect(serializeCanonicalRecipe(document.original)).toBe(before);
	});

	it('preserves managed links, user preserve, body details, constants, variadic layout, enrichment, query, graph edges, and link style', () => {
		const document = loadRich();
		const patched = patchRecipeDocument(document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;

		const target = patched.recipe.target;
		expect(target.also_emit?.frontmatter?.managed_links).toEqual(rich.target.also_emit?.frontmatter?.managed_links);
		expect(target.also_emit?.frontmatter?.user_preserve).toEqual(['reviewer', 'status', '*notes*']);
		expect(target.also_emit?.body).toEqual(expect.arrayContaining([
			expect.objectContaining({ position: 'section', heading: 'Discussion', format: 'quote' }),
			expect.objectContaining({ position: 'section', heading: 'Example', format: 'code' }),
		]));
		expect(target.layout[0].template).toBe('Frameworks/Portable');
		expect(target.layout[1]).toEqual(expect.objectContaining({
			level: 'edge',
			mechanism: 'folder',
			variadic: expect.objectContaining({ delimiter: '.', on_overflow: 'error' }),
		}));
		expect(target.enrichment).toEqual(rich.target.enrichment);
		expect(target.graph_edges).toEqual(rich.target.graph_edges);
		expect(target.linkStyle).toBe('shortest');
		expect(patched.recipe.query).toEqual(rich.query);
	});

	it('retains source-compatibility diagnostics and blocks apply instead of dropping missing columns', () => {
		const loaded = loadRecipeDocument(rich, {
			origin: 'bundled',
			sourceColumns: ['edge_id', 'title'],
		});
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.document.diagnostics.some((diagnostic) => diagnostic.code === 'source-column-missing')).toBe(true);
		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(false);
		expect(patched.diagnostics.some((diagnostic) => diagnostic.code === 'source-column-missing')).toBe(true);
	});

	it('returns explicit blocking diagnostics for every nonportable editable field', () => {
		const mapping: ImportMapping = {
			mappings: [{
				levels: [{
					level: 'leaf',
					source: { column: 'id' },
					naming: { lookup: 'title' },
					missing: 'error',
					materialize: true,
					destinations: [
						{ primitive: 'name' },
						{ primitive: 'note' },
						{ primitive: 'body', position: 'table-row', transform: 'trim' },
						{ primitive: 'link', key: 'parent', direction: 'both', predicate: 'skos:broader' },
						{ primitive: 'property', key: 'labels', list: true },
					],
				}],
			}],
			filters: [{ column: 'status', op: 'equals', value: 'active' }],
		};
		const codes = diagnoseEditableMapping(mapping).map((diagnostic) => diagnostic.code);
		expect(codes).toEqual(expect.arrayContaining([
			'row-filters-not-portable',
			'missing-policy-not-portable',
			'materialize-not-portable',
			'naming-lookup-not-portable',
			'note-destination-not-portable',
			'body-table-row-not-portable',
			'body-transform-not-portable',
			'link-semantics-not-portable',
			'property-list-not-portable',
		]));

		const patched = patchRecipeDocument(loadRich(), { mapping });
		expect(patched.ok).toBe(false);
		expect(patched.diagnostics.every((diagnostic) => diagnostic.severity === 'blocking' || diagnostic.severity === 'warning')).toBe(true);
	});

	it('render evaluates the rich canonical body and retains the crosswalk-edge kind', () => {
		const address = render(rich as never, { curie: 'portable-contract:cw-1', scope: richRow() });
		expect(address.frontmatter.kind).toBe('crosswalk-edge');
		expect(address.body).toEqual([
			{ position: 'append', content: 'Primary body text.' },
			{ position: 'section', heading: 'Discussion', headingDepth: 2, content: '> Line one\n> Line two' },
			{ position: 'section', heading: 'Example', headingDepth: 3, content: '```\nconst edge = true;\n```' },
			{ position: 'append', content: '- one\n- two' },
		]);
	});
});

describe('MappingWorkbench RecipeDocument integration', () => {
	function workbench(): { wb: MappingWorkbench; parsedData: ParsedData } {
		const row = richRow();
		const parsedData: ParsedData = { columns: Object.keys(row), rows: [row], rowCount: 1 };
		return {
			parsedData,
			wb: new MappingWorkbench({
				parsedData,
				columnInfos: analyzeColumns(parsedData),
				outputPath: 'Mappings',
				debug,
				defaultPresetId: 'browsable-framework',
				initialRecipe: rich,
				recipeOrigin: 'bundled',
				seedColumnDefaults: false,
				onChange: () => {},
			}),
		};
	}

	it('recognized recipes keep canonical identity, kind, body, and deferred fields through workbench assembly', () => {
		const { wb } = workbench();
		const recipe = wb.buildRecipe();
		expect(recipe.recipe).toBe('portable-contract-rich');
		expect(recipe.target.layout.at(-1)?.kind).toBe('crosswalk-edge');
		expect(recipe.target.also_emit?.body).toHaveLength(4);
		expect(recipe.target.also_emit?.frontmatter?.managed_links?.related.split).toEqual([',', ';']);
		expect((recipe as unknown as CrosswalkerImportRecipe).query).toEqual(rich.query);
		expect(recipe.target.graph_edges).toEqual(rich.target.graph_edges);
		expect(recipe.target.linkStyle).toBe('shortest');
	});

	it('tracks dirty state and derives custom identity after a recognized workbench edit', () => {
		const { wb } = workbench();
		expect(wb.getRecipeDocument().dirty).toBe(false);
		(wb as unknown as { updateEnrichment: (patch: { parent_note: 'folder-note' }) => void })
			.updateEnrichment({ parent_note: 'folder-note' });
		expect(wb.getRecipeDocument().dirty).toBe(true);
		expect(wb.buildRecipe().recipe).toBe('portable-contract-rich-custom');
	});

	it('detected edge sources retain crosswalk-edge kind through recipe assembly and preview', () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({
			subject_id: `nist:AC-${index + 1}`,
			predicate_id: 'is_equivalent_to',
			object_id: `iso27001:A.${index + 1}`,
			mapping_justification: 'semapv:ManualMappingCuration',
		}));
		const parsedData: ParsedData = { columns: Object.keys(rows[0]), rows, rowCount: rows.length };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Mappings',
			debug,
			defaultPresetId: 'browsable-framework',
			sourceOntology: 'detected-crosswalk.csv',
			onChange: () => {},
		});
		expect(wb.buildRecipe().target.layout.at(-1)?.kind).toBe('crosswalk-edge');
		expect(wb.computePreview()?.addresses[0].address.frontmatter.kind).toBe('crosswalk-edge');
	});

	it('fresh detection sessions receive a complete deterministic canonical draft', () => {
		const rows = Array.from({ length: 10 }, (_, index) => ({
			id: `A-${index + 1}`,
			title: `Alpha ${index + 1}`,
			description: `Long body for row ${index + 1}. `.repeat(8),
		}));
		const parsedData: ParsedData = { columns: Object.keys(rows[0]), rows, rowCount: rows.length };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Frameworks',
			debug,
			defaultPresetId: 'browsable-framework',
			sourceOntology: 'Example controls.csv',
			onChange: () => {},
		});
		const recipe = wb.buildRecipe() as unknown as CrosswalkerImportRecipe;
		expect(recipe.recipe).toBe('custom-example-controls');
		expect(recipe.spec_version).toBe('https://crosswalker.dev/spec/recipe.schema.json');
		expect(recipe.source.ontology).toBe('example-controls');
		expect(recipe.source.levels.length).toBeGreaterThan(0);
		expect(recipe.target.also_emit?.body?.[0]).toEqual(expect.objectContaining({
			position: 'append',
			template: '{description}',
		}));
	});

	it('generation records recognized identity and emits crosswalk kind plus canonical body', async () => {
		const { wb, parsedData } = workbench();
		const files = new Map<string, string>();
		const folders = new Set<string>(['']);
		const app = {
			vault: {
				// generateNotes resolves existing notes by identity, which reads the
				// vault markdown list. This double has no pre-existing notes.
				getMarkdownFiles: () => [],
				getAbstractFileByPath(path: string) {
					if (files.has(path)) return new TFile(path);
					if (folders.has(path)) return new TFolder(path);
					return null;
				},
				async create(path: string, content: string) { files.set(path, content); return new TFile(path); },
				async modify(file: TFile, content: string) { files.set(file.path, content); },
				async read(file: TFile) { return files.get(file.path) ?? ''; },
				async createFolder(path: string) { folders.add(path); },
				async rename(file: TFile, path: string) {
					const content = files.get(file.path);
					if (content !== undefined) { files.delete(file.path); files.set(path, content); }
				},
				async delete(file: TFile) { files.delete(file.path); },
			},
			metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
		};
		const config: Partial<ImportRecipe> = {
			name: 'workbench',
			mapping: {
				hierarchy: [],
				frontmatter: [],
				links: [],
				body: wb.getLegacyBodyMappings(),
				filename: { template: wb.leafFileTemplate()!, sanitize: true },
			},
		};
		const result = await generateNotes(
			app as never,
			parsedData,
			config,
			{
				basePath: 'Mappings',
				overwriteMode: 'replace',
				createFolders: true,
				recipeOverride: wb.buildRecipe(),
			},
			debug,
		);
		expect(result.errors).toEqual([]);
		const edge = [...files.entries()].find(([, content]) => content.includes('kind: crosswalk-edge'));
		expect(edge).toBeDefined();
		expect(edge![1]).toContain('kind: crosswalk-edge');
		expect(edge![1]).toContain('id: portable-contract-rich');
		expect(edge![1]).toContain('Primary body text.');
		expect(edge![1]).toContain('## Discussion');
		expect(edge![1]).toContain('> Line one');
		expect(edge![1]).toContain('### Example');
	});
});
