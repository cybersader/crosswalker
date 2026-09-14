/**
 * Explicit housekeeping re-baselining for Ch 43 re-attestation.
 *
 * This is deliberately selection-driven and confirmation-gated. It records the
 * current subject fingerprints only after Tier 2 proves every selected row is a
 * housekeeping-only change. It never writes status, reviewer, or review_date.
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { readReviewGroupCids, type ReviewGroupCids } from '../generation/hash';
import { hashFrontmatter } from '../tier2/projector';
import { readNoteFrontmatterState } from '../export/vault-reader';

export interface HousekeepingRebaselineCandidate {
	vaultPath: string;
	status: string | null;
	subjectCurie: string;
	reviewCid: string;
	reviewGroups: ReviewGroupCids;
	/**
	 * AM-25 (2026-08-31). WHICH link the report row was about.
	 *
	 * The junction's own identity, carried from the query index to the write so
	 * the note found at `vaultPath` can be checked against it before an audit fact
	 * is stamped on it. It was available in Tier 2 all along and was never
	 * selected.
	 */
	junctionCurie: string;
}

/** Extract the first-cell junction links from selected report rows. */
export function selectedReportPaths(selection: string): string[] {
	const paths = new Set<string>();
	for (const line of selection.split(/\r?\n/)) {
		const tableLink = line.match(/^\s*\|\s*\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]\s*\|/);
		if (tableLink) paths.add(tableLink[1].trim());
	}
	// Also support selecting one or more bare report links rather than full rows.
	if (paths.size === 0) {
		for (const match of selection.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
			paths.add(match[1].trim());
		}
	}
	return [...paths].filter(Boolean);
}

/**
 * Resolve and validate every selected path before any vault write occurs.
 * Refuses the whole selection if even one row is not a classifiable,
 * housekeeping-only change.
 */
