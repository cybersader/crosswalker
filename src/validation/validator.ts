/**
 * Crosswalker validator
 *
 * Wraps AJV to validate two artifact types against the canonical spec:
 *   - Tier 1 frontmatter (concept notes, junction notes, crosswalk edges)
 *     against spec/tier1.schema.json
 *   - Import recipes against spec/recipe.schema.json
 *
 * Both schemas are loaded at module init. Schema-file malformation throws
 * (caught at AJV compile time); call-site usage failures surface as
 * `ValidationResult` with structured errors.
 *
 * Per the v0.1 architectural commitment "runtime-agnostic recipe schema"
 * (Ch 23 §4): the recipe schema is the contract; engine implementations
 * are swappable; AJV + JSONata is the v0.1 validation/expression layer.
 *
 * Loaded JSON schemas come from spec/. esbuild bundles them at build time
 * via the JSON loader; tsconfig has `resolveJsonModule: true` so the
 * imports type-check cleanly.
 */

import Ajv2020 from 'ajv/dist/2020';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import tier1Schema from '../../spec/tier1.schema.json';
import recipeSchema from '../../spec/recipe.schema.json';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { validateTemplateSyntax } from '../render/template';

const tier1CuriePattern = (tier1Schema as { $defs?: { curie?: { pattern?: unknown } } }).$defs?.curie?.pattern;
if (typeof tier1CuriePattern !== 'string' || tier1CuriePattern.length === 0) {
	throw new Error('spec/tier1.schema.json is malformed: $defs.curie.pattern must be a non-empty string');
}
const TIER1_CURIE_RE = new RegExp(tier1CuriePattern);
const TIER1_CURIE_PREFIX_RE = /^[a-z][a-z0-9_-]*$/;

export function extractTier1Curie(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return TIER1_CURIE_RE.test(trimmed) ? trimmed : null;
}

export function isTier1Curie(value: unknown): value is string {
	return extractTier1Curie(value) !== null;
}

export function isTier1CuriePrefix(value: unknown): value is string {
	return typeof value === 'string' && TIER1_CURIE_PREFIX_RE.test(value);
}

/** Validation result returned to call sites. */
export interface ValidationResult {
	valid: boolean;
	/** Human-readable error strings; empty when `valid` is true. */
	errors: string[];
	/** Raw AJV error objects for programmatic inspection / Notice formatting. */
	rawErrors?: ErrorObject[];
}

/** Recipe schema discriminator style (per Ch 31). No longer settings-exposed — the `recipeSchemaStyle` setting was removed (settings-redesign report, 2026-07-11) since both styles validate identically; callers pass 'A'. */
export type RecipeSchemaStyle = 'A' | 'B';

let ajv: Ajv2020 | null = null;
let validateTier1Inner: ValidateFunction | null = null;
let validateRecipeStyleA: ValidateFunction<CrosswalkerImportRecipe> | null = null;
let validateRecipeStyleB: ValidateFunction<CrosswalkerImportRecipe> | null = null;

/**
 * Build a style-B variant of the recipe schema by patching the in-memory
 * schema object before AJV compilation. Style B uses if/then/else dispatch
 * (ShapeDispatchB) instead of style A's oneOf+const (ShapeDispatchA). Both
 * are defined in spec/recipe.schema.json `$defs`; this swaps which one
 * `query_block.allOf[0]` references. Per Ch 31 deliverables A + B —
 * semantically equivalent; differ in error-message focus + IDE autocomplete.
 *
 * Strips the `$id` from the cloned schema so AJV treats it as anonymous
 * (otherwise both compiles would conflict on the same canonical URI).
 * Internal `#/$defs/...` $refs resolve correctly without `$id`.
 */
function buildStyleBSchema(base: unknown): AnySchema {
	// Deep clone so we don't mutate the imported JSON.
	const cloned = JSON.parse(JSON.stringify(base));
	if (cloned?.$defs?.query_block?.allOf?.[0]) {
		cloned.$defs.query_block.allOf[0] = { $ref: '#/$defs/ShapeDispatchB' };
	}
	// Strip $id so AJV can compile this as an anonymous variant.
	delete cloned.$id;
	return cloned as AnySchema;
}

/**
 * Initialize AJV + compile the spec schemas. Throws if a spec file is
 * malformed (which means the project itself is broken — fail-fast at startup).
 *
 * Recipe schema compiled in BOTH style A (oneOf+const, default) and style B
 * (if/then/else, advanced) per Ch 31 v0.1.6 commitment. Settings select which
 * validator to use at call time via `validateRecipe(recipe, style)`.
 *
 * Idempotent: safe to call multiple times.
 */
