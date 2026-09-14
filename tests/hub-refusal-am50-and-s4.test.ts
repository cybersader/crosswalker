/**
 * hub-refusal-am50-and-s4.test.ts -- AM-50 and S4 (2026-09-04, pass 16, Task C
 * items 3 and 4): refuse when you have nothing to say, and the hosting
 * exemption applies only when the hosting row's own chain reached the folder.
 *
 * THE DEFECT AM-50 PINS (pass-15 Ground 4 / CONFIRMED 3). `hubCurieOf` ended
 * with `?? pathHubCurieOf(f)`, and that fallback was reached not only by "this
 * caller hands over no values at all" (its documented justification) but also
 * by "this run collected values, and NONE of them describe this folder" -- the
 * state a hand-moved generated note produces: found by curie at its new
 * address on refresh, its new folder joins `folders` from the note's FINAL
 * path, no rendered chain ever described it, nothing disagreed with it
 * either, so it was refused by neither `valuesByFolder` nor
 * `unalignedFolders` -- and the address route derived its identity anyway,
 * with no refusal, no deviation, no warning. AM-50 closes it: `hubCurieOf`
 * returns null (never a path-derived curie) for any such folder once this run
 * has collected values at all, `refusalFor` gains the third state, and the
 * `_root` hub -- whose identity is the SET's own, not a row's -- is the one
 * folder exempted by name.
 *
 * THE DEFECT S4 PINS. The pre-existing hosting exemption
 * (`byBasename.has(basename(f))`) is whole-batch and basename-keyed: ANY note
 * anywhere in the import sharing the folder's last segment answered "this
 * folder is hosted," which let an unrelated row's basename bypass a genuine
 * disagreement. S4 replaces it with `hostByFolder`, keyed by folder and
 * decided by PLACEMENT -- the note inside the folder, or beside it -- so only
 * a note the run actually put at that folder can exempt it.
 */

import { enrich, type EnrichNote } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';

/**
 * AM-65 (2026-09-04). THE WRITE SET, STATED. `enrich()` no longer infers which
 * half of a batch it may act on from `renderedPath` vs `path`; the caller says so,
 * and omitting it is a refusal by name rather than "everything is writable".
 *
 * Every fixture below therefore declares the same fact it always meant: a kept
 * note is EXCLUDED (an empty set, when the batch is one kept row), every live note
 * is INCLUDED. The assertions are unchanged - this is the test supplying a fact it
 * previously left the engine to guess.
 */
const writable = (...notes: EnrichNote[]): Set<string> => new Set(notes.map((n) => n.path));
/** A batch of one KEPT row: nothing in it is writable. */
const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();

const hubCuriesOf = (result: ReturnType<typeof enrich>): string[] =>
	result.levelHubs.notes.map((h) => h.curie).sort();
const hubPathsOf = (result: ReturnType<typeof enrich>): string[] =>
	result.levelHubs.notes.map((h) => h.path).sort();
const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);

// ---------------------------------------------------------------------------
// AM-50: a folder present on disk that no chain described is refused BY NAME,
// absent from the parent's Contents, and never gets a path curie. `_root`
// still identifies.
// ---------------------------------------------------------------------------