export function resolveHousekeepingRebaselineCandidates(
	db: any,
	paths: string[],
): HousekeepingRebaselineCandidate[] {
	const out: HousekeepingRebaselineCandidate[] = [];
	for (const path of paths) {
		const rows = db.exec({
			sql: `
				SELECT
					j.vault_path,
					j.status,
					j.subject_baseline,
					j.change_kind,
					c.curie,
					c.review_cid,
					c.review_wording_cid,
					c.review_scope_cid,
					c.review_housekeeping_cid,
					-- AM-25. The junction's OWN identity. The row is still found by
					-- path (the report renders links, and a link is a path), but what
					-- is written is checked against this before it is written.
					j.curie
				FROM junction_notes_with_freshness j
				LEFT JOIN concepts c
				  ON c.rowid = (
					SELECT c2.rowid FROM concepts c2
					WHERE c2.curie = COALESCE(j.reviewed_against_curie, j.subject_curie)
					ORDER BY c2.ontology_id
					LIMIT 1
				  )
				WHERE j.vault_path = $path
				LIMIT 1
			`,
			bind: { $path: path },
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];
		if (rows.length === 0) {
			throw new Error(`${path} is not a projected evidence link.`);
		}
		const row = rows[0];
		if (String(row[2]) !== 'changed' || String(row[3]) !== 'housekeeping') {
			throw new Error(`${path} is not a housekeeping-only changed link.`);
		}
		const subjectCurie = typeof row[4] === 'string' ? row[4].trim() : '';
		const reviewCid = typeof row[5] === 'string' ? row[5].trim() : '';
		const reviewGroups = readReviewGroupCids({
			wording: row[6],
			scope: row[7],
			housekeeping: row[8],
		});
		if (!subjectCurie || !/^sha256-[a-f0-9]{64}$/.test(reviewCid) || !reviewGroups) {
			throw new Error(`${path} has no complete current fingerprint set.`);
		}
		// AM-25. A projected junction always carries a curie (`junction_notes.curie`
		// is NOT NULL and projection rejects a junction without one), so an empty
		// value here means the index row is not the shape this command believes it
		// is. Refuse rather than write an audit fact with nothing to check it
		// against.
		const junctionCurie = typeof row[9] === 'string' ? row[9].trim() : '';
		if (!junctionCurie) {
			throw new Error(`${path} has no recorded identity in the coverage index, so Crosswalker cannot confirm which link it is.`);
		}
		out.push({
			vaultPath: String(row[0]),
			status: row[1] === null || row[1] === undefined ? null : String(row[1]),
			subjectCurie,
			reviewCid,
			reviewGroups,
			junctionCurie,
		});
	}
	return out;
}

/**
 * Raised when the canonical note edits all succeeded and only the derived index
 * update failed.
 *
 * The distinction is reported to the user rather than kept internal. Telling
 * someone their re-baseline failed, when their notes were in fact updated and
 * only a rebuildable cache lagged, invites them to run it again or to believe
 * an audit action did not happen when it did. The index catches up on its own.
 */
export class HousekeepingIndexUpdateError extends Error {
	/** Always true: this error exists only for the after-Tier-1 case. */
	readonly canonicalWritten = true;
	constructor(message: string, readonly reason: unknown) {
		super(message);
		this.name = 'HousekeepingIndexUpdateError';
	}
}

/** Canonical Tier 1 first; Tier 2 is updated only after every file write succeeds. */
export async function applyHousekeepingRebaseline(
	app: App,
	db: any,
	candidates: HousekeepingRebaselineCandidate[],
): Promise<void> {
	// Resolve every selected note before the first write. This cannot make vault
	// writes transactional, but it prevents a missing later selection from
	// producing an avoidable half-applied batch.
	//
	// AM-25 (2026-08-31). And every note is CHECKED before the first write, not
	// merely resolved. This is the only write in the plugin that asserts an audit
	// fact - `reviewed_against` is the baseline a compliance claim rests on - and
	// it was asserting it by address: a Tier 2 row selected `WHERE vault_path =`,
	// parsed out of a generated report, then stamped onto whatever note now sits
	// at that path. A stale report plus a stale projection (one note deleted,
	// another created at the same path) recorded an attestation baseline onto a
	// note nothing had ever identified. The junction's own curie is the fact that
	// says which link it is; one mismatch refuses the whole selection, through the
	// same refuse-all path every other check here uses.
	const files: { candidate: HousekeepingRebaselineCandidate; file: TFile }[] = [];
	for (const candidate of candidates) {
		const file = app.vault.getAbstractFileByPath(candidate.vaultPath);
		if (!(file instanceof TFile)) throw new Error(`Evidence link not found: ${candidate.vaultPath}`);
		const read = await readNoteFrontmatterState(app, file);
		if (read.state === 'unreadable') {
			// AM-19's rule, at this site: nothing was established about this note, so
			// nothing may be claimed about it. Never "this is not the link" and never
			// an invitation to move or delete it.
			throw new Error(
				`Crosswalker could not read the properties of ${candidate.vaultPath}, `
				+ 'so it could not confirm which link it is. Nothing was recorded. '
				+ "Fix that note's properties block, then run this again.",
			);
		}
		const actual = read.state === 'ok' && typeof read.frontmatter.curie === 'string'
			? read.frontmatter.curie.trim()
			: '';
		if (!actual) {
			throw new Error(
				`${candidate.vaultPath} carries no identity, so Crosswalker cannot confirm it is the link the report named. `
				+ 'Nothing was recorded. Regenerate the coverage report, then try again.',
			);
		}
		if (actual !== candidate.junctionCurie) {
			throw new Error(
				`${candidate.vaultPath} is not the link the report named: the report row is ${candidate.junctionCurie}, `
				+ `the note there is ${actual}. Nothing was recorded. Regenerate the coverage report, then try again.`,
			);
		}
		files.push({ candidate, file });
	}
	const sourceHashes = new Map<string, string>();

	for (const { candidate, file } of files) {
		await app.fileManager.processFrontMatter(file, (frontmatter) => {
			// Intentionally no writes to status, reviewer, review_date, or coverage.
			frontmatter.reviewed_against = {
				curie: candidate.subjectCurie,
				review_cid: candidate.reviewCid,
				review_groups: { ...candidate.reviewGroups },
			};
			sourceHashes.set(candidate.vaultPath, hashFrontmatter(frontmatter));
		});
	}

	// Tier 2 is deletable projection state. Update it only after Tier 1 succeeded,
	// so an interruption can leave a stale cache but can never make the cache the
	// sole source of the new audit fact. The savepoint makes the selected Tier 2
	// rows all-or-none and keeps source_hash aligned with the canonical edit.
	// The SAVEPOINT is inside the try because opening it is itself a database
	// call, and it is the first thing to fail if the index was reset while the
	// confirmation dialog was open. Left outside, that failure escaped untyped
	// and the command reported the whole operation as failed even though every
	// note above had already been written.
	try {
		db.exec('SAVEPOINT housekeeping_rebaseline');
		for (const candidate of candidates) {
			db.exec({
				sql: `
					UPDATE junction_notes
					SET reviewed_against_curie = $curie,
						reviewed_against_cid = $review_cid,
						reviewed_wording_cid = $wording,
						reviewed_scope_cid = $scope,
						reviewed_housekeeping_cid = $housekeeping,
						source_hash = $source_hash,
						modified_at = $modified_at
					WHERE vault_path = $path
				`,
				bind: {
					$curie: candidate.subjectCurie,
					$review_cid: candidate.reviewCid,
					$wording: candidate.reviewGroups.wording,
					$scope: candidate.reviewGroups.scope,
					$housekeeping: candidate.reviewGroups.housekeeping,
					$source_hash: sourceHashes.get(candidate.vaultPath),
					$modified_at: new Date().toISOString(),
					$path: candidate.vaultPath,
				},
			});
		}
		db.exec('RELEASE housekeeping_rebaseline');
	} catch (error) {
		try {
			db.exec('ROLLBACK TO housekeeping_rebaseline');
			db.exec('RELEASE housekeeping_rebaseline');
		} catch {
			// Preserve the original Tier 2 update error. On a closed database
			// both of these throw too, which is expected and says nothing new.
		}
		throw new HousekeepingIndexUpdateError(
			error instanceof Error ? error.message : String(error),
			error,
		);
	}
}

class HousekeepingRebaselineConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly count: number,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	private finish(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(confirmed);
		this.close();
	}

	onOpen(): void {
		this.contentEl.empty();
		new Setting(this.contentEl).setName('Record housekeeping baseline').setHeading();
		this.contentEl.createEl('p', {
			text: `Record the current fingerprints for ${this.count} selected housekeeping-only change${this.count === 1 ? '' : 's'}?`,
		});
		this.contentEl.createEl('p', {
			text: 'This acknowledges source changes outside recipe body and managed frontmatter declarations. It does not approve content, change link status, identify a reviewer, or change the original review date.',
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
			.addButton((button) => button.setButtonText('Record baseline').setCta()
				.onClick(() => this.finish(true)));
	}

	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolve(false);
		}
		this.contentEl.empty();
	}
}

