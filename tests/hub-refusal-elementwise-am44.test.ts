/**
 * hub-refusal-elementwise-am44.test.ts — AM-44 (2026-09-02, pass 15, Task C
 * item 4): the refusal is elementwise and local; a refused hub is never
 * linked.
 *
 * THE DEFECT THIS PINS (pass-14 CONFIRMED 4). The AM-37 check compared
 * `segs.length !== lv.length` — ARITY, not content — so it could not see (a) a
 * value that differs from its segment while the counts still match (an
 * NFC-decomposed cell, or a degenerate `file`-before-`folder` layout that
 * happens to emit the same number of values as directories, just in the wrong
 * order), and when it DID fire, it marked EVERY folder from the import root's
 * first child down to the row's own leaf — refusing a level-1 hub thousands of
 * clean rows describe perfectly because ONE row disagreed two levels deeper.
 * Worse: the refused hub was still IDENTIFIED and LINKED — `identityOf(f)` ran
 * above the refusal check, and the parent's `childRefs` loop pushed the label
 * with no unaligned check at all, so the surviving hub's managed Contents
 * listed a wikilink to a note the run had just declined to write.
 *
 * THE RULE. The comparison is BYTE-FOR-BYTE AT EACH INDEX (never arity); a
 * disagreement marks only folders at depth >= the first disagreeing index, ON
 * THAT ROW'S OWN CHAIN; a folder ANY row aligned wins over a sibling row's
 * deeper disagreement (`valuesByFolder` beats `unalignedFolders`); and the
 * refusal is consulted BEFORE `identityOf` runs and INSIDE the parent's
 * `childRefs` loop, so a hub the run declines to write is never identified and
 * never linked to.
 */

import { enrich, type EnrichNote } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';

/**
 * AM-66 (2026-09-04). THE WRITE SET THIS FIXTURE MEANS: every note in the batch.
 *
 * No batch below is a kept row - each is a live import writing every note it
 * hands over - so the write set is every path. Stated rather than left to
 * `enrich()` to infer: AM-65 made the fact required because, while it was
 * optional, an omitted write set silently meant "everything is writable", which
 * is true for THIS fixture and false for a kept-row one, so the one default
 * served one caller and quietly broke the other with nothing in the output naming
 * the omission. Assertions are unchanged.
 */
const writable = (...notes: EnrichNote[]): Set<string> => new Set(notes.map((n) => n.path));

const hubCuriesOf = (result: ReturnType<typeof enrich>): string[] =>
	result.levelHubs.notes.map((h) => h.curie).sort();
const hubPathsOf = (result: ReturnType<typeof enrich>): string[] =>
	result.levelHubs.notes.map((h) => h.path).sort();
const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);

// ---------------------------------------------------------------------------
// (a) File-before-folder with EQUAL ARITY still refuses — the shape an
// old arity-only check could not see.
// ---------------------------------------------------------------------------

describe('AM-44(a): equal arity does not excuse a positional disagreement', () => {
	it('a degenerate file-before-folder emission (same length, wrong order) refuses the whole chain', () => {
		// Directory is "X/Y" -> segs = ['X', 'Y']. A layout that recorded the
		// SAME NUMBER of values but in the wrong order (the SUSPECTED-9 shape: a
		// `file` entry's own directory prefix recorded before a `folder` entry
		// that runs after it) produces values = ['Y', 'X'] — length 2, count
		// matches, and an arity-only check would have said "fine" and derived
		// `hg:hub/y/x` for a folder that is actually named `X/Y`.
		const notes: EnrichNote[] = [{
			path: `${ROOT}/X/Y/A.md`,
			curie: `${ONT}:A`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'y', value: 'Y' }, { level: 'x', value: 'X' }],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });

		// Disagreement is at index 0 (values[0]="Y" !== segs[0]="X"), so BOTH "X"
		// and "X/Y" are refused — nothing above the disagreement to save them.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/x`);
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/x/y`);
		// And never the WRONG identity an arity-only check would have derived.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/y/x`);
		expect(result.deviations.length).toBeGreaterThan(0);
		expect(result.deviations.join('\n')).toContain(`${ROOT}/X`);
	});
});

// ---------------------------------------------------------------------------
// (b) The refusal is LOCAL: it starts at the first disagreeing index and marks
// nothing above it.
// ---------------------------------------------------------------------------

describe('AM-44(b): a disagreement at index 2 leaves indices 0-1 aligned', () => {
	it('folders A and A/B keep their hubs; only A/B/C is refused', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/A/B/C/D.md`,
			curie: `${ONT}:D`,
			frontmatter: {},
			facets: [],
			layoutValues: [
				{ level: 'a', value: 'A' },
				{ level: 'b', value: 'B' },
				{ level: 'c', value: 'WRONG' }, // segs[2] is actually "C"
			],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });

		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/a`);
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/a/b`);
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/a/b/c`);
		expect(result.deviations).toHaveLength(1);
		expect(result.deviations[0]).toContain(`${ROOT}/A/B/C`);
		expect(result.deviations[0]).not.toContain(`${ROOT}/A/B"`);
	});
});

