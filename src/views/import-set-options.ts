/**
 * import-set-options.ts — the choices behind a query parameter of type
 * `import-set` (recipe SchemaVer 1.19.0).
 *
 * A shipped query template filters on one imported set's minted id
 * (`note._crosswalker.import_set.id`), never on a folder path. This module
 * answers "which sets can the user pick, and what do we call them?":
 *
 *   - `classifyImportSet` decides framework vs mapping set from identity only:
 *     a producing parent set stamped on the notes, or notes whose `kind` is a
 *     relationship kind (crosswalk edge, junction, mapping set release record).
 *     The relationship-kind rule is the one the workspace view already uses to
 *     keep relationship notes out of installed frameworks.
 *   - `buildImportSetOptions` is pure: it filters by kind, drops sets Bases
 *     cannot see (a table-form mapping set owns no notes), labels each set in
 *     plain words, and preselects only when exactly one candidate exists
 *     (chosen, never guessed).
 *   - `loadImportSetChoices` is the vault-facing wrapper. A vault Obsidian has
 *     not finished indexing is reported as indexing, never as empty.
 */

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import {
	discoverImportSets,
	settleVaultIndex,
	VaultStillIndexingError,
	VAULT_STILL_INDEXING_MESSAGE,
	type DiscoveredImportSet,
} from '../generation/import-set';
import { notesPhrase, runSetDisplayName } from '../import/recipe-runs';
import { RELATIONSHIP_NOTE_KINDS } from './workspace-view-helpers';

export type ImportSetKind = 'framework' | 'mapping';

/** The facts the option builder reads from one discovered set. */
export type ImportSetFacts = Pick<
	DiscoveredImportSet,
	'id' | 'noteCount' | 'mapping_form' | 'root' | 'ontology' | 'ontologyPrefixes' | 'parent_set' | 'parentSets'
>;

/** A discovered set plus the distinct `kind` values its notes carry. */
export interface ClassifiedImportSet {
	set: ImportSetFacts;
	kind: ImportSetKind;
}

export interface ImportSetOption {
	/** The minted set id: what the template filters on. Never shown as the label. */
	id: string;
	/** Plain label, e.g. `nist-mini (8 notes)`. */
	label: string;
}

export interface ImportSetOptions {
	options: ImportSetOption[];
	/** The id to select up front: only when exactly one candidate exists. */
	preselect: string | null;
}

export type ImportSetChoices =
	| { state: 'ready'; options: ImportSetOption[]; preselect: string | null }
	| { state: 'indexing'; message: string };

/**
 * Framework or mapping set, from identity only. `noteKinds` are the distinct
 * frontmatter `kind` values of the set's notes (concept notes carry none).
 */
export function classifyImportSet(set: ImportSetFacts, noteKinds: Iterable<string>): ImportSetKind {
	if (set.parent_set || (set.parentSets && set.parentSets.length > 0)) return 'mapping';
	for (const kind of noteKinds) {
		if (RELATIONSHIP_NOTE_KINDS.has(kind)) return 'mapping';
	}
	return 'framework';
}

/** The empty-state sentence for a kind with no candidates. */
export function noImportSetMessage(kind: ImportSetKind): string {
	return kind === 'mapping'
		? 'No imported mapping sets yet. Import a crosswalk first, then create this query.'
		: 'No imported frameworks yet. Import one first, then create this query.';
}

/** The parameter's row label in the editor. */
export function importSetParamLabel(kind: ImportSetKind): string {
	return kind === 'mapping' ? 'Mapping set' : 'Framework';
}

function baseName(set: ImportSetFacts, kind: ImportSetKind): string {
	const name = runSetDisplayName(set);
	// runSetDisplayName's last resort names the internal concept; say it plainly.
	if (name === 'an import set') return kind === 'mapping' ? 'Unnamed mapping set' : 'Unnamed framework';
	return name;
}

/**
 * Pure. Candidates of `kind`, labelled, sorted by label, with a preselect only
 * when there is exactly one. Sets Bases cannot query (a table-form mapping set,
 * or any set that owns no notes) are not offered.
 */
export function buildImportSetOptions(sets: ClassifiedImportSet[], kind: ImportSetKind): ImportSetOptions {
	const candidates = sets
		.filter((c) => c.kind === kind)
		.filter((c) => c.set.mapping_form !== 'table' && c.set.noteCount > 0)
		.map((c) => ({ set: c.set, name: baseName(c.set, kind) }));

	// Two sets with the same name (two releases under one folder name) get the
	// fuller root path; if that still collides, the id goes last as a tiebreak.
	const nameCounts = new Map<string, number>();
	for (const c of candidates) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
	const labelled = candidates.map((c) => {
		let name = c.name;
		if ((nameCounts.get(name) ?? 0) > 1 && c.set.root) name = c.set.root;
		return { set: c.set, name };
	});
	const fullCounts = new Map<string, number>();
	for (const c of labelled) fullCounts.set(c.name, (fullCounts.get(c.name) ?? 0) + 1);

	const options = labelled
		.map((c) => {
			const tail = (fullCounts.get(c.name) ?? 0) > 1 ? `, ${c.set.id}` : '';
			return { id: c.set.id, label: `${c.name} (${notesPhrase(c.set.noteCount)}${tail})` };
		})
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

	return { options, preselect: options.length === 1 ? options[0].id : null };
}

/** Distinct frontmatter `kind` values across a set's notes, read from the metadata cache. */
function noteKindsOf(app: App, set: DiscoveredImportSet): Set<string> {
	const kinds = new Set<string>();
	for (const path of set.paths) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		const kind: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.kind;
		if (typeof kind === 'string') {
			kinds.add(kind);
			if (RELATIONSHIP_NOTE_KINDS.has(kind)) break;
		}
	}
	return kinds;
}

/**
 * The choices for one `import-set` parameter. Waits briefly for Obsidian to
 * finish indexing; if it has not, says so rather than offering an empty list.
 */
export async function loadImportSetChoices(app: App, kind: ImportSetKind): Promise<ImportSetChoices> {
	try {
		if (await settleVaultIndex(app) > 0) {
			return { state: 'indexing', message: VAULT_STILL_INDEXING_MESSAGE };
		}
		const sets = await discoverImportSets(app);
		const classified = sets.map((set) => ({ set, kind: classifyImportSet(set, noteKindsOf(app, set)) }));
		const { options, preselect } = buildImportSetOptions(classified, kind);
		return { state: 'ready', options, preselect };
	} catch (err) {
		if (err instanceof VaultStillIndexingError) {
			return { state: 'indexing', message: err.message };
		}
		throw err;
	}
}
