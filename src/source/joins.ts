/**
 * joins.ts — `source.joins`, keyed lookup enrichment.
 *
 * Ch 46 source contract §4. NOT relational algebra: one primary stream plus N
 * independent, bounded lookup indexes. The primary collection is still consumed
 * row by row; only the SECONDARY collection is materialized, and that cost is
 * the accepted one (largest measured secondary is ATT&CK `relationships` at
 * 18,570 rows).
 *
 * Three properties are load-bearing and each is enforced here rather than
 * assumed:
 *
 *   1. FIXED DEPTH. `from` admits no nested `joins`, so a join can never
 *      compose with another join. Two-hop enrichment is producer work, ruled
 *      out of scope permanently (contract §4.6).
 *   2. NO NAMESPACE MERGE. A joined row gains exactly ONE key: the alias. Its
 *      value is the match. Nothing is ever merged into the primary row's own
 *      namespace, so a joined field can never shadow a source column, and the
 *      template grammar needs no change: the alias is an ordinary nested object
 *      reached by traversal that already exists (contract §4.4).
 *   3. LOUD ON A MISSING KEY, SILENT ON A MISSING RELATION. A key expression
 *      that yields nothing is a DEFECT and aborts the run. A key that finds no
 *      match is DATA: the alias is simply absent from that row (verdict rule 5).
 */

import { iterateJsonPath, toSourceRows } from '../import/parsers/json-source-core';
import type { SourceContainer } from '../types/config';
import { SourceStageError, formatAvailableNames } from './errors';
import {
	assertReferencesExist,
	compileSourceExpression,
	SourceStageBudget,
	type CompiledSourceExpression,
} from './expression';
import { assertAdmittedSomething, evaluateWherePredicate, type WhereTally } from './where';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Declaration shape (mirrors spec/recipe.schema.json $defs/source_join)
// ---------------------------------------------------------------------------

export interface JoinFromDeclaration {
	/** Another sheet of the same workbook. XOR with `iterator`. */
	sheet?: string;
	/** 0-based banner depth for `sheet`. Sheets in one workbook differ. */
	header_row?: number;
	/** A sibling array of the same JSON document. XOR with `sheet`. */
	iterator?: string;
	/** Optional predicate over the SECONDARY rows, with the §3 `where` contract exactly. */
	where?: string;
}

export interface JoinOnDeclaration {
	/** Key expression over the primary row, evaluated at lookup time. */
	primary: string;
	/** Key expression over a secondary row, evaluated at index-build time. */
	secondary: string;
}

export interface JoinDeclaration {
	from: JoinFromDeclaration;
	on: JoinOnDeclaration;
	/** Required, no default. `"first"` does not exist (contract §5). */
	cardinality: 'one' | 'many';
	/** Optional for `one` (field subset); REQUIRED and exactly one field for `many`. */
	select?: string[];
}

/** Keyed by alias. Alias must match ALIAS_PATTERN. */
export type JoinsDeclaration = Record<string, JoinDeclaration>;

/**
 * Aliases must be addressable as a BARE template segment with no quoting, which
 * is what keeps `source.joins` free of any template-grammar change.
 */
export const ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Names the render scope already owns. An alias taking one of these would
 * shadow provenance or identity rather than a mere data column.
 * `_crosswalker_curie_local_part` is injected into the render scope at
 * generation-engine.ts; `_crosswalker` is the Tier 1 provenance block.
 */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set([
	'_cw',
	'_crosswalker',
	'_crosswalker_curie_local_part',
	'curie',
]);

/** Refuse a source column that would collide with nested-record lineage. */
export function assertNoReservedSourceColumn(columns: string[]): void {
	if (columns.includes('_cw')) {
		throw new Error('Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.');
	}
}

// ---------------------------------------------------------------------------
// Prepared join
// ---------------------------------------------------------------------------

