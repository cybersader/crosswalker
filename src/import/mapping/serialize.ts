/**
 * mapping/serialize.ts — StructureMapping ⇄ recipe regions (spec §5 parity contract).
 *
 * `toRecipeRegions(mapping)` projects the model onto the recipe regions it maps
 * to 1:1: folder/name/heading levels → layout entries; tag/property/link/alias
 * destinations → also_emit; the ragged tail → a `variadic` folder block.
 * `fromRecipe(recipe)` reconstructs the model from those regions, including
 * recognizing merged-template rows (composed `split()` templates → a merged
 * source range) and re-grouping also_emit destinations back onto the structural
 * level that shares their source.
 *
 * The ROUND-TRIP LAW (spec §3a½): `fromRegions(toRecipeRegions(m))` deep-equals
 * `m` for every mapping expressible in recipe regions. Fields with no recipe
 * surface (per-level `missing`, `materialize`, `naming.lookup`, row filters, and
 * the `note` destination) remain outside this serializer. RecipeDocument blocks
 * those states explicitly rather than allowing a lossy portable patch. Body
 * append/section destinations and tail placement are wired.
 *
 * Assumptions that keep the mapping ⇄ layout correspondence tractable:
 *   - A level carries AT MOST ONE structural destination (folder XOR name XOR
 *     heading) plus any number of metadata destinations (tag/property/link/alias).
 *     Real recipes never split one source level across two structural mechanisms.
 *   - Literal path prefixes on a template (`Frameworks/{catalog.name}`) are not
 *     modeled; a template with a leading literal beyond a tag namespace is
 *     reconstructed best-effort (documented limitation — none of the v0.1 corpus
 *     structural templates use one).
 *
 * Pure module: NO Obsidian imports.
 */

import type { VariadicConfig } from '../../render/types';
import type { CrosswalkColumnEntry, NestedRecordLevel } from '../../types/generated/recipe';
import type {
	ImportMapping,
	StructureMapping,
	LevelRule,
	TailRule,
	Destination,
	LevelSource,
	PartRef,
	LevelNaming,
	Enrichment,
} from './types';
import { destinationRank, toSourceRefs, isConstantRef, DEFAULT_MISSING } from './types';
import {
	interpolationColumn,
	parseTemplateSegments,
	pathTextFor,
	type Interpolation,
} from '../../render/template';

// ============================================================================
// Recipe region shapes (structural subset of spec/recipe.schema.json)
// ============================================================================

/** A single recipe layout entry (the structural subset we read/write). */
export interface LayoutEntry {
	level: string;
	mechanism: 'folder' | 'file' | 'heading';
	template: string;
	level_depth?: number;
	kind?: 'concept' | 'junction-note' | 'crosswalk-edge';
	variadic?: VariadicConfig;
}

/** A managed list-valued wikilink spec (schema `managed_links`). */
export interface ManagedLinkSpec {
	template: string;
	split?: string[];
}

/** One canonical body projection represented by a workbench body destination. */
export type BodyProjectionSpec =
	| {
			template: string;
			position?: 'append';
			level?: string;
			format?: 'text' | 'code' | 'quote' | 'list';
			omit_if_empty?: boolean;
	  }
	| {
			template: string;
			position: 'section';
			heading: string;
			heading_depth?: 1 | 2 | 3 | 4 | 5 | 6;
			format?: 'text' | 'code' | 'quote' | 'list';
			omit_if_empty?: boolean;
	  };

/** The cross-cutting also_emit region. */
export interface AlsoEmit {
	tags?: string[];
	aliases?: string[];
	frontmatter?: {
		managed?: Record<string, string>;
		managed_links?: Record<string, ManagedLinkSpec>;
		user_preserve?: string[];
	};
	body?: BodyProjectionSpec[];
}

/** The regions `toRecipeRegions` produces / `fromRegions` consumes. */
export interface RecipeRegions {
	layout: LayoutEntry[];
	nest?: NestedRecordLevel[];
	also_emit?: AlsoEmit;
	crosswalks?: CrosswalkColumnEntry[];
	/** Batch enrichment (Pass 1.5). Serializes to recipe target.enrichment. */
	enrichment?: Enrichment;
}

/** A recipe (structural subset) accepted by `fromRecipe`. */
export interface RecipeLike {
	target: RecipeRegions;
	source?: { nest?: NestedRecordLevel[] };
}

/** A constant level id for the variadic tail's folder entry (irrelevant to the tail model). */
const TAIL_LEVEL_ID = 'tail';

// ============================================================================
// Serialization: mapping → recipe regions
// ============================================================================

/** Structural destination primitives — those that place a note in the vault tree. */
function isStructuralDestination(dest: Destination): boolean {
	return dest.primitive === 'folder' || dest.primitive === 'name' || dest.primitive === 'heading';
}

/** Does a mapping carry any structural destination (levels or tail)? */
function hasStructuralDestination(m: StructureMapping): boolean {
	if (m.levels.some((l) => l.destinations.some(isStructuralDestination))) return true;
	return m.tail !== undefined && m.tail.destinations.some(isStructuralDestination);
}

/**
 * Guard the single-structural constraint (spec §7g) LOUDLY. render() walks the
 * concatenated layout in order, so two structural mappings interleave their
 * folder/file entries into garbage paths (`T1055/T1055.011.md/defense/...`). A
 * loud throw here beats silent path corruption. instantiate() already elects one
 * structural winner; this catches a hand-built or mis-merged mapping that slipped
 * past. Metadata-only mappings (tags/links/properties/aliases/body) are unlimited.
 */
