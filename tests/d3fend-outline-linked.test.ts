import * as fs from 'node:fs';
import * as path from 'node:path';
import Papa from 'papaparse';
import { load } from 'js-yaml';
import ts from 'typescript';
import { runCli } from '../cli/crosswalker';
import { createFsApp } from '../cli/fs-app';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './cli/helpers';
import { generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import { discoverImportSets } from '../src/generation/import-set';
import { validateImportSetBlock } from '../src/generation/import-set-block';
import { validateTier1Frontmatter } from '../src/validation/validator';
import { edgeEndpointIndex, resolveEdgeEndpoints } from '../src/generation/edge-endpoints';
import { computeRecipeHash } from '../src/generation/hash';
import { RECIPE_REGISTRY, findRecognizedRecipes, matchScore } from '../src/import/recipe-registry';
import { loadRecipeDocument, patchRecipeDocument } from '../src/import/recipe-document';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns, STREAMING_THRESHOLD_BYTES } from '../src/import/parsers/csv-parser';
import * as sourceStage from '../src/source';
import type { ParsedData } from '../src/types/config';
import type { Recipe } from '../src/render';
import type { DebugLog } from '../src/utils/debug';
import { d3fendNames, d3fendAttackMappings, d3fendControlMappings, publicCsv, mappingResolution } from '../tools/lib/demo-public-sources';

