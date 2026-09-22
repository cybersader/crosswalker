/**
 * source/index.ts — the source stage.
 *
 * Ch 46 source contract §2. Fixed, spec-owned pipeline order:
 *
 *   parse
 *     -> [0] source.nest      depth-first row emission with lineage
 *     -> [1] source.where     row predicate, over each emitted row
 *     -> [2] source.joins     keyed lookup enrichment, over surviving rows
 *   identity -> curie mint -> concept_cid -> render() -> Tier 1 validate -> write
 *
 * The order is fixed by the SPEC, never by the recipe. That single property is
 * what makes every future source shape additive (contract §9): a recipe that
 * never expressed an opinion about stage order can never be contradicted by a
 * stage inserted later. An ordered step-list in the recipe would be the general
 * transform stage the verdict rejected.
 *
 * `where` BEFORE `joins` is a ruling, not an accident (contract §2.1): it keeps
 * the predicate a pure function of the source row, it does no lookup work for
 * rows that are discarded anyway, and it structurally prevents inner-join
 * semantics arriving through the back door. `where: "$exists(alias)"` cannot be
 * written, because at the time `where` runs no alias exists yet, so its G2
 * reference preflight rejects the name.
 *
 * ADDITIVITY IS LOAD-BEARING: when a recipe declares no source shaping,
 * prepareSourceStage returns the caller's own `rows` reference unchanged, never
 * constructs an expression, and never enters the jsonata module at all
 * (acceptance case A4).
 */

import type { ParsedData, SourceContainer } from '../types/config';
import type { NestedRecordLevel } from '../types/generated/recipe';
import { renderTemplate } from '../render/template';
import { SourceStageError } from './errors';
import { expandNestedRows, type LineageObject } from './nest';
import {
	assertReferencesExist,
	compileSourceExpression,
	SourceStageBudget,
	type CompiledSourceExpression,
} from './expression';
import { assertAdmittedSomething, evaluateWherePredicate, WHERE_DECLARATION, type WhereTally } from './where';
import {
	applyJoins,
	prepareJoins,
	resolveSecondaryRows,
	type JoinFromDeclaration,
	type JoinsDeclaration,
	type PreparedJoin,
} from './joins';

export { SourceStageError } from './errors';
export type { SourceStageErrorInit } from './errors';
export {
	compileSourceExpression,
	assertReferencesExist,
	getSourceExpressionCompileCount,
	resetSourceExpressionCompileCount,
	SourceStageBudget,
	SOURCE_EXPRESSION_MAX_LENGTH,
	SOURCE_EXPRESSION_TIMEOUT_MS,
	SOURCE_EXPRESSION_STACK_DEPTH,
	SOURCE_STAGE_BUDGET_MS,
	PERMITTED_FUNCTIONS,
	type CompiledSourceExpression,
} from './expression';
export { evaluateWherePredicate, assertAdmittedSomething, WHERE_DECLARATION } from './where';
export { shorthandToSourceExpression } from './shorthand';
export {
	prepareJoins,
	applyJoins,
	resolveSecondaryRows,
	normalizeKey,
	ALIAS_PATTERN,
	RESERVED_ALIASES,
} from './joins';
export { expandNestedRows } from './nest';
export type { LineageObject, NestExpansion } from './nest';
export type {
	JoinDeclaration,
	JoinFromDeclaration,
	JoinOnDeclaration,
	JoinsDeclaration,
	PreparedJoin,
} from './joins';

type Row = Record<string, unknown>;

/**
 * How many streamed rows to buffer when the parser has not yet published a
 * column list, so G2 has a key universe to check against (contract §3.4: "all
 * rows if eager, else the first 200 streamed rows"). Bounded, so streaming
 * survives: memory does not scale with row count.
 */
export const STREAM_KEY_UNIVERSE_SAMPLE = 200;

/**
 * The recipe's `source` block, as far as the source stage cares. Loose typing
 * matches the runtime contract: recipes arrive as parsed JSON and are validated
 * upstream against spec/recipe.schema.json.
 */
export interface SourceStageDeclaration {
	nest?: NestedRecordLevel[];
	where?: string;
	joins?: JoinsDeclaration;
}

