/**
 * Crosswalker command line, first slice (2026-10-27).
 *
 *   bun run cw -- import   --vault <dir> --source <file> [--recipe <id|path>]
 *                          [--set new|<set id>] [--ontology <id>] [--destination <folder>]
 *                          [--sheet <name>] [--header-row <n>]
 *                          [--deterministic]
 *   bun run cw -- validate --vault <dir> [--folder <folder>]
 *   bun run cw -- export   --vault <dir> --folder <folder> --format csv|sssom|strm --out <file>
 *   bun run cw -- replay   --vault <dir> --set <set id> --source <file>
 *                          [--sheet <name>] [--header-row <n>] [--digest sha256-<hex>]
 *                          [--deterministic]
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
import { createFsApp, StandInTFile, vaultRelative, type FsApp } from './fs-app';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import {
	RECIPE_REGISTRY,
	applyHeaderAliases,
	libraryRegistryEntry,
	type RecipeRegistryEntry,
} from '../src/import/recipe-registry';
import { parseRecognizedSource, runRecognizedImport } from '../src/import/run-recognized-import';
import { refreshRootProblem } from '../src/import/import-wizard';
import { discoverImportSets } from '../src/generation/import-set';
import { listXLSXSheets } from '../src/import/parsers/xlsx-parser';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { MappingWorkbench } from '../src/import/workbench';
import { patchRecipeDocument } from '../src/import/recipe-document';
import { importSssom } from '../src/import/sssom-importer';
import { exportFolderAsCsv } from '../src/export/csv-exporter';
import { csvExportNotice } from '../src/export/csv-inverse';
import { exportFolderAsSssomTsv } from '../src/export/sssom-exporter';
import { exportFolderAsStrmTsv, releaseFilePathFor, strmReleaseFileContent } from '../src/export/strm-tsv-exporter';
import { validateTier1Frontmatter } from '../src/validation/validator';
import { recipeStampOf } from '../src/export/recipe-for-note';
import { readImportSetRecipe } from '../src/import/import-set-recipes';
import type { ParsedData } from '../src/types/config';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import { DebugLog } from '../src/utils/debug';
import { configureGraphFromCli, connectionsFromCli } from './graph';
import { ConnectionsError } from '../src/graph/connections-query';

/** Pinned clock and first set id under --deterministic, as tools/generate-fixtures.ts pins them. */
export const DETERMINISTIC_PRODUCED_AT = '2026-05-04T00:00:00.000Z';
export const DETERMINISTIC_FIRST_SET_ID = 'iset-a0f1e2';

/** A usage or runtime error with a cause and a next step. Exit 1. */
class CliError extends Error {}

const USAGE = [
	'Usage: bun run cw -- <command> [options]',
	'',
	'Commands:',
	'  import    --vault <dir> --source <file> [--recipe <id|path>] [--set new|new-set-qualified|<set id>]',
	'            [--ontology <id>] [--destination <folder>] [--sheet <name>]',
	'            [--header-row <n>] [--deterministic]',
	'            --sheet picks a workbook sheet or a JSON collection; --header-row is the',
	'            spreadsheet row number (1 = first row) that holds the column names.',
	'  validate  --vault <dir> [--folder <folder>]',
	'  export    --vault <dir> --folder <folder> --format csv|sssom|strm --out <file>',
	'  replay    --vault <dir> --set <set id> --source <file> [--sheet <name>]',
	'            [--header-row <n>] [--digest sha256-<hex>] [--deterministic]',
	'            Runs a set again with the exact recipe revision it ran. Crosswalker keeps',
	'            no copy of the source, so --source is the file the set came from or a newer',
	'            release of it. --digest picks a revision when the set holds more than one.',
	'  graph configure --vault <dir> [--mode colors|overview] [--config-dir <folder>] [--apply]',
	'            Preview saved global graph defaults as JSON. Colors only unless overview is chosen.',
	'            Close Obsidian before --apply; open views can overwrite saved defaults.',
	'  graph connections --vault <dir> --source-set <id> --target-set <id>',
	'            [--focus-curie <id>] [--focus-set <id>] [--search <text>] [--limit <1..100>] [--offset <n>]',
	'            Read recorded connections as JSON. No note or graph settings writes.',
	'  recipes   list the built-in recipe ids',
	'',
	'Exit codes: 0 ok, 1 usage or runtime error, 2 validation failures.',
].join('\n');

