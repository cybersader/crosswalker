/**
 * entry-points.test.ts — pure-logic coverage for the non-command-palette
 * discovery surfaces (file-menu extension filtering, status bar ontology
 * count derivation, first-run/update notice gate).
 */

import {
	IMPORTABLE_EXTENSIONS,
	isImportableExtension,
	formatOntologyStatusLabel,
	checkFirstRun,
} from '../src/ui/entry-points';

describe('isImportableExtension', () => {
	it('accepts every extension in IMPORTABLE_EXTENSIONS', () => {
		for (const ext of IMPORTABLE_EXTENSIONS) {
			expect(isImportableExtension(ext)).toBe(true);
		}
	});

	it('is case-insensitive', () => {
		expect(isImportableExtension('CSV')).toBe(true);
		expect(isImportableExtension('Xlsx')).toBe(true);
		expect(isImportableExtension('JSON')).toBe(true);
	});

	it('rejects extensions the wizard cannot read', () => {
		expect(isImportableExtension('md')).toBe(false);
		expect(isImportableExtension('pdf')).toBe(false);
		expect(isImportableExtension('')).toBe(false);
		expect(isImportableExtension('txt')).toBe(false);
	});
});

describe('formatOntologyStatusLabel', () => {
	it('uses a no-frameworks message at zero', () => {
		expect(formatOntologyStatusLabel(0)).toBe('Crosswalker: no frameworks yet');
	});

	it('uses singular "framework" at exactly one', () => {
		expect(formatOntologyStatusLabel(1)).toBe('Crosswalker: 1 framework');
	});

	it('uses plural "frameworks" for counts above one', () => {
		expect(formatOntologyStatusLabel(2)).toBe('Crosswalker: 2 frameworks');
		expect(formatOntologyStatusLabel(15)).toBe('Crosswalker: 15 frameworks');
	});

	it('reads "indexing" while the count is unknown, never zero', () => {
		expect(formatOntologyStatusLabel('indexing')).toBe('Crosswalker: indexing');
		expect(formatOntologyStatusLabel('indexing')).not.toContain('no frameworks');
	});

	it('never contains an em dash', () => {
		expect(formatOntologyStatusLabel('indexing')).not.toContain('—');
		expect(formatOntologyStatusLabel(0)).not.toContain('—');
		expect(formatOntologyStatusLabel(3)).not.toContain('—');
	});
});

describe('checkFirstRun', () => {
	it('shows on a fresh install (no recorded version)', () => {
		expect(checkFirstRun(null, '0.1.6')).toEqual({ shouldShow: true, reason: 'first-install' });
		expect(checkFirstRun(undefined, '0.1.6')).toEqual({ shouldShow: true, reason: 'first-install' });
		expect(checkFirstRun('', '0.1.6')).toEqual({ shouldShow: true, reason: 'first-install' });
	});

	it('shows once after an update (version changed)', () => {
		expect(checkFirstRun('0.1.5', '0.1.6')).toEqual({ shouldShow: true, reason: 'version-changed' });
	});

	it('does not show again for the same version', () => {
		expect(checkFirstRun('0.1.6', '0.1.6')).toEqual({ shouldShow: false, reason: 'already-seen' });
	});
});
