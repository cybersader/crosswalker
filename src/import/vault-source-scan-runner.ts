import type { App, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { computeSourceByteDigest } from '../generation/hash';
import {
	discoverImportSets,
	knownSourcesOf,
	settleVaultIndex,
} from '../generation/import-set';
import { outputRootPath } from '../settings/folder-settings';
import type { CrosswalkerSettings } from '../settings/settings-data';
import { isImportableExtension } from '../ui/entry-points';
import {
	DRAFT_SCHEMA_VERSION,
	autoDraftName,
	newDraftId,
	type WizardDraft,
} from './draft-store';
import { recognizedDestination } from './import-wizard';
import { STREAMING_THRESHOLD_BYTES } from './parsers/csv-parser';
import { peekXLSXBytes } from './parsers/xlsx-parser';
import { RECIPE_REGISTRY, type RecipeRegistryEntry } from './recipe-registry';
import {
	peekCSV,
	peekJSON,
	planScan,
	reconcileCandidate,
	scoreFilePeeks,
	type ScanCandidate,
	type ScanPlan,
	type SourceState,
} from './vault-source-scan';

export const LARGE_FILE_BYTES = STREAMING_THRESHOLD_BYTES;

export const LARGE_FILE_NOTE =
	'Skipped: larger than the header scan limit. Open it in the wizard instead.';

export interface ScanRow {
	path: string;
	name: string;
	candidate: ScanCandidate;
	state: SourceState;
	digest: string | null;
	note: string | null;
}

export interface ScanReport {
	rows: ScanRow[];
	skipped: ScanPlan['skipped'];
	/** Per-file caveats for files that produced no row, including large or unreadable sources. */
	notes: Record<string, string>;
	scanned: number;
	total: number;
	cancelled: boolean;
	indexReady: boolean;
	foreignSets: { setId: string; root: string | null; noteCount: number }[];
}

export interface ScanProgress {
	scanned: number;
	total: number;
	currentPath: string;
}

function fileName(path: string): string {
	return path.split('/').pop() ?? path;
}

function sourceTypeFor(path: string): WizardDraft['sourceType'] {
	const extension = path.split('.').pop()?.toLowerCase();
	if (extension === 'json') return 'json';
	if (extension === 'xlsx' || extension === 'xls') return 'xlsx';
	return 'csv';
}

/** Build the minimum neutral draft that resumes through the wizard's normal recognition path. */
export function draftFromScanRow(
	row: ScanRow,
	entry: RecipeRegistryEntry,
	settings: Pick<CrosswalkerSettings, 'defaultOutputPath'>,
): WizardDraft {
	const now = new Date().toISOString();
	const root = outputRootPath(settings);
	const recognized = recognizedDestination(entry, root);
	const outputPath = recognized ?? root;
	return {
		schemaVersion: DRAFT_SCHEMA_VERSION,
		id: newDraftId(),
		name: autoDraftName(row.name, 1),
		createdAt: now,
		updatedAt: now,
		currentStep: 1,
		sourceFile: { name: row.name, vaultPath: row.path },
		sourceType: sourceTypeFor(row.path),
		selectedSheet: sourceTypeFor(row.path) === 'xlsx' ? row.candidate.table : null,
		xlsxHeaderRow: sourceTypeFor(row.path) === 'xlsx' ? row.candidate.headerRow : 0,
		columnInfos: [],
		columnConfigsDict: {},
		config: {},
		outputPath,
		destinationEdited: false,
		...(recognized ? { curatedDestination: outputPath } : {}),
		overwriteMode: 'skip',
		frameworkId: entry.ontology,
		recognizedFastPath: false,
		appliedConfigId: null,
	};
}

function unreadableNote(error: unknown): string {
	const cause = error instanceof Error && error.message.trim() !== ''
		? error.message.trim()
		: 'the file could not be read';
	return `Skipped: ${cause}. Open the file in the wizard and choose its source settings manually.`;
}

/** Run the bounded, cancellable vault-source scan without writing to the vault. */
export async function scanVaultForSources(
	app: App,
	plugin: CrosswalkerPlugin,
	opts: { onProgress?: (progress: ScanProgress) => void; signal?: AbortSignal } = {},
): Promise<ScanReport> {
	void plugin;
	const indexReady = (await settleVaultIndex(app)) === 0;
	const sets = await discoverImportSets(app);
	const known = knownSourcesOf(sets);
	const roots = sets
		.map((set) => set.root)
		.filter((root): root is string => root !== null && root !== '');
	const registryIds = new Set(RECIPE_REGISTRY.map((entry) => entry.id));
	const foreignSets = sets
		.filter((set) => set.sources.length === 0 && !set.recipeIds.some((id) => registryIds.has(id)))
		.map((set) => ({ setId: set.id, root: set.root, noteCount: set.noteCount }));

	const importableFiles = app.vault
		.getFiles()
		.filter((file) => isImportableExtension(file.extension))
		.sort((a, b) => a.path.localeCompare(b.path));
	const filesByPath = new Map(importableFiles.map((file) => [file.path, file]));
	const plan = planScan(importableFiles.map((file) => file.path), roots);
	const rows: ScanRow[] = [];
	const notes: Record<string, string> = {};
	let scanned = 0;
	let cancelled = false;

	for (const path of plan.files) {
		if (opts.signal?.aborted) {
			cancelled = true;
			break;
		}
		const file = filesByPath.get(path) as TFile | undefined;
		if (!file) {
			notes[path] = 'Skipped: the file disappeared during the scan. Restore it and scan again.';
			scanned++;
			opts.onProgress?.({ scanned, total: plan.files.length, currentPath: path });
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			continue;
		}

		try {
			const buffer = await app.vault.readBinary(file);
			const bytes = new Uint8Array(buffer);
			if (bytes.byteLength > LARGE_FILE_BYTES) {
				notes[path] = LARGE_FILE_NOTE;
			} else {
				const extension = file.extension.toLowerCase();
				const peeks = extension === 'xlsx' || extension === 'xls'
					? peekXLSXBytes(bytes)
					: extension === 'json'
						? peekJSON(new TextDecoder().decode(bytes))
						: peekCSV(new TextDecoder().decode(bytes));
				const candidate = scoreFilePeeks(path, file.name ?? fileName(path), peeks, RECIPE_REGISTRY);
				if (candidate) {
					const digest = computeSourceByteDigest(bytes);
					rows.push({
						path,
						name: file.name ?? fileName(path),
						candidate,
						state: reconcileCandidate(file.name ?? fileName(path), digest, known, indexReady),
						digest,
						note: null,
					});
				}
			}
		} catch (error) {
			notes[path] = unreadableNote(error);
		}

		scanned++;
		opts.onProgress?.({ scanned, total: plan.files.length, currentPath: path });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	return {
		rows,
		skipped: plan.skipped,
		notes,
		scanned,
		total: plan.files.length,
		cancelled,
		indexReady,
		foreignSets,
	};
}
