/** Read-only, ephemeral Connections snapshot. Canonical reader alone decides active assertions. */
import type { App } from 'obsidian';
import { readVaultTree, type CrosswalkEdgeRow, type ReadVaultTreeResult } from '../export/vault-reader';
import { buildIdentityIndex, type IdentityIndex } from '../generation/identity-index';
import { discoverImportSets, requireVaultIndexed, VaultStillIndexingError, ImportSetProvenanceError, type DiscoveredImportSet } from '../generation/import-set';
import { readImportSetRecipe } from '../import/import-set-recipes';
import { recipeStampOf } from '../export/recipe-for-note';
import { readMappingSet, type MappingSetRecord } from '../mappings/mapping-set';
import { importSetIdOf } from '../mappings/conversion-marker';
import { classifyImportSet } from '../views/import-set-options';
import { normalizeVaultPath } from '../render/vault-path';
import { wikilinkPath } from '../views/mapping-review-helpers';
import { CROSSWALK_PREDICATE_LABELS, type CrosswalkPredicate } from '../import/mapping/types';

export class ConnectionsError extends Error {
	constructor(message: string, public readonly details?: { cause: string; paths: string[]; action: string }) { super(message); }
}
function unavailable(error: unknown): ConnectionsError {
	const known = error instanceof ImportSetProvenanceError;
	const message = known ? error.message : '';
	let cause = 'A vault record could not be read.', action = 'Check that the vault files are accessible, then try again.';
	if (known) {
		cause = 'Imported-set records are inconsistent or unsupported.';
		action = 'Open the affected files and restore their recorded import metadata from a known-good backup, then try again.';
		if (/both notes and a table|different mapping forms/.test(message)) { cause = 'The same imported set is recorded in conflicting storage forms.'; action = 'Finish or roll back the mapping conversion from the mapping review workflow, then try again.'; }
		else if (/scheme|derivation|nested identity/.test(message)) { cause = 'The imported set uses inconsistent or unsupported identity rules.'; action = 'Update Crosswalker if these files came from a newer version. Otherwise restore the affected files from a known-good backup, then try again.'; }
		else if (/YAML|frontmatter/.test(message)) { cause = 'An imported file has invalid frontmatter.'; action = 'Repair the YAML frontmatter in the affected file or restore it from backup, then try again.'; }
		else if (/mapping tables/.test(message)) { cause = 'More than one table claims the same imported set.'; action = 'Keep the authoritative table for this set and move duplicate copies outside the vault, then try again.'; }
	}
	const paths = known ? error.paths.filter((p) => !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..')) : [];
	return new ConnectionsError('Connections are unavailable. An imported set could not be read. No results are available, and nothing was changed. Try again. If it still fails, open Error details to identify the affected file.', { cause, paths, action });
}
export interface ConnectionsSelection {
	sourceSet: string; targetSet: string; focusCurie?: string; focusSet?: string;
	search?: string; limit?: number; offset?: number;
}
export interface ConnectionSetChoice { id: string; label: string; kind: 'framework' | 'mapping' }
export interface EndpointMember { setId: string; path: string; title: string }
export interface ConnectionEndpoint {
	curie: string; title: string; recordedLabel: string | null; members: EndpointMember[];
	state: 'resolved' | 'ambiguous' | 'absent-from-selected-sets' | 'not-found-in-vault' | 'unreadable-evidence';
	path?: string; setId?: string;
}
export interface ConnectionRow {
	identity: string; owner: string | null; category: 'resolved' | 'unresolved';
	subject: ConnectionEndpoint; object: ConnectionEndpoint;
	predicate: string; gloss: string; modifier: 'NOT' | null; noRelationship: boolean; negative: boolean;
	locator: { kind: 'note' | 'table'; path: string; rowId?: string };
	provenance: Record<string, unknown>; rawFields: Record<string, unknown>;
	diagnostic: string | null;
}
export interface ConnectionsCoverage {
	complete: boolean; assertionsRead: number; junctionNotesNotEvaluated: number;
	mappingExclusions: Array<{ path: string; reason: string }>;
	unclassifiedSkips: Array<{ path: string; reason: string }>;
	metadataWarnings: string[];
}
export interface ConnectionsSnapshot {
	choices: ConnectionSetChoice[]; coverage: ConnectionsCoverage;
	/** Internal query state, never serialized by CLI. */
	app: App; tree: ReadVaultTreeResult; sets: DiscoveredImportSet[];
	indexes: Map<string, Promise<IdentityIndex>>; releases: Map<string, MappingSetRecord | undefined>;
}
export const CONNECTIONS_MEMBERSHIP_TEXT = 'Connects concepts present in these sets.';
export const CONNECTIONS_NATIVE_LIMIT = 'Local graph navigation is not available here. Use the note and assertion links below. Native graph lines are file links, not relationship meanings.';
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const yieldTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new ConnectionsError('This request was cancelled. Choose the sets again to load their connections.'); }

