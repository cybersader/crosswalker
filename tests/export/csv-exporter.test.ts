/**
 * csv-exporter.test.ts — v0.1.7 exporters: concept notes -> plain CSV.
 *
 * Coverage: deterministic column order + row order, correct escaping of
 * commas/quotes/embedded newlines (round-tripped through Papa.parse to
 * prove the exported cell recovers byte-identically, not just "looks
 * right"), array-field joining, and the vault-scoped `exportFolderAsCsv`
 * entry point (which must skip crosswalk-edge/hub/junction-note kinds).
 */

import Papa from 'papaparse';
import { conceptsToCsv, exportFolderAsCsv } from '../../src/export/csv-exporter';
import { readVaultTree, type ConceptRow } from '../../src/export/vault-reader';
import { buildNoteContent } from '../../src/generation/generation-engine';
import { makeMockApp } from './helpers';

function concept(overrides: Partial<ConceptRow> & { curie: string }): ConceptRow {
	return {
		kind: 'concept',
		path: `Notes/${overrides.curie.replace(/[:.]/g, '-')}.md`,
		title: undefined,
		aliases: [],
		tags: [],
		parent: undefined,
		children: [],
		frontmatter: {},
		...overrides,
	};
}

describe('conceptsToCsv — determinism + shape', () => {
	it('fixed leading columns appear in order regardless of input row order or which row introduces an extra key', () => {
		const rows: ConceptRow[] = [
			concept({ curie: 'nist:AC-3', path: 'B.md', frontmatter: { control_family: 'Access Control' } }),
			concept({ curie: 'nist:AC-1', path: 'A.md', title: 'Policy', frontmatter: { baseline: 'low' } }),
		];
		const result = conceptsToCsv(rows);
		expect(result.columns.slice(0, 6)).toEqual(['curie', 'title', 'parent', 'children', 'aliases', 'tags']);
		// extra keys sorted alphabetically after the leading columns
		expect(result.columns.slice(6)).toEqual(['baseline', 'control_family']);

		const parsed = Papa.parse<Record<string, string>>(result.csv, { header: true, skipEmptyLines: true });
		// row order follows PATH sort (A.md before B.md), not input array order
		expect(parsed.data.map((r) => r.curie)).toEqual(['nist:AC-1', 'nist:AC-3']);
		expect(parsed.data[1].control_family).toBe('Access Control');
		expect(parsed.data[0].baseline).toBe('low');
		expect(parsed.data[0].control_family).toBe(''); // missing cell -> empty, not undefined/dropped
	});

	it('produces byte-identical output for the same rows regardless of array insertion order', () => {
		const a = concept({ curie: 'nist:AC-1', path: 'A.md' });
		const b = concept({ curie: 'nist:AC-2', path: 'B.md' });
		expect(conceptsToCsv([a, b]).csv).toBe(conceptsToCsv([b, a]).csv);
	});

	it('joins array fields (aliases/tags/children/parent-as-array) with `|`', () => {
		const row = concept({
			curie: 'nist:AC-2',
			aliases: ['Account Mgmt', 'AC-2'],
			tags: ['framework/nist/ac-2', 'family/ac'],
			children: ['[[AC-2(1)]]', '[[AC-2(2)]]'],
			parent: ['[[AC]]', '[[Access-Control-Family]]'],
		});
		const result = conceptsToCsv([row]);
		const parsed = Papa.parse<Record<string, string>>(result.csv, { header: true, skipEmptyLines: true });
		expect(parsed.data[0].aliases).toBe('Account Mgmt|AC-2');
		expect(parsed.data[0].tags).toBe('framework/nist/ac-2|family/ac');
		expect(parsed.data[0].children).toBe('[[AC-2(1)]]|[[AC-2(2)]]');
		expect(parsed.data[0].parent).toBe('[[AC]]|[[Access-Control-Family]]');
	});
});

