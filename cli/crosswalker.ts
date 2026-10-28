/**
 * Crosswalker command line, first slice (2026-10-27).
 *
 *   bun run cw -- import   --vault <dir> --source <file> [--recipe <id|path>]
 *                          [--set new|<set id>] [--ontology <id>] [--destination <folder>]
 *                          [--deterministic]
 *   bun run cw -- validate --vault <dir> [--folder <folder>]
 *   bun run cw -- export   --vault <dir> --folder <folder> --format csv|sssom|strm --out <file>
 *   bun run cw -- replay   --vault <dir> --set <set id>        (not available yet)
 *
 * Every command runs the plugin's own `src/` code against a plain folder through
 * `cli/fs-app.ts`, so the command line and the plugin write the same notes.
 *
 * Exit codes: 0 ok, 1 usage or runtime error, 2 validation failures.
 * The process entry is `cli/main.ts`; this module only exports `runCli`, so
 * tests call it in-process.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { TFile } from 'obsidian';
import { createFsApp, vaultRelative, type FsApp } from './fs-app';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import {
	RECIPE_REGISTRY,
	applyHeaderAliases,
	libraryRegistryEntry,
	type RecipeRegistryEntry,
} from '../src/import/recipe-registry';
import { parseRecognizedSource, runRecognizedImport } from '../src/import/run-recognized-import';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { MappingWorkbench } from '../src/import/workbench';
import { patchRecipeDocument } from '../src/import/recipe-document';
import type { ImportMapping } from '../src/import/mapping/types';
import { importSssom } from '../src/import/sssom-importer';
import { exportFolderAsCsv } from '../src/export/csv-exporter';
import { exportFolderAsSssomTsv } from '../src/export/sssom-exporter';
import { exportFolderAsStrmTsv, releaseFilePathFor, strmReleaseFileContent } from '../src/export/strm-tsv-exporter';
import { validateTier1Frontmatter } from '../src/validation/validator';
import type { ParsedData } from '../src/types/config';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import { DebugLog } from '../src/utils/debug';

/** Pinned clock and first set id under --deterministic, as tools/generate-fixtures.ts pins them. */
export const DETERMINISTIC_PRODUCED_AT = '2026-05-04T00:00:00.000Z';
export const DETERMINISTIC_FIRST_SET_ID = 'iset-a0f1e2';

/** A usage or runtime error with a cause and a next step. Exit 1. */
class CliError extends Error {}

const USAGE = [
	'Usage: bun run cw -- <command> [options]',
	'',
	'Commands:',
	'  import    --vault <dir> --source <file> [--recipe <id|path>] [--set new|<set id>]',
	'            [--ontology <id>] [--destination <folder>] [--deterministic]',
	'  validate  --vault <dir> [--folder <folder>]',
	'  export    --vault <dir> --folder <folder> --format csv|sssom|strm --out <file>',
	'  replay    --vault <dir> --set <set id>   (not available from the command line yet)',
	'  recipes   list the built-in recipe ids',
	'',
	'Exit codes: 0 ok, 1 usage or runtime error, 2 validation failures.',
].join('\n');

interface Io {
	out: (line: string) => void;
	err: (line: string) => void;
}

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): { command: string | undefined; flags: Flags } {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	const [command, ...rest] = args;
	const flags: Flags = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token === '--') continue;
		if (!token.startsWith('--')) {
			throw new CliError(`Unexpected argument "${token}". Options start with --; run "bun run cw -- help" for the list.`);
		}
		const eq = token.indexOf('=');
		if (eq > 0) {
			flags[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const name = token.slice(2);
		const next = rest[i + 1];
		if (next === undefined || next.startsWith('--')) flags[name] = true;
		else {
			flags[name] = next;
			i++;
		}
	}
	return { command, flags };
}

function stringFlag(flags: Flags, name: string, required: true, hint: string): string;
function stringFlag(flags: Flags, name: string, required?: false, hint?: string): string | undefined;
function stringFlag(flags: Flags, name: string, required = false, hint = ''): string | undefined {
	const value = flags[name];
	if (value === true) throw new CliError(`--${name} needs a value. ${hint}`.trim());
	if (value === undefined && required) throw new CliError(`Missing --${name}. ${hint}`.trim());
	return value;
}

