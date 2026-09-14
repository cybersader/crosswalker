/**
 * enrich.test.ts — Pass 1.5 batch enrichment (pure logic).
 *
 * Covers the 2026-07-10 batch-enrichment design §5 acceptance cases 1, 2, 4, 5:
 *   1. T1078 gains a sorted `children` list.
 *   2. A facet hub note (Persistence) materializes with kind:facet + members + H1.
 *   4. Deterministic (same notes → deep-equal result); user prose survives a
 *      re-import while `members` regenerates.
 *   5. `parent_note: 'folder-note'` relocates T1078.md → T1078/T1078.md; the
 *      symmetric flip-back; idempotency; the streamed v1 restriction; and the
 *      collision guard.
 * Plus: children/parent derivation, edge count, multi-value link split (render),
 * and hub min-members.
 */

import { render, splitLinkValues, type Recipe } from '../src/render';
import {
	enrich,
	mergeHubBody,
	extractWikilinkTargets,
	HUB_MIN_MEMBERS,
	buildManagedChildrenSection,
	mergeManagedChildrenSection,
	ensureWaypointMarker,
	type EnrichNote,
} from '../src/generation/enrich';
import { mergeFrontmatter, computeManagedKeys } from '../src/generation/frontmatter-merge';

// ---------------------------------------------------------------------------
// Fixture — an ATT&CK-persistence-shaped batch (with a `tactic` facet so the
// hub path is exercised; the committed subset's tactic is single-valued, so this
// synthetic fixture is where the multi-member hub case lives).
// ---------------------------------------------------------------------------

function note(path: string, id: string, parent: string, tactic: string, renderedPath?: string): EnrichNote {
	return {
		path,
		curie: `attack:${id}`,
		frontmatter: { parent: `[[${parent}]]`, curie: `attack:${id}` },
		facets: [{ namespace: 'tactic', value: tactic }],
		...(renderedPath !== undefined ? { renderedPath } : {}),
	};
}

function attackBatch(): EnrichNote[] {
	return [
		note('T1078.md', 'T1078', '', 'Persistence'),
		note('T1078/T1078.001.md', 'T1078.001', 'T1078', 'Persistence'),
		note('T1078/T1078.002.md', 'T1078.002', 'T1078', 'Persistence'),
		note('T1078/T1078.003.md', 'T1078.003', 'T1078', 'Persistence'),
		note('T1078/T1078.004.md', 'T1078.004', 'T1078', 'Persistence'),
	];
}

const CONFIG = { children_lists: true, facet_notes: 'notes' as const, parent_note: 'sibling' as const };

/**
 * AM-66 (2026-09-04). THE WRITE SET THIS FILE MEANS: every note in the batch.
 *
 * Decided once for the whole file, because every fixture here is a LIVE import
 * writing every note it hands over. There is no kept row anywhere in this file -
 * no assertion in it is about a row the run declined to write.
 *
 * Stated rather than left to `enrich()` to infer: AM-65 made the fact required
 * because, while it was optional, an omitted write set silently meant "everything
 * is writable" - true for THIS file and false for the kept-row fixtures, so the
 * one default served one caller and quietly broke the other with nothing in the
 * output naming the omission.
 *
 * ONE note in this file carries `renderedPath` (`relocatedBatch()`'s T1078, the
 * only 5-argument `note(...)` call in the file), and it is IN the write set: its
 * `renderedPath` is render()'s own evidence that this import wants the sibling
 * form, and the three declarations that use it assert the relocation this run
 * PERFORMS. That is AM-65's structural rule verbatim - a note whose rendered
 * folder differs from its own and which IS in the write set is a relocation, not
 * a hold - and it is why the deleted inference was a defect: it read relocation
 * evidence as a hold. Assertions are unchanged.
 */
const writable = (notes: EnrichNote[]): Set<string> => new Set(notes.map((n) => n.path));

// ===========================================================================
// Acceptance case 1 — children lists
// ===========================================================================

describe('enrich — children lists (design §5 case 1)', () => {
	it('T1078 gains a sorted children list of its four sub-techniques', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(result.childrenByPath.get('T1078.md')).toEqual([
			'[[T1078.001]]',
			'[[T1078.002]]',
			'[[T1078.003]]',
			'[[T1078.004]]',
		]);
	});

	it('children are sorted by curie regardless of input order', () => {
		const shuffled = [
			attackBatch()[3],
			attackBatch()[0],
			attackBatch()[4],
			attackBatch()[1],
			attackBatch()[2],
		];
		const result = enrich(shuffled, { writeSet: writable(shuffled), ontology: 'attack', config: CONFIG });
		expect(result.childrenByPath.get('T1078.md')).toEqual([
			'[[T1078.001]]',
			'[[T1078.002]]',
			'[[T1078.003]]',
			'[[T1078.004]]',
		]);
	});

	it('a note with no children gets no children patch', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(result.childrenByPath.has('T1078/T1078.001.md')).toBe(false);
	});

	it('children_lists off → no children patches (but parent links still counted)', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()),
			ontology: 'attack',
			config: { children_lists: false, facet_notes: 'none' },
		});
		expect(result.childrenByPath.size).toBe(0);
		expect(result.edgeCount).toBe(4); // 4 resolvable parent links
	});
});

// ===========================================================================
// Acceptance case 2 — facet hub note
// ===========================================================================

