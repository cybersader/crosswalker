/**
 * hub-refusal-am52-kept-not-moved.test.ts -- AM-52 (2026-09-04, pass 17, Task C
 * item 2): a kept note is not a moved note.
 *
 * THE DEFECT THIS PINS (pass-16 Ground 2 / CONFIRMED 2). A source release that
 * recategorises a row (a control moves from one section to another) imported
 * with Skip existing leaves the note exactly where it is and renders it
 * somewhere else -- the ONE shape `enrich()` sees that also matches the
 * relocated-note shape AM-50 refuses. Before AM-52, that folder was refused
 * with the MOVED cause ("the note may have been moved... move it back"), its
 * hub stopped being written, dropped out of the parent's Contents, and the
 * orphan pass reported the still-occupied folder's index note as vanished --
 * A-8's "zero new orphans, skip included" clause failing on an ORDINARY
 * refresh, over a cause the user did not create and cannot act on.
 *
 * THE RULE. `enrich()` receives, per record, both the FINAL path and the
 * RENDERED path (it already does). A folder holding one of THIS RUN'S OWN kept
 * records (`dirOf(path) !== dirOf(renderedPath)`, positive evidence only) is a
 * fourth state: its hub keeps the RECORDED identity the caller reads off the
 * existing hub note's own `hub_values` -- never re-derived from the path -- and
 * is written and listed in Contents exactly as before. With no recorded
 * identity (a hub that never existed, or a half-record), the folder is refused
 * with the KEPT cause instead, naming what was actually observed ("this folder
 * holds notes the refresh kept in place because Skip existing was chosen") --
 * never the MOVED cause, which nobody's actions produced.
 *
 * `dirOf(path) !== dirOf(renderedPath)` has exactly one real producer
 * (generation-engine.ts's `keptRecords.push`, both call sites): a skip-mode
 * kept row. A replace-mode move renames FIRST, so `path` and `renderedPath`
 * agree by the time a record reaches `enrich()` -- see the updated comment on
 * hub-refusal-am50-and-s4.test.ts's "a note relocated away..." case, which now
 * demonstrates AM-52's no-recorded-identity branch rather than AM-50's.
 *
 * AM-55 UPDATE (2026-09-04, pass 18). `recordedHubValues` (folder -> a bare
 * values chain) is now `ownedHubsByFolder` (folder -> the tri-state
 * `OwnedHubAtFolder`: `{ state: 'one', path, curie, values? }` or
 * `{ state: 'many', paths }`), because the old shape collapsed "no index note
 * here", "one here that records nothing usable", and "one here nobody could
 * read" into a single absent map entry -- see hub-refusal-am55-tri-state.test.ts
 * for the full three-row table this test's second describe block now defers
 * to. The kept-cause text also changed: the old single sentence ("...keep them
 * and their index note stays as it was") is gone, replaced by AM-55's two texts
 * (present-but-unusable vs. absent), each naming the consequence the run
 * actually delivers.
 *
 * AM-54 UPDATE (2026-09-04, pass 18). The THIRD describe block below used to
 * pin CONFIRMED 1 (pass-17's own defect) as accepted behaviour: an ancestor two
 * levels above a kept folder took the MOVED cause because `keptFolders` marked
 * only the direct holder. AM-54 fixed that -- the ancestor is now walked too --
 * so this block now pins the FIX: the ancestor is exempt via its own recorded
 * identity, same as the direct holder. See hub-refusal-am54-chain.test.ts for
 * the dedicated coverage (three folders deep, live-chain precedence, and the
 * import root).
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
 * Every batch below is a single row this run KEPT, so nothing in it is writable.
 * The assertions are unchanged - this is the test supplying a fact it previously
 * left the engine to guess.
 */
const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();

const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);

describe('AM-52: a folder holding a row this run KEPT, with a RECORDED identity, is exempt and written as before', () => {
	it('exempt from refusal, keeps its recorded curie, carries hub_levels/hub_values forward, and is still listed in the parent Contents', () => {
		// T1 stays at Frameworks/Persistence/T1.md (skip mode never moves it) but
		// this source release recategorises it to IA.
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Persistence/T1.md`,
			renderedPath: `${ROOT}/IA/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'IA' }],
		}];
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[`${ROOT}/Persistence`, { state: 'one', path: `${ROOT}/Persistence/Persistence.md`, curie: `${ONT}:hub/persistence`, values: [{ level: 'tactic', value: 'Persistence' }] }],
		]);
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		// No refusal at all for Persistence -- the recorded identity answers it.
		expect(result.deviations).toEqual([]);

		const persistence = hubByPath(result, `${ROOT}/Persistence/Persistence.md`);
		expect(persistence).toBeDefined();
		// The SAME curie the existing hub note already carries -- found, not
		// re-minted, and never derived from the current folder chain (which would
		// have been `hub/ia` or nothing at all).
		expect(persistence!.curie).toBe(`${ONT}:hub/persistence`);
		// hub_levels/hub_values round-trip: dropping them would erase the one
		// record of what the folder is about (both are always-managed keys).
		expect(persistence!.frontmatter.hub_levels).toEqual(['tactic']);
		expect(persistence!.frontmatter.hub_values).toEqual(['Persistence']);

		// Still linked from the root's Contents, exactly as before.
		const root = hubByPath(result, `${ROOT}/${ROOT}.md`);
		expect(root!.childrenLinks).toContain('[[Persistence]]');
		expect(root!.body).toContain('[[Persistence]]');
	});
});

