/**
 * d1-pass20-s17-s18-address-and-withheld.test.ts -- S17 and S18 (2026-09-04,
 * pass 20, Task C items 6 and 7).
 *
 * S17 IS TESTED STRUCTURALLY, ON PURPOSE, NOT END TO END. `producedThisRun`'s
 * bypass in `addressRefusal` is meaningfully different from the pre-S17 bug
 * ONLY when the occupying note is a row THIS RUN'S OWN CSV kept (in `records`
 * but not the write set) AND that note is not stamped with the run's own
 * import set (an ordinary same-set kept row is admitted either way, via the
 * stamp check `addressRefusal` falls through to). Constructing that ORGANIC
 * collision needs a synthetic level hub's desired address to coincide with a
 * kept row's address, and every route there is intercepted first by
 * `enrich()`'s own `hostByFolder` exemption (a batch row sharing a folder's
 * basename is always treated as that folder's HOST, never reaches
 * `resolveHubTarget`'s address branch at all) -- the pass-20 implementer
 * recorded the same finding as residual risk 3 ("not covered by any existing
 * test I could see"). Rather than force a contrived repro, this pins the
 * mechanism directly: `producedThisRun`'s exact construction
 * (`generation-engine.ts:3992-3995`) against the exported, real
 * `addressRefusal` (`:1289`), with the PRE-S17 construction as an explicit
 * CONTROL that reproduces the bypass the ruling closed.
 *
 * THE DEFECT THIS PINS. Before S17, `producedThisRun` also carried
 * `result.skipped` and every kept record's path -- so a synthetic hub whose
 * desired address happened to hold ANY kept note (not necessarily one this
 * run's own rows share a folder-basename with -- any note at all) skipped
 * `addressRefusal` entirely and was adopted, no matter who owned it.
 *
 * THE RULE. The bypass is exactly the WRITE SET plus what this run actually
 * created (`generation-engine.ts:3992-3995`) -- a kept note is an OCCUPANT of
 * its address, not something this run produced there.
 */

import { normalizePath } from 'obsidian';
import { addressRefusal, type AddressRefusal } from '../src/generation/generation-engine';
import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';
import type { IdentityIndex, AddressStamp } from '../src/generation/identity-index';

function stubIndex(stampByPath: Map<string, AddressStamp>): IdentityIndex {
	return {
		get: () => null,
		owner: () => null,
		provenanceAt: (path: string) => stampByPath.get(path) ?? null,
		curies: () => [],
		collisions: [],
		size: 0,
	};
}

/** S17's own construction, verbatim (generation-engine.ts:3992-3995). */
function producedThisRunFixed(
	records: { path: string }[],
	writeSet: ReadonlySet<string>,
	created: string[],
): Set<string> {
	return new Set<string>([
		...records.filter((r) => writeSet.has(r.path)).map((r) => normalizePath(r.path)),
		...created.map((path) => normalizePath(path)),
	]);
}

/** The PRE-S17 construction, for the control: every record, kept or written. */
function producedThisRunPreS17(records: { path: string }[], created: string[]): Set<string> {
	return new Set<string>([
		...records.map((r) => normalizePath(r.path)),
		...created.map((path) => normalizePath(path)),
	]);
}

