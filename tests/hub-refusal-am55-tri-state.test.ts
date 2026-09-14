/**
 * hub-refusal-am55-tri-state.test.ts -- AM-55 (2026-09-04, pass 18, Task C item
 * 2): a kept folder's hub is a FACT READ FROM THE VAULT, tri-state, and the
 * `enrich()`-level half of it -- text AND accounting together, one test per row
 * of the amendment's table, so a consequence clause can never drift from the
 * run again.
 *
 * THE DEFECT THIS PINS (pass-17 CONFIRMED 3 / Ground 3). The old kept-cause
 * refusal said the index note "stays as it was" for EVERY kept folder with no
 * usable recorded chain, including the ordinary case where the note is sitting
 * right there in the vault -- and the SAME run's orphan pass then reported that
 * same note as vanished, because nothing marked its curie produced. The cause
 * (Skip existing kept the rows) was true; the consequence clause (the note
 * "stays as it was", i.e. is accounted for) was false, and it is the half a
 * user acts on.
 *
 * THE RULE. `OwnedHubAtFolder` is `{ state: 'one', ...}` (with or without a
 * usable `values` chain) or `{ state: 'many', paths }`. Each observed shape has
 * its own row in the amendment's table, and each row's TEXT and ACCOUNTING are
 * asserted TOGETHER here so the two cannot silently disagree again:
 *
 *   Row 1 -- usable chain          -> exempt, rewritten, no deviation.
 *   Row 2 -- present, no usable chain -> refused (kept cause), its curie still
 *                                        added to `levelHubs.keptExistingCuries`.
 *   Row 3 -- no hub in the folder  -> refused (kept cause), nothing to account.
 *   many  -- two hubs in one folder -> refused by NAME, BOTH curies accounted
 *                                       (AM-59, pass 19 -- see below).
 *
 * AM-59 UPDATE (2026-09-04, pass 19). Pass 18's `many` branch refused and
 * accounted for NOTHING, so the same run's orphan pass reported both competing
 * notes as vanished over the refusal naming them present -- the ninth rule of
 * the arc ("a refusal names the population it looked at") applied to its own
 * `many` state. `OwnedHubAtFolder`'s `many` arm now carries `curies` alongside
 * `paths`, index for index, and BOTH are added to `keptExistingCuries` before
 * the refusal returns. The row-3 text also changed, from a vault-wide claim
 * ("No index note exists for the folder") to one scoped to what the read
 * actually covers ("This import has no index note for the folder").
 */

import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';
const FOLDER = `${ROOT}/Persistence`;

/** A single kept row holding FOLDER, recategorised to a different folder this run. */
function keptNote(): EnrichNote {
	return {
		path: `${FOLDER}/T1.md`,
		renderedPath: `${ROOT}/IA/T1.md`,
		curie: `${ONT}:t1`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'IA' }],
	};
}

/**
 * AM-65 (2026-09-04). THE WRITE SET, STATED. `enrich()` no longer infers which
 * half of a batch it may act on from `renderedPath` vs `path`; the caller says so,
 * and omitting it is a refusal by name rather than "everything is writable".
 *
 * Every batch below is the single row this run KEPT, so nothing in it is writable.
 * The assertions are unchanged - this is the test supplying a fact it previously
 * left the engine to guess.
 */
const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();

const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);
const deviationFor = (result: ReturnType<typeof enrich>, folder: string) =>
	result.deviations.find((d) => d.includes(`"${folder}"`));

describe('AM-55 row 1: a usable recorded chain exempts the folder -- rewritten, no deviation, nothing to account separately', () => {
	it('the hub is written from the recorded chain and no curie is added to keptExistingCuries (it is written, not merely accounted for)', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence`, values: [{ level: 'tactic', value: 'Persistence' }] }],
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		expect(deviationFor(result, FOLDER)).toBeUndefined();
		const hub = hubByPath(result, `${FOLDER}/Persistence.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(`${ONT}:hub/persistence`);
		// Written as a real hub note, so accounting for it a SECOND time via
		// keptExistingCuries would be a duplicate claim.
		expect(result.levelHubs.keptExistingCuries).not.toContain(`${ONT}:hub/persistence`);
	});
});