describe('AM-52/AM-55: a folder holding a kept row with NO usable recorded identity is refused with the KEPT cause, never the MOVED cause', () => {
	it('no ownedHubsByFolder entry at all (row 3): the deviation names Skip existing, not a moved note', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Persistence/T1.md`,
			renderedPath: `${ROOT}/IA/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'IA' }],
		}];
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE }); // no ownedHubsByFolder at all

		expect(hubByPath(result, `${ROOT}/Persistence/Persistence.md`)).toBeUndefined();
		const deviation = result.deviations.find((d) => d.includes(`${ROOT}/Persistence`));
		expect(deviation).toBeDefined();
		expect(deviation).toContain('kept in place by Skip existing');
		expect(deviation).toContain('Re-run with Replace');
		// Never the address-derived cause this state used to fall through to.
		expect(deviation).not.toContain('the note may');
		expect(deviation).not.toContain('have been moved');
	});

	it('a present hub with no usable chain (row 2: hub_values with no matching hub_levels) is fail-closed to the SAME kept cause, not a guess', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Persistence/T1.md`,
			renderedPath: `${ROOT}/IA/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'IA' }],
		}];
		// The caller (readOwnedHubsByFolder) never hands over a half-record in
		// practice -- it reads hub_levels and hub_values TOGETHER or not at all --
		// but `enrich()` itself must not assume a well-formed map either. A `one`
		// state with no `values` field is the shape "found nothing usable to
		// record" collapses to.
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[`${ROOT}/Persistence`, { state: 'one', path: `${ROOT}/Persistence/Persistence.md`, curie: `${ONT}:hub/persistence` }],
		]);
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		const deviation = result.deviations.find((d) => d.includes(`${ROOT}/Persistence`));
		expect(deviation).toBeDefined();
		expect(deviation).toContain('kept in place by Skip existing');
		// AM-55 row 2's accounting: the note demonstrably exists, so its curie is
		// still marked produced even though it was not written.
		expect(result.levelHubs.keptExistingCuries).toEqual([`${ONT}:hub/persistence`]);
	});
});

describe('AM-54 (2026-09-04, pass 18): AM-52\'s exemption reaches the WHOLE chain, so an ancestor holding no kept record itself is exempt too, via ITS OWN recorded identity', () => {
	it('an ancestor TWO levels above a kept folder, described by no chain and holding no kept record of its own, is exempt because AM-54 walks the chain and the ancestor has ITS OWN recorded identity', () => {
		// A three-level layout: Root/Category/Section/Item.md. This run's one row
		// is kept in place at Root/Cat/Sub/Item.md but renders to
		// Root/OtherCat/Sub/Item.md -- a top-level recategorisation. AM-54 (fixing
		// pass-17's CONFIRMED 1) walks the WHOLE chain from the holder, so
		// Root/Cat/Sub (the direct holder) AND Root/Cat (its ancestor) both join
		// keptFolders -- and since Root/Cat's own index note DOES record a usable
		// chain here, it is exempt and rewritten from it, exactly like the direct
		// holder.
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Cat/Sub/Item.md`,
			renderedPath: `${ROOT}/OtherCat/Sub/Item.md`,
			curie: `${ONT}:item`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'cat', value: 'OtherCat' }, { level: 'sub', value: 'Sub' }],
		}];
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[`${ROOT}/Cat/Sub`, { state: 'one', path: `${ROOT}/Cat/Sub/Sub.md`, curie: `${ONT}:hub/cat-sub`, values: [{ level: 'cat', value: 'Cat' }, { level: 'sub', value: 'Sub' }] }],
			[`${ROOT}/Cat`, { state: 'one', path: `${ROOT}/Cat/Cat.md`, curie: `${ONT}:hub/cat`, values: [{ level: 'cat', value: 'Cat' }] }],
		]);
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		// The DIRECT holder: exempt, via its recorded identity.
		expect(hubByPath(result, `${ROOT}/Cat/Sub/Sub.md`)).toBeDefined();
		expect(result.deviations.find((d) => d.includes(`${ROOT}/Cat/Sub"`))).toBeUndefined();

		// The ANCESTOR: ALSO exempt now (AM-54's fix), via ITS OWN recorded
		// identity -- never the MOVED cause pass 17 shipped this as.
		expect(hubByPath(result, `${ROOT}/Cat/Cat.md`)).toBeDefined();
		expect(result.deviations.find((d) => d.includes(`${ROOT}/Cat"`))).toBeUndefined();
	});
});
