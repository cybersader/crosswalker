/**
 * validation.test.ts — Jest unit tests for the AJV validator
 *
 * Covers v0.1.1 milestone success criteria:
 *   - Valid Tier 1 frontmatter passes
 *   - Required fields missing → fails with clear error
 *   - Bad CURIE format → fails
 *   - Valid recipe (one of the 3 worked NIST examples) passes
 *   - Recipe with bad mechanism enum value → fails
 *   - Heading mechanism missing level_depth → fails (allOf if/then constraint)
 */

import {
	initValidator,
	isValidRecipe,
	validateRecipe,
	validateTier1Frontmatter,
} from '../src/validation/validator';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import richPortableRecipe from './fixtures/portable-import-recipe-rich.json';

beforeAll(() => {
	initValidator();
});

describe('validateTier1Frontmatter', () => {
	it('accepts valid concept-note frontmatter', () => {
		const result = validateTier1Frontmatter({
			curie: 'nist:AC-2',
			title: 'Account Management',
			tags: ['framework/nist-800-53-r5/ac/ac-2'],
			control_id: 'AC-2',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'NIST_800-53.csv' },
				produced_at: '2026-05-04T18:42:00Z',
			},
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('accepts valid junction-note frontmatter', () => {
		const result = validateTier1Frontmatter({
			curie: 'cwk:jn-bdfd9a',
			kind: 'junction-note',
			subject: 'Frameworks/NIST 800-53 r5/AC/AC-2',
			predicate: 'covers',
			object: 'Evidence/MFA-Policy',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'manual-mapping.csv' },
				produced_at: '2026-05-04T18:42:00Z',
			},
		});

		expect(result.valid).toBe(true);
	});

	it('accepts valid crosswalk-edge frontmatter', () => {
		const result = validateTier1Frontmatter({
			curie: 'cwk:cw-7e8b9d',
			kind: 'crosswalk-edge',
			subject_id: 'nist:AC-2',
			predicate_id: 'is_equivalent_to',
			object_id: 'iso27001:A.9.2.1',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { url: 'https://csrc.nist.gov/projects/olir/...' },
				produced_at: '2026-05-04T19:00:00Z',
			},
		});

		expect(result.valid).toBe(true);
	});

	it.each(['endpoint-v1', 'set-qualified-v1'] as const)(
		'accepts the additive import-set scheme %s',
		(scheme) => {
			const result = validateTier1Frontmatter({
				curie: scheme === 'endpoint-v1'
					? 'sssom:cw-nist-AC-2-iso-A-9'
					: 'sssom:cwset-iset-abc123-nist-AC-2-iso-A-9',
				kind: 'crosswalk-edge',
				subject_id: 'nist:AC-2',
				predicate_id: 'is_equivalent_to',
				object_id: 'iso27001:A.9',
				_crosswalker: {
					spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
					source_ref: { file: 'mapping.tsv' },
					produced_at: '2026-08-21T00:00:00Z',
					import_set: { id: 'iset-abc123', scheme },
				},
			});

			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		},
	);


	it('accepts parent_set on an edge set but rejects unknown import-set keys', () => {
		const edge = {
			curie: 'sssom:cwset-iset-abc123-nist-AC-2-iso-A-9',
			kind: 'crosswalk-edge',
			subject_id: 'nist:AC-2', predicate_id: 'is_equivalent_to', object_id: 'iso27001:A.9',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'synthetic.tsv' }, produced_at: '2026-09-24T00:00:00Z',
				import_set: { id: 'iset-abc123', scheme: 'set-qualified-v1', parent_set: 'iset-fedcba' },
			},
		};
		expect(validateTier1Frontmatter(edge).valid).toBe(true);
		expect(validateTier1Frontmatter({ ...edge, _crosswalker: { ...edge._crosswalker,
			import_set: { ...edge._crosswalker.import_set, parent_set: 'invalid' },
		} }).valid).toBe(false);
		expect(validateTier1Frontmatter({ ...edge, _crosswalker: { ...edge._crosswalker,
			import_set: { ...edge._crosswalker.import_set, unexpected: true },
		} }).valid).toBe(false);
	});

	it('rejects frontmatter missing the required curie field', () => {
		const result = validateTier1Frontmatter({
			title: 'Account Management',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'test.csv' },
				produced_at: '2026-05-04T18:42:00Z',
			},
		});

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		// Should reference the missing required field somewhere in errors
		const combined = result.errors.join(' ');
		expect(combined).toMatch(/required|curie/i);
	});

	it('rejects frontmatter missing the required _crosswalker provenance block', () => {
		const result = validateTier1Frontmatter({
			curie: 'nist:AC-2',
			title: 'Account Management',
		});

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('rejects malformed CURIE format', () => {
		const result = validateTier1Frontmatter({
			curie: 'NotACurie!!!', // no `prefix:local` shape
			title: 'X',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'test.csv' },
				produced_at: '2026-05-04T18:42:00Z',
			},
		});

		expect(result.valid).toBe(false);
		const combined = result.errors.join(' ');
		expect(combined.toLowerCase()).toContain('pattern');
	});

	it('rejects bad STRM predicate_id on a crosswalk edge', () => {
		const result = validateTier1Frontmatter({
			curie: 'cwk:cw-bad',
			kind: 'crosswalk-edge',
			subject_id: 'nist:AC-2',
			predicate_id: 'invalid_predicate_lol',
			object_id: 'iso27001:A.9.2.1',
			_crosswalker: {
				spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
				source_ref: { file: 'test.csv' },
				produced_at: '2026-05-04T19:00:00Z',
			},
		});

		expect(result.valid).toBe(false);
		const combined = result.errors.join(' ');
		expect(combined.toLowerCase()).toMatch(/enum|allowed/);
	});
});

