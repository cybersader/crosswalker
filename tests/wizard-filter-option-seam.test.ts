import { TFile, TFolder } from 'obsidian';
import { ImportFlow } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import type { DebugLog } from '../src/utils/debug';
import type { GenerationResult, ParsedData, SavedConfig } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

type FlowApp = ConstructorParameters<typeof ImportFlow>[0];
type FlowPlugin = ConstructorParameters<typeof ImportFlow>[1];

interface FlowInternals {
	doGenerate(): Promise<void>;
	renderStep(): void;
	renderGenerationResults(result: GenerationResult): void;
	waitForMetadataResolve(): Promise<void>;
	discoveredSets: [];
	destinationEdited: boolean;
	isWorkbenchMode(): boolean;
}

const inner = (flow: ImportFlow): FlowInternals => flow as unknown as FlowInternals;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as { Notice: new (message: string, timeout?: number) => unknown };
const RealNotice = obsidianModule.Notice;
const notices: string[] = [];

beforeAll(() => {
	obsidianModule.Notice = class {
		constructor(message: string) { notices.push(message); }
	} as unknown as typeof RealNotice;
});

afterAll(() => { obsidianModule.Notice = RealNotice; });
beforeEach(() => { notices.length = 0; });

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const create = jest.fn(async (path: string, content: string) => {
		files.set(path, content);
		return new TFile(path);
	});
	const modify = jest.fn(async (file: TFile, content: string) => {
		files.set(file.path, content);
	});
	const remove = jest.fn(async (file: TFile) => {
		files.delete(file.path);
	});
	const rename = jest.fn(async (file: TFile, path: string) => {
		const content = files.get(file.path);
		if (content !== undefined) {
			files.delete(file.path);
			files.set(path, content);
		}
		file.path = path;
	});
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create,
			modify,
			delete: remove,
			read: async (file: TFile) => files.get(file.path) ?? '',
			cachedRead: async (file: TFile) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		fileManager: { renameFile: rename },
		metadataCache: { getFileCache: () => null },
	};
	return { app: app as unknown as FlowApp, files, create, modify, remove, rename };
}

const debug = {
	info() {}, trace() {}, warn() {}, error() {},
	newTraceId: () => 'wizard-filter-seam',
	withTrace: <T>(_id: string, fn: () => T): T => fn(),
} as unknown as DebugLog;

const SAVED_CLASSIC_CONFIG: SavedConfig = {
	schemaVersion: 1,
	id: 'saved-classic-config-id',
	name: 'Saved classic display name',
	createdAt: '2026-09-07T00:00:00.000Z',
	updatedAt: '2026-09-07T00:00:00.000Z',
	fingerprint: {
		columnNames: [],
		columnNamesNormalized: [],
		columnCount: 0,
	},
	config: {
		name: 'different-classic-recipe-name',
		mapping: {
			hierarchy: [],
			frontmatter: [],
			links: [],
			body: [],
			filename: { template: '{name}.md', sanitize: true },
		},
	},
};

function makeFlow(where: string) {
	const vault = makeApp();
	const close = jest.fn();
	const plugin = {
		settings: {
			...DEFAULT_SETTINGS,
			enableShapeWorkbench: false,
			promptToSaveConfig: false,
		},
		debug,
		draftStore: { delete: jest.fn() },
	} as unknown as FlowPlugin;
	const flow = new ImportFlow(vault.app, plugin, {
		containerEl: null as unknown as HTMLElement,
		close,
	});
	flow.currentStep = 4;
	flow.sourceType = 'json';
	flow.sourceFile = { name: 'stix.json' } as File;
	flow.appliedConfig = SAVED_CLASSIC_CONFIG;
	flow.outputPath = 'Out';
	flow.overwriteMode = 'replace';
	flow.jsonWhere = where;
	flow.parsedData = stixRows();
	flow.columnConfigs = new Map([
		['type', { useAs: 'frontmatter', outputKey: 'type' }],
		['name', { useAs: 'title', outputKey: 'name' }],
		['x_mitre_is_subtechnique', { useAs: 'frontmatter', outputKey: 'x_mitre_is_subtechnique' }],
		['revoked', { useAs: 'frontmatter', outputKey: 'revoked' }],
		['source_ref', { useAs: 'frontmatter', outputKey: 'source_ref' }],
		['target_ref', { useAs: 'frontmatter', outputKey: 'target_ref' }],
	]);
	const internals = inner(flow);
	internals.discoveredSets = [];
	internals.destinationEdited = true;
	internals.renderStep = jest.fn();
	internals.waitForMetadataResolve = jest.fn(async () => undefined);
	const results: GenerationResult[] = [];
	internals.renderGenerationResults = jest.fn((result: GenerationResult) => { results.push(result); });
	return { flow, internals, vault, close, results };
}

function stixRows(): ParsedData {
	return {
		columns: ['type', 'name', 'x_mitre_is_subtechnique', 'revoked', 'source_ref', 'target_ref'],
		rows: [
			{ type: 'attack-pattern', name: 'Process Injection', x_mitre_is_subtechnique: 'false' },
			{ type: 'attack-pattern', name: 'Old Technique', revoked: 'true' },
			{ type: 'relationship', source_ref: 'x', target_ref: 'y' },
		],
		rowCount: 3,
	};
}

function frontmatterFor(files: Map<string, string>, path: string): Record<string, any> {
	const text = files.get(path);
	if (!text) throw new Error(`missing generated note ${path}`);
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) throw new Error(`missing frontmatter in ${path}`);
	return (yaml.load(match[1]) ?? {}) as Record<string, any>;
}

describe('ImportFlow ordinary filter option seam', () => {
	it('carries the classic UI filter through doGenerate and preserves configId ownership', async () => {
		const subject = makeFlow('type=attack-pattern,revoked!=true');
		expect(subject.internals.isWorkbenchMode()).toBe(false);

		await subject.internals.doGenerate();

		expect([...subject.vault.files.keys()]).toEqual(['Out/Process Injection.md']);
		const fm = frontmatterFor(subject.vault.files, 'Out/Process Injection.md');
		expect(SAVED_CLASSIC_CONFIG.id).not.toBe(SAVED_CLASSIC_CONFIG.config.name);
		expect(fm._crosswalker.recipe.id).toBe(SAVED_CLASSIC_CONFIG.id);
		expect(fm).not.toHaveProperty('revoked');
		expect(fm).not.toHaveProperty('source_ref');
		expect(fm).not.toHaveProperty('target_ref');
		expect(subject.vault.create).toHaveBeenCalledTimes(1);
		expect(subject.vault.modify).not.toHaveBeenCalled();
		expect(subject.vault.remove).not.toHaveBeenCalled();
		expect(subject.vault.rename).not.toHaveBeenCalled();
		expect(subject.results).toEqual([]);
		expect(subject.close).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed UI shorthand before any note mutation', async () => {
		const subject = makeFlow('type');

		await subject.internals.doGenerate();

		expect(subject.vault.create).not.toHaveBeenCalled();
		expect(subject.vault.modify).not.toHaveBeenCalled();
		expect(subject.vault.remove).not.toHaveBeenCalled();
		expect(subject.vault.rename).not.toHaveBeenCalled();
		expect(subject.close).not.toHaveBeenCalled();
		expect(subject.flow.isGenerating).toBe(false);
		expect(notices.join('\n')).toContain('Malformed filter "type"');
	});
});
