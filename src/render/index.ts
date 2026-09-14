/**
 * render() — pure function from (Recipe, ConceptIdentity) to Address.
 *
 * Per Ch 22 (target-structure expressivity synthesis):
 *   - Pass 1: vault-independent. Deterministic. Hashable. Same input → byte-
 *     identical output every time.
 *   - Pass 2 (link minimizer with VaultIndex): deferred to v0.3.
 *
 * v0.1.2 wires three of the five mechanisms: folder, file, heading.
 * tag and wikilink (as layout mechanisms) are schema-reserved with
 * fail-fast errors.
 *
 * Cross-cutting `also_emit` (tags, aliases, managed frontmatter) IS wired —
 * those emit on every note regardless of layout mechanism choice.
 */

import type { ConceptIdentity, Address, RenderReport, VariadicConfig, LayoutValue } from './types';
import { renderTemplate, renderTemplateValue, RenderError } from './template';
import { renderBodyProjection, type BodyProjection } from './body';
import { applyFolder, applyVariadicFolder } from './mechanisms/folder';
import { applyFile } from './mechanisms/file';
import { applyHeading } from './mechanisms/heading';
import { applyTagStub } from './mechanisms/tag';
import { applyWikilinkStub } from './mechanisms/wikilink';

export type {
	Address,
	ConceptIdentity,
	SourceScope,
	RenderNote,
	RenderedBodyRegion,
	RenderNoteCode,
	RenderReport,
	VariadicConfig,
	LayoutValue,
} from './types';
export { RenderError } from './template';
export { renderTemplate, renderTemplateValue } from './template';
export { formatBodyValue, renderBodyProjection, type BodyFormat, type BodyProjection } from './body';
export {
	summarizeRenderNotes,
	DEFAULT_MAX_RENDER_NOTE_DETAILS,
	type PreviewRowNotes,
	type RenderNoteDetail,
	type RenderNoteSummary,
} from './summarize-render-notes';

/**
 * The recipe shape we accept. Loose typing here matches the runtime contract
 * (recipes come from parsed YAML/JSON; AJV validates them upstream against
 * spec/recipe.schema.json). Internal modules use the same shape.
 */
export type Tier1Kind = 'concept' | 'junction-note' | 'crosswalk-edge';

export interface Recipe {
	recipe: string;
	metadata?: {
		title?: string;
		description?: string;
		based_on?: { recipe: string; hash?: string; spec_version?: string };
	};
	source?: {
		ontology?: string;
		version?: string;
		levels?: string[];
		/**
		 * Optional JSONata row predicate (schema SchemaVer 1.9.0, Ch 46 source
		 * contract §3). A row for which it is false never becomes a note. Runs
		 * BEFORE identity, curie minting, concept_cid and render(), and enters
		 * the recipe hash because it changes which notes exist. render() itself
		 * never reads it: by the time render() runs, the row already survived.
		 */
		where?: string;
		/**
		 * Optional keyed lookup enrichment (schema SchemaVer 1.9.0, Ch 46 source
		 * contract 4). Each alias names a secondary collection inside the SAME
		 * source bytes, indexed by a key expression; a matching row binds under
		 * the alias and nowhere else. Runs after `where`, before identity, and
		 * enters the recipe hash for the same reason `where` does.
		 *
		 * render() needs no knowledge of it: by the time render() runs the alias
		 * is an ordinary nested value on the row, reached by traversal that
		 * already existed. That is the whole point of the no-merge collision
		 * policy.
		 */
		joins?: Record<string, {
			from: { sheet?: string; header_row?: number; iterator?: string; where?: string };
			on: { primary: string; secondary: string };
			cardinality: 'one' | 'many';
			select?: string[];
		}>;
	};
	target: {
		layout: Array<{
			level: string;
			mechanism: string;
			template: string;
			level_depth?: number;
			kind?: Tier1Kind;
			/** Variable-depth folder expansion — valid on `mechanism: "folder"` only. */
			variadic?: VariadicConfig;
		}>;
		also_emit?: {
			tags?: string[];
			aliases?: string[];
			frontmatter?: {
				managed?: Record<string, string>;
				/**
				 * List-valued managed wikilink arrays (schema `managed_links`,
				 * SchemaVer 1.3.0). Each key's template is rendered to a scalar,
				 * split on `split` (default comma/semicolon), and each non-empty
				 * piece is wrapped in `[[...]]`; the key emits as an array. Empty
				 * results omit the key. Used for multi-value link columns.
				 */
				managed_links?: Record<string, { template: string; split?: string[] }>;
				user_preserve?: string[];
			};
			/** Ordered canonical body projections evaluated by pure render(). */
			body?: BodyProjection[];
		};
		graph_edges?: Array<{ from: string; via: string; to: string }>;
		/**
		 * Engine automatic-H1 control (schema `target.auto_heading`, SchemaVer
		 * 1.8.0). A template string sets the heading text (rendered against row
		 * scope); `false` suppresses the heading; absent keeps the historical
		 * engine behaviour byte-for-byte. render() ignores it — it is consumed by
		 * resolveAutoHeadingText() in src/generation/generation-engine.ts, which
		 * both generation paths call. It lives on `target` (not `also_emit`) so
		 * patchOwnedRegions' wholesale `also_emit` replacement preserves it
		 * through a workbench round trip for free.
		 */
		auto_heading?: string | false;
		linkStyle?: 'absolute' | 'shortest';
		/** Batch-scope Pass 1.5 enrichment (schema `enrichment`, SchemaVer 1.3.0).
		 *  render() ignores it — it is consumed by the post-render enrichment pass
		 *  (src/generation/enrich.ts). Carried here so the recipe stays the single
		 *  contract. */
		enrichment?: RecipeEnrichment;
	};
}