describe('enrich — facet hub notes (design §5 case 2)', () => {
	it('Persistence.md exists with kind:facet, sorted members, facet tag, H1 body', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(result.hubs).toHaveLength(1);
		const hub = result.hubs[0];
		expect(hub.path).toBe('Persistence.md');
		expect(hub.curie).toBe('attack:facet/tactic/persistence');
		expect(hub.frontmatter.kind).toBe('facet');
		expect(hub.frontmatter.tags).toEqual(['tactic/persistence']);
		expect(hub.frontmatter.members).toEqual([
			'[[T1078]]',
			'[[T1078.001]]',
			'[[T1078.002]]',
			'[[T1078.003]]',
			'[[T1078.004]]',
		]);
		expect(hub.body).toBe('# Persistence\n');
	});

	it('materializes one hub per facet value (multi-tactic → multiple hubs, sorted by path)', () => {
		const batch = [
			note('T1078.md', 'T1078', '', 'Persistence'),
			note('T1078/T1078.001.md', 'T1078.001', 'T1078', 'Persistence'),
			{ ...note('T1548.md', 'T1548', '', 'Privilege Escalation'), facets: [{ namespace: 'tactic', value: 'Privilege Escalation' }] },
			{ ...note('T1548/T1548.001.md', 'T1548.001', 'T1548', 'Privilege Escalation'), facets: [{ namespace: 'tactic', value: 'Privilege Escalation' }] },
		];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: CONFIG });
		// Filenames preserve spaces (mirrors the fs-safe filter); curie value-slug
		// lowercases + hyphenates.
		expect(result.hubs.map((h) => h.path)).toEqual(['Persistence.md', 'Privilege Escalation.md']);
		expect(result.hubs[1].curie).toBe('attack:facet/tactic/privilege-escalation');
	});

	it('facet_notes tags-only → no hub notes', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()),
			ontology: 'attack',
			config: { children_lists: true, facet_notes: 'tags-only' },
		});
		expect(result.hubs).toEqual([]);
	});

	it('hubs with fewer than HUB_MIN_MEMBERS members are not materialized', () => {
		const batch = [
			{ ...note('A.md', 'A', '', 'Solo'), facets: [{ namespace: 'tactic', value: 'Solo' }] },
			{ ...note('B.md', 'B', '', 'Pair'), facets: [{ namespace: 'tactic', value: 'Pair' }] },
			{ ...note('C.md', 'C', '', 'Pair'), facets: [{ namespace: 'tactic', value: 'Pair' }] },
		];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: CONFIG });
		expect(HUB_MIN_MEMBERS).toBe(2);
		expect(result.hubs.map((h) => h.path)).toEqual(['Pair.md']); // Solo (1 member) skipped
	});

	it('hub_note_folder places hubs under the given folder', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()),
			ontology: 'attack',
			config: { ...CONFIG, hub_note_folder: 'Facets' },
		});
		expect(result.hubs[0].path).toBe('Facets/Persistence.md');
	});
});

// ===========================================================================
// Edge count (design §3.5)
// ===========================================================================

describe('enrich — edge count', () => {
	it('edgeCount = parent links + children entries + member entries', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		// 4 parent links + 4 children entries + 5 hub members = 13.
		expect(result.edgeCount).toBe(13);
	});
});

// ===========================================================================
// Acceptance case 4 — determinism + re-import safety
// ===========================================================================

describe('enrich — determinism (design §5 case 4)', () => {
	it('two runs over the same batch produce deep-equal results', () => {
		const a = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		const b = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(serialize(a)).toEqual(serialize(b));
	});

	it('input order does not change the hubs or edge count', () => {
		const forward = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		const reversed = enrich([...attackBatch()].reverse(), { writeSet: writable([...attackBatch()].reverse()), ontology: 'attack', config: CONFIG });
		expect(serialize(forward)).toEqual(serialize(reversed));
	});
});

describe('mergeHubBody — user prose survives re-import while members regenerate', () => {
	it('preserves user prose below the managed H1', () => {
		const existing = '# Persistence\n\nMy notes about this tactic.\n\n- a bullet\n';
		const fresh = '# Persistence\n';
		expect(mergeHubBody(existing, fresh)).toBe('# Persistence\n\nMy notes about this tactic.\n\n- a bullet\n');
	});

	it('regenerates the H1 (e.g. a renamed value) but keeps the prose', () => {
		const existing = '# Old Name\n\nUser prose.\n';
		const fresh = '# Persistence\n';
		expect(mergeHubBody(existing, fresh)).toBe('# Persistence\n\nUser prose.\n');
	});

	it('is idempotent (merging a fresh-only body twice is stable)', () => {
		const fresh = '# Persistence\n';
		const once = mergeHubBody(fresh, fresh);
		expect(mergeHubBody(once, fresh)).toBe(once);
	});

	it('members regenerate via the managed-key merge while user keys survive', () => {
		// Simulate a re-import: existing hub has user-added `reviewer`; fresh has new members.
		const existing = { curie: 'attack:facet/tactic/persistence', kind: 'facet', members: ['[[T1078]]'], reviewer: 'me' };
		const fresh = {
			curie: 'attack:facet/tactic/persistence',
			kind: 'facet',
			members: ['[[T1078]]', '[[T1098]]'],
		};
		const merged = mergeFrontmatter(existing, fresh, computeManagedKeys(fresh));
		expect(merged.members).toEqual(['[[T1078]]', '[[T1098]]']); // regenerated wholesale
		expect(merged.reviewer).toBe('me'); // user key preserved
	});
});