// ---------------------------------------------------------------------------
// (c) A folder any row aligned is never refused for a sibling's deeper
// disagreement.
// ---------------------------------------------------------------------------

describe('AM-44(c): a sibling row\'s deeper disagreement does not refuse a folder another row aligned', () => {
	it('folder A/B/C keeps its hub because ONE row fully aligned it, though a sibling disagrees underneath', () => {
		const aligned: EnrichNote = {
			path: `${ROOT}/A/B/C/Aligned.md`,
			curie: `${ONT}:aligned`,
			frontmatter: {},
			facets: [],
			layoutValues: [
				{ level: 'a', value: 'A' },
				{ level: 'b', value: 'B' },
				{ level: 'c', value: 'C' },
			],
		};
		const disagreeing: EnrichNote = {
			path: `${ROOT}/A/B/C/Disagreeing.md`,
			curie: `${ONT}:disagreeing`,
			frontmatter: {},
			facets: [],
			layoutValues: [
				{ level: 'a', value: 'A' },
				{ level: 'b', value: 'B' },
				{ level: 'c', value: 'NOT-C' }, // this row's OWN chain disagrees at index 2
			],
		};
		const result = enrich([aligned, disagreeing], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(aligned, disagreeing) });

		// The folder survives: something (the aligned row) genuinely described it.
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/a/b/c`);
		// Exactly one hub note for it — not refused-then-recreated, not doubled.
		expect(result.levelHubs.notes.filter((h) => h.curie === `${ONT}:hub/a/b/c`)).toHaveLength(1);
		// And since the folder was NOT refused, no deviation names it.
		expect(result.deviations.join('\n')).not.toContain(`${ROOT}/A/B/C"`);
	});

	it('holds regardless of which row the iteration (sorted by curie) reaches first', () => {
		// Same fixture, curies reversed so the DISAGREEING row sorts first. The
		// winning rule (`valuesByFolder` wins over `unalignedFolders`) does not
		// depend on write order: the disagreeing row never reaches the
		// `valuesByFolder.set` line for the folder it disagrees at, so the
		// aligned row's entry is the only one that can ever land there.
		const aligned: EnrichNote = {
			path: `${ROOT}/A/B/C/ZAligned.md`,
			curie: `${ONT}:z-aligned`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'a', value: 'A' }, { level: 'b', value: 'B' }, { level: 'c', value: 'C' }],
		};
		const disagreeing: EnrichNote = {
			path: `${ROOT}/A/B/C/ADisagreeing.md`,
			curie: `${ONT}:a-disagreeing`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'a', value: 'A' }, { level: 'b', value: 'B' }, { level: 'c', value: 'NOT-C' }],
		};
		const result = enrich([aligned, disagreeing], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(aligned, disagreeing) });
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/a/b/c`);
	});
});

// ---------------------------------------------------------------------------
// (d) A refused hub is absent from the parent's Contents, and never
// identified.
// ---------------------------------------------------------------------------

describe('AM-44(d): a refused hub is absent from the parent\'s Contents and never identified', () => {
	it('the ROOT hub links the aligned sibling and never links the refused one', () => {
		const notes: EnrichNote[] = [
			// "X" disagrees at index 0 -> refused.
			{
				path: `${ROOT}/X/A.md`,
				curie: `${ONT}:a`,
				frontmatter: {},
				facets: [],
				layoutValues: [{ level: 'group', value: 'WRONG' }],
			},
			// "Y" is aligned -> gets its hub, and its label appears in the root's
			// Contents.
			{
				path: `${ROOT}/Y/B.md`,
				curie: `${ONT}:b`,
				frontmatter: {},
				facets: [],
				layoutValues: [{ level: 'group', value: 'Y' }],
			},
		];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });

		// X was never identified: no hub note anywhere carries its identity or
		// sits at its would-be path.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/x`);
		expect(hubPathsOf(result)).not.toContain(`${ROOT}/X/X.md`);
		// Y was identified normally.
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/y`);

		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root).toBeDefined();
		// The parent's managed Contents links Y...
		expect(root!.childrenLinks).toContain('[[Y]]');
		// ...and NEVER links X — a link a run declined to write is not a link the
		// parent may point at, whether to nothing or to an unrelated note sharing
		// the basename.
		expect(root!.childrenLinks).not.toContain('[[X]]');
		expect(root!.body).not.toContain('[[X]]');
	});
});