export function initValidator(): void {
	if (ajv) return;

	// Use the 2020-12 draft-aware AJV class because our spec/*.schema.json files
	// declare `$schema: "https://json-schema.org/draft/2020-12/schema"`. The default
	// `Ajv` constructor targets Draft-07 and would reject the 2020-12 metaschema.
	ajv = new Ajv2020({
		allErrors: true,
		strict: false,
		// Tier 1 is intentionally open (`additionalProperties: true`) so domain-specific
		// frontmatter beyond the canonical fields validates cleanly.
		useDefaults: false,
	});
	addFormats(ajv);

	try {
		validateTier1Inner = ajv.compile(tier1Schema);
	} catch (err) {
		throw new Error(`spec/tier1.schema.json is malformed: ${(err as Error).message}`);
	}

	// Compile style A: schema as-shipped (default discriminator).
	try {
		validateRecipeStyleA = ajv.compile<CrosswalkerImportRecipe>(recipeSchema);
	} catch (err) {
		throw new Error(`spec/recipe.schema.json (style A) is malformed: ${(err as Error).message}`);
	}

	// Compile style B: same schema, ShapeDispatchA → ShapeDispatchB swap.
	try {
		validateRecipeStyleB = ajv.compile<CrosswalkerImportRecipe>(buildStyleBSchema(recipeSchema));
	} catch (err) {
		throw new Error(`spec/recipe.schema.json (style B variant) is malformed: ${(err as Error).message}`);
	}
}

/**
 * Validate a Tier 1 frontmatter object (concept-note, junction-note, or
 * crosswalk-edge shape — discriminated by the schema's `oneOf`).
 *
 * Used pre-write in the generation engine to abort on invalid output
 * rather than corrupt the vault.
 */
export function validateTier1Frontmatter(fm: unknown): ValidationResult {
	if (!validateTier1Inner) initValidator();
	const valid = !!validateTier1Inner!(fm);
	return formatResult(valid, validateTier1Inner!.errors);
}

/**
 * Validate an import recipe.
 *
 * Used at recipe-load time (import wizard save, recipe browser open) to
 * reject malformed recipes early with line/column-level errors users can
 * act on.
 *
 * @param recipe - The recipe object to validate.
 * @param style  - Discriminator style for the optional `query:` block (per Ch 31).
 *                 'A' (default; oneOf+const) or 'B' (if/then/else). Both styles
 *                 produce identical validity verdicts; differ in error-message
 *                 focus + IDE autocomplete behavior. No longer settings-exposed;
 *                 all call sites pass 'A' (settings-redesign report, 2026-07-11).
 */
export function validateRecipe(recipe: unknown, style: RecipeSchemaStyle = 'A'): ValidationResult {
	const validator = getRecipeValidator(style);
	const valid = !!validator(recipe);
	const result = formatResult(valid, validator.errors);
	const layout = (recipe as { target?: { layout?: unknown } } | null)?.target?.layout;
	if (!Array.isArray(layout)) return result;
	for (let i = 0; i < layout.length; i++) {
		const entry = layout[i];
		if (!entry || typeof entry !== 'object' || !('implied_concept' in entry)) continue;
		const item = entry as Record<string, unknown>;
		const path = `target.layout.${i}.implied_concept`;
		if (i === layout.length - 1) result.errors.push(`${path}: the leaf level produces rows; an implied concept level must be above it`);
		if (item.mechanism !== 'folder') result.errors.push(`${path}: only a folder level can carry implied concepts`);
		if ('variadic' in item) result.errors.push(`${path}: implied concepts and variadic expansion cannot be combined in this version`);
		const option = item.implied_concept;
		if (option && typeof option === 'object' && 'identity' in option && typeof (option as { identity?: unknown }).identity === 'string') {
			try { validateTemplateSyntax((option as { identity: string }).identity); }
			catch (error) {
				result.errors.push(`${path}.identity: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	result.valid = result.errors.length === 0;
	return result;
}

/**
 * AJV-backed type guard for JSON load/save boundaries. A true result narrows
 * unknown input to the schema-generated root recipe type.
 */
export function isValidRecipe(
	recipe: unknown,
	style: RecipeSchemaStyle = 'A',
): recipe is CrosswalkerImportRecipe {
	return validateRecipe(recipe, style).valid;
}

function getRecipeValidator(style: RecipeSchemaStyle): ValidateFunction<CrosswalkerImportRecipe> {
	if (!validateRecipeStyleA || !validateRecipeStyleB) initValidator();
	return style === 'B' ? validateRecipeStyleB! : validateRecipeStyleA!;
}

function formatResult(valid: boolean, rawErrors: ErrorObject[] | null | undefined): ValidationResult {
	if (valid) return { valid: true, errors: [] };
	const errors = (rawErrors ?? []).map(formatError);
	return { valid: false, errors, rawErrors: rawErrors ?? undefined };
}

function formatError(err: ErrorObject): string {
	const path = err.instancePath || '(root)';
	const msg = err.message ?? 'unknown error';
	const allowed = err.params && 'allowedValues' in err.params
		? ` (allowed: ${JSON.stringify((err.params as { allowedValues: unknown[] }).allowedValues)})`
		: '';
	return `${path}: ${msg}${allowed}`;
}