export interface SourceStage {
	/** True when the recipe declared any source shaping. */
	readonly active: boolean;
	/**
	 * Rows for the rest of the pipeline. When inactive this is the caller's own
	 * `parsedData.rows` reference, unchanged.
	 */
	readonly rows: Iterable<Row> | AsyncIterable<Row>;
	/**
	 * The 1-indexed SOURCE row number for a row the stage emitted. Downstream
	 * errors must name the row the user can find in their spreadsheet, not the
	 * post-filter position. Falls back to `fallbackIndex + 1`, which is exactly
	 * what the engine used before this stage existed.
	 */
	sourceRowNumber(row: unknown, fallbackIndex: number): number;
	/** Rows the stage excluded. Informational. */
	readonly excludedCount: number;
	/** Source rows the stage examined. */
	readonly examinedCount: number;
	/**
	 * The lookup indexes this run built, in declaration order. Empty when no
	 * join is declared. Exposed so the memory cost of a join is a number a test
	 * can assert on rather than a claim in a comment.
	 */
	readonly joins: readonly PreparedJoin[];
	/** Emitted row total when source shaping can know it before iteration. */
	readonly expectedRowCount?: number;
	/** Source record counts at each declared nest level, including leaf: none levels. */
	readonly countsByLevel?: Record<string, number>;
	/** Joined child rows whose parent key did not name an emitted parent, by child level. */
	readonly unparented?: Record<string, number>;
	/** End-of-stream guards (G3). Call after the row loop completes normally. */
	finalize(): void;
}

const INACTIVE_STAGE_SOURCE_ROW = (_row: unknown, fallbackIndex: number) => fallbackIndex + 1;

const EMPTY_JOINS: readonly PreparedJoin[] = Object.freeze([]);

async function resolveNestedSecondaryRows(
	from: JoinFromDeclaration,
	container: SourceContainer | undefined,
	declaration: string,
	budget: SourceStageBudget,
): Promise<Row[]> {
	const rows = await resolveSecondaryRows(from, container, declaration);
	if (from.where === undefined || from.where === null) return rows;

	const names = unionKeys(rows);
	const compiled = compileSourceExpression(from.where, {
		declaration: `${declaration}.where`,
		budget,
	});
	assertReferencesExist(compiled, new Set(names), names);
	const tally: WhereTally = { examined: 0, admitted: 0, excluded: 0 };
	const kept: Row[] = [];
	for (let index = 0; index < rows.length; index++) {
		tally.examined += 1;
		if (await evaluateWherePredicate(compiled, rows[index], index + 1)) {
			tally.admitted += 1;
			kept.push(rows[index]);
		} else {
			tally.excluded += 1;
		}
	}
	assertAdmittedSomething(compiled, tally);
	return kept;
}

/**
 * Prepare the source stage for one generation run.
 *
 * Async because the G2 key-universe preflight may need to sample a streamed
 * source. Preflight completes BEFORE any row is handed downstream, so a typo'd
 * column name produces zero writes and one clear error (contract §7).
 */
export async function prepareSourceStage(
	parsedData: ParsedData,
	source: SourceStageDeclaration | undefined,
	options: { budget?: SourceStageBudget } = {},
): Promise<SourceStage> {
	const nest = source?.nest;
	const whereText = source?.where;
	const joinsDeclaration = hasJoins(source?.joins) ? (source!.joins as JoinsDeclaration) : undefined;

	// The additive path. No expression is constructed, jsonata is never entered,
	// no container handle is ever called, and the caller's rows reference is
	// passed straight through.
	if (nest === undefined && (whereText === undefined || whereText === null) && joinsDeclaration === undefined) {
		return {
			active: false,
			rows: parsedData.rows as Iterable<Row> | AsyncIterable<Row>,
			sourceRowNumber: INACTIVE_STAGE_SOURCE_ROW,
			excludedCount: 0,
			examinedCount: 0,
			joins: EMPTY_JOINS,
			finalize: () => undefined,
		};
	}

	const budget = options.budget ?? new SourceStageBudget();
	let expectedRowCount: number | undefined;
	let countsByLevel: Record<string, number> | undefined;
	let unparented: Record<string, number> | undefined;
	let stageData = parsedData;

	// [0] nest expansion. JSON parsing is eager in this build, so the complete
	// depth-first sequence is available before G2 checks expressions. That lets
	// `_cw` and every child-level field enter the key universe before `where`
	// compiles, while the downstream generator still sees one row per note.
	if (nest !== undefined) {
		if (!Array.isArray(parsedData.rows)) {
			throw new SourceStageError(
				'Nested records require an eager JSON source in this build. Import a JSON document without streaming.',
				{ declaration: 'source.nest' },
			);
		}
		const expansion = await expandNestedRows(
			parsedData.rows,
			nest,
			(template, row) => renderTemplate(template, row),
			{
				resolve: (from, declaration) => resolveNestedSecondaryRows(
					from,
					parsedData.container,
					declaration,
					budget,
				),
			},
		);
		expectedRowCount = expansion.rows.length;
		countsByLevel = expansion.countsByLevel;
		unparented = expansion.unparented;
		const columns = unionKeys(expansion.rows, [...parsedData.columns, '_cw']);
		stageData = { ...parsedData, rows: expansion.rows, rowCount: expansion.rows.length, columns };
	}

	// G2 preflight needs the primary collection's key universe, and so does the
	// alias-collision check. Buffers a bounded prefix when the parser has not
	// published columns yet (streaming CSV publishes them lazily, as rows arrive).
	const { universe, names, buffered, iterator } = await resolveKeyUniverse(stageData);

	let compiled: CompiledSourceExpression | undefined;
	if (whereText !== undefined && whereText !== null) {
		compiled = compileSourceExpression(whereText, { declaration: WHERE_DECLARATION, budget });
		// Deliberately BEFORE prepareJoins: at this point no alias exists, so a
		// `where` naming one is reported as an unknown field. That is what makes
		// "where runs before joins" a structural property rather than a promise.
		assertReferencesExist(compiled, universe, names);
	}

	// Every lookup index is built here, before a single primary row is handed
	// downstream. A bad declaration therefore produces zero writes.
	const joins = joinsDeclaration
		? await prepareJoins(joinsDeclaration, {
			primaryKeyUniverse: universe,
			primaryKeyNames: names,
			container: parsedData.container,
			budget,
		})
		: EMPTY_JOINS;

	const tally: WhereTally = { examined: 0, admitted: 0, excluded: 0 };
	const rowNumbers = new WeakMap<object, number>();

	const rows = shapeRows(compiled, joins, tally, rowNumbers, buffered, iterator);

	return {
		active: true,
		rows,
		sourceRowNumber(row: unknown, fallbackIndex: number): number {
			if (row !== null && typeof row === 'object') {
				const known = rowNumbers.get(row as object);
				if (known !== undefined) return known;
			}
			return fallbackIndex + 1;
		},
		get excludedCount() {
			return tally.excluded;
		},
		get examinedCount() {
			return tally.examined;
		},
		joins,
		expectedRowCount,
		countsByLevel,
		unparented,
		finalize() {
			if (compiled) assertAdmittedSomething(compiled, tally);
		},
	};
}

