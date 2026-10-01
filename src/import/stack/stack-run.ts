import { plural } from '../../utils/plural';
import type { App, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { discoverImportSets, settleVaultIndex, type DiscoveredImportSet } from '../../generation/import-set';
import { importSssom, sssomRecipeDigest, type SssomImportResult } from '../sssom-importer';
import { computeSourceByteDigest } from '../../generation/hash';
import type { RunChoice } from './stack-persistence';
import { readCtidJson, readOlirWorkbookDetails, mappingRowsToTsv } from './mapping-readers';
import type { MappingCandidate } from './stack-recognize';
import type { MappingPreset } from '../recipe-registry';
import { ATTACK_MAPPING_RELEASE } from '../recipe-registry';
import type { MappingForm } from '../../generation/import-set-block';

/** Wait for notes written by one framework slot before the next slot's vault-wide
 * import-set qualification. A single `resolved` event can precede those notes;
 * never interpret a cold metadata cache as an empty set. */
export async function waitForIndexedDestination(app: App, root: string, timeoutMs = 10_000): Promise<number> {
	// An empty destination is not a scoped slot; there is nothing safe to poll.
	if (!root.trim()) return 0;
	const prefix = `${root.replace(/\/$/, '')}/`;
	const remaining = (): number => app.vault.getMarkdownFiles()
		.filter((file) => file.path.startsWith(prefix) && !app.metadataCache.getFileCache(file)).length;
	const deadline = Date.now() + timeoutMs;
	let cold = remaining();
	while (cold > 0 && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
		cold = remaining();
	}
	// A Replace refresh may expose a non-null but old cache entry. It still
	// identifies an existing set, not an absent one, so it cannot cause the
	// next slot's first-run set qualification to mint a duplicate set.
	return cold;
}

/** A crosswalk needs replay only when its target is newly written later in this run. */
export function needsLateCrosswalkRefresh(targetOntologies: readonly string[], laterImportedOntologies: readonly string[]): boolean {
	return targetOntologies.some((target) => laterImportedOntologies.includes(target));
}

export function builtInMappingTsv(): string {
	return require('../../../recipes/import/crosswalks/nist-csf-2-to-nist-800-53.sssom.tsv') as string;
}

export interface CompletedMapping {
	id: string;
	label: string;
	setId: string;
	folder: string;
	/** Mapping notes the set owns; 0 for a table-form set (see `rowCount`). */
	noteCount: number;
	/** How the set stores its mappings. Absent on records from before slice 3: notes. */
	form?: MappingForm;
	/** Table sets only: rows in the one table file. */
	rowCount?: number;
	/** Table refresh only: rows whose review columns were carried over. */
	reviewCarried?: number;
	/** Table refresh only: rows the new source no longer produces. */
	rowsDropped?: number;
	upToDate?: number;
	duplicateRowsSkipped?: number;
	sheetSkips?: { sheet: string; reason: string }[];
	unresolved: string[];
	/** The captured input is kept only for this open modal's explicit reconnect. */
	tsv: string;
	/** Facts captured from this run's source and effective recipe. */
	sourceDigest?: string;
	recipeDigest?: string;
	sourceName?: string;
}

/**
 * The mapping clauses of the completion headline. Note clauses count only notes-form sets,
 * and a run whose separately imported sets are all tables reports only the tables written.
 */
export function mappingCompletionText(mappingSets: readonly CompletedMapping[]): string {
	const tables = mappingSets.filter((item) => item.form === 'table');
	const notes = mappingSets.filter((item) => item.form !== 'table');
	const tableText = tables.length ? `${plural(tables.length, 'mapping table')} written. ` : '';
	if (tables.length && !notes.length) return tableText;
	const upToDate = notes.reduce((sum, item) => sum + (item.upToDate ?? 0), 0);
	const written = notes.reduce((sum, item) => sum + item.noteCount, 0) - upToDate;
	return `${plural(written, 'separately imported mapping note')} created or updated; ${plural(upToDate, 'separately imported mapping note')} already up to date. ${tableText}`;
}

export interface MappingRunDependencies {
	importRows(tsv: string, options: { importSet: 'new-set-qualified' | { id: string }; outputFolder?: string; overwriteMode?: 'skip' | 'replace'; mappingForm?: MappingForm }): Promise<SssomImportResult>;
	listSets(root?: string): Promise<DiscoveredImportSet[]>;
	readBytes(file: TFile): Promise<Uint8Array>;
	log(stage: string, slot: string): void;
	/** Persist each confirmed set in the open modal before the next mapping can fail. */
	onCompleted?(mapping: CompletedMapping): void | Promise<void>;
}

/** A reconnect may only use a stored set id from this run record, never source or label matching. */
export async function reconnectMappings(
	completed: CompletedMapping[], dependencies: MappingRunDependencies,
): Promise<CompletedMapping[]> {
	const known = new Map((await dependencies.listSets()).map((set) => [set.id, set]));
	const refreshed: CompletedMapping[] = [];
	for (const item of completed) {
		const set = known.get(item.setId);
		if (!set || !set.root) throw new Error(`Mapping set ${item.setId} is no longer available. Import its source again as a new set.`);
		dependencies.log('mapping-refresh', item.id);
		// Routed by the set's pinned form, never by a record or a setting: the
		// importer refuses a refresh that asks for the other form.
		const form = set.mapping_form ?? 'notes';
		const outcome = await dependencies.importRows(item.tsv, { importSet: { id: item.setId }, outputFolder: set.root, overwriteMode: 'replace', mappingForm: form });
		if (!outcome.generation?.success) throw new Error(`${item.label} could not reconnect. Check the mapping source and vault permissions, then try again.`);
		refreshed.push(form === 'table'
			? { ...item, form, noteCount: 0, rowCount: outcome.rowsWritten ?? 0, upToDate: 0,
				reviewCarried: outcome.reviewCarried ?? 0, rowsDropped: outcome.rowsDropped ?? 0, unresolved: outcome.summary }
			: { ...item, form, noteCount: (outcome.generation.created.length + (outcome.generation.upToDate?.length ?? 0)), upToDate: (outcome.generation.upToDate?.length ?? 0), unresolved: outcome.summary });
	}
	return refreshed;
}

export async function importMappingSlots(
	mappings: readonly MappingPreset[], candidates: readonly MappingCandidate[], files: ReadonlyMap<string, TFile>,
	dependencies: MappingRunDependencies, already: readonly CompletedMapping[] = [],
	/**
	 * `form` is the storage form: for a new set, the user's choice; for a
	 * refresh, the set's pinned form (the caller reads it from discovery, never
	 * from the review dropdown). Absent means notes.
	 */
	choices?: ReadonlyMap<string, { mode: RunChoice; setId?: string; folder?: string; form?: MappingForm }>,
): Promise<CompletedMapping[]> {
	const completed = [...already];
	for (const mapping of mappings) {
		if (mapping.kind === 'from-slot' || choices?.get(mapping.id)?.mode === 'skip'
			|| completed.some((item) => item.id === mapping.id)) continue;
		const candidate = candidates.find((item) => item.mapping.id === mapping.id);
		let tsv: string;
		let sourceDigest: string;
		let sourceName: string;
		let duplicateRowsSkipped = 0;
		let sheetSkips: { sheet: string; reason: string }[] = [];
		if (!candidate && mapping.kind === 'built-in') {
			// Only this NIST public-domain asset ships in the bundle. CTID and CRI files stay local.
			tsv = builtInMappingTsv();
			sourceDigest = computeSourceByteDigest(new TextEncoder().encode(tsv));
			sourceName = 'Built-in mapping';
		} else {
			const file = candidate && files.get(candidate.source.path);
			if (!file || !candidate) throw new Error(`${mapping.label} has no recognized source file. Add the publisher mapping export, then try again.`);
			const bytes = await dependencies.readBytes(file);
			sourceDigest = computeSourceByteDigest(bytes);
			sourceName = file.name;
			if (/\.json$/i.test(file.name)) {
				const parsed = readCtidJson(new TextDecoder().decode(bytes), mapping.from);
				if (parsed.attackVersion && parsed.attackVersion !== ATTACK_MAPPING_RELEASE) {
					throw new Error(`This mapping covers ATT&CK ${parsed.attackVersion}, but this stack expects ${ATTACK_MAPPING_RELEASE}. Choose the matching CTID release and try again.`);
				}
				duplicateRowsSkipped = parsed.duplicateRowsSkipped;
				tsv = mappingRowsToTsv(parsed.rows, 'CTID Mappings Explorer', mapping.from, mapping.to, parsed.attackVersion ?? ATTACK_MAPPING_RELEASE);
			} else {
				const options = { subjectOntology: mapping.from, objectOntology: mapping.to,
					depad: mapping.id === 'cri-80053' ? 'subject' as const : 'object' as const,
					reverse: mapping.id === 'cri-80053' };
				const workbook = readOlirWorkbookDetails(bytes, options, [candidate.table], candidate.headerRow);
				sheetSkips = workbook.skipped;
				for (const skip of workbook.skipped) dependencies.log('mapping-sheet-skipped', `${mapping.id}: ${skip.sheet}: ${skip.reason}`);
				dependencies.log('mapping-sheets-included', `${mapping.id}: ${workbook.included.length}`);
				const rows = workbook.rows;
				if (!rows.length) throw new Error(`${mapping.label} has no Focal/Reference mapping rows. Choose the publisher mapping sheet, then try again.`);
				tsv = mappingRowsToTsv(rows, 'OLIR mapping workbook', mapping.from, mapping.to, file.name);
			}
		}
		dependencies.log('mapping', mapping.id);
		const selection = choices?.get(mapping.id);
		const refresh = selection?.mode === 'refresh' ? selection : undefined;
		if (refresh && (!refresh.setId || !refresh.folder)) throw new Error(`${mapping.label} has no confirmed refresh set. Import as a new set.`);
		const form: MappingForm = selection?.form ?? 'notes';
		const before = refresh ? new Set<string>() : new Set((await dependencies.listSets()).map((set) => set.id));
		const outcome = await dependencies.importRows(tsv, refresh
			? { importSet: { id: refresh.setId! }, outputFolder: refresh.folder, overwriteMode: 'replace', mappingForm: form }
			: { importSet: 'new-set-qualified', overwriteMode: 'skip', mappingForm: form });
		if (!outcome.generation?.success || !outcome.folder) {
			// A table run's refusals (a notes set refreshed as a table, unreadable
			// rows that would lose reviews) already name a cause and an action. So
			// does the early refusal of non-curie endpoint ids, in either form.
			const first = outcome.generation?.errors?.[0]?.message;
			const reason = first && (form === 'table' || first.includes('Convert the set') || first.includes('is not a curie')) ? first : undefined;
			throw new Error(reason ? `${mapping.label} could not be imported. ${reason}`
				: `${mapping.label} could not be imported. Check the mapping file and destination, then try again.`);
		}
		// The scoped delta is the runner's result for a new mapping; refresh uses the explicitly stored id.
		const added = refresh ? [] : (await dependencies.listSets(outcome.folder)).filter((set) => !before.has(set.id) && set.root === outcome.folder);
		if (!refresh && added.length !== 1) throw new Error(`${mapping.label} was written but its new import set could not be confirmed. Wait for vault indexing, then inspect the mapping ${form === 'table' ? 'table' : 'notes'} before retrying.`);
		const counts = form === 'table'
			? { form, noteCount: 0, rowCount: outcome.rowsWritten ?? (refresh ? 0 : added[0].rowCount), upToDate: 0,
				...(refresh ? { reviewCarried: outcome.reviewCarried ?? 0, rowsDropped: outcome.rowsDropped ?? 0 } : {}) }
			: { form, noteCount: refresh ? (outcome.generation.created.length + (outcome.generation.upToDate?.length ?? 0)) : added[0].noteCount,
				upToDate: (outcome.generation.upToDate?.length ?? 0) };
		const record: CompletedMapping = { id: mapping.id, label: mapping.label, setId: refresh ? refresh.setId! : added[0].id,
			folder: outcome.folder, ...counts, duplicateRowsSkipped, sheetSkips, unresolved: outcome.summary, tsv, sourceDigest, sourceName,
			recipeDigest: sssomRecipeDigest(mapping.from, mapping.to) };
		completed.push(record);
		await dependencies.onCompleted?.(record);
	}
	return completed;
}

export function stackMappingDependencies(app: App, plugin: CrosswalkerPlugin): MappingRunDependencies {
	return {
		importRows: (tsv, options) => importSssom(app, tsv, plugin.runProjection, plugin.precomputeClosure,
			{ ...options }, plugin.debug),
		listSets: async (root) => {
			if (root !== undefined) return discoverImportSets(app, root);
			if (await settleVaultIndex(app) > 0) throw new Error('Vault index is still loading. Wait a moment, then try again.');
			return discoverImportSets(app);
		},
		readBytes: async (file) => new Uint8Array(await app.vault.readBinary(file)),
		log: (stage, slot) => plugin.debug.info('stack', stage, `Stack ${stage}: ${slot}`),
	};
}
