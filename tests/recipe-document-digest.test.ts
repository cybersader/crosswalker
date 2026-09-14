import { createHash } from 'node:crypto';

import {
	canonicalStringify,
	computeRecipeDocumentDigest,
	computeRecipeHash,
} from '../src/generation/hash';
import {
	normalizeRecipe,
	serializeCanonicalRecipe,
} from '../src/import/recipe-document';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import {
	validateRecipe,
	validateTier1Frontmatter,
} from '../src/validation/validator';

const RECIPE_SPEC = 'https://crosswalker.dev/spec/recipe.schema.json' as const;
const TIER1_SPEC = 'https://crosswalker.dev/spec/tier1.schema.json' as const;
const VALID_DIGEST = `sha256-${'a'.repeat(64)}`;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedVectorRecipe(): CrosswalkerImportRecipe {
	return {
		recipe: 'digest-unicode-Δ',
		spec_version: RECIPE_SPEC,
		metadata: { title: 'Café ✓' },
		source: {
			ontology: 'synthetic-ontology',
			version: 'v1',
			levels: ['group', 'leaf'],
		},
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: 'Répertoire/{group}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: { aliases: ['{label}', '{id}'] },
			linkStyle: 'absolute',
		},
	};
}

function omittedDefaultsRecipe(): CrosswalkerImportRecipe {
	return {
		recipe: 'digest-defaults',
		source: { ontology: 'synthetic-defaults', levels: ['branch', 'leaf'] },
		target: {
			layout: [
				{
					level: 'branch',
					mechanism: 'folder',
					template: '{path}',
					variadic: { delimiter: '.' },
				},
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: {
				body: [
					{ template: '{summary}' },
					{ template: '{details}', position: 'section', heading: 'Details' },
				],
			},
		},
	} as CrosswalkerImportRecipe;
}

function explicitDefaultsRecipe(): CrosswalkerImportRecipe {
	const recipe = omittedDefaultsRecipe();
	recipe.spec_version = RECIPE_SPEC;
	recipe.target.linkStyle = 'absolute';
	const variadic = recipe.target.layout[0].variadic!;
	variadic.segment = 'prefix';
	variadic.drop_last = true;
	variadic.max_depth = 6;
	variadic.on_overflow = 'truncate';
	const [append, section] = recipe.target.also_emit!.body!;
	append.position = 'append';
	append.format = 'text';
	append.omit_if_empty = true;
	section.format = 'text';
	section.omit_if_empty = true;
	if (section.position === 'section') section.heading_depth = 2;
	return recipe;
}

function reverseObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseObjectKeys);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.reverse()
				.map(([key, child]) => [key, reverseObjectKeys(child)]),
		);
	}
	return value;
}

function recipeWithAncestryDigest(digest: unknown): unknown {
	const recipe = normalizedVectorRecipe() as unknown as Record<string, unknown>;
	recipe.metadata = {
		title: 'Café ✓',
		based_on: { recipe: 'digest-base', recipe_document_digest: digest },
	};
	return recipe;
}

function tier1WithRecipeDigest(digest: unknown, hash: unknown = undefined): unknown {
	return {
		curie: 'synthetic:item-1',
		_crosswalker: {
			spec_version: TIER1_SPEC,
			source_ref: { file: 'synthetic.csv' },
			produced_at: '2026-09-06T00:00:00Z',
			recipe: {
				id: 'digest-unicode-Δ',
				...(hash === undefined ? {} : { hash }),
				recipe_document_digest: digest,
			},
		},
	};
}

