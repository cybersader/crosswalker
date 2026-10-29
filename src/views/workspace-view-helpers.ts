/**
 * workspace-view-helpers.ts — pure logic for the Crosswalker workspace view.
 *
 * Kept Obsidian-free so installed-framework discovery can be tested without
 * mocking the plugin API. The caller adapts vault files into `MinimalVaultNode`
 * values and includes the identity facts read from each note's frontmatter.
 */

import { RECIPE_REGISTRY } from '../import/recipe-registry';

export interface MinimalVaultNode {
	path: string;
	name: string;
	/** Present (possibly empty) for folders; absent for files. */
	children?: MinimalVaultNode[];
	/** `_crosswalker.producer.kind`, when this is a Markdown note. */
	producerKind?: string;
	/** Top-level `kind`, which marks relationship notes (junction, edge, mapping set). */
	noteKind?: string;
	/** Canonical ontology identity derived from the note's CURIE prefix. */
	ontologyId?: string;
	/** `_crosswalker.recipe.id`, used only to choose the best display label/action. */
	recipeId?: string;
	/** Number of frontmatter wikilinks in this note. */
	linkCount?: number;
}

export interface InstalledOntologySummary {
	/** Canonical identity shared by every note in this group. */
	id: string;
	/** User-facing label, when a bundled recipe recognizes the identity. */
	name: string;
	noteCount: number;
	linkCount: number;
	/** One exact bundled recipe id, when the generated notes name one. */
	recipeId?: string;
}

/**
 * Tier 1 notes that describe a relationship or a mapping set, not a concept
 * of a framework. They carry a CURIE too, so they are excluded by kind.
 */
export const RELATIONSHIP_NOTE_KINDS: ReadonlySet<string> = new Set(['junction-note', 'crosswalk-edge', 'mapping-set']);

type RecipeIdentity = { id: string; label: string; ontology: string };

/**
 * Derive installed frameworks from note identity, never from folder shape.
 *
 * Every concept note stamped with a Crosswalker producer contributes to the
 * group named by its ontology id (the prefix before `:` in `curie`, populated
 * by the adapter). Any producer counts, not only the plugin: a valid Tier 1
 * producer is first-class (commitment 1), and the import wizard's set
 * discovery already counts every stamped set, so the two surfaces agree.
 * Therefore a flat import whose notes live directly under the output root and
 * a hierarchical import spread across nested folders produce the same summary.
 * Unstamped hand-authored notes, relationship notes, and notes without a
 * usable identity do not register. Underscore-prefixed subtrees remain excluded because they
 * are Crosswalker/internal or protected-corpus storage, not user imports.
 */
export function deriveInstalledOntologies(
	outputRoot: MinimalVaultNode | null | undefined,
	registry: RecipeIdentity[] = RECIPE_REGISTRY,
): InstalledOntologySummary[] {
	if (!outputRoot) return [];
	const notes: MinimalVaultNode[] = [];
	const visit = (node: MinimalVaultNode, isRoot = false): void => {
		if (node.children) {
			if (!isRoot && node.name.startsWith('_')) return;
			for (const child of node.children) visit(child);
			return;
		}
		notes.push(node);
	};
	visit(outputRoot, true);
	return summarizeOntologyNotes(notes, registry);
}

/**
 * The same derivation over a flat list of notes from anywhere in the vault.
 * Whole-vault discovery (status bar, workspace view, graph colors) uses this so
 * the count never depends on the output folder setting: a vault built by the
 * command line or the demo builder puts frameworks wherever its recipe said.
 * Notes inside any underscore-prefixed folder are skipped, matching the
 * subtree rule above.
 */
export function deriveInstalledOntologiesFromNotes(
	notes: readonly MinimalVaultNode[],
	registry: RecipeIdentity[] = RECIPE_REGISTRY,
): InstalledOntologySummary[] {
	return summarizeOntologyNotes(notes.filter((n) => !inUnderscoreFolder(n.path)), registry);
}

function inUnderscoreFolder(path: string): boolean {
	const segments = path.split('/');
	segments.pop();
	return segments.some((s) => s.startsWith('_'));
}

