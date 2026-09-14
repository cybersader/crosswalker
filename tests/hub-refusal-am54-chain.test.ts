/**
 * hub-refusal-am54-chain.test.ts -- AM-54 (2026-09-04, pass 18, Task C item 1):
 * a kept note is held by its WHOLE CHAIN, not by the one folder it sits in.
 *
 * THE DEFECT THIS PINS (pass-17 CONFIRMED 1 / Ground 1). AM-52's `keptFolders`
 * marked only `dirOf(e.path)` -- the folder a kept row is literally IN -- while
 * `folders` (the set every folder gets tested against) walks every ANCESTOR of
 * every note's final path. On any layout deeper than one level, the direct
 * holder was exempt and every folder above it fell straight back into AM-50's
 * "no chain describes this folder" refusal, dropping its hub's curie out of
 * `producedCuries` and reporting it as an orphan on an ordinary Skip-existing
 * refresh -- A-8's own "zero new orphans" clause, failing on a two-level
 * shipped recipe with no exotic input.
 *
 * THE RULE. `keptFolders` is populated by CLIMBING from the kept row's holder
 * up through every in-scope ancestor this pass tracks, stopping BELOW the
 * import root (which is exempt on its own terms and must never be described as
 * kept). A folder any row's OWN chain describes is never treated as kept --
 * `valuesByFolder` outranks `keptFolders` in `refusalFor`'s precedence, so a
 * live chain always wins over a recorded one.
 */

import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';

/**
 * AM-65 (2026-09-04). THE WRITE SET, STATED. `enrich()` no longer infers which
 * half of a batch it may act on from `renderedPath` vs `path`; the caller says so,
 * and omitting it is a refusal by name rather than "everything is writable".
 *
 * The kept row is EXCLUDED and the live row is INCLUDED, which is what each
 * fixture already meant. The assertions are unchanged - this is the test supplying
 * a fact it previously left the engine to guess.
 */
const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();

const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);
const deviationFor = (result: ReturnType<typeof enrich>, folder: string) =>
	result.deviations.find((d) => d.includes(`"${folder}"`));