export interface PreparedJoin {
	readonly alias: string;
	/** Declaration path root, e.g. `source.joins.mitigations`. */
	readonly declaration: string;
	readonly cardinality: 'one' | 'many';
	readonly select?: readonly string[];
	readonly primaryKey: CompiledSourceExpression;
	/** key -> matching secondary rows, in secondary-collection order. */
	readonly index: ReadonlyMap<string, Row[]>;
	/** Secondary rows retained in the index. The whole memory cost of this join. */
	readonly indexedRowCount: number;
	/** Distinct keys in the index. */
	readonly distinctKeyCount: number;
}

export interface PrepareJoinsContext {
	/** The primary collection's key universe, for G2 and for alias-collision. */
	primaryKeyUniverse: ReadonlySet<string>;
	/** Same universe as an ordered name list, for error details. */
	primaryKeyNames: readonly string[];
	/** Where secondary collections live. Absent means none can be located. */
	container?: SourceContainer;
	/** Shared whole-stage evaluation budget. */
	budget: SourceStageBudget;
}

/**
 * Build every declared lookup index. ALL of it is preflight: it runs before a
 * single primary row is handed downstream, so a bad declaration produces zero
 * writes and one clear error.
 *
 * Aliases are prepared in declaration order, so the first bad one is the one
 * reported.
 */
export async function prepareJoins(
	joins: JoinsDeclaration,
	ctx: PrepareJoinsContext,
): Promise<PreparedJoin[]> {
	const prepared: PreparedJoin[] = [];
	const claimedAliases = new Set<string>();

	for (const [alias, declaration] of Object.entries(joins)) {
		assertAliasIsAvailable(alias, claimedAliases, ctx);
		claimedAliases.add(alias);
		prepared.push(await prepareOneJoin(alias, declaration, ctx));
	}
	return prepared;
}

/**
 * Collision policy (contract §4.4), enforced as three separate refusals.
 * NEVER shadow, NEVER merge, NEVER auto-rename: the row is the user's data and
 * an alias quietly taking a column's name is exactly the silent, shape-dependent
 * degradation this whole stage exists to prevent.
 */
function assertAliasIsAvailable(
	alias: string,
	claimed: ReadonlySet<string>,
	ctx: PrepareJoinsContext,
): void {
	const declaration = `source.joins.${alias}`;
	if (!ALIAS_PATTERN.test(alias)) {
		throw new SourceStageError(`join alias "${alias}" is not a legal name`, {
			declaration,
			detail: 'An alias must match ^[a-z][a-z0-9_]*$ so it is addressable as a bare template segment '
				+ 'with no quoting. Lowercase letters, digits and underscores, starting with a letter.',
		});
	}
	if (RESERVED_ALIASES.has(alias)) {
		throw new SourceStageError(`join alias "${alias}" is reserved`, {
			declaration,
			detail: `Reserved names: ${[...RESERVED_ALIASES].join(', ')}. These already exist in the render scope.`,
		});
	}
	if (claimed.has(alias)) {
		// Unreachable through JSON (object keys are unique) but reachable through
		// a hand-built declaration, and cheap to refuse.
		throw new SourceStageError(`join alias "${alias}" is declared twice`, { declaration });
	}
	if (ctx.primaryKeyUniverse.has(alias)) {
		throw new SourceStageError(
			`join alias "${alias}" collides with a column of the same name in the source`,
			{
				declaration,
				detail: 'A join never merges into the row namespace and never shadows a column. '
					+ `Rename the alias. ${formatAvailableNames(ctx.primaryKeyNames)}`,
			},
		);
	}
}