function assertSingleStructural(mapping: ImportMapping): void {
	const structural = mapping.mappings.filter(hasStructuralDestination);
	if (structural.length > 1) {
		const describe = (m: StructureMapping): string =>
			m.levels.map((l) => l.level).join('+') + (m.tail ? '+tail' : '');
		throw new Error(
			`one recipe supports exactly one structural mapping (folder/name/heading); found ${structural.length}: ${structural
				.map(describe)
				.join(', ')}. Metadata-only mappings are unlimited; demote the extra structural detection in instantiate() (spec section 7g).`,
		);
	}
}

/**
 * Project an ImportMapping onto recipe regions. Structural destinations become
 * layout entries; metadata/body destinations become also_emit; a tail becomes a
 * variadic folder entry. Callers that need a portable artifact must run the
 * RecipeDocument editable-model diagnostics before using these regions.
 */
interface OrderedEmission<T> {
	value: T;
	canonicalOrder?: number;
	sequence: number;
}

const DETECTION_BACKED_LINK = Symbol('crosswalker-detection-backed-link');

export function markDetectionBackedLink<T extends Destination>(destination: T): T {
	Object.defineProperty(destination, DETECTION_BACKED_LINK, { value: true });
	return destination;
}

function isDetectionBackedLink(destination: Destination): boolean {
	return (destination as Destination & { [DETECTION_BACKED_LINK]?: boolean })[DETECTION_BACKED_LINK] === true;
}

export interface ScalarLinkEmission {
	key: string;
	template: string;
	sourceColumns: string[];
	predicate?: string;
	detectionBacked: boolean;
	mappingIndex: number;
	levelIndex: number;
	destinationIndex: number;
}

export function collectScalarLinkEmissions(mapping: ImportMapping): ScalarLinkEmission[] {
	const emissions: ScalarLinkEmission[] = [];
	for (let mappingIndex = 0; mappingIndex < mapping.mappings.length; mappingIndex++) {
		const structure = mapping.mappings[mappingIndex];
		for (let levelIndex = 0; levelIndex < structure.levels.length; levelIndex++) {
			const level = structure.levels[levelIndex];
			for (let destinationIndex = 0; destinationIndex < level.destinations.length; destinationIndex++) {
				const destination = level.destinations[destinationIndex];
				if (destination.primitive !== 'link' || destination.list === true) continue;
				emissions.push({
					key: destination.key,
					template: scalarLinkTemplate(level, destination),
					sourceColumns: toSourceRefs(level.source).flatMap((ref) =>
						isConstantRef(ref) ? [] : [ref.column],
					),
					...(destination.predicate ? { predicate: destination.predicate } : {}),
					detectionBacked: isDetectionBackedLink(destination),
					mappingIndex,
					levelIndex,
					destinationIndex,
				});
			}
		}
	}
	return emissions;
}

function scalarLinkTemplate(rule: LevelRule, destination: Extract<Destination, { primitive: 'link' }>): string {
	return `[[${buildName(rule.source, rule.delimiter, rule.join, rule.filters, rule.naming, rule.delimiters)}]]`;
}

export function toRecipeRegions(mapping: ImportMapping): RecipeRegions {
	assertSingleStructural(mapping);
	const layout: LayoutEntry[] = [];
	const tags: OrderedEmission<string>[] = [];
	const aliases: OrderedEmission<string>[] = [];
	const managed: Record<string, string> = {};
	const managedLinks: Record<string, ManagedLinkSpec> = {};
	const body: OrderedEmission<BodyProjectionSpec>[] = [];
	const crosswalks: CrosswalkColumnEntry[] = [];

	// Precedence (2026-07-11, the Connections placement-chooser repro):
	// `mapping.enrichment.parent_note` is the knob the workbench UI writes
	// (`updateEnrichment`, the placement-chooser radio) and it ALWAYS wins when
	// set. A tail's own `placement` is a recipe-authoring escape hatch (hand-
	// written recipes, presets) that only fills the gap when the enrichment
	// block doesn't specify one — see the `TailRule.placement` doc comment in
	// types.ts. This used to be inverted (tail wins), which was harmless on a
	// fresh instantiation (no preset stamps `tail.placement`) but silently
	// discarded an explicit UI choice on any mapping that had been round-
	// tripped through `fromRegions` first (draft resume, the recognized-recipe
	// fast path via `recipeMapping`/`fromRecipe`): `fromRegions` stamps
	// `tail.placement` from the recipe's `enrichment.parent_note` (the reverse
	// promotion below) so a later `updateEnrichment({parent_note: ...})` call —
	// which only patches `mapping.enrichment`, by design (see the doc comment
	// on `updateEnrichment` in workbench.ts) — left a stale `tail.placement`
	// that then out-voted the user's fresh choice here.
	let tailPlacement: 'sibling' | 'folder-note' | undefined;

	for (const structure of mapping.mappings) {
		const structLayout: LayoutEntry[] = [];
		for (const rule of structure.levels) {
			emitLevel(rule, structLayout, tags, aliases, managed, managedLinks, body, crosswalks);
		}
		if (structure.tail) {
			// render() walks layout in order, so the variadic tail (parent
			// folders) must precede the leaf file/heading entry. Appending it
			// after the leaf inverts every ragged path (T1055.001.md/T1055
			// instead of T1055/T1055.001.md) — found via E2E screenshot.
			const leafIdx = structLayout.findIndex(
				(e) => e.mechanism === 'file' || e.mechanism === 'heading',
			);
			const tailEntry = tailToEntry(structure.tail);
			if (leafIdx >= 0) structLayout.splice(leafIdx, 0, tailEntry);
			else structLayout.push(tailEntry);
			if (structure.tail.placement !== undefined) tailPlacement = structure.tail.placement;
		}
		layout.push(...structLayout);
	}

	const also_emit = buildAlsoEmit(tags, aliases, managed, managedLinks, body, mapping.userPreserve);
	const regions: RecipeRegions = also_emit ? { layout, also_emit } : { layout };
	if (mapping.nest?.length) {
		regions.nest = mapping.nest.map((entry) => {
			const copy: NestedRecordLevel = {
				...entry,
				...(entry.carry ? { carry: [...entry.carry] } : {}),
				...(entry.children && typeof entry.children === 'object'
					? { children: { ...entry.children } }
					: {}),
			};
			const row = mapping.mappings.flatMap((structure) => structure.levels)
				.find((level) => level.level === entry.level);
			if (entry.children !== undefined && row?.destinations.some((destination) => destination.primitive === 'name')) {
				delete copy.leaf;
			}
			return copy;
		});
	}
	if (crosswalks.length > 0) regions.crosswalks = crosswalks;
	// Enrichment-level wins when set (see the precedence note above); the tail's
	// placement only fills in when the enrichment block leaves it unspecified.
	const parentNote = mapping.enrichment?.parent_note ?? tailPlacement;
	if (mapping.enrichment || parentNote !== undefined) {
		regions.enrichment = { ...mapping.enrichment, ...(parentNote !== undefined ? { parent_note: parentNote } : {}) };
	}
	return regions;
}

