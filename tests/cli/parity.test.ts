/**
 * Parity: `cw import` on a plain folder writes the same managed content as the
 * plugin's own import path run against an in-memory vault, for nist-mini.csv
 * with the default (detected) recipe.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { TFile, TFolder } from 'obsidian';
import { runCli, defaultRecipeEntry, installDeterminism } from '../../cli/crosswalker';
import { DEFAULT_SETTINGS } from '../../src/settings/settings-data';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';
import { parseRecognizedSource, runRecognizedImport } from '../../src/import/run-recognized-import';
import { managedContentEquivalent } from '../../src/generation/managed-equivalence';
import type { DebugLog } from '../../src/utils/debug';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const SOURCE = path.join(REPO, 'tools/fixtures/synthetic/nist-mini.csv');
const DESTINATION = 'Frameworks/NIST-mini';
const ONTOLOGY = 'nist-mini';

const debug = { info() {}, trace() {}, warn() {}, error() {}, log() {} } as unknown as DebugLog;

function frontmatter(text: string): Record<string, unknown> | null {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	return match ? ((load(match[1]) as Record<string, unknown>) ?? {}) : null;
}

/** The smallest in-memory App the import path needs, in the style of the other harnesses. */
function memoryApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const fileEntry = (p: string) => {
		const file = new TFile(p);
		const name = p.split('/').pop()!;
		Object.assign(file, { name, basename: name.replace(/\.[^.]+$/, ''), extension: name.split('.').pop()! });
		return file;
	};
	const parentsOf = (p: string) => {
		const parts = p.split('/');
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
	};
	const key = (p: string) => p.replace(/^\/+/, '');
	const vault = {
		getName: () => 'memory',
		getRoot: () => new TFolder(''),
		getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map(fileEntry),
		getFiles: () => [...files.keys()].map(fileEntry),
		getAbstractFileByPath: (p: string) => {
			const k = key(p);
			if (files.has(k)) return fileEntry(k);
			if (folders.has(k)) return new TFolder(k);
			return null;
		},
		getFileByPath: (p: string) => (files.has(key(p)) ? fileEntry(key(p)) : null),
		getFolderByPath: (p: string) => (folders.has(key(p)) ? new TFolder(key(p)) : null),
		read: async (f: { path: string }) => files.get(key(f.path)) ?? '',
		cachedRead: async (f: { path: string }) => files.get(key(f.path)) ?? '',
		create: async (p: string, content: string) => {
			const k = key(p);
			if (files.has(k)) throw new Error('File already exists.');
			parentsOf(k);
			files.set(k, content);
			return fileEntry(k);
		},
		modify: async (f: { path: string }, content: string) => { files.set(key(f.path), content); },
		process: async (f: { path: string }, fn: (d: string) => string) => {
			const next = fn(files.get(key(f.path)) ?? '');
			files.set(key(f.path), next);
			return next;
		},
		createFolder: async (p: string) => { parentsOf(`${key(p)}/x`); },
		on: () => ({}),
		offref: () => {},
	};
	const metadataCache = {
		getFileCache: (f: { path: string } | null) => {
			if (!f) return null;
			const text = files.get(key(f.path));
			if (text === undefined) return null;
			const fm = frontmatter(text);
			return fm ? { frontmatter: fm } : {};
		},
		getFirstLinkpathDest: () => null,
		on: () => ({}),
		offref: () => {},
	};
	return { app: { vault, metadataCache, workspace: { on: () => ({}), offref: () => {} } } as never, files };
}

describe('cw import parity with the plugin import path', () => {
	it('writes managed-equivalent notes for nist-mini.csv with the default recipe', async () => {
		const vault = tempDir('parity');
		const { io, err } = captureIo();
		const code = await runCli(['import', '--vault', vault, '--source', SOURCE, '--ontology', ONTOLOGY,
			'--destination', DESTINATION, '--deterministic'], io);
		expect(err).toEqual([]);
		expect(code).toBe(0);
		const cliNotes = [...readTree(vault)].filter(([p]) => p.endsWith('.md'));
		expect(cliNotes.length).toBeGreaterThan(5);

		// The plugin path, same inputs, same pinned clock and set id.
		const memory = memoryApp();
		const restore = installDeterminism();
		try {
			const bytes = fs.readFileSync(SOURCE);
			const handle = new TFile('nist-mini.csv');
			Object.assign(handle, { name: 'nist-mini.csv', basename: 'nist-mini', extension: 'csv' });
			const request = { file: handle, table: '', headerRow: 1 } as const;
			const parsedData = await parseRecognizedSource(new File([bytes], 'nist-mini.csv'), { ...request, entry: RECIPE_REGISTRY[0] });
			const entry = defaultRecipeEntry(parsedData, ONTOLOGY, DESTINATION, debug);
			const outcome = await runRecognizedImport(memory.app, {
				app: memory.app, settings: DEFAULT_SETTINGS, debug, runProjection: null, precomputeClosure: null,
			} as never, { ...request, entry, parsedData, destination: DESTINATION });
			expect(outcome.errors).toEqual([]);
			expect(outcome.ok).toBe(true);
		} finally {
			restore();
		}

		const memoryNotes = [...memory.files].filter(([p]) => p.endsWith('.md'));
		expect(memoryNotes.map(([p]) => p).sort()).toEqual(cliNotes.map(([p]) => p).sort());
		for (const [notePath, bytes] of cliNotes) {
			const result = managedContentEquivalent(bytes.toString('utf8'), memory.files.get(notePath)!, {
				parseYaml: (text) => load(text),
			});
			expect({ notePath, differences: result.differences }).toEqual({ notePath, differences: [] });
		}
	}, 60000);
});