async function prepareOneJoin(
	alias: string,
	declaration: JoinDeclaration,
	ctx: PrepareJoinsContext,
): Promise<PreparedJoin> {
	const root = `source.joins.${alias}`;
	const cardinality = declaration?.cardinality;
	if (cardinality !== 'one' && cardinality !== 'many') {
		throw new SourceStageError('cardinality is required and must be "one" or "many"', {
			declaration: root,
			detail: 'There is no default. Cardinality is an assertion about the data, not a preference, '
				+ 'and a default would make a wrong assumption invisible. "first" does not exist: silently '
				+ 'picking one of several matches is the banned behaviour.',
		});
	}
	const select = declaration.select;
	if (cardinality === 'many') {
		if (!Array.isArray(select) || select.length !== 1) {
			throw new SourceStageError(
				'cardinality "many" requires select to name exactly one field',
				{
					declaration: root,
					detail: 'A "many" join binds a LIST OF SCALARS, which is what the shipped list algebra '
						+ 'consumes (managed frontmatter arrays, managed_links, body format "list"). A list of '
						+ 'objects would require template traversal to lift over arrays, which the frozen '
						+ 'grammar does not do.',
				},
			);
		}
	} else if (select !== undefined && (!Array.isArray(select) || select.length === 0)) {
		throw new SourceStageError('select must be a non-empty array of field names when present', {
			declaration: root,
		});
	}

	// --- locate and materialize the secondary collection -------------------
	const rawSecondary = await resolveSecondaryRows(alias, declaration.from, ctx.container);
	if (rawSecondary.length === 0) {
		throw new SourceStageError('the secondary collection is empty, so this join can never match', {
			declaration: `${root}.from`,
			detail: 'An index that cannot match any row is a defect, not an empty result. '
				+ 'Check the sheet name or iterator path.',
		});
	}
	const secondaryNames = unionKeys(rawSecondary);
	const secondaryUniverse = new Set(secondaryNames);

	// --- from.where: the secondary-side predicate --------------------------
	// Same subset, same guards, same errors as source.where. Fixed depth 1:
	// there is no `from.joins`, so this can never recurse.
	let secondary = rawSecondary;
	const fromWhereText = declaration.from?.where;
	if (fromWhereText !== undefined && fromWhereText !== null) {
		const compiled = compileSourceExpression(fromWhereText, {
			declaration: `${root}.from.where`,
			budget: ctx.budget,
		});
		assertReferencesExist(compiled, secondaryUniverse, secondaryNames);
		const tally: WhereTally = { examined: 0, admitted: 0, excluded: 0 };
		const kept: Row[] = [];
		for (let i = 0; i < rawSecondary.length; i++) {
			tally.examined += 1;
			if (await evaluateWherePredicate(compiled, rawSecondary[i], i + 1)) {
				tally.admitted += 1;
				kept.push(rawSecondary[i]);
			} else {
				tally.excluded += 1;
			}
		}
		assertAdmittedSomething(compiled, tally);
		secondary = kept;
	}

	// --- select field existence -------------------------------------------
	// Not named by the contract; added on the contract's own stated rule.
	// Selecting a field that appears on NO secondary row yields nothing for
	// every match, i.e. the silent-empty failure the reference preflight exists
	// to catch, one level down. Absence on a row is data; absence from the
	// collection is a defect.
	if (select) {
		for (const field of select) {
			if (!secondaryUniverse.has(field)) {
				throw new SourceStageError(`select names "${field}", which the secondary collection has no such field`, {
					declaration: `${root}.select`,
					detail: formatAvailableNames(secondaryNames),
				});
			}
		}
	}

	// --- key expressions ---------------------------------------------------
	const secondaryKey = compileSourceExpression(declaration.on?.secondary, {
		declaration: `${root}.on.secondary`,
		budget: ctx.budget,
	});
	assertReferencesExist(secondaryKey, secondaryUniverse, secondaryNames);

	const primaryKey = compileSourceExpression(declaration.on?.primary, {
		declaration: `${root}.on.primary`,
		budget: ctx.budget,
	});
	assertReferencesExist(primaryKey, ctx.primaryKeyUniverse, ctx.primaryKeyNames);

	// --- build the index ---------------------------------------------------
	// Insertion order IS secondary-collection order, and Map preserves it, so a
	// "many" list is deterministic across runs without any sort. Determinism is
	// a Tier 1 commitment and re-import stability depends on it.
	const index = new Map<string, Row[]>();
	for (let i = 0; i < secondary.length; i++) {
		const raw = await secondaryKey.evaluate(secondary[i], i + 1);
		const key = normalizeKey(raw, {
			declaration: `${root}.on.secondary`,
			expression: secondaryKey.text,
			row: i + 1,
			side: 'secondary',
		});
		const bucket = index.get(key);
		if (bucket) bucket.push(secondary[i]);
		else index.set(key, [secondary[i]]);
	}

	return {
		alias,
		declaration: root,
		cardinality,
		select,
		primaryKey,
		index,
		indexedRowCount: secondary.length,
		distinctKeyCount: index.size,
	};
}