/** Emit one level's destinations into the appropriate regions. */
function emitLevel(
	rule: LevelRule,
	layout: LayoutEntry[],
	tags: OrderedEmission<string>[],
	aliases: OrderedEmission<string>[],
	managed: Record<string, string>,
	managedLinks: Record<string, ManagedLinkSpec>,
	body: OrderedEmission<BodyProjectionSpec>[],
	crosswalks: CrosswalkColumnEntry[],
): void {
	const name = buildName(rule.source, rule.delimiter, rule.join, rule.filters, rule.naming, rule.delimiters);
	for (const dest of rule.destinations) {
		switch (dest.primitive) {
			case 'folder':
				layout.push({ level: rule.level, mechanism: 'folder', template: name });
				break;
			case 'name':
				layout.push({ level: rule.level, mechanism: 'file', template: `${name}.md` });
				break;
			case 'heading':
				layout.push({
					level: rule.level,
					mechanism: 'heading',
					level_depth: dest.depth,
					template: name,
				});
				break;
			case 'tag': {
				const ns = dest.namespace ?? slug(firstColumn(rule.source));
				const tagValue = buildName(
					rule.source,
					rule.delimiter,
					rule.join,
					appendFilter(rule.filters, 'tagsafe'),
					rule.naming,
					rule.delimiters,
				);
				pushOrdered(tags, `${ns}/${tagValue}`, dest.canonicalOrder);
				break;
			}
			case 'property':
				managed[dest.key] = name;
				break;
			case 'link':
				if (dest.list) {
					// Multi-value link → a list-valued managed wikilink array. The
					// template is the bare column value; render() splits + wikilinks it.
					managedLinks[dest.key] = {
						template: name,
						...(dest.split && dest.split.length > 0 ? { split: [...dest.split] } : {}),
					};
				} else {
					managed[dest.key] = scalarLinkTemplate(rule, dest);
				}
				break;
			case 'crosswalk': {
				if (!dest.toOntology) break;
				const column = singleSourceColumn(rule.source);
				if (!column) break;
				crosswalks.push({
					column,
					to_ontology: dest.toOntology,
					...(dest.predicate && dest.predicate !== 'is_approximate_to' ? { predicate: dest.predicate } : {}),
					...(dest.split && dest.split.length > 0 ? { split: [...dest.split] } : {}),
					...(dest.qualifier ? { qualifier: dest.qualifier } : {}),
					...(dest.mappingSetId ? { mapping_set_id: dest.mappingSetId } : {}),
				});
				break;
			}
			case 'alias':
				pushOrdered(aliases, name, dest.canonicalOrder);
				break;
			case 'body':
				if (dest.position === 'append') {
					pushOrdered(body, {
						template: name,
						position: 'append',
						...(dest.level ? { level: dest.level } : {}),
						...(dest.format ? { format: dest.format } : {}),
						...(dest.omitIfEmpty !== undefined ? { omit_if_empty: dest.omitIfEmpty } : {}),
					}, dest.canonicalOrder);
				} else if (dest.position === 'section') {
					pushOrdered(body, {
						template: name,
						position: 'section',
						heading: dest.heading ?? rule.level,
						...(dest.headingDepth ? { heading_depth: dest.headingDepth } : {}),
						...(dest.format ? { format: dest.format } : {}),
						...(dest.omitIfEmpty !== undefined ? { omit_if_empty: dest.omitIfEmpty } : {}),
					}, dest.canonicalOrder);
				}
				break;
			case 'note':
				// `note` has no canonical recipe surface. RecipeDocument diagnostics block it.
				break;
		}
	}
}

