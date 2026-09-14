/**
 * draft-store.ts — Phase 3.6 (Import wizard draft sessions).
 *
 * Auto-saves wizard state to `_crosswalker/drafts/draft_<id>.json` so the
 * user can X out of the modal mid-import and resume later. Drafts auto-expire
 * after N days and cap at M total to prevent unbounded growth.
 *
 * The store is intentionally minimal — file I/O + parse + filter. Wizard
 * integration lives in import-wizard.ts (the wizard's Step 1 renders an
 * always-visible "Drafts from previous sessions" section).
 *
 * Schema (WizardDraft): see TYPE below. `columnConfigs` is serialized as
 * `Record<string, ...>` because JSON.stringify silently drops Map. The
 * applied config is referenced by ID only (re-lookup at resume time) to avoid
 * embedding stale config snapshots.
 */

import { App, TFile, TFolder } from 'obsidian';
import type { ColumnInfo, ImportRecipe } from '../types/config';
import type { ImportMapping } from './mapping/types';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import type { RecipeDocumentOrigin } from './recipe-document';
import type { ColumnDest } from './workbench';
import type { DebugLog } from '../utils/debug';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const DRAFT_SCHEMA_VERSION = 1 as const;

export interface WizardDraft {
	schemaVersion: typeof DRAFT_SCHEMA_VERSION;
	id: string;                                          // 'draft_<unix-ms>_<random-hex>'
	name: string;                                        // Auto-generated, e.g. 'NIST 800-53 import (Step 2)'
	createdAt: string;                                   // ISO-8601
	updatedAt: string;                                   // ISO-8601

	// Wizard navigation
	currentStep: number;                                 // 1-4

	// Source file (re-parsed on resume; the File object isn't serializable)
	sourceFile: { name: string; vaultPath: string | null } | null;
	sourceType: 'csv' | 'xlsx' | 'json' | null;
	selectedSheet: string | null;

	// Column analysis (expensive to recompute; persisted)
	columnInfos: ColumnInfo[];

	// User decisions (the payload the user invested time in)
	columnConfigsDict: Record<string, { useAs: string; outputKey: string }>;
	config: Partial<ImportRecipe>;
	outputPath: string;
	/**
	 * The user typed the destination, as opposed to the wizard filling it in.
	 * Absent on a pre-flag draft hydrates as `false`, which re-derives the
	 * per-import root on resume. That is deliberate: those drafts always recorded
	 * the bare global output path, which was never a choice, so replaying it would
	 * replay the flattened-destination defect it came from.
	 */
	destinationEdited?: boolean;
	/**
	 * Curated per-import root from the recognized recipe that seeded this draft
	 * (`recognizedDestination` in import-wizard.ts). Absent when nothing was
	 * recognized; resume then derives from the source file name.
	 */
	curatedDestination?: string;
	overwriteMode: 'skip' | 'replace' | 'error';
	frameworkId: string;

	// Shape-workbench mapping (spec §7i). Plain JSON — the whole ImportMapping is
	// pure data, so it serializes and round-trips as-is. Present only when the
	// draft was saved in workbench (beta) mode; on resume the workbench is
	// rehydrated from it instead of re-detecting from scratch.
	workbenchMapping?: ImportMapping;
	/** Canonical preservation authority for lossless recipe-backed resume. */
	workbenchRecipe?: CrosswalkerImportRecipe;
	workbenchRecipeOrigin?: RecipeDocumentOrigin;

	/**
	 * B5: which workbench-entry path produced this draft's mapping — the
	 * recognized-recipe fast path (spec §7m), as opposed to the plain
	 * `enableShapeWorkbench` setting. Optional/absent on pre-B5 drafts hydrates
	 * safely as `false` (the classic column-mapping mode default); resume mode
	 * additionally treats a present `workbenchMapping` as authoritative on its
	 * own (`isWorkbenchMode()` in import-wizard.ts), so a missing/stale value
	 * here never strands a resumed workbench mapping in the classic branch.
	 */
	recognizedFastPath?: boolean;

	/**
	 * M8: a snapshot of the demoted "all columns" destination table
	 * (`MappingWorkbench.getColumnDests()`), so a manual "route this column
	 * to…" choice survives a draft resume instead of being silently re-seeded
	 * from the detection heuristic. Absent on pre-M8 drafts — the workbench
	 * falls back to its normal `seedColumnDests()` seeding in that case.
	 */
	workbenchColumnDests?: Record<string, ColumnDest>;

	/**
	 * M8: dismissed evidence-card keys (`MappingWorkbench.getDismissed()`), so
	 * a dismissed detection stays suppressed after resume instead of
	 * reappearing — and re-adding the structure the user explicitly turned
	 * off. Absent on pre-M8 drafts hydrates safely as no dismissals.
	 */
	workbenchDismissed?: string[];

	// Applied saved-config reference (ID only; re-lookup at resume time)
	appliedConfigId: string | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DraftStoreConfig {
	draftExpiryDays: number;  // 0 = never expire
	maxDrafts: number;        // when exceeded, oldest drafts deleted
}

const DRAFTS_DIR = '_crosswalker/drafts';

// ---------------------------------------------------------------------------
// DraftStore
// ---------------------------------------------------------------------------

export class DraftStore {
	private app: App;
	private debug: DebugLog;
	private config: DraftStoreConfig;

