/**
 * d1-pass20-am61-write-set.test.ts -- AM-61 (2026-09-04, pass 20, Task C item
 * 1): the batch enrich() is handed carries THREE populations, named, and only
 * two of them may describe or move anything: the WRITE SET (rows this run
 * writes), the HELD SET (every other note), and the WHOLE POPULATION (used
 * only for counting/listing, never for deciding).
 *
 * THE DEFECT THIS PINS (pass-19 Ground 2 and Ground 4). AM-60 widened
 * `enrich()`'s population so every LIST could see the whole batch, and the
 * same widened batch was then handed to two DECISIONS it should never have
 * reached:
 *
 *   Ground 2 -- a kept row's live layout values (`valuesByFolder`) outranked
 *   its folder's own RECORDED identity, so a legacy hub written under an
 *   older curie derivation was silently re-identified by a row nobody wrote.
 *
 *   Ground 4 -- `computeRelocations` planned a move for a KEPT note (Skip
 *   existing left it exactly where it was), so the run reported "relocated X
 *   back to sibling form (A -> B)" for a file the write gate then correctly
 *   refused to touch. The report and the outcome disagreed.
 *
 * THE RULE. `EnrichOptions.writeSet` (ABSENT = "every note is writable", the
 * bare-harness/unit-caller default) tells three things which half of the
 * batch they may read: `valuesByFolder` (a folder is DESCRIBED only by a row
 * the run WRITES), `computeRelocations` (a relocation is a WRITE), and
 * `keptFolders` (walked over the HELD set alone). `recordedHubCurieOf` reads
 * the identity a kept folder's hub note RECORDS (`observed.curie`) rather
 * than re-deriving it from that note's own recorded values, which is what
 * makes the identity a FACT the note carries rather than an OPINION this
 * run's derivation has about it.
 *
 * ONE ITEM DOES NOT HOLD AS WRITTEN, AND IS NOT COVERED HERE ON PURPOSE.
 * AM-61's gate clause ("the gate returns to `enrichRecords.length > 0` ...
 * `tests/legacy-vault-refresh.test.ts` passes unmodified") is implemented
 * verbatim and, on this tree, that frozen file does NOT pass unmodified:
 *
 *   bun x jest tests/legacy-vault-refresh.test.ts --runInBand
 *   Tests: 8 failed, 291 passed, 299 total   EXIT=1
 *
 * every one of the eight for the same reason -- an all-skip refresh no
 * longer accounts for the hubs its kept rows imply (the `markKeptHubsProduced`
 * job AM-60 folded into `applyEnrichment`, now unreachable when the gate is
 * narrow again), so it reports them as orphans:
 *
 *   `Created 0 notes, skipped 6 existing ... Nothing moved. 3 orphans.`
 *
 * This is the exact scenario Task C item 1(c) asks to cover ("all-skip
 * refresh: zero writes, zero produced_at change"), and it is ALREADY covered,
 * by the frozen file itself, which the task forbids editing and requires to
 * pass. It does not, on this tree, as written. Per the task's own frozen-item
 * instruction ("if unimplementable as written, say so with evidence and stop
 * on that item"), no test is added here that asserts the contradictory
 * behaviour, and the source is not touched to force it green -- the two
 * candidate fixes the implementer identified are both wider than AM-61's own
 * text (facet hubs and hub CREATION are not write-set gated by either one)
 * and are the architect's call, not a test-writer's. Evidence is the jest
 * run above, reproduced verbatim in .workspace/2026-09-04-pass20-tests.md.
 */

import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';
const OLD_FOLDER = `${ROOT}/Persistence`;
const NEW_FOLDER = `${ROOT}/Discovery`;

const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);
const deviationFor = (result: ReturnType<typeof enrich>, folder: string) =>
	result.deviations.find((d) => d.includes(`"${folder}"`));

// ---------------------------------------------------------------------------
// AM-61(a): a legacy hub (pre-AM-38 curie derivation) plus one appended row.
// ---------------------------------------------------------------------------