function allowOnly(flags: Flags, allowed: string[], command: string): void {
	for (const name of Object.keys(flags)) {
		if (!allowed.includes(name)) {
			throw new CliError(`Unknown option --${name} for "${command}". Allowed: ${allowed.map((a) => `--${a}`).join(', ')}.`);
		}
	}
}

function openVault(flags: Flags): FsApp {
	const dir = stringFlag(flags, 'vault', true, 'Pass the vault folder, for example --vault ./my-vault.');
	return createFsApp(dir);
}

function folderFlag(flags: Flags, name: string, required: boolean): string | undefined {
	const raw = required
		? stringFlag(flags, name, true, `Pass a folder inside the vault, for example --${name} Frameworks.`)
		: stringFlag(flags, name);
	if (raw === undefined) return undefined;
	try {
		return vaultRelative(raw);
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error));
	}
}

// ---------------------------------------------------------------- determinism

/**
 * Pin every clock read and random draw the import path makes, so two runs on
 * the same inputs write byte-identical trees. Returns the restore function;
 * `runCli` always restores, because jest calls it in-process.
 *
 * - `new Date()` and `Date.now()` return DETERMINISTIC_PRODUCED_AT (the
 *   provenance `produced_at` and the mapping-set record's dates).
 * - `crypto.getRandomValues` replays a fixed stream whose first 6 bytes make
 *   the import set id `iset-a0f1e2`; later draws come from a sha256 counter,
 *   so a second set minted in the same vault gets a distinct, stable id
 *   (minting retries on collision with ids already present).
 * - `Math.random` comes from a separate seeded stream.
 */
export function installDeterminism(): () => void {
	const fixedMs = Date.parse(DETERMINISTIC_PRODUCED_AT);
	const RealDate = Date;
	class PinnedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(fixedMs);
			else super(...(args as [string]));
		}
		static now(): number {
			return fixedMs;
		}
	}
	// Date indices: [0,26,5,27,4,28] -> a,0,f,1,e,2 in the minting alphabet.
	const lead = [0, 26, 5, 27, 4, 28];
	let counter = 0;
	let buffer: number[] = [...lead];
	const nextByte = (): number => {
		if (buffer.length === 0) {
			buffer = [...createHash('sha256').update(`crosswalker-cli-${counter++}`).digest()];
		}
		return buffer.shift()!;
	};

	const cryptoApi = globalThis.crypto as Crypto;
	const ownGetRandom = Object.getOwnPropertyDescriptor(cryptoApi, 'getRandomValues');
	const realRandom = Math.random;
	Object.defineProperty(cryptoApi, 'getRandomValues', {
		configurable: true,
		writable: true,
		value: <T extends ArrayBufferView | null>(array: T): T => {
			if (array) {
				const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
				for (let i = 0; i < bytes.length; i++) bytes[i] = nextByte();
			}
			return array;
		},
	});
	// Math.random draws from its own stream (trace ids, draft ids), so how often
	// the engine logs can never shift which import set id gets minted.
	let randomCounter = 0;
	Math.random = () => {
		const digest = createHash('sha256').update(`crosswalker-cli-random-${randomCounter++}`).digest();
		return digest.readUIntBE(0, 6) / 2 ** 48;
	};
	globalThis.Date = PinnedDate as DateConstructor;

	return () => {
		globalThis.Date = RealDate;
		Math.random = realRandom;
		if (ownGetRandom) Object.defineProperty(cryptoApi, 'getRandomValues', ownGetRandom);
		else delete (cryptoApi as unknown as Record<string, unknown>).getRandomValues;
	};
}

// --------------------------------------------------------------------- import

/**
 * The plugin's debug log with its console echo switched off: the engine logs
 * every step, which is noise on a terminal. Nothing is written to disk either
 * (logging stays disabled, as the plugin's default is).
 */