	constructor(app: App, debug: DebugLog, config: DraftStoreConfig) {
		this.app = app;
		this.debug = debug;
		this.config = config;
	}

	setConfig(config: DraftStoreConfig): void {
		this.config = config;
	}

	/**
	 * List all valid (non-expired, non-corrupt) drafts in the drafts folder,
	 * sorted by `updatedAt` descending (most recent first).
	 */
	async list(): Promise<WizardDraft[]> {
		const folder = this.app.vault.getAbstractFileByPath(DRAFTS_DIR);
		if (!(folder instanceof TFolder)) return [];

		const drafts: WizardDraft[] = [];
		const expiryMs = this.config.draftExpiryDays > 0
			? Date.now() - this.config.draftExpiryDays * 24 * 60 * 60 * 1000
			: -Infinity;

		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			if (!child.name.endsWith('.json')) continue;

			try {
				const raw = await this.app.vault.read(child);
				const draft = JSON.parse(raw) as WizardDraft;

				// Schema version gate
				if (draft.schemaVersion !== DRAFT_SCHEMA_VERSION) {
					this.debug.warn('drafts', 'schema-version-mismatch', 'Draft has unsupported schema version', {
						path: child.path,
						found: draft.schemaVersion,
						expected: DRAFT_SCHEMA_VERSION,
					});
					continue;
				}

				// Expiry filter
				const updatedMs = new Date(draft.updatedAt).getTime();
				if (Number.isFinite(updatedMs) && updatedMs < expiryMs) {
					continue;
				}

				drafts.push(draft);
			} catch (err) {
				this.debug.warn('drafts', 'parse-failed', 'Draft JSON could not be parsed', {
					path: child.path,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		drafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		return drafts;
	}

	async load(id: string): Promise<WizardDraft | null> {
		const path = `${DRAFTS_DIR}/${id}.json`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		try {
			const raw = await this.app.vault.read(file);
			const draft = JSON.parse(raw) as WizardDraft;
			if (draft.schemaVersion !== DRAFT_SCHEMA_VERSION) {
				this.debug.warn('drafts', 'load-version-mismatch', 'Refusing to load draft from incompatible schema', {
					id,
					found: draft.schemaVersion,
					expected: DRAFT_SCHEMA_VERSION,
				});
				return null;
			}
			return draft;
		} catch (err) {
			this.debug.warn('drafts', 'load-failed', 'Draft load failed', {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/**
	 * Persist a draft. Writes are idempotent — same ID overwrites. Enforces
	 * `maxDrafts` cap by deleting the oldest after a successful write when the
	 * total exceeds the cap.
	 */
	async save(draft: WizardDraft): Promise<void> {
		await this.ensureFolder();

		const path = `${DRAFTS_DIR}/${draft.id}.json`;
		const payload = JSON.stringify(draft, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, payload);
		} else {
			await this.app.vault.create(path, payload);
		}

		this.debug.info('drafts', 'saved', `Draft ${draft.id} saved at step ${draft.currentStep}`, {
			id: draft.id,
			step: draft.currentStep,
			source: draft.sourceFile?.name,
		});

		await this.enforceMaxDrafts();
	}

	async delete(id: string): Promise<void> {
		const path = `${DRAFTS_DIR}/${id}.json`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.delete(file);
			this.debug.info('drafts', 'deleted', `Draft ${id} deleted`, { id });
		}
	}

	async clearAll(): Promise<number> {
		const drafts = await this.list();
		for (const d of drafts) {
			await this.delete(d.id);
		}
		this.debug.info('drafts', 'cleared-all', `Cleared ${drafts.length} drafts`, { count: drafts.length });
		return drafts.length;
	}

	/**
	 * Manually trigger the expiry sweep. (Auto-runs implicitly via list() filter
	 * but those drafts only become deleted on the next save() that exceeds the
	 * cap. This command actually removes expired files from disk.)
	 */
	async purgeExpired(): Promise<number> {
		const folder = this.app.vault.getAbstractFileByPath(DRAFTS_DIR);
		if (!(folder instanceof TFolder)) return 0;

		if (this.config.draftExpiryDays <= 0) return 0;
		const expiryMs = Date.now() - this.config.draftExpiryDays * 24 * 60 * 60 * 1000;

		let purged = 0;
		for (const child of folder.children) {
			if (!(child instanceof TFile) || !child.name.endsWith('.json')) continue;
			try {
				const raw = await this.app.vault.read(child);
				const draft = JSON.parse(raw) as WizardDraft;
				const updatedMs = new Date(draft.updatedAt).getTime();
				if (Number.isFinite(updatedMs) && updatedMs < expiryMs) {
					await this.app.vault.delete(child);
					purged += 1;
				}
			} catch {
				// Corrupt JSON — leave it for the user to deal with via clearAll
			}
		}

		this.debug.info('drafts', 'purged-expired', `Purged ${purged} expired drafts`, { count: purged });
		return purged;
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private async ensureFolder(): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(DRAFTS_DIR);
		if (existing instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(DRAFTS_DIR);
		} catch (err) {
			// Race-condition tolerance: another concurrent save may have created
			// the folder between our check and create call.
			const errMsg = err instanceof Error ? err.message : String(err);
			if (!errMsg.includes('already exists')) {
				throw err;
			}
		}
	}

	private async enforceMaxDrafts(): Promise<void> {
		if (this.config.maxDrafts <= 0) return;
		const drafts = await this.list();
		if (drafts.length <= this.config.maxDrafts) return;
		// list() is sorted newest-first; oldest are at the tail
		const toDelete = drafts.slice(this.config.maxDrafts);
		for (const d of toDelete) {
			await this.delete(d.id);
		}
		this.debug.info('drafts', 'cap-enforced', `Enforced maxDrafts cap, deleted ${toDelete.length} oldest`, {
			cap: this.config.maxDrafts,
			deleted: toDelete.length,
		});
	}
}

// ---------------------------------------------------------------------------
// Serialization helpers (wizard ↔ draft)
// ---------------------------------------------------------------------------

/**
 * Generate a fresh draft ID. Format: `draft_<unix-ms>_<8-hex>`.
 */
export function newDraftId(): string {
	const ms = Date.now();
	let hex = '';
	for (let i = 0; i < 4; i++) {
		hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
	}
	return `draft_${ms}_${hex}`;
}

/**
 * Generate a human-readable auto-name for a new draft.
 */
export function autoDraftName(sourceName: string | undefined, step: number): string {
	const base = sourceName ?? 'untitled';
	const stem = base.replace(/\.(csv|tsv|xlsx?|json)$/i, '');
	return `${stem} (Step ${step})`;
}

/**
 * Convert the wizard's `columnConfigs` Map → JSON-serializable Record.
 * Used at save boundary; reverse at load boundary.
 */
export function columnConfigsToDict(
	configs: Map<string, { useAs: string; outputKey: string }>,
): Record<string, { useAs: string; outputKey: string }> {
	const out: Record<string, { useAs: string; outputKey: string }> = {};
	for (const [k, v] of configs.entries()) {
		out[k] = { useAs: v.useAs, outputKey: v.outputKey };
	}
	return out;
}

/**
 * Inverse of `columnConfigsToDict` — Record → Map. Used when hydrating wizard
 * state from a draft.
 */
export function dictToColumnConfigs(
	dict: Record<string, { useAs: string; outputKey: string }>,
): Map<string, { useAs: string; outputKey: string }> {
	const out = new Map<string, { useAs: string; outputKey: string }>();
	for (const [k, v] of Object.entries(dict)) {
		out.set(k, { useAs: v.useAs, outputKey: v.outputKey });
	}
	return out;
}

/**
 * How to restore a draft's source data on resume (spec §7i).
 *
 * When the draft recorded a `sourceFile.vaultPath` AND that vault file still
 * exists, the wizard re-reads and re-parses it automatically (no forced return
 * to Step 1, no re-select prompt). Otherwise the file came from the OS picker
 * (external, no vault path) or has since been deleted, and the wizard falls back
 * to asking the user to re-select it.
 *
 * Pure decision function — the caller supplies a `vaultFileExists` predicate so
 * this stays free of Obsidian imports and is unit-testable.
 */
export function resolveDraftSource(
	draft: Pick<WizardDraft, 'sourceFile'>,
	vaultFileExists: (path: string) => boolean,
): { action: 'reparse'; vaultPath: string } | { action: 'reselect' } {
	const vaultPath = draft.sourceFile?.vaultPath ?? null;
	if (vaultPath && vaultFileExists(vaultPath)) {
		return { action: 'reparse', vaultPath };
	}
	return { action: 'reselect' };
}

/**
 * Format an ISO-8601 timestamp as a friendly relative-time string. Coarse-
 * grained — good enough for "when did I last touch this draft" UX.
 */
export function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return 'unknown';
	const deltaMs = Date.now() - then;
	const deltaSec = Math.floor(deltaMs / 1000);
	if (deltaSec < 60) return 'just now';
	const deltaMin = Math.floor(deltaSec / 60);
	if (deltaMin < 60) return `${deltaMin} minute${deltaMin === 1 ? '' : 's'} ago`;
	const deltaHr = Math.floor(deltaMin / 60);
	if (deltaHr < 24) return `${deltaHr} hour${deltaHr === 1 ? '' : 's'} ago`;
	const deltaDay = Math.floor(deltaHr / 24);
	if (deltaDay === 1) return 'yesterday';
	if (deltaDay < 7) return `${deltaDay} days ago`;
	if (deltaDay < 30) return `${Math.floor(deltaDay / 7)} week${Math.floor(deltaDay / 7) === 1 ? '' : 's'} ago`;
	return `${Math.floor(deltaDay / 30)} month${Math.floor(deltaDay / 30) === 1 ? '' : 's'} ago`;
}
