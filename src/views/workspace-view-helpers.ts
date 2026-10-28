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

	interface MutableSummary {
		id: string;
		noteCount: number;
		linkCount: number;
		recipeIds: Set<string>;
	}
	const groups = new Map<string, MutableSummary>();

	const visit = (node: MinimalVaultNode, isRoot = false): void => {
		if (node.children) {
			if (!isRoot && node.name.startsWith('_')) return;
			for (const child of node.children) visit(child);
			return;
		}
		if (!node.name.toLowerCase().endsWith('.md')) return;
		if (!node.producerKind?.trim()) return;
		if (node.noteKind && RELATIONSHIP_NOTE_KINDS.has(node.noteKind)) return;
		const id = node.ontologyId?.trim();
		if (!id) return;

		let group = groups.get(id);
		if (!group) {
			group = { id, noteCount: 0, linkCount: 0, recipeIds: new Set<string>() };
			groups.set(id, group);
		}
		group.noteCount += 1;
		group.linkCount += node.linkCount ?? 0;
		if (node.recipeId) group.recipeIds.add(node.recipeId);
	};
	visit(outputRoot, true);

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