function quietDebug(app: FsApp): DebugLog {
	const log = new DebugLog(app as never, false);
	(log as unknown as { recordAndMaybeWrite: (event: unknown) => void }).recordAndMaybeWrite = () => {};
	return log;
}

function pluginStub(app: FsApp, debug: DebugLog) {
	return {
		app,
		settings: DEFAULT_SETTINGS,
		debug,
		runProjection: null,
		precomputeClosure: null,
	};
}

function slugOf(text: string): string {
	return text.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function readSource(flags: Flags): { abs: string; name: string; bytes: Buffer } {
	const source = stringFlag(flags, 'source', true, 'Pass the file to import, for example --source controls.csv.');
	const abs = nodePath.resolve(source);
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
		throw new CliError(`Source file not found: ${source}. Check the path, then run the import again.`);
	}
	return { abs, name: nodePath.basename(abs), bytes: fs.readFileSync(abs) };
}

/** A stand-in TFile for a source that lives outside the vault: only its name is read. */
function sourceHandle(name: string): TFile {
	const file = new TFile(name) as TFile & { name: string; extension: string };
	file.name = name;
	file.extension = (name.split('.').pop() ?? '').toLowerCase();
	return file;
}

/** Resolve --recipe: a built-in id, a recipe JSON path, or absent (detect the structure). */
function resolveRecipe(flags: Flags): RecipeRegistryEntry | null {
	const value = stringFlag(flags, 'recipe');
	if (value === undefined || value === 'default') return null;
	const builtIn = RECIPE_REGISTRY.find((entry) => entry.id === value);
	if (builtIn) return builtIn;
	const abs = nodePath.resolve(value);
	if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new CliError(`Recipe file ${value} is not valid JSON: ${cause}. Fix the file, then run the import again.`);
		}
		const recipe = parsed as CrosswalkerImportRecipe;
		if (!recipe || typeof recipe !== 'object' || typeof recipe.recipe !== 'string' || !recipe.target) {
			throw new CliError(`Recipe file ${value} has no "recipe" id or "target" section. Use a recipe saved from Crosswalker, or a built-in id from "bun run cw -- recipes".`);
		}
		return libraryRegistryEntry(recipe);
	}
	throw new CliError(`No built-in recipe or recipe file named "${value}". Run "bun run cw -- recipes" for the built-in ids, or pass a path to a recipe JSON file.`);
}

/** The recipe the import wizard proposes for a fresh source (structure detection, default preset). */
export function defaultRecipeEntry(parsedData: ParsedData, ontology: string, destination: string, debug: DebugLog): RecipeRegistryEntry {
	const workbench = new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: destination,
		debug,
		defaultPresetId: 'browsable-framework',
		sourceOntology: ontology,
		seedColumnDefaults: true,
		onChange: () => {},
	});
	// Regions are built while the detected parent link still carries its
	// `skos:broader` predicate, because that is what derives `parent_curie`.
	// The predicate itself is not written anywhere (managed frontmatter cannot
	// carry it, see mapping/types.ts), so the portability check would block a
	// predicate that renders nothing. Patch the canonical document with the same
	// regions over a mapping without that implied predicate. Any other
	// predicate or direction is left in place and still blocks.
	const regions = workbench.buildFinalRegions();
	const mapping = withoutImpliedBroader(workbench.getMapping());
	const patched = patchRecipeDocument(workbench.getRecipeDocument(), { mapping, regions });
	if (!patched.ok) {
		throw new Error(patched.diagnostics
			.filter((diagnostic) => diagnostic.severity === 'blocking')
			.map((diagnostic) => diagnostic.message)
			.join('; '));
	}
	return libraryRegistryEntry(patched.recipe as CrosswalkerImportRecipe);
}