/** Only exact canonical vocabulary gets a gloss; arbitrary namespaces never borrow one. */
export function connectionPredicateGloss(predicate: string): string {
	if (predicate === 'no_relationship') return 'No relationship asserted';
	return Object.prototype.hasOwnProperty.call(CROSSWALK_PREDICATE_LABELS, predicate)
		? CROSSWALK_PREDICATE_LABELS[predicate as CrosswalkPredicate]
		: 'Relationship wording not recorded in this vocabulary';
}

export async function loadConnectionsSnapshot(app: App, signal?: AbortSignal): Promise<ConnectionsSnapshot> {
	check(signal);
	try { await requireVaultIndexed(app); }
	catch (error) {
		if (error instanceof VaultStillIndexingError) throw error;
		throw new ConnectionsError('Vault readiness could not be checked. Try again after checking that this vault is accessible.', { cause: 'The vault readiness check failed.', paths: [], action: 'Reopen the vault, then try again. This failure does not establish whether indexing is complete.' });
	}
	let sets: DiscoveredImportSet[];
	let tree: ReadVaultTreeResult;
	try { sets = await discoverImportSets(app); check(signal); tree = await readVaultTree(app, ''); }
	catch (error) {
		if (error instanceof ConnectionsError) throw error;
		throw unavailable(error);
	}
	check(signal);
	const byPath = new Map([...tree.concepts, ...tree.crosswalkEdges, ...tree.junctionNotes, ...tree.hubs].map((r) => [r.path, r]));
	const mappingExclusions: ConnectionsCoverage['mappingExclusions'] = [];
	const unclassifiedSkips: ConnectionsCoverage['unclassifiedSkips'] = [];
	for (const skipped of tree.skipped) {
		const file = app.vault.getAbstractFileByPath(skipped.path);
		const kind = file ? app.metadataCache.getFileCache(file as never)?.frontmatter?.kind : undefined;
		const attributable = skipped.path.endsWith('.mapping-table.tsv') || kind === 'crosswalk-edge' || /conversion marker|mapping set is being converted/.test(skipped.reason);
		(attributable ? mappingExclusions : unclassifiedSkips).push(skipped);
	}
	const coverage: ConnectionsCoverage = {
		complete: tree.skipped.length === 0, assertionsRead: tree.crosswalkEdges.length,
		junctionNotesNotEvaluated: tree.junctionNotes.length, mappingExclusions, unclassifiedSkips, metadataWarnings: [],
	};
	const releases = new Map<string, MappingSetRecord | undefined>();
	// Cache one metadata read per owner, not one read per assertion. Metadata never adds rows.
	const owners = new Set(tree.crosswalkEdges.map((r) => importSetIdOf(r.frontmatter._crosswalker)).filter((id): id is string => !!id));
	for (const owner of owners) {
		check(signal);
		const set = sets.find((s) => s.id === owner);
		if (!set) continue;
		try { releases.set(owner, await readMappingSet(app, set)); }
		catch { coverage.metadataWarnings.push(`Release metadata for ${owner} could not be read. Inspect that set's release record, then refresh.`); }
	}
	const choices: ConnectionSetChoice[] = [];
	for (const set of sets) {
		const kinds = set.paths.map((p) => byPath.get(p)?.kind ?? (app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(p) as never)?.frontmatter?.kind as string ?? ''));
		const kind = classifyImportSet(set, kinds);
		const release = releases.get(set.id);
		// Presentation only: read verified recipe revisions actually stamped on owned concepts.
		const titles = new Set<string>(), sourceTypes = new Set<string>(), revisions = new Set<string>();
		for (const row of tree.concepts) {
			const stamp = recipeStampOf(row.frontmatter);
			if (stamp.setId !== set.id || !stamp.id || !stamp.digest || revisions.has(stamp.digest)) continue;
			revisions.add(stamp.digest); check(signal);
			const recipe = await readImportSetRecipe(app.vault.adapter, set.id, stamp.digest);
			if (!recipe || recipe.recipe !== stamp.id) continue;
			if (text(recipe.metadata?.title)) titles.add(recipe.metadata!.title!);
			for (const level of recipe.source.levels) if (text(level)) sourceTypes.add(level);
		}
		const name = release?.mapping_set_title ?? (titles.size === 1 ? [...titles][0] : set.ontology) ?? 'Unnamed imported set';
		const detail = sourceTypes.size ? ` · Source types: ${[...sourceTypes].sort(cmp).join(', ')}` : set.recipeIds.length ? ` · Recipes: ${set.recipeIds.join(', ')}` : '';
		const version = release?.mapping_set_version;
		choices.push({ id: set.id, kind, label: `${name}${version ? ` ${version}` : ''}${detail} (${set.id}, ${kind})` });
	}
	choices.sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id));
	return { app, tree, sets, choices, coverage, releases, indexes: new Map() };
}