describe('AM-61(a): legacy vault + one appended row, Skip existing', () => {
	/**
	 * The kept row: T1 sits in Persistence on disk. This run's layout recategorised
	 * it to IA (`renderedPath`), but Skip existing left the note exactly where it
	 * is -- the AM-54 chain-walk shape `keptFolders` looks for (a row whose
	 * RENDERED folder differs from where it currently sits is what marks the OLD
	 * folder "kept", never a row that simply wasn't touched).
	 */
	const keptRow: EnrichNote = {
		path: `${OLD_FOLDER}/T1.md`,
		renderedPath: `${ROOT}/IA/T1.md`,
		curie: `${ONT}:t1`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'IA' }],
	};
	/** The new row: T2 lands in a folder Persistence's hub never covered. */
	const newRow: EnrichNote = {
		path: `${NEW_FOLDER}/T2.md`,
		curie: `${ONT}:t2`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'Discovery' }],
	};

	/**
	 * The vault's own hub note for Persistence, written by a build whose
	 * derivation differed from `hubCurieFromParts` (a hand-edit, or a version
	 * predating AM-38): its recorded VALUES describe Persistence perfectly, but
	 * its recorded CURIE is not what today's derivation would mint from them.
	 * Ground 2's exact shape: an old identity, a current-scheme derivation that
	 * disagrees with it, and nothing this run wrote that could tell them apart
	 * except which one the note itself carries.
	 */
	const LEGACY_CURIE = `${ONT}:hub/persistence-legacy-slug`;
	const ownedHubsByFolder: OwnedHubsByFolder = new Map([
		[OLD_FOLDER, {
			state: 'one',
			path: `${OLD_FOLDER}/Persistence.md`,
			curie: LEGACY_CURIE,
			values: [{ level: 'tactic', value: 'Persistence' }],
		}],
	]);

	function run() {
		return enrich([keptRow, newRow], {
			ontology: ONT,
			config: HUB_CONFIG,
			rootFolder: ROOT,
			ownedHubsByFolder,
			// The write set is the NEW row only -- keptRow is Skip existing.
			writeSet: new Set([newRow.path]),
		});
	}

	it('the kept hub keeps its legacy curie BYTE-FOR-BYTE -- never re-derived from its own recorded values', () => {
		const result = run();
		const hub = hubByPath(result, `${OLD_FOLDER}/Persistence.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(LEGACY_CURIE);
		// The re-derivation this pins against: today's scheme would mint this from
		// the SAME recorded values. If the identity were re-derived instead of
		// read, the hub would carry this string, not the legacy one above.
		expect(hub!.curie).not.toBe(`${ONT}:hub/persistence`);
		expect(deviationFor(result, OLD_FOLDER)).toBeUndefined();
	});

	it("the new row's folder is described and derived normally -- the write set is not starved by the kept row sharing its case", () => {
		const result = run();
		const hub = hubByPath(result, `${NEW_FOLDER}/Discovery.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(`${ONT}:hub/discovery`);
		expect(deviationFor(result, NEW_FOLDER)).toBeUndefined();
	});

	it('the catalog (root hub Contents) lists BOTH folders', () => {
		const result = run();
		const root = result.levelHubs.notes.find((h) => h.path === `${ROOT}/${ROOT}.md`);
		expect(root).toBeDefined();
		expect(root!.childrenLinks).toEqual(expect.arrayContaining(['[[Persistence]]', '[[Discovery]]']));
	});
});

// ---------------------------------------------------------------------------
// AM-61(b): a kept row sitting in folder-note form; this recipe's parent_note
// is the default (sibling). Ground 4 -- no relocation may be PLANNED for a
// note the write gate will not touch.
// ---------------------------------------------------------------------------