describe('S17: the producedThisRun bypass in addressRefusal is the WRITE SET, not every record', () => {
	const HUB_ADDRESS = 'Ontologies/Persistence/Persistence.md';
	// A kept row this run's CSV carries at that exact address, stamped as a
	// LEGACY note (no import_set block) -- the case S17's own ruling names:
	// "when it is unstamped or legacy it is now refused by name where it was
	// previously merged into".
	const keptLegacyRecord = { path: HUB_ADDRESS };
	const records = [keptLegacyRecord, { path: 'Ontologies/Discovery/T2.md' }];
	const writeSet = new Set(['Ontologies/Discovery/T2.md']); // the hub's address was never written this run.
	const created: string[] = [];
	const stamps = new Map<string, AddressStamp>([[HUB_ADDRESS, { importSetId: null }]]); // unstamped/legacy.
	const index = stubIndex(stamps);

	it('FIXED (S17): a kept, unstamped note at the hub\'s address is REFUSED -- the bypass no longer reaches it', () => {
		const produced = producedThisRunFixed(records, writeSet, created);
		expect(produced.has(HUB_ADDRESS)).toBe(false);
		const refusal = addressRefusal(index, HUB_ADDRESS, 'iset-current', produced);
		expect(refusal).not.toBeNull();
		expect((refusal as AddressRefusal).reason).toBe('unstamped');
	});

	it('CONTROL, PRE-S17: the SAME note, under the old construction, bypasses the check entirely -- reproducing the exact regression the ruling closed', () => {
		const produced = producedThisRunPreS17(records, created);
		expect(produced.has(HUB_ADDRESS)).toBe(true); // the bug: a kept path treated as produced.
		const refusal = addressRefusal(index, HUB_ADDRESS, 'iset-current', produced);
		expect(refusal).toBeNull(); // admitted -- the hub would merge into a note this run never wrote.
	});

	it('the ordinary same-set case is unaffected either way -- admitted on its OWN stamp, no bypass needed', () => {
		const sameSetStamps = new Map<string, AddressStamp>([[HUB_ADDRESS, { importSetId: 'iset-current' }]]);
		const sameSetIndex = stubIndex(sameSetStamps);
		const fixed = producedThisRunFixed(records, writeSet, created);
		const pre = producedThisRunPreS17(records, created);
		expect(addressRefusal(sameSetIndex, HUB_ADDRESS, 'iset-current', fixed)).toBeNull();
		expect(addressRefusal(sameSetIndex, HUB_ADDRESS, 'iset-current', pre)).toBeNull();
	});

	it('a path actually in the write set is admitted under BOTH constructions -- S17 narrows the bypass, it does not remove it', () => {
		const writtenPath = 'Ontologies/Discovery/T2.md';
		const fixed = producedThisRunFixed(records, writeSet, created);
		expect(fixed.has(normalizePath(writtenPath))).toBe(true);
		expect(addressRefusal(index, writtenPath, 'iset-current', fixed)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// S18: row-2/row-3 causes are OBSERVED, verbatim, and one voice per folder --
// a `withheld` folder gets ONLY the caller's own warning, never row 3's text
// on top of it.
// ---------------------------------------------------------------------------

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';
const FOLDER = `${ROOT}/Persistence`;

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

const deviationFor = (result: ReturnType<typeof enrich>, folder: string) =>
	result.deviations.find((d) => d.includes(`"${folder}"`));

describe('S18: row 2 and row 3 causes are the OBSERVATION, verbatim', () => {
	it('row 2 (a hub present but with no usable recorded chain) reads "was left as it was: its recorded identity could not be read" -- not the old "predates recorded identity" story', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: `${ONT}:hub/persistence` }], // no `values`.
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: new Set() });
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toContain('was left as it was: its recorded identity could not be read.');
		expect(deviation).not.toContain('predates recorded identity');
	});

	it('row 3 (no hub in the folder at all) reads "...and none was created: the notes in it were kept in place by Skip existing and no index note of this import was found in it"', () => {
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder: new Map(), writeSet: new Set() });
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toContain(
			'and none was created: the notes in it were kept in place by Skip existing and no index note of this import was found in it.',
		);
	});
});

describe('S18: ONE VOICE PER FOLDER -- a folder the caller marked `withheld` gets silence here, never row 3\'s text on top of the caller\'s own warning', () => {
	it('a withheld folder produces NO deviation at all from this pass -- the caller has already named the note and suppressed orphan reporting itself', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'withheld' }],
		]);
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: new Set() });
		expect(deviationFor(result, FOLDER)).toBeUndefined();
		// No hub is written for it either -- there is no identity to write from.
		expect(result.levelHubs.notes.find((h) => h.path === `${FOLDER}/Persistence.md`)).toBeUndefined();
		// And nothing is claimed produced on the folder's behalf here -- the S12/
		// unreadable caller already suppressed orphan reporting for the whole run,
		// so a SECOND, narrower claim from this pass would just be wrong in the
		// opposite direction if that suppression were ever lifted.
		expect(result.levelHubs.keptExistingCuries).toEqual([]);
	});

	it('CONTROL: the SAME folder as an ordinary row-3 case (absent from the map, not withheld) DOES speak -- proving `withheld` is doing something, not merely absent by another name', () => {
		const result = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder: new Map(), writeSet: new Set() });
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toBeDefined();
		expect(deviation).toContain('This import has no index note for the folder');
	});
});