/** Drop `skos:broader` from parent-on-child link destinations: it is the implied meaning of a parent link. */
function withoutImpliedBroader(mapping: ImportMapping): ImportMapping {
	return {
		...mapping,
		mappings: mapping.mappings.map((structure) => ({
			...structure,
			levels: structure.levels.map((level) => ({
				...level,
				destinations: level.destinations.map((destination) => {
					if (destination.primitive !== 'link' || destination.direction !== 'parent-on-child'
						|| destination.predicate !== 'skos:broader') return destination;
					const { predicate: _implied, ...rest } = destination;
					return rest;
				}),
			})),
		})),
	};
}

function setFlag(flags: Flags): string | undefined {
	const value = stringFlag(flags, 'set');
	if (value === undefined || value === 'new') return undefined;
	if (!/^iset-[a-z0-9]+$/.test(value)) {
		throw new CliError(`--set takes "new" or an existing set id such as iset-a0f1e2, not "${value}". Run the import once without --set to mint one.`);
	}
	return value;
}

async function commandImport(flags: Flags, io: Io): Promise<number> {
	allowOnly(flags, ['vault', 'source', 'recipe', 'set', 'ontology', 'destination', 'deterministic'], 'import');
	const app = openVault(flags);
	const source = readSource(flags);
	const refreshSetId = setFlag(flags);
	const destinationFlag = folderFlag(flags, 'destination', false);
	const ontologyFlag = stringFlag(flags, 'ontology');

	if (/\.sssom\.tsv$/i.test(source.name)) {
		if (flags.recipe !== undefined) {
			throw new CliError('A mapping file (.sssom.tsv) imports without a recipe. Remove --recipe, then run the import again.');
		}
		const result = await importSssom(app as never, source.bytes.toString('utf8'), null, null, {
			...(destinationFlag ? { outputFolder: destinationFlag } : {}),
			...(ontologyFlag ? { sourceOntology: ontologyFlag } : {}),
			overwriteMode: 'replace',
			importSet: refreshSetId ? { id: refreshSetId } : 'new',
			runTier2Projection: false,
		}, quietDebug(app));
		const parseErrors = result.parse.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
		const genErrors = (result.generation?.errors ?? []).map((e) => `Row ${e.row}: ${e.message}`);
		for (const line of result.summary) io.out(line);
		if (parseErrors.length > 0 || genErrors.length > 0 || result.skipped === 'parse-error') {
			for (const line of [...parseErrors, ...genErrors]) io.err(line);
			io.err(`Mapping import from ${source.name} did not finish. Fix the lines above, then run the import again.`);
			return 1;
		}
		if (result.skipped === 'no-rows') {
			io.err(`${source.name} has no mapping rows. Check that the file has a header line and at least one mapping.`);
			return 1;
		}
		io.out(`Imported ${source.name} into ${result.folder ?? result.tablePath ?? '(vault)'}: ${result.generation?.created.length ?? result.rowsWritten ?? 0} written.`
			+ (result.generation?.importSetId ? ` Set id: ${result.generation.importSetId}.` : ''));
		return 0;
	}

	const debug = quietDebug(app);
	const handle = sourceHandle(source.name);
	const explicit = resolveRecipe(flags);
	const sourceFile = new File([source.bytes], source.name);
	const baseRequest = { file: handle, table: '', headerRow: 1 } as const;
	let parsedData;
	try {
		parsedData = await parseRecognizedSource(sourceFile, { ...baseRequest, entry: explicit ?? RECIPE_REGISTRY[0] });
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new CliError(`Could not read ${source.name}: ${cause}. Check the file is CSV, TSV, XLSX or JSON, then run the import again.`);
	}

	const ontology = ontologyFlag ?? explicit?.ontology ?? slugOf(source.name);
	const destination = destinationFlag ?? (explicit ? undefined : `${DEFAULT_SETTINGS.defaultOutputPath}/${slugOf(source.name)}`);
	let entry: RecipeRegistryEntry;
	if (explicit) {
		entry = ontologyFlag ? { ...explicit, ontology } : explicit;
		parsedData = applyHeaderAliases(parsedData, entry);
	} else {
		try {
			entry = defaultRecipeEntry(parsedData, ontology, destination!, debug);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new CliError(`Could not work out a layout for ${source.name}: ${cause}. Pass a recipe with --recipe, then run the import again.`);
		}
	}

	const outcome = await runRecognizedImport(app as never, pluginStub(app, debug) as never, {
		...baseRequest,
		entry,
		parsedData,
		// `--destination .` is the vault root (''), which is a real choice: a
		// recipe whose file template already names its folder lands there as written.
		...(destination !== undefined ? { destination } : {}),
		...(refreshSetId ? { refreshSetId, overwriteMode: 'replace' as const } : {}),
	});
	for (const warning of outcome.warnings) io.err(`warning: ${warning}`);
	if (!outcome.ok) {
		for (const error of outcome.errors) io.err(error);
		if (outcome.errors.length === 0) io.err(`Import of ${source.name} did not finish. Run "bun run cw -- validate --vault <dir>" to see what is wrong.`);
		return 1;
	}
	io.out(
		`Imported ${outcome.parsedRowCount} rows from ${source.name} into ${outcome.destination || 'the vault root'}: ` +
		`${outcome.created} created, ${outcome.upToDate} up to date, ${outcome.skipped} skipped.` +
		(outcome.importSetId ? ` Set id: ${outcome.importSetId}.` : ''),
	);
	return 0;
}

