/**
 * Identity reconciliation on the native recipe path. Crosswalk notes are
 * generated through generateFromRecipe(), so layout changes must relocate the
 * canonical note rather than strand it at the old address or duplicate it.
 */

import { TFile, TFolder } from 'obsidian';
import { buildNoteContent, generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

const CURIE = 'xwalk:edge-1';
const OLD_PATH = 'Mappings/legacy/edge-1.md';
const NEW_PATH = 'Mappings/set-new/edge-1.md';

const RECIPE: Recipe = {
	recipe: 'crosswalk-edge-identity-test',
	source: { ontology: 'xwalk', levels: ['edge'] },
	target: {
		layout: [{
			level: 'edge',
			mechanism: 'file',
			template: 'set-new/{edge_id}.md',
			kind: 'crosswalk-edge',
		}],
		also_emit: {
			frontmatter: {
				managed: {
					subject_id: '{subject_id}',
					predicate_id: '{predicate_id}',
					object_id: '{object_id}',
				},
			},
		},
	},
};

const ROW = {
	edge_id: 'edge-1',
	subject_id: 'ex-a:A-1',
	predicate_id: 'is_equivalent_to',
	object_id: 'ex-b:B-1',
};

function parsed(): ParsedData {
	return { columns: Object.keys(ROW), rows: [{ ...ROW }], rowCount: 1 };
}

function generatedCrosswalkContent(
	body: string = `# ${CURIE}\n`,
	importSetId: string = 'iset-abc123',
): string {
	return buildNoteContent({
		curie: CURIE,
		kind: 'crosswalk-edge',
		subject_id: ROW.subject_id,
		predicate_id: ROW.predicate_id,
		object_id: ROW.object_id,
		_crosswalker: {
			spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
			source_ref: { curie: 'unknown:_' },
			produced_at: '2026-08-21T00:00:00.000Z',
			import_set: { id: importSetId, scheme: 'endpoint-v1' },
			recipe: { id: RECIPE.recipe },
		},
	}, body);
}

function makeApp(seedPaths: string[], legacyBody?: string, legacyImportSetId?: string) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['', 'Mappings', 'Mappings/legacy']);
	for (const path of seedPaths) {
		files.set(path, generatedCrosswalkContent(legacyBody, legacyImportSetId));
	}
	const renameFile = jest.fn(async (file: TFile, newPath: string) => {
		const content = files.get(file.path);
		if (content === undefined) throw new Error(`Missing source file: ${file.path}`);
		files.delete(file.path);
		files.set(newPath, content);
		file.path = newPath;
	});
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: TFile, content: string) => {
				files.set(file.path, content);
			},
			read: async (file: TFile) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		fileManager: { renameFile },
		metadataCache: {
			getFileCache: (file: TFile) => {
				const content = files.get(file.path);
				if (!content) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, '\n'));
				return { frontmatter: match ? (yaml.load(match[1]) as Record<string, unknown>) : {} };
			},
		},
	};
	return { app: app as any, files, renameFile };
}

const OPTIONS = {
	basePath: 'Mappings',
	importSet: { id: 'iset-abc123' },
	overwriteMode: 'replace' as const,
	createFolders: true,
	curiePrefix: 'xwalk',
	curieLocalPart: () => 'edge-1',
};

const WIZARD_CONFIG: Partial<ImportRecipe> = {
	name: 'xwalk',
	mapping: {
		hierarchy: [],
		frontmatter: [],
		links: [],
		body: [],
		filename: { template: '{edge_id}.md', sanitize: true },
	},
};

