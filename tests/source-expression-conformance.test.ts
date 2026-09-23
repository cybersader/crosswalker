/**
 * Conformance runner for spec/conformance/source-expressions.json.
 *
 * Ch 46 source contract §10 D1-D6. The JSON file is the contract; this is one
 * implementation of a runner for it. It deliberately calls the engine DIRECTLY
 * for engine-semantics cases (`value` / `undefined` / `parse_error` /
 * `eval_error`) rather than going through compileSourceExpression, because
 * those cases describe what JSONata itself does, independent of Crosswalker's
 * site policy. Site policy (`rejected_by_subset`) goes through
 * compileSourceExpression, which is where the subset lives.
 *
 * That split is the point of the file: a Python port must reproduce the engine
 * rows with its own engine and the policy rows with its own subset checker.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import jsonata from 'jsonata';
import { compileSourceExpression, PERMITTED_FUNCTIONS } from '../src/source';
import { SourceStageError } from '../src/source/errors';

interface ConformanceCase {
	id: string;
	expression: string;
	input: string;
	expect: { kind: string; value?: unknown; code?: string };
}

interface ConformanceFile {
	spec_version: string;
	engine: { package: string; minimum_version: string };
	inputs: Record<string, Record<string, unknown>>;
	cases: ConformanceCase[];
}

const FILE = join(__dirname, '..', 'spec', 'conformance', 'source-expressions.json');
const suite = JSON.parse(readFileSync(FILE, 'utf8')) as ConformanceFile;

describe('source-expression conformance suite', () => {
	it('declares an engine floor the installed package satisfies', () => {
		// Contract §6.1: jsonata >= 2.2.1. A silent downgrade would change the
		// semantics this file pins without changing the file.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const installed = require('jsonata/package.json') as { version: string; name: string };
		expect(installed.name).toBe(suite.engine.package);
		const [major, minor, patch] = installed.version.split('.').map(Number);
		const [fMajor, fMinor, fPatch] = suite.engine.minimum_version.split('.').map(Number);
		const asNum = (a: number, b: number, c: number) => a * 1e6 + b * 1e3 + c;
		expect(asNum(major, minor, patch)).toBeGreaterThanOrEqual(asNum(fMajor, fMinor, fPatch));
	});

	it('names an input that exists for every case', () => {
		for (const c of suite.cases) expect(Object.keys(suite.inputs)).toContain(c.input);
	});

	it('has unique case ids', () => {
		const ids = suite.cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('covers every permitted function (contract §10 D4)', () => {
		const covered = suite.cases
			.filter((c) => c.expect.kind === 'value' || c.expect.kind === 'undefined')
			.map((c) => c.expression)
			.join(' ');
		for (const fn of PERMITTED_FUNCTIONS) expect(covered).toContain(`$${fn}(`);
	});

	it('pins the measured undefined-absorption fact (contract §10 D3)', () => {
		const d3 = suite.cases.find((c) => c.id === 'missing-name-compares-false');
		expect(d3).toBeDefined();
		expect(d3!.expect).toEqual({ kind: 'value', value: false });
	});

	describe.each(suite.cases.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
		const input = suite.inputs[testCase.input];

		if (testCase.expect.kind === 'rejected_by_subset') {
			it('is refused by the permitted subset, before evaluating anything', () => {
				let thrown: unknown;
				try {
					compileSourceExpression(testCase.expression, { declaration: 'source.where' });
				} catch (err) {
					thrown = err;
				}
				expect(thrown).toBeInstanceOf(SourceStageError);
				expect((thrown as SourceStageError).message).toContain('does not permit');
			});
			return;
		}

		if (testCase.expect.kind === 'site_value') {
			it('evaluates to the pinned site-policy value', async () => {
				const expression = compileSourceExpression(testCase.expression, { declaration: 'source.where' });
				expect(await expression.evaluate(input)).toEqual(testCase.expect.value);
			});
			return;
		}

		if (testCase.expect.kind === 'parse_error') {
			it('does not parse', () => {
				let code: string | undefined;
				try {
					jsonata(testCase.expression);
				} catch (err) {
					code = (err as { code?: string }).code;
				}
				expect(code).toBeDefined();
				if (testCase.expect.code) expect(code).toBe(testCase.expect.code);
			});
			return;
		}

		if (testCase.expect.kind === 'eval_error') {
			it('parses but throws at evaluation', async () => {
				const expr = jsonata(testCase.expression);
				let code: string | undefined;
				try {
					await expr.evaluate(input);
				} catch (err) {
					code = (err as { code?: string }).code;
				}
				expect(code).toBeDefined();
				if (testCase.expect.code) expect(code).toBe(testCase.expect.code);
			});
			return;
		}

		it(`evaluates to the pinned ${testCase.expect.kind}`, async () => {
			const result = await jsonata(testCase.expression).evaluate(input);
			if (testCase.expect.kind === 'undefined') {
				expect(result).toBeUndefined();
			} else {
				expect(result).toEqual(testCase.expect.value);
			}
		});
	});
});