// ===========================================================================
// Multi-value link split (render managed_links)
// ===========================================================================

describe('render — managed_links multi-value split', () => {
	const recipe: Recipe = {
		recipe: 'nist',
		source: { ontology: 'nist' },
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{Control ID}.md' }],
			also_emit: { frontmatter: { managed_links: { related: { template: '{Related Controls}' } } } },
		},
	};

	it('splits a comma-separated cell into a wikilink array', () => {
		const addr = render(recipe, { curie: 'nist:AC-2', scope: { 'Control ID': 'AC-2', 'Related Controls': 'AC-1, AC-3, PM-9' } });
		expect(addr.frontmatter.related).toEqual(['[[AC-1]]', '[[AC-3]]', '[[PM-9]]']);
	});

	it('omits the key entirely for an empty cell (no dead empty array)', () => {
		const addr = render(recipe, { curie: 'nist:AC-2', scope: { 'Control ID': 'AC-2', 'Related Controls': '' } });
		expect('related' in addr.frontmatter).toBe(false);
	});

	it('splitLinkValues splits on comma and semicolon by default, trimming', () => {
		expect(splitLinkValues('AC-1, AC-3; PM-9')).toEqual(['AC-1', 'AC-3', 'PM-9']);
		expect(splitLinkValues('  solo  ')).toEqual(['solo']);
		expect(splitLinkValues('')).toEqual([]);
	});
});

// ===========================================================================
// parent_note relocation (design §5 case 5 + §4 re-import identity)
// ===========================================================================

/** attackBatch(), but T1078 is ALREADY folder-note-shaped (as if a prior
 *  import relocated it) — used to test the flip-back direction + idempotency.
 *  T1078 carries `renderedPath: 'T1078.md'` — the POSITIVE evidence that
 *  render() itself wants the sibling form this import (see the `renderedPath`
 *  doc comment in enrich.ts); without it, flip-back must not fire (that's the
 *  false-positive guard tested separately below). */
function relocatedBatch(): EnrichNote[] {
	return [
		note('T1078/T1078.md', 'T1078', '', 'Persistence', 'T1078.md'),
		note('T1078/T1078.001.md', 'T1078.001', 'T1078', 'Persistence'),
		note('T1078/T1078.002.md', 'T1078.002', 'T1078', 'Persistence'),
		note('T1078/T1078.003.md', 'T1078.003', 'T1078', 'Persistence'),
		note('T1078/T1078.004.md', 'T1078.004', 'T1078', 'Persistence'),
	];
}

describe('enrich — parent_note: folder-note relocation (design §5 case 5)', () => {
	it('relocates T1078.md → T1078/T1078.md (a colliding folder already exists)', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()),
			ontology: 'attack',
			config: { ...CONFIG, parent_note: 'folder-note' },
		});
		expect(result.relocations).toEqual([{ curie: 'attack:T1078', from: 'T1078.md', to: 'T1078/T1078.md' }]);
		expect(result.deviations).toEqual([
			'parent_note: relocated attack:T1078 to folder-note form (T1078.md → T1078/T1078.md).',
		]);
		// Children list keyed by the FINAL (relocated) path.
		expect(result.childrenByPath.has('T1078.md')).toBe(false);
		expect(result.childrenByPath.get('T1078/T1078.md')).toEqual([
			'[[T1078.001]]',
			'[[T1078.002]]',
			'[[T1078.003]]',
			'[[T1078.004]]',
		]);
	});

	it('relocations are processed in sorted-curie order (multi-parent determinism)', () => {
		const batch = [
			...attackBatch(),
			note('T1548.md', 'T1548', '', 'Privilege Escalation'),
			note('T1548/T1548.001.md', 'T1548.001', 'T1548', 'Privilege Escalation'),
		];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: { ...CONFIG, parent_note: 'folder-note' } });
		expect(result.relocations.map((r) => r.curie)).toEqual(['attack:T1078', 'attack:T1548']);
	});

	it('a parent with no children is left as a sibling (no folder to relocate into)', () => {
		const batch = [note('T1136.md', 'T1136', '', 'Persistence')];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: { ...CONFIG, parent_note: 'folder-note' } });
		expect(result.relocations).toEqual([]);
	});

	it('a parent whose children do NOT nest under its own folder is left as a sibling', () => {
		// flat-and-linked shape: parent link exists, but no folder mirrors T1078.
		const batch = [note('T1078.md', 'T1078', '', 'Persistence'), note('T1078.001.md', 'T1078.001', 'T1078', 'Persistence')];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: { ...CONFIG, parent_note: 'folder-note' } });
		expect(result.relocations).toEqual([]);
	});

	it('is idempotent: an already folder-note-shaped parent is not relocated again', () => {
		const result = enrich(relocatedBatch(), { writeSet: writable(relocatedBatch()), ontology: 'attack', config: { ...CONFIG, parent_note: 'folder-note' } });
		expect(result.relocations).toEqual([]);
		expect(result.deviations).toEqual([]);
		expect(result.childrenByPath.get('T1078/T1078.md')).toHaveLength(4);
	});

	it('streamed sources fall back to sibling with a deviation (v1 restriction)', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()),
			ontology: 'attack',
			config: { ...CONFIG, parent_note: 'folder-note' },
			streamed: true,
		});
		expect(result.relocations).toEqual([]);
		expect(result.deviations).toHaveLength(1);
		expect(result.deviations[0]).toMatch(/requires an eager \(non-streamed\) source/);
		expect(result.childrenByPath.get('T1078.md')).toHaveLength(4);
	});

	it('a batch-occupied target path is a collision guard, not a crash', () => {
		const batch = [
			...attackBatch(),
			// An unrelated note happens to already occupy the relocation target.
			note('T1078/T1078.md', 'other', '', 'Persistence'),
		];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: { ...CONFIG, parent_note: 'folder-note' } });
		expect(result.relocations).toEqual([]);
		expect(result.deviations).toHaveLength(1);
		expect(result.deviations[0]).toMatch(/could not relocate attack:T1078/);
		// Left at the sibling path — children list unaffected.
		expect(result.childrenByPath.get('T1078.md')).toHaveLength(4);
	});

	it('sibling placement (default) records no deviation and no relocations', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(result.deviations).toEqual([]);
		expect(result.relocations).toEqual([]);
	});
});

