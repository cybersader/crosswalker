/**
 * vault-reader.ts — v0.1.7 exporters, the read half of round-trip.
 *
 * Walks a chosen vault folder and reconstructs the canonical Tier 1 rows
 * (per spec/tier1.schema.json) from whatever Crosswalker (or any other
 * Tier-1-conformant producer, per the schema-as-primitive commitment —
 * see .claude/CLAUDE.md "v0.1 architectural commitments" #1) already wrote
 * there. This is deliberately the mirror image of the import path: import
 * turns external data into Tier 1 notes; this turns Tier 1 notes back into
 * structured rows that the exporters in this folder serialize to a wire
 * format (SSSOM TSV, plain CSV, STRM/OLIR TSV, ...).
 *
 * Frontmatter read strategy mirrors `producerKindOf` in
 * src/views/workspace-view.ts: prefer `app.metadataCache.getFileCache()`
 * (fast, already-parsed), falling back to a direct `cachedRead` + regex +
 * `parseYaml` when the cache hasn't resolved yet (observed lag right after
 * bulk `vault.create()` batches — see that file's doc comment for the
 * concrete repro). Never throws on an unreadable/malformed note; such notes
 * land in `skipped` with a reason instead, so one bad file never aborts an
 * export.
 *
 * Classification follows spec/tier1.schema.json's own discriminator: a
 * note's `kind` field selects the crosswalk-edge / junction-note branch;
 * absent `kind` is a concept note. `kind: 'hub'` and `kind: 'facet'` are
 * Crosswalker-specific extensions (src/generation/enrich.ts's synthetic
 * hierarchy-MOC and facet-membership notes) layered on top of the same
 * `additionalProperties: true` concept-note shape — they get their own
 * bucket here because they're graph scaffolding, not source-of-truth rows,
 * and most exporters should skip them.
 */

import type { App, TFile } from 'obsidian';
import { parseYaml } from 'obsidian';
import { normalizeMappingSetId, readStoredPredicateModifier } from '../utils/mapping-provenance';

export type VaultNoteKind = 'concept' | 'crosswalk-edge' | 'junction-note' | 'hub' | 'facet';

/** A skipped file + why. Never fatal — export continues past bad notes. */
export interface SkippedNote {
	path: string;
	reason: string;
}

/** Reconstructed concept-note row (spec's `concept_note_frontmatter`). */
export interface ConceptRow {
	kind: 'concept';
	path: string;
	curie: string;
	title?: string;
	aliases: string[];
	tags: string[];
	/** Wikilink target(s), string or array (polyhierarchy) — verbatim from frontmatter. */
	parent?: string | string[];
	parent_curie?: string;
	children: string[];
	/** Full raw frontmatter (incl. recipe-specific domain fields), minus nothing — callers pick what they need. */
	frontmatter: Record<string, unknown>;
}

/** Reconstructed crosswalk-edge row (spec's `crosswalk_edge_frontmatter`). */
export interface CrosswalkEdgeRow {
	kind: 'crosswalk-edge';
	path: string;
	curie: string;
	subject_id: string;
	predicate_id: string;
	object_id: string;
	mapping_set_id?: string;
	predicate_modifier?: 'NOT';
	match_type?: string;
	match_confidence?: number;
	mapping_justification?: string;
	mapping_provider?: string;
	mapping_date?: string;
	creator_id?: string;
	review_status?: string;
	tags: string[];
	frontmatter: Record<string, unknown>;
}

/** Reconstructed junction-note row (spec's `junction_note_frontmatter`, the evidence-link shape). */
export interface JunctionNoteRow {
	kind: 'junction-note';
	path: string;
	curie: string;
	subject: string;
	subject_curie?: string;
	predicate: string;
	object: string;
	object_curie?: string;
	coverage?: string;
	reviewer?: string;
	review_date?: string;
	status?: string;
	confidence?: number;
	scope?: string;
	expires_at?: string;
	notes?: string;
	tags: string[];
	frontmatter: Record<string, unknown>;
}

/** Synthetic hierarchy/facet hub notes (src/generation/enrich.ts). Not part of Tier 1's discriminator but common in real vaults. */
export interface HubRow {
	kind: 'hub' | 'facet';
	path: string;
	curie: string;
	tags: string[];
	/** `children` (hub) or `members` (facet) — normalized to one field. */
	children: string[];
	frontmatter: Record<string, unknown>;
}

export type VaultRow = ConceptRow | CrosswalkEdgeRow | JunctionNoteRow | HubRow;