/** Build a folder entry carrying the variadic block from a tail rule. */
function tailToEntry(tail: TailRule): LayoutEntry {
	const variadic: VariadicConfig = { delimiter: tail.delimiter };
	if (tail.naming) variadic.segment = tail.naming;
	if (tail.drop_last !== undefined) variadic.drop_last = tail.drop_last;
	if (tail.max_depth !== undefined) variadic.max_depth = tail.max_depth;
	if (tail.on_overflow !== undefined) variadic.on_overflow = tail.on_overflow;
	// tail.placement has no PER-ENTRY recipe surface (the variadic block has no
	// placement field) — it serializes to the recipe's global
	// target.enrichment.parent_note instead, in toRecipeRegions (the caller).
	return {
		level: tail.level ?? TAIL_LEVEL_ID,
		mechanism: 'folder',
		template: buildName(tail.source, tail.delimiter, undefined, undefined),
		variadic,
	};
}

/** Assemble the also_emit region, omitting empty sub-blocks (matches recipe shape). */
function buildAlsoEmit(
	tags: OrderedEmission<string>[],
	aliases: OrderedEmission<string>[],
	managed: Record<string, string>,
	managedLinks: Record<string, ManagedLinkSpec>,
	body: OrderedEmission<BodyProjectionSpec>[],
	userPreserve?: string[],
): AlsoEmit | undefined {
	const out: AlsoEmit = {};
	if (tags.length) out.tags = orderedValues(tags);
	if (aliases.length) out.aliases = orderedValues(aliases);
	const hasManaged = Object.keys(managed).length > 0;
	const hasManagedLinks = Object.keys(managedLinks).length > 0;
	const hasUserPreserve = !!userPreserve && userPreserve.length > 0;
	if (hasManaged || hasManagedLinks || hasUserPreserve) {
		out.frontmatter = {};
		if (hasManaged) out.frontmatter.managed = managed;
		if (hasManagedLinks) out.frontmatter.managed_links = managedLinks;
		// B7 (2026-07-12 pre-merge review): user_preserve was declared on
		// AlsoEmit.frontmatter but never written here — re-imports silently
		// lost the field, defeating the merge's own re-import-safety mechanism.
		if (hasUserPreserve) out.frontmatter.user_preserve = userPreserve;
	}
	if (body.length > 0) out.body = orderedValues(body);
	return tags.length || aliases.length || hasManaged || hasManagedLinks || hasUserPreserve || body.length > 0
		? out
		: undefined;
}

function pushOrdered<T>(
	items: OrderedEmission<T>[],
	value: T,
	canonicalOrder?: number,
): void {
	items.push({ value, canonicalOrder, sequence: items.length });
}

function orderedValues<T>(items: OrderedEmission<T>[]): T[] {
	return [...items]
		.sort((left, right) => {
			if (left.canonicalOrder !== undefined && right.canonicalOrder !== undefined) {
				return left.canonicalOrder - right.canonicalOrder;
			}
			if (left.canonicalOrder !== undefined) return -1;
			if (right.canonicalOrder !== undefined) return 1;
			return left.sequence - right.sequence;
		})
		.map((item) => item.value);
}

// ============================================================================
// Template building
// ============================================================================

/**
 * Build a template string from a source. Each ref becomes one piece:
 *   - constant            → the literal string, verbatim (no braces, no filters)
 *   - whole column        → `{col}`
 *   - part index n        → `{col|split(delimiter,n)}`
 *   - range [i,j]         → `{col|split(delimiter,i)}` … `{col|split(delimiter,j)}`
 * Pieces are concatenated with `join ?? delimiter ?? ''`. Trailing filters chain
 * inside each interpolation. This is the exact inverse of
 * `parseStructuralTemplate`.
 *
 * Delimiter SETS: when the level carries `delimiters`, or is named `'prefix'`,
 * the part filter becomes `part(D,n)` / `prefix(D,n)` instead of `split(d,n)`.
 * A level carrying only the legacy single `delimiter` is byte-identical to the
 * pre-set behaviour, which is what keeps existing recipe hashes stable.
 */
export function buildName(
	source: LevelSource,
	delimiter: string | undefined,
	join: string | undefined,
	filters: string[] | undefined,
	naming?: LevelNaming,
	delimiters?: string,
): string {
	const sep = join ?? delimiter ?? '';
	// `prefix` has no `split` spelling, so a prefix level always takes the set
	// form and falls back to the single delimiter when no set was recorded.
	const useSet = delimiters !== undefined || naming === 'prefix';
	const filterName = naming === 'prefix' ? 'prefix' : 'part';
	const setArg = useSet ? escapeFilterArg(delimiters ?? delimiter ?? '') : '';
	const partFilter = (index: number): string =>
		useSet ? `${filterName}(${setArg},${index})` : `split(${delimiter},${index})`;
	const pieces: string[] = [];
	for (const ref of toSourceRefs(source)) {
		if (isConstantRef(ref)) {
			// Literal — emitted as-is (a constant carries no split/filter).
			pieces.push(ref.constant);
		} else if (ref.part === undefined) {
			pieces.push(`{${withFilters(pathTextFor(ref.column, ref.literal), filters)}}`);
		} else if (typeof ref.part === 'number') {
			pieces.push(
				`{${withFilters(`${pathTextFor(ref.column, ref.literal)}|${partFilter(ref.part)}`, filters)}}`,
			);
		} else {
			const [i, j] = ref.part;
			for (let k = i; k <= j; k++) {
				pieces.push(
					`{${withFilters(`${pathTextFor(ref.column, ref.literal)}|${partFilter(k)}`, filters)}}`,
				);
			}
		}
	}
	return pieces.join(sep);
}