// ------------------------------------------------------------------- validate

interface ValidationLine {
	path: string;
	message: string;
}

/** Notes Crosswalker manages: those carrying the `_crosswalker` block. Others are counted, not judged. */
export async function validateVault(app: FsApp, folder?: string): Promise<{ checked: number; skipped: number; failures: ValidationLine[] }> {
	const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
	const files = (app.vault.getMarkdownFiles() as TFile[])
		.filter((file) => !prefix || file.path.startsWith(prefix))
		.sort((a, b) => a.path.localeCompare(b.path));
	let checked = 0;
	let skipped = 0;
	const failures: ValidationLine[] = [];
	for (const file of files) {
		const text = await app.vault.read(file);
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		let fm: unknown = null;
		if (match) {
			try {
				fm = yaml.load(match[1]);
			} catch (error) {
				failures.push({ path: file.path, message: `frontmatter: not valid YAML (${error instanceof Error ? error.message.split('\n')[0] : String(error)})` });
				checked++;
				continue;
			}
		}
		if (!fm || typeof fm !== 'object' || !('_crosswalker' in (fm as Record<string, unknown>))) {
			skipped++;
			continue;
		}
		checked++;
		const result = validateTier1Frontmatter(fm);
		if (!result.valid) {
			for (const error of result.errors) {
				const text = String(error);
				const colon = text.indexOf(': ');
				const field = colon > 0 ? text.slice(0, colon) || '(root)' : '(root)';
				const message = colon > 0 ? text.slice(colon + 2) : text;
				failures.push({ path: file.path, message: `${field.replace(/^\//, '').replace(/\//g, '.') || '(root)'}: ${message}` });
			}
		}
	}
	return { checked, skipped, failures };
}

async function commandValidate(flags: Flags, io: Io): Promise<number> {
	allowOnly(flags, ['vault', 'folder'], 'validate');
	const app = openVault(flags);
	const folder = folderFlag(flags, 'folder', false);
	if (folder && !app.vault.getFolderByPath(folder)) {
		throw new CliError(`Folder not found in the vault: ${folder}. Check the spelling, or leave out --folder to check the whole vault.`);
	}
	const { checked, skipped, failures } = await validateVault(app, folder);
	for (const failure of failures) io.out(`${failure.path}: ${failure.message}`);
	const failedNotes = new Set(failures.map((f) => f.path)).size;
	const summary = `Checked ${checked} Crosswalker notes (${skipped} other notes not checked): ${failedNotes === 0 ? 'all valid' : `${failedNotes} with problems`}.`;
	if (failures.length > 0) {
		io.err(summary);
		io.err('Fix the fields named above, or run the import again to rewrite the managed fields.');
		return 2;
	}
	io.out(summary);
	return 0;
}

// --------------------------------------------------------------------- export