interface Io {
	out: (line: string) => void;
	err: (line: string) => void;
}

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): { command: string | undefined; flags: Flags; graphAction?: string } {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	const [command, ...rest] = args;
	let graphAction: string | undefined;
	if (command === 'graph') {
		if (!['configure', 'connections'].includes(rest[0])) throw new CliError('Choose "cw graph configure" or "cw graph connections". Run help for their required options.');
		graphAction = rest.shift();
	}
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
	return { command, flags, graphAction };
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
	const file = new StandInTFile(name) as TFile & { name: string; extension: string };
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
	// The portability check accepts that implied predicate (isImpliedLinkPredicate).
	const regions = workbench.buildFinalRegions();
	const mapping = workbench.getMapping();
	const patched = patchRecipeDocument(workbench.getRecipeDocument(), { mapping, regions });
	if (!patched.ok) {
		throw new Error(patched.diagnostics
			.filter((diagnostic) => diagnostic.severity === 'blocking')
			.map((diagnostic) => diagnostic.message)
			.join('; '));
	}
	return libraryRegistryEntry(patched.recipe as CrosswalkerImportRecipe);
}

function setFlag(flags: Flags): string | undefined {
	const value = stringFlag(flags, 'set');
	if (value === undefined || value === 'new') return undefined;
	if (!/^iset-[a-z0-9]+$/.test(value)) {
		throw new CliError(`--set takes "new" or an existing set id such as iset-a0f1e2, not "${value}". Run the import once without --set to mint one.`);
	}
	return value;
}

/**
 * --sheet and --header-row: which table in the source to read, and which row
 * holds its column names. --header-row is the row number a spreadsheet shows
 * (1 is the first row), so a banner row above the headers means --header-row 2.
 * Without the flags: the first sheet, headers on its first row.
 */
export function tableFlags(flags: Flags, extension: string): { table: string; headerRow: number } {
	const table = stringFlag(flags, 'sheet', false, 'Pass a sheet name, for example --sheet "CSF 2.0".') ?? '';
	const rawRow = stringFlag(flags, 'header-row', false, 'Pass a row number, for example --header-row 2.');
	let headerRow = 0;
	if (rawRow !== undefined) {
		if (!/^[1-9][0-9]*$/.test(rawRow)) {
			throw new CliError(`--header-row takes a row number starting at 1, not "${rawRow}". Count rows the way the spreadsheet shows them.`);
		}
		headerRow = Number(rawRow) - 1;
	}
	const ext = extension.toLowerCase();
	if (ext === 'csv' || ext === 'tsv') {
		if (table !== '') throw new CliError('--sheet is for workbooks (.xlsx) and JSON files. A CSV has one table; remove --sheet.');
		if (headerRow !== 0) throw new CliError('--header-row is for workbooks (.xlsx). Remove the banner rows from the CSV, or save it from the workbook with the headers on the first row.');
	}
	if (ext === 'json' && rawRow !== undefined) {
		throw new CliError('--header-row is for workbooks (.xlsx). A JSON source has no header row; remove --header-row.');
	}
	return { table, headerRow };
}

/**
 * A failed workbook import read the first sheet from its first row. Say so,
 * name the sheets, and name the sheet the recipe was written for when it
 * declares one. An offer for the user to act on, never applied by itself.
 */
async function workbookHint(file: File, entry: RecipeRegistryEntry): Promise<string> {
	let sheets: string[] = [];
	try {
		sheets = await listXLSXSheets(file);
	} catch {
		// The parse already succeeded once; a listing failure only loses the names.
	}
	const named = sheets.length > 0 ? ` Sheets in this workbook: ${sheets.map((name) => `"${name}"`).join(', ')}.` : '';
	const detect = (entry.recipe.source as { detect?: { sheet?: string; header_row?: number } } | undefined)?.detect;
	const suggested = detect?.sheet
		? ` This recipe was written for --sheet "${detect.sheet}"${detect.header_row !== undefined ? ` --header-row ${detect.header_row + 1}` : ''}.`
		: '';
	return `The import read the first sheet with column names on row 1.${named}${suggested} If the columns are elsewhere, pass --sheet <name> and --header-row <row number>.`;
}