export interface ReadVaultTreeResult {
	concepts: ConceptRow[];
	crosswalkEdges: CrosswalkEdgeRow[];
	junctionNotes: JunctionNoteRow[];
	hubs: HubRow[];
	skipped: SkippedNote[];
}

/** Strip a leading/trailing slash so folder-path comparisons are exact. */
function normalizeFolderPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/g, '').replace(/^\/+/, '');
}

/**
 * Every markdown file under `rootPath` (inclusive of the root itself, for the
 * degenerate case of a single note passed as "folder"), sorted by path for
 * determinism. `rootPath: ''` scopes to the whole vault.
 *
 * Uses `vault.getMarkdownFiles()` + a path-prefix filter rather than walking
 * `TFolder.children` — this is deliberately identical to the filter
 * `VaultImportFilePicker` uses for the importable-files list (src/ui/
 * vault-file-picker.ts), which sidesteps any question of whether a TFolder's
 * `children` array is fully populated, and works uniformly against both the
 * real Obsidian vault and a flat mock vault in tests.
 */
export function listMarkdownFilesUnder(app: App, rootPath: string): TFile[] {
	const root = normalizeFolderPath(rootPath);
	const all = app.vault.getMarkdownFiles();
	const inScope = root === '' ? all : all.filter((f) => f.path === root || f.path.startsWith(`${root}/`));
	return [...inScope].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * AM-26 (2026-08-31). What a read of one note's properties actually found.
 *
 * Three answers, never two. `none` is a FACT about the file: it has no
 * properties block, so it carries no title, no curie, and no marker, and a
 * caller may say so. `unreadable` is the ABSENCE of a fact: the bytes would not
 * read, or the block is there and will not parse, so nothing at all is known.
 *
 * Failure mode prevented: a caller telling a user "Crosswalker did not generate
 * this note. Move or rename it." about a note Crosswalker did generate and a
 * hand edit damaged. That is a false cause attached to a destructive
 * instruction. Same rule as `identity-index.ts`'s `AddressStamp` and
 * `generation-engine`'s `unreadable` refusal, and the same rule as
 * `project_cache_lag_is_not_absence` one level up.
 */
export type NoteFrontmatterRead =
	| { state: 'ok'; frontmatter: Record<string, unknown> }
	| { state: 'none' }
	| { state: 'unreadable' };

/**
 * One note's frontmatter, distinguishing "has none" from "could not be read".
 * See the module doc comment for the cache-then-fallback strategy (mirrors
 * `producerKindOf` in src/views/workspace-view.ts).
 */
export async function readNoteFrontmatterState(app: App, file: TFile): Promise<NoteFrontmatterRead> {
	const cached = app.metadataCache?.getFileCache?.(file)?.frontmatter;
	if (cached && Object.keys(cached).length > 0) {
		return { state: 'ok', frontmatter: cached as unknown as Record<string, unknown> };
	}

	let content: string;
	try {
		const reader = app.vault.cachedRead ? app.vault.cachedRead.bind(app.vault) : app.vault.read.bind(app.vault);
		content = await reader(file);
	} catch {
		return { state: 'unreadable' };
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return { state: 'none' };
	try {
		const parsed = parseYaml(match[1]) as unknown;
		if (parsed === null || parsed === undefined) return { state: 'none' };
		// A YAML document that is not a mapping is a properties block nothing can be
		// read out of, which is a failure to read, not an absence of properties.
		if (typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable' };
		return { state: 'ok', frontmatter: parsed as Record<string, unknown> };
	} catch {
		return { state: 'unreadable' };
	}
}

/**
 * One note's frontmatter, or null if it can't be read/parsed.
 *
 * Two-state convenience over `readNoteFrontmatterState`, for callers whose next
 * step is the same either way (they need values, and there are none). A caller
 * that TELLS THE USER A CAUSE must use the tri-state read instead: null here
 * cannot distinguish a stranger's plain note from a damaged note of our own.
 */
export async function readNoteFrontmatter(app: App, file: TFile): Promise<Record<string, unknown> | null> {
	const read = await readNoteFrontmatterState(app, file);
	return read.state === 'ok' ? read.frontmatter : null;
}

/** Discriminate a note's Tier 1 kind from its frontmatter (see module doc comment). */
export function classifyFrontmatterKind(fm: Record<string, unknown>): VaultNoteKind {
	const kind = typeof fm.kind === 'string' ? fm.kind : undefined;
	if (kind === 'crosswalk-edge') return 'crosswalk-edge';
	if (kind === 'junction-note') return 'junction-note';
	if (kind === 'hub') return 'hub';
	if (kind === 'facet') return 'facet';
	return 'concept';
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number.parseFloat(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
	if (typeof v === 'string' && v.length > 0) return [v];
	return [];
}

/**
 * Walk `rootPath` and bucket every note by Tier 1 kind. Never throws — a note
 * missing frontmatter, missing `curie`, or missing its kind's required fields
 * lands in `skipped` with a human-readable reason instead of aborting the
 * whole export. Every bucket is sorted by path (matches the file-list sort),
 * so exporters built on top of this are deterministic without re-sorting.
 */
export async function readVaultTree(app: App, rootPath: string): Promise<ReadVaultTreeResult> {
	const result: ReadVaultTreeResult = {
		concepts: [],
		crosswalkEdges: [],
		junctionNotes: [],
		hubs: [],
		skipped: [],
	};

	const files = listMarkdownFilesUnder(app, rootPath);
	for (const file of files) {
		const fm = await readNoteFrontmatter(app, file);
		if (!fm) {
			result.skipped.push({ path: file.path, reason: 'no parsable YAML frontmatter block' });
			continue;
		}
		const curie = asString(fm.curie);
		if (!curie) {
			result.skipped.push({ path: file.path, reason: 'missing required `curie` field (not a Tier 1 note)' });
			continue;
		}

		const kind = classifyFrontmatterKind(fm);
		const tags = asStringArray(fm.tags);

		if (kind === 'crosswalk-edge') {
			const subject_id = asString(fm.subject_id);
			const predicate_id = asString(fm.predicate_id);
			const object_id = asString(fm.object_id);
			let predicateModifier: '' | 'NOT';
			try {
				predicateModifier = readStoredPredicateModifier(fm);
			} catch (error) {
				result.skipped.push({
					path: file.path,
					reason: error instanceof Error ? error.message : 'invalid explicit predicate_modifier',
				});
				continue;
			}
			if (!subject_id || !predicate_id || !object_id) {
				result.skipped.push({
					path: file.path,
					reason: 'crosswalk-edge note missing one of subject_id/predicate_id/object_id',
				});
				continue;
			}
			result.crosswalkEdges.push({
				kind: 'crosswalk-edge',
				path: file.path,
				curie,
				subject_id,
				predicate_id,
				object_id,
				mapping_set_id:
					typeof fm.mapping_set_id === 'string'
						? normalizeMappingSetId(fm.mapping_set_id) || undefined
						: undefined,
				predicate_modifier: predicateModifier || undefined,
				match_type: asString(fm.match_type),
				match_confidence: asNumber(fm.match_confidence),
				mapping_justification: asString(fm.mapping_justification),
				mapping_provider: asString(fm.mapping_provider),
				mapping_date: asString(fm.mapping_date),
				creator_id: asString(fm.creator_id),
				review_status: asString(fm.review_status),
				tags,
				frontmatter: fm,
			});
			continue;
		}

		if (kind === 'junction-note') {
			const subject = asString(fm.subject);
			const predicate = asString(fm.predicate);
			const object = asString(fm.object);
			if (!subject || !predicate || !object) {
				result.skipped.push({
					path: file.path,
					reason: 'junction-note missing one of subject/predicate/object',
				});
				continue;
			}
			result.junctionNotes.push({
				kind: 'junction-note',
				path: file.path,
				curie,
				subject,
				subject_curie: asString(fm.subject_curie),
				predicate,
				object,
				object_curie: asString(fm.object_curie),
				coverage: asString(fm.coverage),
				reviewer: asString(fm.reviewer),
				review_date: asString(fm.review_date),
				status: asString(fm.status),
				confidence: asNumber(fm.confidence),
				scope: asString(fm.scope),
				expires_at: asString(fm.expires_at),
				notes: asString(fm.notes),
				tags,
				frontmatter: fm,
			});
			continue;
		}

		if (kind === 'hub' || kind === 'facet') {
			result.hubs.push({
				kind,
				path: file.path,
				curie,
				tags,
				children: asStringArray(fm.children ?? fm.members),
				frontmatter: fm,
			});
			continue;
		}

		// concept (default branch — absent/other `kind`, per the spec's discriminator).
		result.concepts.push({
			kind: 'concept',
			path: file.path,
			curie,
			title: asString(fm.title),
			aliases: asStringArray(fm.aliases),
			tags,
			parent: Array.isArray(fm.parent) ? asStringArray(fm.parent) : asString(fm.parent),
			parent_curie: asString(fm.parent_curie),
			children: asStringArray(fm.children),
			frontmatter: fm,
		});
	}

	return result;
}
