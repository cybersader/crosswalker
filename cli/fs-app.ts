/**
 * A filesystem-backed subset of the Obsidian `App`, so the plugin's own
 * engine, importers, exporters and validator run unchanged against a plain
 * folder. Same code path as the plugin, so the command line and the UI write
 * the same managed content.
 *
 * Implemented, because these call sites use them (surveyed 2026-10-27 across
 * src/generation, src/import/run-recognized-import.ts, src/import/sssom-importer.ts,
 * src/mappings/mapping-set.ts, src/export and src/validation):
 *
 *   vault.getAbstractFileByPath   engine, identity index, import set, exporters
 *   vault.getMarkdownFiles        identity index, import-set discovery, vault-reader
 *   vault.getFiles                listing helpers
 *   vault.read / cachedRead       existing-note merge, vault-reader, sssom-importer
 *   vault.readBinary              run-recognized-import (source file bytes)
 *   vault.create / modify         engine, sssom-importer, mapping-set record
 *   vault.createFolder            engine (createFolders)
 *   vault.rename                  engine relocation
 *   vault.trash                   mapping-set duplicate cleanup (moves to .trash/)
 *   vault.delete                  removal helpers
 *   vault.getRoot                 folder pickers
 *   vault.adapter                 exists / read / write / mkdir: the recipe copy
 *                                 each import keeps (import-set-recipes.ts)
 *   fileManager.renameFile        engine relocation (generation-engine.ts)
 *   metadataCache.getFileCache    existing-note, identity-index, import-set,
 *                                 vault-reader, sssom-importer. Never null for an
 *                                 existing file: the cache is read from disk on
 *                                 every call, so "not indexed yet" cannot occur.
 *
 * Probed as optional and left absent on purpose: metadataCache.on / offref
 * (settleVaultIndex only subscribes when a file is unindexed, which never
 * happens here).
 * Any other method throws "not supported from the command line: <method>".
 *
 * Paths are vault-relative and `/`-separated. Absolute paths and `..` segments
 * are rejected, so nothing escapes the vault folder. Dot-folders (`.obsidian`,
 * `.trash`) are not listed as vault content, matching Obsidian.
 *
 * `obsidian` resolves to `tests/__mocks__/obsidian.ts` (jest mapper, or the bun
 * preload in `cli/preload.ts`), so `TFile`, `TFolder` and `normalizePath` here
 * are the same classes the plugin code checks with `instanceof`.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { TFile, TFolder, normalizePath } from 'obsidian';

/**
 * The CLI runs on the test stand-in for obsidian (cli/preload.ts), whose
 * TFile/TFolder take their path; the real API types declare no-arg constructors.
 */
export const StandInTFile = TFile as unknown as new (path: string) => TFile;
/** See {@link StandInTFile}. */
export const StandInTFolder = TFolder as unknown as new (path: string) => TFolder;
// js-yaml is what the in-memory test harnesses parse frontmatter with; Obsidian
// itself parses full YAML, which the mock's limited `parseYaml` does not.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

type AnyFile = TFile | TFolder;

/** Thrown for any App method the command line does not provide. */
export class UnsupportedFromCommandLineError extends Error {
	constructor(method: string) {
		super(`not supported from the command line: ${method}`);
		this.name = 'UnsupportedFromCommandLineError';
	}
}

/**
 * Normalize and check a vault-relative path. Throws on an absolute path or a
 * `..` segment, naming the cause and the fix.
 */
export function vaultRelative(input: string): string {
	const raw = String(input ?? '').replace(/\\/g, '/');
	if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
		throw new Error(`Path "${input}" is absolute. Give a path relative to the vault folder.`);
	}
	if (raw.split('/').some((segment) => segment === '..')) {
		throw new Error(`Path "${input}" uses "..", which would leave the vault folder. Give a path inside the vault.`);
	}
	const out = normalizePath(raw);
	return out === '.' ? '' : out.replace(/^\.\//, '');
}

/**
 * The vault API's own path rule. Obsidian's `normalizePath` drops a leading
 * slash, so engine code that joins an empty base folder with `/name` means the
 * vault root, not the disk root. `..` is still refused. Flags typed by a person
 * go through the strict `vaultRelative` instead.
 */