async function indexFor(snapshot: ConnectionsSnapshot, id: string): Promise<IdentityIndex> {
	let index = snapshot.indexes.get(id);
	if (!index) { index = buildIdentityIndex(snapshot.app, { importSetId: id }); snapshot.indexes.set(id, index); }
	return index;
}
function bounds(selection: ConnectionsSelection): { limit: number; offset: number } {
	const limit = selection.limit ?? 40, offset = selection.offset ?? 0;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ConnectionsError('Page size must be an integer from 1 to 100. Choose a smaller page size.');
	if (!Number.isSafeInteger(offset) || offset < 0) throw new ConnectionsError('Page offset must be a nonnegative integer. Start at offset 0.');
	return { limit, offset };
}

export async function selectConnections(snapshot: ConnectionsSnapshot, selection: ConnectionsSelection, signal?: AbortSignal) {
	check(signal);
	const { limit, offset } = bounds(selection);
	const ids = [...new Set([selection.sourceSet, selection.targetSet])];
	for (const id of ids) if (!snapshot.sets.some((s) => s.id === id)) throw new ConnectionsError('Choose a known source set and target set. Refresh the browser to see available imported sets.');
	if (selection.focusSet && !selection.focusCurie) throw new ConnectionsError('A focus set needs a focal identifier. Choose a focal concept or clear the focus set.');
	if (selection.focusSet && !ids.includes(selection.focusSet)) throw new ConnectionsError('The focus set must be one of the two selected sets. Choose a focal concept in either selected set.');
	const indexes = new Map<string, IdentityIndex>();
	for (const id of ids) { indexes.set(id, await indexFor(snapshot, id)); check(signal); }
	const concepts = new Map(snapshot.tree.concepts.map((r) => [r.path, r]));
	const allCuries = new Set(snapshot.tree.concepts.map((r) => r.curie));
	const memberships = (curie: string): EndpointMember[] => ids.flatMap((id) => {
		const index = indexes.get(id)!;
		// Inspect collisions BEFORE the single-value getter; never pick its first claimant.
		const collision = index.collisions.find((c) => c.curie === curie);
		const paths = collision ? collision.paths : [index.get(curie)?.path].filter((p): p is string => !!p);
		return paths.flatMap((path) => {
			const concept = concepts.get(path), stamp = index.provenanceAt(path);
			if (!concept || concept.curie !== curie || !stamp || stamp === 'unreadable' || stamp.importSetId !== id) return [];
			return [{ setId: id, path, title: concept.title ?? curie }];
		});
	});
	let focusSet = selection.focusSet;
	if (selection.focusCurie) {
		const found = [...new Set(memberships(selection.focusCurie).map((m) => m.setId))];
		if (!focusSet && found.length > 1) throw new ConnectionsError('This focal identifier belongs to both selected sets. Choose its focus set with --focus-set or the disambiguated concept selector.');
		focusSet ??= found[0];
		if (!focusSet || !found.includes(focusSet)) throw new ConnectionsError('The focal identifier is not readable in the chosen focus set. Choose a concept present in a selected set.');
	}
	const shortLinks = new Map<string, string[]>();
	for (const file of snapshot.app.vault.getMarkdownFiles()) { const paths = shortLinks.get(file.basename) ?? []; paths.push(file.path); shortLinks.set(file.basename, paths); }
	const endpoint = (curie: string, label: unknown, link: unknown, edgePath: string): ConnectionEndpoint => {
		let members = memberships(curie);
		// Recorded links are evidence only after verifying the actual target against identity + ownership.
		const recorded = wikilinkPath(text(link) ?? undefined);
		if (recorded) {
			// Do not delegate ambiguous short links to runtime-specific first-match ranking.
			const normalized = normalizeVaultPath(recorded);
			let paths: string[];
			if (normalized.startsWith('./') || normalized.startsWith('../')) {
				const base = edgePath.split('#')[0].split('/'); base.pop();
				let escaped = false;
				for (const piece of normalized.split('/')) {
					if (piece === '..') { if (!base.length) { escaped = true; break; } base.pop(); }
					else if (piece !== '.') base.push(piece);
				}
				paths = escaped ? [] : [base.join('/')];
			} else if (normalized.includes('/')) paths = [normalized];
			else paths = shortLinks.get(normalized.replace(/\.md$/, '')) ?? [];
			paths = paths.map((p) => p.endsWith('.md') ? p : `${p}.md`);
			const valid = paths.length === 1 ? members.filter((m) => m.path === paths[0]) : [];
			if (valid.length === 1) members = valid;
		}
		const state = members.length === 1 ? 'resolved' : members.length > 1 ? 'ambiguous'
			: allCuries.has(curie) ? 'absent-from-selected-sets' : snapshot.coverage.complete ? 'not-found-in-vault' : 'unreadable-evidence';
		return { curie, title: members.length === 1 ? members[0].title : curie, recordedLabel: text(label), members, state };
	};
	const rows: ConnectionRow[] = [];
	for (let i = 0; i < snapshot.tree.crosswalkEdges.length; i++) {
		if (i % 100 === 0) { await yieldTurn(); check(signal); }
		const edge = snapshot.tree.crosswalkEdges[i], fm = edge.frontmatter;
		const subject = endpoint(edge.subject_id, fm.subject_label, fm.subject_note, edge.path);
		const target = endpoint(edge.object_id, fm.object_label, fm.object_note, edge.path);
		if (!subject.members.length && !target.members.length) continue;
		const assignments = subject.members.flatMap((s) => target.members.filter((o) => ids.length === 1 || s.setId !== o.setId).map((o) => ({ s, o })));
		const resolved = assignments.length === 1;
		if (resolved) {
			for (const [e, m] of [[subject, assignments[0].s], [target, assignments[0].o]] as const) {
				e.state = 'resolved'; e.path = m.path; e.setId = m.setId; e.title = m.title;
			}
		} else if (assignments.length > 1) { subject.state = 'ambiguous'; target.state = 'ambiguous'; }
		if (selection.focusCurie && ![subject, target].some((e) => e.curie === selection.focusCurie && (resolved ? e.setId === focusSet : e.members.some((m) => m.setId === focusSet)))) continue;
		const owner = importSetIdOf(fm._crosswalker), release = owner ? snapshot.releases.get(owner) : undefined;
		const noRelationship = edge.predicate_id === 'no_relationship';
		const modifier = edge.predicate_modifier ?? null;
		const hash = edge.path.lastIndexOf('.mapping-table.tsv#');
		const locator: ConnectionRow['locator'] = hash < 0 ? { kind: 'note', path: edge.path }
			: { kind: 'table', path: edge.path.slice(0, hash + '.mapping-table.tsv'.length), rowId: edge.path.slice(hash + '.mapping-table.tsv#'.length) };
		rows.push({
			identity: edge.curie, owner, category: resolved ? 'resolved' : 'unresolved', subject, object: target,
			predicate: edge.predicate_id, gloss: connectionPredicateGloss(edge.predicate_id), modifier, noRelationship,
			negative: modifier === 'NOT' || noRelationship, locator,
			provenance: provenanceOf(edge, release), rawFields: rawFieldsOf(edge),
			diagnostic: resolved ? null : assignments.length > 1 ? 'Ambiguous identity or membership assignment. Inspect the endpoint records; no note was chosen.' : 'One selected endpoint is present, but the opposite membership cannot be established for this pair.',
		});
	}
	rows.sort((a, b) => cmp(JSON.stringify([a.identity, a.owner, a.provenance.mapping_set_id, a.provenance.mapping_set_version, a.subject.curie, a.predicate, a.modifier, a.object.curie]), JSON.stringify([b.identity, b.owner, b.provenance.mapping_set_id, b.provenance.mapping_set_version, b.subject.curie, b.predicate, b.modifier, b.object.curie])) || cmp(JSON.stringify(a.locator), JSON.stringify(b.locator)));
	const needle = selection.search?.trim().toLocaleLowerCase() ?? '';
	const filtered = needle ? rows.filter((r) => recordedSearchValues([r.identity, r.owner, r.subject.curie, r.subject.title, r.subject.recordedLabel, r.object.curie, r.object.title, r.object.recordedLabel, r.predicate, r.modifier, ...PROVENANCE_KEYS.map((key) => r.provenance[key]), r.provenance.sssom_predicate, r.provenance.source_ref]).some((value) => value.toLocaleLowerCase().includes(needle))) : rows;
	return { selection: { ...selection, focusSet, limit, offset }, membershipMeaning: CONNECTIONS_MEMBERSHIP_TEXT,
		totals: counts(rows), filteredTotals: counts(filtered), coverage: snapshot.coverage,
		rows: filtered.slice(offset, offset + limit), hasMore: offset + limit < filtered.length,
		emptyMessage: filtered.length ? null : 'No readable matching assertions found. Check the selected sets and coverage below.', nativeGraph: { available: false, message: CONNECTIONS_NATIVE_LIMIT },
	};
}
function counts(rows: ConnectionRow[]) {
	const resolved = rows.filter((r) => r.category === 'resolved');
	return { assertions: rows.length, resolved: resolved.length, unresolved: rows.length - resolved.length,
		positive: resolved.filter((r) => !r.negative).length, negative: resolved.filter((r) => r.negative).length,
		/** These counters overlap. `negative` is the union, never their sum. */
		not: resolved.filter((r) => r.modifier === 'NOT').length, noRelationship: resolved.filter((r) => r.noRelationship).length };
}
function rawFieldsOf(edge: CrosswalkEdgeRow): Record<string, unknown> {
	const keys = ['curie', 'subject_id', 'predicate_id', 'predicate_modifier', 'object_id', 'sssom_predicate', 'subject_label', 'object_label', 'subject_note', 'object_note', 'mapping_set_id', 'mapping_set_version', 'mapping_provider', 'mapping_justification', 'review_status', 'source_ref'];
	return Object.fromEntries(keys.filter((k) => edge.frontmatter[k] !== undefined).map((k) => [k, edge.frontmatter[k]]));
}
const PROVENANCE_KEYS = ['mapping_provider', 'mapping_justification', 'mapping_set_id', 'mapping_set_version', 'mapping_set_title', 'mapping_set_description', 'subject_source', 'subject_source_version', 'object_source', 'object_source_version', 'review_status', 'mapping_date', 'creator_id'];
/** Values, not JSON keys or generated explanations, are searchable evidence. */
function recordedSearchValues(value: unknown): string[] {
	if (typeof value === 'string') return value.trim() ? [value] : [];
	if (typeof value === 'number') return [String(value)];
	if (Array.isArray(value)) return value.flatMap(recordedSearchValues);
	if (value && typeof value === 'object') return Object.values(value).flatMap(recordedSearchValues);
	return [];
}
function provenanceOf(edge: CrosswalkEdgeRow, release?: MappingSetRecord): Record<string, unknown> {
	const fm = edge.frontmatter, provenance = object(fm._crosswalker);
	const rowId = text(fm.mapping_set_id), rowVersion = text(fm.mapping_set_version);
	const sameId = !!rowId && rowId === release?.mapping_set_id;
	const releaseConflict = !!release && !!rowId && (!sameId || !!rowVersion && !!release.mapping_set_version && rowVersion !== release.mapping_set_version);
	const associated = sameId && !releaseConflict;
	const ownerRelease = release ? Object.fromEntries(PROVENANCE_KEYS.filter((k) => (release as unknown as Record<string, unknown>)[k] !== undefined).map((k) => [k, (release as unknown as Record<string, unknown>)[k]])) : null;
	const fieldConflicts = associated ? PROVENANCE_KEYS.filter((k) => fm[k] !== undefined && ownerRelease?.[k] !== undefined && JSON.stringify(fm[k]) !== JSON.stringify(ownerRelease[k])) : [];
	return { ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, fm[k] ?? (associated ? ownerRelease?.[k] : undefined) ?? null])),
		owner_release: ownerRelease, release_association: associated ? 'matching-recorded-identity' : releaseConflict ? 'conflicting-release-declarations' : rowId ? 'no-associated-release-record' : 'row-release-identity-not-recorded',
		release_conflict: releaseConflict || fieldConflicts.length > 0, conflicting_fields: fieldConflicts,
		sssom_predicate: text(fm.sssom_predicate), source_ref: fm.source_ref ?? provenance.source_ref ?? null,
		classification: 'Synthetic/publisher status not recorded.', verification: 'Recorded provenance, not independently verified.' };
}
