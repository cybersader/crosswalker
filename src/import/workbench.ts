/**
 * workbench.ts — the shape-first mapping workbench (spec 2026-07-05 §1a, mockups M0–M2b).
 *
 * One live screen, three zones, all reading and writing ONE `ImportMapping` (the
 * view-coherence law, spec §3a½/§7a):
 *   - source rail (left): file + shape chip, columns with detection badges,
 *     per-detection evidence cards, and the demoted "all columns" destinations.
 *   - mapping canvas (center): preset bar → one card per mapping (shape-card
 *     toggles + combined preview) → the per-level matrix (full control).
 *   - vault preview rail (right): live folder tree + one rendered note + the
 *     deviation banner, recomputed (debounced) on every model change anywhere.
 *
 * Every write goes through `src/import/mapping/view-model.ts` (pure, unit-tested).
 * This module is the Obsidian-facing view over that model; it holds no business
 * logic the view-model doesn't already own.
 *
 * The demoted "all columns" table (spec §3b) is the one piece kept OUTSIDE the
 * single `ImportMapping`: it is a thin frontmatter-assignment layer merged into
 * the recipe at build time, deliberately not part of the matrix's tri-state
 * coherence (documented deviation — the coherence law governs the shape mappings,
 * which is what §3a½ is about).
 */

import { setIcon } from 'obsidian';
import type { ParsedData, ColumnInfo } from '../types/config';
import { isEagerRows } from '../types/config';
import type { Detection } from './detection';
import { detectStructure, defaultDestinationForColumn } from './detection';
import type { DebugLog } from '../utils/debug';
import {
	render,
	summarizeRenderNotes,
	type Recipe,
	type RenderReport,
	type PreviewRowNotes,
	type Address,
} from '../render';
import {
	BUILT_IN_PRESETS,
	getBuiltInPreset,
	type Preset,
} from './mapping/presets';
import { instantiate } from './mapping/instantiate';
import { collectScalarLinkEmissions, toRecipeRegions, type RecipeRegions } from './mapping/serialize';
import type {
	ImportMapping,
	StructureMapping,
	LevelRule,
	TailRule,
	Destination,
	DestinationPrimitive,
	LevelSource,
	LevelNaming,
	MissingPolicy,
	Enrichment,
} from './mapping/types';
import { toSourceRefs, isConstantRef } from './mapping/types';
import { deriveFacetMemberships } from './mapping/facets';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { isTier1CuriePrefix } from '../validation/validator';
import {
	createFreshRecipeDocument,
	loadRecipeDocument,
	patchRecipeDocument,
	updateRecipeDocumentMapping,
	type RecipeDocument,
	type RecipeDocumentOrigin,
} from './recipe-document';
import {
	SHAPE_CARDS,
	deriveShapeCards,
	toggleDestinationAcrossMapping,
	addDestination,
	removeDestination,
	mergeRows,
	splitRow,
	isUnmodifiedPreset,
	deriveProvenance,
	destKey,
	structuralEqual,
	facetTagColumns,
	buildParentPlacementPreview,
	shapeCardHint,
	blockedPlacingToggle,
	type ShapeCardId,
	type Provenance,
	type PathTreeNode,
} from './mapping/view-model';
import { explainRecipeError } from './mapping/diagnostics';

/** Render the provenance badge(s) for a preset/config surface (spec §7j #3). */
export function renderProvenanceBadge(parent: HTMLElement, prov: Provenance): void {
	parent.createSpan({ cls: `crosswalker-prov-badge is-${prov.origin}`, text: prov.badge });
	if (prov.recommended) {
		parent.createSpan({ cls: 'crosswalker-prov-badge is-recommended', text: 'Recommended' });
	}
}

/** Append a Lucide icon glyph (theme-aware, uniform sizing via `.crosswalker-wb-ico`). */
function wbIcon(parent: HTMLElement, name: string, extraCls = ''): HTMLElement {
	const span = parent.createSpan({ cls: 'crosswalker-wb-ico' + (extraCls ? ' ' + extraCls : '') });
	setIcon(span, name);
	return span;
}

/** Per-column destination in the demoted "all columns" table (spec §3b).
 *  Exported so callers can persist a snapshot of it (draft resume, M8). */
export type ColumnDest = 'property' | 'tag' | 'body' | 'title' | 'alias' | 'link' | 'skip';

/** The subset of primitives the two-stage ⊕ menu offers, grouped by role (spec §3d). */
const ADD_MENU_GROUPS: { group: string; items: { primitive: DestinationPrimitive; label: string }[] }[] = [
	{
		group: 'Structure',
		items: [
			{ primitive: 'folder', label: 'Folder' },
			{ primitive: 'name', label: 'File name' },
			{ primitive: 'note', label: 'Its own note' },
		],
	},
	{
		group: 'Metadata',
		items: [
			{ primitive: 'property', label: 'Property' },
			{ primitive: 'tag', label: 'Tag' },
			{ primitive: 'link', label: 'Link' },
		],
	},
	{
		group: 'Content',
		items: [
			{ primitive: 'heading', label: 'Heading' },
			{ primitive: 'body', label: 'Body' },
			{ primitive: 'alias', label: 'Alias' },
		],
	},
];

/** Affordance + whisper copy for the six shape cards (mockup M2, sentence case). */
const SHAPE_CARD_COPY: Record<ShapeCardId, { icon: string; afford: string; whisper: string }> = {
	folder: { icon: 'folder', afford: 'Browse down into it in the file explorer.', whisper: 'pre-coordinated hierarchy' },
	name: { icon: 'file', afford: 'Keep it flat. The id reads at a glance.', whisper: 'packed notation' },
	tag: { icon: 'tag', afford: 'Filter any combination in search and Bases.', whisper: 'faceted classification' },
	heading: { icon: 'file-text', afford: 'Read top to bottom, one portable outline.', whisper: 'document order' },
	link: { icon: 'link', afford: 'Hop the graph. A note can sit under many parents.', whisper: 'polyhierarchy' },
	property: { icon: 'table', afford: 'Group, sort, and filter by level in Bases.', whisper: 'faceted metadata' },
};

const PREVIEW_ROW_LIMIT = 20;
let workbenchInstanceCounter = 0;

/** Semantic focus target that survives the workbench's full DOM rebuilds. */
type WorkbenchFocusTarget =
	| { kind: 'evidence-badge'; key: string; column: string }
	| { kind: 'evidence-action'; key: string; column: string }
	| { kind: 'chooser-trigger' }
	| { kind: 'chooser-search' }
	| { kind: 'source-restore' }
	| { kind: 'source-collapse' }
	| { kind: 'mapping-card'; index: number };

/** How many sample notes the preview tree renders as clickable rows. */
const TREE_ROW_LIMIT = 12;

export interface WorkbenchOptions {
	parsedData: ParsedData;
	columnInfos: ColumnInfo[];
	outputPath: string;
	debug: DebugLog;
	defaultPresetId: string;
	/**
	 * A persisted mapping to seed the workbench with (draft resume, spec §7i).
	 * When present, it replaces the fresh preset-instantiation so shape decisions
	 * survive a close/reopen. Detections are still computed (for the evidence rail
	 * and the preset-drift chip); only the mapping is taken from here.
	 */
	initialMapping?: ImportMapping;
	/** Full canonical preservation authority for a recognized or resumed recipe. */
	initialRecipe?: CrosswalkerImportRecipe;
	/** Application origin for initialRecipe. Defaults to bundled. */
	recipeOrigin?: RecipeDocumentOrigin;
	/** Deterministic source ontology slug seed for fresh in-memory drafts. */
	sourceOntology?: string;
	/**
	 * Adaptive parent-note default (owner): folder-note when the vault runs a
	 * folder-notes plugin, else sibling. Applied only to a FRESH instantiation
	 * (never overrides a draft's or vetted recipe's explicit choice). The
	 * reason string renders as a hint under the placement chooser.
	 */
	defaultParentNote?: { value: 'sibling' | 'folder-note'; reason?: string };
	/**
	 * Seed the demoted "all columns" table with a default destination per column
	 * (default true). A recognized-recipe fast path (spec §7m) passes `false` so the
	 * workbench emits EXACTLY the vetted recipe — the recipe's frontmatter already
	 * flows from `initialMapping`; auto-seeding would add extra per-column properties
	 * the recipe author deliberately omitted.
	 */
	seedColumnDefaults?: boolean;
	/**
	 * Restore the demoted "all columns" destination table from a persisted draft
	 * (draft resume, M8). When present, this IS the seed — `seedColumnDests()`
	 * is skipped entirely so a manual "route this column to…" choice from a
	 * prior session survives resume instead of being silently re-derived from
	 * the detection heuristic.
	 */
	initialColumnDests?: Record<string, ColumnDest>;
	/**
	 * Restore dismissed evidence-card keys from a persisted draft (draft resume,
	 * M8). Applied BEFORE the mapping is instantiated (constructor order) so a
	 * dismissal from a prior session keeps suppressing its detection — not just
	 * cosmetically re-marking the badge — when `initialMapping` is absent and a
	 * fresh `instantiate()` runs over `activeDetections()`.
	 */
	initialDismissed?: string[];
	/**
	 * True when the vault has a Waypoint-style community plugin enabled
	 * (`detectWaypointPlugin`, 2026-07-11 ICSB audit §4 verdict). Gates the
	 * Connections card's opt-in "also mark folder notes for Waypoint" toggle —
	 * offered only when it would actually do something. Default false (no
	 * toggle shown) when omitted.
	 */
	waypointDetected?: boolean;
	/**
	 * Vault-level Connections defaults (settings § Connections,
	 * `CrosswalkerSettings.defaultEnrichment`). Overlaid onto a FRESH
	 * instantiation's preset enrichment — only the keys actually set here
	 * participate, so an empty/omitted object changes nothing. Precedence
	 * (highest to lowest): a recognized built-in configuration or a resumed
	 * draft/saved mapping both arrive as `initialMapping` and bypass this
	 * entirely; vault defaults > the active preset's own defaults > adaptive
	 * `defaultParentNote` detection (below).
	 */
	vaultDefaults?: Enrichment;
	/** Notified after any model change (for draft save / state mirroring). */
	onChange: () => void;
}

/**
 * The mapping workbench. Construct once per source; call `render(container)` on
 * every wizard re-render (internal state persists on the instance).
 */
export class MappingWorkbench {
	private mapping: ImportMapping;
	private recipeDocument: RecipeDocument;
	private detections: Detection[];
	private dismissed = new Set<string>();
	private presetId: string;
	private columnDests = new Map<string, ColumnDest>();
	private readonly columnSig: string;
	/**
	 * Hand-added mappings (`addManualMapping`), tracked by object reference so
	 * `reinstantiate()` (B3) can carry them forward: a fresh `instantiate()`
	 * only re-derives structure from detections, so anything the user typed in
	 * by hand would otherwise be silently discarded on every preset switch or
	 * evidence dismiss/use. `updateMapping`/`removeMapping` keep the reference
	 * current as the mapping is edited in place.
	 */
	private manualMappings: StructureMapping[] = [];
	/**
	 * Set when `buildRecipe()` throws inside `computePreview()` (B2) — most
	 * commonly the single-structural-mapping guard (`assertSingleStructural`,
	 * serialize.ts). The preview rail and the step-3 review both surface this
	 * as a blocking error instead of a silent "0 deviations" state.
	 */
	private previewError: string | null = null;
	/**
	 * The last shape-card toggle that was refused because it would have left the
	 * import with nowhere to put its notes. Rendered inline under that one card,
	 * and cleared by the next toggle that does apply, so a refusal is never
	 * silent (it used to be: the write simply did nothing).
	 */
	private blockedCard: { mi: number; primitive: DestinationPrimitive; message: string } | null = null;

	// Transient view state (persists across re-renders).
	private expanded = new Set<number>();
	private matrixOpen = new Set<number>();
	private openEvidence: { key: string; column: string } | null = null;
	private mappingChooserOpen = false;
	private mappingChooserQuery = '';
	private pendingFocus: WorkbenchFocusTarget | null = null;
	private allColumnsOpen = false;
	private addMenu: { mi: number; li: number } | null = null;
	private addMenuPrimitive: DestinationPrimitive | null = null;
	private addMenuParams: Record<string, string> = {};
	private selectedNoteRow = 0;
	/** Source visibility is transient to this workbench instance, never persisted. */
	private sourceCollapsed = false;
	private readonly sourceRegionId = `crosswalker-source-${++workbenchInstanceCounter}`;

