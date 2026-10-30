import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, type Recipe } from '../src/render';
import { validateRecipe } from '../src/validation/validator';
import { d3fendNames, d3fendControlMappings, d3fendAttackMappings, mappingPairDiff, mappingResolution, publicCsv } from '../tools/lib/demo-public-sources';

const recipe = (file: string): Recipe => JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8')) as Recipe;
const attack = recipe('tools/fixtures/demo/recipes/mitre-attack-demo-full.json');
const mitigations = recipe('recipes/import/mitre-attack-mitigation.json');
const d3fend = recipe('recipes/import/mitre-d3fend.json');
const catalog = [{ ID: 'D3-TEST', 'D3FEND Tactic': 'Test', 'D3FEND Technique': 'Test technique' }];

describe('public demo source preparation', () => {
	it('reads quoted CSV cells and rejects malformed data', () => {
		expect(publicCsv('ID,Name\nA,"One, two"\n')).toEqual([{ ID: 'A', Name: 'One, two' }]);
		expect(() => publicCsv('ID,Name\nA,B,C')).toThrow('Invalid public demo CSV');
	});

	it('uses all sparse name levels without inventing parent rows', () => {
		expect(d3fendNames([...catalog, { ID: 'D3-CHILD', 'D3FEND Technique Level 0': 'Child' }])).toEqual(new Map([['Test technique', 'D3-TEST'], ['Child', 'D3-CHILD']]));
		expect(() => d3fendNames([...catalog, ...catalog])).toThrow('unique');
		expect(() => d3fendNames([...catalog, { ID: 'D3-TEST', 'D3FEND Technique Level 1': 'Different name' }])).toThrow('unique');
		expect(() => d3fendNames([{ ID: 'D3-TEST', 'D3FEND Technique': 'One', 'D3FEND Technique Level 0': 'Two' }])).toThrow('one name');
	});

	it.each(['broader', 'narrower', 'related', 'exactly', ''])('does not guess the publisher direction for %s', (relation) => {
		expect(d3fendControlMappings([{ Control: 'AC-02(01)', Technique: 'Test technique', Relation: relation }], d3fendNames(catalog))).toEqual([{
			subject_id: 'nist-800-53:AC-2(1)', object_id: 'mitre-d3fend:D3-TEST', predicate_id: 'skos:relatedMatch',
			mapping_justification: 'semapv:ManualMappingCuration', source_relation: relation,
		}]);
	});

	it('never silently drops an unknown catalog name', () => {
		expect(() => d3fendControlMappings([{ Control: 'AC-2', Technique: 'Absent' }], d3fendNames(catalog))).toThrow('unknown technique');
	});

	it('expands many defensive ids, keeps M ids and counts empty publisher rows', () => {
		const result = d3fendAttackMappings([
			{ 'ATT&CK ID': 'M1001', 'Related D3FEND Techniques': 'D3-ONE [One](url)<br>D3-TWO [Two](url) D3-ONE' },
			{ 'ATT&CK ID': 'M1002', 'Related D3FEND Techniques': '' },
		]);
		expect(result.emptyRows).toBe(1);
		expect(() => d3fendAttackMappings([{ 'ATT&CK ID': 'T1000', 'Related D3FEND Techniques': 'D3-ONE' }])).toThrow('mitigation id');
		expect(result.rows.map((row) => [row.subject_id, row.object_id, row.predicate_id])).toEqual([
			['mitre-attack:M1001', 'mitre-d3fend:D3-ONE', 'skos:relatedMatch'],
			['mitre-attack:M1001', 'mitre-d3fend:D3-TWO', 'skos:relatedMatch'],
		]);
	});

	it('diffs endpoint pairs independently of predicates and retains strength as a reason for a separate set', () => {
		const rows = d3fendControlMappings([{ Control: 'AC-2', Technique: 'Test technique' }], d3fendNames(catalog));
		expect(mappingPairDiff(rows, [{ ...rows[0], confidence: 0.7 }])).toEqual({ existingPairs: 1, incomingPairs: 1, added: 0, removed: 0, strengthRows: 1 });
		expect(mappingResolution(rows, new Set(['mitre-d3fend:D3-TEST']))).toMatchObject({ rows: 1, subjectResolved: 0, objectResolved: 1, bothResolved: 0, missingSubjects: ['nist-800-53:AC-2'] });
	});
});

describe('public demo recipes', () => {
	it.each([attack, mitigations, d3fend])('validates $recipe', (value) => {
		expect(validateRecipe(value)).toMatchObject({ valid: true, errors: [] });
	});

	it('keeps the shipped ATT&CK body and facets while deriving only real dotted parents', () => {
		const shipped = recipe('recipes/import/mitre-attack-technique.json');
		expect(attack.target.also_emit?.body).toEqual(shipped.target.also_emit?.body);
		const scope = { ID: 'T1000.001', name: 'Synthetic child', description: 'Synthetic description' };
		const child = render(attack, { curie: 'mitre-attack:T1000.001', scope });
		expect(child.frontmatter.parent).toBe('[[T1000]]');
		expect(child.frontmatter.parent_curie).toBe('mitre-attack:T1000');
		expect(render(attack, { curie: 'mitre-attack:T1000', scope: { ...scope, ID: 'T1000' } }).frontmatter.parent).toBeUndefined();
	});

	it('imports mitigation identities without claiming they are techniques', () => {
		const note = render(mitigations, { curie: 'mitre-attack:M1001', scope: { ID: 'M1001', name: 'Synthetic mitigation', description: 'Synthetic prose', version: '1.0' } });
		expect(note.primary.path).toBe('M1001.md');
		expect(note.frontmatter.mitigation_id).toBe('M1001');
		expect(note.frontmatter.mitigation_version).toBe('1.0');
		expect(note.frontmatter).not.toHaveProperty('technique_id');
		expect(note.frontmatter).not.toHaveProperty('technique_version');
		expect(note.tags).toContain('mitre-attack');
	});

	it.each(['D3FEND Technique', 'D3FEND Technique Level 0', 'D3FEND Technique Level 1'])('names a sparse row at %s', (column) => {
		const note = render(d3fend, { curie: 'mitre-d3fend:D3-TEST', scope: { ID: 'D3-TEST', 'D3FEND Tactic': 'Test', [column]: 'Synthetic technique' } });
		expect(note.frontmatter.title).toBe('Synthetic technique');
		expect(note.frontmatter).not.toHaveProperty('parent');
	});
});
