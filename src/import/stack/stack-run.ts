import type { App, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { discoverImportSets, settleVaultIndex, type DiscoveredImportSet } from '../../generation/import-set';
import { importSssom, type SssomImportResult } from '../sssom-importer';
import { readCtidJson, readOlirWorkbook, mappingRowsToTsv } from './mapping-readers';
import type { MappingCandidate } from './stack-recognize';
import type { MappingPreset } from '../recipe-registry';
import { ATTACK_MAPPING_RELEASE } from '../recipe-registry';

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

export interface CompletedMapping {
	id: string;
	label: string;
	setId: string;
	folder: string;
	noteCount: number;
	unresolved: string[];
	/** The captured input is kept only for this open modal's explicit reconnect. */
	tsv: string;
}

export interface MappingRunDependencies {
	importRows(tsv: string, options: { importSet: 'new-set-qualified' | { id: string }; outputFolder?: string; overwriteMode?: 'skip' | 'replace' }): Promise<SssomImportResult>;
	listSets(root?: string): Promise<DiscoveredImportSet[]>;
	readBytes(file: TFile): Promise<Uint8Array>;
	log(stage: string, slot: string): void;
	/** Persist each confirmed set in the open modal before the next mapping can fail. */
	onCompleted?(mapping: CompletedMapping): void;
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
		const outcome = await dependencies.importRows(item.tsv, { importSet: { id: item.setId }, outputFolder: set.root, overwriteMode: 'replace' });
		if (!outcome.generation?.success) throw new Error(`${item.label} could not reconnect. Check the mapping source and vault permissions, then try again.`);
		refreshed.push({ ...item, noteCount: outcome.generation.created.length, unresolved: outcome.summary });
	}
	return refreshed;
}

export async function importMappingSlots(
	mappings: readonly MappingPreset[], candidates: readonly MappingCandidate[], files: ReadonlyMap<string, TFile>,
	dependencies: MappingRunDependencies, already: readonly CompletedMapping[] = [],
): Promise<CompletedMapping[]> {
	const completed = [...already];
	for (const mapping of mappings) {
		if (mapping.kind === 'from-slot' || completed.some((item) => item.id === mapping.id)) continue;
		const candidate = candidates.find((item) => item.mapping.id === mapping.id);
		let tsv: string;
		if (!candidate && mapping.kind === 'built-in') {
			// Only this NIST public-domain asset ships in the bundle. CTID and CRI files stay local.
			tsv = require('../../../recipes/import/crosswalks/nist-csf-2-to-nist-800-53.sssom.tsv') as string;
		} else {
			const file = candidate && files.get(candidate.source.path);
			if (!file || !candidate) throw new Error(`${mapping.label} has no recognized source file. Add the publisher mapping export, then try again.`);
			const bytes = await dependencies.readBytes(file);
			if (/\.json$/i.test(file.name)) {
				const parsed = readCtidJson(new TextDecoder().decode(bytes), mapping.from);
				if (parsed.attackVersion && parsed.attackVersion !== ATTACK_MAPPING_RELEASE) {
					throw new Error(`This mapping covers ATT&CK ${parsed.attackVersion}, but this stack expects ${ATTACK_MAPPING_RELEASE}. Choose the matching CTID release and try again.`);
				}
				tsv = mappingRowsToTsv(parsed.rows, 'CTID Mappings Explorer', mapping.from, mapping.to, parsed.attackVersion ?? ATTACK_MAPPING_RELEASE);
			} else {
				const options = { subjectOntology: mapping.from, objectOntology: mapping.to,
					depad: mapping.id === 'cri-80053' ? 'subject' as const : 'object' as const,
					reverse: mapping.id === 'cri-80053' };
				const rows = readOlirWorkbook(bytes, options, [candidate.table], candidate.headerRow);
				if (!rows.length) throw new Error(`${mapping.label} has no Focal/Reference mapping rows. Choose the publisher mapping sheet, then try again.`);
				tsv = mappingRowsToTsv(rows, 'OLIR mapping workbook', mapping.from, mapping.to, file.name);
			}
		}
		dependencies.log('mapping', mapping.id);
		const before = new Set((await dependencies.listSets()).map((set) => set.id));
		const outcome = await dependencies.importRows(tsv, { importSet: 'new-set-qualified', overwriteMode: 'skip' });
		if (!outcome.generation?.success || !outcome.folder) throw new Error(`${mapping.label} could not be imported. Check the mapping file and destination, then try again.`);
		// Scoped discovery reads cache-cold notes in the written destination; a global
		// cache settle can time out immediately after generation and lose this set's ID.
		const added = (await dependencies.listSets(outcome.folder)).filter((set) => !before.has(set.id) && set.root === outcome.folder);
		if (added.length !== 1) throw new Error(`${mapping.label} was written but its new import set could not be confirmed. Wait for vault indexing, then inspect the mapping notes before retrying.`);
		const record = { id: mapping.id, label: mapping.label, setId: added[0].id,
			folder: outcome.folder ?? added[0].root ?? '', noteCount: added[0].noteCount,
			unresolved: outcome.summary, tsv };
		completed.push(record);
		dependencies.onCompleted?.(record);
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