describe('enrich — parent_note flip-back: folder-note → sibling (design §4, least-surprising)', () => {
	it('relocates an already folder-note-shaped parent back to sibling when the config no longer asks for folder-note', () => {
		const result = enrich(relocatedBatch(), { writeSet: writable(relocatedBatch()), ontology: 'attack', config: CONFIG }); // config: parent_note 'sibling'
		expect(result.relocations).toEqual([{ curie: 'attack:T1078', from: 'T1078/T1078.md', to: 'T1078.md' }]);
		expect(result.deviations).toEqual([
			'parent_note: relocated attack:T1078 back to sibling form (T1078/T1078.md → T1078.md).',
		]);
		expect(result.childrenByPath.has('T1078/T1078.md')).toBe(false);
		expect(result.childrenByPath.get('T1078.md')).toHaveLength(4);
	});

	it('flip-back also fires when parent_note is left unset (sibling is the implicit default)', () => {
		const { parent_note, ...rest } = CONFIG;
		void parent_note;
		const result = enrich(relocatedBatch(), { writeSet: writable(relocatedBatch()), ontology: 'attack', config: rest });
		expect(result.relocations).toHaveLength(1);
		expect(result.relocations[0].to).toBe('T1078.md');
	});

	it('is idempotent: an already sibling-shaped batch has nothing to flip back', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		expect(result.relocations).toEqual([]);
	});

	// The false-positive this whole `renderedPath` mechanism exists to prevent:
	// a note that is folder-note-SHAPED (X/X.md) purely because that's what its
	// OWN recipe layout always produces (e.g. NIST-CSF's committed golden
	// `GV/GV.md` — a fixed top-level folder whose value equals the leaf's own
	// basename), NOT because any parent_note relocation ever touched it. Path
	// shape alone can't distinguish the two cases; only `renderedPath` (or its
	// absence, here) can.
	it('does NOT flip back a note that is natively folder-note-shaped by its own recipe layout (no renderedPath evidence)', () => {
		const nativelyNested = [
			note('GV/GV.md', 'GV', '', 'Govern'), // no renderedPath — render() intends exactly this path.
			note('GV/GV.OC.md', 'GV.OC', 'GV', 'Govern'),
		];
		const result = enrich(nativelyNested, { writeSet: writable(nativelyNested), ontology: 'csf', config: CONFIG });
		expect(result.relocations).toEqual([]);
		expect(result.deviations).toEqual([]);
	});
});

// ===========================================================================
// extractWikilinkTargets (empty [[]] ignored)
// ===========================================================================

describe('enrich — parent resolution ignores empty [[]]', () => {
	it('empty parent link yields no children edge', () => {
		expect(extractWikilinkTargets('[[]]')).toEqual([]);
		// Root T1078 has parent "[[]]" — it must not become its own or anyone's child.
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		let rootChildEdges = 0;
		for (const kids of result.childrenByPath.values()) rootChildEdges += kids.length;
		expect(rootChildEdges).toBe(4); // only the 4 real sub-techniques
	});
});

// ---------------------------------------------------------------------------
// Helper — a stable serialization of an EnrichmentResult for deep-equal.
// ---------------------------------------------------------------------------

function serialize(r: ReturnType<typeof enrich>): unknown {
	return {
		children: [...r.childrenByPath.entries()].sort(),
		hubs: r.hubs,
		edgeCount: r.edgeCount,
		deviations: r.deviations,
		relocations: r.relocations,
	};
}

// ===========================================================================
// Level hubs (hierarchy MOCs) — 2026-07-11 ICSB emitter-controls gap audit #1
// ===========================================================================

const LEVEL_HUB_CONFIG = { ...CONFIG, level_hubs: 'notes' as const };

describe('enrich — level hubs off by default (no config change)', () => {
	it('level_hubs omitted → no hosted patches, no synthetic notes, edgeCount unchanged', () => {
		const withoutHubs = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		const withHubsOff = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: { ...CONFIG, level_hubs: 'none' } });
		expect(withoutHubs.levelHubs.hostedChildrenByPath.size).toBe(0);
		expect(withoutHubs.levelHubs.notes).toEqual([]);
		expect(withHubsOff.levelHubs.hostedChildrenByPath.size).toBe(0);
		expect(withHubsOff.edgeCount).toBe(withoutHubs.edgeCount);
	});
});