describe('generateFromRecipe identity reconciliation', () => {
	it('mints a fresh OLIR-recipe crosswalk edge under sssom even when the source label and caller override say xwalk', async () => {
		const crosswalkVault = makeApp([]);
		const crosswalkResult = await generateFromRecipe(crosswalkVault.app, parsed(), RECIPE, OPTIONS);
		expect(crosswalkResult.errors).toEqual([]);
		const crosswalkFm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(crosswalkVault.files.get(NEW_PATH)!)![1]) as any;
		expect(crosswalkFm.kind).toBe('crosswalk-edge');
		expect(crosswalkFm.curie).toBe('sssom:cw-ex-a-A-1-ex-b-B-1');
		// `destination` is recorded on every run so a refresh never has to infer
		// where its own set lives (2026-08-29).
		// AM-6 (2026-08-30): the set also carries the ontology its curies are
		// minted under, pinned at mint beside the scheme.
		expect(crosswalkFm._crosswalker.import_set).toEqual({
			id: 'iset-abc123', scheme: 'endpoint-v1', destination: 'Mappings', ontology: 'sssom',
		});

		const junctionRecipe: Recipe = {
			recipe: 'junction-identity-test',
			source: { ontology: 'cwk', levels: ['edge'] },
			target: {
				layout: [{ level: 'edge', mechanism: 'file', template: 'junction/{edge_id}.md', kind: 'junction-note' }],
				also_emit: { frontmatter: { managed: {
					subject: '{subject_id}', predicate: '{predicate_id}', object: '{object_id}',
				} } },
			},
		};
		const junctionVault = makeApp([]);
		const junctionResult = await generateFromRecipe(junctionVault.app, parsed(), junctionRecipe, {
			...OPTIONS, curiePrefix: 'cwk',
		});
		expect(junctionResult.errors).toEqual([]);
		const junction = junctionVault.files.get('Mappings/junction/edge-1.md')!;
		const junctionFm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(junction)![1]) as any;
		expect(junctionFm.kind).toBe('junction-note');
		// A SEPARATE empty vault, so `iset-abc123` is named but not yet present:
		// nothing is pinned, and the run's own proposal (`cwk`) becomes the pin.
		// The pin only overrides a proposal once the set has notes to be pinned by.
		expect(junctionFm._crosswalker.import_set).toEqual({
			id: 'iset-abc123', scheme: 'endpoint-v1', destination: 'Mappings', ontology: 'cwk',
		});
	});

	it('mints the bundled-recipe wizard path under sssom instead of its xwalk source label', async () => {
		const vault = makeApp([]);
		const result = await generateNotes(vault.app, parsed(), WIZARD_CONFIG, {
			basePath: 'Mappings',
			importSet: { id: 'iset-abc123' },
			overwriteMode: 'replace',
			createFolders: true,
			recipeOverride: RECIPE,
		});

		expect(result.errors).toEqual([]);
		const frontmatter = yaml.load(/^---\n([\s\S]*?)\n---/.exec(vault.files.get(NEW_PATH)!)![1]) as any;
		expect(frontmatter.curie).toBe('sssom:cw-ex-a-A-1-ex-b-B-1');
		expect(frontmatter._crosswalker.import_set.ontology).toBe('sssom');
	});

	it('recognizes the same legacy pair on the wizard path and keeps its address and curie', async () => {
		const { app, files, renameFile } = makeApp([OLD_PATH], '');
		const result = await generateNotes(app, parsed(), WIZARD_CONFIG, {
			basePath: 'Mappings',
			importSet: { id: 'iset-abc123' },
			overwriteMode: 'replace',
			createFolders: true,
			recipeOverride: RECIPE,
		});

		expect(result.errors).toEqual([]);
		expect(result.conflicts).toBeUndefined();
		expect(renameFile).not.toHaveBeenCalled();
		expect(files.has(OLD_PATH)).toBe(true);
		expect(files.has(NEW_PATH)).toBe(false);
		const refreshed = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(OLD_PATH)!)![1]) as any;
		expect(refreshed.curie).toBe(CURIE);
	});

	it('updates one legacy xwalk edge in place, pins xwalk, and reports zero orphans on explicit refresh', async () => {
		const { app, files, renameFile } = makeApp([OLD_PATH]);

		const result = await generateFromRecipe(app, parsed(), RECIPE, OPTIONS);

		expect(result.errors).toEqual([]);
		expect(result.moved).toBeUndefined();
		expect(renameFile).not.toHaveBeenCalled();
		expect(files.has(OLD_PATH)).toBe(true);
		expect(files.has(NEW_PATH)).toBe(false);
		expect(files.size).toBe(1);
		const refreshed = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(OLD_PATH)!)![1]) as any;
		expect(refreshed.curie).toBe(CURIE);
		expect(refreshed._crosswalker.import_set.ontology).toBe('xwalk');
		expect(result.orphansChecked).toBe(true);
		expect(result.orphans ?? []).toEqual([]);
	});

	it('does not move an identity under skip mode', async () => {
		const { app, files, renameFile } = makeApp([OLD_PATH]);

		const result = await generateFromRecipe(app, parsed(), RECIPE, {
			...OPTIONS,
			overwriteMode: 'skip',
		});

		expect(result.errors).toEqual([]);
		expect(result.moved).toBeUndefined();
		expect(renameFile).not.toHaveBeenCalled();
		expect(files.has(OLD_PATH)).toBe(true);
		expect(files.has(NEW_PATH)).toBe(false);
		expect(files.size).toBe(1);
	});

	it('refuses to annex a same-pair legacy edge owned by another import set', async () => {
		const foreignSetId = 'iset-fedcba';
		const { app, files, renameFile } = makeApp([OLD_PATH], undefined, foreignSetId);

		const result = await generateFromRecipe(app, parsed(), RECIPE, OPTIONS);

		expect(result.success).toBe(false);
		expect(result.errors).toEqual([{
			row: 1,
			message: `Cross-set identity collision: ${CURIE} is claimed by import set ${foreignSetId} at ${OLD_PATH}. Nothing was written for it. Refresh that set instead, or rename this source so it uses its own identities.`,
		}]);
		expect(result.created).toEqual([]);
		expect(renameFile).not.toHaveBeenCalled();
		expect(files.has(OLD_PATH)).toBe(true);
		expect(files.has(NEW_PATH)).toBe(false);
		expect(files.size).toBe(1);
	});

	it('reports ambiguous identity and does not pick a note to move', async () => {
		const otherPath = 'Mappings/duplicate/edge-1.md';
		const { app, files, renameFile } = makeApp([OLD_PATH, otherPath]);

		const result = await generateFromRecipe(app, parsed(), RECIPE, OPTIONS);

		expect(result.success).toBe(false);
		expect(result.errors).toEqual([
			{
				row: 0,
				message: `Ambiguous identity ${CURIE} claimed by: ${otherPath}, ${OLD_PATH}`,
			},
			{
				row: 1,
				message: `2 legacy crosswalk notes already record ${ROW.subject_id} -> ${ROW.object_id}: ${otherPath}, ${OLD_PATH}. Fix the duplicates, then import again.`,
			},
		]);
		expect(result.created).toEqual([]);
		expect(renameFile).not.toHaveBeenCalled();
		expect(files.has(OLD_PATH)).toBe(true);
		expect(files.has(otherPath)).toBe(true);
		expect(files.has(NEW_PATH)).toBe(false);
	});
});
