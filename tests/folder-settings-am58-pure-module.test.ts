/**
 * folder-settings-am58-pure-module.test.ts -- AM-58 (2026-09-04, pass 19, Task
 * C item 1): a pure module stays pure, and an absent declaration is a failed
 * gate.
 *
 * THE DEFECT THIS PINS (pass-18 Ground 1 / BLOCKING). AM-57 gave
 * `folder-settings.ts` a VALUE import of `obsidian` (`normalizePath`), behind a
 * module (`evidence-link.ts`) whose own header promises "no vault access, so
 * the contract below is unit-testable". Jest hides the missing `obsidian`
 * package behind `moduleNameMapper`; the wdio/tsx loader used by
 * `tests/e2e/ch43-release-drift.spec.ts` has no such mapping, so the spec died
 * with `Cannot find module 'obsidian'` BEFORE Mocha registered a single line.
 * Nine green declarations simply stopped existing, and a PASS -> FAIL diff
 * cannot see a spec that emits nothing -- the gate's own blind spot until pass
 * 18's suite agent diffed the ABSENT set by hand.
 *
 * THE RULE. `folder-settings.ts` imports `App`/`TAbstractFile` TYPE-ONLY
 * (erased at compile time) and normalizes through the AM-45 mirror
 * (`src/render/vault-path.ts`) instead of the host's `normalizePath`. Both
 * halves are proven here: the mirror-based `normalizeFolderSetting` agrees
 * with the HOST'S OWN mock on every input the AM-45 suite already exercises,
 * plus the four inputs this amendment names by name; and a real Node process
 * (no `moduleNameMapper`, no `obsidian` package on disk -- the exact
 * conditions `ch43-release-drift.spec.ts` runs under) can load both
 * `evidence-link.ts` and `folder-settings.ts` without throwing.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { normalizeFolderSetting } from '../src/settings/folder-settings';
import { normalizePath as mockNormalizePath } from './__mocks__/obsidian';

const REPO_ROOT = join(__dirname, '..');

// Built from \u escapes, deliberately (mirrors vault-path-normalization-am45.test.ts's
// own hygiene rule) -- no literal non-ASCII character appears anywhere else in
// this file, so an editor or tool that quietly re-normalizes text it touches
// cannot silently collapse the composed/decomposed distinction this test relies on.
const NBSP = ' ';
const NNBSP = ' ';
const COMPOSED_AE = 'ä'; // "a WITH DIAERESIS", ONE code point
const DECOMPOSED_AE = 'ä'; // "a" + COMBINING DIAERESIS, TWO code points
const COMPOSED = `Zug${COMPOSED_AE}nge`;
const DECOMPOSED = `Zug${DECOMPOSED_AE}nge`;

describe('AM-58: normalizeFolderSetting agrees with the host mock on every AM-45 mutation, plus the amendment\'s own four inputs', () => {
	const inputs = [
		// The AM-45 mutation set (vault-path-normalization-am45.test.ts).
		'Ordinary',
		'IT/OT',
		'IT\\OT',
		'/Identify',
		'Identify/',
		'A//B',
		`A${NBSP}B`,
		`A${NNBSP}B`,
		COMPOSED,
		DECOMPOSED,
		'',
		'A/B/C/D',
		// AM-58's own four, named in the amendment text (excluding the two
		// whitespace-bearing ones -- '   ' and ' a/ ' below -- which exercise
		// `normalizeFolderSetting`'s OWN extra `.trim()` step, a behaviour
		// deliberately ADDED on top of the mirror for settings text a person
		// typed, and never claimed to be shared with the host's raw
		// `normalizePath`, which does not trim whitespace at all).
		'/',
		'//',
	];
	for (const input of inputs) {
		it(`agrees on ${JSON.stringify(input)}`, () => {
			// The host's normalizePath('') is '/', and normalizeFolderSetting maps
			// BOTH spellings of the root ('' and '/') to '' -- so the two agree only
			// after that one deliberate remapping, which is asserted explicitly
			// below rather than folded silently into this loop.
			const host = mockNormalizePath(input);
			const mirrored = normalizeFolderSetting(input);
			if (host === '/') {
				expect(mirrored).toBe('');
			} else {
				expect(mirrored).toBe(host);
			}
		});
	}

	it('a whitespace-only value normalizes to the root ("   " has no real segment once trimmed)', () => {
		expect(normalizeFolderSetting('   ')).toBe('');
	});

	it('both spellings of the root ("" and "/") normalize to the SAME empty string', () => {
		expect(normalizeFolderSetting('')).toBe('');
		expect(normalizeFolderSetting('/')).toBe('');
	});

	it('a doubled separator ("//") normalizes to the root, same as the host', () => {
		expect(mockNormalizePath('//')).toBe('/');
		expect(normalizeFolderSetting('//')).toBe('');
	});

	it('leading/trailing whitespace around a real segment collapses to the trimmed segment', () => {
		expect(normalizeFolderSetting(' a/ ')).toBe('a');
	});
});

describe('AM-58: a real Node process with NO obsidian package on disk can load these two modules', () => {
	// The exact failure mode: `bun x tsx -e "..."` has no moduleNameMapper and no
	// `obsidian` package installed, so a VALUE import of `obsidian` anywhere in
	// the module graph throws `Cannot find module 'obsidian'` before anything
	// else runs. This is the same loader tests/e2e/ch43-release-drift.spec.ts
	// (and every other Node-side e2e spec) uses.
	function loadInNode(specifier: string): { status: number | null; stderr: string } {
		const result = spawnSync('bun', ['x', 'tsx', '-e', `import('${specifier}')`], {
			cwd: REPO_ROOT,
			encoding: 'utf-8',
			timeout: 60_000,
		});
		return { status: result.status, stderr: result.stderr ?? '' };
	}

	it('src/settings/folder-settings.ts loads cleanly (AM-58\'s own verification command)', () => {
		const { status, stderr } = loadInNode('./src/settings/folder-settings');
		expect(stderr).not.toContain("Cannot find module 'obsidian'");
		expect(status).toBe(0);
	}, 60_000);

	it('src/views/evidence-link.ts loads cleanly -- its "no vault access" header claim is honest again', () => {
		const { status, stderr } = loadInNode('./src/views/evidence-link');
		expect(stderr).not.toContain("Cannot find module 'obsidian'");
		expect(status).toBe(0);
	}, 60_000);

	// Control, not a requirement of AM-58: proves this harness actually detects
	// a value import of the host when one is present, rather than the two tests
	// above passing vacuously for an unrelated reason (a broken `bun x tsx`
	// invocation would exit non-zero for every specifier alike).
	it('control: src/generation/import-set.ts (residual risk 1, still a value importer of the host) still fails to load -- proving this harness catches the failure AM-58 fixed elsewhere', () => {
		const { status, stderr } = loadInNode('./src/generation/import-set');
		expect(status).not.toBe(0);
		expect(stderr).toContain("Cannot find module 'obsidian'");
	}, 60_000);
});