/**
 * Escape a delimiter set for the balanced-paren filter lexer. Only the five
 * characters the lexer treats specially are touched, and `\\` goes first so an
 * already-escaping backslash is not double-counted.
 */
function escapeFilterArg(arg: string): string {
	return arg.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/\)/g, '\\)').replace(/\|/g, '\\|');
}

/** Append a filter chain onto an interpolation body. */
function withFilters(base: string, filters: string[] | undefined): string {
	if (!filters || filters.length === 0) return base;
	return base + filters.map((f) => `|${f}`).join('');
}

/** Add one filter to a (possibly undefined) filter chain, once. */
function appendFilter(filters: string[] | undefined, filter: string): string[] {
	const list = filters ? [...filters] : [];
	if (!list.includes(filter)) list.push(filter);
	return list;
}

// ============================================================================
// Deserialization: recipe regions → mapping
// ============================================================================

export interface FromRegionsOptions {
	/** Retain canonical array positions for RecipeDocument's lossless patcher. */
	preserveCanonicalOrder?: boolean;
}

/** Reconstruct an ImportMapping from a full recipe. */
export function fromRecipe(recipe: RecipeLike, options: FromRegionsOptions = {}): ImportMapping {
	return fromRegions(
		{ ...recipe.target, ...(recipe.source?.nest ? { nest: recipe.source.nest } : {}) },
		options,
	);
}

/**
 * Reconstruct an ImportMapping from recipe regions.
 *
 * Structural (layout) entries form one StructureMapping (levels in layout order;
 * a variadic entry becomes the tail). Each also_emit destination is re-grouped
 * onto the structural level that shares its source; destinations with no
 * structural match form their own single-level StructureMappings, in encounter
 * order (tags → aliases → managed).
 */
export function fromRegions(regions: RecipeRegions, options: FromRegionsOptions = {}): ImportMapping {
	const structuralLevels: LevelRule[] = [];
	let tail: TailRule | undefined;
	// Signature → the structural level that owns that source (for metadata re-grouping).
	const sigToLevel = new Map<string, LevelRule>();

	for (const entry of regions.layout) {
		if (entry.variadic) {
			tail = variadicToTail(entry);
			// The recipe's global target.enrichment.parent_note is the tail's
			// placement — the reverse of toRecipeRegions' tail→enrichment
			// promotion above. Only one tail carries a structural placement in
			// v0.1's single-structural-mapping constraint, so this is exact.
			if (regions.enrichment?.parent_note !== undefined) tail.placement = regions.enrichment.parent_note;
			continue;
		}
		const isFile = entry.mechanism === 'file';
		const parsed = parseStructuralTemplate(isFile ? stripMd(entry.template) : entry.template);
		const dest: Destination =
			entry.mechanism === 'folder'
				? { primitive: 'folder' }
				: entry.mechanism === 'heading'
					? {
						primitive: 'heading',
						hostRule: headingHostRule(entry.level, regions),
						depth: entry.level_depth ?? 1,
					}
					: { primitive: 'name' };
		const rule = makeLevel(entry.level, parsed, [dest]);
		structuralLevels.push(rule);
		sigToLevel.set(sourceSignature(parsed), rule);
	}

	// Standalone metadata destinations, grouped by source signature (insertion-ordered).
	const standalone = new Map<string, LevelRule>();

	const attach = (parsed: ParsedSource, dest: Destination): void => {
		const sig = sourceSignature(parsed);
		const owner = sigToLevel.get(sig);
		if (owner) {
			owner.destinations.push(dest);
			return;
		}
		const existing = standalone.get(sig);
		if (existing) {
			existing.destinations.push(dest);
		} else {
			standalone.set(sig, makeLevel(synthLevelId(parsed), parsed, [dest]));
		}
	};

	const emit = regions.also_emit;
	if (emit) {
		for (const [canonicalOrder, tag] of (emit.tags ?? []).entries()) {
			const { namespace, parsed } = parseTagTemplate(tag);
			attach(parsed, {
				primitive: 'tag',
				namespace,
				...(options.preserveCanonicalOrder ? { canonicalOrder } : {}),
			});
		}
		for (const [canonicalOrder, alias] of (emit.aliases ?? []).entries()) {
			attach(parseStructuralTemplate(alias), {
				primitive: 'alias',
				...(options.preserveCanonicalOrder ? { canonicalOrder } : {}),
			});
		}
		const managed = emit.frontmatter?.managed ?? {};
		for (const [key, template] of Object.entries(managed)) {
			const link = matchWikilink(template);
			if (link) {
				attach(parseStructuralTemplate(link), { primitive: 'link', key, direction: 'parent-on-child' });
			} else {
				attach(parseStructuralTemplate(template), { primitive: 'property', key });
			}
		}
		// managed_links → list-valued link destinations. The stored template is the
		// bare column value (no `[[…]]` wrapper — render() wikilinks each piece).
		const managedLinks = emit.frontmatter?.managed_links ?? {};
		for (const [key, spec] of Object.entries(managedLinks)) {
			attach(parseStructuralTemplate(spec.template), {
				primitive: 'link',
				key,
				direction: 'parent-on-child',
				list: true,
				...(spec.split && spec.split.length > 0 ? { split: [...spec.split] } : {}),
			});
		}
		for (const [canonicalOrder, projection] of (emit.body ?? []).entries()) {
			const parsed = parseStructuralTemplate(projection.template);
			if (projection.position === 'section') {
				attach(parsed, {
					primitive: 'body',
					position: 'section',
					heading: projection.heading,
					...(projection.heading_depth ? { headingDepth: projection.heading_depth } : {}),
					...(projection.format ? { format: projection.format } : {}),
					...(projection.omit_if_empty !== undefined ? { omitIfEmpty: projection.omit_if_empty } : {}),
					...(options.preserveCanonicalOrder ? { canonicalOrder } : {}),
				});
			} else {
				attach(parsed, {
					primitive: 'body',
					position: 'append',
					...(projection.level ? { level: projection.level } : {}),
					...(projection.format ? { format: projection.format } : {}),
					...(projection.omit_if_empty !== undefined ? { omitIfEmpty: projection.omit_if_empty } : {}),
					...(options.preserveCanonicalOrder ? { canonicalOrder } : {}),
				});
			}
		}
	}

	for (const entry of regions.crosswalks ?? []) {
		attach(parseStructuralTemplate(`{${entry.column}}`), {
			primitive: 'crosswalk',
			toOntology: entry.to_ontology,
			predicate: entry.predicate ?? 'is_approximate_to',
			...(entry.split && entry.split.length > 0 ? { split: [...entry.split] } : {}),
			...(entry.qualifier ? { qualifier: entry.qualifier } : {}),
			...(entry.mapping_set_id ? { mappingSetId: entry.mapping_set_id } : {}),
		});
	}

	// Canonicalize destination order on every level.
	for (const rule of structuralLevels) sortDestinations(rule);
	for (const rule of standalone.values()) sortDestinations(rule);

	const mappings: StructureMapping[] = [];
	if (structuralLevels.length > 0 || tail) {
		mappings.push(tail ? { levels: structuralLevels, tail } : { levels: structuralLevels });
	}
	for (const rule of standalone.values()) {
		mappings.push({ levels: [rule] });
	}

	const result: ImportMapping = { mappings };
	if (regions.nest?.length) {
		result.nest = regions.nest.map((entry) => ({
			...entry,
			...(entry.carry ? { carry: [...entry.carry] } : {}),
			...(entry.children && typeof entry.children === 'object'
				? { children: { ...entry.children } }
				: {}),
		}));
	}
	if (regions.enrichment) result.enrichment = regions.enrichment;
	// B7 (2026-07-12 pre-merge review): read user_preserve back so the
	// round-trip law holds — see buildAlsoEmit's write side above.
	const userPreserve = regions.also_emit?.frontmatter?.user_preserve;
	if (userPreserve && userPreserve.length > 0) result.userPreserve = userPreserve;
	return result;
}

