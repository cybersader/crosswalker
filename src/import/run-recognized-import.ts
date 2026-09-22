import { App, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { generateNotes } from '../generation/generation-engine';
import {
	discoverImportSets,
	newSetSchemeFor,
	settleVaultIndex,
} from '../generation/import-set';
import { outputRootPath } from '../settings/folder-settings';
import type { ImportRecipe, ParsedData } from '../types/config';
import { recognizedDestination } from './import-wizard';
import { MappingWorkbench } from './workbench';
import { analyzeColumns, parseCSVFile, shouldUseStreaming } from './parsers/csv-parser';
import { parseJSONFile } from './parsers/json-parser';
import { parseXLSXFile } from './parsers/xlsx-parser';
import type { RecipeRegistryEntry } from './recipe-registry';

export interface RecognizedImportRequest {
	file: TFile;
	entry: RecipeRegistryEntry;
	table: string;
	headerRow: number;
	destination?: string;
	overwriteMode?: 'skip' | 'replace' | 'error';
	onProgress?: (current: number, total: number, message: string) => void;
}

export interface RecognizedImportOutcome {
	ok: boolean;
	destination: string;
	importSetId: string | null;
	created: number;
	skipped: number;
	crosswalkEdges?: number;
	errors: string[];
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
		skipped: 0,
		errors: [],
		parsedRowCount: 0,
	};

	if (await settleVaultIndex(app) > 0) {
		return { ...empty, errors: [STILL_INDEXING_ERROR] };
	}

	let parsedData: ParsedData;
	try {
		const sourceFile = await sourceFileFromVault(app, req.file);
		parsedData = await parseRecognizedSource(sourceFile, req);
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
		const recipeOverride = workbench.buildRecipe();
		const config = buildRecognizedImportConfig(workbench);
		const importSet = await newSetSchemeFor(app, req.entry.ontology);
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
		let importSetId: string | null = null;
		try {
			importSetId = await importSetIdFromCreatedNotes(app, destination, result.created);
		} catch {
			// Generation succeeded; cache-cold provenance lookup may remain unavailable.
		}
		return {
			ok: result.success && errors.length === 0,
			destination,
			importSetId,
			created: result.created.length,
			skipped: result.skipped.length,
			...(result.crosswalkEdges ? { crosswalkEdges: result.crosswalkEdges.created } : {}),
			errors,
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