function vaultKey(input: string): string {
	return vaultRelative(String(input ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
}

function frontmatterOf(text: string): Record<string, unknown> | undefined {
	const normalized = text.replace(/\r\n/g, '\n');
	const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
	if (!match) return undefined;
	try {
		const parsed = yaml.load(match[1]);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		// Obsidian reports an unparseable block as no frontmatter, not an error.
		return undefined;
	}
}

/** Wikilinks inside frontmatter values, shaped like Obsidian's `frontmatterLinks`. */
function frontmatterLinksOf(fm: Record<string, unknown> | undefined): Array<{ key: string; link: string; original: string; displayText?: string }> {
	if (!fm) return [];
	const out: Array<{ key: string; link: string; original: string; displayText?: string }> = [];
	const visit = (key: string, value: unknown): void => {
		if (typeof value === 'string') {
			for (const m of value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
				out.push({ key, link: m[1].trim(), original: m[0], ...(m[2] !== undefined ? { displayText: m[2] } : {}) });
			}
		} else if (Array.isArray(value)) {
			value.forEach((item, i) => visit(`${key}.${i}`, item));
		}
	};
	for (const [key, value] of Object.entries(fm)) visit(key, value);
	return out;
}

/** Wrap an object so any method it lacks throws instead of being undefined. */
function strict<T extends object>(target: T, owner: string, optional: ReadonlySet<string>): T {
	return new Proxy(target, {
		get(obj, prop, receiver) {
			if (typeof prop === 'symbol' || prop in obj) return Reflect.get(obj, prop, receiver);
			if (prop === 'then' || prop === 'toJSON' || optional.has(prop)) return undefined;
			return () => { throw new UnsupportedFromCommandLineError(`${owner}.${prop}`); };
		},
	});
}

export interface FsApp {
	vault: any;
	metadataCache: any;
	fileManager: any;
	workspace: any;
	/** Absolute folder this App reads and writes. */
	root: string;
}

/**
 * Build an App subset over `rootDir` (created if missing). The file index is
 * scanned once here and kept in step by every write made through this App.
 */
export function createFsApp(rootDir: string): FsApp {
	const root = nodePath.resolve(rootDir);
	fs.mkdirSync(root, { recursive: true });
	const entries = new Map<string, AnyFile>();
	const rootFolder = new StandInTFolder('');
	(rootFolder as any).name = '';
	(rootFolder as any).parent = null;
	(rootFolder as any).isRoot = () => true;
	entries.set('', rootFolder);

	const abs = (path: string): string => nodePath.join(root, ...vaultKey(path).split('/').filter(Boolean));
	const parentPath = (path: string): string => {
		const i = path.lastIndexOf('/');
		return i === -1 ? '' : path.slice(0, i);
	};
	const isHidden = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.'));

	const attach = (child: AnyFile): void => {
		const parent = entries.get(parentPath(child.path)) as TFolder | undefined;
		(child as any).parent = parent ?? null;
		if (parent && !parent.children.includes(child)) parent.children.push(child);
	};
	const detach = (child: AnyFile): void => {
		const parent = (child as any).parent as TFolder | null;
		if (parent) parent.children = parent.children.filter((c: AnyFile) => c !== child);
	};

	const makeFile = (path: string): TFile => {
		const file = new StandInTFile(path);
		const name = path.split('/').pop() ?? path;
		const dot = name.lastIndexOf('.');
		(file as any).name = name;
		file.extension = dot > 0 ? name.slice(dot + 1) : '';
		file.basename = dot > 0 ? name.slice(0, dot) : name;
		const stat = fs.statSync(abs(path));
		(file as any).stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
		(file as any).vault = vault;
		return file;
	};
	const makeFolder = (path: string): TFolder => {
		const folder = new StandInTFolder(path);
		(folder as any).name = path.split('/').pop() ?? path;
		(folder as any).isRoot = () => false;
		(folder as any).vault = vault;
		return folder;
	};
	const refreshStat = (file: TFile): void => {
		const stat = fs.statSync(abs(file.path));
		(file as any).stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
	};

	const ensureFolderEntry = (path: string): TFolder => {
		const existing = entries.get(path);
		if (existing instanceof TFolder) return existing;
		if (existing) throw new Error(`Cannot create folder "${path}": a file already has that path. Rename the file or choose another folder.`);
		if (path !== '') ensureFolderEntry(parentPath(path));
		const folder = makeFolder(path);
		entries.set(path, folder);
		attach(folder);
		return folder;
	};

	const asPath = (fileOrPath: { path: string } | string): string =>
		vaultKey(typeof fileOrPath === 'string' ? fileOrPath : fileOrPath.path);
	const requireFile = (fileOrPath: { path: string } | string, method: string): TFile => {
		const path = asPath(fileOrPath);
		const entry = entries.get(path);
		if (!(entry instanceof TFile)) throw new Error(`${method}: no file at "${path}". Check the path, then run the command again.`);
		return entry;
	};

	const moveEntry = (entry: AnyFile, newPath: string): void => {
		const target = vaultKey(newPath);
		if (entries.has(target)) throw new Error(`Cannot move "${entry.path}" to "${target}": something already has that path.`);
		ensureFolderEntry(parentPath(target));
		fs.mkdirSync(nodePath.dirname(abs(target)), { recursive: true });
		fs.renameSync(abs(entry.path), abs(target));
		const oldPath = entry.path;
		const moved: AnyFile[] = [...entries.values()].filter((e) => e.path === oldPath || e.path.startsWith(`${oldPath}/`));
		for (const e of moved) entries.delete(e.path);
		detach(entry);
		for (const e of moved) {
			e.path = target + e.path.slice(oldPath.length);
			const name = e.path.split('/').pop() ?? e.path;
			(e as any).name = name;
			if (e instanceof TFile) {
				const dot = name.lastIndexOf('.');
				e.basename = dot > 0 ? name.slice(0, dot) : name;
			}
			entries.set(e.path, e);
		}
		attach(entry);
	};

	const vault = strict({
		getName: () => nodePath.basename(root),
		getRoot: () => rootFolder,
		getAbstractFileByPath: (path: string) => {
			let key: string;
			try { key = vaultKey(path); } catch { return null; }
			return entries.get(key) ?? null;
		},
		getFileByPath: (path: string) => {
			const entry = vault.getAbstractFileByPath(path);
			return entry instanceof TFile ? entry : null;
		},
		getFolderByPath: (path: string) => {
			const entry = vault.getAbstractFileByPath(path);
			return entry instanceof TFolder ? entry : null;
		},
		getFiles: () => [...entries.values()].filter((e): e is TFile => e instanceof TFile),
		getMarkdownFiles: () => [...entries.values()].filter((e): e is TFile => e instanceof TFile && e.extension === 'md'),
		getAllLoadedFiles: () => [...entries.values()],
		read: async (file: { path: string }) => fs.readFileSync(abs(requireFile(file, 'read').path), 'utf8'),
		cachedRead: async (file: { path: string }) => fs.readFileSync(abs(requireFile(file, 'cachedRead').path), 'utf8'),
		readBinary: async (file: { path: string }) => {
			const buf = fs.readFileSync(abs(requireFile(file, 'readBinary').path));
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
		create: async (path: string, content: string) => {
			const key = vaultKey(path);
			if (entries.has(key)) throw new Error('File already exists.');
			ensureFolderEntry(parentPath(key));
			fs.mkdirSync(nodePath.dirname(abs(key)), { recursive: true });
			fs.writeFileSync(abs(key), content, 'utf8');
			const file = makeFile(key);
			entries.set(key, file);
			attach(file);
			return file;
		},
		modify: async (file: { path: string }, content: string) => {
			const target = requireFile(file, 'modify');
			fs.writeFileSync(abs(target.path), content, 'utf8');
			refreshStat(target);
		},
		process: async (file: { path: string }, fn: (data: string) => string) => {
			const target = requireFile(file, 'process');
			const next = fn(fs.readFileSync(abs(target.path), 'utf8'));
			fs.writeFileSync(abs(target.path), next, 'utf8');
			refreshStat(target);
			return next;
		},
		createFolder: async (path: string) => {
			const key = vaultKey(path);
			if (entries.has(key)) throw new Error('Folder already exists.');
			fs.mkdirSync(abs(key), { recursive: true });
			return ensureFolderEntry(key);
		},
		rename: async (file: AnyFile, newPath: string) => {
			const entry = entries.get(asPath(file));
			if (!entry) throw new Error(`rename: nothing at "${file.path}".`);
			moveEntry(entry, newPath);
		},
		delete: async (file: AnyFile) => {
			const key = asPath(file);
			const entry = entries.get(key);
			if (!entry || key === '') throw new Error(`delete: nothing at "${key}".`);
			fs.rmSync(abs(key), { recursive: true, force: true });
			for (const p of [...entries.keys()]) if (p === key || p.startsWith(`${key}/`)) entries.delete(p);
			detach(entry);
		},
		// Obsidian's local trash: move under `.trash/`, which is hidden from the index.
		trash: async (file: AnyFile, _system: boolean) => {
			const key = asPath(file);
			const entry = entries.get(key);
			if (!entry || key === '') throw new Error(`trash: nothing at "${key}".`);
			let dest = nodePath.join(root, '.trash', ...key.split('/'));
			for (let n = 1; fs.existsSync(dest); n += 1) dest = `${nodePath.join(root, '.trash', ...key.split('/'))} ${n}`;
			fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
			fs.renameSync(abs(key), dest);
			for (const p of [...entries.keys()]) if (p === key || p.startsWith(`${key}/`)) entries.delete(p);
			detach(entry);
		},
	}, 'vault', new Set(['adapter', 'on', 'off', 'offref', 'config']));

	// The raw file layer. Obsidian indexes adapter writes from its file watcher;
	// here the write is indexed straight away, so the vault view stays in step.
	(vault as any).adapter = {
		exists: async (path: string) => fs.existsSync(abs(path)),
		read: async (path: string) => fs.readFileSync(abs(path), 'utf8'),
		write: async (path: string, text: string) => {
			const key = vaultKey(path);
			fs.mkdirSync(nodePath.dirname(abs(key)), { recursive: true });
			fs.writeFileSync(abs(key), text);
			const existing = entries.get(key);
			if (existing instanceof TFile) { refreshStat(existing); return; }
			if (isHidden(key)) return;
			ensureFolderEntry(parentPath(key));
			const file = makeFile(key);
			entries.set(key, file);
			attach(file);
		},
		mkdir: async (path: string) => {
			const key = vaultKey(path);
			fs.mkdirSync(abs(key), { recursive: true });
			if (!isHidden(key)) ensureFolderEntry(key);
		},
	};

	const metadataCache = strict({
		getFileCache: (file: { path: string } | null | undefined) => {
			if (!file) return null;
			let key: string;
			try { key = vaultKey(file.path); } catch { return null; }
			const entry = entries.get(key);
			if (!(entry instanceof TFile)) return null;
			if (entry.extension !== 'md') return {};
			const frontmatter = frontmatterOf(fs.readFileSync(abs(key), 'utf8'));
			if (!frontmatter) return {};
			const links = frontmatterLinksOf(frontmatter);
			return { frontmatter, ...(links.length > 0 ? { frontmatterLinks: links } : {}) };
		},
		getFirstLinkpathDest: (linkpath: string, _source: string) => {
			const target = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
			const exact = entries.get(target);
			if (exact instanceof TFile) return exact;
			const base = target.split('/').pop();
			const matches = [...entries.values()]
				.filter((e): e is TFile => e instanceof TFile && e.path.split('/').pop() === base)
				.sort((a, b) => a.path.localeCompare(b.path));
			return matches[0] ?? null;
		},
	}, 'metadataCache', new Set(['on', 'off', 'offref', 'resolvedLinks', 'unresolvedLinks']));

	const fileManager = strict({
		renameFile: async (file: AnyFile, newPath: string) => vault.rename(file, newPath),
	}, 'fileManager', new Set());

	const workspace = strict({}, 'workspace', new Set(['on', 'off', 'offref']));

	// Index what is already on disk.
	const scan = (dirAbs: string, rel: string): void => {
		for (const dirent of fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
			if (isHidden(childRel)) continue;
			if (dirent.isDirectory()) {
				ensureFolderEntry(childRel);
				scan(nodePath.join(dirAbs, dirent.name), childRel);
			} else if (dirent.isFile()) {
				const file = makeFile(childRel);
				entries.set(childRel, file);
				attach(file);
			}
		}
	};
	scan(root, '');

	return { vault, metadataCache, fileManager, workspace, root };
}