function summarizeOntologyNotes(
	notes: readonly MinimalVaultNode[],
	registry: RecipeIdentity[],
): InstalledOntologySummary[] {
	interface MutableSummary {
		id: string;
		noteCount: number;
		linkCount: number;
		recipeIds: Set<string>;
	}
	const groups = new Map<string, MutableSummary>();

	for (const node of notes) {
		if (!node.name.toLowerCase().endsWith('.md')) continue;
		if (!node.producerKind?.trim()) continue;
		if (node.noteKind && RELATIONSHIP_NOTE_KINDS.has(node.noteKind)) continue;
		const id = node.ontologyId?.trim();
		if (!id) continue;

		let group = groups.get(id);
		if (!group) {
			group = { id, noteCount: 0, linkCount: 0, recipeIds: new Set<string>() };
			groups.set(id, group);
		}
		group.noteCount += 1;
		group.linkCount += node.linkCount ?? 0;
		if (node.recipeId) group.recipeIds.add(node.recipeId);
	}

	return Array.from(groups.values())
		.map((group): InstalledOntologySummary => {
			const recipeId = Array.from(group.recipeIds).sort()[0];
			const recipe = (recipeId ? registry.find((entry) => entry.id === recipeId) : undefined)
				?? registry.find((entry) => entry.ontology === group.id);
			return {
				id: group.id,
				name: recipe?.label ?? group.id,
				noteCount: group.noteCount,
				linkCount: group.linkCount,
				...(recipeId ? { recipeId } : {}),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Identity facts a note's frontmatter carries. Path never participates. */
export interface NoteIdentityFacts {
	producerKind?: string;
	noteKind?: string;
	ontologyId?: string;
	recipeId?: string;
}

function curiePrefix(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const colon = value.indexOf(':');
	return colon > 0 ? value.slice(0, colon) : undefined;
}

/**
 * Read identity from parsed frontmatter: the producer (`_crosswalker.producer.kind`),
 * the note kind (`kind`), the owning framework (the prefix of `curie`, else of
 * `_crosswalker.source_ref.curie`), and the recipe (`_crosswalker.recipe.id`).
 */
export function identityFactsFromFrontmatter(frontmatter: unknown): NoteIdentityFacts {
	if (!frontmatter || typeof frontmatter !== 'object') return {};
	const fm = frontmatter as {
		curie?: unknown;
		kind?: unknown;
		_crosswalker?: {
			producer?: { kind?: unknown };
			source_ref?: { curie?: unknown };
			recipe?: { id?: unknown };
		};
	};
	const producerKind = fm._crosswalker?.producer?.kind;
	const recipeId = fm._crosswalker?.recipe?.id;
	const ontologyId = curiePrefix(fm.curie) ?? curiePrefix(fm._crosswalker?.source_ref?.curie);
	return {
		...(typeof producerKind === 'string' ? { producerKind } : {}),
		...(typeof fm.kind === 'string' ? { noteKind: fm.kind } : {}),
		...(ontologyId ? { ontologyId } : {}),
		...(typeof recipeId === 'string' ? { recipeId } : {}),
	};
}

/** Exact recipe match from canonical identity/provenance, with no path heuristic. */
export function findRecipeForOntologyIdentity(
	ontologyId: string,
	recipeId?: string,
	registry: RecipeIdentity[] = RECIPE_REGISTRY,
): OntologyRecipeMatch | null {
	const match = (recipeId ? registry.find((entry) => entry.id === recipeId) : undefined)
		?? registry.find((entry) => entry.ontology === ontologyId);
	return match ? { id: match.id, label: match.label } : null;
}

/** A recipe recognized as a likely match for an already-installed ontology folder. */
export interface OntologyRecipeMatch {
	id: string;
	label: string;
}

const NORMALIZE = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Legacy best-effort match from a display/folder name to a bundled recipe.
 * New installed-framework discovery uses `findRecipeForOntologyIdentity`;
 * this helper remains for callers that only possess an old folder label.
 */
export function findRecipeForOntologyName(
	folderName: string,
	registry: RecipeIdentity[] = RECIPE_REGISTRY,
): OntologyRecipeMatch | null {
	const target = NORMALIZE(folderName);
	if (!target) return null;

	let best: (OntologyRecipeMatch & { specificity: number }) | null = null;
	for (const entry of registry) {
		const labelCore = entry.label.split('(')[0];
		const candidates = [NORMALIZE(entry.ontology), NORMALIZE(labelCore)];
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (target.includes(candidate) || candidate.includes(target)) {
				if (!best || candidate.length > best.specificity) {
					best = { id: entry.id, label: entry.label, specificity: candidate.length };
				}
			}
		}
	}
	return best ? { id: best.id, label: best.label } : null;
}