describe('computeRecipeDocumentDigest', () => {
	it('matches an independently constructed canonical JSON + Node SHA-256 Unicode vector', () => {
		const recipe = normalizedVectorRecipe();
		const independentCanonical = '{"metadata":{"title":"Café ✓"},"recipe":"digest-unicode-Δ","source":{"levels":["group","leaf"],"ontology":"synthetic-ontology","version":"v1"},"spec_version":"https://crosswalker.dev/spec/recipe.schema.json","target":{"also_emit":{"aliases":["{label}","{id}"]},"layout":[{"level":"group","mechanism":"folder","template":"Répertoire/{group}"},{"level":"leaf","mechanism":"file","template":"{id}.md"}],"linkStyle":"absolute"}}';
		const reference = `sha256-${createHash('sha256').update(independentCanonical, 'utf8').digest('hex')}`;

		expect(validateRecipe(recipe).valid).toBe(true);
		expect(canonicalStringify(recipe)).toBe(independentCanonical);
		expect(computeRecipeDocumentDigest(recipe)).toBe(reference);
		expect(reference).toMatch(/^sha256-[a-f0-9]{64}$/);
	});

	it('uses caller normalization: omitted and explicitly equivalent defaults digest identically', () => {
		const omitted = omittedDefaultsRecipe();
		const explicit = explicitDefaultsRecipe();
		const omittedBefore = clone(omitted);
		const normalized = normalizeRecipe(omitted);

		expect(validateRecipe(omitted).valid).toBe(true);
		expect(validateRecipe(explicit).valid).toBe(true);
		expect(validateRecipe(normalized).valid).toBe(true);
		expect(normalizeRecipe(normalized)).toEqual(normalized);
		expect(normalized).toEqual(normalizeRecipe(explicit));
		expect(computeRecipeDocumentDigest(normalized)).toBe(
			computeRecipeDocumentDigest(normalizeRecipe(explicit)),
		);
		expect(omitted).toEqual(omittedBefore);
	});

	it('does not mutate normalized input while hashing', () => {
		const recipe = normalizeRecipe(omittedDefaultsRecipe());
		const before = clone(recipe);
		computeRecipeDocumentDigest(recipe);
		expect(recipe).toEqual(before);
	});

	it('ignores object insertion order and JSON whitespace after parsing and normalization', () => {
		const recipe = normalizedVectorRecipe();
		const reorderedJson = JSON.stringify(reverseObjectKeys(recipe), null, 4);
		const reparsed = normalizeRecipe(JSON.parse(`\n${reorderedJson}\n`) as CrosswalkerImportRecipe);
		expect(computeRecipeDocumentDigest(reparsed)).toBe(computeRecipeDocumentDigest(recipe));
	});

	it('changes for a changed value and for reordered meaningful arrays', () => {
		const recipe = normalizedVectorRecipe();
		const changed = clone(recipe);
		changed.source.version = 'v2';
		const reordered = clone(recipe);
		reordered.target.also_emit!.aliases!.reverse();

		expect(computeRecipeDocumentDigest(changed)).not.toBe(computeRecipeDocumentDigest(recipe));
		expect(computeRecipeDocumentDigest(reordered)).not.toBe(computeRecipeDocumentDigest(recipe));
	});

	it('survives canonical pretty serialization and its trailing newline', () => {
		const recipe = normalizeRecipe(omittedDefaultsRecipe());
		const serialized = serializeCanonicalRecipe(recipe);
		const reparsed = normalizeRecipe(JSON.parse(serialized) as CrosswalkerImportRecipe);

		expect(serialized.endsWith('\n')).toBe(true);
		expect(computeRecipeDocumentDigest(reparsed)).toBe(computeRecipeDocumentDigest(recipe));
	});

	it('covers recipe id, source, target, metadata, ancestry, and opaque similarly named content', () => {
		const base = normalizedVectorRecipe();
		const baseDigest = computeRecipeDocumentDigest(base);
		const effectiveHash = computeRecipeHash(base.target, base.source);

		const changedId = clone(base);
		changedId.recipe = 'digest-unicode-renamed';
		const changedSource = clone(base);
		changedSource.source.version = 'v2';
		const changedTarget = clone(base);
		changedTarget.target.also_emit!.aliases = ['{id}'];
		const changedMetadata = clone(base);
		changedMetadata.metadata!.title = 'Changed title';
		const withAncestry = clone(base);
		withAncestry.metadata = {
			...withAncestry.metadata,
			based_on: {
				recipe: 'digest-base',
				recipe_document_digest: `sha256-${'0'.repeat(64)}`,
			},
		};
		const changedAncestry = clone(withAncestry);
		changedAncestry.metadata!.based_on!.recipe_document_digest = `sha256-${'1'.repeat(64)}`;
		const withOpaqueNamedField = clone(base) as CrosswalkerImportRecipe & Record<string, unknown>;
		withOpaqueNamedField.query = {
			shape: 'table',
			primitives: { from: 'synthetic-ontology', select: [{ field: 'concept.label' }] },
			recipe_document_digest: 'opaque-field-a',
		} as CrosswalkerImportRecipe['query'];
		const changedOpaqueNamedField = clone(withOpaqueNamedField);
		(changedOpaqueNamedField.query as Record<string, unknown>).recipe_document_digest = 'opaque-field-b';

		for (const candidate of [changedId, changedSource, changedTarget, changedMetadata, withAncestry]) {
			expect(validateRecipe(candidate).valid).toBe(true);
			expect(computeRecipeDocumentDigest(candidate)).not.toBe(baseDigest);
		}
		expect(computeRecipeDocumentDigest(changedAncestry)).not.toBe(
			computeRecipeDocumentDigest(withAncestry),
		);
		expect(validateRecipe(withOpaqueNamedField).valid).toBe(true);
		expect(validateRecipe(changedOpaqueNamedField).valid).toBe(true);
		expect(computeRecipeDocumentDigest(changedOpaqueNamedField)).not.toBe(
			computeRecipeDocumentDigest(withOpaqueNamedField),
		);
		expect(computeRecipeHash(changedId.target, changedId.source)).toBe(effectiveHash);
		expect(computeRecipeHash(withAncestry.target, withAncestry.source)).toBe(effectiveHash);
	});
});

