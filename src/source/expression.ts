/**
 * expression.ts — the ONE place this codebase calls jsonata().
 *
 * Ch 46 source contract §6.3: "Single choke point. Nothing else in the codebase
 * may call jsonata() directly, and a lint rule or test should assert that."
 * Same discipline as the R0 single-tokenizer refactor in src/render/template.ts,
 * and for the same reason: four call sites with four option objects is how
 * silent divergence happens. tests/source-expression.test.ts asserts it.
 *
 * What this module owns:
 *   - the length ceiling
 *   - the permitted-subset AST walk (contract §6.2)
 *   - collection of root field references, for the G2 reference preflight
 *   - the compile options ({ timeout, stack }; `recover` never true)
 *   - the whole-stage evaluation budget
 *
 * Everything here is a PREFLIGHT concern except evaluate(). A compiled
 * expression that survives compileSourceExpression() has already been proven
 * length-legal, subset-legal, and parseable; only reference existence (G2,
 * which needs the collection's key universe) and the per-row guards remain.
 */

import jsonata from 'jsonata';
import { SourceStageError, formatAvailableNames } from './errors';

// ---------------------------------------------------------------------------
// Guardrail constants (contract §6.3)
// ---------------------------------------------------------------------------

/** Contract §6.3. Keeps expressions reviewable; reinforces "computation goes to a producer". */
export const SOURCE_EXPRESSION_MAX_LENGTH = 512;

/**
 * Per-evaluation timeout. Measured typical eval is ~2 microseconds (20,000
 * evaluations of `Subcategory != ''` in 40 ms on the dev machine, 2026-08-27),
 * so 100 ms is ~50,000x headroom and can never false-positive. jsonata throws
 * D1012 on exceed.
 */
export const SOURCE_EXPRESSION_TIMEOUT_MS = 100;

/**
 * Stack depth ceiling. Defense in depth ONLY, and the contract says to report
 * that honestly rather than overclaim: measured, a 5,000-deep tail-recursive
 * lambda does NOT trip `stack: 100`, because JSONata tail-call-optimizes. The
 * real depth bound is the subset's ban on lambdas. jsonata throws D1011.
 */
export const SOURCE_EXPRESSION_STACK_DEPTH = 100;

/**
 * Cumulative wall-clock ceiling across every source-stage evaluation in one
 * run. 18,570 evaluations measured at 35 ms, so 5 s is ~140x the largest
 * secondary collection in the corpus.
 */
export const SOURCE_STAGE_BUDGET_MS = 5000;

/**
 * The 8 allowlisted functions (contract §6.2). Deliberately tiny: every
 * construct permitted here is one an external Python producer must match
 * exactly. $contains is restricted to a literal substring (no regex). Regex
 * functions remain banned because JS-vs-Python regex parity is not guaranteed.
 */
export const PERMITTED_FUNCTIONS: ReadonlySet<string> = new Set([
	'not',
	'exists',
	'trim',
	'lowercase',
	'uppercase',
	'string',
	'number',
	'contains',
]);

/** Binary operators the subset admits. */
const PERMITTED_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	'=', '!=', '<', '<=', '>', '>=', 'in', 'and', 'or', '&',
]);

// ---------------------------------------------------------------------------
// A4 instrumentation
// ---------------------------------------------------------------------------

let compileCount = 0;

/**
 * Acceptance case A4: "A recipe with neither declaration must not construct,
 * compile, or invoke JSONata at all. Assert the module is never entered
 * (spy or counter)." This is that counter.
 */
export function getSourceExpressionCompileCount(): number {
	return compileCount;
}

/** Test-only reset for the A4 counter. */
export function resetSourceExpressionCompileCount(): void {
	compileCount = 0;
}

// ---------------------------------------------------------------------------
// Evaluation budget
// ---------------------------------------------------------------------------

/**
 * Whole-stage budget (contract §6.3). One instance per generation run, shared
 * by every compiled source expression in that run, so a stage that is slow in
 * aggregate fails even when no single evaluation trips the per-eval timeout.
 */