/** Recover the note-bearing ancestor for a section heading; ordinary headings keep the legacy root host. */
function headingHostRule(level: string, regions: RecipeRegions): string {
	const nest = regions.nest;
	const index = nest?.findIndex((entry) => entry.level === level) ?? -1;
	if (!nest || index < 0 || nest[index].leaf !== 'section') return 'root';
	for (let ancestor = index - 1; ancestor >= 0; ancestor--) {
		const ancestorLevel = nest[ancestor].level;
		const layout = regions.layout.find((entry) => entry.level === ancestorLevel);
		if (layout?.mechanism === 'file' || nest[ancestor].leaf === 'folder-note') return ancestorLevel;
	}
	return 'root';
}

/** Turn a parsed source + destinations into a LevelRule with default policies. */
function makeLevel(level: string, parsed: ParsedSource, destinations: Destination[]): LevelRule {
	const rule: LevelRule = {
		level,
		source: parsed.source,
		destinations,
		naming: parsed.naming ?? inferNaming(parsed.source),
		missing: DEFAULT_MISSING,
		materialize: false,
	};
	if (parsed.delimiter !== undefined) rule.delimiter = parsed.delimiter;
	if (parsed.delimiters !== undefined) rule.delimiters = parsed.delimiters;
	if (parsed.join !== undefined) rule.join = parsed.join;
	if (parsed.filters.length > 0) rule.filters = parsed.filters;
	return rule;
}

/** Sort a level's destinations into the canonical order for stable round-trips. */
function sortDestinations(rule: LevelRule): void {
	rule.destinations.sort((a, b) => destinationRank(a.primitive) - destinationRank(b.primitive));
}

/** Reconstruct a TailRule from a variadic folder entry. */
function variadicToTail(entry: LayoutEntry): TailRule {
	const v = entry.variadic as VariadicConfig;
	const parsed = parseStructuralTemplate(entry.template);
	const tail: TailRule = {
		source: parsed.source,
		delimiter: v.delimiter,
		destinations: [{ primitive: 'folder' }],
		naming: v.segment === 'part' ? 'part' : 'prefix',
	};
	if (entry.level !== TAIL_LEVEL_ID) tail.level = entry.level;
	if (v.drop_last !== undefined) tail.drop_last = v.drop_last;
	if (v.max_depth !== undefined) tail.max_depth = v.max_depth;
	if (v.on_overflow !== undefined) tail.on_overflow = v.on_overflow;
	return tail;
}

// ============================================================================
// Template parsing
// ============================================================================

/** A source recovered from a template. */
export interface ParsedSource {
	source: LevelSource;
	delimiter?: string;
	/** Delimiter set, when the template used `part()` / `prefix()`. */
	delimiters?: string;
	/**
	 * Naming the template stated outright. Only `prefix` is carried: a `part`
	 * template is left to `inferNaming`, which correctly reads a merged range as
	 * `joined` while a single part stays `part`.
	 */
	naming?: LevelNaming;
	join?: string;
	filters: string[];
}

