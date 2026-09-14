/**
 * folder-settings-s10-sidecar-path.test.ts -- S10 (2026-09-04, pass 19, Task C
 * item 5): the Tier 2 sidecar path is the fourth and last path-shaped
 * setting, and it now has ONE reading like the other three.
 *
 * THE DEFECT THIS PINS. `tier2SidecarPath` was read RAW at every call site
 * (`main.ts`'s two readers, `sidecar.ts`'s `sahPoolKeyFor` and `openSidecar`),
 * each applying its OWN bare `normalizePath` -- which does not `.trim()` and
 * answers `'/'` where this module answers `''`. "Open the index" and "clear
 * the index" agreed with each other only by both being wrong the same way; a
 * leading space or a pasted non-breaking space would key the sahpool VFS
 * under a name the pool does not hold, and a clear that finds no files
 * deletes nothing while reporting the index as already empty.
 *
 * THE RULE, and where it differs from the other three. Unlike the evidence
 * folders (S11), an empty value here takes the DEFAULT rather than meaning
 * the vault root: this setting names a FILE, and the vault root is not a file
 * name. `tier2SidecarPath` (settings-record reader) and `normalizeSidecarPath`
 * (raw-string reader, for `sidecar.ts`'s two entry points, which are handed a
 * path by their own callers) apply the SAME rule so "open" and "clear" cannot
 * drift again.
 */

import { tier2SidecarPath, normalizeSidecarPath, DEFAULT_TIER2_SIDECAR_PATH } from '../src/settings/folder-settings';

describe('S10: tier2SidecarPath / normalizeSidecarPath -- the ONE reading of the sidecar setting', () => {
	it('a trailing slash reaches the sidecar normalized (the separator is stripped, same rule as every other folder setting)', () => {
		expect(normalizeSidecarPath('.crosswalker.sqlite/')).toBe('.crosswalker.sqlite');
		expect(tier2SidecarPath({ tier2SidecarPath: 'data/index.sqlite/' })).toBe('data/index.sqlite');
	});

	it('a leading "./" passes through unchanged -- the host\'s own normalizePath does not resolve dot-segments, only separators, so this is NOT a second spelling of the mirror', () => {
		// Deliberately asserted rather than assumed: real Obsidian's normalizePath
		// collapses separators and folds whitespace/Unicode, but it is not a full
		// path resolver and never touches a literal "." segment. The AM-45 mirror
		// this setting routes through must agree, or the "one function" claim is
		// false for this input.
		expect(normalizeSidecarPath('./config.sqlite')).toBe('./config.sqlite');
	});

	it('an internal doubled separator collapses, same as every other folder setting', () => {
		expect(normalizeSidecarPath('data//index.sqlite')).toBe('data/index.sqlite');
	});

	it('an empty value takes the DEFAULT FILE NAME -- unlike the evidence folders (S11), NOT the vault root, because this setting names a file', () => {
		expect(normalizeSidecarPath('')).toBe(DEFAULT_TIER2_SIDECAR_PATH);
		expect(normalizeSidecarPath(undefined)).toBe(DEFAULT_TIER2_SIDECAR_PATH);
		expect(tier2SidecarPath({ tier2SidecarPath: '' })).toBe(DEFAULT_TIER2_SIDECAR_PATH);
		expect(tier2SidecarPath({})).toBe(DEFAULT_TIER2_SIDECAR_PATH);
	});

	it('a bare root separator ALSO takes the default -- reinforcing "this names a file", the opposite of S11\'s evidence-folder rule', () => {
		expect(normalizeSidecarPath('/')).toBe(DEFAULT_TIER2_SIDECAR_PATH);
	});

	it('the settings-record reader and the raw-string reader agree on the SAME input -- the two real consumers (sahPoolKeyFor, openSidecar) cannot drift', () => {
		const raw = '  Data/Sidecar.sqlite//  ';
		expect(tier2SidecarPath({ tier2SidecarPath: raw })).toBe(normalizeSidecarPath(raw));
	});
});
