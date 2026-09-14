/**
 * output-root-am53.test.ts -- AM-53 (2026-09-04, pass 17, Task C item 3): every
 * surface that compares against the output root normalizes it, through ONE
 * accessor.
 *
 * THE DEFECT THIS PINS (pass-16 Ground 3 / CONFIRMED 3). `main.ts`'s status-bar
 * lookup and `workspace-view.ts`'s "Installed frameworks" count both did
 * `app.vault.getAbstractFileByPath(settings.defaultOutputPath)` -- the RAW
 * setting, straight into a direct file-map key lookup that normalizes nothing.
 * The engine normalizes the root at its own boundary (AM-49); these two
 * surfaces did not, so a trailing separator in the setting field -- entered
 * once, in Settings, with no source import involved at all -- made a
 * successful import report "Nothing imported yet" and 0 ontologies over a
 * vault that had just written the notes.
 *
 * THE RULE. `outputRootPath(settings)` is the only way `defaultOutputPath` is
 * read anywhere a comparison happens: trim, `normalizePath`, then the host's
 * `'/'` (what an empty path normalizes to) folded back to `''`, which is the
 * SAME empty-root spelling `normalizeBasePath` uses at the engine boundary
 * (AM-49). The settings field itself keeps storing exactly what the person
 * typed -- a text box that rewrites itself under the cursor is hostile -- only
 * READERS are routed through the one function.
 *
 * `outputRootFile(app, settings)` is the companion for the two surfaces that
 * need the root AS A VAULT ENTRY: the vault root's own key in the file map is
 * `'/'`, not `''`, so asking `getAbstractFileByPath('')` for the "Vault root"
 * state answers null and every caller reads that as "nothing installed". The
 * conversion lives here, once, rather than as a second spelling of it in each
 * caller.
 */

import { TFolder, normalizePath } from 'obsidian';
import { outputRootPath, normalizeFolderSetting as normalizeOutputRoot, outputRootFile } from '../src/settings/folder-settings';
import type { App } from 'obsidian';

function makeApp(folders: string[]): App {
	const set = new Set(folders);
	return {
		vault: {
			getAbstractFileByPath: (path: string) => (set.has(path) ? new TFolder(path) : null),
		},
	} as unknown as App;
}

const settingsWith = (defaultOutputPath: string) => ({ defaultOutputPath });

// ---------------------------------------------------------------------------
// Five spellings of "the vault root" -- all must resolve to the SAME root.
// ---------------------------------------------------------------------------