interface ParsedInterp {
	column: string;
	/** True when the column was written as a quoted literal key (`{['A.B']}`). */
	literal?: boolean;
	part?: number;
	delimiter?: string;
	/** Delimiter set recovered from a `part(D,n)` / `prefix(D,n)` filter. */
	delimiters?: string;
	/** Naming the template stated outright (only `part`/`prefix` filters do). */
	naming?: 'part' | 'prefix';
	filters: string[];
}

type Segment = { kind: 'lit'; text: string } | { kind: 'interp'; interp: Interpolation };

/**
 * Parse a structural template (folder / file-name-without-.md / heading / plain
 * managed value) back into a source. Recognizes merged rows: several `split()`
 * interpolations over one column at consecutive indices collapse into one merged
 * range `[i,j]`. The exact inverse of `buildName`.
 */
export function parseStructuralTemplate(template: string): ParsedSource {
	const segments = parseTemplate(template);
	const interps = segments.filter(
		(s): s is { kind: 'interp'; interp: Interpolation } => s.kind === 'interp',
	);
	const separators = segments.filter((s): s is { kind: 'lit'; text: string } => s.kind === 'lit').map((s) => s.text);

	if (interps.length === 0) {
		// No interpolation at all — a literal value (spec §7f). A brace-less
		// template is never a column reference (real templates always use
		// `{col}`); it is a constant, e.g. CIS `level: "control"` or a
		// `Frameworks/` path prefix.
		return { source: { constant: template }, filters: [] };
	}

	const parsedInterps = interps.map((s) => parseInterp(s.interp));
	const sep = separators.length > 0 ? separators[separators.length - 1] : undefined;

	// Single interpolation → single part or whole column. Preserve any literal
	// prefix/suffix as ConstantRefs so `cw-{edge_id|slug}` round-trips exactly.
	if (parsedInterps.length === 1) {
		const p = parsedInterps[0];
		const ref: PartRef = partRefFor(p);
		const source = segments.length === 1
			? ref
			: segments.map((segment) => segment.kind === 'lit'
				? { constant: segment.text }
				: ref);
		return {
			source,
			delimiter: p.delimiter,
			...(p.delimiters !== undefined ? { delimiters: p.delimiters } : {}),
			...(p.naming === 'prefix' ? { naming: 'prefix' as LevelNaming } : {}),
			...(segments.length > 1 ? { join: '' } : {}),
			filters: p.filters,
		};
	}

	// Multiple interpolations. Merged range when all share one column + delimiter and
	// their indices are consecutive ascending; otherwise a cross-column PartRef[].
	const sameColumn = parsedInterps.every((p) => p.column === parsedInterps[0].column);
	const allIndexed = parsedInterps.every((p) => typeof p.part === 'number');
	const delimiter = parsedInterps[0].delimiter;
	const sameDelimiter = parsedInterps.every((p) => p.delimiter === delimiter);
	// A delimiter SET merges into a range on exactly the same terms as a single
	// delimiter: same column, same set, same filter name, consecutive indices.
	const delimiters = parsedInterps[0].delimiters;
	const sameDelimiters = parsedInterps.every((p) => p.delimiters === delimiters);
	const naming = explicitNaming(parsedInterps);
	const consecutive =
		allIndexed &&
		parsedInterps.every((p, i) => i === 0 || (p.part as number) === (parsedInterps[i - 1].part as number) + 1);

	if (sameColumn && allIndexed && sameDelimiter && sameDelimiters && consecutive) {
		const first = parsedInterps[0].part as number;
		const last = parsedInterps[parsedInterps.length - 1].part as number;
		return {
			source: partRefFor(parsedInterps[0], [first, last]),
			delimiter,
			...(delimiters !== undefined ? { delimiters } : {}),
			...(naming !== undefined ? { naming } : {}),
			join: sep,
			filters: parsedInterps[0].filters,
		};
	}

	// General multi-interpolation template. Preserve literal prefixes, infixes,
	// and suffixes as ConstantRefs, and retain a shared filter chain. This is what
	// keeps templates such as `cw-{subject_id|slug}--{object_id|slug}` exact.
	const sharedFilters = parsedInterps.every(
		(parsed) => JSON.stringify(parsed.filters) === JSON.stringify(parsedInterps[0].filters),
	)
		? parsedInterps[0].filters
		: [];
	const source: LevelSource = segments.map((segment) => {
		if (segment.kind === 'lit') return { constant: segment.text };
		const parsed = parseInterp(segment.interp);
		return partRefFor(parsed);
	});
	return {
		source,
		delimiter,
		...(sameDelimiters && delimiters !== undefined ? { delimiters } : {}),
		...(naming !== undefined ? { naming } : {}),
		join: '',
		filters: sharedFilters,
	};
}

/**
 * The naming a template stated outright, or undefined when it said nothing.
 * Only `prefix` is reported: a `part` template is left to `inferNaming`, which
 * reads a merged range as `joined` and a lone part as `part` — exactly what
 * `buildName` re-emits.
 */
function explicitNaming(parsedInterps: ParsedInterp[]): LevelNaming | undefined {
	const indexed = parsedInterps.filter((p) => p.naming !== undefined);
	if (indexed.length === 0) return undefined;
	return indexed.every((p) => p.naming === 'prefix') ? 'prefix' : undefined;
}