async function commandExport(flags: Flags, io: Io): Promise<number> {
	allowOnly(flags, ['vault', 'folder', 'format', 'out'], 'export');
	const app = openVault(flags);
	const folder = folderFlag(flags, 'folder', true)!;
	const format = stringFlag(flags, 'format', true, 'Choose --format csv, sssom or strm.');
	const out = stringFlag(flags, 'out', true, 'Pass the file to write, for example --out export.csv.');
	if (!app.vault.getFolderByPath(folder)) {
		throw new CliError(`Folder not found in the vault: ${folder}. Check the spelling, then run the export again.`);
	}
	const outAbs = nodePath.resolve(out);
	fs.mkdirSync(nodePath.dirname(outAbs), { recursive: true });

	let rows: number;
	let skipped: number;
	if (format === 'csv') {
		const result = await exportFolderAsCsv(app as never, folder);
		if (result.rowCount === 0 && (result.mappingCount ?? 0) > 0) {
			throw new CliError(`${folder} holds ${result.mappingCount} mappings and no concepts. Export it with --format sssom or --format strm instead.`);
		}
		fs.writeFileSync(outAbs, result.csv);
		rows = result.rowCount;
		skipped = result.skipped.length;
	} else if (format === 'sssom') {
		const result = await exportFolderAsSssomTsv(app as never, folder);
		fs.writeFileSync(outAbs, result.tsv);
		rows = result.rowCount;
		skipped = result.skipped.length;
	} else if (format === 'strm') {
		const result = await exportFolderAsStrmTsv(app as never, folder);
		fs.writeFileSync(outAbs, result.tsv);
		if (result.record) {
			const releaseAbs = releaseFilePathFor(outAbs);
			fs.writeFileSync(releaseAbs, strmReleaseFileContent(result.record, nodePath.basename(outAbs)));
			io.out(`Wrote the release record beside it: ${nodePath.basename(releaseAbs)}.`);
		}
		rows = result.rowCount;
		skipped = result.skipped.length;
	} else {
		throw new CliError(`Unknown export format "${format}". Choose --format csv, sssom or strm.`);
	}
	if (rows === 0) {
		io.err(`Nothing to export from ${folder} as ${format}. Check the folder holds ${format === 'csv' ? 'imported concepts' : 'mappings'}.`);
		return 1;
	}
	io.out(`Exported ${rows} rows from ${folder} to ${out}${skipped ? ` (${skipped} notes skipped)` : ''}.`);
	return 0;
}

// --------------------------------------------------------------------- replay

function commandReplay(): number {
	throw new CliError(
		'Replay is not available from the command line yet: "Run again" is only reachable from the plugin today. ' +
		'Run the same "cw import" again with --set <set id> to refresh a set from its source.',
	);
}

// ----------------------------------------------------------------------- main

/** Run one command. Returns the exit code; never calls process.exit. */
export async function runCli(argv: string[], io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
	let restore: (() => void) | null = null;
	try {
		const { command, flags } = parseFlags(argv);
		if (!command || command === 'help' || command === '--help' || flags.help) {
			io.out(USAGE);
			return command ? 0 : 1;
		}
		if (flags.deterministic !== undefined && flags.deterministic !== true) {
			throw new CliError('--deterministic takes no value. Write it on its own.');
		}
		if (flags.deterministic) restore = installDeterminism();
		switch (command) {
			case 'import':
				return await commandImport(flags, io);
			case 'validate':
				return await commandValidate(flags, io);
			case 'export':
				return await commandExport(flags, io);
			case 'replay':
				return commandReplay();
			case 'recipes':
				for (const entry of RECIPE_REGISTRY) io.out(`${entry.id}  ${entry.label}`);
				return 0;
			default:
				throw new CliError(`Unknown command "${command}". Run "bun run cw -- help" for the list.`);
		}
	} catch (error) {
		if (error instanceof CliError) io.err(error.message);
		else {
			const cause = error instanceof Error ? error.message : String(error);
			io.err(`Crosswalker stopped: ${cause}. Check the inputs named in the command, then run it again.`);
		}
		return 1;
	} finally {
		restore?.();
	}
}