	private container: HTMLElement | null = null;
	private rerenderTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private opts: WorkbenchOptions) {
		// M8: restore dismissed evidence keys BEFORE anything detection-derived
		// runs (activeDetections()/instantiate() below both read this.dismissed),
		// so a prior-session dismissal keeps suppressing its detection on resume
		// rather than only cosmetically re-marking the badge.
		this.dismissed = new Set(opts.initialDismissed ?? []);
		this.columnSig = opts.parsedData.columns.join('|');
		this.detections = detectStructure(opts.parsedData, opts.columnInfos);
		this.presetId = getBuiltInPreset(opts.defaultPresetId) ? opts.defaultPresetId : 'browsable-framework';
		const loadedRecipe = opts.initialRecipe
			? loadRecipeDocument(opts.initialRecipe, {
				origin: opts.recipeOrigin ?? 'bundled',
				sourceColumns: opts.parsedData.columns,
			})
			: null;
		if (loadedRecipe && !loadedRecipe.ok) {
			throw new Error(loadedRecipe.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
		}
		// A full canonical recipe seeds both the preservation authority and mapping.
		// A resumed legacy draft may still supply only the mapping.
		this.mapping = opts.initialMapping
			?? (loadedRecipe?.ok ? loadedRecipe.document.mapping : instantiate(this.currentPreset(), this.activeDetections()));
		// Vault defaults + adaptive parent_note only apply to a FRESH instantiation.
		if (!opts.initialMapping && !opts.initialRecipe) this.applyDefaultsOverlay();
		// M8: a restored columnDests snapshot IS the seed — never re-run the
		// detection-derived default seeding over it (that would silently reset
		// every manual "route this column to…" choice back to the heuristic
		// default). Otherwise, a recognized-recipe seed (seedColumnDefaults ===
		// false) emits exactly the vetted recipe; only auto-seed per-column
		// defaults in the remaining case (spec §7m).
		if (opts.initialColumnDests) {
			this.columnDests = new Map(Object.entries(opts.initialColumnDests));
		} else if (opts.seedColumnDefaults !== false) {
			this.seedColumnDests();
		}
		if (loadedRecipe?.ok) {
			this.recipeDocument = updateRecipeDocumentMapping(loadedRecipe.document, this.mapping);
		} else {
			const fresh = createFreshRecipeDocument(this.mapping, opts.sourceOntology ?? this.sourceLabel(), {
				sourceColumns: opts.parsedData.columns,
			});
			if (!fresh.ok) throw new Error(fresh.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
			if (this.detections.some((detection) => detection.kind === 'edge-file')) {
				const leaf = [...fresh.document.original.target.layout]
					.reverse()
					.find((entry) => entry.mechanism === 'file' || entry.mechanism === 'heading');
				if (leaf) leaf.kind = 'crosswalk-edge';
			}
			const completeDraft = patchRecipeDocument(fresh.document, {
				mapping: this.mapping,
				regions: this.buildFinalRegions(fresh.document.original.source.ontology),
			});
			this.recipeDocument = {
				...fresh.document,
				original: completeDraft.ok ? completeDraft.recipe : fresh.document.original,
				origin: opts.initialMapping ? 'legacy' : 'fresh',
				mapping: this.mapping,
				dirty: false,
			};
		}
		opts.debug.info('wizard', 'workbench-init', 'Shape workbench initialized', {
			detections: this.detections.length,
			mappings: this.mapping.mappings.length,
			preset: this.presetId,
			seededFromDraft: !!opts.initialMapping,
		});
	}

	/** Signature of the source columns — the wizard recreates the workbench when this changes. */
	columnsSignature(): string {
		return this.columnSig;
	}

	/** The shape mappings (the single coherent model). */
	getMapping(): ImportMapping {
		return this.mapping;
	}

	/** The canonical preservation boundary backing preview and generation. */
	getRecipeDocument(): RecipeDocument {
		return this.recipeDocument;
	}

	/** Snapshot of the demoted "all columns" destinations (draft persistence, M8). */
	getColumnDests(): Record<string, ColumnDest> {
		return Object.fromEntries(this.columnDests);
	}

	/** Snapshot of dismissed evidence-card keys (draft persistence, M8). */
	getDismissed(): string[] {
		return [...this.dismissed];
	}

	/**
	 * The reason `computePreview()` returned null due to `buildRecipe()`
	 * throwing (B2) — most commonly the single-structural-mapping guard. Null
	 * when there is no error (a clean preview, or simply a non-eager source
	 * with nothing to build yet).
	 */
	getPreviewError(): string | null {
		return this.previewError;
	}

	/**
	 * Provenance of the current mapping (spec §7j #3) — feeds the preset badge in
	 * the canvas and the step-3 provenance line. `appliedConfigName` is the name of
	 * a user-saved config in effect (from the wizard), if any.
	 */
	provenance(appliedConfigName: string | null = null): Provenance {
		const preset = this.currentPreset();
		return deriveProvenance({
			presetLabel: preset.label ?? preset.preset,
			isBuiltIn: !!getBuiltInPreset(this.presetId),
			unmodified: isUnmodifiedPreset(this.mapping, preset, this.activeDetections()),
			recommended: this.presetId === this.opts.defaultPresetId,
			appliedConfigName,
		});
	}

	// =========================================================================
	// Recipe assembly (shape mappings + the demoted column layer)
	// =========================================================================

	/** The recipe regions the preview and generation consume. */
	buildFinalRegions(sourceOntologyOverride?: string): RecipeRegions {
		const base = toRecipeRegions(this.mapping);
		const layout = base.layout.map((e) => ({ ...e }));
		const tags = [...(base.also_emit?.tags ?? [])];
		const aliases = [...(base.also_emit?.aliases ?? [])];
		const managed: Record<string, string> = { ...(base.also_emit?.frontmatter?.managed ?? {}) };
		const managedLinks = { ...(base.also_emit?.frontmatter?.managed_links ?? {}) };
		const userPreserve = [...(base.also_emit?.frontmatter?.user_preserve ?? [])];
		const body = [...(base.also_emit?.body ?? [])];
		const bodyCandidates = new Set<string>();
		for (const detection of this.activeDetections()) {
			if (detection.kind === 'body-candidate') bodyCandidates.add(detection.column);
		}
		let primaryBodyUsed = body.some((entry) => entry.position !== 'section');

		for (const [col, dest] of this.columnDests) {
			if (dest === 'skip') continue;
			if (dest === 'body') {
				if (!primaryBodyUsed && bodyCandidates.has(col)) {
					body.push({ template: `{${col}}`, position: 'append', format: 'text', omit_if_empty: true });
					primaryBodyUsed = true;
				} else {
					body.push({
						template: `{${col}}`,
						position: 'section',
						heading: this.keyOf(col),
						heading_depth: 2,
						format: 'text',
						omit_if_empty: true,
					});
				}
				continue;
			}
			const key = this.keyOf(col);
			switch (dest) {
				case 'property':
					if (!(key in managed)) managed[key] = `{${col}}`;
					break;
				case 'tag':
					tags.push(`${this.slug(col)}/{${col}|tagsafe}`);
					break;
				case 'alias':
					aliases.push(`{${col}}`);
					break;
				case 'link':
					if (!(key in managed)) managed[key] = `[[{${col}}]]`;
					break;
				case 'title': {
					// The column becomes the note file name — replace the leaf file entry.
					const fileEntry = layout.find((e) => e.mechanism === 'file');
					if (fileEntry) fileEntry.template = `{${col}}.md`;
					else layout.push({ level: 'leaf', mechanism: 'file', template: `{${col}}.md` });
					break;
				}
			}
		}

		if (!(Object.prototype.hasOwnProperty.call(managed, 'parent_curie'))) {
			const finalParentTemplate = managed.parent;
			if (finalParentTemplate) {
				const activeParents = this.activeDetections().filter(
					(detection): detection is Extract<Detection, { kind: 'parent-column' }> => detection.kind === 'parent-column',
				);
				const emission = collectScalarLinkEmissions(this.mapping)
					.reverse()
					.find((entry) =>
						entry.key === 'parent'
						&& entry.detectionBacked
						&& entry.predicate === 'skos:broader'
						&& entry.template === finalParentTemplate
						&& entry.sourceColumns.length === 1
						&& activeParents.some((detection) => detection.column === entry.sourceColumns[0]),
					);
				if (emission) {
					const detection = activeParents.find((candidate) => candidate.column === emission.sourceColumns[0])!;
					if (detection.parentIdentityMode === 'raw-curie') {
						managed.parent_curie = `{${detection.column}|optional}`;
					} else {
						const ontology = sourceOntologyOverride ?? this.recipeDocument.original.source.ontology;
						if (!isTier1CuriePrefix(ontology)) {
							throw new Error(
								'Cannot derive parent_curie: recipe source.ontology must be a lowercase CURIE prefix (letters, digits, _ or -; first character must be a letter).',
							);
						}
						managed.parent_curie = `{${detection.column}|optional|curie-prefix(${ontology})}`;
					}
				}
			}
		}

		const alsoEmit: RecipeRegions['also_emit'] = {};
		if (tags.length) alsoEmit.tags = tags;
		if (aliases.length) alsoEmit.aliases = aliases;
		if (body.length) alsoEmit.body = body;
		if (Object.keys(managed).length || Object.keys(managedLinks).length || userPreserve.length) {
			alsoEmit.frontmatter = {};
			if (Object.keys(managed).length) alsoEmit.frontmatter.managed = managed;
			if (Object.keys(managedLinks).length) alsoEmit.frontmatter.managed_links = managedLinks;
			if (userPreserve.length) alsoEmit.frontmatter.user_preserve = userPreserve;
		}
		const hasAlsoEmit = tags.length
			|| aliases.length
			|| body.length
			|| Object.keys(managed).length
			|| Object.keys(managedLinks).length
			|| userPreserve.length;
		const regions: RecipeRegions = hasAlsoEmit ? { layout, also_emit: alsoEmit } : { layout };
		// §7o root cause: toRecipeRegions(this.mapping) computes `base.enrichment`
		// (Pass 1.5 batch enrichment — children lists, facet hubs, edge stats), but
		// this method was rebuilding a fresh regions literal that dropped it, so
		// enrichment never reached generation on the workbench path. Carry it through.
		if (base.enrichment) regions.enrichment = base.enrichment;
		return regions;
	}

	/** A full canonical Recipe for render() / generation. */
	buildRecipe(): Recipe {
		const patched = patchRecipeDocument(this.recipeDocument, {
			mapping: this.mapping,
			regions: this.buildFinalRegions(),
		});
		if (!patched.ok) {
			throw new Error(
				patched.diagnostics
					.filter((diagnostic) => diagnostic.severity === 'blocking')
					.map((diagnostic) => diagnostic.message)
					.join('; '),
			);
		}
		this.recipeDocument = {
			...this.recipeDocument,
			mapping: this.mapping,
			dirty: patched.dirty,
		};
		return patched.recipe as Recipe;
	}

	/** Columns the user routed to the note body — fed to the legacy body path at generate time. */
	getLegacyBodyMappings(): { column: string; heading: string }[] {
		// The primary body column (a detected body-candidate) becomes the clean
		// document body: H1 + plain prose, no '## <key>' section heading. Secondary
		// body columns keep their key as a section heading so several bodies stay
		// distinguishable.
		const bodyCandidates = new Set<string>();
		for (const d of this.activeDetections()) {
			if (d.kind === 'body-candidate') bodyCandidates.add(d.column);
		}
		const out: { column: string; heading: string }[] = [];
		let primaryUsed = false;
		for (const [col, dest] of this.columnDests) {
			if (dest !== 'body') continue;
			if (!primaryUsed && bodyCandidates.has(col)) {
				out.push({ column: col, heading: '' });
				primaryUsed = true;
			} else {
				out.push({ column: col, heading: this.keyOf(col) });
			}
		}
		return out;
	}

	/** The leaf file template (used to give generation a stable curie stem). */
	leafFileTemplate(): string | undefined {
		const entry = this.buildFinalRegions().layout.find((e) => e.mechanism === 'file');
		return entry?.template;
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	render(container: HTMLElement): void {
		this.container = container;
		container.empty();
		const grid = container.createDiv({
			cls: 'crosswalker-workbench' + (this.sourceCollapsed ? ' is-source-collapsed' : ''),
		});
		this.renderSourceRail(grid.createDiv({
			cls: 'crosswalker-wb-rail crosswalker-wb-source',
			attr: { id: this.sourceRegionId },
		}));
		this.renderCanvas(grid.createDiv({ cls: 'crosswalker-wb-canvas' }));
		this.renderPreviewRail(grid.createDiv({ cls: 'crosswalker-wb-rail crosswalker-wb-preview' }));

		// Escape and click-away stay scoped to this workbench. The workspace (tab)
		// host registers no Obsidian Scope, so this local listener is its only
		// Escape path. The modal host does register one, and that binding always
		// consumes Escape, so whichever of the two runs first the outcome is the
		// same: there, this listener is redundant rather than load-bearing.
		grid.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape' || !this.closeTransientUi()) return;
			event.preventDefault();
			event.stopPropagation();
		});
		grid.addEventListener('click', (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			let changed = false;
			if (
				this.openEvidence
				&& !target.closest('.crosswalker-wb-evidence')
				&& !target.closest('.crosswalker-wb-badge')
			) {
				this.openEvidence = null;
				changed = true;
			}
			if (
				this.mappingChooserOpen
				&& !target.closest('.crosswalker-wb-mapping-chooser')
				&& !target.closest('.crosswalker-wb-addmapping-trigger')
			) {
				this.mappingChooserOpen = false;
				this.mappingChooserQuery = '';
				this.pendingFocus = { kind: 'chooser-trigger' };
				changed = true;
			}
			if (changed) this.scheduleRerender();
		});
		this.restorePendingFocus(grid);
	}

	/**
	 * Close the topmost transient workbench surface. Modal hosts call this from
	 * their Obsidian Scope so Escape is consumed before Modal closes; workspace
	 * hosts reach the same path through the workbench-local keydown listener.
	 *
	 * This method is the modal host's Escape close-suppression allow-list: any new
	 * transient surface (popover, inline confirmation) must be closed here, or
	 * Escape will tear down the whole wizard instead of just that surface.
	 */
	closeTransientUi(): boolean {
		if (this.mappingChooserOpen) {
			this.mappingChooserOpen = false;
			this.mappingChooserQuery = '';
			this.pendingFocus = { kind: 'chooser-trigger' };
		} else if (this.openEvidence) {
			this.pendingFocus = { kind: 'evidence-badge', ...this.openEvidence };
			this.openEvidence = null;
		} else {
			return false;
		}
		this.scheduleRerender();
		return true;
	}

	/** Resolve a semantic focus target against the newly rendered, visible DOM. */
	private restorePendingFocus(grid: HTMLElement): void {
		const target = this.pendingFocus;
		if (!target) return;
		this.pendingFocus = null;
		let element: HTMLElement | null = null;
		if (target.kind === 'evidence-badge' || target.kind === 'evidence-action') {
			const selector = target.kind === 'evidence-badge'
				? '.crosswalker-wb-badge'
				: '.crosswalker-wb-evidence-action';
			element = Array.from(grid.querySelectorAll<HTMLElement>(selector)).find(
				(el) => el.dataset.detectionKey === target.key
					&& el.dataset.column === target.column
					&& this.isVisibleFocusTarget(el),
			) ?? null;
		} else if (target.kind === 'chooser-trigger') {
			element = grid.querySelector<HTMLElement>('.crosswalker-wb-addmapping-trigger');
		} else if (target.kind === 'chooser-search') {
			element = grid.querySelector<HTMLElement>('.crosswalker-wb-chooser-search');
		} else if (target.kind === 'source-restore') {
			element = Array.from(grid.querySelectorAll<HTMLElement>('[data-source-control="restore"]'))
				.find((el) => this.isVisibleFocusTarget(el)) ?? null;
		} else if (target.kind === 'source-collapse') {
			element = Array.from(grid.querySelectorAll<HTMLElement>('[data-source-control="collapse"]'))
				.find((el) => this.isVisibleFocusTarget(el)) ?? null;
		} else {
			element = grid.querySelector<HTMLElement>(`.crosswalker-wb-mapcard[data-mapping-index="${target.index}"]`);
		}
		if (element && this.isVisibleFocusTarget(element)) element.focus();
	}

	/** CSS-hidden duplicate restore controls must never receive focus. */
	private isVisibleFocusTarget(element: HTMLElement): boolean {
		if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
		let current: HTMLElement | null = element;
		while (current) {
			const style = getComputedStyle(current);
			if (style.display === 'none' || style.visibility === 'hidden') return false;
			current = current.parentElement;
		}
		return element.getClientRects().length > 0;
	}

	/** Schedule a full re-render; `delay` debounces text-input-driven updates (~300ms). */
	private scheduleRerender(delay = 0): void {
		if (this.rerenderTimer) clearTimeout(this.rerenderTimer);
		this.rerenderTimer = setTimeout(() => {
			this.rerenderTimer = null;
			if (this.container) this.render(this.container);
		}, delay);
	}

	/** Commit a model change: persist via onChange, then re-render. */
	private applyChange(delay = 0): void {
		let regions: RecipeRegions | undefined;
		try {
			regions = this.buildFinalRegions();
		} catch {
			// The preview/generation path surfaces the full blocking diagnostic.
		}
		this.recipeDocument = updateRecipeDocumentMapping(this.recipeDocument, this.mapping, regions);
		this.opts.onChange();
		this.scheduleRerender(delay);
	}

	/**
	 * Replace mapping[mi] with `next`, keeping `manualMappings`' tracked
	 * references coherent (B3: `updateMapping` swaps in a brand-new object on
	 * every edit, so a hand-added mapping's tracked reference must move with
	 * it or `reinstantiate()`'s carry-forward would stop recognizing it after
	 * its first edit). Does not commit — callers call `applyChange()`.
	 */
	private replaceMappingAt(mi: number, next: StructureMapping): void {
		const old = this.mapping.mappings[mi];
		const mappings = this.mapping.mappings.map((m, i) => (i === mi ? next : m));
		this.mapping = { ...this.mapping, mappings };
		const manualIdx = this.manualMappings.indexOf(old);
		if (manualIdx !== -1) this.manualMappings[manualIdx] = next;
	}

	/** Replace one shape mapping and commit. */
	private updateMapping(mi: number, next: StructureMapping, delay = 0): void {
		this.replaceMappingAt(mi, next);
		this.applyChange(delay);
	}

	/**
	 * Shape-card toggle (M2's on/off/mixed cards). Also reconciles
	 * `enrichment.facet_notes` (M9): if this toggle just turned off the last
	 * tag-emitting destination anywhere in the mapping, "Create hub notes for"
	 * has nothing left to group by — clear it back to `'none'` so the
	 * Connections card doesn't keep rendering a stale selection with zero
	 * facet columns behind it.
	 *
	 * Returns FALSE when the toggle was refused (turning it off would leave the
	 * import with no folder, file name or one file anywhere, so generation would
	 * have nowhere to put its notes). The caller restores the checkbox and the
	 * refusal renders under the card; it is never swallowed.
	 */
	private toggleShapeCard(mi: number, m: StructureMapping, primitive: DestinationPrimitive, on: boolean): boolean {
		const blocked = blockedPlacingToggle(this.mapping, mi, primitive, on);
		if (blocked) {
			this.blockedCard = { mi, primitive, message: blocked };
			this.scheduleRerender();
			return false;
		}
		this.blockedCard = null;
		this.replaceMappingAt(mi, toggleDestinationAcrossMapping(m, primitive, on));
		if (primitive === 'tag' && !on) {
			const enrichment = this.mapping.enrichment;
			if (enrichment?.facet_notes && enrichment.facet_notes !== 'none' && facetTagColumns(this.mapping).length === 0) {
				this.mapping = { ...this.mapping, enrichment: { ...enrichment, facet_notes: 'none' } };
			}
		}
		this.applyChange();
		return true;
	}

	/** Patch the batch-scope enrichment block (Pass 1.5, spec §7k) and commit.
	 *  Serializes straight to recipe `target.enrichment` (`toRecipeRegions`
	 *  copies `mapping.enrichment` through unchanged — see `serialize.ts`). */
	private updateEnrichment(patch: Partial<Enrichment>): void {
		this.mapping = { ...this.mapping, enrichment: { ...(this.mapping.enrichment ?? {}), ...patch } };
		this.applyChange();
	}

	// -------------------------------------------------------------------------
	// Zone 1 — source rail
	// -------------------------------------------------------------------------

	private renderSourceRail(rail: HTMLElement): void {
		const { parsedData, columnInfos } = this.opts;
		if (this.sourceCollapsed) {
			const compact = rail.createDiv({ cls: 'crosswalker-wb-source-disclosure' });
			compact.createSpan({ cls: 'crosswalker-wb-source-disclosure-label', text: 'Source' });
			compact.createSpan({
				cls: 'crosswalker-wb-source-disclosure-summary',
				text: `${parsedData.rowCount.toLocaleString()} rows · ${parsedData.columns.length.toLocaleString()} columns`,
			});
			this.renderSourceRestoreButton(compact, 'crosswalker-wb-source-restore is-compact');
			return;
		}

		const eyebrowRow = rail.createDiv({ cls: 'crosswalker-wb-eyebrow crosswalker-wb-eyebrow-row' });
		eyebrowRow.createSpan({ text: 'Source' });
		const collapseBtn = eyebrowRow.createEl('button', {
			cls: 'crosswalker-wb-collapse-btn',
			attr: {
				title: 'Hide source',
				'aria-label': 'Hide source',
				'aria-controls': this.sourceRegionId,
				'aria-expanded': 'true',
				'data-source-control': 'collapse',
			},
		});
		wbIcon(collapseBtn, 'chevrons-left');
		collapseBtn.addEventListener('click', () => {
			this.sourceCollapsed = true;
			this.pendingFocus = { kind: 'source-restore' };
			this.scheduleRerender();
		});

		const fileLine = rail.createDiv({ cls: 'crosswalker-wb-source-file' });
		fileLine.createEl('b', { text: this.sourceLabel() });
		rail.createDiv({
			cls: 'crosswalker-wb-chip',
			text: `table · ${parsedData.rowCount.toLocaleString()} rows × ${parsedData.columns.length} columns`,
		});

		const detectedColumns = columnInfos.filter((c) => this.detectionsForColumn(c.name).length > 0);
		rail.createDiv({ cls: 'crosswalker-wb-detected-heading', text: 'Detected structure' });
		if (detectedColumns.length > 0) {
			rail.createDiv({
				cls: 'crosswalker-wb-collist-hint',
				text: 'Inspect the evidence behind each automatic suggestion.',
			});
		}

		// Only columns with findings belong in the compact detected-structure list.
		// Dismissed findings remain visible here because dismissal changes automatic
		// mapping, not the evidence Crosswalker observed in the source.
		const colList = rail.createDiv({ cls: 'crosswalker-wb-collist' });
		if (detectedColumns.length === 0) {
			colList.createDiv({ cls: 'crosswalker-wb-detected-empty', text: 'No structural patterns detected.' });
		}
		for (const col of detectedColumns) {
			const dets = this.detectionsForColumn(col.name);
			const row = colList.createDiv({ cls: 'crosswalker-wb-colrow' });
			row.createSpan({ cls: 'crosswalker-wb-colname mono', text: col.name });
			const badges = row.createSpan({ cls: 'crosswalker-wb-badges' });
			for (const d of dets) {
				const key = this.detectionKey(d);
				const active = this.openEvidence?.key === key && this.openEvidence.column === col.name;
				const badge = badges.createEl('button', {
					cls: 'crosswalker-wb-badge'
						+ (this.dismissed.has(key) ? ' is-dismissed' : '')
						+ (active ? ' is-active' : ''),
					attr: {
						title: this.badgeTitle(d),
						'aria-label': `${this.badgeTitle(d)} evidence for ${col.name}`,
						'aria-expanded': active ? 'true' : 'false',
						'data-detection-key': key,
						'data-column': col.name,
					},
				});
				wbIcon(badge, this.badgeIcon(d), 'crosswalker-wb-badge-icon');
				badge.createSpan({ cls: 'crosswalker-wb-badge-label', text: this.badgeLabel(d) });
				badge.addEventListener('click', () => {
					this.openEvidence = active ? null : { key, column: col.name };
					this.pendingFocus = { kind: 'evidence-badge', key, column: col.name };
					this.scheduleRerender();
				});
			}

			if (this.openEvidence?.column === col.name) {
				const openDet = dets.find((d) => this.detectionKey(d) === this.openEvidence?.key);
				if (openDet) this.renderEvidenceCard(colList, openDet, col);
			}
		}

		// Exhaustive destination routing stays available without diluting the evidence list.
		this.renderAllColumns(rail);
	}

	private renderEvidenceCard(parent: HTMLElement, d: Detection, columnInfo: ColumnInfo): void {
		const key = this.detectionKey(d);
		const column = columnInfo.name;
		const card = parent.createDiv({
			cls: 'crosswalker-wb-evidence',
			attr: { 'data-detection-key': key, 'data-column': column },
		});
		const header = card.createDiv({ cls: 'crosswalker-wb-evidence-head' });
		const context = header.createDiv({ cls: 'crosswalker-wb-evidence-context' });
		context.createSpan({ cls: 'crosswalker-wb-evidence-context-label', text: 'Source column' });
		context.createEl('code', { text: column });
		const close = header.createEl('button', {
			cls: 'crosswalker-wb-evidence-close',
			attr: { title: 'Close evidence', 'aria-label': `Close evidence for ${column}` },
		});
		setIcon(close, 'x');
		close.addEventListener('click', () => {
			this.openEvidence = null;
			this.pendingFocus = { kind: 'evidence-badge', key, column };
			this.scheduleRerender();
		});

		card.createDiv({ cls: 'crosswalker-wb-evidence-title', text: this.evidenceTitle(d) });
		const noticed = card.createDiv({ cls: 'crosswalker-wb-evidence-section' });
		noticed.createDiv({ cls: 'crosswalker-wb-evidence-label', text: 'What Crosswalker noticed' });
		noticed.createDiv({ cls: 'crosswalker-wb-evidence-copy', text: this.evidenceNotice(d) });

		const coverage = card.createDiv({ cls: 'crosswalker-wb-evidence-section' });
		coverage.createDiv({ cls: 'crosswalker-wb-evidence-label', text: 'Coverage' });
		coverage.createDiv({ cls: 'crosswalker-wb-evidence-cov', text: this.evidenceCoverage(d, column) });

		// Depth distribution is meaningful only for a packed hierarchy.
		if (d.kind === 'packed-hierarchy') {
			const histSection = card.createDiv({ cls: 'crosswalker-wb-evidence-section' });
			histSection.createDiv({ cls: 'crosswalker-wb-evidence-label', text: 'Depth histogram' });
			const hist = histSection.createDiv({ cls: 'crosswalker-wb-hist' });
			const entries = Object.entries(d.depthHistogram).sort((a, b) => Number(a[0]) - Number(b[0]));
			const max = Math.max(1, ...entries.map(([, n]) => n));
			for (const [depth, n] of entries) {
				const col = hist.createDiv({ cls: 'crosswalker-wb-hcol' });
				const bar = col.createDiv({ cls: 'crosswalker-wb-hbar' });
				bar.style.height = `${Math.round((n / max) * 44) + 4}px`;
				col.createDiv({ cls: 'crosswalker-wb-hlabel', text: `${depth} lvl` });
				col.createDiv({ cls: 'crosswalker-wb-hcount', text: String(n) });
			}
		}

		const examples = card.createDiv({ cls: 'crosswalker-wb-evidence-section' });
		examples.createDiv({ cls: 'crosswalker-wb-evidence-label', text: `Examples from ${column}` });
		const sampleValues = [...new Set(
			columnInfo.sampleValues
				.filter((value) => value !== null && value !== undefined && String(value).length > 0)
				.map((value) => String(value)),
		)];
		if (sampleValues.length > 0) {
			const samples = examples.createDiv({ cls: 'crosswalker-wb-samples mono' });
			for (const value of sampleValues.slice(0, 5)) samples.createDiv({ text: String(value) });
		} else {
			examples.createDiv({ cls: 'crosswalker-wb-evidence-copy is-muted', text: 'No non-empty examples available.' });
		}

		const effect = card.createDiv({ cls: 'crosswalker-wb-evidence-section' });
		effect.createDiv({ cls: 'crosswalker-wb-evidence-label', text: 'Effect on automatic mapping' });
		effect.createDiv({ cls: 'crosswalker-wb-evidence-copy', text: this.evidenceEffect(d) });

		const dismissed = this.dismissed.has(key);
		const footer = card.createDiv({ cls: 'crosswalker-wb-evidence-footer' });
		footer.createSpan({
			cls: 'crosswalker-wb-evidence-status' + (dismissed ? ' is-ignored' : ' is-included'),
			text: dismissed ? 'Ignored by automatic mapping' : 'Included in automatic mapping',
		});
		const action = footer.createEl('button', {
			cls: 'crosswalker-wb-evidence-action',
			text: dismissed ? 'Use this detection' : 'Ignore this detection',
			attr: { 'data-detection-key': key, 'data-column': column },
		});
		action.addEventListener('click', () => {
			if (dismissed) this.dismissed.delete(key);
			else this.dismissed.add(key);
			this.pendingFocus = { kind: 'evidence-action', key, column };
			this.reinstantiate();
		});
	}

	private renderAllColumns(rail: HTMLElement): void {
		const details = rail.createEl('details', { cls: 'crosswalker-wb-allcols' });
		if (this.allColumnsOpen) details.setAttr('open', '');
		details.addEventListener('toggle', () => {
			this.allColumnsOpen = (details as HTMLDetailsElement).open;
		});
		details.createEl('summary', { text: `Column destinations (${this.opts.columnInfos.length})` });
		details.createDiv({
			cls: 'crosswalker-wb-allcols-explainer',
			text: 'Choose where each source column goes, including columns without detected structure.',
		});
		const structural = this.structuralColumns();
		for (const col of this.opts.columnInfos) {
			const r = details.createDiv({ cls: 'crosswalker-wb-allcol-row' });
			r.createSpan({ cls: 'crosswalker-wb-colname mono', text: col.name });
			const sel = r.createEl('select', { cls: 'dropdown' });
			for (const [value, label] of [
				['property', 'Property'],
				['tag', 'Tag'],
				['body', 'Body'],
				['title', 'Title'],
				['alias', 'Alias'],
				['link', 'Link'],
				['skip', 'Skip'],
			] as const) {
				sel.createEl('option', { text: label, attr: { value } });
			}
			sel.value = this.columnDests.get(col.name) ?? (structural.has(col.name) ? 'skip' : 'property');
			sel.addEventListener('change', () => {
				this.columnDests.set(col.name, sel.value as ColumnDest);
				this.applyChange();
			});
		}
	}

	private renderSourceRestoreButton(parent: HTMLElement, cls: string): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls,
			attr: {
				'aria-controls': this.sourceRegionId,
				'aria-expanded': 'false',
				'data-source-control': 'restore',
			},
		});
		wbIcon(button, 'chevrons-right');
		button.createSpan({ text: 'Show source' });
		button.addEventListener('click', () => {
			this.sourceCollapsed = false;
			this.pendingFocus = { kind: 'source-collapse' };
			this.scheduleRerender();
		});
		return button;
	}

	// -------------------------------------------------------------------------
	// Zone 2 — mapping canvas
	// -------------------------------------------------------------------------

	private renderCanvas(canvas: HTMLElement): void {
		const eyebrow = canvas.createDiv({ cls: 'crosswalker-wb-eyebrow crosswalker-wb-eyebrow-row' });
		eyebrow.createSpan({ text: 'Mappings' });
		if (this.sourceCollapsed) {
			this.renderSourceRestoreButton(eyebrow, 'crosswalker-wb-source-restore is-canvas');
		}

		// Preset bar.
		const presetBar = canvas.createDiv({ cls: 'crosswalker-wb-presetbar' });
		presetBar.createSpan({ text: 'Preset' });
		const presetSel = presetBar.createEl('select', { cls: 'dropdown' });
		for (const [id, preset] of Object.entries(BUILT_IN_PRESETS)) {
			// Provenance tags in the option labels (spec §7j #3): built-in, and the
			// default preset is called out as recommended.
			const tags = [
				'built-in',
				...(id === this.opts.defaultPresetId ? ['recommended'] : []),
			];
			presetSel.createEl('option', { text: `${preset.label ?? id} · ${tags.join(' · ')}`, attr: { value: id } });
		}
		presetSel.value = this.presetId;
		presetSel.addEventListener('change', () => {
			this.presetId = presetSel.value;
			this.reinstantiate();
		});
		renderProvenanceBadge(presetBar, this.provenance());

		// Manual mapping is a first-class next step, directly below the preset.
		this.renderMappingChooser(canvas);

		// One card per mapping.
		if (this.mapping.mappings.length === 0) {
			canvas.createDiv({
				cls: 'crosswalker-wb-empty',
				text: 'No automatic mappings yet. Use Add mapping from a column to create one.',
			});
		}
		this.mapping.mappings.forEach((m, mi) => this.renderMappingCard(canvas, m, mi));

		// Connections — the Pass 1.5 batch-enrichment block gets its own controls
		// (spec §7k, "generated vaults must be graphs, not filing cabinets").
		if (this.mapping.mappings.length > 0) this.renderConnections(canvas);
	}

	private renderMappingChooser(canvas: HTMLElement): void {
		const addRow = canvas.createDiv({ cls: 'crosswalker-wb-addmapping' });
		const trigger = addRow.createEl('button', {
			cls: 'crosswalker-wb-addmapping-trigger',
			attr: {
				'aria-expanded': this.mappingChooserOpen ? 'true' : 'false',
				'aria-controls': 'crosswalker-mapping-chooser',
			},
		});
		wbIcon(trigger, 'plus');
		trigger.createSpan({ text: 'Add mapping from a column' });
		trigger.addEventListener('click', () => {
			this.mappingChooserOpen = !this.mappingChooserOpen;
			this.mappingChooserQuery = '';
			this.pendingFocus = this.mappingChooserOpen
				? { kind: 'chooser-search' }
				: { kind: 'chooser-trigger' };
			this.scheduleRerender();
		});
		if (!this.mappingChooserOpen) return;

		const chooser = addRow.createDiv({
			cls: 'crosswalker-wb-mapping-chooser',
			attr: { id: 'crosswalker-mapping-chooser' },
		});
		const head = chooser.createDiv({ cls: 'crosswalker-wb-chooser-head' });
		const heading = head.createDiv();
		heading.createDiv({ cls: 'crosswalker-wb-chooser-title', text: 'Choose a source column' });
		heading.createDiv({ cls: 'crosswalker-wb-chooser-hint', text: 'Search names or example values.' });
		const close = head.createEl('button', {
			cls: 'crosswalker-wb-chooser-close',
			attr: { title: 'Close column chooser', 'aria-label': 'Close column chooser' },
		});
		setIcon(close, 'x');
		close.addEventListener('click', () => {
			this.mappingChooserOpen = false;
			this.mappingChooserQuery = '';
			this.pendingFocus = { kind: 'chooser-trigger' };
			this.scheduleRerender();
		});

		const search = chooser.createEl('input', {
			cls: 'crosswalker-wb-chooser-search',
			type: 'search',
			placeholder: 'Search column names or sample values',
			attr: { 'aria-label': 'Search source columns' },
		});
		search.value = this.mappingChooserQuery;
		const results = chooser.createDiv({ cls: 'crosswalker-wb-chooser-results' });
		const renderResults = () => {
			results.empty();
			const matches = this.mappingChooserMatches(this.mappingChooserQuery);
			if (matches.length === 0) {
				results.createDiv({ cls: 'crosswalker-wb-chooser-empty', text: 'No columns match this search.' });
				return;
			}
			for (const info of matches) {
				const option = results.createEl('button', {
					cls: 'crosswalker-wb-chooser-option',
					attr: { 'data-column': info.name },
				});
				option.createDiv({ cls: 'crosswalker-wb-chooser-column mono', text: info.name });
				const metadata = option.createDiv({ cls: 'crosswalker-wb-column-meta' });
				metadata.createSpan({ text: `Type: ${info.detectedType}` });
				metadata.createSpan({ text: `${info.uniqueCount.toLocaleString()} unique` });
				metadata.createSpan({ text: info.hasEmptyValues ? 'Contains empty values' : 'No empty values' });
				const sampleValues = info.sampleValues
					.filter((value) => value !== null && value !== undefined && String(value).length > 0)
					.map((value) => String(value));
				const needle = this.mappingChooserQuery.trim().toLocaleLowerCase();
				const samples = needle
					? [
						...sampleValues.filter((value) => value.toLocaleLowerCase().includes(needle)),
						...sampleValues.filter((value) => !value.toLocaleLowerCase().includes(needle)),
					].slice(0, 3)
					: sampleValues.slice(0, 3);
				option.createDiv({
					cls: 'crosswalker-wb-column-samples',
					text: samples.length > 0 ? `Examples: ${samples.join(' · ')}` : 'Examples: none available',
				});
				option.addEventListener('click', () => {
					const newIndex = this.mapping.mappings.length;
					this.mappingChooserOpen = false;
					this.mappingChooserQuery = '';
					this.pendingFocus = { kind: 'mapping-card', index: newIndex };
					this.addManualMapping(info.name);
				});
			}
		};
		search.addEventListener('input', () => {
			this.mappingChooserQuery = search.value;
			renderResults();
		});
		renderResults();
	}

	/** Source-order, case-insensitive matches, capped so a wide source stays usable. */
	private mappingChooserMatches(query: string): ColumnInfo[] {
		const infoByName = new Map(this.opts.columnInfos.map((info) => [info.name, info]));
		const needle = query.trim().toLocaleLowerCase();
		return this.opts.parsedData.columns
			.map((column) => infoByName.get(column))
			.filter((info): info is ColumnInfo => info !== undefined)
			.filter((info) => {
				if (!needle) return true;
				if (info.name.toLocaleLowerCase().includes(needle)) return true;
				return info.sampleValues.some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
			})
			.slice(0, 50);
	}

	private renderMappingCard(canvas: HTMLElement, m: StructureMapping, mi: number): void {
		const card = canvas.createDiv({
			cls: 'crosswalker-wb-mapcard',
			attr: { tabindex: '-1', 'data-mapping-index': String(mi) },
		});
		const head = card.createDiv({ cls: 'crosswalker-wb-mapcard-head' });
		const expanded = this.expanded.has(mi);
		const toggle = head.createEl('button', { cls: 'crosswalker-wb-mapcard-toggle', text: expanded ? '▾' : '▸' });
		toggle.addEventListener('click', () => {
			if (expanded) this.expanded.delete(mi);
			else this.expanded.add(mi);
			this.scheduleRerender();
		});
		head.createEl('b', { text: this.mappingTitle(m) });
		// Destination summary chips.
		const summary = deriveShapeCards(m);
		const chips = head.createSpan({ cls: 'crosswalker-wb-summary-chips' });
		for (const { id, label } of SHAPE_CARDS) {
			const state = summary[id];
			if (state === 'off') continue;
			const chip = chips.createSpan({ cls: 'crosswalker-wb-chip' + (state === 'mixed' ? ' is-mixed' : '') });
			wbIcon(chip, SHAPE_CARD_COPY[id].icon);
			chip.createSpan({ text: label + (state === 'mixed' ? ' (some)' : '') });
		}
		// Remove-mapping button.
		const rm = head.createEl('button', { cls: 'crosswalker-wb-mapcard-rm', attr: { title: 'Remove this mapping', 'aria-label': 'Remove this mapping' } });
		setIcon(rm, 'x');
		rm.addEventListener('click', () => this.removeMapping(mi));

		if (!expanded) return;

		// Shape cards.
		this.renderShapeCards(card, m, mi);

		// Combined preview — one sample row through the whole mix.
		this.renderCombinedPreview(card, mi);

		// Arrange levels → the matrix.
		const arrange = card.createEl('button', {
			cls: 'crosswalker-wb-arrange',
			text: (this.matrixOpen.has(mi) ? '▾' : '▸') + ' Arrange levels (combine or drop id levels)',
		});
		arrange.addEventListener('click', () => {
			if (this.matrixOpen.has(mi)) this.matrixOpen.delete(mi);
			else this.matrixOpen.add(mi);
			this.scheduleRerender();
		});
		if (this.matrixOpen.has(mi)) this.renderMatrix(card, m, mi);
	}

	private renderShapeCards(card: HTMLElement, m: StructureMapping, mi: number): void {
		const states = deriveShapeCards(m);
		const sampleValue = this.firstSampleValue(m);
		const grid = card.createDiv({ cls: 'crosswalker-wb-shapes' });
		for (const { id, label, primitive } of SHAPE_CARDS) {
			const state = states[id];
			const copy = SHAPE_CARD_COPY[id];
			// A card no row of this mapping can carry used to render as a plain
			// "Off" card whose checkbox silently did nothing. Say why instead.
			const hint = shapeCardHint(m, primitive, { sampleValue });
			const blocked = this.blockedCard && this.blockedCard.mi === mi && this.blockedCard.primitive === primitive
				? this.blockedCard.message
				: null;
			const stateLabel = hint
				? 'Not available'
				: state === 'on' ? 'On' : state === 'mixed' ? 'Some levels' : 'Off';
			const shape = grid.createDiv({
				cls: 'crosswalker-wb-shape'
					+ (state === 'on' ? ' is-on' : state === 'mixed' ? ' is-mixed' : '')
					+ (hint ? ' is-unavailable' : ''),
			});
			const noteId = `${this.sourceRegionId}-shape-${mi}-${id}`;
			const control = shape.createEl('label', { cls: 'crosswalker-wb-shape-control' });
			const cb = control.createEl('input', { type: 'checkbox' });
			cb.checked = state === 'on';
			cb.indeterminate = state === 'mixed';
			if (state === 'mixed') cb.setAttr('aria-checked', 'mixed');
			if (hint) {
				cb.disabled = true;
				cb.setAttr('aria-describedby', noteId);
			}
			cb.addEventListener('change', () => {
				if (this.toggleShapeCard(mi, m, primitive, cb.checked)) return;
				// Refused: keep the control showing what the mapping actually says.
				cb.checked = state === 'on';
				cb.indeterminate = state === 'mixed';
			});
			const title = control.createSpan({ cls: 'crosswalker-wb-shape-title' });
			wbIcon(title, copy.icon);
			title.createSpan({ text: label });
			control.createSpan({ cls: 'crosswalker-wb-shape-state', text: stateLabel });

			this.renderShapeIllustration(shape, id);
			const details = shape.createEl('details', { cls: 'crosswalker-wb-shape-details' });
			details.createEl('summary', { text: 'What this does' });
			details.createDiv({ cls: 'crosswalker-wb-shape-afford', text: copy.afford });
			details.createDiv({ cls: 'crosswalker-wb-whisper', text: copy.whisper });
			if (hint) {
				shape.createDiv({ cls: 'crosswalker-wb-shape-hint', text: hint, attr: { id: noteId } });
			} else if (blocked) {
				shape.createDiv({ cls: 'crosswalker-wb-shape-hint is-blocked', text: blocked });
			}
		}
	}

	/** A real value from the column a mapping reads, for worked examples in hints. */
	private firstSampleValue(m: StructureMapping): string | null {
		const source = m.levels[0]?.source;
		if (!source) return null;
		const column = this.firstColumn(source);
		const info = this.opts.columnInfos.find((c) => c.name === column);
		const value = info?.sampleValues.find((v) => String(v ?? '').trim() !== '');
		return value === undefined ? null : String(value);
	}

	/** Small decorative vault-shape diagrams; labels and state text carry meaning. */
	private renderShapeIllustration(parent: HTMLElement, id: ShapeCardId): void {
		const illustration = parent.createDiv({
			cls: `crosswalker-wb-shape-illustration is-${id}`,
			attr: { 'aria-hidden': 'true' },
		});
		switch (id) {
			case 'folder':
				for (let i = 0; i < 3; i++) illustration.createDiv({ cls: `crosswalker-wb-mini-folder is-depth-${i}` });
				break;
			case 'name':
				for (let i = 0; i < 3; i++) illustration.createDiv({ cls: 'crosswalker-wb-mini-file' });
				break;
			case 'tag':
				for (const text of ['#one', '#two', '#three']) illustration.createSpan({ cls: 'crosswalker-wb-mini-tag', text });
				break;
			case 'heading': {
				const sheet = illustration.createDiv({ cls: 'crosswalker-wb-mini-sheet' });
				sheet.createDiv({ cls: 'crosswalker-wb-mini-heading' });
				for (let i = 0; i < 3; i++) sheet.createDiv({ cls: 'crosswalker-wb-mini-line' });
				break;
			}
			case 'link':
				illustration.createSpan({ cls: 'crosswalker-wb-mini-node is-a' });
				illustration.createSpan({ cls: 'crosswalker-wb-mini-connector is-a' });
				illustration.createSpan({ cls: 'crosswalker-wb-mini-node is-b' });
				illustration.createSpan({ cls: 'crosswalker-wb-mini-connector is-b' });
				illustration.createSpan({ cls: 'crosswalker-wb-mini-node is-c' });
				break;
			case 'property':
				for (let i = 0; i < 3; i++) {
					const row = illustration.createDiv({ cls: 'crosswalker-wb-mini-property' });
					row.createSpan({ cls: 'crosswalker-wb-mini-key' });
					row.createSpan({ cls: 'crosswalker-wb-mini-value' });
				}
				break;
		}
	}

	private renderCombinedPreview(card: HTMLElement, mi: number): void {
		const wrap = card.createDiv({ cls: 'crosswalker-wb-combined' });
		wrap.createDiv({ cls: 'crosswalker-wb-combined-label', text: 'Your mix, on one row (rendered for real)' });
		const sample = this.firstRow();
		const pre = wrap.createEl('pre', { cls: 'crosswalker-wb-mini' });
		if (!sample) {
			pre.setText('(no rows to preview)');
			return;
		}
		try {
			const recipe: Recipe = { recipe: 'wb-mix', target: toRecipeRegions({ mappings: [this.mapping.mappings[mi]] }) as Recipe['target'] };
			const address = render(recipe, { curie: 'preview:1', scope: sample });
			pre.setText(this.describeAddress(address));
		} catch (err) {
			pre.setText(`(cannot preview: ${err instanceof Error ? err.message : String(err)})`);
		}
	}

	// -------------------------------------------------------------------------
	// Connections — the Pass 1.5 batch enrichment block (spec §7k)
	// -------------------------------------------------------------------------

	/**
	 * Outcome-first Connections cards for child lists, shared-value hubs, folder
	 * indexes, optional Waypoint marking, and (for ragged/variadic hierarchies)
	 * parent placement. Every control writes its existing enrichment key straight
	 * to `ImportMapping.enrichment`; this refactor changes presentation, not values.
	 */
	private renderConnections(canvas: HTMLElement): void {
		const card = canvas.createDiv({ cls: 'crosswalker-wb-mapcard crosswalker-wb-connections' });
		const head = card.createDiv({ cls: 'crosswalker-wb-mapcard-head' });
		wbIcon(head, 'git-branch');
		head.createEl('b', { text: 'Connections' });
		card.createDiv({
			cls: 'crosswalker-wb-connections-sub',
			text: 'Choose the useful relationships Crosswalker adds around the generated notes.',
		});

		const enrichment = this.mapping.enrichment ?? {};
		const options = card.createDiv({ cls: 'crosswalker-wb-connection-options' });

		// Children lists — the managed reverse of the parent link. This control
		// deliberately writes only children_lists; the existing parent-link shape
		// and every other enrichment value remain untouched.
		const childrenOn = enrichment.children_lists === true;
		const childrenCard = options.createDiv({
			cls: 'crosswalker-wb-connection-option' + (childrenOn ? ' is-on' : ''),
			attr: { 'data-connection-option': 'children-lists', 'data-enrichment-key': 'children_lists' },
		});
		const childrenControl = childrenCard.createEl('label', { cls: 'crosswalker-wb-connection-control' });
		const childrenCb = childrenControl.createEl('input', {
			type: 'checkbox',
			attr: { 'data-enrichment-key': 'children_lists' },
		});
		childrenCb.checked = childrenOn;
		const childrenTitle = childrenControl.createSpan({ cls: 'crosswalker-wb-connection-title' });
		wbIcon(childrenTitle, 'list-tree');
		childrenTitle.createSpan({ text: 'Child lists' });
		childrenControl.createSpan({ cls: 'crosswalker-wb-connection-state', text: childrenOn ? 'On' : 'Off' });
		childrenCb.addEventListener('change', () => this.updateEnrichment({ children_lists: childrenCb.checked }));
		childrenCard.createDiv({
			cls: 'crosswalker-wb-connection-outcome',
			text: 'Parents list their direct children.',
		});
		const childrenDetails = childrenCard.createEl('details', { cls: 'crosswalker-wb-connection-details' });
		childrenDetails.createEl('summary', { text: 'What this does' });
		childrenDetails.createDiv({
			text: 'Adds a managed children list to each parent note. The parent link already written on each child is unchanged.',
		});

		// Shared-value hubs — one hub note per tagged facet value, tags only, or off.
		const facetCols = facetTagColumns(this.mapping);
		const facetMode = enrichment.facet_notes ?? 'none';
		const facetCard = options.createDiv({
			cls: 'crosswalker-wb-connection-option' + (facetMode !== 'none' ? ' is-on' : ''),
			attr: { 'data-connection-option': 'shared-value-hubs', 'data-enrichment-key': 'facet_notes' },
		});
		const facetHead = facetCard.createDiv({ cls: 'crosswalker-wb-connection-control' });
		const facetTitle = facetHead.createSpan({ cls: 'crosswalker-wb-connection-title' });
		wbIcon(facetTitle, 'tags');
		facetTitle.createSpan({ text: 'Shared-value hubs' });
		const facetSel = facetHead.createEl('select', {
			cls: 'dropdown crosswalker-wb-connection-select',
			attr: { 'aria-label': 'Shared-value hubs', 'data-enrichment-key': 'facet_notes' },
		});
		facetSel.createEl('option', { text: 'Off', attr: { value: 'none' } });
		facetSel.createEl('option', { text: 'Tags only', attr: { value: 'tags-only' } });
		const notesOption = facetSel.createEl('option', { text: 'Create hub notes', attr: { value: 'notes' } });
		notesOption.disabled = facetCols.length === 0;
		facetSel.value = facetMode;
		facetSel.addEventListener('change', () => {
			this.updateEnrichment({ facet_notes: facetSel.value as Enrichment['facet_notes'] });
		});
		facetCard.createDiv({
			cls: 'crosswalker-wb-connection-outcome',
			text: 'Shared values can connect related notes with tags or navigable hub notes.',
		});
		facetCard.createDiv({
			cls: 'crosswalker-wb-connection-context' + (facetCols.length === 0 ? ' is-inactive' : ''),
			text: facetCols.length > 0
				? `Using tags: ${facetCols.join(', ')}.`
				: 'Enable the Tags shape above to create hub notes.',
		});
		const facetDetails = facetCard.createEl('details', { cls: 'crosswalker-wb-connection-details' });
		facetDetails.createEl('summary', { text: 'What this does' });
		facetDetails.createDiv({
			text: 'Tags only writes the selected shared values as tags. Create hub notes also gathers every note with the same value under one generated note.',
		});

		// Folder index notes (level hubs). Waypoint is subordinate to this outcome:
		// when indexes are off its persisted value remains intact, but its control is
		// visibly inactive because there are no generated folder notes to mark.
		const folderIndexesOn = enrichment.level_hubs === 'notes';
		const hubsCard = options.createDiv({
			cls: 'crosswalker-wb-connection-option' + (folderIndexesOn ? ' is-on' : ''),
			attr: { 'data-connection-option': 'folder-indexes', 'data-enrichment-key': 'level_hubs' },
		});
		const hubsControl = hubsCard.createEl('label', { cls: 'crosswalker-wb-connection-control' });
		const hubsCb = hubsControl.createEl('input', {
			type: 'checkbox',
			attr: { 'data-enrichment-key': 'level_hubs' },
		});
		hubsCb.checked = folderIndexesOn;
		const hubsTitle = hubsControl.createSpan({ cls: 'crosswalker-wb-connection-title' });
		wbIcon(hubsTitle, 'folder-tree');
		hubsTitle.createSpan({ text: 'Folder indexes' });
		hubsControl.createSpan({ cls: 'crosswalker-wb-connection-state', text: folderIndexesOn ? 'On' : 'Off' });
		hubsCb.addEventListener('change', () => this.updateEnrichment({ level_hubs: hubsCb.checked ? 'notes' : 'none' }));
		hubsCard.createDiv({
			cls: 'crosswalker-wb-connection-outcome',
			text: 'Each generated folder gets a Contents list.',
		});
		const hubsDetails = hubsCard.createEl('details', { cls: 'crosswalker-wb-connection-details' });
		hubsDetails.createEl('summary', { text: 'What this does' });
		hubsDetails.createDiv({
			text: 'Creates an index note for each generated folder. If a parent note already lives inside that folder, its Contents list is added there instead.',
		});

		if (this.opts.waypointDetected) {
			const waypointOn = enrichment.waypoint_marker === true;
			const waypoint = hubsCard.createDiv({
				cls: 'crosswalker-wb-waypoint' + (folderIndexesOn ? '' : ' is-inactive'),
				attr: { 'data-connection-option': 'waypoint', 'data-enrichment-key': 'waypoint_marker' },
			});
			const waypointControl = waypoint.createEl('label', { cls: 'crosswalker-wb-connection-control' });
			const waypointCb = waypointControl.createEl('input', {
				type: 'checkbox',
				attr: { 'data-enrichment-key': 'waypoint_marker' },
			});
			waypointCb.checked = waypointOn;
			waypointCb.disabled = !folderIndexesOn;
			const waypointTitle = waypointControl.createSpan({ cls: 'crosswalker-wb-connection-title' });
			wbIcon(waypointTitle, 'map-pin');
			waypointTitle.createSpan({ text: 'Also mark for Waypoint' });
			waypointControl.createSpan({
				cls: 'crosswalker-wb-connection-state',
				text: folderIndexesOn ? (waypointOn ? 'On' : 'Off') : 'Needs folder indexes',
			});
			waypointCb.addEventListener('change', () => this.updateEnrichment({ waypoint_marker: waypointCb.checked }));
			const waypointDetails = waypoint.createEl('details', { cls: 'crosswalker-wb-connection-details' });
			waypointDetails.createEl('summary', { text: 'What this does' });
			waypointDetails.createDiv({
				text: 'Adds the Waypoint marker to generated folder notes so Waypoint can also track notes added by hand later.',
			});
		}

		// Parent-note placement — only a live question when a ragged/variadic
		// hierarchy exists (variadic-split design §4).
		if (this.mapping.mappings.some((m) => !!m.tail)) {
			this.renderPlacementChooser(card, enrichment);
		}
	}

	/**
	 * Sibling-vs-folder-note placement chooser (variadic-split design §4): a
	 * side-by-side mini file-tree built from the sample rows' own real render
	 * output. Both options are live: the batch relocation pass (Pass 1.5)
	 * moves an eligible parent (one whose children actually nest under its
	 * own-named folder) from `X.md` to `X/X.md` at generate time
	 * (spec/recipe.schema.json `$defs/enrichment.parent_note`). The mini-tree
	 * previews here mirror that same eligibility rule (a leaf whose stem
	 * matches an existing folder in the sample).
	 */
	private renderPlacementChooser(card: HTMLElement, enrichment: Enrichment): void {
		const wrap = card.createDiv({ cls: 'crosswalker-wb-placement' });
		const prompt = wrap.createDiv({ cls: 'crosswalker-wb-connection-row-label' });
		prompt.createSpan({ text: 'When ' });
		prompt.createEl('code', { text: 'X/' });
		prompt.createSpan({ text: ' contains child notes, where should ' });
		prompt.createEl('code', { text: 'X.md' });
		prompt.createSpan({ text: ' live?' });
		const preview = this.computePreview();
		const paths = preview ? preview.addresses.map((a) => a.address.primary.path) : [];
		const trees = buildParentPlacementPreview(paths);
		const current = enrichment.parent_note ?? 'sibling';
		const defaultChoice = this.opts.defaultParentNote?.value ?? 'sibling';
		const options: { id: 'sibling' | 'folder-note'; label: string; nodes: PathTreeNode[] }[] = [
			{ id: 'sibling', label: 'Beside its folder', nodes: trees.sibling },
			{ id: 'folder-note', label: 'Inside its folder', nodes: trees.folderNote },
		];

		const grid = wrap.createDiv({ cls: 'crosswalker-wb-placement-grid' });
		for (const opt of options) {
			const selected = current === opt.id;
			const col = grid.createDiv({
				cls: 'crosswalker-wb-placement-col' + (selected ? ' is-selected' : ''),
				attr: { 'data-parent-note-value': opt.id },
			});
			const head = col.createDiv({ cls: 'crosswalker-wb-placement-head' });
			const radioLabel = head.createEl('label', { cls: 'crosswalker-wb-placement-radio' });
			const radio = radioLabel.createEl('input', {
				type: 'radio',
				attr: {
					name: `${this.sourceRegionId}-parent-note`,
					value: opt.id,
					'data-parent-note-value': opt.id,
				},
			});
			radio.checked = selected;
			radioLabel.createSpan({ text: opt.label });
			radio.addEventListener('change', () => {
				if (radio.checked) this.updateEnrichment({ parent_note: opt.id });
			});
			const states = head.createDiv({ cls: 'crosswalker-wb-placement-states' });
			if (selected) states.createSpan({ cls: 'crosswalker-wb-placement-state is-selected', text: 'Selected' });
			if (defaultChoice === opt.id) states.createSpan({ cls: 'crosswalker-wb-placement-state', text: 'Default' });
			const treeEl = col.createDiv({ cls: 'crosswalker-wb-placement-tree crosswalker-wb-tree' });
			if (opt.nodes.length === 0) {
				treeEl.createDiv({ cls: 'crosswalker-muted', text: '(no sample rows to preview)' });
			} else {
				// Highlight the connected pair: the parent note and its matching
				// folder both render accent so each option shows the real move.
				for (const node of opt.nodes.slice(0, 12)) {
					let cls = 'crosswalker-wb-tree-row' + (node.isFile ? ' is-file' : '');
					if (node.relation === 'parent') cls += ' cw-rel-parent';
					const row = treeEl.createDiv({ cls });
					row.style.paddingLeft = `${node.depth * 14}px`;
					wbIcon(row, node.isFile ? 'file' : 'folder', 'crosswalker-wb-tree-ico');
					row.createSpan({ text: node.isFile ? node.label : `${node.label}/` });
				}
			}
		}

		const details = wrap.createEl('details', { cls: 'crosswalker-wb-placement-details' });
		details.createEl('summary', { text: 'Placement details' });
		if (this.opts.defaultParentNote?.reason) {
			details.createDiv({
				cls: 'crosswalker-wb-placement-reason',
				text: `Default: ${this.opts.defaultParentNote.reason}`,
			});
		}
		details.createDiv({
			cls: 'crosswalker-wb-placement-reason',
			text: 'Only parent notes with child notes inside a same-named folder move. Childless notes keep their rendered location.',
		});
	}

	/**
	 * Cheap, sample-scoped connection counts ("edge/hub counts if cheap" — spec).
	 * Reuses the same `PREVIEW_ROW_LIMIT` sample the rest of the workbench
	 * previews from; explicitly labeled "(sample)" since it is NOT the true
	 * batch Pass 1.5 count over the full import (that only exists at generate
	 * time). Returns null when enrichment is off or there's nothing to count.
	 */
	private connectionStats(): string | null {
		const enrichment = this.mapping.enrichment;
		if (!enrichment) return null;
		const parts: string[] = [];

		if (enrichment.children_lists) {
			const preview = this.computePreview();
			const parentLinks = preview
				? preview.addresses.filter((a) => {
						const parent = a.address.frontmatter['parent'];
						return typeof parent === 'string' && parent.trim() !== '' && parent !== '[[]]';
					}).length
				: 0;
			if (parentLinks) parts.push(`${parentLinks} parent link${parentLinks === 1 ? '' : 's'}`);
		}

		if (enrichment.facet_notes && enrichment.facet_notes !== 'none') {
			const rows = this.opts.parsedData.rows;
			if (isEagerRows(rows)) {
				const values = new Set<string>();
				rows.slice(0, PREVIEW_ROW_LIMIT).forEach((row) => {
					for (const f of deriveFacetMemberships(this.mapping, row as Record<string, unknown>)) {
						values.add(`${f.namespace}:${f.value}`);
					}
				});
				if (values.size) parts.push(`${values.size} facet value${values.size === 1 ? '' : 's'}`);
			}
		}

		return parts.length ? `In this sample: ${parts.join(' · ')}` : null;
	}

	// -------------------------------------------------------------------------
	// The matrix (M2b)
	// -------------------------------------------------------------------------

	private renderMatrix(card: HTMLElement, m: StructureMapping, mi: number): void {
		const wrap = card.createDiv({ cls: 'crosswalker-wb-matrix-wrap' });
		const table = wrap.createEl('table', { cls: 'crosswalker-wb-matrix' });
		const thead = table.createEl('thead').createEl('tr');
		for (const h of ['Level', 'Sample', 'Lands as', 'Named', 'If missing']) thead.createEl('th', { text: h });
		const tbody = table.createEl('tbody');

		m.levels.forEach((rule, li) => this.renderMatrixRow(tbody, m, mi, rule, li));
		if (m.tail) this.renderTailRow(tbody, m, mi, m.tail);
	}

	private renderMatrixRow(tbody: HTMLElement, m: StructureMapping, mi: number, rule: LevelRule, li: number): void {
		const tr = tbody.createEl('tr');

		// Level cell — id + merge/split buttons.
		const lvl = tr.createEl('td');
		lvl.createEl('b', { text: rule.level });
		const gestures = lvl.createDiv({ cls: 'crosswalker-wb-gestures' });
		if (li < m.levels.length - 1) {
			const mergeBtn = gestures.createEl('button', { text: 'Merge ▾', attr: { title: 'Merge with the next level' } });
			mergeBtn.addEventListener('click', () => this.updateMapping(mi, mergeRows(m, li)));
		}
		if (this.isSplittable(rule.source)) {
			const splitBtn = gestures.createEl('button', { text: 'Split', attr: { title: 'Split this merged level back apart' } });
			splitBtn.addEventListener('click', () => this.updateMapping(mi, splitRow(m, li)));
		}

		// Sample cell.
		tr.createEl('td', { cls: 'mono', text: this.sampleForLevel(rule) });

		// Lands as — destination chips + ⊕.
		const lands = tr.createEl('td');
		this.renderDestinationChips(lands, m, mi, li, rule.destinations);

		// Named — naming dropdown.
		const named = tr.createEl('td');
		const nameSel = named.createEl('select', { cls: 'dropdown' });
		for (const [value, label] of [
			['part', 'The part'],
			['prefix', 'Cumulative prefix'],
			['joined', 'Joined parts'],
		] as const) {
			nameSel.createEl('option', { text: label, attr: { value } });
		}
		nameSel.value = this.namingValue(rule.naming);
		nameSel.addEventListener('change', () => {
			const next: LevelRule = { ...rule, naming: nameSel.value as LevelNaming };
			this.updateMapping(mi, this.replaceLevel(m, li, next));
		});

		// If missing — missing dropdown.
		const miss = tr.createEl('td');
		const missSel = miss.createEl('select', { cls: 'dropdown' });
		for (const [value, label] of [
			['skip', 'Skip level'],
			['fallback', 'Use fallback'],
			['error', 'Report'],
		] as const) {
			missSel.createEl('option', { text: label, attr: { value } });
		}
		missSel.value = rule.missing;
		missSel.addEventListener('change', () => {
			const next: LevelRule = { ...rule, missing: missSel.value as MissingPolicy };
			this.updateMapping(mi, this.replaceLevel(m, li, next));
		});
	}

	private renderTailRow(tbody: HTMLElement, m: StructureMapping, mi: number, tail: TailRule): void {
		const tr = tbody.createEl('tr', { cls: 'crosswalker-wb-tailrow' });
		const lvl = tr.createEl('td');
		lvl.createEl('b', { text: 'Any deeper' });
		lvl.createDiv({ cls: 'crosswalker-wb-tail-note', text: 'the tail rule' });
		tr.createEl('td', { cls: 'mono crosswalker-muted', text: '-' });
		const lands = tr.createEl('td');
		for (const d of tail.destinations) this.destChip(lands, d);
		tr.createEl('td', { cls: 'mono', text: tail.naming });
		const miss = tr.createEl('td');
		const maxDepth = tail.max_depth ?? 6;
		const overflowText = tail.on_overflow === 'error'
			? `error past ${maxDepth} levels`
			: `keep first ${maxDepth}, report the rest`;
		miss.createSpan({ text: overflowText });
	}

	private renderDestinationChips(cell: HTMLElement, m: StructureMapping, mi: number, li: number, destinations: Destination[]): void {
		for (const d of destinations) {
			const chip = this.destChip(cell, d, 'crosswalker-wb-chip-dest');
			const x = chip.createEl('button', { cls: 'crosswalker-wb-chip-x', attr: { 'aria-label': 'Remove' } });
			setIcon(x, 'x');
			x.addEventListener('click', () => this.updateMapping(mi, removeDestination(m, li, d.primitive, destKey(d))));
		}
		const add = cell.createEl('button', { cls: 'crosswalker-wb-chip crosswalker-wb-chip-add', attr: { 'aria-label': 'Also send this level somewhere' } });
		setIcon(add, 'plus');
		add.addEventListener('click', () => {
			const open = this.addMenu && this.addMenu.mi === mi && this.addMenu.li === li;
			this.addMenu = open ? null : { mi, li };
			this.addMenuPrimitive = null;
			this.scheduleRerender();
		});
		if (this.addMenu && this.addMenu.mi === mi && this.addMenu.li === li) {
			this.renderAddMenu(cell, m, mi, li);
		}
	}

	/** The two-stage ⊕ menu: pick a primitive, then a small param popover (spec §3d). */
	private renderAddMenu(cell: HTMLElement, m: StructureMapping, mi: number, li: number): void {
		const menu = cell.createDiv({ cls: 'crosswalker-wb-addmenu' });
		if (!this.addMenuPrimitive) {
			menu.createDiv({ cls: 'crosswalker-wb-addmenu-title', text: 'Also send this level to…' });
			for (const grp of ADD_MENU_GROUPS) {
				menu.createDiv({ cls: 'crosswalker-wb-addmenu-group', text: grp.group });
				for (const it of grp.items) {
					const b = menu.createEl('button', { cls: 'crosswalker-wb-addmenu-item', text: it.label });
					b.addEventListener('click', () => {
						this.addMenuPrimitive = it.primitive;
						this.addMenuParams = this.defaultParams(it.primitive, m.levels[li]);
						this.scheduleRerender();
					});
				}
			}
			return;
		}

		// Stage 2 — parameter popover for the chosen primitive.
		const primitive = this.addMenuPrimitive;
		menu.createDiv({ cls: 'crosswalker-wb-addmenu-title', text: `Add ${primitive}` });
		for (const field of this.paramFields(primitive)) {
			const row = menu.createDiv({ cls: 'crosswalker-wb-addmenu-field' });
			row.createSpan({ text: field.label });
			if (field.options) {
				const sel = row.createEl('select', { cls: 'dropdown' });
				for (const [v, l] of field.options) sel.createEl('option', { text: l, attr: { value: v } });
				sel.value = this.addMenuParams[field.key] ?? field.options[0][0];
				sel.addEventListener('change', () => { this.addMenuParams[field.key] = sel.value; });
			} else {
				const inp = row.createEl('input', { type: 'text', value: this.addMenuParams[field.key] ?? '' });
				inp.addEventListener('input', () => { this.addMenuParams[field.key] = inp.value; });
			}
		}
		const btns = menu.createDiv({ cls: 'crosswalker-wb-addmenu-btns' });
		const addBtn = btns.createEl('button', { cls: 'mod-cta', text: 'Add' });
		addBtn.addEventListener('click', () => {
			const dest = this.buildDestination(primitive, this.addMenuParams);
			this.addMenu = null;
			this.addMenuPrimitive = null;
			this.updateMapping(mi, addDestination(m, li, dest));
		});
		const cancel = btns.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => {
			this.addMenu = null;
			this.addMenuPrimitive = null;
			this.scheduleRerender();
		});
	}

	// -------------------------------------------------------------------------
	// Zone 3 — vault preview rail
	// -------------------------------------------------------------------------

	private renderPreviewRail(rail: HTMLElement): void {
		rail.createDiv({ cls: 'crosswalker-wb-eyebrow', text: 'Vault preview · live' });
		const preview = this.computePreview();
		if (!preview) {
			if (this.previewError) {
				// B2: a thrown guard (the single-structural-mapping assertion, most
				// commonly) surfaces as a visible blocking error — never a silent
				// "nothing to preview" state that a user could mistake for "all clear".
				// The guard's own message is engineer-facing (it cites instantiate()
				// and the spec); the banner translates the common case to plain
				// language naming the conflicting mappings (2026-07-12 hands-on
				// finding: the raw message wrapped into an unreadable wall).
				const banner = rail.createDiv({ cls: 'crosswalker-render-banner is-warning' });
				wbIcon(banner, 'alert-triangle', 'crosswalker-render-banner-icon');
				const structuralTitles = this.structuralMappingTitles();
				const text = structuralTitles.length > 1
					? `${structuralTitles.join(' and ')} both shape the vault. On one mapping, untick Folders and File names. Tags, Properties, and Links can stay enabled.`
					: explainRecipeError(this.previewError) ?? `Can't generate: ${this.previewError}`;
				banner.createSpan({ cls: 'crosswalker-render-banner-text', text });
				return;
			}
			rail.createDiv({ cls: 'crosswalker-wb-preview-empty', text: 'Preview is available for in-memory sources. Streamed sources render at generate time.' });
			return;
		}

		// One selected note. Default selection = the first file (spec §7j #4).
		const addrs = preview.addresses;
		if (addrs.length) this.selectedNoteRow = Math.min(this.selectedNoteRow, addrs.length - 1);

		// Tree + rendered note. Wrapped together so wide viewports (spec §7n item
		// 2 — "generous" preview rail, tree and note side by side) can lay them out
		// as a row via CSS; narrow viewports keep the original stacked order.
		const treenote = rail.createDiv({ cls: 'crosswalker-wb-treenote' });

		// Folder tree from the sample addresses — clickable file rows select the
		// note previewed below (spec §7j #4: the tree IS the selector, no pager).
		const tree = treenote.createDiv({ cls: 'crosswalker-wb-tree' });
		for (const node of this.buildTreeNodes(addrs)) {
			const row = tree.createDiv({
				cls: 'crosswalker-wb-tree-row'
					+ (node.isFile ? ' is-file' : '')
					+ (node.isFile && node.addrIndex === this.selectedNoteRow ? ' is-selected' : ''),
			});
			row.style.paddingLeft = `${node.depth * 14}px`;
			wbIcon(row, node.isFile ? 'file' : 'folder', 'crosswalker-wb-tree-ico');
			row.createSpan({ text: node.isFile ? node.label : `${node.label}/` });
			if (node.isFile) {
				const idx = node.addrIndex;
				row.addEventListener('click', () => { this.selectedNoteRow = idx; this.scheduleRerender(); });
			}
		}
		if (addrs.length > TREE_ROW_LIMIT) tree.createDiv({ cls: 'crosswalker-wb-tree-row crosswalker-muted', text: '… and more' });

		if (addrs.length) {
			const note = treenote.createDiv({ cls: 'crosswalker-wb-note' });
			const noteTitle = note.createDiv({ cls: 'crosswalker-wb-note-title' });
			wbIcon(noteTitle, 'file-text');
			noteTitle.createSpan({ text: this.basename(addrs[this.selectedNoteRow].address.primary.path) });
			note.createEl('pre', { cls: 'crosswalker-wb-mini', text: this.describeFrontmatter(addrs[this.selectedNoteRow].address) });
		}

		// Deviation banner (reuses the render report summary).
		if (preview.perRow.length) {
			const summary = summarizeRenderNotes(preview.perRow, preview.total);
			const banner = rail.createDiv({ cls: `crosswalker-render-banner is-${summary.tone}` });
			wbIcon(banner, summary.tone === 'clean' ? 'check-circle-2' : 'alert-triangle', 'crosswalker-render-banner-icon');
			banner.createSpan({ cls: 'crosswalker-render-banner-text', text: summary.message });
		}

		// Connections stats — cheap, sample-scoped edge/hub counts so an import
		// that produces zero connections is never silent (spec §7k).
		const stats = this.connectionStats();
		if (stats) rail.createDiv({ cls: 'crosswalker-wb-connection-stats', text: stats });
	}

	/**
	 * Run the workbench recipe over a sample of rows. Null for non-eager
	 * sources, OR when `buildRecipe()` throws (B2) — check `getPreviewError()`
	 * to tell the two apart; a thrown guard (e.g. the single-structural-mapping
	 * assertion) must surface as a visible blocking error, never a silent
	 * "nothing to preview" state that reads as zero deviations.
	 */
	computePreview(): { addresses: { row: number; address: Address }[]; perRow: PreviewRowNotes[]; total: number } | null {
		const rows = this.opts.parsedData.rows;
		if (!isEagerRows(rows) || rows.length === 0) {
			this.previewError = null;
			return null;
		}
		let recipe: Recipe;
		try {
			recipe = this.buildRecipe();
		} catch (err) {
			this.previewError = err instanceof Error ? err.message : String(err);
			return null;
		}
		this.previewError = null;
		const addresses: { row: number; address: Address }[] = [];
		const perRow: PreviewRowNotes[] = [];
		rows.slice(0, PREVIEW_ROW_LIMIT).forEach((row, i) => {
			const rowNum = i + 1;
			const report: RenderReport = { notes: [] };
			try {
				const address = render(recipe, { curie: `preview:${rowNum}`, scope: row as Record<string, unknown> }, report);
				addresses.push({ row: rowNum, address });
				perRow.push({ row: rowNum, notes: report.notes, path: this.withBase(address.primary.path) });
			} catch {
				// A bad row surfaces at generate time; skip it in the live preview.
			}
		});
		return { addresses, perRow, total: this.opts.parsedData.rowCount || rows.length };
	}

	// =========================================================================
	// Model helpers
	// =========================================================================

	private currentPreset(): Preset {
		return getBuiltInPreset(this.presetId) ?? BUILT_IN_PRESETS['browsable-framework'];
	}

	private activeDetections(): Detection[] {
		return this.detections.filter((d) => !this.dismissed.has(this.detectionKey(d)));
	}

	/**
	 * Re-derive the mapping from the (possibly changed) preset/active
	 * detections — fired by a preset switch or an evidence dismiss/use.
	 *
	 * B3: `instantiate()` has no "previous mapping" input, so a bare
	 * re-instantiation silently discards the user's live in-session choices —
	 * most visibly `enrichment.parent_note` (the placement chooser) and any
	 * hand-added mapping (`addManualMapping`). Both are explicit decisions
	 * already made in THIS session, so they outrank vault defaults and preset
	 * defaults on re-instantiation. Precedence inside this method: user's
	 * prior in-session enrichment > vault defaults > preset defaults >
	 * adaptive `defaultParentNote`.
	 *
	 * Deliberately NOT carried: anything the fresh `instantiate()` already
	 * re-derives from detections (a dismissed detection's structural mapping,
	 * for instance) — only `manualMappings` (hand-added, tracked by
	 * reference) are re-appended, so dismissing evidence still removes the
	 * structure it produced.
	 */
	private reinstantiate(): void {
		const previousEnrichment = this.mapping.enrichment;
		this.mapping = instantiate(this.currentPreset(), this.activeDetections());
		// Same fresh-instantiation rules as the constructor: a preset switch (or
		// an evidence dismiss/use) re-derives the mapping from scratch, so vault
		// defaults + the adaptive parent_note fallback re-apply here too.
		this.applyDefaultsOverlay();
		// The user's own prior in-session enrichment choices outrank whatever
		// applyDefaultsOverlay() just stamped (B3).
		if (previousEnrichment) {
			this.mapping = {
				...this.mapping,
				enrichment: { ...(this.mapping.enrichment ?? {}), ...previousEnrichment },
			};
		}
		// Carry forward hand-added mappings the fresh instantiation didn't
		// already re-derive (B3). Structural (not referential) equality: a
		// manual mapping edited via the matrix is a new object each time, but
		// `replaceMappingAt` keeps `manualMappings`' reference current.
		const carried = this.manualMappings.filter(
			(pm) => !this.mapping.mappings.some((m) => structuralEqual(m, pm)),
		);
		if (carried.length > 0) {
			this.mapping = { ...this.mapping, mappings: [...this.mapping.mappings, ...carried] };
		}
		this.expanded.clear();
		this.matrixOpen.clear();
		this.addMenu = null;
		this.applyChange();
	}

	/**
	 * Overlay vault-level Connections defaults (`opts.vaultDefaults`) onto
	 * `this.mapping.enrichment`, then fall back to the adaptive folder-notes
	 * detection (`opts.defaultParentNote`) for `parent_note` only when it is
	 * STILL unset after that overlay. Only called on a fresh instantiation —
	 * the precedence chain this implements (documented on `WorkbenchOptions.
	 * vaultDefaults`): recognized built-in configuration > resumed draft/saved
	 * mapping > vault defaults > preset defaults > adaptive detection.
	 */
	private applyDefaultsOverlay(): void {
		if (this.opts.vaultDefaults && Object.keys(this.opts.vaultDefaults).length > 0) {
			this.mapping = {
				...this.mapping,
				enrichment: { ...(this.mapping.enrichment ?? {}), ...this.opts.vaultDefaults },
			};
		}
		if (this.opts.defaultParentNote && this.mapping.enrichment && this.mapping.enrichment.parent_note === undefined) {
			this.mapping = {
				...this.mapping,
				enrichment: { ...this.mapping.enrichment, parent_note: this.opts.defaultParentNote.value },
			};
		}
	}

	private seedColumnDests(): void {
		const structural = this.structuralColumns();
		const detections = this.activeDetections();
		for (const col of this.opts.parsedData.columns) {
			// Long-text (body-candidate) columns default to the note body; other
			// non-structural columns default to a frontmatter property.
			this.columnDests.set(col, structural.has(col) ? 'skip' : defaultDestinationForColumn(col, detections));
		}
	}

	/** Columns already carried by a shape mapping (so the all columns table can default them to skip). */
	private structuralColumns(): Set<string> {
		const cols = new Set<string>();
		const addSource = (source: LevelSource) => {
			for (const ref of toSourceRefs(source)) {
				if (!isConstantRef(ref)) cols.add(ref.column);
			}
		};
		for (const m of this.mapping.mappings) {
			for (const l of m.levels) addSource(l.source);
			if (m.tail) addSource(m.tail.source);
		}
		return cols;
	}

	/**
	 * True when a structural destination (folder/name/heading) already exists
	 * anywhere in the mapping — mirrors `serialize.ts`'s `assertSingleStructural`
	 * guard's own check (kept independent so this module stays free of a
	 * serialize.ts import for one boolean).
	 */
	private hasStructuralMapping(): boolean {
		return this.structuralMappingTitles().length > 0;
	}

	/** Titles of every mapping carrying a structural destination (folder/name/
	 *  heading), for the plain-language two-structural banner. */
	private structuralMappingTitles(): string[] {
		const isStructural = (d: Destination): boolean =>
			d.primitive === 'folder' || d.primitive === 'name' || d.primitive === 'heading';
		return this.mapping.mappings
			.filter(
				(m) => m.levels.some((l) => l.destinations.some(isStructural))
					|| (m.tail !== undefined && m.tail.destinations.some(isStructural)),
			)
			.map((m) => this.mappingTitle(m));
	}

	/**
	 * Add a mapping by hand from the "Add mapping from a column" chooser
	 * (B6). A recipe supports exactly one structural mapping (folder/name/
	 * heading) — `serialize.ts`'s `assertSingleStructural` throws the moment a
	 * second one exists, and this control had zero guard against creating that
	 * second one. Only seed a structural `{primitive:'name'}` destination when
	 * NO structural mapping exists yet; otherwise the natural "route this
	 * column" action is a frontmatter property, same as the demoted "all
	 * columns" table's own default.
	 */
	private addManualMapping(column: string): void {
		const structuralExists = this.hasStructuralMapping();
		const next: StructureMapping = {
			levels: [
				{
					level: column,
					source: { column },
					destinations: [
						structuralExists ? { primitive: 'property', key: this.keyOf(column) } : { primitive: 'name' },
					],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				},
			],
		};
		this.mapping = { ...this.mapping, mappings: [...this.mapping.mappings, next] };
		this.manualMappings.push(next);
		this.expanded.add(this.mapping.mappings.length - 1);
		this.applyChange();
	}

	private removeMapping(mi: number): void {
		const old = this.mapping.mappings[mi];
		this.mapping = { ...this.mapping, mappings: this.mapping.mappings.filter((_, i) => i !== mi) };
		const manualIdx = this.manualMappings.indexOf(old);
		if (manualIdx !== -1) this.manualMappings.splice(manualIdx, 1);
		this.expanded.delete(mi);
		this.matrixOpen.delete(mi);
		this.applyChange();
	}

	private replaceLevel(m: StructureMapping, li: number, next: LevelRule): StructureMapping {
		const levels = m.levels.map((l, i) => (i === li ? next : l));
		return m.tail ? { levels, tail: m.tail } : { levels };
	}

	private defaultParams(primitive: DestinationPrimitive, rule: LevelRule): Record<string, string> {
		const col = this.firstColumn(rule.source);
		switch (primitive) {
			case 'property': return { key: this.keyOf(col) };
			case 'link': return { key: 'parent', direction: 'parent-on-child' };
			case 'tag': return { namespace: this.slug(col) };
			case 'heading': return { depth: '2' };
			case 'body': return { position: 'section' };
			default: return {};
		}
	}

	private paramFields(primitive: DestinationPrimitive): { key: string; label: string; options?: [string, string][] }[] {
		switch (primitive) {
			case 'property': return [{ key: 'key', label: 'Property key' }];
			case 'link': return [
				{ key: 'key', label: 'Frontmatter key' },
				{ key: 'direction', label: 'Direction', options: [['parent-on-child', 'Parent on child'], ['children-on-parent', 'Children on parent'], ['both', 'Both']] },
			];
			case 'tag': return [{ key: 'namespace', label: 'Tag namespace' }];
			case 'heading': return [{ key: 'depth', label: 'Heading depth', options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']] }];
			case 'body': return [{ key: 'position', label: 'Position', options: [['section', 'Section'], ['append', 'Append'], ['table-row', 'Table row']] }];
			default: return [];
		}
	}

	private buildDestination(primitive: DestinationPrimitive, params: Record<string, string>): Destination {
		switch (primitive) {
			case 'folder': return { primitive: 'folder' };
			case 'name': return { primitive: 'name' };
			case 'note': return { primitive: 'note' };
			case 'alias': return { primitive: 'alias' };
			case 'property': return { primitive: 'property', key: params.key || 'value' };
			case 'link': {
				const dir = params.direction === 'children-on-parent' || params.direction === 'both' ? params.direction : 'parent-on-child';
				return { primitive: 'link', key: params.key || 'parent', direction: dir };
			}
			case 'tag': return params.namespace ? { primitive: 'tag', namespace: params.namespace } : { primitive: 'tag' };
			case 'heading': return { primitive: 'heading', hostRule: 'root', depth: Number(params.depth) || 2 };
			case 'body': return { primitive: 'body', position: (params.position as 'section' | 'append' | 'table-row') || 'section' };
		}
	}

	// =========================================================================
	// Rendering helpers (pure formatting)
	// =========================================================================

	private detectionsForColumn(column: string): Detection[] {
		return this.detections.filter((d) => this.detectionColumns(d).includes(column));
	}

	private detectionColumns(d: Detection): string[] {
		switch (d.kind) {
			case 'level-column-chain': return d.columns;
			case 'edge-file': return [d.subjectColumn, d.objectColumn, ...(d.predicateColumn ? [d.predicateColumn] : [])];
			default: return 'column' in d ? [d.column] : [];
		}
	}

	private detectionKey(d: Detection): string {
		return `${d.kind}:${this.detectionColumns(d).join(',')}`;
	}

	/** Lucide icon id per detection kind (rendered via setIcon — theme-aware). */
	private badgeIcon(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return 'layers';
			case 'level-column-chain': return 'layers';
			case 'facet-candidate': return 'tag';
			case 'parent-column':
			case 'multi-value-link': return 'link';
			case 'title-candidate': return 'type';
			case 'body-candidate': return 'pilcrow';
			case 'edge-file': return 'arrow-left-right';
			case 'row-type-discriminator': return 'list';
		}
	}

	/** Short one-word chip label per detection kind (spec §7h #2). */
	private badgeLabel(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return 'hierarchy';
			case 'level-column-chain': return 'chain';
			case 'facet-candidate': return 'facet';
			case 'parent-column':
			case 'multi-value-link': return 'link';
			case 'title-candidate': return 'title';
			case 'body-candidate': return 'text';
			case 'edge-file': return 'edge';
			case 'row-type-discriminator': return 'mixed';
		}
	}

	private badgeTitle(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return `Packed hierarchy (${d.classification})`;
			case 'level-column-chain': return 'Level per column';
			case 'facet-candidate': return `Facet, ${d.cardinality} values`;
			case 'parent-column': return 'Parent column';
			case 'multi-value-link': return 'Multi-value link';
			case 'title-candidate': return 'Title candidate';
			case 'body-candidate': return 'Body candidate';
			case 'edge-file': return 'Edge-shaped file';
			case 'row-type-discriminator': return 'Row-type discriminator';
		}
	}

	private evidenceTitle(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return 'Packed hierarchy';
			case 'level-column-chain': return 'Hierarchy across columns';
			case 'facet-candidate': return 'Facet candidate';
			case 'parent-column': return 'Parent references';
			case 'multi-value-link': return 'Multiple references per cell';
			case 'title-candidate': return 'Title candidate';
			case 'body-candidate': return 'Body text candidate';
			case 'edge-file': return 'Relationship-shaped source';
			case 'row-type-discriminator': return 'Mixed row levels';
		}
	}

	private evidenceNotice(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return `Values split on "${d.delimiter}" into a ${d.classification} hierarchy.`;
			case 'level-column-chain': return `Values become more specific across ${d.columns.join(' → ')}.`;
			case 'facet-candidate': return `A small repeated set of ${d.cardinality} values behaves like labels.`;
			case 'parent-column': return `Values point from ${d.column} to identifiers in ${d.idColumn}.`;
			case 'multi-value-link': return `Cells list several identifiers found in ${d.idColumn}.`;
			case 'title-candidate': return 'Values are distinct enough to name individual rows.';
			case 'body-candidate': return 'Values are long, distinct prose suitable for note content.';
			case 'edge-file': return 'The source has subject and object identifiers, so its rows describe relationships.';
			case 'row-type-discriminator': return 'Repeated row types correlate with different sets of populated columns.';
		}
	}

	private evidenceCoverage(d: Detection, column: string): string {
		switch (d.kind) {
			case 'packed-hierarchy': return `${Math.round(d.coverage * 100)}% of sampled non-empty values contain the delimiter.`;
			case 'level-column-chain': {
				const position = d.columns.indexOf(column);
				const agreement = position > 0 ? d.agreements[position - 1] : d.agreements[0];
				const cardinality = d.cardinalities[column];
				return `${cardinality ?? 0} unique values${agreement === undefined ? '' : `, ${Math.round(agreement * 100)}% hierarchy agreement`}.`;
			}
			case 'facet-candidate': return `${d.cardinality} distinct label values in the sampled rows.`;
			case 'parent-column': return `${Math.round(d.matchRate * 100)}% of values match an identifier in ${d.idColumn}.`;
			case 'multi-value-link': return `${Math.round(d.matchRate * 100)}% of split values match an identifier, averaging ${d.avgValuesPerCell.toFixed(1)} per cell.`;
			case 'title-candidate': return `${Math.round(d.distinctness * 100)}% distinct among non-empty sampled values.`;
			case 'body-candidate': return `${Math.round(d.distinctness * 100)}% distinct, with an average length of ${Math.round(d.avgLength)} characters.`;
			case 'row-type-discriminator': return `${d.values.length} row types, with ${Math.round(d.maxJaccardDistance * 100)}% maximum fill-pattern difference.`;
			case 'edge-file': {
				if (column === d.subjectColumn) return `${Math.round(d.subjectConfidence * 100)}% identifier confidence for subjects.`;
				if (column === d.objectColumn) return `${Math.round(d.objectConfidence * 100)}% identifier confidence for objects.`;
				return `${Math.round((d.predicateConfidence ?? 0) * 100)}% predicate confidence.`;
			}
		}
	}

	private evidenceEffect(d: Detection): string {
		switch (d.kind) {
			case 'packed-hierarchy': return 'Proposes folders and a file name from the hierarchy levels.';
			case 'level-column-chain': return 'Proposes one hierarchy level for each detected source column.';
			case 'facet-candidate': return 'Proposes tags from this column when the active preset uses facets.';
			case 'parent-column': return 'Proposes a parent link when the active preset uses links.';
			case 'multi-value-link': return 'Proposes a list of links when the active preset uses links.';
			case 'title-candidate': return 'Supplies naming evidence but does not create a mapping by itself.';
			case 'body-candidate': return 'Suggests note content routing but does not create a shape mapping by itself.';
			case 'edge-file': return 'Flags relationship-shaped input but does not create a shape mapping by itself.';
			case 'row-type-discriminator': return 'Flags mixed row levels for review but does not create a mapping by itself.';
		}
	}

	private mappingTitle(m: StructureMapping): string {
		const cols = new Set<string>();
		for (const l of m.levels) cols.add(this.firstColumn(l.source));
		if (m.tail) cols.add(this.firstColumn(m.tail.source));
		return `${[...cols].slice(0, 2).join(', ') || 'mapping'}`;
	}

	/** Lucide icon id for a destination chip (rendered via setIcon). */
	private destChipIcon(d: Destination): string {
		switch (d.primitive) {
			case 'folder': return 'folder';
			case 'name': return 'file';
			case 'note': return 'file-plus';
			case 'heading': return 'hash';
			case 'property': return 'table';
			case 'tag': return 'tag';
			case 'link': return 'link';
			case 'alias': return 'quote';
			case 'body': return 'pilcrow';
		}
	}

	/** Short text label for a destination chip. */
	private destChipLabel(d: Destination): string {
		switch (d.primitive) {
			case 'folder': return 'folder';
			case 'name': return 'file name';
			case 'note': return 'own note';
			case 'heading': return `heading ${d.depth}`;
			case 'property': return d.key;
			case 'tag': return d.namespace ?? 'tag';
			case 'link': return d.key;
			case 'alias': return 'alias';
			case 'body': return 'body';
		}
	}

	/** Build a destination chip (icon + label) into `parent`; returns the chip element. */
	private destChip(parent: HTMLElement, d: Destination, extraCls = ''): HTMLElement {
		const chip = parent.createSpan({ cls: 'crosswalker-wb-chip' + (extraCls ? ' ' + extraCls : '') });
		wbIcon(chip, this.destChipIcon(d));
		chip.createSpan({ text: this.destChipLabel(d) });
		return chip;
	}

	private namingValue(naming: LevelNaming): string {
		return typeof naming === 'string' ? naming : 'part';
	}

	private isSplittable(source: LevelSource): boolean {
		const refs = toSourceRefs(source);
		if (refs.length > 1) return true;
		const only = refs[0];
		return !isConstantRef(only) && Array.isArray(only.part);
	}

	private sampleForLevel(rule: LevelRule): string {
		const sample = this.firstRow();
		if (!sample) return '-';
		try {
			const regions = toRecipeRegions({ mappings: [{ levels: [rule] }] });
			const recipe: Recipe = { recipe: 'wb-cell', target: regions as Recipe['target'] };
			const address = render(recipe, { curie: 'preview:1', scope: sample });
			// Show whichever rendered piece exists (folder path segment, name, or a frontmatter value).
			return address.primary.path || Object.values(address.frontmatter).filter((v) => v !== undefined && v !== 'concept')[0]?.toString() || '-';
		} catch {
			return '-';
		}
	}

	private firstColumn(source: LevelSource): string {
		const ref = toSourceRefs(source)[0];
		return isConstantRef(ref) ? ref.constant : ref.column;
	}

	private firstRow(): Record<string, unknown> | null {
		const rows = this.opts.parsedData.rows;
		if (!isEagerRows(rows) || rows.length === 0) return null;
		return rows[0] as Record<string, unknown>;
	}

	private describeAddress(a: Address): string {
		const lines: string[] = [];
		lines.push(this.withBase(a.primary.path));
		const fm = this.describeFrontmatter(a);
		if (fm.trim()) lines.push(fm);
		return lines.join('\n');
	}

	private describeFrontmatter(a: Address): string {
		const lines: string[] = ['---'];
		for (const [k, v] of Object.entries(a.frontmatter)) {
			if (k === 'curie') continue;
			lines.push(`${k}: ${String(v)}`);
		}
		if (a.tags.length) lines.push(`tags: [${a.tags.join(', ')}]`);
		if (a.aliases.length) lines.push(`aliases: [${a.aliases.join(', ')}]`);
		lines.push('---');
		return lines.length > 2 ? lines.join('\n') : '';
	}

	/**
	 * Build the preview tree as structured nodes (spec §7j #4). Folders are
	 * de-duplicated by their cumulative prefix; every file row carries the index of
	 * its address so a click can select that note. `addrIndex` for folders is -1.
	 */
	private buildTreeNodes(
		addresses: { row: number; address: Address }[],
	): { depth: number; label: string; isFile: boolean; addrIndex: number }[] {
		const seen = new Set<string>();
		const nodes: { depth: number; label: string; isFile: boolean; addrIndex: number }[] = [];
		addresses.slice(0, TREE_ROW_LIMIT).forEach((entry, ai) => {
			const full = this.withBase(entry.address.primary.path);
			if (!full) return;
			const parts = full.split('/');
			let prefix = '';
			parts.forEach((part, depth) => {
				prefix += (prefix ? '/' : '') + part;
				const isFile = depth === parts.length - 1;
				if (!isFile) {
					if (seen.has(prefix)) return;
					seen.add(prefix);
					nodes.push({ depth, label: part, isFile: false, addrIndex: -1 });
				} else {
					nodes.push({ depth, label: part, isFile: true, addrIndex: ai });
				}
			});
		});
		return nodes;
	}

	private basename(path: string): string {
		return path.split('/').pop() ?? path;
	}

	private withBase(path: string): string {
		const base = this.opts.outputPath;
		return base ? `${base}/${path}` : path;
	}

	private keyOf(column: string): string {
		return column.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
	}

	private slug(column: string): string {
		return column.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	}

	private sourceLabel(): string {
		return this.opts.parsedData.sheetName ?? 'source table';
	}
}