/**
 * Split a template into ordered literal + interpolation segments.
 * Thin wrapper over the shared tokenizer (contract R0).
 */
function parseTemplate(template: string): Segment[] {
	return parseTemplateSegments(template).map((segment) =>
		segment.kind === 'lit'
			? { kind: 'lit' as const, text: segment.text }
			: { kind: 'interp' as const, interp: segment.interp },
	);
}

/** Build a PartRef from a parsed interpolation, carrying the R1.5 literal flag. */
function partRefFor(parsed: ParsedInterp, part?: number | [number, number]): PartRef {
	const chosen = part ?? parsed.part;
	const ref: PartRef = chosen === undefined ? { column: parsed.column } : { column: parsed.column, part: chosen };
	if (parsed.literal) ref.literal = true;
	return ref;
}

/**
 * Parse one interpolation (`col|split(.,0)|fs-safe`) into its mapping parts.
 *
 * R1.5 — a segment written `['A.B']` sets `literal: true` and yields the
 * UNQUOTED name, so `buildName` can re-quote it. A dotted path written bare
 * (`external_references.0.external_id`) keeps its raw text and no flag, so a
 * nested traversal is never silently converted into a literal lookup.
 */
function parseInterp(interp: Interpolation): ParsedInterp {
	const { column, literal } = interpolationColumn(interp);
	let part: number | undefined;
	let delimiter: string | undefined;
	let delimiters: string | undefined;
	let naming: 'part' | 'prefix' | undefined;
	const filters: string[] = [];
	for (const call of interp.filters) {
		// `call.arg` arrives already unescaped from the shared lexer, so the index
		// is taken greedily off the decoded text: a set containing `,` reads back
		// whole. The list form `part(D)` carries no index and stays an opaque
		// filter, since it does not name a single level part.
		const isSet = (call.name === 'part' || call.name === 'prefix') && call.arg !== undefined;
		const setCall = isSet ? /^(.*),(\d+)$/.exec(call.arg as string) : null;
		const sp = call.name === 'split' && call.arg !== undefined ? /^(.),(\d+)$/.exec(call.arg) : null;
		if (setCall) {
			delimiters = setCall[1];
			part = Number(setCall[2]);
			naming = call.name === 'prefix' ? 'prefix' : 'part';
		} else if (sp) {
			delimiter = sp[1];
			part = Number(sp[2]);
		} else {
			filters.push(call.raw);
		}
	}
	// Non-literal columns keep the raw (untrimmed) path text so re-serialization
	// is byte-exact against the pre-tokenizer behaviour.
	return { column: literal ? column : interp.rawPath, literal, part, delimiter, delimiters, naming, filters };
}

/** Parse a tag template (`namespace/{col|tagsafe}`) → namespace + source (tagsafe stripped). */
function parseTagTemplate(template: string): { namespace: string; parsed: ParsedSource } {
	const brace = template.indexOf('{');
	const namespace = brace >= 0 ? template.slice(0, brace).replace(/\/+$/, '') : template;
	const rest = brace >= 0 ? template.slice(brace) : '';
	const parsed: ParsedSource = rest
		? parseStructuralTemplate(rest)
		: { source: { constant: template }, filters: [] };
	// The implicit tagsafe filter is not part of the level's own filter chain.
	parsed.filters = parsed.filters.filter((f) => f !== 'tagsafe');
	return { namespace, parsed };
}

/** Return the inner target of a `[[...]]` wikilink template, or null. */
function matchWikilink(template: string): string | null {
	const m = /^\[\[(.+)\]\]$/.exec(template.trim());
	return m ? m[1] : null;
}

// ============================================================================
// Shared helpers
// ============================================================================

/** Infer naming from a source shape (merged → 'joined'; single → 'part'). */
function inferNaming(source: LevelSource): LevelNaming {
	const refs = toSourceRefs(source);
	if (refs.length > 1) return 'joined';
	const only = refs[0];
	if (!isConstantRef(only) && Array.isArray(only.part)) return 'joined';
	return 'part';
}

/** Canonical signature of a parsed source for metadata re-grouping. */
function sourceSignature(parsed: ParsedSource): string {
	const refs = toSourceRefs(parsed.source).map((r) =>
		isConstantRef(r)
			? { constant: r.constant }
			: { column: r.column, part: r.part ?? null, literal: r.literal ?? null },
	);
	return JSON.stringify({
		refs,
		delimiter: parsed.delimiter ?? null,
		delimiters: parsed.delimiters ?? null,
		filters: parsed.filters,
	});
}

/** Deterministic level id for a standalone (metadata-only) source. */
function synthLevelId(parsed: ParsedSource): string {
	return firstColumn(parsed.source);
}

/** The one real whole-column source required by a crosswalk column role. */
function singleSourceColumn(source: LevelSource): string | null {
	const refs = toSourceRefs(source);
	if (refs.length !== 1 || isConstantRef(refs[0]) || refs[0].part !== undefined) return null;
	return refs[0].column;
}

/** First column (or literal) referenced by a source — the level's identity key. */
function firstColumn(source: LevelSource): string {
	const ref = toSourceRefs(source)[0];
	return isConstantRef(ref) ? ref.constant : ref.column;
}

/** Strip a trailing `.md` from a file template. */
function stripMd(template: string): string {
	return template.replace(/\.md$/, '');
}

/** Slug a column name into a tag-namespace root (mirrors detection.tagRoot). */
function slug(column: string): string {
	return column
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