/** A declared-but-empty `joins: {}` is not a declaration. The schema forbids it too. */
function hasJoins(joins: JoinsDeclaration | undefined): boolean {
	return joins !== undefined && joins !== null && Object.keys(joins).length > 0;
}

/**
 * The shaping generator — the ONE place stage order lives.
 *
 * Always async, because the engine's row loop already accepts an AsyncIterable
 * and jsonata's evaluate() is async-only (there is no synchronous API). That
 * asyncness is an additional structural reason these expressions can never move
 * into the pure, synchronous render().
 *
 * STREAMING IS PRESERVED FOR THE PRIMARY COLLECTION. This generator pulls
 * exactly one primary row, shapes it, and yields it; it holds no row across
 * iterations and accumulates nothing. The only memory a join costs is its
 * secondary index, built once at preflight. tests/source-joins.test.ts asserts
 * lock-step consumption, so buffering the primary would fail the suite rather
 * than merely contradict this comment.
 *
 * A failure throws OUT of the iterator, not inside the engine's per-row
 * try/catch, which is exactly the abort semantics the contract demands.
 */
async function* shapeRows(
	compiled: CompiledSourceExpression | undefined,
	joins: readonly PreparedJoin[],
	tally: WhereTally,
	rowNumbers: WeakMap<object, number>,
	buffered: Row[],
	iterator: Iterator<Row> | AsyncIterator<Row> | null,
): AsyncIterable<Row> {
	const excludedAncestors: Array<{ level: string; path: string[] }> = [];
	const shape = async function* (row: Row, sourceRowNumber: number) {
		tally.examined += 1;

		// [0] nest expansion already produced this depth-first row and attached
		// lineage during preflight. This is the first shaping step; no later step
		// creates rows.

		// [1] where — over the emitted row, before any alias exists.
		if (compiled) {
			const keep = await evaluateWherePredicate(compiled, row, sourceRowNumber);
			if (!keep) {
				tally.excluded += 1;
				const lineage = lineageOf(row);
				if (lineage) excludedAncestors.push({ level: lineage.level, path: lineage.path });
				return;
			}
		}
		tally.admitted += 1;

		// A filtered parent does not cascade to its descendants. Its identity stays
		// in `_cw.parent` and `_cw.path`, while its carried folder values are blanked
		// so render records the existing folder-level-skipped deviation and places
		// the descendant one level up.
		const admitted = omitExcludedAncestorValues(row, excludedAncestors);

		// [2] joins — over the surviving row only.
		const shaped = joins.length > 0 ? await applyJoins(admitted, joins, sourceRowNumber) : admitted;

		// Number the object the pipeline actually emits: a joined row is a new
		// object, so registering the input would leave downstream errors naming
		// a fallback position instead of the user's spreadsheet row.
		if (shaped !== null && typeof shaped === 'object') rowNumbers.set(shaped as object, sourceRowNumber);
		yield shaped;
	};

	let sourceRowNumber = 0;
	for (const row of buffered) {
		sourceRowNumber += 1;
		yield* shape(row, sourceRowNumber);
	}
	if (!iterator) return;
	for (;;) {
		const next = await iterator.next();
		if (next.done) return;
		sourceRowNumber += 1;
		yield* shape(next.value as Row, sourceRowNumber);
	}
}

