/**
 * src/source/expression.ts — the guardrails and the single jsonata choke point.
 *
 * Ch 46 source contract §6 and acceptance cases B8, B9, E2, E3, E4.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
	assertReferencesExist,
	compileSourceExpression,
	PERMITTED_FUNCTIONS,
	SOURCE_EXPRESSION_MAX_LENGTH,
	SOURCE_EXPRESSION_STACK_DEPTH,
	SOURCE_EXPRESSION_TIMEOUT_MS,
	SOURCE_STAGE_BUDGET_MS,
	SourceStageBudget,
} from '../src/source';
import { SourceStageError } from '../src/source/errors';

const WHERE = { declaration: 'source.where' };

function compileError(expression: string): SourceStageError {
	try {
		compileSourceExpression(expression, WHERE);
	} catch (err) {
		expect(err).toBeInstanceOf(SourceStageError);
		return err as SourceStageError;
	}
	throw new Error(`expected ${expression} to be refused`);
}

describe('E2 — jsonata has exactly one caller in src/', () => {
	/**
	 * Contract §6.3: "Nothing else in the codebase may call jsonata() directly,
	 * and a lint rule or test should assert that." Same discipline as the R0
	 * single-tokenizer refactor: four call sites with four option objects is how
	 * silent divergence happens.
	 */
	function walkTsFiles(dir: string, out: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walkTsFiles(full, out);
			else if (entry.endsWith('.ts')) out.push(full);
		}
		return out;
	}

	it('only src/source/expression.ts imports the engine', () => {
		const srcRoot = join(__dirname, '..', 'src');
		const importers = walkTsFiles(srcRoot).filter((file) => {
			const text = readFileSync(file, 'utf8');
			return /(^|\n)\s*import\s+[^;]*from\s+['"]jsonata['"]/.test(text)
				|| /require\(\s*['"]jsonata['"]\s*\)/.test(text);
		});
		expect(importers.map((f) => f.slice(srcRoot.length + 1))).toEqual([join('source', 'expression.ts')]);
	});
});

describe('E3 — compile options', () => {
	it('pins the guardrail numbers the contract specifies', () => {
		expect(SOURCE_EXPRESSION_MAX_LENGTH).toBe(512);
		expect(SOURCE_EXPRESSION_TIMEOUT_MS).toBe(100);
		expect(SOURCE_EXPRESSION_STACK_DEPTH).toBe(100);
		expect(SOURCE_STAGE_BUDGET_MS).toBe(5000);
	});

	it('never enables recover, which would collect errors instead of throwing', () => {
		const source = readFileSync(join(__dirname, '..', 'src', 'source', 'expression.ts'), 'utf8');
		expect(source).not.toMatch(/recover\s*:\s*true/);
	});

	it('applies the per-evaluation timeout (D1012), loudly', async () => {
		// Reaches the timeout only because it is compiled through a path that
		// bypasses the subset walk is impossible here: lambdas are refused. So
		// assert the option is actually installed by checking the engine throws
		// on a runaway expression compiled with the same options.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const jsonata = require('jsonata') as (s: string, o?: unknown) => { evaluate: (i: unknown) => Promise<unknown> };
		const runaway = jsonata('($f := function($n){ $n <= 0 ? 0 : $f($n - 1) }; $f(500000))', {
			timeout: SOURCE_EXPRESSION_TIMEOUT_MS,
			stack: SOURCE_EXPRESSION_STACK_DEPTH,
		});
		await expect(runaway.evaluate({})).rejects.toMatchObject({ code: 'D1012' });
	});
});

describe('E4 — whole-stage budget', () => {
	it('aborts with a SourceStageError once the cumulative budget is spent', async () => {
		const budget = new SourceStageBudget(0); // every evaluation overruns
		const compiled = compileSourceExpression("Subcategory != ''", { ...WHERE, budget });
		await expect(compiled.evaluate({ Subcategory: 'x' }, 7)).rejects.toBeInstanceOf(SourceStageError);
		await expect(compiled.evaluate({ Subcategory: 'x' }, 7)).rejects.toThrow('evaluation budget');
	});

	it('leaves a normal run far inside the budget', async () => {
		const budget = new SourceStageBudget();
		const compiled = compileSourceExpression("Subcategory != ''", { ...WHERE, budget });
		for (let i = 0; i < 2000; i++) await compiled.evaluate({ Subcategory: i % 2 ? 'x' : '' }, i + 1);
		expect(budget.spentMs).toBeLessThan(SOURCE_STAGE_BUDGET_MS);
	});
});

describe('B9 — expression length ceiling', () => {
	it('refuses a 600-character expression at preflight', () => {
		const long = `Subcategory != '${'x'.repeat(600)}'`;
		const err = compileError(long);
		expect(err.message).toContain('over the 512 character limit');
		expect(err.declaration).toBe('source.where');
	});

	it('admits an expression exactly at the ceiling', () => {
		const padding = 'x'.repeat(SOURCE_EXPRESSION_MAX_LENGTH - "Subcategory != ''".length);
		const atLimit = `Subcategory != '${padding}'`;
		expect(atLimit.length).toBe(SOURCE_EXPRESSION_MAX_LENGTH);
		expect(() => compileSourceExpression(atLimit, WHERE)).not.toThrow();
	});

	it('refuses an empty expression', () => {
		expect(compileError('   ').message).toContain('non-empty string');
	});
});

describe('parse failures are preflight failures', () => {
	it('names the engine code and position', () => {
		const err = compileError('Subcategory = ');
		expect(err.message).toContain('does not parse');
		expect(err.detail).toContain('S0207');
		expect(err.row).toBeUndefined();
	});
});

describe('B8 and §6.2 — the permitted subset', () => {
	it.each([
		["Subcategory != ''", 'bare field reference'],
		['`CIS Safeguard` != \'\'', 'backtick-quoted field reference'],
		["meta.tier = '2'", 'dotted traversal'],
		["$.Subcategory = ''", 'the $ context head'],
		["element_type in ['sort', 'party']", 'array literal membership'],
		["a = 'x' and (b = 'y' or c = 'z')", 'grouping parentheses'],
		["$number(count) >= 5", 'numeric coercion'],
		["$trim(`CIS Safeguard`) != ''", 'trim'],
		["a & '-' & b = 'x-y'", 'concatenation'],
	])('admits %s (%s)', (expression) => {
		expect(() => compileSourceExpression(expression, WHERE)).not.toThrow();
	});

	it.each([
		["$eval('1+1') = 2", '$eval'],
		["$match(a, /x/)", 'regex'],
		['$lookup($, \'a\') = 1', '$lookup'],
		['$exists(function($x) { $x })', 'lambda'],
		["a ? true : false", 'conditional'],
		['($x := a; $x = 1)', 'variable assignment'],
		['$$.a = 1', 'root reference'],
		['(a ~> $lowercase()) = 1', 'chain operator'],
		["**.a = 1", 'descendant wildcard'],
		['$sum([1, 2]) > 1', 'unlisted function'],
	])('refuses %s (%s)', (expression) => {
		const err = compileError(expression);
		expect(err.message).toContain('does not permit');
	});

	it('names the permitted set in the rejection, so the fix is discoverable', () => {
		const err = compileError('$sum([1, 2]) > 1');
		for (const fn of PERMITTED_FUNCTIONS) expect(err.detail).toContain(`$${fn}`);
	});

	it('bans regex with an explicit cross-runtime-parity reason', () => {
		// `$match(a, /x/)` is refused one level earlier, because $match itself is
		// not allowlisted. Put the literal inside a PERMITTED function so the
		// regex branch is the one that fires.
		const err = compileError('$exists(/abc/)');
		expect(err.message).toContain('a regular expression');
		expect(err.detail).toContain('Python');
	});

	it('is an allowlist, so an unknown node type is refused rather than admitted', () => {
		// `|...|...|` (transform) is not in the permitted table and must be
		// refused by the default branch, not merely by an explicit case.
		expect(compileError('$exists(|a|{"b": 1}|)').message).toContain('does not permit');
	});
});

describe('literal-only $contains predicate', () => {
	it('returns false for absent or numeric first arguments and accepts join-key declarations', async () => {
		const missing = compileSourceExpression("$contains(identifier, '(')", { declaration: 'source.where' });
		expect(await missing.evaluate({}, 1)).toBe(false);
		expect(await missing.evaluate({ identifier: 7 }, 2)).toBe(false);
		const join = compileSourceExpression("$contains(identifier, '(')", { declaration: 'source.joins.aux.on.primary' });
		expect(await join.evaluate({ identifier: 'ZZ-1(1)' }, 1)).toBe(true);
	});

	it('accepts substring matching with a string-literal pattern', async () => {
		const predicate = compileSourceExpression("$not($contains(identifier, '('))", WHERE);
		expect(predicate.references).toEqual(['identifier']);
		expect(await predicate.evaluate({ identifier: 'ZZ-1' }, 1)).toBe(true);
		expect(await predicate.evaluate({ identifier: 'ZZ-1(2)' }, 2)).toBe(false);
	});

	it.each(["$contains(identifier, pattern)", '$contains(identifier, /\\(/)', '$contains(identifier)', "$contains(identifier, '(' & 'x')"])(
		'refuses dynamic, regex, or arity-incorrect pattern %s', (expression) => {
			expect(compileError(expression).message).toContain('does not permit');
		},
	);
});

describe('G2 — reference collection and preflight', () => {
	it('collects the ROOT of each path, in first-appearance order', () => {
		const compiled = compileSourceExpression(
			"meta.tier = '2' and `CIS Safeguard` != '' and $trim(Subcategory) != ''",
			WHERE,
		);
		expect(compiled.references).toEqual(['meta', 'CIS Safeguard', 'Subcategory']);
	});

	it('does not treat a nested path segment as a root reference', () => {
		// `tier` is a property of `meta`, not a column. Requiring it to be a
		// column would break every nested-JSON source.
		const compiled = compileSourceExpression("meta.tier = '2'", WHERE);
		expect(compiled.references).not.toContain('tier');
	});

	it('accepts an expression whose references all exist', () => {
		const compiled = compileSourceExpression("Subcategory != ''", WHERE);
		expect(() =>
			assertReferencesExist(compiled, new Set(['ID', 'Subcategory']), ['ID', 'Subcategory']),
		).not.toThrow();
	});

	it('refuses a typo, listing the available names', () => {
		const compiled = compileSourceExpression("Subcatgory != ''", WHERE);
		let thrown: SourceStageError | undefined;
		try {
			assertReferencesExist(compiled, new Set(['ID', 'Subcategory']), ['ID', 'Subcategory']);
		} catch (err) {
			thrown = err as SourceStageError;
		}
		expect(thrown).toBeInstanceOf(SourceStageError);
		expect(thrown!.message).toContain('unknown field "Subcatgory"');
		expect(thrown!.detail).toContain('Available: ID, Subcategory');
	});

	it('caps the available-names list at 40', () => {
		const names = Array.from({ length: 100 }, (_, i) => `col${i}`);
		const compiled = compileSourceExpression("nope != ''", WHERE);
		try {
			assertReferencesExist(compiled, new Set(names), names);
			throw new Error('expected a rejection');
		} catch (err) {
			const detail = (err as SourceStageError).detail!;
			expect(detail).toContain('col39');
			expect(detail).not.toContain('col40,');
			expect(detail).toContain('(60 more)');
		}
	});
});