describe('AM-61(b): a kept row on disk in folder-note form, recipe default sibling, Skip existing', () => {
	const CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'none' as const, parent_note: 'sibling' as const };
	/**
	 * On disk: `Frameworks/Widgets/Widgets.md` (folder-note shaped -- a prior
	 * `parent_note: 'folder-note'` import, or hand-placed). This run's render()
	 * computed the SIBLING form for it (`renderedPath`), which is the positive
	 * evidence `computeRelocations`'s flip-back needs. Skip existing left the
	 * note exactly where it is.
	 */
	const keptParent: EnrichNote = {
		path: `${ROOT}/Widgets/Widgets.md`,
		renderedPath: `${ROOT}/Widgets.md`,
		curie: `${ONT}:widgets`,
		frontmatter: {},
		facets: [],
	};

	function run(writeSet: Set<string>) {
		return enrich([keptParent], { ontology: ONT, config: CONFIG, rootFolder: ROOT, writeSet });
	}

	it('reports no relocation and no deviation when the row is HELD (not in the write set)', () => {
		const result = run(new Set()); // keptParent excluded -- it is held, not written.
		expect(result.relocations).toEqual([]);
		expect(result.deviations.some((d) => d.includes('relocated'))).toBe(false);
	});

	it('CONTROL: the very same note, if it WERE in the write set, is relocated -- proving the gate above is genuinely write-set-scoped, not a no-op', () => {
		const result = run(new Set([keptParent.path])); // same note, now writable.
		expect(result.relocations).toEqual([
			{ curie: `${ONT}:widgets`, from: `${ROOT}/Widgets/Widgets.md`, to: `${ROOT}/Widgets.md` },
		]);
		expect(result.deviations.some((d) => d.includes('relocated') && d.includes('sibling form'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AM-61(d), structural: valuesByFolder and keptFolders are computed relative
// to the WRITE SET the caller supplies, not fixed by the notes' own shape.
// Same two notes, same layout, the only variable is which set writeSet names.
// ---------------------------------------------------------------------------

describe('AM-61(d) structural: valuesByFolder / keptFolders track the SUPPLIED write set', () => {
	const CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
	/** Anchor row so the batch always has at least one genuinely writable note. */
	const anchor: EnrichNote = {
		path: `${NEW_FOLDER}/T9.md`,
		curie: `${ONT}:t9`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'Discovery' }],
	};
	/** Recategorised: sits in Persistence on disk, but this run's layout renders it to IA. */
	const recategorized: EnrichNote = {
		path: `${OLD_FOLDER}/T1.md`,
		renderedPath: `${ROOT}/IA/T1.md`,
		curie: `${ONT}:t1`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'IA' }],
	};
	const ownedHubsByFolder: OwnedHubsByFolder = new Map([
		[OLD_FOLDER, { state: 'one', path: `${OLD_FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence`, values: [{ level: 'tactic', value: 'Persistence' }] }],
	]);

	it('excluded from the write set: Persistence is HELD, so its RECORDED identity survives (row 1)', () => {
		const result = enrich([anchor, recategorized], {
			ontology: ONT, config: CONFIG, rootFolder: ROOT, ownedHubsByFolder,
			writeSet: new Set([anchor.path]), // recategorized is held.
		});
		const hub = hubByPath(result, `${OLD_FOLDER}/Persistence.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(`${ONT}:hub/persistence`);
		expect(deviationFor(result, OLD_FOLDER)).toBeUndefined();
	});

	it('CONTROL: included in the write set (the AM-60 shape): Persistence is no longer held or described by anything writable -- a DIFFERENT, disagreeing outcome for the identical notes', () => {
		const result = enrich([anchor, recategorized], {
			ontology: ONT, config: CONFIG, rootFolder: ROOT, ownedHubsByFolder,
			// Both rows writable now -- recategorized's values describe IA, not
			// Persistence, so nothing writable describes Persistence and it is not
			// held either (keptFolders excludes writable rows by construction).
			writeSet: new Set([anchor.path, recategorized.path]),
		});
		expect(hubByPath(result, `${OLD_FOLDER}/Persistence.md`)).toBeUndefined();
		const deviation = deviationFor(result, OLD_FOLDER);
		expect(deviation).toBeDefined();
		// AM-50's "no row describes this folder" cause, not AM-55's kept cause --
		// a different refusal reason, proving Persistence really did change which
		// bucket it fell into when writeSet changed and nothing else did.
		expect(deviation).toContain('No index note was created');
		expect(deviation).not.toContain('kept in place');
	});
});

/**
 * AM-61(d), the ANCESTOR case. The two tests above cannot distinguish
 * write-set-scoped `valuesByFolder` from a whole-population one: a
 * recategorized row's OWN values describe its RENDERED chain only (never its
 * old folder), so a kept row can never leak a description of the folder it
 * was moved AWAY from, under either construction. The guard only matters for
 * a folder the OLD and NEW chains still SHARE -- a two-level layout where
 * only the leaf category changed. This is the shape a whole-population
 * `valuesByFolder` mutation actually reaches and this file's own
 * falsification driver confirms it (`.workspace/falsify-pass20-am61-63-s13-
 * s18.py`, mutation AM61-3): without it, this describe block is the one that
 * goes red.
 */
describe('AM-61(d) structural, the ANCESTOR case: a folder BOTH the old and new chain pass through must still take its RECORDED identity, never the kept row\'s own rendered values', () => {
	const CONFIG2 = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
	const PARENT = `${ROOT}/Persistence`; // shared by both the old and new address.
	/** On disk: Frameworks/Persistence/OldSub/T1.md. Rendered this run: .../NewSub/T1.md -- only the SUBcategory moved. */
	const recategorizedSub: EnrichNote = {
		path: `${PARENT}/OldSub/T1.md`,
		renderedPath: `${PARENT}/NewSub/T1.md`,
		curie: `${ONT}:t1sub`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'category', value: 'Persistence' }, { level: 'sub', value: 'NewSub' }],
	};
	const anchor2: EnrichNote = {
		path: `${NEW_FOLDER}/T9.md`,
		curie: `${ONT}:t9b`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'category', value: 'Discovery' }],
	};
	const LEGACY_PARENT_CURIE = `${ONT}:hub/persistence-legacy-ancestor`;
	const ownedHubsByFolder: OwnedHubsByFolder = new Map([
		[PARENT, { state: 'one', path: `${PARENT}/Persistence.md`, curie: LEGACY_PARENT_CURIE, values: [{ level: 'category', value: 'Persistence' }] }],
	]);

	it("Persistence (the shared parent) keeps its RECORDED legacy curie -- never re-derived from the kept row's own rendered chain, even though that chain's first segment is the SAME value", () => {
		const result = enrich([anchor2, recategorizedSub], {
			ontology: ONT, config: CONFIG2, rootFolder: ROOT, ownedHubsByFolder,
			writeSet: new Set([anchor2.path]), // recategorizedSub is held.
		});
		const hub = hubByPath(result, `${PARENT}/Persistence.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(LEGACY_PARENT_CURIE);
		// The re-derivation this pins against: today's scheme derives THIS from
		// the row's own rendered first segment, "Persistence" -- identical text to
		// what the recorded values say, which is exactly why an unscoped
		// valuesByFolder can describe this folder WITHOUT disagreeing and still be
		// wrong: it substitutes a live derivation for a recorded fact that happens,
		// this time, to look the same.
		expect(hub!.curie).not.toBe(`${ONT}:hub/persistence`);
	});
});