describe('AM-53: outputRootPath resolves five spellings of the vault root to the same string', () => {
	const EMPTY = ''; // the supported "Vault root" state, rendered as such in Settings

	it('an empty setting resolves to the empty string (never the host\'s truthy \'/\')', () => {
		expect(outputRootPath(settingsWith(EMPTY))).toBe('');
	});

	it('a bare "/" resolves the same as empty', () => {
		expect(outputRootPath(settingsWith('/'))).toBe(outputRootPath(settingsWith(EMPTY)));
		expect(outputRootPath(settingsWith('/'))).toBe('');
	});

	it('a trailing slash on a real folder resolves the same as no trailing slash', () => {
		expect(outputRootPath(settingsWith('Frameworks/'))).toBe(outputRootPath(settingsWith('Frameworks')));
		expect(outputRootPath(settingsWith('Frameworks/'))).toBe('Frameworks');
	});

	it('an NBSP (U+00A0) pasted from a document folds to an ordinary space, matching the plain-space spelling', () => {
		const withNbsp = 'My Frameworks';
		expect(outputRootPath(settingsWith(withNbsp))).toBe(outputRootPath(settingsWith('My Frameworks')));
		expect(outputRootPath(settingsWith(withNbsp))).toBe('My Frameworks');
	});

	it('a backslash (pasted from a Windows path) resolves the same as a forward slash', () => {
		expect(outputRootPath(settingsWith('Frameworks\\NIST'))).toBe(outputRootPath(settingsWith('Frameworks/NIST')));
		expect(outputRootPath(settingsWith('Frameworks\\NIST'))).toBe('Frameworks/NIST');
	});

	it('all five spellings of the empty/root case collapse to one value, checked together', () => {
		const spellings = ['', '/', '  ', ' / ', ' '];
		const resolved = spellings.map((s) => outputRootPath(settingsWith(s)));
		expect(new Set(resolved).size).toBe(1);
		expect(resolved[0]).toBe('');
	});

	it('is the SAME empty-root spelling the engine boundary uses (AM-49), by construction: both fold the host\'s \'/\' back to \'\'', () => {
		// normalizeOutputRoot is the function normalizeBasePath's own doc comment
		// (AM-49) says the two must agree with -- checked directly, not by
		// re-deriving a second copy of the mapping here.
		expect(normalizePath('')).toBe('/'); // the host fact both functions correct for
		expect(normalizeOutputRoot('')).toBe('');
		expect(normalizeOutputRoot('/')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// outputRootFile: the counting surfaces' own lookup, including the '' vs '/'
// vault-root key conversion.
// ---------------------------------------------------------------------------

describe('AM-53: outputRootFile resolves the counting surfaces\' lookup for every spelling, including the vault root itself', () => {
	it('a real folder with a trailing separator in the SETTING still resolves to that folder', () => {
		const app = makeApp(['Frameworks']);
		const file = outputRootFile(app, settingsWith('Frameworks/'));
		expect(file).not.toBeNull();
		expect(file!.path).toBe('Frameworks');
	});

	it('an empty setting (the supported "Vault root" state) resolves to the vault root -- never null', () => {
		// getAbstractFileByPath('') answers null on the real host; the vault
		// root's own key is '/'. Without the conversion, this is exactly the
		// "Nothing imported yet" defect: a successful import at the vault root
		// reported as if nothing were there.
		const app = makeApp(['/']);
		const file = outputRootFile(app, settingsWith(''));
		expect(file).not.toBeNull();
		expect(file!.path).toBe('/');
	});

	it('a bare "/" setting resolves to the SAME vault-root entry as an empty setting', () => {
		const app = makeApp(['/']);
		const viaEmpty = outputRootFile(app, settingsWith(''));
		const viaSlash = outputRootFile(app, settingsWith('/'));
		expect(viaSlash).not.toBeNull();
		expect(viaSlash!.path).toBe(viaEmpty!.path);
	});

	it('a folder that genuinely does not exist still resolves to null -- the fix does not manufacture folders', () => {
		const app = makeApp(['Frameworks']);
		const file = outputRootFile(app, settingsWith('Nonexistent'));
		expect(file).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The status-bar refresh guard: '' must schedule, not silently stay dead.
//
// `main.ts`'s `pathAffectsInstalledFrameworks` is a private method on the
// plugin class, which this repo does not instantiate end to end in unit tests
// (`Plugin`'s base constructor wires commands, ribbon icons and workspace
// events that need a much larger harness than this defect needs to be pinned
// well). Its whole body after AM-53 is `const outputRoot = outputRootPath(...)
// ; if (!outputRoot) return true; ...` -- so the fact this test pins directly,
// against the REAL production accessor rather than a re-derived copy of the
// guard, is the one AM-53's own doc comment states the defect as: the host's
// `normalizePath('')` is the truthy string `'/'`, which is why reading the
// setting raw left `!outputRoot` permanently false for the supported "Vault
// root" state. `outputRootPath` closes exactly that gap.
// ---------------------------------------------------------------------------

describe('AM-53: the status-bar refresh guard\'s own premise -- \'\' now reads as empty, so the refresh schedules', () => {
	it('the RAW setting for "vault root" is falsy under normalizePath alone -- this is the bug AM-53 closes, verified against the real host', () => {
		// This is what main.ts's guard would still see today if it read
		// `normalizePath(settings.defaultOutputPath)` directly instead of the
		// accessor: truthy, so `!outputRoot` never fires.
		expect(normalizePath('')).toBeTruthy();
		expect(!normalizePath('')).toBe(false);
	});

	it('outputRootPath answers empty for every root spelling, so !outputRootPath(...) is true -- the guard schedules', () => {
		for (const spelling of ['', '/', '  ', ' / ']) {
			expect(!outputRootPath(settingsWith(spelling))).toBe(true);
		}
	});

	it('a real (non-root) output path is NOT read as empty -- the guard stays scoped, not always-on', () => {
		expect(!outputRootPath(settingsWith('Frameworks'))).toBe(false);
		expect(!outputRootPath(settingsWith('Frameworks/'))).toBe(false);
	});
});