describe('AM-50: a folder no row of this run describes is refused, never named from its address', () => {
	it('a note relocated away from its rendered address leaves an orphan ancestor folder that gets refused, not path-identified', () => {
		// This is the exact shape the record names: render() would have put this
		// note under Frameworks/X (and DID record layout values describing X), but
		// it was found by curie at Frameworks/Elsewhere on this refresh -- a
		// user-moved note. Frameworks/Elsewhere becomes an ancestor of the note's
		// FINAL path with no row's values ever describing it.
		//
		// AM-52 (2026-09-04) HANDOFF. `path !== renderedPath` (differing directory)
		// is exactly `enrich()`'s ONLY evidence for "a row this run kept in place",
		// because in the real engine that shape has exactly one producer: a
		// skip-mode kept row (generation-engine.ts's `keptRecords.push`). A
		// replace-mode move always renames FIRST, so `path` and `renderedPath`
		// agree by the time a record reaches `enrich()`. So this fixture -- built
		// to simulate "a user dragged the file by hand" -- is INDISTINGUISHABLE,
		// from inside `enrich()`, from a genuine skip-mode kept row, and AM-52's
		// fourth refusal state (asked BEFORE this one) now claims it: with no
		// `ownedHubsByFolder` entry for Frameworks/Elsewhere (none supplied here),
		// the folder is refused with the KEPT cause (AM-55 row 3), never the MOVED
		// cause below -- see hub-refusal-am52-kept-not-moved.test.ts for the
		// exempt/refused pair this state now owns, and
		// hub-refusal-am54-chain.test.ts for AM-54's fix to the OTHER pass-17
		// finding this exact fixture shape used to demonstrate (an ancestor two
		// levels up now DOES get walked and marked, where it used to fall through
		// to the MOVED cause).
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Elsewhere/A.md`,
			renderedPath: `${ROOT}/X/A.md`,
			curie: `${ONT}:a`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'x', value: 'X' }],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE });

		// Refused by name, not silently identified from its path.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/elsewhere`);
		expect(hubPathsOf(result)).not.toContain(`${ROOT}/Elsewhere/Elsewhere.md`);
		expect(result.deviations.length).toBeGreaterThan(0);
		const deviation = result.deviations.find((d) => d.includes(`${ROOT}/Elsewhere`));
		expect(deviation).toBeDefined();
		// AM-52/AM-55: the KEPT cause (row 3 -- no index note recorded at all), since
		// no ownedHubsByFolder entry was supplied for this folder and its shape is a
		// kept-row shape. Never the MOVED wording.
		expect(deviation).toContain('kept in place by Skip existing');
		expect(deviation).toContain('Re-run with Replace to create it');
		expect(deviation).not.toContain('the note may');
		expect(deviation).not.toContain('have been moved');

		// Absent from the parent's (root's) Contents -- never linked to.
		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root).toBeDefined();
		expect(root!.childrenLinks ?? []).not.toContain('[[Elsewhere]]');
		expect(root!.body).not.toContain('[[Elsewhere]]');

		// The root hub itself -- whose identity is the SET's own, not any row's
		// -- still identifies normally, via its reserved local part.
		expect(root!.curie).toBe(`${ONT}:hub/_root`);
	});

	it('a caller that collects no values at all keeps the documented path-derived fallback (the golden-vault-harness carve-out)', () => {
		// AM-50's OTHER named carve-out: "this caller hands over no values" is a
		// fact about the caller, not a disagreement, and the fallback exists for
		// exactly it. No `layoutValues` field anywhere in this batch.
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Group/A.md`,
			curie: `${ONT}:a`,
			frontmatter: {},
			facets: [],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });

		expect(result.deviations).toEqual([]);
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/group`);
	});

	it('a folder some row genuinely aligned is written normally -- AM-50 only closes the address route for folders nothing describes', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Group/A.md`,
			curie: `${ONT}:a`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'group', value: 'Group' }],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });

		expect(result.deviations).toEqual([]);
		expect(hubCuriesOf(result)).toContain(`${ONT}:hub/group`);
		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root!.childrenLinks).toContain('[[Group]]');
	});
});

// ---------------------------------------------------------------------------
// S4: the hosting exemption applies only when the hosting row's own chain
// reached the folder -- an unrelated row's basename no longer exempts a real
// disagreement.
// ---------------------------------------------------------------------------

describe('S4: an unrelated row\'s basename no longer exempts a real disagreement', () => {
	it('a far-away note sharing the refused folder\'s basename does not save it from refusal', () => {
		// "Group" disagrees at index 0 (values say "WRONG", the directory is
		// "Group") -- a genuine, row-caused disagreement.
		const disagreeing: EnrichNote = {
			path: `${ROOT}/Group/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'group', value: 'WRONG' }],
		};
		// An UNRELATED note elsewhere in the batch whose basename happens to equal
		// the folder's own basename ("Group") -- but it is neither INSIDE
		// Frameworks/Group nor BESIDE it (it sits under a different folder
		// entirely), so it hosts nothing.
		const unrelated: EnrichNote = {
			path: `${ROOT}/Somewhere/Deep/Group.md`,
			curie: `${ONT}:unrelated-group`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'deep', value: 'Somewhere' }, { level: 'x', value: 'Deep' }],
		};
		const result = enrich([disagreeing, unrelated], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(disagreeing, unrelated) });

		// Pre-S4, `byBasename.get('Group')` would have found `unrelated` (the only
		// note with that basename) and exempted Frameworks/Group from refusal
		// though nothing about `unrelated`'s placement describes that folder.
		expect(hubCuriesOf(result)).not.toContain(`${ONT}:hub/group`);
		const deviation = result.deviations.find((d) => d.includes(`${ROOT}/Group`));
		expect(deviation).toBeDefined();
	});

	it('control: a note actually PLACED at the folder (the folder-note form) still exempts it, unrelated to basename alone', () => {
		// The legitimate exemption S4 preserves: a note inside the folder itself
		// (Frameworks/Group/Group.md) genuinely hosts it, so no path is read and no
		// Contents entry is lost by exempting it.
		const disagreeing: EnrichNote = {
			path: `${ROOT}/Group/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'group', value: 'WRONG' }],
		};
		const host: EnrichNote = {
			path: `${ROOT}/Group/Group.md`,
			curie: `${ONT}:group-host`,
			frontmatter: {},
			facets: [],
		};
		const result = enrich([disagreeing, host], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(disagreeing, host) });

		// Exempted: the folder is hosted, so it is not refused, and its identity
		// is the host note's own curie (never a synthesized `hub/group`).
		expect(result.deviations.find((d) => d.includes(`${ROOT}/Group"`))).toBeUndefined();
		expect(result.levelHubs.hostedChildrenByPath.has(`${ROOT}/Group/Group.md`)).toBe(true);
	});

	it('control: a note placed BESIDE the folder (the sibling / production form) still exempts it', () => {
		const disagreeing: EnrichNote = {
			path: `${ROOT}/Group/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'group', value: 'WRONG' }],
		};
		// Sibling form: the host note sits in the PARENT of Frameworks/Group,
		// with the folder's own basename.
		const host: EnrichNote = {
			path: `${ROOT}/Group.md`,
			curie: `${ONT}:group-host`,
			frontmatter: {},
			facets: [],
		};
		const result = enrich([disagreeing, host], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(disagreeing, host) });

		expect(result.deviations.find((d) => d.includes(`${ROOT}/Group"`))).toBeUndefined();
		expect(result.levelHubs.hostedChildrenByPath.has(`${ROOT}/Group.md`)).toBe(true);
	});
});
