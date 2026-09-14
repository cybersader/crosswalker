/**
 * hub-refusal-am56-retraction-withdrawn.test.ts -- AM-56 (2026-09-04, pass 18,
 * Task C item 3): the S7 retraction is withdrawn; a stale hosting fact is
 * DISCLOSED, never un-written by guessing at it.
 *
 * THE DEFECT THIS PINS (pass-17 CONFIRMED 2 / Ground 2). The withdrawn
 * retraction picked its target by whole-batch `byBasename.get(basename(f))` --
 * exactly the rule S4/S7 removed from the hosting exemption itself, reopened on
 * the write path -- and by construction could only ever name a note that was
 * NOT the refused folder's host (`refusalFor` returning past `hostByFolder`
 * proves the match is empty). Where the guard didn't stop it, it set
 * `hostedChildrenByPath[unrelatedNotePath] = []`, and because an empty array is
 * TRUTHY, `applyEnrichment` wrote a visible `## Contents` / `*(nothing yet)*`
 * block into a note that never carried one -- inside the one region the user is
 * told the next run owns.
 *
 * THE RULE. Whether a note hosts a folder is a fact the VAULT carries, not one
 * this batch recovers by basename. The retraction is deleted outright; a
 * refused folder's stale Contents entry (if any) is disclosed in the refusal
 * text instead (`STALE_LIST_DISCLOSURE`), and `mergeManagedChildrenSection`
 * gains a `freshIsEmpty` guard so an empty section can only ever REWRITE a
 * region a note already carries -- never manufacture one.
 */

import { enrich, mergeManagedChildrenSection, buildManagedChildrenSection, type EnrichNote } from '../src/generation/enrich';

const ONT = 'hg';
const ROOT = 'Frameworks';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };

/**
 * AM-66 (2026-09-04). THE WRITE SET THIS FIXTURE MEANS: the live rows only.
 *
 * Both `enrich()` fixtures below are KEPT-SHAPED - each carries a note whose
 * `renderedPath` sits in a different folder from its own path, which is a row
 * this run declined to write at the address the layout now chooses. That is the
 * fact the file's own comments state ("kept in place", "the kept-row holder"),
 * and it is the fact the deleted inference merely recovered from a path
 * comparison; AM-65 requires the caller to state it instead.
 *
 * So: a note whose `renderedPath` is absent or equal to its `path` is written;
 * one whose `renderedPath` differs is held. Assertions are unchanged - the
 * refusals these tests pin are exactly the ones a held folder produces.
 */
const writable = (...notes: EnrichNote[]): Set<string> =>
	new Set(notes.filter((n) => n.renderedPath === undefined || n.renderedPath === n.path).map((n) => n.path));

describe('AM-56: a refused folder never touches an unrelated note that happens to share its basename', () => {
	it('a leaf note elsewhere in the batch, sharing the refused folder\'s basename but hosting nothing, gains no Contents region', () => {
		// Frameworks/Persistence is refused (kept in place, no recorded identity --
		// the row-3 shape from AM-55). A totally unrelated LEAF note under a
		// different top-level folder happens to be named "Persistence.md" too --
		// the exact basename collision the withdrawn retraction picked by.
		const keptRow: EnrichNote = {
			path: `${ROOT}/Persistence/T1.md`,
			renderedPath: `${ROOT}/IA/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'IA' }],
		};
		const unrelatedLeaf: EnrichNote = {
			path: `${ROOT}/Discovery/Persistence.md`,
			curie: `${ONT}:persistence-leaf`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'Discovery' }],
		};
		const result = enrich([keptRow, unrelatedLeaf], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(keptRow, unrelatedLeaf) });

		// The folder is genuinely refused (sanity check the fixture engages AM-56 at all).
		expect(result.deviations.find((d) => d.includes(`${ROOT}/Persistence"`))).toBeDefined();

		// The unrelated note never gains a hosted-Contents entry: it is not the
		// folder's host (S4/S7), and nothing recovers a "former host" from its
		// basename any more (the withdrawn retraction's whole mechanism).
		expect(result.levelHubs.hostedChildrenByPath.has(unrelatedLeaf.path)).toBe(false);
	});
});

describe('AM-56: the disclosure sentence is present on every refusal, never a silent retraction', () => {
	it('an AM-50 "moved" refusal carries the stale-list disclosure', () => {
		const notes: EnrichNote[] = [{
			path: `${ROOT}/Elsewhere/A.md`,
			renderedPath: `${ROOT}/X/A.md`,
			curie: `${ONT}:a`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'x', value: 'X' }],
		}];
		// No recordedHubValues -- an ordinary undescribed folder, not on any kept
		// row's chain (the note here is at a different top-level folder than any
		// kept-row holder, so it reaches AM-50 directly rather than AM-55's kept
		// branch)... in practice this shape is AM-52/54's own kept-cause branch
		// (see hub-refusal-am50-and-s4.test.ts's own note on the same fixture);
		// either branch it lands in carries the SAME disclosure sentence, which
		// is what this test actually pins.
		const result = enrich(notes, { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(...notes) });
		const deviation = result.deviations.find((d) => d.includes(`${ROOT}/Elsewhere`));
		expect(deviation).toBeDefined();
		expect(deviation).toContain("Any list that still names this folder's index note is left as it was.");
	});
});

describe('AM-56: mergeManagedChildrenSection never manufactures a Contents region on a note that never had one', () => {
	it('freshIsEmpty=true and no existing children region: the body comes back byte-for-byte unchanged', () => {
		const body = '# Some Note\n\nSome user prose. No managed region here at all.\n';
		const fresh = buildManagedChildrenSection('Contents', []);
		const out = mergeManagedChildrenSection(body, fresh, true);
		expect(out).toBe(body);
	});

	it('freshIsEmpty=true and an EXISTING children region: the region is honestly rewritten to empty, not left stale', () => {
		const before = buildManagedChildrenSection('Contents', ['[[Old]]']).replace(/\n$/, '');
		const body = `# Some Note\n\n${before}\n`;
		const fresh = buildManagedChildrenSection('Contents', []);
		const out = mergeManagedChildrenSection(body, fresh, true);
		expect(out).not.toContain('[[Old]]');
		expect(out).toContain('*(nothing yet)*');
	});

	it('control: freshIsEmpty=false (the default) still appends as before -- the guard is scoped to the empty case only', () => {
		const body = '# Some Note\n\nUser prose.\n';
		const fresh = buildManagedChildrenSection('Contents', ['[[A]]']);
		const out = mergeManagedChildrenSection(body, fresh);
		expect(out).toContain('[[A]]');
		expect(out).not.toBe(body);
	});
});