describe('enrich — level hubs, hosted case (a sibling/folder-note IS the folder)', () => {
	it('T1078.md (sibling, folder T1078/ holds its children) hosts the folder\'s Contents list', () => {
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: LEVEL_HUB_CONFIG });
		expect(result.levelHubs.hostedChildrenByPath.get('T1078.md')).toEqual([
			'[[T1078.001]]',
			'[[T1078.002]]',
			'[[T1078.003]]',
			'[[T1078.004]]',
		]);
		expect(result.levelHubs.notes).toEqual([]); // no pure-structural folder in this fixture
	});

	it('the same relation also works when the concept is folder-note shaped (T1078/T1078.md)', () => {
		const folderNoteBatch: EnrichNote[] = [
			{ path: 'T1078/T1078.md', curie: 'attack:T1078', frontmatter: { curie: 'attack:T1078' }, facets: [] },
			{ path: 'T1078/T1078.001.md', curie: 'attack:T1078.001', frontmatter: { parent: '[[T1078]]', curie: 'attack:T1078.001' }, facets: [] },
			{ path: 'T1078/T1078.002.md', curie: 'attack:T1078.002', frontmatter: { parent: '[[T1078]]', curie: 'attack:T1078.002' }, facets: [] },
		];
		const result = enrich(folderNoteBatch, { writeSet: writable(folderNoteBatch), ontology: 'attack', config: { level_hubs: 'notes' } });
		expect(result.levelHubs.hostedChildrenByPath.get('T1078/T1078.md')).toEqual(['[[T1078.001]]', '[[T1078.002]]']);
		expect(result.levelHubs.notes).toEqual([]);
	});

	it('edgeCount includes hosted level-hub child links (sum-not-dedupe, same convention as children_lists)', () => {
		const without = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: CONFIG });
		const withHubs = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: LEVEL_HUB_CONFIG });
		// 4 hosted children counted again, on top of children_lists' own 4.
		expect(withHubs.edgeCount).toBe(without.edgeCount + 4);
	});
});

