/**
 * import-set-block.ts — the pure rules for one `_crosswalker.import_set` block.
 *
 * Split out of `import-set.ts` (slice 2 of the mapping table form, 2026-09-30)
 * because a mapping table's header carries the same block a note carries, and
 * the table codec must stay free of the host runtime. Failure mode prevented:
 * two readers of one fact drifting apart, so a block a note would be refused
 * for is accepted from a table header, or the other way round. Both readers
 * call `validateImportSetBlock`; neither restates a check.
 *
 * No `obsidian` import here, not even a type.
 */

export const IMPORT_SET_ID_PATTERN = /^iset-[a-z0-9]{6}$/;
export const IMPORT_SET_SCHEMES = ['endpoint-v1', 'set-qualified-v1'] as const;
export type ImportSetScheme = typeof IMPORT_SET_SCHEMES[number];

/** Mapping storage form is pinned per import set; legacy sets use notes. */
export const MAPPING_FORMS = ['notes', 'table'] as const;
export type MappingForm = typeof MAPPING_FORMS[number];

/** See `import-set.ts` (AM-27) for why derivation is pinned per set. */
export const IMPORT_SET_DERIVATIONS = ['filename-stem-v1', 'declared-facts-v1'] as const;
export type ImportSetDerivation = typeof IMPORT_SET_DERIVATIONS[number];

/**
 * The `_crosswalker` block as `buildProvenance` stamps it. Everything but the
 * ownership block is open: the stamp grows fields, and a reader that closed the
 * shape would drop what a newer writer recorded.
 */
export type CrosswalkerProvenance = Record<string, unknown> & {
	import_set?: Record<string, unknown>;
};

/** Stored import-set provenance is malformed or disagrees within one set. */
export class ImportSetProvenanceError extends Error {
	constructor(message: string, public readonly paths: string[]) {
		super(message);
		this.name = 'ImportSetProvenanceError';
	}
}

export function isImportSetScheme(value: unknown): value is ImportSetScheme {
	return typeof value === 'string' && (IMPORT_SET_SCHEMES as readonly string[]).includes(value);
}

export function isImportSetDerivation(value: unknown): value is ImportSetDerivation {
	return typeof value === 'string' && (IMPORT_SET_DERIVATIONS as readonly string[]).includes(value);
}

/** A trimmed non-empty string, or null. Blank stamps are no stamp. */
export function readProvenanceString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export interface ImportSetBlockFacts {
	id: string;
	scheme: string | null;
	derivation: string | null;
	mappingForm: MappingForm | null;
	destination: string | null;
	ontology: string | null;
	parentSet: string | null;
	nestIdentity: Record<string, 'global' | 'path'> | null;
}

export interface ValidateImportSetBlockOptions {
	/**
	 * Where `scheme` and `derivation` are checked. `'block'` (default) refuses an
	 * unknown or missing scheme and an unknown derivation right here. `'set'`
	 * leaves both to the caller's set-level agreement check, which can name every
	 * disagreeing note at once; note discovery uses it because one set spans many
	 * notes, while a table header is the whole set and has nothing to agree with.
	 */
	schemeAndDerivation?: 'block' | 'set';
}

/** Refuse a present but non-object block. Absence is the caller's decision. */
export function assertImportSetBlockObject(raw: unknown, where: string): asserts raw is Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ImportSetProvenanceError(`Invalid _crosswalker.import_set at ${where}: expected an object.`, [where]);
	}
}

/**
 * Validate one `import_set` block and return its facts. Throws
 * `ImportSetProvenanceError` naming `where`. Unlike a cache miss, a present but
 * malformed pin cannot safely default, so nothing here guesses.
 */
export function validateImportSetBlock(
	raw: unknown,
	where: string,
	options: ValidateImportSetBlockOptions = {},
): ImportSetBlockFacts {
	assertImportSetBlockObject(raw, where);
	const id = readProvenanceString(raw.id);
	if (!id || !IMPORT_SET_ID_PATTERN.test(id)) {
		throw new ImportSetProvenanceError(`Invalid import set id at ${where}: expected iset- followed by 6 lowercase letters or digits.`, [where]);
	}
	const scheme = readProvenanceString(raw.scheme);
	const derivation = readProvenanceString(raw.derivation);
	if ((options.schemeAndDerivation ?? 'block') === 'block') {
		if (!isImportSetScheme(scheme)) {
			throw new ImportSetProvenanceError(
				`Invalid import set scheme at ${where}: ${scheme ?? 'missing'}. Update Crosswalker or restore the import set provenance before refreshing.`,
				[where],
			);
		}
		if (derivation !== null && !isImportSetDerivation(derivation)) {
			throw new ImportSetProvenanceError(
				`Invalid identity derivation at ${where}: ${derivation}. Update Crosswalker or restore the import set provenance before refreshing.`,
				[where],
			);
		}
	}
	const rawForm = raw.mapping_form;
	if (rawForm !== undefined && !MAPPING_FORMS.includes(rawForm as MappingForm)) {
		throw new ImportSetProvenanceError(
			`Invalid mapping form at ${where}: ${String(rawForm)}. Update Crosswalker or restore the import set provenance before refreshing.`,
			[where],
		);
	}
	return {
		id,
		scheme,
		derivation,
		mappingForm: (rawForm as MappingForm | undefined) ?? null,
		destination: readProvenanceString(raw.destination),
		ontology: readProvenanceString(raw.ontology),
		parentSet: readProvenanceString(raw.parent_set),
		nestIdentity: readNestIdentity(raw.nest_identity, where),
	};
}

function readNestIdentity(value: unknown, path: string): Record<string, 'global' | 'path'> | null {
	if (value === undefined) return null;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ImportSetProvenanceError(
			`Invalid _crosswalker.import_set.nest_identity at ${path}: expected an object of level names to global or path.`,
			[path],
		);
	}
	const out: Record<string, 'global' | 'path'> = {};
	for (const [level, identity] of Object.entries(value as Record<string, unknown>)) {
		if (identity !== 'global' && identity !== 'path') {
			throw new ImportSetProvenanceError(
				`Invalid _crosswalker.import_set.nest_identity at ${path}: level ${level} must be global or path.`,
				[path],
			);
		}
		out[level] = identity;
	}
	return out;
}