describe('AM-55 row 2: present, no usable chain -- refused with the row-2 text AND the curie is marked produced via keptExistingCuries', () => {
	it('a pre-AM-38 hub (values present, no usable chain to derive from) is refused, never written, and its OWN curie is accounted for', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence` }],
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toBeDefined();
		// AM-67 (2026-09-04). CORRECTED TO THE RULING THAT CHANGED IT. S18 (pass 20)
		// re-ruled AM-55's row-2 text: "was left as it was and not updated this run"
		// / "predates recorded identity" became one clause that names what was
		// observed, because "the note predates recorded identity" is a story about
		// the observation and not the observation - a run that computed no values
		// writes the same state, and so does a hand edit, and so does a length
		// mismatch. Both halves below are the pass-22 tree's own text, verbatim
		// (`enrich.ts` row 2, the `state === 'one'` branch); AM-68 deleted the
		// identically-worded UNREADABLE-folder message beside it, leaving this the
		// one emitter of the sentence.
		//
		// These two assertions were red on the pass-21 tree and were masked before it
		// by the missing write set, which failed the declaration earlier.
		expect(deviation).toContain('was left as it was:');
		expect(deviation).toContain('its recorded identity could not be read');
		expect(deviation).toContain('Re-run with Replace to re-establish it');
		// The note demonstrably exists -- its EXISTING curie (never a re-derived
		// one) is added to the accounting list the caller marks produced.
		expect(result.levelHubs.keptExistingCuries).toEqual([`${ONT}:hub/persistence`]);
	});

	it('a half-record (values array present but empty) is fail-closed to the SAME row-2 behaviour, not a guess', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence`, values: [] }],
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		// AM-67. The same S18 correction as the sibling declaration above.
		expect(deviationFor(result, FOLDER)).toContain('was left as it was: its recorded identity could not be read');
		expect(result.levelHubs.keptExistingCuries).toEqual([`${ONT}:hub/persistence`]);
	});
});

describe('AM-55 row 3: no hub in the folder at all -- refused with the row-3 text, and nothing to account for', () => {
	it('an empty ownedHubsByFolder map (nothing recorded, nothing on disk) refuses with the row-3 text and marks no curie produced', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map();
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toBeDefined();
		// AM-59 (pass 19): the sentence now names the POPULATION IT READ ("this
		// import") rather than claiming a fact about the whole vault.
		expect(deviation).toContain('This import has no index note for the folder');
		expect(deviation).not.toContain('No index note exists for the folder');
		expect(deviation).toContain('none was created');
		expect(deviation).toContain('Re-run with Replace to create it');
		expect(result.levelHubs.keptExistingCuries).toEqual([]);
	});

	it('no ownedHubsByFolder option supplied at all behaves identically to an empty map (the caller-optional contract)', () => {
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE });
		expect(deviationFor(result, FOLDER)).toContain('This import has no index note for the folder');
		expect(result.levelHubs.keptExistingCuries).toEqual([]);
	});
});

describe('AM-55/AM-59 "many": two index notes in one folder is a refusal by NAME, never a pick, and BOTH curies are accounted for', () => {
	it('names both paths in the refusal and marks BOTH curies produced (AM-59, pass 19: refusing to pick is not evidence either note vanished)', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, {
				state: 'many',
				paths: [`${FOLDER}/Persistence.md`, `${FOLDER}/Persistence-copy.md`],
				curies: [`${ONT}:hub/persistence`, `${ONT}:hub/persistence-copy`],
			}],
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE });

		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toBeDefined();
		expect(deviation).toContain('more than one index note');
		expect(deviation).toContain(`${FOLDER}/Persistence.md`);
		expect(deviation).toContain(`${FOLDER}/Persistence-copy.md`);
		expect(deviation).toContain('cannot say which one');
		// AM-59: BOTH competing notes' curies are marked produced. The run read
		// both this pass and is about to print their paths in the refusal above --
		// letting the orphan pass call either one vanished would be a consequence
		// clause the same run contradicts. Refusing to CHOOSE between them is not
		// evidence that either one LEFT the source.
		expect(result.levelHubs.keptExistingCuries.slice().sort()).toEqual(
			[`${ONT}:hub/persistence`, `${ONT}:hub/persistence-copy`].sort(),
		);
	});
});

describe('AM-56 disclosure: every AM-55 refusal text carries the trailing stale-list sentence', () => {
	it('row 2, row 3, and "many" all end with the disclosure that a stale host list is left as it was, not un-written', () => {
		const disclosure = "Any list that still names this folder's index note is left as it was.";
		const many = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE,
			ownedHubsByFolder: new Map([[FOLDER, { state: 'many', paths: [`${FOLDER}/A.md`, `${FOLDER}/B.md`], curies: [`${ONT}:hub/a`, `${ONT}:hub/b`] }]]),
		});
		expect(deviationFor(many, FOLDER)).toContain(disclosure);

		const row2 = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE,
			ownedHubsByFolder: new Map([[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence` }]]),
		});
		expect(deviationFor(row2, FOLDER)).toContain(disclosure);

		const row3 = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder: new Map(), writeSet: NOTHING_WRITABLE });
		expect(deviationFor(row3, FOLDER)).toContain(disclosure);
	});
});
