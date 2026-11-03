import { enrich, type EnrichNote } from '../src/generation/enrich';

const note = (path: string, curie: string, parent?: string): EnrichNote => ({
	path, curie, frontmatter: parent ? { parent: `[[${parent}]]` } : {}, facets: [],
});
const writeSet = (notes: EnrichNote[]) => new Set(notes.map((n) => n.path));

describe('enrichment navigation resolves duplicate basenames within the final import', () => {
	it('qualifies duplicate child names while keeping unique child output unchanged', () => {
		const notes = [
			note('F/P.md', 'test:P'), note('F/A/X.md', 'test:a', 'P'),
			note('F/B/X.md', 'test:b', 'P'), note('F/C/Y.md', 'test:c', 'P'),
		];
		const result = enrich(notes, { writeSet: writeSet(notes), ontology: 'test', config: { children_lists: true } });
		expect(result.childrenByPath.get('F/P.md')).toEqual(['[[F/A/X|X]]', '[[F/B/X|X]]', '[[Y]]']);
	});

	it('counts synthetic indexes, never links a GV hub to itself, and distinguishes WR indexes', () => {
		const notes = [
			note('F/GV/GV/GV.md', 'test:GV'), note('F/GV/GV.OC/GV.OC.md', 'test:GV.OC'),
			note('F/WR-a/WR/X.md', 'test:X'), note('F/WR-b/WR/Y.md', 'test:Y'),
		];
		const run = (batch: EnrichNote[]) => enrich(batch, {
			writeSet: writeSet(batch), ontology: 'test', rootFolder: 'F', config: { level_hubs: 'notes', children_lists: true },
		});
		const result = run(notes);
		const gv = result.levelHubs.notes.find((hub) => hub.path === 'F/GV/GV.md')!;
		expect(gv.frontmatter.children).toEqual(['[[F/GV/GV/GV|GV]]', '[[GV.OC]]']);
		expect(gv.childrenLinks).toEqual(gv.frontmatter.children);
		expect(gv.body).toContain('- [[F/GV/GV/GV|GV]]');
		expect(gv.body).not.toContain('[[GV]]');
		for (const branch of ['WR-a', 'WR-b']) {
			const hub = result.levelHubs.notes.find((h) => h.path === `F/${branch}/${branch}.md`)!;
			expect(hub.childrenLinks).toEqual([`[[F/${branch}/WR/WR|WR]]`]);
		}
		expect(run([...notes].reverse())).toEqual(result);
	});

	it('qualifies facet membership and root facet links when a facet hub shares a concept basename', () => {
		const notes = [note('F/Hub/Hub.md', 'test:A'), note('F/Other.md', 'test:B')];
		for (const n of notes) n.facets = [{ namespace: 'tactic', value: 'Hub' }];
		const result = enrich(notes, {
			writeSet: writeSet(notes), ontology: 'test', rootFolder: 'F',
			config: { facet_notes: 'notes', level_hubs: 'notes' },
		});
		expect(result.hubs[0].frontmatter.members).toEqual(['[[F/Hub/Hub|Hub]]', '[[Other]]']);
		const root = result.levelHubs.notes.find((hub) => hub.path === 'F/F.md')!;
		expect(root.facetLinks).toEqual(['[[F/Hub|Hub]]']);
		expect(root.body).toContain('- [[F/Hub|Hub]]');
	});
});
