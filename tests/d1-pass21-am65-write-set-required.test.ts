/**
 * d1-pass21-am65-write-set-required.test.ts -- AM-65 (2026-09-04, pass 21,
 * Task C item 5): `EnrichOptions.writeSet` is REQUIRED, not optional, and
 * omitting it is a refusal by name rather than "everything is writable".
 *
 * THE DEFECT THIS PINS. While `writeSet` was optional (AM-61, pass 20), the
 * documented ABSENT behaviour was "every note in this batch is writable" --
 * which is exactly the state `isWritable` answered for a caller that had not
 * been updated to pass the new argument. With every note writable,
 * `keptFolders` (built only from notes that are NOT writable) was
 * unconditionally empty, so every one of AM-52/AM-54/AM-55/AM-59's kept-folder
 * exemptions collapsed into AM-50's plain "the note may have been moved"
 * refusal. Twenty-four declarations across seven pre-existing test files went
 * red on one omitted argument, silently, with no evidence anywhere in the
 * output that the argument had ever existed.
 *
 * THE RULE. `writeSet: ReadonlySet<string>` carries no `?`, so a TypeScript
 * caller is a compile error without it, and `enrich()` itself throws a named
 * error before deriving anything, for a caller the compiler never saw. The
 * pre-AM-61 inference this replaced -- `dirOf(renderedPath) !== dirOf(path)`
 * therefore kept -- does not return as a fallback: the write set is the WHOLE
 * test, in both directions, so a note whose rendered folder differs from its
 * own but which IS in the write set is a relocation this run performs, never
 * a hold.
 */

import { enrich, type EnrichNote } from '../src/generation/enrich';

const ONT = 'am65';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'none' as const, parent_note: 'sibling' as const };
const ROOT = 'Frameworks';

describe('AM-65: writeSet is required, and its absence is a refusal by name', () => {
	it('a caller that omits writeSet entirely gets the exact named refusal, before anything is derived', () => {
		const note: EnrichNote = {
			path: `${ROOT}/Widgets/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
		};
		// A caller the compiler never saw -- a JS caller, or a fixture built
		// through a cast -- represented here by deliberately omitting the
		// required field and casting past the type checker.
		const optsWithoutWriteSet = { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT } as any;
		expect(() => enrich([note], optsWithoutWriteSet)).toThrow(
			'enrich(): writeSet is required; without it every kept row would describe its own folder',
		);
	});

	it('writeSet: undefined (explicitly passed) refuses identically to omitting it', () => {
		const note: EnrichNote = {
			path: `${ROOT}/Widgets/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
		};
		const opts = { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: undefined } as any;
		expect(() => enrich([note], opts)).toThrow('enrich(): writeSet is required');
	});

	it('CONTROL: the same call with an actual (even empty) writeSet does not throw', () => {
		const note: EnrichNote = {
			path: `${ROOT}/Widgets/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
		};
		expect(() => enrich([note], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: new Set() })).not.toThrow();
	});
});

describe('AM-65 structural: the write set is the whole test, in both directions -- not a renderedPath comparison', () => {
	/**
	 * `computeRelocations` only ever plans a `parent_note` shape flip (sibling
	 * <-> folder-note), so the note has to be shaped for that mechanism: sitting
	 * on disk in FOLDER-NOTE form (`Widgets/Widgets.md`) while `parent_note:
	 * 'sibling'` (the recipe default here) says it belongs in SIBLING form
	 * (`Widgets.md`) -- the exact positive evidence `computeRelocations`'s
	 * flip-back reads. `renderedPath` differs from `path` in directory (the
	 * pre-AM-61 inference's own trigger condition), which is precisely why this
	 * shape is the one that could tell "read from the set" apart from "guessed
	 * from comparing renderedPath to path": under the OLD inference this note
	 * was unconditionally "kept" no matter what the caller meant, because
	 * `dirOf(renderedPath) !== dirOf(path)` is true here regardless of writeSet.
	 */
	const foldedParent: EnrichNote = {
		path: `${ROOT}/Widgets/Widgets.md`,
		renderedPath: `${ROOT}/Widgets.md`,
		curie: `${ONT}:widgets`,
		frontmatter: {},
		facets: [],
	};

	it('excluded from the write set: HELD -- no relocation is planned for a note this run will not touch', () => {
		const result = enrich([foldedParent], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT,
			writeSet: new Set(), // foldedParent is NOT in it.
		});
		expect(result.relocations).toEqual([]);
		expect(result.deviations.some((d) => d.includes('relocated'))).toBe(false);
	});

	it('included in the write set: the SAME note is a RELOCATION this run performs -- proving the fact comes from the set, not from comparing renderedPath to path', () => {
		const result = enrich([foldedParent], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT,
			writeSet: new Set([foldedParent.path]), // same note, now writable.
		});
		expect(result.relocations).toEqual([
			{ curie: `${ONT}:widgets`, from: `${ROOT}/Widgets/Widgets.md`, to: `${ROOT}/Widgets.md` },
		]);
		expect(result.deviations.some((d) => d.includes('relocated') && d.includes('sibling form'))).toBe(true);
	});
});