describe('validateRecipe', () => {
	const validNistAllFolders = {
		recipe: 'nist-80053r5-allfolders',
		source: {
			ontology: 'nist-800-53-r5',
			levels: ['catalog', 'family', 'control', 'enhancement'],
		},
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
				{ level: 'family', mechanism: 'folder', template: '{family.id}' },
				{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
				{ level: 'enhancement', mechanism: 'file', template: '{enhancement.id}.md' },
			],
			also_emit: {
				tags: ['framework/nist-800-53-r5/{family.id|lower}/{control.id|tagsafe}'],
				aliases: ['{control.id}', '{control.title}'],
			},
		},
	};

	it('accepts the all-folders worked NIST example', () => {
		const result = validateRecipe(validNistAllFolders);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('accepts the mostly-headings worked NIST example with level_depth', () => {
		const result = validateRecipe({
			recipe: 'nist-80053r5-mostly-headings',
			source: {
				ontology: 'nist-800-53-r5',
				levels: ['catalog', 'family', 'control'],
			},
			target: {
				layout: [
					{ level: 'catalog', mechanism: 'file', template: 'Frameworks/{catalog.name}.md' },
					{
						level: 'family',
						mechanism: 'heading',
						level_depth: 2,
						template: '{family.id} — {family.title}',
					},
					{
						level: 'control',
						mechanism: 'heading',
						level_depth: 3,
						template: '{control.id} {control.title}',
					},
				],
			},
		});
		expect(result.valid).toBe(true);
	});

	it('rejects an unknown mechanism enum value', () => {
		const bad = JSON.parse(JSON.stringify(validNistAllFolders));
		bad.target.layout[0].mechanism = 'banana';
		const result = validateRecipe(bad);
		expect(result.valid).toBe(false);
		const combined = result.errors.join(' ');
		expect(combined.toLowerCase()).toMatch(/enum|allowed/);
	});

	it('rejects a heading mechanism missing the required level_depth', () => {
		const bad = JSON.parse(JSON.stringify(validNistAllFolders));
		bad.target.layout[0] = {
			level: 'catalog',
			mechanism: 'heading',
			template: '{catalog.name}',
			// level_depth missing!
		};
		const result = validateRecipe(bad);
		expect(result.valid).toBe(false);
		const combined = result.errors.join(' ');
		expect(combined.toLowerCase()).toMatch(/required|level_depth/);
	});

	it('rejects a recipe missing the required `recipe` identifier', () => {
		const bad = JSON.parse(JSON.stringify(validNistAllFolders));
		delete bad.recipe;
		const result = validateRecipe(bad);
		expect(result.valid).toBe(false);
	});

	it('rejects a recipe missing the required `source` block', () => {
		const bad = JSON.parse(JSON.stringify(validNistAllFolders));
		delete bad.source;
		const result = validateRecipe(bad);
		expect(result.valid).toBe(false);
	});

	it('accepts a variadic folder layout entry', () => {
		const result = validateRecipe({
			recipe: 'attack-variadic',
			source: { ontology: 'mitre-attack', levels: ['technique'] },
			target: {
				layout: [
					{ level: 'root', mechanism: 'folder', template: 'Techniques' },
					{
						level: 'technique',
						mechanism: 'folder',
						template: '{external_id}',
						variadic: {
							delimiter: '.',
							segment: 'prefix',
							drop_last: true,
							max_depth: 6,
							on_overflow: 'truncate',
						},
					},
					{ level: 'technique', mechanism: 'file', template: '{external_id}.md' },
				],
			},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('accepts a minimal variadic block (only the required delimiter)', () => {
		const result = validateRecipe({
			recipe: 'attack-variadic-minimal',
			source: { ontology: 'mitre-attack', levels: ['technique'] },
			target: {
				layout: [
					{ level: 'technique', mechanism: 'folder', template: '{external_id}', variadic: { delimiter: '.' } },
					{ level: 'technique', mechanism: 'file', template: '{external_id}.md' },
				],
			},
		});
		expect(result.valid).toBe(true);
	});

	it('rejects variadic on a non-folder (file) mechanism', () => {
		const result = validateRecipe({
			recipe: 'variadic-on-file',
			source: { ontology: 'mitre-attack', levels: ['technique'] },
			target: {
				layout: [
					{ level: 'technique', mechanism: 'file', template: '{external_id}.md', variadic: { delimiter: '.' } },
				],
			},
		});
		expect(result.valid).toBe(false);
	});

	it('rejects a variadic block missing the required delimiter', () => {
		const result = validateRecipe({
			recipe: 'variadic-no-delimiter',
			source: { ontology: 'mitre-attack', levels: ['technique'] },
			target: {
				layout: [
					{ level: 'technique', mechanism: 'folder', template: '{external_id}', variadic: { segment: 'prefix' } },
					{ level: 'technique', mechanism: 'file', template: '{external_id}.md' },
				],
			},
		});
		expect(result.valid).toBe(false);
	});

	it('accepts the rich portable contract fixture and narrows it to the generated root type', () => {
		const input: unknown = richPortableRecipe;
		expect(isValidRecipe(input)).toBe(true);
		if (!isValidRecipe(input)) throw new Error('Fixture unexpectedly failed validation');
		const narrowed: CrosswalkerImportRecipe = input;
		expect(narrowed.metadata?.based_on?.recipe).toBe('portable-contract-base');
		expect(narrowed.source.version).toBe('2026.1');
		expect(narrowed.target.also_emit?.body).toHaveLength(4);
	});

	it.each([
		['table-row position', { template: '{text}', position: 'table-row' }],
		['legacy transform', { template: '{text}', transform: [{ type: 'trim' }] }],
		['heading on append', { template: '{text}', position: 'append', heading: 'Invalid' }],
		['section without heading', { template: '{text}', position: 'section' }],
	])('rejects non-portable body state: %s', (_label, bodyEntry) => {
		const recipe = JSON.parse(JSON.stringify(validNistAllFolders));
		recipe.target.also_emit.body = [bodyEntry];
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('requires based_on.recipe when ancestry is present', () => {
		const recipe = JSON.parse(JSON.stringify(validNistAllFolders));
		recipe.metadata = { based_on: { hash: `sha256-${'0'.repeat(64)}` } };
		expect(validateRecipe(recipe).valid).toBe(false);
	});
});