export class SourceStageBudget {
	private spent = 0;

	constructor(private readonly limitMs: number = SOURCE_STAGE_BUDGET_MS) {}

	get spentMs(): number {
		return this.spent;
	}

	charge(ms: number, ctx: { declaration: string; expression: string; row?: number }): void {
		this.spent += ms;
		// `>=`, not `>`: landing exactly on the ceiling has exceeded the budget,
		// and it lets a 0 ms budget mean "no evaluation is permitted at all",
		// which is what makes this guard testable without a fake clock.
		if (this.spent >= this.limitMs) {
			throw new SourceStageError(
				`source stage exceeded its ${this.limitMs} ms evaluation budget`,
				{ ...ctx, detail: `Spent ${Math.round(this.spent)} ms evaluating source expressions.` },
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Compiled expression
// ---------------------------------------------------------------------------

export interface CompiledSourceExpression {
	/** The expression text exactly as the recipe wrote it. */
	readonly text: string;
	/** Declaration path this expression came from, e.g. 'source.where'. */
	readonly declaration: string;
	/**
	 * Root field references, in first-appearance order. `meta.tier` contributes
	 * `meta`; `` `CIS Safeguard` `` contributes `CIS Safeguard`. This is the
	 * input to the G2 reference preflight (contract §3.4 step 2).
	 */
	readonly references: readonly string[];
	/** Evaluate against one row. Throws SourceStageError on engine failure. */
	evaluate(row: unknown, row1Indexed?: number): Promise<unknown>;
}

export interface CompileSourceExpressionOptions {
	/** Declaration path used in every error this expression can raise. */
	declaration: string;
	/** Shared whole-stage budget. Omitted means a fresh private budget. */
	budget?: SourceStageBudget;
}

/**
 * Compile one source-stage expression under the full guardrail set.
 *
 * Order matters: length before parse (a 100 KB string should not reach the
 * parser), parse before subset walk (the walk needs an AST), subset walk before
 * anything evaluates. G2 (reference existence) is NOT here because it needs the
 * collection's key universe; call assertReferencesExist() once that is known.
 */
export function compileSourceExpression(
	text: string,
	options: CompileSourceExpressionOptions,
): CompiledSourceExpression {
	const declaration = options.declaration;

	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new SourceStageError('expression must be a non-empty string', {
			declaration,
			detail: `Got ${describeValue(text)}.`,
		});
	}
	if (text.length > SOURCE_EXPRESSION_MAX_LENGTH) {
		throw new SourceStageError(
			`expression is ${text.length} characters, over the ${SOURCE_EXPRESSION_MAX_LENGTH} character limit`,
			{
				declaration,
				detail: 'Long expressions are computation. Computation belongs in the producer that emits the source, not in the recipe.',
			},
		);
	}

	compileCount += 1;

	let expr: ReturnType<typeof jsonata>;
	try {
		// `recover` is deliberately never true: it collects errors instead of
		// throwing, which directly contradicts the loudness contract.
		expr = jsonata(text, {
			timeout: SOURCE_EXPRESSION_TIMEOUT_MS,
			stack: SOURCE_EXPRESSION_STACK_DEPTH,
		});
	} catch (err) {
		const e = err as { code?: string; position?: number; message?: string };
		throw new SourceStageError('expression does not parse', {
			declaration,
			expression: text,
			detail: `${e.code ?? 'parse error'} at position ${e.position ?? '?'}: ${e.message ?? String(err)}`,
		});
	}

	const references = assertPermittedSubset(expr.ast() as ExprNode, { declaration, expression: text });
	// JSONata returns undefined for a missing first argument and throws on a number.
	// Site semantics for this literal-only function are a boolean in both cases.
	if (text.includes('$contains')) expr.registerFunction('contains',
		(value: unknown, literal: string) => typeof value === 'string' && value.includes(literal));
	const budget = options.budget ?? new SourceStageBudget();

	return {
		text,
		declaration,
		references,
		async evaluate(row: unknown, row1Indexed?: number): Promise<unknown> {
			const started = Date.now();
			try {
				const value = await expr.evaluate(row as Record<string, unknown>);
				budget.charge(Date.now() - started, { declaration, expression: text, row: row1Indexed });
				return value;
			} catch (err) {
				if (err instanceof SourceStageError) throw err;
				const e = err as { code?: string; message?: string };
				throw new SourceStageError('expression failed to evaluate', {
					declaration,
					expression: text,
					row: row1Indexed,
					detail: `${e.code ?? 'evaluation error'}: ${e.message ?? String(err)}`,
				});
			}
		},
	};
}

/**
 * G2, the reference preflight (contract §3.4) — the load-bearing guard.
 *
 * THE MEASURED FACT THIS EXISTS FOR (contract §0): jsonata's comparison and
 * logic operators absorb an undefined operand, so a typo'd column name in
 * `Typo != ''` returns a perfectly good boolean `false` for EVERY row. The
 * import then admits zero rows, writes zero notes, and reports nothing. A
 * return-type check cannot see that. This can.
 *
 * The rule, and it is the same rule the verdict already states for join keys:
 *   absence of a field ON A ROW is data; absence FROM THE COLLECTION is a defect.
 *
 * Heterogeneous JSON is why the universe is a union over the collection rather
 * than a per-row requirement: CPRT leaves `title` absent on some element kinds,
 * and that is real data.
 */
export function assertReferencesExist(
	compiled: CompiledSourceExpression,
	keyUniverse: ReadonlySet<string>,
	universeNames: readonly string[],
): void {
	if (keyUniverse.size === 0) return; // nothing known about the collection; G1/G3 still apply
	for (const reference of compiled.references) {
		if (!keyUniverse.has(reference)) {
			throw new SourceStageError(`unknown field "${reference}". The source has no such column`, {
				declaration: compiled.declaration,
				expression: compiled.text,
				detail: formatAvailableNames(universeNames),
			});
		}
	}
}

// ---------------------------------------------------------------------------
// The permitted-subset walk (contract §6.2)
// ---------------------------------------------------------------------------

interface ExprNode {
	type: string;
	value?: unknown;
	position?: number;
	arguments?: ExprNode[];
	procedure?: ExprNode;
	steps?: ExprNode[];
	expressions?: ExprNode[];
	stages?: ExprNode[];
	lhs?: ExprNode | unknown;
	rhs?: ExprNode | unknown;
}

/**
 * Walk the AST, rejecting anything outside §6.2 and collecting root field
 * references on the way. Allowlist, never denylist: an unrecognized node type
 * is rejected, so a future jsonata release that adds syntax cannot widen this
 * subset by accident.
 */
function assertPermittedSubset(
	ast: ExprNode,
	ctx: { declaration: string; expression: string },
): string[] {
	const references: string[] = [];
	const seen = new Set<string>();
	const addReference = (name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			references.push(name);
		}
	};

	const reject = (construct: string, why?: string): never => {
		throw new SourceStageError(`uses ${construct}, which the source expression subset does not permit`, {
			declaration: ctx.declaration,
			expression: ctx.expression,
			detail: `${why ? why + ' ' : ''}Permitted: field references, string/number/true/false/null literals, array literals, ` +
				`= != < <= > >= in and or &, and the functions ` +
				`${[...PERMITTED_FUNCTIONS].map((f) => '$' + f).join(' ')}. ` +
				'Anything more is computation and belongs in the producer that emits the source.',
		});
	};

	const walk = (node: ExprNode | undefined): void => {
		if (!node || typeof node !== 'object') return;
		switch (node.type) {
			case 'string':
			case 'number':
			case 'value':
				return;

			case 'path':
				walkPath(node);
				return;

			case 'binary': {
				const op = String(node.value);
				if (!PERMITTED_BINARY_OPERATORS.has(op)) reject(`the "${op}" operator`);
				walk(node.lhs as ExprNode);
				walk(node.rhs as ExprNode);
				return;
			}

			case 'unary': {
				const op = String(node.value);
				if (op === '[') {
					// Array literal, e.g. `element_type in ['sort', 'party']`.
					for (const child of node.expressions ?? []) walk(child);
					return;
				}
				if (op === '{') reject('an object constructor');
				reject(`the unary "${op}" operator`);
				return;
			}

			case 'block': {
				// Grouping parens `(a or b)` parse to a block with ONE expression
				// and are essential for `and`/`or` precedence. A block with two or
				// more expressions is the `(...; ...)` sequence form the contract
				// rejects by name. Implementation ruling, recorded in the report.
				const expressions = node.expressions ?? [];
				if (expressions.length !== 1) {
					reject('a multi-expression block "( ... ; ... )"');
				}
				walk(expressions[0]);
				return;
			}

			case 'function': {
				const procedure = node.procedure;
				const name = procedure && procedure.type === 'variable' ? String(procedure.value) : undefined;
				if (!name || !PERMITTED_FUNCTIONS.has(name)) {
					reject(`the function $${name ?? '<computed>'}`);
				}
				// JSONata also accepts a regex as $contains' second argument. Only a
				// literal substring has portable semantics across producers.
				if (name === 'contains' && (node.arguments?.length !== 2 || node.arguments[1]?.type !== 'string')) {
					reject('$contains without a string-literal second argument');
				}
				for (const arg of node.arguments ?? []) walk(arg);
				return;
			}

			case 'variable':
				// A bare `$` (value '') or `$$` (value '$') or a user variable.
				// None of them are permitted outside the head of a path.
				reject(node.value === '' ? 'the bare "$" context reference' : `the variable "$${String(node.value)}"`);
				return;

			case 'lambda':
				reject('a lambda (function(...) { ... })', 'Lambdas are unbounded in cost and recursion depth.');
				return;
			case 'condition':
				reject('a conditional (a ? b : c)');
				return;
			case 'bind':
				reject('a variable assignment (:=)');
				return;
			case 'apply':
				reject('the chain operator (~>)');
				return;
			case 'regex':
			case 'regexp':
				reject(
					'a regular expression',
					'Regex is banned at every source expression site: JS regex and Python re disagree, and cross-runtime parity is the point of this subset.',
				);
				return;
			case 'partial':
				reject('a partial function application');
				return;
			case 'transform':
				reject('a transform (|...|...|)');
				return;
			case 'descendant':
				reject('the descendant wildcard (**)');
				return;
			case 'wildcard':
				reject('the wildcard (*)');
				return;
			default:
				reject(`an unsupported construct ("${node.type}")`);
		}
	};

	const walkPath = (node: ExprNode): void => {
		const steps = node.steps ?? [];
		if (steps.length === 0) reject('an empty path');
		let index = 0;
		const head = steps[0];
		if (head.type === 'variable') {
			// `$` (value '') as the head of a path is permitted and means "this
			// row". `$$` (value '$') is the document root: rejected, because the
			// row IS the unit of evaluation and $$ would reach past it.
			if (head.value !== '') {
				reject(head.value === '$' ? 'the root reference ($$)' : `the variable "$${String(head.value)}"`);
			}
			index = 1;
		}
		let rootTaken = false;
		for (; index < steps.length; index++) {
			const step = steps[index];
			if (step.type !== 'name') reject(`a "${step.type}" path step`);
			if (step.stages && step.stages.length > 0) reject('a path predicate/filter ([...])');
			if (!rootTaken) {
				addReference(String(step.value));
				rootTaken = true;
			}
		}
		// `$` alone as a whole path has no name step and contributes no reference.
		if (node.stages && node.stages.length > 0) reject('a path predicate/filter ([...])');
	};

	walk(ast);
	return references;
}

function describeValue(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
	if (Array.isArray(value)) return `an array of ${value.length}`;
	return `${typeof value} ${JSON.stringify(value)}`;
}

/** Shared by G1's error message and any future value-type guard. */
export function describeResultValue(value: unknown): string {
	return describeValue(value);
}