/** The `target.enrichment` block (see spec/recipe.schema.json $defs/enrichment). */
export interface RecipeEnrichment {
	children_lists?: boolean;
	facet_notes?: 'none' | 'tags-only' | 'notes';
	parent_note?: 'sibling' | 'folder-note';
	hub_note_folder?: string;
	/**
	 * Hierarchy hub / MOC notes (SchemaVer 1.4.0, 2026-07-11 ICSB audit gap #1).
	 * `'notes'`: every folder level in the generated structure gets an index
	 * note derived from the model (see src/generation/enrich.ts's step 4.5).
	 * Default `'none'`.
	 */
	level_hubs?: 'none' | 'notes';
	/**
	 * Also append the `%% Waypoint %%` trigger comment to every folder-note /
	 * hub note this import generates (SchemaVer 1.4.0). Opt-in, additive to
	 * `level_hubs` — Crosswalker's own managed section stays the primary
	 * mechanism; this lets the Waypoint community plugin additionally track
	 * notes a user later adds to the folder by hand. Default `false`.
	 */
	waypoint_marker?: boolean;
}

/**
 * Pass-1 render. Produces an Address from `(recipe, identity)` only — vault-
 * independent. Determinism is the architectural commitment that makes
 * canonical-state hashing (Ch 22 §8) work.
 *
 * Throws `RenderError` for: unknown mechanism, missing template variable,
 * malformed filter, heading without level_depth, tag/wikilink as layout level
 * (deferred to v0.2).
 *
 * `report` (optional): when provided, per-row deviations (skipped folder
 * levels, split/regex fallbacks) are recorded into it. Purely observational —
 * output is byte-identical with or without it.
 *
 * `layoutValues` (optional, AM-33 / AM-37): when provided, every DIRECTORY
 * SEGMENT of `address.primary.path` is appended to it, in order, as the segment
 * is produced — by a folder mechanism (fixed or variadic), by a literal
 * separator inside a folder template, or by the directory prefix of a file
 * template. The guarantee is byte-level and load-bearing: after render, the
 * k-th entry's `value` is byte-identical to the k-th segment of the rendered
 * directory, and the list is exactly as long as that directory is deep. A
 * consumer can therefore compare the two, and a disagreement is a bug rather
 * than a case to fall back on. Also purely observational — the Address is
 * byte-identical with or without it, so nothing hashed or asserted about
 * render's output changes shape.
 *
 * Failure mode prevented: a consumer that needs to know what a folder level was
 * ABOUT going back to `dirname(finalPath)` to find out. Parsing a path to
 * recover the facts that built it is a guess, and hub identity was built on that
 * guess (adversarial pass 12, CONFIRMED 1). The facts are handed over here
 * instead, at the one moment they are known for certain.
 */