function confirmHousekeepingRebaseline(app: App, count: number): Promise<boolean> {
	return new Promise((resolve) => new HousekeepingRebaselineConfirmModal(app, count, resolve).open());
}

export interface HousekeepingRebaselineCommandDeps {
	app: App;
	openTier2: () => Promise<{ db: any }>;
	selection: string;
	confirm?: (count: number) => Promise<boolean>;
}

/** Selection-based command entry point. Every rejection is explicit and non-writing. */
export async function runHousekeepingRebaselineCommand(
	deps: HousekeepingRebaselineCommandDeps,
): Promise<number> {
	const paths = selectedReportPaths(deps.selection);
	if (paths.length === 0) {
		new Notice('Select one or more housekeeping rows in an evidence coverage report first.');
		return 0;
	}
	try {
		const { db } = await deps.openTier2();
		const candidates = resolveHousekeepingRebaselineCandidates(db, paths);
		const confirmed = await (deps.confirm ?? ((count) => confirmHousekeepingRebaseline(deps.app, count)))(candidates.length);
		if (!confirmed) return 0;

		// Re-acquire rather than reuse the handle from before the dialog. That
		// dialog is user time and unbounded: a reset of the query index during
		// it closes the database and deletes the file, leaving the handle above
		// pointing at nothing. Waiting for an open modal is not an option --
		// that would hang the reset for as long as the dialog sits there -- so
		// the handle is simply not carried across the decision. This returns the
		// same live handle when nothing happened, and a fresh one when it did.
		//
		// The candidates stay valid across that: they describe the notes and
		// their source, and a reset only discards derived data that reprojection
		// recomputes identically.
		const { db: liveDb } = await deps.openTier2();
		await applyHousekeepingRebaseline(deps.app, liveDb, candidates);
		new Notice(
			`Recorded current fingerprints for ${candidates.length} link${candidates.length === 1 ? '' : 's'}. Status, reviewer, and review date were not changed.`,
		);
		return candidates.length;
	} catch (error) {
		if (error instanceof HousekeepingIndexUpdateError) {
			// The audit fact is recorded in the notes, which are canonical. Only
			// the derived index missed the update, and it rebuilds on its own.
			// Saying "could not record" here would be false, and would invite a
			// second run of an action that already happened.
			new Notice(
				`Baselines were recorded in your notes for ${paths.length} link${paths.length === 1 ? '' : 's'}. `
				+ 'The search index did not pick the change up yet and will catch up on its next rebuild.',
				8000,
			);
			return paths.length;
		}
		new Notice(`Could not record housekeeping baselines: ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}