describe('enrich — level hubs, synthetic case (pure structural folder, no matching concept note)', () => {
	function familyBatch(): EnrichNote[] {
		return [
			{ path: 'Persistence/T1078.md', curie: 'attack:T1078', frontmatter: {}, facets: [] },
			{ path: 'Persistence/T1098.md', curie: 'attack:T1098', frontmatter: {}, facets: [] },
		];
	}

	it('creates a synthetic hub note at <folder>/<folder>.md with kind: hub and a managed Contents section', () => {
		const result = enrich(familyBatch(), { writeSet: writable(familyBatch()), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Persistence' });
		expect(result.levelHubs.hostedChildrenByPath.size).toBe(0);
		expect(result.levelHubs.notes).toHaveLength(1);
		const hub = result.levelHubs.notes[0];
		expect(hub.path).toBe('Persistence/Persistence.md');
		// This folder IS the import root, so its path relative to the root is
		// empty and it takes the reserved local part. The address-derived form it
		// used to carry travels as an alias so hubs already written under it stay
		// reconcilable (see the hub-identity block at the bottom of this file).
		expect(hub.curie).toBe('attack:hub/_root');
		expect(hub.legacyCuries).toEqual(['attack:hub/persistence']);
		expect(hub.frontmatter.kind).toBe('hub');
		expect(hub.frontmatter.children).toEqual(['[[T1078]]', '[[T1098]]']);
		expect(hub.childrenLinks).toEqual(['[[T1078]]', '[[T1098]]']);
		expect(hub.body).toContain('# Persistence');
		expect(hub.body).toContain('- [[T1078]]');
		expect(hub.body).toContain('- [[T1098]]');
	});

	it('hub notes are sorted by path, deterministic across input order', () => {
		const shuffled = [familyBatch()[1], familyBatch()[0]];
		const result = enrich(shuffled, { writeSet: writable(shuffled), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Persistence' });
		expect(result.levelHubs.notes[0].frontmatter.children).toEqual(['[[T1078]]', '[[T1098]]']);
	});
});

describe('enrich — level hubs, root/home hub (design step 4.5 root fallback)', () => {
	it('rootFolder that IS a tracked ancestor (real basePath usage) gets its hub via the uniform per-folder pass, no double-create', () => {
		// Every path already prefixed by the basePath, exactly like generation-engine.
		const batch: EnrichNote[] = [
			{ path: 'Frameworks/MITRE/T1078.md', curie: 'attack:T1078', frontmatter: {}, facets: [] },
			{ path: 'Frameworks/MITRE/T1078/T1078.001.md', curie: 'attack:T1078.001', frontmatter: { parent: '[[T1078]]' }, facets: [] },
		];
		const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Frameworks/MITRE' });
		// One hub for the root (hosted by nothing → synthetic at Frameworks/MITRE/MITRE.md)
		// and the T1078 folder is hosted by the sibling note. No duplicate root note.
		const rootHubs = result.levelHubs.notes.filter((h) => h.path === 'Frameworks/MITRE/MITRE.md');
		expect(rootHubs).toHaveLength(1);
		expect(rootHubs[0].frontmatter.children).toEqual(['[[T1078]]']);
		// The destination is two segments deep and NONE of it reaches the identity.
		expect(rootHubs[0].curie).toBe('attack:hub/_root');
		expect(rootHubs[0].legacyCuries).toEqual(['attack:hub/frameworks/mitre']);
		expect(result.levelHubs.hostedChildrenByPath.get('Frameworks/MITRE/T1078.md')).toEqual(['[[T1078.001]]']);
	});

	it('rootFolder that is NOT a tracked ancestor (bare golden-vault harness) falls back to a top-level home note with no duplicate entries', () => {
		// attackBatch()'s paths are never prefixed by "attack-corpus" — the exact
		// shape tests/helpers/golden-vault.ts hits (rootFolder: corpusId).
		const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: LEVEL_HUB_CONFIG, rootFolder: 'attack-corpus' });
		const home = result.levelHubs.notes.find((h) => h.path === 'attack-corpus.md');
		expect(home).toBeDefined();
		// T1078.md is BOTH a top-level sibling file AND the host of the T1078/
		// folder — it must appear exactly once, not duplicated (the bug this
		// fixture pins: naive "top files" ∪ "top folders" double-counts a
		// sibling-shaped parent).
		expect(home!.frontmatter.children).toEqual(['[[T1078]]']);
	});

	it('a fully flat batch (no folders at all) still gets a home note linking every note', () => {
		const flat: EnrichNote[] = [
			{ path: 'A.md', curie: 'attack:A', frontmatter: {}, facets: [] },
			{ path: 'B.md', curie: 'attack:B', frontmatter: {}, facets: [] },
		];
		const result = enrich(flat, { writeSet: writable(flat), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'flat-corpus' });
		const home = result.levelHubs.notes.find((h) => h.path === 'flat-corpus.md');
		expect(home!.frontmatter.children).toEqual(['[[A]]', '[[B]]']);
	});

	// 2026-07-11: facet hub notes (step 4) and level hubs (step 4.5) both
	// materialize in the SAME Pass 1.5 run but couldn't see each other — the
	// root/home hub's Contents omitted facet hubs even though both land in the
	// same folder (found via the e2e "furnished vault" spec's view-13 note).
	// The ROOT hub only gets a separate "Facets" sub-list; `frontmatter.children`
	// (the structural children) is untouched — facets are a body-only addition.
	describe('root hub Facets sub-list (facet hubs + level hubs, same batch)', () => {
		it('bare-harness root home note gains a Facets group alongside its structural Contents', () => {
			// attackBatch(): 5 notes, all facet tactic=Persistence → 1 facet hub
			// (>= HUB_MIN_MEMBERS). LEVEL_HUB_CONFIG turns on both facet_notes and
			// level_hubs, exactly like browsable-framework's preset defaults.
			const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: LEVEL_HUB_CONFIG, rootFolder: 'attack-corpus' });
			expect(result.hubs.map((h) => h.path)).toEqual(['Persistence.md']); // step 4 already ran
			const home = result.levelHubs.notes.find((h) => h.path === 'attack-corpus.md')!;
			expect(home.frontmatter.children).toEqual(['[[T1078]]']); // structural children unaffected
			expect(home.facetLinks).toEqual(['[[Persistence]]']);
			expect(home.body).toContain('**Facets:**');
			expect(home.body).toContain('- [[Persistence]]');
			// The Facets group comes AFTER the Contents bullet list, both still
			// inside the single managed block (one start/end marker pair).
			const start = home.body.indexOf('## Contents');
			const facetsIdx = home.body.indexOf('**Facets:**');
			expect(facetsIdx).toBeGreaterThan(start);
			expect((home.body.match(/crosswalker:children:start/g) ?? []).length).toBe(1);
			expect((home.body.match(/crosswalker:children:end/g) ?? []).length).toBe(1);
		});

		it('a tracked-ancestor root (real generation-engine basePath usage) also gains the Facets group', () => {
			const batch: EnrichNote[] = [
				{ path: 'Frameworks/T1078.md', curie: 'attack:T1078', frontmatter: {}, facets: [{ namespace: 'tactic', value: 'Persistence' }] },
				{ path: 'Frameworks/T1078/T1078.001.md', curie: 'attack:T1078.001', frontmatter: { parent: '[[T1078]]' }, facets: [{ namespace: 'tactic', value: 'Persistence' }] },
			];
			const result = enrich(batch, { writeSet: writable(batch), ontology: 'attack', config: LEVEL_HUB_CONFIG, rootFolder: 'Frameworks' });
			const root = result.levelHubs.notes.find((h) => h.path === 'Frameworks/Frameworks.md')!;
			expect(root.facetLinks).toEqual(['[[Persistence]]']);
			expect(root.body).toContain('**Facets:**\n- [[Persistence]]');
		});

		it('no facet hubs materialized (below HUB_MIN_MEMBERS) → no Facets group, no empty label', () => {
			const singleton: EnrichNote[] = [
				{ path: 'A.md', curie: 'attack:A', frontmatter: {}, facets: [{ namespace: 'tactic', value: 'Impact' }] },
				{ path: 'B.md', curie: 'attack:B', frontmatter: {}, facets: [{ namespace: 'tactic', value: 'Impact' }] },
				{ path: 'C.md', curie: 'attack:C', frontmatter: {}, facets: [] },
			];
			// Only 2 members hit HUB_MIN_MEMBERS exactly, so flip facet_notes off
			// to isolate "no facet hubs exist at all" from the min-members guard.
			const result = enrich(singleton, { writeSet: writable(singleton), ontology: 'attack', config: { ...LEVEL_HUB_CONFIG, facet_notes: 'none' }, rootFolder: 'flat' });
			const home = result.levelHubs.notes.find((h) => h.path === 'flat.md')!;
			expect(home.facetLinks).toBeUndefined();
			expect(home.body).not.toContain('**Facets:**');
		});

		it('re-import merge rebuilds the Facets group from hub.facetLinks (does not depend on re-parsing body)', () => {
			// Mirrors generation-engine.ts's re-import path: buildManagedChildrenSection
			// is called fresh with childrenLinks + a facetGroup derived from facetLinks,
			// then merged over whatever body the vault currently holds.
			const result = enrich(attackBatch(), { writeSet: writable(attackBatch()), ontology: 'attack', config: LEVEL_HUB_CONFIG, rootFolder: 'attack-corpus' });
			const home = result.levelHubs.notes.find((h) => h.path === 'attack-corpus.md')!;
			const facetGroup = home.facetLinks ? [{ label: 'Facets', links: home.facetLinks }] : [];
			const fresh = buildManagedChildrenSection('Contents', home.childrenLinks ?? [], facetGroup);
			const existingBody = '# attack-corpus\n\nMy own notes about this import.\n';
			const merged = mergeManagedChildrenSection(existingBody, fresh);
			expect(merged).toContain('My own notes about this import.');
			expect(merged).toContain('- [[T1078]]');
			expect(merged).toContain('**Facets:**\n- [[Persistence]]');
			// Idempotent: merging the same fresh section again is stable.
			expect(mergeManagedChildrenSection(merged, fresh)).toBe(merged);
		});
	});
});