export function render(
	recipe: Recipe,
	identity: ConceptIdentity,
	report?: RenderReport,
	layoutValues?: LayoutValue[],
): Address {
	const address: Address = {
		primary: { path: '' },
		wikilinkTarget: '',
		tags: [],
		aliases: [],
		body: [],
		frontmatter: {},
	};

	// 1. Walk layout entries in order, dispatching per mechanism
	for (const entry of recipe.target.layout) {
		// `variadic` is a folder-only knob (heading/tag variants deferred).
		// Fail fast rather than silently ignore it on any other mechanism.
		if (entry.variadic && entry.mechanism !== 'folder') {
			throw new RenderError(
				`variadic is only valid on mechanism "folder"; found it on "${entry.mechanism}" at level "${entry.level}".`,
			);
		}

		switch (entry.mechanism) {
			case 'folder':
				if (entry.variadic) {
					applyVariadicFolder(
						address,
						entry as Parameters<typeof applyVariadicFolder>[1],
						identity.scope,
						report,
						layoutValues,
					);
				} else {
					applyFolder(address, entry as Parameters<typeof applyFolder>[1], identity.scope, report, layoutValues);
				}
				break;
			case 'file':
				// AM-37: `layoutValues` reaches the file mechanism too. Its template
				// may render directory prefixes, and a directory nobody recorded a
				// value for is a directory whose hub identity has to be guessed back
				// out of the path.
				applyFile(address, entry as Parameters<typeof applyFile>[1], identity.scope, report, layoutValues);
				break;
			case 'heading':
				applyHeading(address, entry as Parameters<typeof applyHeading>[1], identity.scope, report);
				break;
			case 'tag':
				applyTagStub();
				break;
			case 'wikilink':
				applyWikilinkStub();
				break;
			default:
				throw new RenderError(
					`Unknown mechanism "${entry.mechanism}" at level "${entry.level}". ` +
						`Allowed: folder, file, heading, tag, wikilink (last two deferred to v0.2).`,
				);
		}
	}

	// 2. Cross-cutting also_emit
	const alsoEmit = recipe.target.also_emit;
	if (alsoEmit) {
		if (alsoEmit.tags) {
			for (const t of alsoEmit.tags) {
				address.tags.push(renderTemplate(t, identity.scope, report));
			}
		}
		if (alsoEmit.aliases) {
			for (const a of alsoEmit.aliases) {
				address.aliases.push(renderTemplate(a, identity.scope, report));
			}
		}
		if (alsoEmit.frontmatter?.managed) {
			for (const [k, t] of Object.entries(alsoEmit.frontmatter.managed)) {
				const v = renderTemplateValue(t, identity.scope, report);
				// Omit keys that render empty or as an empty wikilink target: a
				// root concept has no parent, and emitting parent: "[[]]" puts a
				// literal broken link on every root note (13 across the goldens
				// when this was found). Skipping IS the correct missing-value
				// semantic for metadata, not a deviation — no report note.
				// The `'[[]]'` guard remains for recipes still written as
				// `"[[{parent|optional}]]"`; `{parent|optional|wikilink}` never
				// produces an empty link in the first place.
				if (v === '' || v === '[[]]') continue;
				// A chain that yields a list emits a YAML array; an empty list
				// omits the key, matching the `v === ''` rule above (an empty
				// managed array would still overwrite a user's value on re-import).
				if (Array.isArray(v) && v.length === 0) continue;
				address.frontmatter[k] = v;
			}
		}
		if (alsoEmit.frontmatter?.managed_links) {
			for (const [k, spec] of Object.entries(alsoEmit.frontmatter.managed_links)) {
				const value = renderTemplateValue(spec.template, identity.scope, report);
				// A chain that yields a list is used directly (per-item cleaning,
				// rejection and link decoration already happened in the chain).
				// Anything else takes today's exact path behind an explicit
				// String() coercion, so numeric cells stay byte-identical.
				const links = Array.isArray(value)
					? value
							.map((v) => {
								const s = String(v);
								return /^\[\[[\s\S]*\]\]$/.test(s) ? s : `[[${s}]]`;
							})
							.filter((s) => s !== '[[]]')
					: splitLinkValues(String(value), spec.split).map((v) => `[[${v}]]`);
				// Omit the key entirely when the cell is empty — an empty managed
				// array would still overwrite a user's value on re-import.
				if (links.length > 0) address.frontmatter[k] = links;
			}
		}
		if (alsoEmit.body) {
			for (const projection of alsoEmit.body) {
				const region = renderBodyProjection(projection, identity.scope, report);
				if (region) address.body.push(region);
			}
		}
	}

	// 3. Compute wikilinkTarget — Pass-1 absolute form (full vault path
	//    minus .md extension, plus heading anchor if present).
	//    Pass-2 link minimizer (v0.3) may downgrade to bare basename.
	if (!address.wikilinkTarget) {
		const pathSansMd = address.primary.path.replace(/\.md$/, '');
		address.wikilinkTarget = address.primary.anchor
			? `${pathSansMd}#${address.primary.anchor}`
			: pathSansMd;
	}

	// 4. Always include the concept's CURIE in frontmatter
	if (!('curie' in address.frontmatter)) {
		address.frontmatter.curie = identity.curie;
	}

	// 5. Kind dispatch — if any layout entry declares a non-concept kind, set
	//    the discriminator. Last non-default wins (recipe authors typically
	//    declare kind on the leaf entry only). The frontmatter shape produced
	//    by junction-note + crosswalk-edge layouts is fully driven by the
	//    recipe's also_emit.frontmatter.managed templates (which write
	//    subject/predicate/object for junctions, subject_id/predicate_id/
	//    object_id for crosswalks). Tier 1 schema validation enforces the
	//    kind-specific required-field set + STRM predicate enum at write time.
	let chosenKind: Tier1Kind = 'concept';
	for (const entry of recipe.target.layout) {
		if (entry.kind && entry.kind !== 'concept') {
			chosenKind = entry.kind;
		}
	}
	if (chosenKind !== 'concept') {
		address.frontmatter.kind = chosenKind;
	}

	return address;
}

/** Default list delimiters for a `managed_links` split (comma + semicolon). */
const DEFAULT_LINK_SPLIT = [',', ';'];

/**
 * Split a rendered cell into the individual link values for a `managed_links`
 * array: split on every delimiter in `delimiters` (default comma/semicolon),
 * trim each piece, drop empties. Deterministic. Exported for tests.
 */
export function splitLinkValues(raw: string, delimiters?: string[]): string[] {
	const delims = delimiters && delimiters.length > 0 ? delimiters : DEFAULT_LINK_SPLIT;
	let pieces = [raw];
	for (const d of delims) pieces = pieces.flatMap((p) => p.split(d));
	return pieces.map((p) => p.trim()).filter((p) => p !== '');
}
