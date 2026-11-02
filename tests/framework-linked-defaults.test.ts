/** Recommended defaults add navigation, never rewrite shipped recipes or saved sets. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Papa from 'papaparse';
import { load } from 'js-yaml';
import ts from 'typescript';
import { runCli } from '../cli/crosswalker';
import { createFsApp } from '../cli/fs-app';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './cli/helpers';
import { RECIPE_REGISTRY, findRecognizedRecipes, matchScore, type RecipeRegistryEntry } from '../src/import/recipe-registry';
import { existingFrameworkNotice, honestEnrichment, shouldAutoApplyRecognizedMatch } from '../src/import/import-wizard';
import { serializeCanonicalRecipe } from '../src/import/recipe-document';
import { recipeChangedSinceRun, recipeRunDigest } from '../src/import/recipe-runs';
import { frameworkSlots, DEFAULT_STACK_SELECTION } from '../src/import/stack/stack-model';
import { generateNotes } from '../src/generation/generation-engine';
import { discoverImportSets } from '../src/generation/import-set';
import { edgeEndpointIndex, resolveEdgeEndpoints } from '../src/generation/edge-endpoints';
import { deriveRecipeFacetMemberships } from '../src/import/mapping/facets';
import { validateRecipe } from '../src/validation/validator';
import type { Recipe } from '../src/render';

installByteFile();
const SET = 'iset-a0f1e2';
const DEST = 'Frameworks/Synthetic';
const entry = (id: string): RecipeRegistryEntry => RECIPE_REGISTRY.find((item) => item.id === id)!;
const ROWS = {
	'nist-csf-2-linked': [
		{ Subcategory: 'GV.OC-01: Synthetic first outcome', 'Implementation Examples': 'Synthetic example' },
		{ Subcategory: 'GV.OC-02: Synthetic second outcome', 'Implementation Examples': '' },
	],
	'nist-800-53-linked': [
		{ identifier: 'ZZ-1', name: 'Synthetic control', control_text: 'Synthetic text', discussion: '', related: 'ZZ-1(1)' },
		{ identifier: 'ZZ-1(1)', name: 'Synthetic enhancement', control_text: 'Synthetic text', discussion: '', related: 'ZZ-1' },
	],
	'mitre-attack-technique-linked': [
		{ ID: 'T1001', name: 'Synthetic technique', description: 'Synthetic prose', tactics: 'Command and Control, Discovery' },
		{ ID: 'T1001.002', name: 'Synthetic child two', description: 'Synthetic prose', tactics: 'Command and Control' },
		{ ID: 'T1001.001', name: 'Synthetic child one', description: 'Synthetic prose', tactics: 'Command and Control' },
	],
};
const PREVIOUS = {
	'nist-csf-2-linked': 'nist-csf-2-flat',
	'nist-800-53-linked': 'nist-800-53-r5-nested',
	'mitre-attack-technique-linked': 'mitre-attack-technique-flat',
};
type Linked = keyof typeof ROWS;
const IDS = Object.keys(ROWS) as Linked[];

function source(id: Linked): string {
	const file = path.join(tempDir('linked-source'), 'synthetic.csv');
	fs.writeFileSync(file, Papa.unparse(ROWS[id]));
	return file;
}
function frontmatter(bytes: Buffer | string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(String(bytes).replace(/\r\n/g, '\n'));
	return match ? load(match[1]) as Record<string, any> : {};
}
function notes(vault: string): Map<string, Record<string, any>> {
	return new Map([...readTree(vault)].filter(([file]) => file.endsWith('.md')).map(([file, bytes]) => [file, frontmatter(bytes)]));
}
async function imported(id: string, input: string, vault = tempDir('linked-vault'), destination = DEST): Promise<string> {
	const io = captureIo();
	const code = await runCli(['import', '--vault', vault, '--source', input, '--recipe', id,
		'--destination', destination, '--deterministic'], io.io);
	expect({ code, errors: io.err }).toEqual({ code: 0, errors: [] });
	return vault;
}

async function importMappings(vault: string, subjectIds: string[]): Promise<Array<[string, Record<string, any>]>> {
	const file = path.join(tempDir('linked-mappings'), 'synthetic.sssom.tsv');
	fs.writeFileSync(file, 'subject_id\tpredicate_id\tobject_id\n'
		+ subjectIds.map((id) => `${id}\tskos:relatedMatch\tnist-csf-2:GV.OC-02`).join('\n') + '\n');
	const io = captureIo();
	expect(await runCli(['import', '--vault', vault, '--source', file, '--destination', 'Mappings/Synthetic', '--deterministic'], io.io)).toBe(0);
	expect(io.err).toEqual([]);
	return [...notes(vault)].filter(([, note]) => note.kind === 'crosswalk-edge');
}

// Prevents: a default silently changing the schema, row identities or replay bytes.
describe.each(IDS)('%s', (id) => {
	it('validates and preserves previous row CURIEs and import-set identity fields', async () => {
		const validation = validateRecipe(entry(id).recipe);
		expect(validation.valid).toBe(true);
		const input = source(id);
		const previous = await imported(PREVIOUS[id], input);
		const linked = await imported(id, input);
		const oldNotes = [...notes(previous).values()];
		const linkedNotes = [...notes(linked).values()];
		for (const old of oldNotes) {
			const current = linkedNotes.find((note) => note.curie === old.curie);
			expect(current).toBeDefined();
			expect(current!._crosswalker.import_set).toEqual(old._crosswalker.import_set);
		}
		const extras = linkedNotes.filter((note) => !oldNotes.some((old) => old.curie === note.curie));
		if (id === 'nist-csf-2-linked') expect(extras.map((note) => note.curie).sort()).toEqual(['nist-csf-2:GV', 'nist-csf-2:GV.OC', 'nist-csf-2:hub/_root']);
		else if (id === 'mitre-attack-technique-linked') expect(extras.map((note) => note.kind)).toEqual(['facet']);
		else expect(extras.map((note) => note.curie)).toEqual(['nist-800-53:hub/_root']);
	});

	it('replays through cw without changing a byte', async () => {
		const input = source(id);
		const vault = await imported(id, input);
		const before = readTree(vault);
		const io = captureIo();
		expect(await runCli(['replay', '--vault', vault, '--set', SET, '--source', input, '--deterministic'], io.io)).toBe(0);
		expect(io.err).toEqual([]);
		const after = readTree(vault);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [file, bytes] of before) expect({ file, text: after.get(file)?.toString() }).toEqual({ file, text: bytes.toString() });
	});

	it('keeps the previous recipe unchanged on Run again, with no changed flag', async () => {
		const previous = entry(PREVIOUS[id]);
		const input = source(id);
		const vault = await imported(previous.id, input);
		const before = readTree(vault);
		const kept = [...before].find(([file]) => /recipe-sha256-.*\.json$/.test(file))!;
		const keptRecipe = JSON.parse(kept[1].toString());
		expect(recipeChangedSinceRun({ recipeDocumentDigest: recipeRunDigest(keptRecipe)! }, recipeRunDigest(previous.recipe))).toBe(false);
		const io = captureIo();
		expect(await runCli(['replay', '--vault', vault, '--set', SET, '--source', input, '--deterministic'], io.io)).toBe(0);
		expect(io.err).toEqual([]);
		const after = readTree(vault);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [file, bytes] of before) expect({ file, text: after.get(file)?.toString() }).toEqual({ file, text: bytes.toString() });
	});
});

describe.each(IDS)('historical normalized kept copy: %s', (id) => {
	it('replays without false drift or rewriting the kept copy or any note', async () => {
		const input = source(id);
		const vault = await imported(id, input);
		const kept = [...readTree(vault).keys()].find((file) => /recipe-sha256-.*\.json$/.test(file))!;
		const oldBytes = serializeCanonicalRecipe(entry(id).recipe);
		fs.writeFileSync(path.join(vault, kept), oldBytes);
		const before = readTree(vault);
		expect(recipeChangedSinceRun({ recipeDocumentDigest: recipeRunDigest(entry(id).recipe)! }, recipeRunDigest(JSON.parse(oldBytes)))).toBe(false);
		const io = captureIo();
		expect(await runCli(['replay', '--vault', vault, '--set', SET, '--source', input, '--deterministic'], io.io)).toBe(0);
		expect(io.err).toEqual([]);
		const after = readTree(vault);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [file, bytes] of before) expect({ file, text: after.get(file)?.toString() }).toEqual({ file, text: bytes.toString() });
		expect(fs.readFileSync(path.join(vault, kept), 'utf8')).toBe(oldBytes);
	});
});

describe('linked navigation', () => {
	it('intentionally retains the existing hub/_root CURIE for level indexes', async () => {
		for (const id of ['nist-csf-2-linked', 'nist-800-53-linked'] as const) {
			const all = [...notes(await imported(id, source(id))).values()];
			expect(all.some((note) => note.curie === `${entry(id).ontology}:hub/_root`)).toBe(true);
		}
	});

	it('creates CSF folder indexes and parent links without a tags key anywhere', async () => {
		const vault = await imported('nist-csf-2-linked', source('nist-csf-2-linked'));
		for (const hub of ['GV/GV.md', 'GV/GV.OC/GV.OC.md']) {
			expect(fs.readFileSync(path.join(vault, DEST, hub), 'utf8')).toContain('## Contents');
		}
		for (const note of notes(vault).values()) expect(note).not.toHaveProperty('tags');
		for (const id of ['GV.OC-01', 'GV.OC-02']) {
			const note = notes(vault).get(`${DEST}/GV/GV.OC/${id}.md`)!;
			expect(note.parent).toBe('[[GV.OC]]');
			expect(note.parent_curie).toBe('nist-csf-2:GV.OC');
		}
	});

	it('derives ATT&CK parents from ID and creates only multi-member tactic hubs', async () => {
		const vault = await imported('mitre-attack-technique-linked', source('mitre-attack-technique-linked'));
		const all = notes(vault);
		const parent = all.get(`${DEST}/T1001.md`)!;
		expect(parent).not.toHaveProperty('parent');
		expect(parent.children).toEqual(['[[T1001.001]]', '[[T1001.002]]']);
		const child = all.get(`${DEST}/T1001.001.md`)!;
		expect(child.parent).toBe('[[T1001]]');
		expect(child.parent_curie).toBe(parent.curie);
		const hubs = [...all].filter(([, note]) => note.kind === 'facet');
		expect(hubs).toHaveLength(1);
		expect(hubs[0][0]).toBe(`${DEST}/Command and Control.md`);
		expect(hubs[0][1].members).toEqual(['[[T1001]]', '[[T1001.001]]', '[[T1001.002]]']);
	});

	it('uses the same raw facet membership authority on the wizard and CLI paths', async () => {
		const id = 'mitre-attack-technique-linked';
		const recipe = entry(id).recipe as unknown as Recipe;
		expect(deriveRecipeFacetMemberships(recipe, ROWS[id][0])).toEqual([
			{ namespace: 'mitre-attack/tactic', value: 'Command and Control' },
			{ namespace: 'mitre-attack/tactic', value: 'Discovery' },
		]);
		const cliVault = await imported(id, source(id));
		const uiVault = tempDir('linked-ui');
		const result = await generateNotes(createFsApp(uiVault) as any,
			{ columns: Object.keys(ROWS[id][0]), rows: ROWS[id], rowCount: ROWS[id].length },
			{ name: 'shape-workbench', mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: '{ID|fs-safe}.md', sanitize: true } } },
			{ basePath: DEST, importSet: { id: SET }, overwriteMode: 'replace', createFolders: true,
				recipeOverride: recipe,
				// A caller's old workbench grouping must not override canonical tags.
				facetsForRow: () => [{ namespace: 'wrong', value: 'wrong' }],
			});
		expect(result.errors).toEqual([]);
		const hubs = (vault: string) => [...notes(vault)].filter(([, note]) => note.kind === 'facet').map(([file, note]) => [file, note.curie]);
		expect(hubs(uiVault)).toEqual(hubs(cliVault));
		expect(hubs(uiVault)).toHaveLength(1);
	});

	it('keeps existing mappings on the first set when the linked recipe creates a second set', async () => {
		const input = source('nist-csf-2-linked');
		const vault = await imported('nist-csf-2-flat', input);
		const first = notes(vault).get(`${DEST}/GV.OC-01.md`)!;
		const mappings = await importMappings(vault, [first.curie]);
		expect(mappings).toHaveLength(1);
		expect(mappings[0][1].subject_note).toBe(`[[${DEST}/GV.OC-01|GV.OC-01]]`);
		const mappingBefore = fs.readFileSync(path.join(vault, mappings[0][0]), 'utf8');
		await imported('nist-csf-2-linked', input, vault, 'Frameworks/Second');
		expect(fs.readFileSync(path.join(vault, mappings[0][0]), 'utf8')).toBe(mappingBefore);
		const app = createFsApp(vault) as any;
		const sets = (await discoverImportSets(app)).filter((set) => set.ontology === 'nist-csf-2');
		expect(sets).toHaveLength(2);
		expect(sets.find((set) => set.id !== SET)?.scheme).toBe('set-qualified-v1');
		expect(existingFrameworkNotice(entry('nist-csf-2-linked'), sets)).toBe('This framework is already in your vault. Importing again creates a second set; existing mappings keep pointing at the first one.');
		const { index } = await edgeEndpointIndex(app);
		const resolved = resolveEdgeEndpoints(index, { subject_id: first.curie, object_id: first.curie });
		expect(resolved).toMatchObject({ subject_note: `[[${DEST}/GV.OC-01|GV.OC-01]]`, object_note: `[[${DEST}/GV.OC-01|GV.OC-01]]` });
	});

	it('resolves every synthetic crosswalk endpoint against a hierarchical linked set', async () => {
		const vault = await imported('nist-csf-2-linked', source('nist-csf-2-linked'));
		const mappings = await importMappings(vault, ['GV', 'GV.OC', 'GV.OC-01'].map((id) => `nist-csf-2:${id}`));
		expect(mappings).toHaveLength(3);
		for (const [, edge] of mappings) {
			expect(edge.subject_note).toContain(`${DEST}/GV/`);
			expect(edge.object_note).toBe(`[[${DEST}/GV/GV.OC/GV.OC-02|GV.OC-02]]`);
		}
		const { index } = await edgeEndpointIndex(createFsApp(vault) as any);
		for (const id of ['GV', 'GV.OC', 'GV.OC-01', 'GV.OC-02']) {
			const resolved = resolveEdgeEndpoints(index, { subject_id: `nist-csf-2:${id}`, object_id: 'nist-csf-2:GV.OC-01' });
			expect(resolved.unresolved).toEqual([]);
			expect(resolved.subject_note).toBeTruthy();
			expect(resolved.object_note).toBeTruthy();
		}
	});
});

describe('recommended selection is additive', () => {
	it('ranks successors first, labels previous defaults, and auto-applies only the recommendation', () => {
		for (const id of ['nist-csf-2-linked', 'mitre-attack-technique-linked']) {
			const previous = entry(PREVIOUS[id as Linked]);
			const columns = [...new Set([...entry(id).signatureColumns, ...previous.signatureColumns])];
			const ranked = findRecognizedRecipes(columns);
			expect(ranked[0].entry.id).toBe(id);
			expect(previous.label).toMatch(/ \(previous default\)$/);
			expect(entry(id).label).not.toContain('previous default');
			expect(shouldAutoApplyRecognizedMatch(true, 100, previous)).toBe(false);
			expect(shouldAutoApplyRecognizedMatch(true, 100, ranked[0].entry)).toBe(true);
			expect(ranked.find((match) => match.entry.id === previous.id)?.score).toBe(100);
		}
	});

	it('totally orders successor, previous default and a specificity-winning third candidate in all six input orders', () => {
		// Synthetic signatures expose the former comparison triangle: previous
		// beats unrelated on specificity, unrelated beats linked on specificity,
		// but linked must beat previous on supersession.
		const successor = { ...entry('mitre-attack-technique-linked'), signatureColumns: ['ID', 'name'], requiredColumns: ['ID'] };
		const previous = { ...entry('mitre-attack-technique-flat'), signatureColumns: ['ID', 'name', 'description', 'tactics'], requiredColumns: ['ID'] };
		const unrelated = { ...successor, id: 'unrelated-specific', signatureColumns: ['ID', 'name', 'description'] };
		const permutations = [
			[successor, previous, unrelated], [successor, unrelated, previous],
			[previous, successor, unrelated], [previous, unrelated, successor],
			[unrelated, successor, previous], [unrelated, previous, successor],
		];
		for (const input of permutations) {
			const ranked = findRecognizedRecipes(['ID', 'name', 'description', 'tactics'], undefined, input)
				.filter((match) => match.entry.origin === 'user');
			expect(ranked.map((match) => match.score)).toEqual([100, 100, 100]);
			expect(ranked.map((match) => match.entry.id)).toEqual([unrelated.id, successor.id, previous.id]);
		}
	});

	it('uses linked stack defaults, but generic 800-53 discovery remains flat only', () => {
		const slots = frameworkSlots(DEFAULT_STACK_SELECTION);
		for (const id of IDS) expect(slots.some((slot) => slot.entry.id === id)).toBe(true);
		const ids = findRecognizedRecipes(entry('nist-800-53-linked').signatureColumns).map((match) => match.entry.id);
		expect(ids).toContain('nist-800-53-r5-flat');
		expect(ids).not.toContain('nist-800-53-linked');
		expect(ids).not.toContain('nist-800-53-r5-nested');
		expect(RECIPE_REGISTRY.some((recipe) => recipe.id === 'mitre-attack-mitigation')).toBe(false);
		for (const id of IDS) expect(honestEnrichment(entry(id))).toEqual(entry(id).recipe.target.enrichment);
	});

	it('does not guess another ontology or show a duplicate-set notice for previous defaults', () => {
		expect(existingFrameworkNotice(entry('nist-csf-2-linked'), [{ ontology: 'other' }])).toBeNull();
		expect(existingFrameworkNotice(entry('nist-csf-2-flat'), [{ ontology: 'nist-csf-2' }])).toBeNull();
	});

	it('D3FEND has no score-100 collision across existing held-sheet signature fixtures', () => {
		const d3fend = entry('mitre-d3fend-flat');
		expect(matchScore(d3fend, d3fend.signatureColumns)).toBe(100);
		// Reuse every literal `const cols = [...]` corpus signature already pinned
		// in the registry suite, without duplicating any held publisher content.
		const fixture = ts.createSourceFile('signatures.ts', fs.readFileSync(path.join(REPO, 'tests/recipe-registry.test.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		const signatures: string[][] = RECIPE_REGISTRY.filter((item) => item.id !== d3fend.id).map((item) => item.signatureColumns);
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && node.name.getText(fixture) === 'cols' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
				signatures.push(node.initializer.elements.filter(ts.isStringLiteral).map((item) => item.text));
			}
			ts.forEachChild(node, visit);
		}
		visit(fixture);
		expect(signatures.length).toBeGreaterThan(25);
		for (const columns of signatures) expect(matchScore(d3fend, columns)).toBeLessThan(100);
	});
});