describe('managed children section — re-import safety (strip-and-reappend, same discipline as facet hubs)', () => {
	it('buildManagedChildrenSection wraps a heading + bullet list in delimiter markers', () => {
		const section = buildManagedChildrenSection('Contents', ['[[A]]', '[[B]]']);
		expect(section).toContain('## Contents');
		expect(section).toContain('- [[A]]');
		expect(section).toContain('- [[B]]');
		expect(section).toMatch(/crosswalker:children:start/);
		expect(section).toMatch(/crosswalker:children:end/);
	});

	it('extraGroups appends an additional labeled sub-list inside the SAME managed block', () => {
		const section = buildManagedChildrenSection('Contents', ['[[T1078]]'], [{ label: 'Facets', links: ['[[Persistence]]', '[[Defense Evasion]]'] }]);
		expect(section).toContain('## Contents\n- [[T1078]]');
		expect(section).toContain('**Facets:**\n- [[Persistence]]\n- [[Defense Evasion]]');
		// Still exactly one marker pair — one managed block, not two.
		expect(section.match(/crosswalker:children:start/g)?.length).toBe(1);
		expect(section.match(/crosswalker:children:end/g)?.length).toBe(1);
	});

	it('an extraGroup with zero links is omitted entirely (no empty label)', () => {
		const section = buildManagedChildrenSection('Contents', ['[[T1078]]'], [{ label: 'Facets', links: [] }]);
		expect(section).not.toContain('Facets');
	});

	it('appends the section when no managed block exists yet', () => {
		const existing = '# T1078\n\nSome user prose about this technique.\n';
		const fresh = buildManagedChildrenSection('Contents', ['[[T1078.001]]']);
		const merged = mergeManagedChildrenSection(existing, fresh);
		expect(merged).toContain('Some user prose about this technique.');
		expect(merged).toContain('- [[T1078.001]]');
	});

	it('regenerates ONLY the managed block on re-import — user prose before, between, and after survives', () => {
		const previousSection = buildManagedChildrenSection('Contents', ['[[T1078.001]]']);
		const existing = `# T1078\n\nIntro prose.\n\n${previousSection}\nOutro prose.\n`;
		const freshSection = buildManagedChildrenSection('Contents', ['[[T1078.001]]', '[[T1078.002]]']);
		const merged = mergeManagedChildrenSection(existing, freshSection);
		expect(merged).toContain('Intro prose.');
		expect(merged).toContain('Outro prose.');
		expect(merged).toContain('- [[T1078.002]]'); // regenerated
		// Exactly one managed block survives (not duplicated).
		expect(merged.match(/crosswalker:children:start/g)?.length).toBe(1);
	});

	it('is idempotent — merging the same fresh section twice is stable', () => {
		const fresh = buildManagedChildrenSection('Contents', ['[[A]]']);
		const once = mergeManagedChildrenSection('# Title\n', fresh);
		const twice = mergeManagedChildrenSection(once, fresh);
		expect(twice).toBe(once);
	});
});

describe('ensureWaypointMarker — opt-in, additive, idempotent (2026-07-11 ICSB audit §4 verdict)', () => {
	it('appends the trigger comment when absent', () => {
		const body = ensureWaypointMarker('# T1078\n\nSome content.\n');
		expect(body).toContain('%% Waypoint %%');
	});

	it('does not duplicate the marker on a second call', () => {
		const once = ensureWaypointMarker('# T1078\n');
		const twice = ensureWaypointMarker(once);
		expect(twice).toBe(once);
	});

	it('never strips or duplicates a block Waypoint has already expanded', () => {
		const expanded = '# T1078\n\n%% Begin Waypoint %%\n- [[Some Note]]\n%% End Waypoint %%\n';
		expect(ensureWaypointMarker(expanded)).toBe(expanded);
	});
});