describe('recipe_document_digest schema references', () => {
	it('accepts the optional digest in recipe ancestry and Tier 1 recipe provenance', () => {
		expect(validateRecipe(recipeWithAncestryDigest(VALID_DIGEST)).valid).toBe(true);
		expect(validateTier1Frontmatter(tier1WithRecipeDigest(VALID_DIGEST)).valid).toBe(true);
	});

	it.each([
		['colon syntax', `sha256:${'a'.repeat(64)}`],
		['uppercase hex', `sha256-${'A'.repeat(64)}`],
		['non-hex', `sha256-${'g'.repeat(64)}`],
		['short length', `sha256-${'a'.repeat(63)}`],
		['long length', `sha256-${'a'.repeat(65)}`],
		['non-string', 42],
	] as Array<[string, unknown]>)('rejects %s in both reference locations', (_label, digest) => {
		expect(validateRecipe(recipeWithAncestryDigest(digest)).valid).toBe(false);
		expect(validateTier1Frontmatter(tier1WithRecipeDigest(digest)).valid).toBe(false);
	});

	it('keeps legacy recipe/Tier 1 objects valid and leaves Tier 1 recipe.hash permissive', () => {
		const legacyRecipe = normalizedVectorRecipe();
		const legacyTier1 = tier1WithRecipeDigest(VALID_DIGEST, 'legacy-free-form-receipt') as Record<string, unknown>;
		delete ((legacyTier1._crosswalker as Record<string, unknown>).recipe as Record<string, unknown>)
			.recipe_document_digest;

		expect(validateRecipe(legacyRecipe).valid).toBe(true);
		expect(validateTier1Frontmatter(legacyTier1).valid).toBe(true);
	});

	it('rejects a misplaced own-digest property on recipe metadata', () => {
		const misplaced = normalizedVectorRecipe() as unknown as Record<string, unknown>;
		misplaced.metadata = {
			title: 'Café ✓',
			recipe_document_digest: VALID_DIGEST,
		};
		expect(validateRecipe(misplaced).valid).toBe(false);
	});
});