describe('conceptsToCsv — escaping (round-tripped through Papa.parse)', () => {
	it.each([
		['a description, with a comma', 'a description, with a comma'],
		['a "quoted" phrase', 'a "quoted" phrase'],
		['line one\nline two', 'line one\nline two'],
		['comma, "quote", and\nnewline all at once', 'comma, "quote", and\nnewline all at once'],
	])('recovers %j exactly after export + re-parse', (input, expected) => {
		const row = concept({ curie: 'nist:AC-2', frontmatter: { description: input } });
		const result = conceptsToCsv([row]);
		const parsed = Papa.parse<Record<string, string>>(result.csv, { header: true, skipEmptyLines: true });
		expect(parsed.data[0].description).toBe(expected);
	});
});

describe('exportFolderAsCsv — vault-scoped entry point', () => {
	it('exports only concept notes under the given folder, skipping other kinds', async () => {
		const { app, written } = makeMockApp();
		written.set(
			'Frameworks/AC-2.md',
			buildNoteContent({ curie: 'nist:AC-2', title: 'Account Management', control_family: 'Access Control' }, '# body'),
		);
		written.set(
			'Frameworks/AC-3.md',
			buildNoteContent({ curie: 'nist:AC-3', title: 'Access Enforcement' }, '# body'),
		);
		written.set(
			'_crosswalker/mappings/cw-1.md',
			buildNoteContent({ curie: 'xwalk:1', kind: 'crosswalk-edge', subject_id: 'nist:AC-2', predicate_id: 'is_equivalent_to', object_id: 'iso:A.1' }, ''),
		);

		const result = await exportFolderAsCsv(app, 'Frameworks');
		expect(result.rowCount).toBe(2);
		const parsed = Papa.parse<Record<string, string>>(result.csv, { header: true, skipEmptyLines: true });
		expect(parsed.data.map((r) => r.curie).sort()).toEqual(['nist:AC-2', 'nist:AC-3']);
	});

	it('counts mapping notes so a folder of mappings can name the right export', async () => {
		const { app, written } = makeMockApp();
		written.set(
			'_crosswalker/mappings/cw-1.md',
			buildNoteContent({ curie: 'xwalk:1', kind: 'crosswalk-edge', subject_id: 'nist:AC-2', predicate_id: 'is_equivalent_to', object_id: 'iso:A.1' }, ''),
		);

		const result = await exportFolderAsCsv(app, '_crosswalker/mappings');
		expect(result.rowCount).toBe(0);
		expect(result.mappingCount).toBe(1);
	});

	it('surfaces skipped notes from vault-reader without failing the export', async () => {
		const { app, written } = makeMockApp();
		written.set('Frameworks/no-frontmatter.md', '# no frontmatter here\n');
		written.set('Frameworks/AC-2.md', buildNoteContent({ curie: 'nist:AC-2' }, '# body'));

		const result = await exportFolderAsCsv(app, 'Frameworks');
		expect(result.rowCount).toBe(1);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].path).toBe('Frameworks/no-frontmatter.md');
	});
});

describe('conceptsToCsv + readVaultTree — sanity check that vault-reader rows feed the exporter cleanly', () => {
	it('round-trips a hand-crafted vault through readVaultTree -> conceptsToCsv', async () => {
		const { app, written } = makeMockApp();
		written.set('X/one.md', buildNoteContent({ curie: 'x:one', title: 'One' }, '# One'));
		written.set('X/two.md', buildNoteContent({ curie: 'x:two', title: 'Two', aliases: ['2', 'Two'] }, '# Two'));

		const tree = await readVaultTree(app, 'X');
		const result = conceptsToCsv(tree.concepts);
		const parsed = Papa.parse<Record<string, string>>(result.csv, { header: true, skipEmptyLines: true });
		expect(parsed.data).toHaveLength(2);
		expect(parsed.data.find((r) => r.curie === 'x:two')?.aliases).toBe('2|Two');
	});
});
