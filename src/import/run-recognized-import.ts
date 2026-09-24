import { App, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { generateNotes } from '../generation/generation-engine';
import type { Recipe } from '../render';
import {
	discoverImportSets,
	newSetSchemeFor,
	settleVaultIndex,
} from '../generation/import-set';
import { outputRootPath } from '../settings/folder-settings';
import type { GenerationError, ImportRecipe, ParsedData } from '../types/config';
import { recognizedDestination } from './import-wizard';
import { MappingWorkbench } from './workbench';
import { analyzeColumns, parseCSVFile, shouldUseStreaming } from './parsers/csv-parser';
import { parseJSONFile } from './parsers/json-parser';
import { parseXLSXFile } from './parsers/xlsx-parser';
import { applyHeaderAliases, type RecipeRegistryEntry } from './recipe-registry';

export interface RecognizedImportRequest {
	file: TFile;
	entry: RecipeRegistryEntry;
	table: string;
	headerRow: number;
	destination?: string;
	overwriteMode?: 'skip' | 'replace' | 'error';
	/** Explicit user-selected set id; never inferred from source, label or destination. */
	refreshSetId?: string;
	/** A run-scoped row predicate; the canonical bundled recipe is never mutated. */
	sourceWhere?: string;
	onProgress?: (current: number, total: number, message: string) => void;
}

export interface RecognizedImportOutcome {
	ok: boolean;
	destination: string;
	importSetId: string | null;
	created: number;
	upToDate: number;
	skipped: number;
	crosswalkEdges?: number;
	crosswalkLinksUpToDate?: number;
	errors: string[];
	warnings: string[];
	parsedRowCount: number;
}

const STILL_INDEXING_ERROR = 'Vault is still indexing. Wait a moment and run the import again.';

/** Wizard-equivalent legacy bridge: body mappings plus the recipe's leaf template. */
export function buildRecognizedImportConfig(
	workbench: Pick<MappingWorkbench, 'getLegacyBodyMappings' | 'leafFileTemplate'>,
): Partial<ImportRecipe> {
	const body = workbench.getLegacyBodyMappings();
	const leaf = workbench.leafFileTemplate();
	return {
		name: 'shape-workbench',
		mapping: {
			hierarchy: [],
			frontmatter: [],
			links: [],
			body,
			...(leaf ? { filename: { template: leaf, sanitize: true } } : {}),
		},
	};
}

async function sourceFileFromVault(app: App, file: TFile): Promise<File> {
	const bytes = await app.vault.readBinary(file);
	return new File([bytes], file.name);
}

async function parseRecognizedSource(file: File, request: RecognizedImportRequest): Promise<ParsedData> {
	switch (request.file.extension.toLowerCase()) {
		case 'csv':
		case 'tsv':
			return parseCSVFile(file, { streaming: shouldUseStreaming(file) });
		case 'xlsx':
		case 'xls':
			return parseXLSXFile(file, { sheet: request.table, headerRow: request.headerRow });
		case 'json':
			return parseJSONFile(file, { iterator: request.table || undefined });
		default:
			throw new Error(`Unsupported source type .${request.file.extension}`);
	}
}

function generationErrors(errors: readonly { row: number; message: string }[]): string[] {
	return errors.map((error) =>
		`Row ${error.row}: ${error.message}. Fix the source data or configuration, then run the import again.`,
	);
}

/** Only CRI rows that stop at a declared upper level may skip a suffix of folders.
 * Keep a skipped middle folder, an unexpected level, and every other render note visible. */
export function visibleGenerationWarnings(
	warnings: readonly GenerationError[], entry: RecipeRegistryEntry, rows: ParsedData['rows'],
): string[] {
	if (entry.id !== 'cri-profile-v2-2-nested' || !Array.isArray(rows)) {
		return warnings.map((warning) => `Row ${warning.row}: ${warning.message}`);
	}
	const folders = entry.recipe.target.layout.filter((level) => level.mechanism === 'folder');
	const byRow = new Map<number, GenerationError[]>();
	for (const warning of warnings) byRow.set(warning.row, [...(byRow.get(warning.row) ?? []), warning]);
	const expectedTrailing = new Map<number, Set<string>>();
	for (const [rowNumber, notes] of byRow) {
		const level = rows[rowNumber - 1]?.Level;
		const start = level === 'F' ? 1 : level === 'C' ? 2 : folders.length;
		if (start >= folders.length) continue;
		const tail = folders.slice(start);
		if (tail.every((folder) =>
			notes.some((note) => note.code === 'prefix-index-missing' && note.template === folder.template) &&
			notes.some((note) => note.code === 'folder-level-skipped' && note.template === folder.template && note.level === folder.level)) &&
			!folders.slice(0, start).some((folder) => notes.some((note) =>
				note.code === 'folder-level-skipped' && note.level === folder.level))) {
			expectedTrailing.set(rowNumber, new Set(tail.map((folder) => folder.template)));
		}
	}
	return warnings.filter((warning) => {
		const trailing = expectedTrailing.get(warning.row);
		return !trailing || !warning.template || !trailing.has(warning.template) ||
			(warning.code !== 'prefix-index-missing' && warning.code !== 'folder-level-skipped');
	}).map((warning) => `Row ${warning.row}: ${warning.message}`);
}

async function importSetIdFromCreatedNotes(
	app: App,
	destination: string,
	createdPaths: readonly string[],
): Promise<string | null> {
	if (createdPaths.length === 0) return null;
	const created = new Set(createdPaths);
	const sets = await discoverImportSets(app, destination);
	return sets.find((set) => set.paths.some((path) => created.has(path)))?.id ?? null;
}

export async function runRecognizedImport(
	app: App,
	plugin: CrosswalkerPlugin,
	req: RecognizedImportRequest,
): Promise<RecognizedImportOutcome> {
	const root = outputRootPath(plugin.settings);
	const destination = req.destination ?? recognizedDestination(req.entry, root) ?? root;
	const empty: RecognizedImportOutcome = {
		ok: false,
		destination,
		importSetId: null,
		created: 0,
		upToDate: 0,
		skipped: 0,
		errors: [],
		warnings: [],
		parsedRowCount: 0,
	};

	if (await settleVaultIndex(app) > 0) {
		return { ...empty, errors: [STILL_INDEXING_ERROR] };
	}

	let parsedData: ParsedData;
	try {
		const sourceFile = await sourceFileFromVault(app, req.file);
		parsedData = applyHeaderAliases(await parseRecognizedSource(sourceFile, req), req.entry);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		return {
			...empty,
			errors: [`Could not parse ${req.file.name}: ${cause}. Check the selected table and header row, then run the import again.`],
		};
	}

	try {
		const workbench = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: destination,
			debug: plugin.debug,
			defaultPresetId: 'browsable-framework',
			initialRecipe: req.entry.recipe,
			recipeOrigin: 'bundled',
			sourceOntology: req.entry.recipe.source.ontology,
			seedColumnDefaults: false,
			onChange: () => {},
		});
		// This path has no mapping editor: use the vetted recipe as the authority.
		// Re-serializing the workbench can fork a nested recipe to `-custom`
		// even when nobody edited it, losing the ID needed for safe refresh.
		const recipeOverride = req.entry.recipe as unknown as Recipe;
		const config = buildRecognizedImportConfig(workbench);
		const importSet = req.refreshSetId ? { id: req.refreshSetId } : await newSetSchemeFor(app, req.entry.ontology);
		const result = await generateNotes(
			app,
			parsedData,
			config,
			{
				basePath: destination,
				importSet,
				overwriteMode: req.overwriteMode ?? 'error',
				createFolders: true,
				sourceFileName: req.file.name,
				recipeOverride,
				sourceWhere: req.sourceWhere,
				tier2: {
					runProjection: plugin.runProjection,
					precomputeClosure: plugin.precomputeClosure,
				},
				strictValidation: true,
				onProgress: req.onProgress,
			},
			plugin.debug,
		);
		const errors = generationErrors(result.errors);
		let importSetId: string | null = req.refreshSetId ?? null;
		if (!req.refreshSetId) try {
			importSetId = await importSetIdFromCreatedNotes(app, destination, result.created);
		} catch {
			// Generation succeeded; cache-cold provenance lookup may remain unavailable.
		}
		return {
			ok: result.success && errors.length === 0,
			destination,
			importSetId,
			created: result.created.length,
			upToDate: result.upToDate.length,
			skipped: result.skipped.length,
			...(result.crosswalkEdges ? { crosswalkEdges: result.crosswalkEdges.created, crosswalkLinksUpToDate: result.crosswalkEdges.upToDate } : {}),
			errors,
			warnings: visibleGenerationWarnings(result.warnings ?? [], req.entry, parsedData.rows),
			parsedRowCount: parsedData.rowCount,
		};
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		return {
			...empty,
			parsedRowCount: parsedData.rowCount,
			errors: [`Import failed for ${req.file.name}: ${cause}. Fix the source or configuration, then run the import again.`],
		};
	}
}
