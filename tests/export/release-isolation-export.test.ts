/**
 * release-isolation-export.test.ts — coexisting releases must never be silently
 * merged, and a user must be able to tell them apart before overwriting one
 * (2026-08-21, from the release-isolation review).
 *
 * Release isolation lets two versions of the same framework live side by side.
 * That created two new ways to act on the wrong release without knowing it:
 *
 *   1. Export walked a folder tree and stamped ONE header over rows drawn from
 *      both releases, choosing whichever contributed more rows. The file looked
 *      well-formed and misrepresented its own contents.
 *   2. The refresh picker listed sets by their minted id only. Those ids are
 *      deliberately meaningless — that is what makes identity stable — but a
 *      chooser built from them gives a user nothing to choose ON, and choosing
 *      wrong overwrites a release.
 */

import { crosswalkEdgesToSssomTsv } from '../../src/export/sssom-exporter';
import { describeImportSet } from '../../src/import/sssom-import-modal';
import type { CrosswalkEdgeRow } from '../../src/export/vault-reader';

/** One crosswalk edge owned by `importSetId`, or by no set at all when omitted. */
function edge(path: string, subject: string, importSetId?: string): CrosswalkEdgeRow {
	return {
		path,
		subject_id: subject,
		object_id: 'soc2:CC6.1',
		predicate_id: 'is_equivalent_to',
		mapping_justification: 'semapv:ManualMappingCuration',
		frontmatter: importSetId ? { _crosswalker: { import_set: { id: importSetId } } } : {},
	} as unknown as CrosswalkEdgeRow;
}

describe('SSSOM export refuses to conflate coexisting releases', () => {
	it('throws, naming both releases, when rows span two import sets', () => {
		const rows = [edge('a.md', 'iso:A.5.1', 'iset-aaa111'), edge('b.md', 'iso:A.5.2', 'iset-bbb222')];
		expect(() => crosswalkEdgesToSssomTsv(rows)).toThrow(/iset-aaa111.*iset-bbb222/);
	});

	it('names the releases so the user knows what to scope to, not just that it failed', () => {
		const rows = [edge('a.md', 'iso:A.5.1', 'iset-aaa111'), edge('b.md', 'iso:A.5.2', 'iset-bbb222')];
		// An error that says only "ambiguous" leaves the user with no next action.
		expect(() => crosswalkEdgesToSssomTsv(rows)).toThrow(/import sets:/);
	});

	it('exports normally when every row belongs to one release', () => {
		const rows = [edge('a.md', 'iso:A.5.1', 'iset-aaa111'), edge('b.md', 'iso:A.5.2', 'iset-aaa111')];
		expect(crosswalkEdgesToSssomTsv(rows).rowCount).toBe(2);
	});

	it('still exports notes written before import sets existed', () => {
		// Legacy notes carry no stamp. They are one unlabelled group, not N releases;
		// treating absence as distinctness would break every pre-existing vault.
		const rows = [edge('a.md', 'iso:A.5.1'), edge('b.md', 'iso:A.5.2')];
		expect(crosswalkEdgesToSssomTsv(rows).rowCount).toBe(2);
	});
});

describe('the refresh picker describes a release, not just its id', () => {
	const set = { id: 'iset-aaa111', noteCount: 42, paths: ['Frameworks/NIST-800-53r5/AC-1.md', 'Frameworks/NIST-800-53r5/AC-2.md'], scheme: 'set-qualified-v1' };

	it('keeps the id visible because that is what appears in note frontmatter', () => {
		expect(describeImportSet(set)).toContain('iset-aaa111');
	});

	it('states how many mappings the release holds and where they live', () => {
		const label = describeImportSet(set);
		expect(label).toContain('42 mapping notes');
		expect(label).toContain('Frameworks/NIST-800-53r5');
	});

	it('does not invent a shared folder when the notes have none in common', () => {
		const scattered = { ...set, noteCount: 2, paths: ['A/x.md', 'B/y.md'] };
		expect(describeImportSet(scattered)).not.toMatch(/ in [AB]/);
	});

	it('reads naturally for a single-note release', () => {
		const one = { ...set, noteCount: 1, paths: ['Frameworks/X/AC-1.md'] };
		expect(describeImportSet(one)).toContain('1 mapping note');
		expect(describeImportSet(one)).not.toContain('1 mapping notes');
	});

	it('leaves the release record note out of the mapping count', () => {
		expect(describeImportSet({ ...set, noteCount: 3, setNoteCount: 1 })).toContain('iset-aaa111: 2 mapping notes');
	});
});