// ---------------------------------------------------------------------------
// Locating a secondary collection (contract §4.2)
// ---------------------------------------------------------------------------

async function resolveSecondaryRows(
	alias: string,
	from: JoinFromDeclaration | undefined,
	container: SourceContainer | undefined,
): Promise<Row[]> {
	const declaration = `source.joins.${alias}.from`;
	const hasSheet = typeof from?.sheet === 'string' && from.sheet.length > 0;
	const hasIterator = typeof from?.iterator === 'string' && from.iterator.length > 0;

	if (hasSheet === hasIterator) {
		throw new SourceStageError(
			hasSheet
				? 'names both a sheet and an iterator; a secondary collection is one or the other'
				: 'names neither a sheet nor an iterator',
			{
				declaration,
				detail: 'Use { "sheet": "<name>" } for another sheet of the same workbook, or '
					+ '{ "iterator": "$.a.b[*]" } for a sibling array of the same JSON document.',
			},
		);
	}

	if (!container) {
		throw new SourceStageError('the source did not record which container it was read from', {
			declaration,
			detail: 'A join locates its secondary collection inside the SAME source bytes, so the parser '
				+ 'must hand the engine a container handle. This source provided none.',
		});
	}
	if (container.kind === 'flat') {
		// Acceptance case C10. Not a gap: a CSV file IS one collection.
		throw new SourceStageError('joins are not available for a single-collection source such as CSV', {
			declaration,
			detail: 'A CSV file is one collection, so there is no second collection to name. Joins require a '
				+ 'container format: a workbook with more than one sheet, or a JSON document with sibling arrays. '
				+ 'Denormalize into one file, or emit Tier 1 directly.',
		});
	}

	if (hasSheet) {
		if (container.kind !== 'workbook') {
			throw new SourceStageError(`names a sheet, but the source is a ${container.kind} document`, {
				declaration,
				detail: 'Use "iterator" to locate a sibling array of a JSON document.',
			});
		}
		const sheet = from!.sheet as string;
		if (!container.sheetNames.includes(sheet)) {
			throw new SourceStageError(`sheet "${sheet}" is not in this workbook`, {
				declaration,
				detail: formatAvailableNames(container.sheetNames),
			});
		}
		const headerRow = from!.header_row ?? 0;
		try {
			return await container.readSheet(sheet, headerRow);
		} catch (err) {
			throw new SourceStageError(`sheet "${sheet}" could not be read`, {
				declaration,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (container.kind !== 'json') {
		throw new SourceStageError(`names an iterator, but the source is a ${container.kind}`, {
			declaration,
			detail: 'Use "sheet" to name another sheet of the same workbook.',
		});
	}
	if (from!.header_row !== undefined) {
		// Never silently ignore a declaration. header_row is a spreadsheet
		// banner-depth control and means nothing to an iterator.
		throw new SourceStageError('header_row applies to a sheet, not to an iterator', {
			declaration,
			detail: 'Remove header_row, or select the secondary collection with "sheet" instead.',
		});
	}
	const iterator = from!.iterator as string;
	try {
		const root = await container.readDocument();
		return toSourceRows(iterateJsonPath(root, iterator)).rows;
	} catch (err) {
		throw new SourceStageError(`iterator "${iterator}" could not be resolved`, {
			declaration,
			detail: err instanceof Error ? err.message : String(err),
		});
	}
}

// ---------------------------------------------------------------------------
// Lookup (per primary row)
// ---------------------------------------------------------------------------

/**
 * Bind every prepared alias onto one primary row.
 *
 * Returns a NEW object. The parser's own row is never mutated: an eager
 * ParsedData is the caller's array, and writing into it would leak this run's
 * enrichment into the next one.
 *
 * Called once per streamed primary row, so it holds nothing across rows.
 */
export async function applyJoins(
	row: Row,
	prepared: readonly PreparedJoin[],
	sourceRowNumber: number,
): Promise<Row> {
	if (prepared.length === 0) return row;
	const out: Row = { ...row };
	for (const join of prepared) {
		const raw = await join.primaryKey.evaluate(row, sourceRowNumber);
		const key = normalizeKey(raw, {
			declaration: `${join.declaration}.on.primary`,
			expression: join.primaryKey.text,
			row: sourceRowNumber,
			side: 'primary',
		});
		const matches = join.index.get(key);

		// NO MATCH IS DATA (verdict rule 5). The alias is simply absent, in BOTH
		// cardinalities, so `{alias.field|optional}` handles a miss identically
		// either way and no new grammar is needed.
		if (!matches || matches.length === 0) continue;

		if (join.cardinality === 'one') {
			if (matches.length > 1) {
				throw new SourceStageError(
					`cardinality "one" but ${matches.length} rows matched key "${key}"`,
					{
						declaration: join.declaration,
						expression: join.primaryKey.text,
						row: sourceRowNumber,
						detail: 'Either the key is not unique in the secondary collection, or this join is '
							+ 'cardinality "many". Picking one of the matches is never done: it would make the '
							+ 'output depend on source row order.',
					},
				);
			}
			out[join.alias] = join.select ? project(matches[0], join.select) : matches[0];
			continue;
		}

		// "many" binds a list of SCALARS, one per match, in secondary-collection
		// order. A single match stays a list of length 1: output shape must not
		// depend on how many rows happened to match.
		const field = join.select![0];
		const values: unknown[] = [];
		for (const match of matches) {
			const value = match[field];
			// Absence of the field ON A ROW is data (heterogeneous collections are
			// real); its absence from the whole collection was refused at preflight.
			if (value === undefined || value === null) continue;
			values.push(value);
		}
		out[join.alias] = values;
	}
	return out;
}

function project(row: Row, select: readonly string[]): Row {
	const out: Row = {};
	for (const field of select) out[field] = row[field];
	return out;
}

/**
 * Key normalization, identical on both sides (contract §4.3): the same
 * `String(v).trim()` coercion the parsers already apply to scalar cells.
 *
 * Every refusal here is the same rule: absence of the KEY is a defect, and a
 * key that is not a scalar is not a key.
 */
function normalizeKey(
	value: unknown,
	ctx: { declaration: string; expression: string; row: number; side: 'primary' | 'secondary' },
): string {
	const where = ctx.side === 'secondary' ? 'secondary row' : 'row';
	if (value === undefined || value === null) {
		throw new SourceStageError('key is undefined', {
			declaration: ctx.declaration,
			expression: ctx.expression,
			row: ctx.row,
			detail: `The key expression produced no value for this ${where}. Absence of a RELATION is data and is fine; `
				+ 'absence of the KEY is a defect, because every following row would be looked up under nothing.',
		});
	}
	if (typeof value === 'object') {
		throw new SourceStageError(
			`key is ${Array.isArray(value) ? 'an array' : 'an object'}, and a key must be a single scalar`,
			{
				declaration: ctx.declaration,
				expression: ctx.expression,
				row: ctx.row,
				detail: 'Compose a scalar key with & if the match needs more than one field, '
					+ "for example `source ID` & '|' & `mapping type`.",
			},
		);
	}
	const key = String(value).trim();
	if (key === '') {
		throw new SourceStageError('key is empty after trimming', {
			declaration: ctx.declaration,
			expression: ctx.expression,
			row: ctx.row,
			detail: 'An empty key would collide every empty-keyed row into one bucket, which is a defect of the '
				+ 'same class as an absent key.',
		});
	}
	return key;
}

/** Union of own keys in first-appearance order. Mirrors the parsers' column ordering. */
function unionKeys(rows: readonly Row[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				names.push(key);
			}
		}
	}
	return names;
}