// ===========================================================================
// F-4 / F-5: hub identity does not encode the hub's address.
//
// A level hub's curie used to be derived from its FULL vault path
// (`${ontology}:hub/${slugPath(folder)}`), so changing an import's destination
// did not merely relocate a hub, it RENAMED it. The note at the old address kept
// a curie nothing would ever claim again (a permanent orphan) while a second note
// was created for the "new" identity. This is the same rule the rest of the
// codebase already obeys -- identity must not be derived from address -- broken
// one level deeper than concepts.
//
// The superseded absolute form travels on `legacyCuries` because a hub CAN carry
// user prose and user frontmatter (generation-engine.ts routes both hub kinds
// through the merge path), so regenerating one at the new address and deleting
// the old is not available: it would destroy that content.
//
// The legacy forms below are the shapes real vaults hold. Both appear verbatim in
// this repo's own test-vault, written by an earlier build:
//   test-vault/Frameworks/Frameworks.md                   -> shape-workbench:hub/frameworks
//   test-vault/Frameworks/MITRE ATT&CK/MITRE ATT&CK.md    -> shape-workbench:hub/frameworks/mitre-att-ck
// ===========================================================================

describe('enrich -- hub identity is independent of the destination (F-4)', () => {
	/** The same two-concept import, rendered under any destination folder. */
	function importedInto(root: string): EnrichNote[] {
		return [
			{ path: `${root}/Persistence/T1078.md`, curie: 'attack:T1078', frontmatter: {}, facets: [] },
			{ path: `${root}/Persistence/T1098.md`, curie: 'attack:T1098', frontmatter: {}, facets: [] },
		];
	}

	function hubCuries(root: string): string[] {
		const result = enrich(importedInto(root), { writeSet: writable(importedInto(root)), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: root });
		return result.levelHubs.notes.map((h) => h.curie).sort();
	}

	it('a sub-folder hub is named by its path RELATIVE to the import root', () => {
		const result = enrich(importedInto('Ontologies'), { writeSet: writable(importedInto('Ontologies')),
			ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Ontologies',
		});
		const sub = result.levelHubs.notes.find((h) => h.path === 'Ontologies/Persistence/Persistence.md')!;
		expect(sub.curie).toBe('attack:hub/persistence');
		expect(sub.curie).not.toContain('ontologies');
	});

	it('the SAME import under a different destination produces the SAME hub identities', () => {
		// The single property F-4 exists for. Pre-fix these two lists differ in
		// every element, which is why moving a destination orphaned every hub.
		expect(hubCuries('Ontologies')).toEqual(hubCuries('Ontologies/attack-mini'));
		expect(hubCuries('Ontologies')).toEqual(['attack:hub/_root', 'attack:hub/persistence']);
	});

	it('carries the superseded address-derived form as an alias, per destination', () => {
		const flat = enrich(importedInto('Ontologies'), { writeSet: writable(importedInto('Ontologies')),
			ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Ontologies',
		}).levelHubs.notes;
		expect(flat.map((h) => [h.curie, h.legacyCuries])).toEqual([
			['attack:hub/_root', ['attack:hub/ontologies']],
			['attack:hub/persistence', ['attack:hub/ontologies/persistence']],
		]);

		// Hub order follows path, which reorders under a nested root, so compare
		// the alias SET rather than pinning an incidental sort.
		const nested = enrich(importedInto('Ontologies/attack-mini'), { writeSet: writable(importedInto('Ontologies/attack-mini')),
			ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Ontologies/attack-mini',
		}).levelHubs.notes;
		expect(nested.flatMap((h) => h.legacyCuries ?? []).sort()).toEqual([
			'attack:hub/ontologies/attack-mini',
			'attack:hub/ontologies/attack-mini/persistence',
		]);
	});

	it('the reserved root local part cannot collide with a real folder name', () => {
		// Slugging lowercases and strips to [a-z0-9-], so no folder a user can
		// create produces a leading underscore. A folder literally named "_root"
		// slugs to "root" and stays distinct from the reserved "_root".
		const underscoreRoot: EnrichNote[] = [
			{ path: 'Ontologies/_root/T1078.md', curie: 'attack:T1078', frontmatter: {}, facets: [] },
			{ path: 'Ontologies/_root/T1098.md', curie: 'attack:T1098', frontmatter: {}, facets: [] },
		];
		const result = enrich(underscoreRoot, { writeSet: writable(underscoreRoot), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'Ontologies' });
		const curies = result.levelHubs.notes.map((h) => h.curie);
		expect(curies).toContain('attack:hub/_root');
		expect(curies).toContain('attack:hub/root');
		expect(new Set(curies).size).toBe(curies.length);
	});

	it('the bare-harness fallback root (not a tracked ancestor) also takes the reserved local part', () => {
		// golden-vault.ts passes a corpus id that prefixes nothing. The home note
		// it produces must not be named after that id either, or the same import
		// run through the harness and through generation would disagree.
		const bareHarness: EnrichNote[] = [
			{ path: 'A.md', curie: 'attack:A', frontmatter: {}, facets: [] },
			{ path: 'B.md', curie: 'attack:B', frontmatter: {}, facets: [] },
		];
		const result = enrich(bareHarness, { writeSet: writable(bareHarness), ontology: 'attack', config: { level_hubs: 'notes' }, rootFolder: 'flat-corpus' });
		const home = result.levelHubs.notes.find((h) => h.path === 'flat-corpus.md')!;
		expect(home.curie).toBe('attack:hub/_root');
		expect(home.legacyCuries).toEqual(['attack:hub/flat-corpus']);
	});
});
