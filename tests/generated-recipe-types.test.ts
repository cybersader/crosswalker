import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	CrosswalkerImportRecipe,
	FolderLayoutEntry,
	HeadingLayoutEntry,
	LayoutEntry,
} from '../src/types/generated/recipe';

const generatedPath = path.resolve(__dirname, '..', 'src', 'types', 'generated', 'recipe.ts');

describe('schema-generated recipe type contract', () => {
	it('emits a useful discriminated layout union and all portable contract fields', () => {
		const generated = fs.readFileSync(generatedPath, 'utf8');
		expect(generated).toContain('export type LayoutEntry =');
		expect(generated).not.toContain('export type LayoutEntry = {\n\t[k: string]: unknown;');
		for (const field of [
			"kind?: 'concept' | 'junction-note' | 'crosswalk-edge'",
			'variadic?: VariadicFolderExpansion',
			'managed_links?:',
			'user_preserve?:',
			'enrichment?: BatchEnrichmentPass15',
			'metadata?: RecipeDisplayMetadata',
			'based_on?: RecipeAncestryReference',
			'recipe_document_digest?: string',
			'version?: string',
			'body?: [BodyProjectionEntry, ...BodyProjectionEntry[]]',
			'query?: QueryBlock',
			'graph_edges?: GraphEdge[]',
			"linkStyle?: 'absolute' | 'shortest'",
		]) {
			expect(generated).toContain(field);
		}
	});

	it('discriminates folder and heading requirements at compile time', () => {
		const folder: FolderLayoutEntry = {
			level: 'edge',
			mechanism: 'folder',
			template: '{edge_id}',
			variadic: { delimiter: '.' },
		};
		const heading: HeadingLayoutEntry = {
			level: 'edge',
			mechanism: 'heading',
			template: '{title}',
			level_depth: 2,
		};
		const layout: LayoutEntry[] = [folder, heading];
		expect(layout.map((entry) => entry.mechanism)).toEqual(['folder', 'heading']);
	});

	it('represents metadata, source version, body, and deferred fields on the generated root', () => {
		const recipe: CrosswalkerImportRecipe = {
			recipe: 'generated-root-coverage',
			metadata: {
				based_on: {
					recipe: 'base',
					recipe_document_digest: `sha256-${'0'.repeat(64)}`,
				},
			},
			source: { ontology: 'test', version: '1', levels: ['leaf'] },
			target: {
				layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
				also_emit: { body: [{ template: '{text}' }] },
				graph_edges: [{ from: '{id}', via: 'related', to: '{parent}' }],
				linkStyle: 'shortest',
			},
		};
		expect(recipe.target.also_emit?.body?.[0].template).toBe('{text}');
	});
});