installByteFile();
const linked = RECIPE_REGISTRY.find((entry) => entry.id === 'mitre-d3fend-linked')!;
const previous = RECIPE_REGISTRY.find((entry) => entry.id === 'mitre-d3fend-flat')!;
const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;
const synthetic = [
	{ ID: 'D3-ROOT', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': 'Root', 'D3FEND Technique Level 0': '', 'D3FEND Technique Level 1': '', Definition: '' },
	{ ID: 'D3-PARENT', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': '', 'D3FEND Technique Level 0': 'Parent', 'D3FEND Technique Level 1': '', Definition: '' },
	{ ID: 'D3-Z', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': '', 'D3FEND Technique Level 0': '', 'D3FEND Technique Level 1': 'Last child', Definition: '' },
	{ ID: 'D3-A', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': '', 'D3FEND Technique Level 0': '', 'D3FEND Technique Level 1': 'First child', Definition: '' },
];
function notes(vault: string): Record<string, any>[] {
	return [...readTree(vault)].filter(([file]) => file.endsWith('.md')).map(([, bytes]) => {
		const match = /^---\n([\s\S]*?)\n---/.exec(bytes.toString().replace(/\r\n/g, '\n'));
		return match ? load(match[1]) as Record<string, any> : {};
	});
}
async function importRows(rows: Record<string, unknown>[], mode: 'cw' | 'wizard') {
	const vault = tempDir('outline-linked');
	if (mode === 'cw') {
		const input = path.join(tempDir('outline-source'), 'source.csv');
		fs.writeFileSync(input, Papa.unparse(rows));
		const io = captureIo();
		expect({ code: await runCli(['import', '--vault', vault, '--source', input, '--recipe', linked.id,
			'--destination', 'Frameworks/D3FEND', '--deterministic'], io.io), errors: io.err }).toEqual({ code: 0, errors: [] });
	} else {
		const result = await generateNotes(createFsApp(vault) as any,
			{ columns: Object.keys(rows[0]), rows, rowCount: rows.length },
			{ name: 'shape-workbench', mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: '{ID|fs-safe}.md', sanitize: true } } },
			{ basePath: 'Frameworks/D3FEND', importSet: 'new', overwriteMode: 'replace', createFolders: true,
				recipeOverride: linked.recipe as unknown as Recipe });
		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	}
	return { vault, all: notes(vault) };
}

it.each(['cw', 'wizard'] as const)('declares ID identically through %s, with sorted children and tactic hubs', async (mode) => {
	const { all } = await importRows(synthetic, mode);
	const byId = new Map(all.map((note) => [note.technique_id, note]));
	expect(byId.get('D3-ROOT').curie).toBe('mitre-d3fend:D3-ROOT');
	expect(byId.get('D3-ROOT')).not.toHaveProperty('parent');
	expect(byId.get('D3-ROOT')).not.toHaveProperty('parent_curie');
	expect(byId.get('D3-A').parent_curie).toBe(byId.get('D3-PARENT').curie);
	expect(byId.get('D3-PARENT').children).toEqual(['[[D3-A]]', '[[D3-Z]]']);
	const hubs = all.filter((note) => note.kind === 'facet');
	expect(hubs).toHaveLength(1);
	expect(hubs[0].members).toHaveLength(4);
	expect(byId.get('D3-A').tags).toEqual(['mitre-d3fend/tactic/synthetic-tactic']);
});

it('preserves outline after a canonical workbench edit and previews truthful parent-link counts', async () => {
	const data: ParsedData = { columns: Object.keys(synthetic[0]), rows: synthetic, rowCount: synthetic.length };
	const loaded = loadRecipeDocument(linked.recipe, { origin: 'bundled', sourceColumns: data.columns });
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) return;
	const mapping = { ...loaded.document.mapping, enrichment: { ...loaded.document.mapping.enrichment, waypoint_marker: true } };
	const patched = patchRecipeDocument(loaded.document, { mapping });
	expect(patched.ok).toBe(true);
	if (!patched.ok) return;
	expect(patched.recipe.source.outline).toEqual(linked.recipe.source.outline);
	expect(patched.recipe.target.enrichment?.waypoint_marker).toBe(true);
	const wb = new MappingWorkbench({ parsedData: data, columnInfos: analyzeColumns(data), outputPath: 'Out', debug,
		defaultPresetId: 'browsable-framework', initialRecipe: linked.recipe, recipeOrigin: 'bundled', seedColumnDefaults: false, onChange() {} });
	// The async source stage completes without mounting DOM; preview is the real workbench method.
	for (let i = 0; i < 50 && !wb.computePreview(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
	expect(wb.getPreviewError()).toBeNull();
	expect(wb.computePreview()?.addresses.filter((entry) => entry.address.frontmatter.parent)).toHaveLength(3);
	expect((wb as unknown as { connectionStats(): string | null }).connectionStats()).toContain('3 parent links');
});

it('keeps the previous recipe golden and recommends linked without new foreign score-100 matches', () => {
	expect(computeRecipeHash(previous.recipe.target, previous.recipe.source)).toBe('sha256-63266fb7580aff970538bcfb0ad3b0acc4f797e0f07c66337f2ea5be8810d44a');
	expect(previous.supersededBy).toBe(linked.id);
	expect(linked.supersededBy).toBeUndefined();
	expect(matchScore(linked, Object.keys(synthetic[0]))).toBe(100);
	expect([...linked.signatureColumns].sort()).toEqual([...previous.signatureColumns].sort());
	for (const column of previous.requiredColumns) expect(linked.requiredColumns).toContain(column);
	expect(findRecognizedRecipes(Object.keys(synthetic[0]))[0].entry.id).toBe(linked.id);
	const fixture = ts.createSourceFile('signatures.ts', fs.readFileSync(path.join(REPO, 'tests/recipe-registry.test.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
	const signatures = RECIPE_REGISTRY.filter((entry) => entry.id !== linked.id && entry.id !== previous.id).map((entry) => entry.signatureColumns);
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && node.name.getText(fixture) === 'cols' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
			signatures.push(node.initializer.elements.filter(ts.isStringLiteral).map((item) => item.text));
		}
		ts.forEachChild(node, visit);
	}
	visit(fixture);
	expect(signatures.length).toBeGreaterThan(25);
	for (const columns of signatures) expect(matchScore(linked, columns)).toBeLessThan(100);
	console.log(`D3FEND recognition: ${signatures.length} foreign signature fixtures, 0 new score-100 matches; flat golden unchanged`);
});

type EntryRoute = 'recipe' | 'wizard';
async function generateOutline(vault: string, data: ParsedData, route: EntryRoute, recipe = linked.recipe as unknown as Recipe,
	importSet: 'new' | { id: string } = 'new', app = createFsApp(vault) as any) {
	const options = { basePath: 'Out', importSet, overwriteMode: 'replace' as const, createFolders: true };
	return route === 'recipe' ? generateFromRecipe(app, data, recipe, options)
		: generateNotes(app, data, { name: 'synthetic', mapping: { hierarchy: [], frontmatter: [], links: [], body: [],
			filename: { template: '{ID|fs-safe}.md', sanitize: true } } }, { ...options, recipeOverride: recipe });
}
function pinlessRecipe(shape: 'flat' | 'nest'): Recipe {
	return {
		recipe: `synthetic:${shape}`,
		source: {
			ontology: 'mitre-d3fend', levels: ['technique'],
			...(shape === 'nest' ? { nest: [{ level: 'technique', id: '{ID}' }] } : {}),
		},
		target: {
			layout: [{ level: 'technique', mechanism: 'file', template: '{ID}.md' }],
			also_emit: { frontmatter: { managed: { title: '{ID}', technique_id: '{ID}' } } },
		},
	};
}
function eager(input = synthetic): ParsedData {
	return { columns: Object.keys(synthetic[0]), rows: input, rowCount: input.length };
}
function workbench(data = eager()) {
	return new MappingWorkbench({ parsedData: data, columnInfos: analyzeColumns(eager()), outputPath: 'Out', debug,
		defaultPresetId: 'browsable-framework', initialRecipe: linked.recipe, recipeOrigin: 'bundled', seedColumnDefaults: false, onChange() {} });
}
async function settle(wb: MappingWorkbench): Promise<void> {
	for (let i = 0; i < 50 && !wb.computePreview(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe.each(['recipe', 'wizard'] as const)('%s outline safety preflight', (route) => {
	it.each(['depth jump', 'two levels', 'no level', 'empty id', 'duplicate id'])('refuses a late %s before creating any folder or file', async (problem) => {
		const input = Array.from({ length: 25 }, (_, index) => ({ ...synthetic[0], ID: `SYN-${index}` }));
		const last = { ...synthetic[0], ID: 'SYN-LAST' };
		if (problem === 'depth jump') { last['D3FEND Technique'] = ''; last['D3FEND Technique Level 1'] = 'Too deep'; }
		if (problem === 'two levels') last['D3FEND Technique Level 0'] = 'Also filled';
		if (problem === 'no level') last['D3FEND Technique'] = '';
		if (problem === 'empty id') last.ID = '';
		if (problem === 'duplicate id') last.ID = input[0].ID;
		input.push(last);
		const data: ParsedData = { ...eager(input), rows: (async function* () { yield* input; })() };
		const vault = tempDir('outline-refusal');
		const result = await generateOutline(vault, data, route);
		expect(result.success).toBe(false);
		expect(result.created).toHaveLength(0);
		expect(result.errors[0].declaration).toBe('source.outline');
		if (problem !== 'duplicate id') expect(result.errors[0].row).toBe(26);
		else expect(result.errors[0].message).toMatch(/unique identity/);
		expect(fs.readdirSync(vault)).toEqual([]);
	});

	it('refuses a legacy derivation before writing', async () => {
		const vault = tempDir('outline-legacy');
		const result = await generateOutline(vault, eager(), route, linked.recipe as unknown as Recipe, { id: 'iset-abc123' });
		expect(result.success).toBe(false);
		expect(result.errors[0]).toMatchObject({ declaration: 'source.outline' });
		expect(result.errors[0].message).toMatch(/new set/);
		expect(fs.readdirSync(vault)).toEqual([]);
	});

	it.each(['flat', 'nest'] as const)('refuses an outline refresh of a pinless %s set with zero vault writes', async (shape) => {
		const vault = tempDir('outline-pinless-refusal');
		const minted = await generateOutline(vault, eager(), route, pinlessRecipe(shape));
		expect(minted.success).toBe(true);
		expect(minted.errors).toEqual([]);
		const before = readTree(vault);
		const entriesBefore = fs.readdirSync(vault, { recursive: true }).sort();
		const app = createFsApp(vault) as any;
		const writes = ['create', 'modify', 'process', 'createFolder', 'rename', 'delete', 'trash']
			.map((method) => jest.spyOn(app.vault, method));
		const refused = await generateOutline(vault, eager(), route, linked.recipe as unknown as Recipe, { id: minted.importSetId! }, app);
		expect(refused.success).toBe(false);
		for (const write of writes) expect(write).not.toHaveBeenCalled();
		expect(refused.created).toHaveLength(0);
		expect(refused.errors[0]).toMatchObject({
			declaration: 'source.outline',
			message: 'source.outline: This set was imported without an outline. Import into a new set to use the outline layout.',
		});
		expect(readTree(vault)).toEqual(before);
		expect(fs.readdirSync(vault, { recursive: true }).sort()).toEqual(entriesBefore);
	});

	it.each(['flat', 'nest'] as const)('%s mint and refresh never write outline_identity', async (shape) => {
		const vault = tempDir('outline-pinless-roundtrip');
		const recipe = pinlessRecipe(shape);
		const minted = await generateOutline(vault, eager(), route, recipe);
		expect(minted.success).toBe(true);
		expect(minted.errors).toEqual([]);
		expect(notes(vault).length).toBeGreaterThan(0);
		for (const note of notes(vault)) expect(note._crosswalker.import_set).not.toHaveProperty('outline_identity');
		const refreshed = await generateOutline(vault, eager(), route, recipe, { id: minted.importSetId! });
		expect(refreshed.success).toBe(true);
		expect(refreshed.errors).toEqual([]);
		for (const note of notes(vault)) expect(note._crosswalker.import_set).not.toHaveProperty('outline_identity');
	});

	it('pins ordered depth columns and identity template at mint and refuses either changing on refresh', async () => {
		const vault = tempDir('outline-pin');
		const minted = await generateOutline(vault, eager(), route);
		expect(minted.errors).toEqual([]);
		for (const note of notes(vault)) {
			expect(note._crosswalker.import_set.outline_identity).toEqual(linked.recipe.source.outline);
			expect(validateTier1Frontmatter(note).errors).toEqual([]);
		}
		const sets = await discoverImportSets(createFsApp(vault) as any);
		expect(sets[0].outline_identity).toEqual(linked.recipe.source.outline);
		const option = { id: minted.importSetId! };
		expect((await generateOutline(vault, eager(), route, linked.recipe as unknown as Recipe, option)).errors).toEqual([]);
		for (const change of ['id', 'levels', 'removed'] as const) {
			const changed = JSON.parse(JSON.stringify(linked.recipe)) as Recipe;
			if (change === 'id') changed.source!.outline!.id = '{ID}';
			if (change === 'levels') changed.source!.outline!.levels = [...changed.source!.outline!.levels].reverse();
			if (change === 'removed') delete changed.source!.outline;
			const before = readTree(vault);
			const refused = await generateOutline(vault, eager(), route, changed, option);
			expect(refused.success).toBe(false);
			expect(refused.errors[0].message).toMatch(/new set/);
			expect(refused.errors[0].declaration).toBe('source.outline');
			if (change === 'removed') expect(refused.errors[0].message).toBe('source.outline: This set was imported with an outline. Restore the outline settings in the recipe, or import into a new set.');
			expect(readTree(vault)).toEqual(before);
		}
	});
});

it('refuses malformed outline provenance and disagreement between notes', async () => {
	const vault = tempDir('outline-pin-conflict');
	await generateOutline(vault, eager(), 'recipe');
	const file = [...readTree(vault).keys()].find((name) => name.endsWith('D3-A.md'))!;
	const full = path.join(vault, file);
	const content = fs.readFileSync(full, 'utf8');
	fs.writeFileSync(full, content.replace('{ID|trim}', '{ID}'));
	const disagreement = await discoverImportSets(createFsApp(vault) as any).then(() => null, (error: Error) => error);
	expect(disagreement).toBeInstanceOf(Error);
	expect(disagreement?.message).toContain('different outline settings');
	for (const [notePath] of readTree(vault)) {
		if (!notePath.endsWith('.md')) continue;
		expect(disagreement?.message).toContain(`${notePath} (${JSON.stringify({
			id: notePath === file ? '{ID}' : '{ID|trim}', levels: linked.recipe.source.outline!.levels,
		})})`);
	}
	expect(disagreement?.message).toMatch(/Restore the notes that disagree from a backup, or move them out of this folder, then run the import again\.$/);
	expect(disagreement?.message).not.toMatch(/provenance/);
	for (const pin of [null, {}, { id: '', levels: ['a'] }, { id: '  ', levels: ['a'] }, { id: '{ID}', levels: [] }, { id: '{ID}', levels: [' '] }, { id: '{ID}', levels: ['a', 'a'] }]) {
		expect(() => validateImportSetBlock({ id: 'iset-abc123', scheme: 'endpoint-v1', outline_identity: pin }, 'Synthetic.md'))
			.toThrow('The outline settings recorded in Synthetic.md are damaged. Restore that note from a backup, or move it out of this folder, then run the import again.');
	}
});

it('rejects whitespace-only outline pins in the Tier 1 schema', async () => {
	const vault = tempDir('outline-schema-pin');
	await generateOutline(vault, eager(), 'recipe');
	const note = notes(vault)[0];
	expect(validateTier1Frontmatter(note).errors).toEqual([]);
	for (const pin of [{ id: '  ', levels: ['Depth'] }, { id: '{ID}', levels: [' \t'] }]) {
		const changed = JSON.parse(JSON.stringify(note));
		changed._crosswalker.import_set.outline_identity = pin;
		expect(validateTier1Frontmatter(changed).errors.length).toBeGreaterThan(0);
	}
});

it('omits multiline source-stage details from the hierarchy preview message', async () => {
	const summary = 'The source settings are damaged. Restore the recipe and import again.';
	const prepare = jest.spyOn(sourceStage, 'prepareSourceStage').mockRejectedValueOnce(new sourceStage.SourceStageError(summary, {
		declaration: 'source.outline', detail: 'Internal diagnostic detail must not reach the preview.',
	}));
	try {
		const wb = workbench();
		await settle(wb);
		expect(wb.getPreviewError()).toBe(summary);
	} finally {
		prepare.mockRestore();
	}
});

it('explains streamed outline preview limits without consuming the stream', () => {
	let consumed = 0;
	const wb = workbench({ ...eager(), rows: (async function* () { consumed++; yield* synthetic; })() });
	expect(wb.computePreview()).toBeNull();
	expect(wb.getPreviewError()).toMatch(/stream.*Reopen a smaller copy/);
	expect(wb.getPreviewError()).toContain(`${STREAMING_THRESHOLD_BYTES / (1024 * 1024)} MiB or less`);
	expect(consumed).toBe(0);
});

it('caches expansion by data identity and serialized source, keeping previous rows during replacement', async () => {
	const wb = workbench();
	await settle(wb);
	const state = wb as any;
	const firstRows = state.expandedRows;
	const firstVersion = state.expansionVersion;
	state.applyChange();
	state.applyChange();
	expect(state.expansionVersion).toBe(firstVersion);
	expect(state.expandedRows).toBe(firstRows);
	expect(wb.computePreview()?.addresses).toHaveLength(4);
	state.recipeDocument.original.source.where = "ID != 'D3-Z'";
	state.refreshExpandedRows();
	expect(state.expansionVersion).toBe(firstVersion + 1);
	expect(state.expandedRows).toBe(firstRows);
	expect(wb.computePreview()?.addresses).toHaveLength(4);
	for (let i = 0; i < 50 && state.expandedRows === firstRows; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	expect(wb.computePreview()?.addresses).toHaveLength(3);
	const secondRows = state.expandedRows;
	state.opts.parsedData = eager(synthetic.slice(0, 2));
	state.refreshExpandedRows();
	expect(state.expandedRows).toBe(secondRows);
	for (let i = 0; i < 50 && state.expandedRows === secondRows; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	expect(wb.computePreview()?.addresses).toHaveLength(2);
});

it('shows a plain cause, action and header-excluding data row for an invalid preview', async () => {
	const invalid = synthetic.map((row) => ({ ...row }));
	invalid[3].ID = '';
	const wb = workbench(eager(invalid));
	await settle(wb);
	expect(wb.computePreview()).toBeNull();
	expect(wb.getPreviewError()).toMatch(/empty id.*Fix.*data row 4, counting from 1 after the header/);
	expect(wb.getPreviewError()).not.toMatch(/source\.outline|\| row/);
});

const corpus = path.join(REPO, 'Frameworks');
const held = ['d3fend.csv', 'att&ck_to_d3fend.csv', 'd3fend_to_nist80053.csv'].every((name) => fs.existsSync(path.join(corpus, name)));
(held ? describe : describe.skip)('held D3FEND catalog and mapping acceptance', () => {
	it.each(['cw', 'wizard'] as const)('%s preserves source containment, identity and every mapping endpoint', async (mode) => {
		const catalog = publicCsv(fs.readFileSync(path.join(corpus, 'd3fend.csv'), 'utf8'));
		const { vault, all } = await importRows(catalog, mode);
		const concepts = all.filter((note) => typeof note.technique_id === 'string');
		const byId = new Map(concepts.map((note) => [note.technique_id, note]));
		expect(concepts).toHaveLength(183);
		expect(byId.get('D3-DPLM').parent).toBe('[[D3-PLM]]');
		expect(byId.get('D3-PLM').parent).toBe('[[D3-NM]]');
		expect(byId.get('D3-DPLM').parent_curie).toBe(byId.get('D3-PLM').curie);
		const roots = catalog.filter((row) => row['D3FEND Technique'].trim());
		expect(roots).toHaveLength(22);
		for (const row of roots) {
			expect(byId.get(row.ID)).not.toHaveProperty('parent');
			expect(byId.get(row.ID)).not.toHaveProperty('parent_curie');
		}
		for (const note of concepts) {
			if (note.parent_curie) expect(concepts.some((parent) => parent.curie === note.parent_curie)).toBe(true);
			if (note.children) expect(note.children).toEqual([...note.children].sort((a, b) => a.localeCompare(b)));
		}
		const identities = new Set(concepts.map((note) => String(note.curie)));
		const attackSource = publicCsv(fs.readFileSync(path.join(corpus, 'att&ck_to_d3fend.csv'), 'utf8'));
		const attackResult = d3fendAttackMappings(attackSource);
		expect(attackSource).toHaveLength(42);
		expect(attackResult.emptyRows).toBe(7);
		const attack = attackResult.rows;
		const controls = d3fendControlMappings(publicCsv(fs.readFileSync(path.join(corpus, 'd3fend_to_nist80053.csv'), 'utf8')), d3fendNames(catalog));
		expect(new Set(attack.map((row) => row.object_id)).size).toBe(57);
		expect(new Set(controls.map((row) => row.object_id)).size).toBe(41);
		const { index } = await edgeEndpointIndex(createFsApp(vault) as any);
		for (const mappings of [attack, controls]) {
			expect(mappingResolution(mappings, identities).objectResolved).toBe(mappings.length);
			for (const row of mappings) {
					// Only D3FEND is imported here. Resolve each unchanged mapping
					// row and prove its object endpoint; foreign subjects are out of scope.
					const resolved = resolveEdgeEndpoints(index, row);
					expect(resolved.object_note).not.toBe('');
					expect(resolved.unresolved.some((endpoint) => endpoint.curie === row.object_id)).toBe(false);
				}
		}
		console.log(`D3FEND ${mode}: ${concepts.length} concepts, ${roots.length} roots, ${concepts.filter((note) => note.parent).length} parent links, ${all.filter((note) => note.kind === 'facet').length} tactic hubs; ATT&CK ${attack.length}/${attack.length} rows (57/57 distinct), NIST ${controls.length}/${controls.length} rows (41/41 distinct) resolved`);
	});
});