async function commandImport(flags: Flags, io: Io): Promise<number> {
	allowOnly(flags, ['vault', 'source', 'recipe', 'set', 'ontology', 'destination', 'sheet', 'header-row', 'deterministic'], 'import');
	const app = openVault(flags);
	const source = readSource(flags);
	const qualifiedMappingSet = stringFlag(flags, 'set') === 'new-set-qualified';
	const refreshSetId = qualifiedMappingSet ? undefined : setFlag(flags);

	if (/\.sssom\.tsv$/i.test(source.name)) {
		const destinationFlag = folderFlag(flags, 'destination', false);
		const ontologyFlag = stringFlag(flags, 'ontology');
		if (flags.recipe !== undefined) {
			throw new CliError('A mapping file (.sssom.tsv) imports without a recipe. Remove --recipe, then run the import again.');
		}
		const result = await importSssom(app as never, source.bytes.toString('utf8'), null, null, {
			...(destinationFlag ? { outputFolder: destinationFlag } : {}),
			...(ontologyFlag ? { sourceOntology: ontologyFlag } : {}),
			overwriteMode: 'replace',
			// Explicit isolation for overlapping publisher releases. Preserve the
			// existing default; never infer a refresh or change an existing set.
			importSet: refreshSetId ? { id: refreshSetId } : qualifiedMappingSet ? 'new-set-qualified' : 'new',
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
		io.out(`Imported ${source.name} into ${result.folder ?? result.tablePath ?? '(vault)'}: ${result.generation ? result.generation.created.length + result.generation.updated.length : result.rowsWritten ?? 0} written.`
			+ (result.generation?.importSetId ? ` Set id: ${result.generation.importSetId}.` : ''));
		return 0;
	}

	if (qualifiedMappingSet) throw new CliError('--set new-set-qualified is for mapping files (.sssom.tsv). Use --set new for a framework import.');
	return runImport(flags, io, app, source, resolveRecipe(flags), refreshSetId);
}

/**
 * The folder an existing set's notes live in, found from the notes it owns.
 * Undefined when no note carries the set yet. Refuses when its notes are
 * spread over several folders, as the plugin refuses: a guessed folder writes
 * a second copy of the set.
 */
async function setRoot(app: FsApp, setId: string): Promise<string | undefined> {
	const set = (await discoverImportSets(app as never)).find((candidate) => candidate.id === setId);
	if (!set || set.noteCount === 0) return undefined;
	const problem = refreshRootProblem(set);
	if (problem) throw new CliError(`${problem} Or pass --destination <folder> to cw import to say where set ${setId} lives.`);
	return set.root ?? undefined;
}

/**
 * The import pipeline both `cw import` and `cw replay` run. `explicit` is the
 * already-resolved recipe (null: detect the structure, as the wizard does);
 * `refreshSetId` refreshes that set in place. Prints the summary line.
 */
async function runImport(
	flags: Flags,
	io: Io,
	app: FsApp,
	source: { name: string; bytes: Buffer },
	explicit: RecipeRegistryEntry | null,
	refreshSetId: string | undefined,
): Promise<number> {
	const destinationFlag = folderFlag(flags, 'destination', false);
	const ontologyFlag = stringFlag(flags, 'ontology');
	const debug = quietDebug(app);
	const handle = sourceHandle(source.name);
	const sourceFile = new File([source.bytes], source.name);
	const baseRequest = { file: handle, ...tableFlags(flags, handle.extension) };
	let parsedData;
	try {
		parsedData = await parseRecognizedSource(sourceFile, { ...baseRequest, entry: explicit ?? RECIPE_REGISTRY[0] });
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new CliError(`Could not read ${source.name}: ${cause}. Check the file is CSV, TSV, XLSX or JSON, then run the import again.`);
	}

	const ontology = ontologyFlag ?? explicit?.ontology ?? slugOf(source.name);
	// A refresh writes back to where the set's own notes already live, as the
	// plugin's refresh does; a recipe's default folder may not be that place.
	const refreshRoot = refreshSetId && destinationFlag === undefined ? await setRoot(app, refreshSetId) : undefined;
	const destination = destinationFlag ?? refreshRoot ?? (explicit ? undefined : `${DEFAULT_SETTINGS.defaultOutputPath}/${slugOf(source.name)}`);
	let entry: RecipeRegistryEntry;
	if (explicit) {
		entry = ontologyFlag ? { ...explicit, ontology } : explicit;
		parsedData = applyHeaderAliases(parsedData, entry);
	} else {
		try {
			entry = defaultRecipeEntry(parsedData, ontology, destination!, debug);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new CliError(`Could not work out a layout for ${source.name}: ${cause.replace(/\.$/, '')}. Pass a recipe with --recipe, then run the import again.`);
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
		if (/^xlsx?$/i.test(handle.extension) && flags.sheet === undefined) {
			io.err(await workbookHint(sourceFile, entry));
		}
		return 1;
	}
	io.out(
		`Imported ${outcome.parsedRowCount} rows from ${source.name} into ${outcome.destination || 'the vault root'}: ` +
		`${outcome.created} created, ${outcome.updated} updated, ${outcome.upToDate} up to date, ${outcome.skipped} skipped.` +
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
	// The CSV export says what it could not rebuild, the same lines the plugin shows.
	let csvNotice: string | null = null;
	if (format === 'csv') {
		const result = await exportFolderAsCsv(app as never, folder);
		if (result.rowCount === 0 && (result.mappingCount ?? 0) > 0) {
			throw new CliError(`${folder} holds ${result.mappingCount} mappings and no concepts. Export it with --format sssom or --format strm instead.`);
		}
		fs.writeFileSync(outAbs, result.csv);
		rows = result.rowCount;
		skipped = result.skipped.length;
		csvNotice = csvExportNotice({ ...result, skippedCount: skipped }, out);
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
	io.out(csvNotice ?? `Exported ${rows} rows from ${folder} to ${out}${skipped ? ` (${skipped} notes skipped)` : ''}.`);
	return 0;
}

// --------------------------------------------------------------------- replay

/**
 * The recipe revision a set ran, found by identity: the notes whose provenance
 * names the set say which recipe document digest wrote them, and the import
 * kept that exact revision under `_crosswalker/import-sets/<set id>/`. Never
 * found by folder or file name, and never re-resolved from the library by id
 * (the library may hold a later revision than the one that ran).
 */
export async function keptRecipeForSet(
	app: FsApp,
	setId: string,
	digestFlag: string | undefined,
): Promise<{ recipe: CrosswalkerImportRecipe; digest: string }> {
	const counts = new Map<string, number>();
	let notes = 0;
	for (const file of app.vault.getMarkdownFiles() as TFile[]) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) continue;
		const stamp = recipeStampOf(frontmatter);
		if (stamp.setId !== setId) continue;
		notes++;
		// Notes from before digests were stamped name no revision; they cannot pick one.
		if (stamp.digest) counts.set(stamp.digest, (counts.get(stamp.digest) ?? 0) + 1);
	}
	if (notes === 0) {
		throw new CliError(
			`No notes in this vault belong to set ${setId}. Check the set id: any imported note shows it under _crosswalker, import_set, id. ` +
			'Pass that id with --set.',
		);
	}
	const noKeptCopy = (digest?: string): CliError => new CliError(
		`Set ${setId} has no kept copy of the recipe revision ${digest ? `${digest} ` : ''}it ran. ` +
		'The set was imported before copies were kept, or the copy was removed. ' +
		`Run "bun run cw -- import --vault <dir> --source <file> --set ${setId} --recipe <id|path>" instead.`,
	);
	let digest: string;
	if (digestFlag !== undefined) {
		if (!counts.has(digestFlag)) {
			const known = [...counts.keys()].sort();
			throw new CliError(
				`No note in set ${setId} was written by recipe revision ${digestFlag}. ` +
				(known.length > 0 ? `Revisions in this set: ${known.join(', ')}. Pass one of them with --digest.` : 'Leave out --digest.'),
			);
		}
		digest = digestFlag;
	} else if (counts.size === 0) {
		throw noKeptCopy();
	} else if (counts.size > 1) {
		const listed = [...counts.entries()]
			.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
			.map(([d, n]) => `${d} (${n} ${n === 1 ? 'note' : 'notes'})`)
			.join(', ');
		throw new CliError(
			`Set ${setId} holds notes written by more than one recipe revision: ${listed}. ` +
			'Pass the one to run again with --digest <revision>.',
		);
	} else {
		digest = [...counts.keys()][0];
	}
	const recipe = await readImportSetRecipe(app.vault.adapter, setId, digest);
	if (!recipe) throw noKeptCopy(digest);
	return { recipe, digest };
}

/** A kept recipe the import path cannot run: the recipe a mapping file (.sssom.tsv) import builds for itself. */
function isMappingTransportRecipe(recipe: CrosswalkerImportRecipe): boolean {
	const leaf = recipe.target.layout[recipe.target.layout.length - 1] as { kind?: string } | undefined;
	return /^sssom-/.test(recipe.recipe) && leaf?.kind === 'crosswalk-edge';
}

/**
 * `cw replay`: the command line "Run again". Refresh a set from a source file
 * with the exact recipe revision that set ran, through the same pipeline as
 * `cw import --set <id> --recipe <that recipe>`.
 */
async function commandReplay(flags: Flags, io: Io): Promise<number> {
	allowOnly(flags, ['vault', 'set', 'source', 'sheet', 'header-row', 'digest', 'deterministic'], 'replay');
	const app = openVault(flags);
	const setId = stringFlag(flags, 'set', true, 'Pass the set to refresh, for example --set iset-a0f1e2. Any imported note shows its set id under _crosswalker, import_set, id.');
	if (!/^iset-[a-z0-9]{6}$/.test(setId)) {
		throw new CliError(`--set takes an existing set id such as iset-a0f1e2, not "${setId}". Any imported note shows its set id under _crosswalker, import_set, id.`);
	}
	if (flags.source === undefined) {
		throw new CliError(
			'Missing --source. Crosswalker keeps no copy of the source file, so pass the file this set was imported from, ' +
			'or a newer release of it, for example --source controls.csv.',
		);
	}
	const digestFlag = stringFlag(flags, 'digest', false, 'Pass a recipe revision, for example --digest sha256-<hex>.');
	if (digestFlag !== undefined && !/^sha256-[a-f0-9]{64}$/.test(digestFlag)) {
		throw new CliError(`--digest takes a recipe revision such as sha256- followed by 64 hex characters, not "${digestFlag}". Copy it from the recipe_document_digest line of a note in the set.`);
	}
	const source = readSource(flags);
	const { recipe, digest } = await keptRecipeForSet(app, setId, digestFlag);
	if (isMappingTransportRecipe(recipe) || /\.sssom\.tsv$/i.test(source.name)) {
		throw new CliError(
			`Set ${setId} was imported from a mapping file (.sssom.tsv), which imports without a recipe, so there is no recipe to run again. ` +
			`Run "bun run cw -- import --vault <dir> --source <file.sssom.tsv> --set ${setId}" instead.`,
		);
	}
	io.out(`Running recipe ${recipe.recipe} (revision ${digest.slice(0, 15)}) again into set ${setId}.`);
	return runImport(flags, io, app, source, libraryRegistryEntry(recipe), setId);
}

async function commandGraph(flags: Flags, io: Io, action?: string): Promise<number> {
	if (action === 'connections') {
		allowOnly(flags, ['vault', 'source-set', 'target-set', 'focus-curie', 'focus-set', 'search', 'limit', 'offset'], 'graph connections');
		const numeric = (name: string, fallback: number): number => {
			const raw = stringFlag(flags, name);
			if (raw !== undefined && !/^\d+$/.test(raw)) throw new CliError(`--${name} needs a whole nonnegative integer. Use --limit 40 and --offset 0 for the first page.`);
			return raw === undefined ? fallback : Number(raw);
		};
		const result = await connectionsFromCli(stringFlag(flags, 'vault', true, 'Pass an existing vault folder.'), {
			sourceSet: stringFlag(flags, 'source-set', true, 'Choose its minted import-set id.'),
			targetSet: stringFlag(flags, 'target-set', true, 'Choose its minted import-set id.'),
			focusCurie: stringFlag(flags, 'focus-curie'), focusSet: stringFlag(flags, 'focus-set'), search: stringFlag(flags, 'search'),
			limit: numeric('limit', 40), offset: numeric('offset', 0),
		});
		io.out(JSON.stringify(result, null, 2)); return 0;
	}
	allowOnly(flags, ['vault', 'config-dir', 'mode', 'apply'], 'graph configure');
	const mode = stringFlag(flags, 'mode') ?? 'colors';
	if (mode !== 'colors' && mode !== 'overview') throw new CliError('Invalid graph mode. Choose --mode colors or --mode overview.');
	if (flags.apply !== undefined && flags.apply !== true) throw new CliError('--apply takes no value. Leave it out for a no-write preview.');
	const vault = stringFlag(flags, 'vault', true, 'Pass the existing vault folder.');
	const result = await configureGraphFromCli(vault, stringFlag(flags, 'config-dir'), mode, flags.apply === true);
	io.out(JSON.stringify(result, null, 2));
	return result.status === 'stale' || result.status === 'partial' ? 1 : 0;
}

// ----------------------------------------------------------------------- main

/** Run one command. Returns the exit code; never calls process.exit. */
export async function runCli(argv: string[], io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
	let restore: (() => void) | null = null;
	try {
		const { command, flags, graphAction } = parseFlags(argv);
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
				return await commandReplay(flags, io);
			case 'graph':
				return await commandGraph(flags, io, graphAction);
			case 'recipes':
				for (const entry of RECIPE_REGISTRY) io.out(`${entry.id}  ${entry.label}`);
				return 0;
			default:
				throw new CliError(`Unknown command "${command}". Run "bun run cw -- help" for the list.`);
		}
	} catch (error) {
		if (error instanceof CliError) io.err(error.message);
		else if (error instanceof ConnectionsError) {
			io.err(error.message);
			if (error.details) io.err(JSON.stringify({ errorDetails: error.details }));
		} else {
			const cause = error instanceof Error ? error.message : String(error);
			io.err(`Crosswalker stopped: ${cause}. Check the inputs named in the command, then run it again.`);
		}
		return 1;
	} finally {
		restore?.();
	}
}