function lineageOf(row: Row): LineageObject | null {
	const value = row._cw;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const lineage = value as Partial<LineageObject>;
	return typeof lineage.level === 'string' && Array.isArray(lineage.path) && lineage.ancestors
		? lineage as LineageObject
		: null;
}

function omitExcludedAncestorValues(
	row: Row,
	excluded: readonly { level: string; path: string[] }[],
): Row {
	const lineage = lineageOf(row);
	if (!lineage) return row;
	const levels = excluded
		.filter((candidate) => candidate.path.length < lineage.path.length
			&& candidate.path.every((part, index) => lineage.path[index] === part))
		.map((candidate) => candidate.level);
	if (levels.length === 0) return row;
	const ancestors = Object.fromEntries(
		Object.entries(lineage.ancestors).map(([level, values]) => [level, levels.includes(level) ? {} : { ...values }]),
	);
	return { ...row, _cw: { ...lineage, ancestors } };
}

interface KeyUniverse {
	universe: ReadonlySet<string>;
	names: string[];
	/** Rows already pulled off a stream during sampling; re-emitted first. */
	buffered: Row[];
	/** Remaining source, or null when `buffered` is the whole collection. */
	iterator: Iterator<Row> | AsyncIterator<Row> | null;
}

/**
 * Build the collection's key universe for G2 (contract §3.4 step 3).
 *
 * | source        | universe                                  | strictness |
 * |---------------|-------------------------------------------|------------|
 * | CSV, XLSX     | ParsedData.columns, complete + authoritative | strict   |
 * | JSON (eager)  | union of own keys over all rows (the JSON parser already computes exactly this into `columns`) | a name on any row passes |
 * | streaming     | union over the first STREAM_KEY_UNIVERSE_SAMPLE rows | a name on any sampled row passes |
 *
 * All three collapse to one rule: the reference must appear in the union. The
 * strictness difference is a property of how complete the union is, not of the
 * check.
 */
async function resolveKeyUniverse(parsedData: ParsedData): Promise<KeyUniverse> {
	const declared = Array.isArray(parsedData.columns) ? parsedData.columns.filter((c) => typeof c === 'string') : [];
	const rows = parsedData.rows as Iterable<Row> | AsyncIterable<Row>;
	const openIterator = (): Iterator<Row> | AsyncIterator<Row> => {
		const asyncFactory = (rows as AsyncIterable<Row>)[Symbol.asyncIterator];
		return asyncFactory ? asyncFactory.call(rows) : (rows as Iterable<Row>)[Symbol.iterator]();
	};

	// `buffered` + `iterator` together always represent the WHOLE row sequence:
	// nothing pulled off a stream for sampling is ever dropped.
	if (declared.length > 0) {
		return { universe: new Set(declared), names: declared, buffered: [], iterator: openIterator() };
	}

	// No published columns. An eager array can be scanned outright without
	// consuming anything; a stream gets a bounded sample that is re-emitted.
	if (Array.isArray(rows)) {
		const names = unionKeys(rows);
		return { universe: new Set(names), names, buffered: [], iterator: openIterator() };
	}

	const iterator = openIterator();
	const buffered: Row[] = [];
	let exhausted = false;
	while (buffered.length < STREAM_KEY_UNIVERSE_SAMPLE) {
		const next = await iterator.next();
		if (next.done) {
			exhausted = true;
			break;
		}
		buffered.push(next.value as Row);
	}
	// A streaming parser may publish its columns into the SAME array once rows
	// start arriving (see csv-parser's lazily-populated `columns`), so re-read.
	const latecomers = Array.isArray(parsedData.columns) ? parsedData.columns.filter((c) => typeof c === 'string') : [];
	const names = unionKeys(buffered, latecomers);
	return { universe: new Set(names), names, buffered, iterator: exhausted ? null : iterator };
}

/** Union of own keys in first-appearance order, matching the parsers' own column ordering. */
function unionKeys(rows: readonly Row[], seedNames: readonly string[] = []): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of seedNames) {
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
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

/**
 * Convert a SourceStageError into the shape GenerationResult.errors carries.
 * Preflight failures use row 0, matching the existing `Ambiguous identity`
 * convention in generation-engine.ts.
 */
export function toGenerationError(err: SourceStageError): { row: number; message: string; declaration: string } {
	return { row: err.row ?? 0, message: err.message, declaration: err.declaration };
}
