import WDIOReporter, { type HookStats, type RunnerStats, type TestStats } from '@wdio/reporter';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal machine-readable results for the nightly red ledger.
 *
 * Enabled only when `CW_E2E_RESULTS_DIR` is set (see wdio.conf.mts). One JSON
 * file per spec worker, shaped for `scripts/check-known-red.mjs`:
 *
 *   { "spec": "tests/e2e/x.spec.ts",
 *     "tests": [{ "title": "...", "fullTitle": "...", "state": "passed" }] }
 *
 * `title` is the `it(...)` title, which is what tests/e2e/KNOWN_RED.md names.
 * A failing `before`/`beforeEach` hook is recorded as a failed case titled
 * after the hook, so a spec that never reaches its tests still reads red.
 *
 * Written in-repo on top of @wdio/reporter (already a dependency) rather than
 * adding @wdio/json-reporter, so the ledger needs no new package.
 */
export interface JsonResultsReporterOptions {
	resultsDir: string;
}

interface CaseResult {
	title: string;
	fullTitle: string;
	state: string;
}

export default class JsonResultsReporter extends WDIOReporter {
	private readonly resultsDir: string;
	private readonly cases: CaseResult[] = [];
	private spec = '';
	private cid = '';

	constructor(options: JsonResultsReporterOptions & Record<string, unknown>) {
		super(options);
		this.resultsDir = options.resultsDir;
	}

	override onRunnerStart(runner: RunnerStats): void {
		this.cid = runner.cid;
		const first = runner.specs[0] ?? '';
		const file = first.startsWith('file://') ? fileURLToPath(first) : first;
		this.spec = path.relative(process.cwd(), file).split(path.sep).join('/');
	}

	override onTestEnd(test: TestStats): void {
		this.cases.push({ title: test.title, fullTitle: test.fullTitle, state: test.state });
	}

	override onHookEnd(hook: HookStats): void {
		if (hook.error) {
			this.cases.push({ title: `"${hook.title}" hook`, fullTitle: hook.title, state: 'failed' });
		}
	}

	override onRunnerEnd(): void {
		mkdirSync(this.resultsDir, { recursive: true });
		const name = `results-${this.cid.replace(/[^\w-]/g, '_')}-${Date.now()}.json`;
		writeFileSync(path.join(this.resultsDir, name), JSON.stringify({ spec: this.spec, tests: this.cases }, null, 2));
	}
}