describe('AM-54: a kept note three folders deep exempts all three ancestors, not just the one it sits in', () => {
	it('A, A/B, and A/B/C are all exempt and written from their OWN recorded identity, none from the address', () => {
		// One row: kept exactly where it is (Skip existing never moves it) at
		// Frameworks/A/B/C/Item.md, but this source release renders it under a
		// completely different top-level category ("Other") -- the shape
		// generation-engine.ts's keptRecords.push produces.
		const notes: EnrichNote[] = [{
			path: `${ROOT}/A/B/C/Item.md`,
			renderedPath: `${ROOT}/Other/B/C/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [
				{ level: 'l1', value: 'Other' },
				{ level: 'l2', value: 'B' },
				{ level: 'l3', value: 'C' },
			],
		}];
		// The vault's own record at each of the three OLD folders -- deliberately
		// NOT matching the plain path segment, so a curie derived from the path
		// instead of the record would read differently and the test would catch it.
		//
		// AM-61 (2026-09-04), recorded by AM-67 (2026-09-04). THE RECORDED FORM IS
		// THE CORRECT ONE. Each entry's `curie` and its `values` deliberately
		// disagree (`hg:hub/stale-a` against a chain that would DERIVE to
		// `hg:hub/reca`), and AM-61 settled which of the two a kept folder keeps: the
		// string the note on disk carries, read, never the string this run's
		// derivation would mint from that note's values. A hub written before a
		// derivation changed records values that describe its folder perfectly and a
		// curie today's rule spells differently, so re-deriving renamed the identity
		// of every hub in an existing vault on a refresh that was otherwise leaving
		// them alone. So the assertions below expect the RECORDED curies; the trap
		// this fixture was built for (an identity taken from the path) is still
		// caught, because a path-derived curie would read `hg:hub/a` and neither the
		// recorded nor the derived form is that.
		//
		// These three assertions were red on the pass-21 tree, and were masked before
		// it by the missing write set: `keptFolders` was empty, so the folder never
		// reached row 1 and fell to AM-50's refusal instead - a different failure.
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[`${ROOT}/A`, { state: 'one', path: `${ROOT}/A/A.md`, curie: `${ONT}:hub/stale-a`, values: [{ level: 'l1', value: 'RecA' }] }],
			[`${ROOT}/A/B`, { state: 'one', path: `${ROOT}/A/B/B.md`, curie: `${ONT}:hub/stale-ab`, values: [{ level: 'l1', value: 'RecA' }, { level: 'l2', value: 'RecB' }] }],
			[`${ROOT}/A/B/C`, { state: 'one', path: `${ROOT}/A/B/C/C.md`, curie: `${ONT}:hub/stale-abc`, values: [{ level: 'l1', value: 'RecA' }, { level: 'l2', value: 'RecB' }, { level: 'l3', value: 'RecC' }] }],
		]);
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		// No refusal anywhere on the chain.
		expect(deviationFor(result, `${ROOT}/A`)).toBeUndefined();
		expect(deviationFor(result, `${ROOT}/A/B`)).toBeUndefined();
		expect(deviationFor(result, `${ROOT}/A/B/C`)).toBeUndefined();

		// Each hub is written, and its identity is the curie the note on disk RECORDS
		// (AM-61 / AM-67, see the fixture comment above), never a re-derivation from
		// the recorded values and never one from the folder's own path segment.
		const a = hubByPath(result, `${ROOT}/A/A.md`);
		const ab = hubByPath(result, `${ROOT}/A/B/B.md`);
		const abc = hubByPath(result, `${ROOT}/A/B/C/C.md`);
		expect(a).toBeDefined();
		expect(ab).toBeDefined();
		expect(abc).toBeDefined();
		expect(a!.curie).toBe(`${ONT}:hub/stale-a`);
		expect(ab!.curie).toBe(`${ONT}:hub/stale-ab`);
		expect(abc!.curie).toBe(`${ONT}:hub/stale-abc`);
		expect(a!.frontmatter.hub_values).toEqual(['RecA']);
		expect(ab!.frontmatter.hub_values).toEqual(['RecA', 'RecB']);
		expect(abc!.frontmatter.hub_values).toEqual(['RecA', 'RecB', 'RecC']);

		// Still linked into the parent chain, exactly as an ordinary hub would be.
		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root!.childrenLinks).toContain('[[A]]');
	});
});

describe('AM-54: a folder described by a LIVE chain is never treated as kept, even when a kept note sits beneath it', () => {
	it('the ancestor both a kept row AND a live row reach takes the LIVE identity, not the recorded one', () => {
		// Row 1 is kept in place three levels under Frameworks/A -- Frameworks/A
		// is on ITS ancestor-walk and would be a keptFolders candidate.
		const kept: EnrichNote = {
			path: `${ROOT}/A/B/C/Item.md`,
			renderedPath: `${ROOT}/Other/B/C/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [
				{ level: 'l1', value: 'Other' },
				{ level: 'l2', value: 'B' },
				{ level: 'l3', value: 'C' },
			],
		};
		// Row 2 is an ORDINARY row this run rendered normally, whose own chain
		// genuinely describes Frameworks/A.
		const live: EnrichNote = {
			path: `${ROOT}/A/Sibling.md`,
			curie: `${ONT}:sibling`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'l1', value: 'A' }],
		};
		// A malicious/stale recorded entry for Frameworks/A: if the live chain did
		// NOT outrank it, this would be the identity written.
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[`${ROOT}/A`, { state: 'one', path: `${ROOT}/A/A.md`, curie: `${ONT}:hub/stale-a`, values: [{ level: 'l1', value: 'WrongRecordedValue' }] }],
		]);
		const result = enrich([kept, live], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: new Set([live.path]) });

		// Never refused (it's described), and never carrying the kept-cause text.
		expect(deviationFor(result, `${ROOT}/A`)).toBeUndefined();

		const a = hubByPath(result, `${ROOT}/A/A.md`);
		expect(a).toBeDefined();
		// Derived from the LIVE chain (value "A"), never from the stale recorded
		// chain ("WrongRecordedValue").
		expect(a!.curie).toBe(`${ONT}:hub/a`);
		expect(a!.frontmatter.hub_values).toEqual(['A']);
	});
});

describe('AM-54: the import root is never added to keptFolders, even when everything beneath it is kept', () => {
	it('a kept row directly under the root leaves the root on its own reserved identity, ignoring a bogus recorded entry for it', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/A/Item.md`,
			renderedPath: `${ROOT}/Other/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'l1', value: 'Other' }],
		}];
		// A bogus recorded entry planted AT THE ROOT ITSELF. If the chain walk
		// ever added the root to keptFolders, this entry would be read and the
		// root's identity would be hijacked by it.
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[ROOT, { state: 'one', path: `${ROOT}/${ROOT}.md`, curie: `${ONT}:hub/should-never-be-used`, values: [{ level: 'bogus', value: 'ShouldNotAppear' }] }],
		]);
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root).toBeDefined();
		// The reserved root identity, never the bogus recorded one.
		expect(root!.curie).toBe(`${ONT}:hub/_root`);
		expect(root!.frontmatter.hub_values).toBeUndefined();
	});
});
