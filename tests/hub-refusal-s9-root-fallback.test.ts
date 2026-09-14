/**
 * hub-refusal-s9-root-fallback.test.ts -- S9 (2026-09-04, pass 19, Task C item
 * 4): the ROOT-hub fallback picks its write target by PLACEMENT, the same
 * test `hostByFolder` makes for every other folder, not by a whole-batch
 * basename lookup.
 *
 * THE DEFECT THIS PINS. The root fallback (`enrich.ts`, gated on
 * `!folders.has(root)` -- the bare golden-vault-harness case, since a real
 * import always tracks its own destination as an ancestor) used to pick its
 * host with `byBasename.get(label)`: ANY note anywhere in the batch whose
 * basename equalled the root's own last segment became the root's host, and
 * the root's whole Contents list was written into that unrelated note's
 * managed region. Two folders sharing a basename also silently overwrote each
 * other's `hostedChildrenByPath` entry.
 *
 * THE RULE. A candidate must be PLACED at the root -- `dirOf(path) === root`
 * (inside a literal folder named after the root; unreachable within this
 * branch's own gate, since a note there would make `folders.has(root)` true
 * and the branch would never fire) or `dirOf(path) === dirOf(root)` (a
 * sibling of the root, the production folder-note form). Two such candidates
 * is a question, answered exactly like AM-55/AM-59 answers two index notes in
 * one folder: refused BY NAME, nothing written -- no host claimed, no
 * synthetic hub either. Zero candidates is not a refusal: it is the ordinary
 * state this fallback exists FOR, and the synthetic root hub is its answer.
 */

import { enrich, type EnrichNote } from '../src/generation/enrich';

const ONT = 'hg';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
// A root that is NEVER a prefix of any note's path below -- the precondition
// for `!folders.has(root)`, i.e. the harness branch this file exercises.
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

const syntheticHome = (result: ReturnType<typeof enrich>) =>
	result.levelHubs.notes.find((h) => h.path === `${ROOT}.md`);

describe('S9: two candidates PLACED as siblings of the root, sharing its basename -- refused by name, nothing written', () => {
	it('names both candidate paths, claims no host, and creates no synthetic root hub either', () => {
		// Two DISTINCT paths that both strip to the SAME basename ("Frameworks")
		// -- basename() strips ".md" case-INsensitively but preserves the body's
		// own case, so a differently-cased extension is the one way two real,
		// distinct vault paths can collide on the stripped basename without
		// requiring a literal "Frameworks/" folder to exist (which would poison
		// this branch's own `!folders.has(root)` gate -- see the module note
		// above and pass-18's adversarial S9 entry).
		const candidateA: EnrichNote = { path: 'Frameworks.md', curie: `${ONT}:a`, frontmatter: {}, facets: [] };
		const candidateB: EnrichNote = { path: 'Frameworks.MD', curie: `${ONT}:b`, frontmatter: {}, facets: [] };

		const result = enrich([candidateA, candidateB], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(candidateA, candidateB) });

		const deviation = result.deviations.find((d) => d.includes(`"${ROOT}"`));
		expect(deviation).toBeDefined();
		expect(deviation).toContain('more than one note in this import is placed at it');
		expect(deviation).toContain('"Frameworks.md"');
		expect(deviation).toContain('"Frameworks.MD"');
		expect(deviation).toContain('cannot say which one');

		// Neither candidate's own note was claimed as the root's HOST.
		expect(result.levelHubs.hostedChildrenByPath.has('Frameworks.md')).toBe(false);
		expect(result.levelHubs.hostedChildrenByPath.has('Frameworks.MD')).toBe(false);
		// And no SYNTHETIC root hub was minted either -- a refusal, not a pick,
		// and not a fall-through to the no-candidate answer.
		expect(syntheticHome(result)).toBeUndefined();
	});
});

describe('S9: a basename twin placed ELSEWHERE (not a sibling of the root) is never chosen as the root\'s host', () => {
	it('a note sharing the root\'s basename, but nested deep inside an unrelated folder, is not claimed; zero real candidates falls through to the synthetic root hub', () => {
		// This note's basename equals the root's label ("Frameworks"), the OLD
		// whole-batch `byBasename.get(label)` rule's exact trigger -- but it sits
		// at `Deep/Sub`, neither AT the root nor a SIBLING of it, so the
		// placement test excludes it.
		const twin: EnrichNote = { path: 'Deep/Sub/Frameworks.md', curie: `${ONT}:twin`, frontmatter: {}, facets: [] };
		// An ordinary top-level row, so there is something for the root's
		// Contents to name (childRefs.length > 0).
		const leaf: EnrichNote = { path: 'Leaf.md', curie: `${ONT}:leaf`, frontmatter: {}, facets: [] };

		const result = enrich([twin, leaf], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: writable(twin, leaf) });

		// The twin was NEVER claimed as the root's host -- the exact failure mode
		// (an unrelated note's managed region getting the root's whole Contents
		// list written into it) this rule exists to prevent.
		expect(result.levelHubs.hostedChildrenByPath.has('Deep/Sub/Frameworks.md')).toBe(false);

		// Zero real candidates is the ordinary state, not a refusal: the
		// synthetic root hub is minted instead, and links the ordinary row.
		const home = syntheticHome(result);
		expect(home).toBeDefined();
		expect(home!.frontmatter.kind).toBe('hub');
		expect(home!.childrenLinks).toContain('[[Leaf]]');
		// No deviation naming the root at all -- this is not an ambiguous case.
		expect(result.deviations.find((d) => d.includes(`"${ROOT}"`))).toBeUndefined();
	});
});
