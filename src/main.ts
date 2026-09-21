import { Plugin, Notice, TFile, TFolder, MarkdownView, Platform, apiVersion, normalizePath, type WorkspaceLeaf } from 'obsidian';
import { CrosswalkerSettings, DEFAULT_SETTINGS } from './settings/settings-data';
import { outputRootPath, outputRootFile, evidenceJunctionFolder, evidenceReportFolder, tier2SidecarPath } from './settings/folder-settings';
import {
	isImportableExtension,
	formatOntologyStatusLabel,
	checkFirstRun,
} from './ui/entry-points';
import { CrosswalkerSettingTab } from './settings/settings-tab';
import { ImportWizardModal } from './import/import-wizard';
import { RECIPE_REGISTRY } from './import/recipe-registry';
import { SssomImportModal } from './import/sssom-import-modal';
import { VaultSourceScanModal } from './import/vault-source-scan-modal';
import {
	ExportFolderPickerModal,
	exportFolderAsSssomTsv,
	exportFolderAsCsv,
	exportSiblingPath,
	writeExportFile,
	runFolderTypedTableExport,
} from './export';
import { ConfigBrowserModal } from './config/config-browser-modal';
import { buildCrosswalkerPivotViewFactory } from './views/crosswalker-pivot-view';
import {
	registerCrosswalkerBasesView,
	isBasesPluginAvailable,
	type CrosswalkerBasesViewOption,
} from './views/bases-api';
import { writeReferenceBaseFiles } from './views/reference-base-files';
import { CrosswalkerWorkspaceView, VIEW_TYPE_CROSSWALKER_WORKSPACE, toMinimalNode } from './views/workspace-view';
import { deriveInstalledOntologies } from './views/workspace-view-helpers';
import { DebugLog } from './utils/debug';
import { DraftStore } from './import/draft-store';
import { RecipePickerModal } from './views/recipe-picker-modal';
import { applyQueryToNote } from './views/apply-query-to-note';
import { regenerateAll } from './views/regenerate-query-views';
import { readQueryFrontmatter } from './views/query-frontmatter-io';
import { initValidator, validateRecipe as validateRecipeFn, validateTier1Frontmatter } from './validation/validator';
import { render } from './render';
import { legacyConfigToRecipe } from './generation/legacy-recipe-shim';
import { mergeFrontmatter, computeManagedKeys } from './generation/frontmatter-merge';
import { buildProvenance } from './generation/provenance';
import { generateNotes, generateFromRecipe } from './generation/generation-engine';
import { openSidecar, clearSidecar, type SidecarHandle } from './tier2/sidecar';
import { runEvidenceReportCommand } from './views/evidence-report-command';
import { runHousekeepingRebaselineCommand } from './views/rebaseline-housekeeping';
import { EvidenceLinkModal } from './views/evidence-link-modal';
import { projectFromTier1, type ProjectionResult } from './tier2/projector';
import { projectionErrorDiagnostics, waitForTier2StartupReadiness } from './tier2/startup-readiness';
import {
	getConceptsByOntology,
	crosswalkBetween,
	closureFromConcept,
	precomputeClosureForOntologyPair,
	type ConceptRow,
	type MappingRow,
	type ClosureEntry,
} from './tier2/queries';

/** Short platform label for the diagnostics bundle (no device-identifying detail). */
function diagnosticsPlatformLabel(): string {
	if (Platform.isMobileApp) {
		if (Platform.isIosApp) return 'mobile-ios';
		if (Platform.isAndroidApp) return 'mobile-android';
		return 'mobile';
	}
	if (Platform.isMacOS) return 'desktop-mac';
	if (Platform.isWin) return 'desktop-win';
	if (Platform.isLinux) return 'desktop-linux';
	return 'desktop';
}

/**
 * Crosswalker - Import structured ontologies into Obsidian
 *
 * Core capabilities:
 * 1. Import structured data (ontologies, taxonomies, frameworks) from CSV/XLSX/JSON
 * 2. Generate hierarchical folder structures with markdown notes
 * 3. Map columns to frontmatter properties with configurable transformations
 * 4. Create WikiLinks for crosswalks between nodes
 * 5. Enable typed links with metadata (Phase 2)
 */
export default class CrosswalkerPlugin extends Plugin {
	settings: CrosswalkerSettings;
	debug: DebugLog;
	draftStore: DraftStore;
	/**
	 * Bundled import presets, exposed so the E2E harness can cross-check the
	 * preset guide's rendered count against the registry it was built from.
	 */
	public readonly recipeRegistry = RECIPE_REGISTRY;

	/**
	 * Status bar "installed ontologies" indicator (discoverability entry
	 * point 3). Held so the count can be refreshed on layout-ready and on
	 * vault structure changes without re-adding the element.
	 */
	private ontologyStatusBarEl: HTMLElement | null = null;
	/** Coalesce bulk create/rename/delete events into one identity scan. */
	private ontologyStatusRefreshTimer: number | null = null;
	/** Prevent a slower stale scan from repainting after a newer one. */
	private ontologyStatusRefreshToken = 0;

	// Validator + render + generation-module handles attached to the plugin
	// instance so E2E tests + future command implementations can call them
	// via the plugin reference. Underlying implementations are pure module
	// exports.
	//
	// validateRecipe wraps the module export. The `recipeSchemaStyle` setting
	// was removed (settings-redesign report, 2026-07-11) — both discriminator
	// styles validated identically, so style 'A' is now hardcoded.
	validateRecipe = (recipe: unknown) => validateRecipeFn(recipe, 'A');
	validateTier1Frontmatter = validateTier1Frontmatter;
	render = render;
	legacyConfigToRecipe = legacyConfigToRecipe;
	mergeFrontmatter = mergeFrontmatter;
	computeManagedKeys = computeManagedKeys;
	buildProvenance = buildProvenance;

	/**
	 * runImport — exposed for E2E tests to invoke a full generation pass
	 * against a known parsedData + config. Wraps the public `generateNotes`
	 * export with the plugin's app + debug instances.
	 */
	runImport = async (parsedData: any, config: any, options: any) => {
		return generateNotes(this.app, parsedData, config, options, this.debug);
	};

	/**
	 * runImportFromRecipe — v0.1.4 native Ch 22 recipe entry. Bypasses the
	 * v0.1.0 column-role legacy logic and runs render() against the recipe
	 * directly. Used by junction-note + crosswalk-edge recipes (and any
	 * concept recipe authored natively without the wizard).
	 */
	runImportFromRecipe = async (parsedData: any, recipe: any, options: any) => {
		return generateFromRecipe(this.app, parsedData, recipe, options, this.debug);
	};

	/**
	 * Tier 2 sidecar handle. Lazily opened on first access (or via
	 * runProjection() E2E entry point). Reset to null when clearSidecar
	 * runs — next openTier2() call recreates from canonical Tier 1.
	 */
	tier2Handle: SidecarHandle | null = null;

	/**
	 * Lazy open the Tier 2 sidecar. Returns the cached handle if already
	 * open. Used by E2E + future Bases-query / exporter milestones.
	 */
	openTier2 = async (): Promise<SidecarHandle> => {
		if (this.tier2Handle) return this.tier2Handle;
		const handle = await openSidecar(this, this.app, {
			// S10 (2026-09-04). Through the accessor, so the path this opens the
			// query index at is normalized by the SAME function every other
			// path-shaped setting is, and cannot disagree with the path the clear
			// command below hands to the pool.
			sidecarPath: tier2SidecarPath(this.settings),
		});
		// Cache BEFORE any projection below, so the reprojection path cannot
		// re-enter this function and open a second handle.
		this.tier2Handle = handle;

		if (handle.schemaRebuilt) {
			// A schema rebuild empties every derived table. Without an immediate
			// reprojection the sidecar answers queries with zero rows, which is
			// indistinguishable from a vault that genuinely contains nothing --
			// a silent wrong answer, the same failure class as the closure-cache
			// depth bug fixed on 2026-08-20.
			//
			// This runs even when `enableTier2Projection` is off. That setting
			// governs routine auto-projection on vault load, not whether the
			// index may be left knowingly empty while still answering queries.
			// Reprojection is cheap: the projector reads Obsidian's existing
			// metadataCache rather than the filesystem, and stores rows only for
			// Crosswalker-generated notes.
			this.debug?.info(
				'tier2',
				'schema-rebuild-reprojection',
				'Tier 2 schema was rebuilt; reprojecting so queries are not served from an empty index',
			);
			await projectFromTier1(this.app, handle.db, { debug: this.debug, projectionMode: 'full' });
		}

		return handle;
	};

	/**
	 * Run a Tier 1 → Tier 2 projection pass over the vault. Walks every
	 * `.md` file, dispatches by `kind`, populates `concepts` /
	 * `mappings` / `junction_notes` tables. Idempotent — re-running on
	 * an unchanged vault produces the same Tier 2 state. Per
	 * [system architecture Layer 3](https://cybersader.github.io/crosswalker/concepts/system-architecture/#layer-3--projection-t1--t2).
	 */
	/**
	 * The projection currently running, if any, so a reset can wait for it to
	 * let go of the database instead of deleting the file out from under it.
	 */
	private tier2InFlightProjection: Promise<ProjectionResult> | null = null;
	/**
	 * Set while the sidecar is being torn down. Read by the projector at each
	 * yield point, and checked before a new projection starts.
	 */
	private tier2TeardownInProgress = false;
	/** Permanently set when this plugin instance begins unloading. */
	private tier2Unloaded = false;

	runProjection = async (): Promise<ProjectionResult> => {
		if (this.tier2TeardownInProgress || this.tier2Unloaded) {
			// A reset is deleting the database right now. Starting here would do
			// up to a full yield-interval of work against a file that is about to
			// disappear, so decline before opening anything.
			return {
				success: true,
				aborted: true,
				counts: { concepts: 0, mappings: 0, junction_notes: 0, ontologies: 0, skipped: 0, errors: 0 },
				errors: [],
				durationMs: 0,
			};
		}
		// One full pass owns the projection marks at a time. A second pass would
		// initialize and prune through the first pass's marks, so overlapping callers
		// share the already-running result instead of opening another pass.
		if (this.tier2InFlightProjection) return this.tier2InFlightProjection;
		const run = (async (): Promise<ProjectionResult> => {
			const handle = await this.openTier2();
			return projectFromTier1(this.app, handle.db, {
				debug: this.debug,
				projectionMode: 'full',
				shouldAbort: () => this.tier2TeardownInProgress,
			});
		})();
		// Published so the reset can await it. Cleared only if still ours, so a
		// slower run cannot wipe a newer one out of the slot.
		this.tier2InFlightProjection = run;
		try {
			return await run;
		} finally {
			if (this.tier2InFlightProjection === run) this.tier2InFlightProjection = null;
		}
	};

	/**
	 * v0.1.5 Phase 3 query API — typed SQL helpers for the v0.1.6 Bases
	 * query layer + v0.1.7 exporters. Per
	 * [system architecture Layer 4](https://cybersader.github.io/crosswalker/concepts/system-architecture/#layer-4--query-t1--t2--user).
	 */
	queryConcepts = async (ontologyId: string): Promise<ConceptRow[]> => {
		const handle = await this.openTier2();
		return getConceptsByOntology(handle.db, ontologyId);
	};

	queryCrosswalk = async (
		subjectOntology: string,
		objectOntology: string,
		predicateId?: string,
	): Promise<MappingRow[]> => {
		const handle = await this.openTier2();
		return crosswalkBetween(handle.db, subjectOntology, objectOntology, predicateId);
	};

	queryClosure = async (
		startCurie: string,
		predicateId?: string,
		maxDepth?: number,
	): Promise<ClosureEntry[]> => {
		const handle = await this.openTier2();
		return closureFromConcept(handle.db, startCurie, predicateId, maxDepth);
	};

	/**
	 * v0.1.6 Phase 2 (per Ch 35): eagerly precompute closure for an
	 * imported ontology pair after SSSOM import. Idempotent. Returns the
	 * count of cached (subject, target) pairs after precompute.
	 */
	precomputeClosure = async (
		sourceOntology: string,
		targetOntology: string,
		predicateId?: string,
	): Promise<number> => {
		const handle = await this.openTier2();
		return precomputeClosureForOntologyPair(handle.db, sourceOntology, targetOntology, predicateId);
	};

	async onload() {
		await this.loadSettings();

		// Initialize debug logging (Phase 3.5 — wide-event NDJSON logger)
		this.debug = new DebugLog(
			this.app,
			this.settings.enableDebugLog,
			this.settings.verboseLogging,
			this.settings.debugLogCategoryFilters,
			this.settings.debugLogLevel,
		);

		// Initialize draft store (Phase 3.6 — wizard auto-save / resume).
		// Constructed unconditionally so commands always have a handle; gated
		// by enableDraftSessions at the wizard hook sites.
		this.draftStore = new DraftStore(this.app, this.debug, {
			draftExpiryDays: this.settings.draftExpiryDays,
			maxDrafts: this.settings.maxDrafts,
		});

		// Compile spec schemas (spec/tier1.schema.json + spec/recipe.schema.json)
		// at startup. Throws fast if schema files are malformed.
		initValidator();

		// Register the main import command
		this.addCommand({
			id: 'import-structured-data',
			name: 'Start here: import structured data',
			callback: () => {
				new ImportWizardModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'find-vault-sources',
			name: 'Start here: find framework sources in this vault',
			callback: () => {
				new VaultSourceScanModal(this.app, this).open();
			},
		});

		// v0.1.6 Phase 2: SSSOM TSV import (per Ch 35)
		this.addCommand({
			id: 'import-sssom',
			name: 'Import and export: import crosswalk mapping file',
			callback: () => {
				new SssomImportModal(this.app, this).open();
			},
		});

		// v0.1.6 Phase 4.6: recipe picker — create a new query (Layout B+).
		// Canonical state lives at _crosswalker/queries/<slug>/{index.md,view.base};
		// the host note (current editor) receives only an `![[<slug>/view.base]]`
		// embed at cursor. To edit an existing query, open its index.md directly
		// and re-run "Maintenance: refresh saved query views" or use "Maintenance:
		// update saved queries to the current layout" if you have legacy Phase 4.5 frontmatter on host notes.
		this.addCommand({
			id: 'insert-query-into-note',
			name: 'Explore data: create a query in the current note',
			editorCallback: (editor, ctx) => {
				const file = ctx.file;
				if (!file) {
					new Notice('Open a Markdown note before running this command.', 5000);
					return;
				}
				const traceId = this.debug.newTraceId();
				void this.debug.withTrace(traceId, async () => {
					// Phase 4.6: check for legacy v1 host-note frontmatter — prompt migration first
					const cache = this.app.metadataCache.getFileCache(file);
					if (cache?.frontmatter?.crosswalker_query) {
						const sv = (cache.frontmatter.crosswalker_query as { schema_version?: number }).schema_version;
						if (sv === 1) {
							new Notice(
								'This note has legacy (Phase 4.5) Crosswalker frontmatter. ' +
								'Run "Maintenance: update saved queries to the current layout" first to move it into _crosswalker/queries/.',
								8000,
							);
							this.debug.info('view', 'picker-blocked-on-legacy', 'Picker blocked — legacy v1 frontmatter on host note', { host: file.path });
							return;
						}
					}
					this.debug.info('view', 'picker-open', 'Recipe picker opened (Layout B+ CREATE flow)');
					new RecipePickerModal(this.app, this, async (result) => {
						if (result.action === 'cancel') {
							this.debug.info('view', 'picker-cancelled', 'Recipe picker cancelled');
							return;
						}
						const applyResult = await applyQueryToNote({
							app: this.app,
							file,
							editor,
							recipeId: result.recipeId,
							recipeName: result.recipeName,
							shape: result.shape,
							params: result.params,
							collisionMode: 'auto-suffix', // TODO Phase 4.7: refuse-and-prompt modal for picker entry point
							debug: this.debug,
						});
						if (applyResult.ok) {
							new Notice(`Created query: ${applyResult.slug}`, 4000);
						} else if (applyResult.reason === 'slug-collision') {
							new Notice(`Query name "${applyResult.existingSlug}" already exists. Pick a different name or use a different recipe.`, 8000);
						} else {
							new Notice(`Could not apply query: ${applyResult.reason}.`, 6000);
						}
					}, null).open();
				});
			},
		});

		// v0.1.6 Phase 4.6: one-shot migration of legacy Phase 4.5 host-note
		// frontmatter to Layout B+ per-query folders. Idempotent.
		this.addCommand({
			id: 'migrate-query-layout',
			name: 'Maintenance: update saved queries to the current layout',
			callback: async () => {
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { migrateQueriesToFolderLayout } = await import('./views/migrate-query-layout');
					const { loadAllRecipes } = await import('./views/recipe-loader');
					// `recipeSchemaStyle` setting removed (settings-redesign report, 2026-07-11); style 'A' hardcoded.
					const loadResult = await loadAllRecipes(this.app, 'A', this.debug);
					const result = await migrateQueriesToFolderLayout({
						app: this.app,
						debug: this.debug,
						recipes: loadResult.recipes,
					});
					new Notice(
						`Migration scan: scanned ${result.scanned}, migrated ${result.migrated}, skipped ${result.skipped}` +
							(result.errors.length > 0 ? `, ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}` : ''),
						8000,
					);
				});
			},
		});

		// v0.1.6 Phase 4.7: Embed an existing query at the cursor — lightweight
		// picker over `_crosswalker/queries/<slug>/`. Per the 3-command split,
		// embedding is CHEAP (just inserts `![[<slug>/view.base]]`); no scan.
		this.addCommand({
			id: 'embed-existing-query',
			name: 'Explore data: embed a saved query in the current note',
			editorCallback: async (editor, ctx) => {
				const file = ctx.file;
				if (!file) {
					new Notice('Open a Markdown note before running this command.', 5000);
					return;
				}
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { EmbedExistingQueryModal } = await import('./views/embed-existing-query-modal');
					const { insertEmbedAtCursor } = await import('./views/insert-base-block');
					new EmbedExistingQueryModal(this.app, async (result) => {
						if (result.action === 'cancel') {
							this.debug.info('view', 'embed-picker-cancelled', 'Embed picker cancelled');
							return;
						}
						const insertResult = insertEmbedAtCursor(editor, result.viewFile);
						if (insertResult.ok) {
							this.debug.info('view', 'embed-inserted', `Embed inserted at cursor`, { slug: result.slug, host: file.path, position: insertResult.reason });
							new Notice(`Embedded "${result.slug}" at cursor.`, 4000);
						} else {
							this.debug.warn('view', 'embed-insert-failed', `Could not insert embed`, { reason: insertResult.reason });
							new Notice(`Could not insert embed: ${insertResult.reason}`, 6000);
						}
					}).open();
				});
			},
		});

		// v0.1.6 Phase 4.7: Browse all queries — discovery surface with
		// per-row actions (Open canonical / Embed here / Delete folder).
		this.addCommand({
			id: 'browse-queries',
			name: 'Explore data: browse saved queries',
			callback: async () => {
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { BrowseQueriesModal } = await import('./views/browse-queries-modal');
					const { insertEmbedAtCursor } = await import('./views/insert-base-block');
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					const editor = activeView?.editor ?? null;
					const activeFile = activeView?.file ?? null;
					new BrowseQueriesModal(this.app, {
						editor,
						activeFile,
						insertEmbed: async (slug, viewFile) => {
							if (!editor) return;
							const r = insertEmbedAtCursor(editor, viewFile);
							if (r.ok) {
								this.debug.info('view', 'embed-inserted', `Embed inserted at cursor (from Browse)`, { slug, host: activeFile?.path, position: r.reason });
								new Notice(`Embedded "${slug}" at cursor.`, 4000);
							} else {
								this.debug.warn('view', 'embed-insert-failed', `Could not embed from Browse`, { reason: r.reason });
								new Notice(`Could not embed: ${r.reason}`, 6000);
							}
						},
					}).open();
				});
			},
		});

		// v0.1.6 Phase 6.3: import a bundled realistic crosswalk fixture.
		// One-click way to populate the vault with junction notes so the pivot
		// can render with real data. Dev convenience — bundles ~6KB of SSSOM
		// TSV inside main.js to skip the manual file-copy step.
		this.addCommand({
			id: 'import-bundled-fixture',
			name: 'Developer tools: import bundled test data',
			callback: async () => {
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { BUNDLED_FIXTURES } = await import('./views/bundled-fixtures');
					const { importSssom, SSSOM_CURIE_PREFIX } = await import('./import/sssom-importer');
					// AM-18. The one implementation of "which new set", imported here
					// rather than re-decided, so this command cannot be the fourth copy.
					const { newSetSchemeFor } = await import('./generation/import-set');

					// Pick a fixture via a small AskUserQuestion-style modal
					const { Modal, ButtonComponent } = await import('obsidian');
					const picked = await new Promise<string | null>((resolve) => {
						const modal = new Modal(this.app);
						modal.contentEl.createEl('h2', { text: 'Import a bundled test fixture' });
						modal.contentEl.createEl('p', {
							// eslint-disable-next-line obsidianmd/ui/sentence-case -- SSSOM is a domain acronym not in the linter's default acronym list
							text: 'Populates _crosswalker/mappings/ with junction notes from a realistic SSSOM crosswalk. Useful for end-to-end pivot testing.',
							cls: 'crosswalker-modal-subtitle',
						});
						for (const fx of BUNDLED_FIXTURES) {
							const row = modal.contentEl.createDiv({ cls: 'crosswalker-fixture-row' });
							row.createEl('div', { text: fx.displayName, cls: 'crosswalker-fixture-title' });
							row.createEl('div', {
								text: `${fx.rowCount} mappings · ${fx.subjectOntology} → ${fx.objectOntology}`,
								cls: 'crosswalker-fixture-meta',
							});
							new ButtonComponent(row).setButtonText('Import').setCta().onClick(() => {
								modal.close();
								resolve(fx.id);
							});
						}
						const footer = modal.contentEl.createDiv({ cls: 'crosswalker-modal-footer' });
						new ButtonComponent(footer).setButtonText('Cancel').onClick(() => {
							modal.close();
							resolve(null);
						});
						modal.open();
					});

					if (!picked) return;
					const fx = BUNDLED_FIXTURES.find((f) => f.id === picked)!;

					// AM-24 (2026-08-31). The qualification rule now refuses to answer
					// from a half-read vault, and a refusal must reach the person who
					// asked. Resolved BEFORE the "Importing..." notice, and caught here:
					// left inline in the options object below, the throw would escape the
					// command callback as an unhandled rejection, and the only symptom
					// would be a command that did nothing at all.
					let importSet: 'new' | 'new-set-qualified';
					try {
						// AM-18 (2026-08-31). WHICH new set is a question this route used
						// to skip: the bare literal `new` always mints endpoint-v1, so
						// loading a fixture into a vault that already held that ontology
						// pair produced a set whose curie space was already occupied, and
						// AM-12 then correctly refused every single row ("0 junction
						// notes, N errors"). Not damage, but exactly the routine collision
						// AM-13 exists to eliminate. One shared rule answers it here as
						// everywhere else.
						importSet = await newSetSchemeFor(this.app, SSSOM_CURIE_PREFIX);
					} catch (err) {
						new Notice(err instanceof Error ? err.message : String(err), 10000);
						return;
					}

					new Notice(`Importing ${fx.displayName}...`, 3000);

					const result = await importSssom(
						this.app,
						fx.tsv,
						null, // no projection callback
						null, // no closure callback
						{
							// AM-9. This developer command has no ownership control on it
							// at all, so it says the only safe thing there is to say: a new
							// set. It used to pass nothing, and the engine read that as
							// "refresh whichever crosswalk already sits in this mapping
							// folder", which meant loading a bundled fixture could replace
							// a real crosswalk a user had imported into the same pair.
							//
							// Resolved above, through the one shared qualification rule.
							importSet,
							// Nothing exists under a freshly minted set, so this only rules
							// out rewriting a note the run does not own.
							overwriteMode: 'skip',
						},
						this.debug,
					);
					// AM-8 (via the pass-8 adversarial's secondary observations). There is
					// no entry point exempt from saying WHY a row was refused: a bare
					// count tells a reader that something went wrong and nothing about
					// what to do. `created` is a list of paths, so its LENGTH is the
					// count -- interpolating the array printed the paths where a number
					// belonged.
					const createdCount = result.generation?.created?.length ?? 0;
					const errors = result.generation?.errors ?? [];
					const conflicts = result.generation?.conflicts ?? [];
					const skipReason = result.skipped ? ` (skipped: ${result.skipped})` : '';
					const refused = errors.length > 0 ? `, ${errors.length} rows refused` : '';
					const unchanged = conflicts.length > 0 ? `, ${conflicts.length} notes left unchanged` : '';
					const detail = errors.length > 0
						? `\n${errors.slice(0, 3).map((error) => error.message).join('\n')}`
							+ (errors.length > 3 ? `\nAnd ${errors.length - 3} more.` : '')
						: '';
					new Notice(
						`Imported "${fx.displayName}": ${createdCount} junction notes${refused}${unchanged}${skipReason}.${detail}`,
						errors.length > 0 ? 15000 : 6000,
					);
				});
			},
		});

		// Rapid-test loop (dev): clear an ad-hoc test import in one click without
		// touching the curated corpus / fixtures / views. The CLI twin is
		// `bun run reset` (scripts/reset-test-vault.mjs) — same protected list.
		this.addCommand({
			id: 'reset-imported-notes',
			name: 'Developer tools: delete a test import',
			callback: async () => {
				const { scanGeneratedImports, deleteImportedNotes } = await import('./views/reset-imports');
				const { Modal, ButtonComponent, Notice } = await import('obsidian');
				const groups = await scanGeneratedImports(this.app);
				const deletable = groups.filter((g) => !g.protected);
				const totalDeletable = deletable.reduce((n, g) => n + g.count, 0);

				const modal = new Modal(this.app);
				modal.titleEl.setText('Reset imported notes');
				const c = modal.contentEl;
				if (groups.length === 0) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Crosswalker" is the plugin's proper name
					c.createEl('p', { text: 'No Crosswalker-generated notes found.', cls: 'crosswalker-modal-subtitle' });
				} else {
					c.createEl('p', {
						text: 'Delete an ad-hoc test import. The curated corpus, fixtures, and views are listed but protected.',
						cls: 'crosswalker-modal-subtitle',
					});
					for (const g of deletable) {
						const row = c.createDiv({ cls: 'crosswalker-fixture-row' });
						const txt = row.createDiv();
						txt.createEl('div', { text: `${g.folder}/`, cls: 'crosswalker-fixture-title' });
						txt.createEl('div', { text: `${g.count} generated notes`, cls: 'crosswalker-fixture-meta' });
						new ButtonComponent(row).setButtonText('Delete').setWarning().onClick(async () => {
							modal.close();
							const n = await deleteImportedNotes(this.app, g.paths);
							new Notice(`Deleted ${n} notes from ${g.folder}/`);
						});
					}
					if (deletable.length === 0) {
						c.createEl('p', { text: 'No deletable test imports — every generated note is curated corpus.', cls: 'crosswalker-fixture-meta' });
					}
					for (const g of groups.filter((x) => x.protected)) {
						const row = c.createDiv({ cls: 'crosswalker-fixture-row crosswalker-fixture-protected' });
						const txt = row.createDiv();
						txt.createEl('div', { text: `${g.folder}/  ·  protected corpus`, cls: 'crosswalker-fixture-title' });
						txt.createEl('div', { text: `${g.count} notes — kept`, cls: 'crosswalker-fixture-meta' });
					}
					const footer = c.createDiv({ cls: 'crosswalker-modal-footer' });
					if (totalDeletable > 0) {
						new ButtonComponent(footer)
							.setButtonText(`Delete all ${totalDeletable} test notes`)
							.setWarning()
							.onClick(async () => {
								modal.close();
								const n = await deleteImportedNotes(this.app, deletable.flatMap((g) => g.paths));
								new Notice(`Deleted ${n} test notes. Curated corpus untouched.`);
							});
					}
					new ButtonComponent(footer).setButtonText('Cancel').onClick(() => modal.close());
				}
				modal.open();
			},
		});

		// v0.1.6 Phase 6.3: run the Layer A primitive benchmark suite.
		// No vault data needed — synthesizes data at varying scales (100/1k/10k
		// rows), times each primitive (array + streaming variants), emits NDJSON
		// `perf` events into the debug log. Useful for spotting regressions +
		// understanding scale characteristics.
		this.addCommand({
			id: 'benchmark-primitives',
			name: 'Developer tools: run a performance check',
			callback: async () => {
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { runBenchmark, formatBenchmarkSummary } = await import('./views/benchmark-primitives');
					new Notice('Running primitives benchmark (this takes a few seconds)...', 3000);
					// Yield once so the Notice renders before we block on CPU
					await new Promise((r) => setTimeout(r, 50));
					const summary = runBenchmark({ debug: this.debug });
					const formatted = formatBenchmarkSummary(summary);
					this.debug.info('perf', 'benchmark-summary', `Benchmark complete`, {
						totalDurationMs: summary.totalDurationMs,
						scales: summary.scales,
						resultCount: summary.results.length,
					});
					try {
						await navigator.clipboard.writeText(formatted);
						new Notice(
							`Benchmark complete in ${summary.totalDurationMs.toFixed(0)}ms. ` +
							`${summary.results.length} timings logged to crosswalker-debug.log. ` +
							`Summary copied to clipboard.`,
							8000,
						);
					} catch {
						new Notice(
							`Benchmark complete in ${summary.totalDurationMs.toFixed(0)}ms. ` +
							`${summary.results.length} timings logged to crosswalker-debug.log. ` +
							`(Clipboard write failed; check debug log for full numbers.)`,
							8000,
						);
					}
				});
			},
		});

		// v0.1.6 Phase 5: materialize the current query (write a snapshot
		// JSON to <slug>/materialized/result.json). Opt-in, audit/share use
		// case per Ch 32 deliverable B. Default browse stays live.
		this.addCommand({
			id: 'materialize-query',
			name: 'Explore data: save a snapshot of the current query',
			editorCallback: async (_editor, ctx) => {
				const file = ctx.file;
				if (!file) {
					new Notice('Open a Markdown note (query index.md or host) before materializing.', 5000);
					return;
				}
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const { materializeQuery, lookupQuery } = await import('./views/materialize');
					const { readQueryFrontmatter } = await import('./views/query-frontmatter-io');

					// Resolve target slug: prefer canonical index.md (file is the query itself)
					let slug: string | null = null;
					if (file.path.startsWith('_crosswalker/queries/') && file.path.endsWith('/index.md')) {
						const fm = await readQueryFrontmatter(this.app, file);
						if (fm.present && fm.data) slug = fm.data.slug;
					}
					if (!slug) {
						new Notice('Open a query\'s index.md (under _crosswalker/queries/) and re-run this command.', 6000);
						return;
					}
					const q = await lookupQuery(this.app, slug);
					if (!q) {
						new Notice(`Could not look up query "${slug}".`, 5000);
						return;
					}

					// Minimal Phase 5 snapshot: record the recipe+params + a timestamp.
					// The view-shape-specific resolved data is written by view-side
					// materialization helpers in v0.1.7+ (table/list/pivot/hierarchy
					// each contribute their snapshot via materializeQuery as needed).
					const r = await materializeQuery(this.app, {
						slug,
						queryId: q.queryId,
						recipe: q.recipe,
						shape: q.shape,
						data: { note: 'Phase 5 baseline snapshot — view-shape-specific resolved data lands in v0.1.7+.', params: q.params },
						metadata: { phase: '5-baseline' },
					}, this.debug);
					if (r.ok) {
						new Notice(`Materialized "${slug}" → ${r.resultPath} (${r.bytesWritten} bytes)`, 5000);
					} else {
						new Notice(`Materialize failed: ${r.error}`, 6000);
					}
				});
			},
		});

		// v0.1.6 Phase 4.5: explicit refresh — re-scan all notes with
		// `crosswalker_query:` frontmatter and regenerate their .base files from
		// the (possibly hand-edited) frontmatter. Idempotent — skips notes
		// whose .base content already matches.
		this.addCommand({
			id: 'refresh-query-views',
			name: 'Maintenance: refresh saved query views',
			callback: async () => {
				const traceId = this.debug.newTraceId();
				await this.debug.withTrace(traceId, async () => {
					const result = await regenerateAll(this.app, this.debug);
					new Notice(
						`Refreshed ${result.regenerated} view${result.regenerated === 1 ? '' : 's'}` +
							(result.skipped > 0 ? `; ${result.skipped} up-to-date` : '') +
							(result.errors.length > 0 ? `; ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}` : ''),
						5000,
					);
				});
			},
		});

		// Register config browser command
		this.addCommand({
			id: 'browse-saved-configs',
			name: 'Import setup: browse saved configurations',
			callback: () => {
				new ConfigBrowserModal(this.app, this, 'browse').open();
			}
		});

		// Create one evidence link. Exists because the only prior ways to make
		// one were bulk import and hand-writing frontmatter, and the published
		// example had subject and object inverted, which yields links that look
		// correct and never count. Asking for "the control" and "the evidence"
		// makes the load-bearing direction impossible to enter backwards.
		this.addCommand({
			id: 'link-evidence-to-control',
			name: 'Evidence: link evidence to a control',
			callback: () => {
				// Pre-select the control when run from an open control note.
				//
				// AM-46 (2026-09-02). The PATH is handed over, not a resolved
				// candidate. This used to resolve it here against a cache-only read
				// of the whole vault, so a control Obsidian had not indexed yet
				// resolved to nothing and the window silently selected a DIFFERENT
				// control (the first in its list) for the reviewer's evidence. The
				// window resolves the path against its one fail-closed scan instead,
				// and a note it cannot read is a refusal by name rather than a
				// substitution. Cache lag is not absence.
				const active = this.app.workspace.getActiveFile();
				new EvidenceLinkModal({
					app: this.app,
					// AM-57 (2026-09-04). Through the accessor, so the folder composed into
					// the junction's vault path is normalized once here rather than by each
					// site that composes with it, and never not at all.
					folder: evidenceJunctionFolder(this.settings),
					initialControlPath: active?.path,
				}).open();
			},
		});

		// Evidence coverage report. The gap question cannot be answered by a
		// Bases view (a filter selects among notes that exist, and a control
		// with no evidence has no note to select), so this command renders it
		// from the query index into a note the user can keep and share.
		this.addCommand({
			id: 'evidence-coverage-report',
			name: 'Evidence: create coverage report',
			callback: async () => {
				await runEvidenceReportCommand({
					app: this.app,
					openTier2: this.openTier2,
					refreshForReport: this.runProjection,
					// AM-57. Same accessor discipline as the junction folder above.
					reportFolder: evidenceReportFolder(this.settings),
				});
			},
		});

		// Housekeeping changes can be acknowledged without pretending the control
		// wording or scope was re-reviewed. Selection + confirmation are both
		// mandatory; status and reviewer facts are never touched.
		this.addCommand({
			id: 'record-selected-housekeeping-baseline',
			name: 'Maintenance: record selected housekeeping changes as baseline',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				await runHousekeepingRebaselineCommand({
					app: this.app,
					openTier2: this.openTier2,
					selection: view?.editor.getSelection() ?? '',
				});
			},
		});

		// v0.1.5: Tier 2 sidecar — clear command
		this.addCommand({
			id: 'clear-tier-2-sidecar',
			name: 'Maintenance: reset search data',
			callback: async () => {
				// Signal before anything else, then wait. A projection holds the
				// database across many cooperative yields, so without this the
				// reset could close and delete the file mid-run and the projector
				// would resume against a dead handle -- surfacing an error next to
				// the reset's own success notice, for a user who did nothing
				// wrong. Signalling without waiting would only narrow the window;
				// awaiting closes it. The wait is bounded by one yield interval.
				this.tier2TeardownInProgress = true;
				try {
					if (this.tier2InFlightProjection) {
						// Its failure, if any, belongs to whoever started it.
						await this.tier2InFlightProjection.catch(() => undefined);
					}
					// Close and drop the handle BEFORE deleting. Unlinking a file
					// that still has an open sahpool access handle is undefined
					// behavior, and a surviving handle would keep answering queries
					// out of the rows the user just asked us to destroy.
					if (this.tier2Handle) {
						const closed = await this.tier2Handle.close();
						this.tier2Handle = null;
						if (!closed) {
							// Deleting a pool file whose access handle is still
							// open recycles that handle under a live file. Stop
							// here: a confusing error beats silent corruption.
							throw new Error('the query index could not be closed, so it was not cleared. Reload Obsidian and try again.');
						}
					}
					// S10. The same accessor the open path reads. A clear that keys the
					// pool differently from the open finds no files, deletes nothing, and
					// reports the index as already empty.
					const result = await clearSidecar(this, tier2SidecarPath(this.settings));
					// clearSidecar throws when it cannot verify the file is gone, so
					// reaching here means the reset actually happened. Each outcome
					// gets its own wording: announcing a deletion that did not occur
					// is the bug this command shipped with.
					if (!result.hadPersistentStore) {
						new Notice('Fast query index was held in memory only. It has been discarded and rebuilds automatically.');
					} else if (result.removed.length === 0) {
						new Notice('Fast query index was already empty. There was nothing to clear.');
					} else {
						new Notice('Fast query index cleared. It rebuilds automatically.');
					}
					this.debug?.info('tier2', 'clear-ok', 'Tier 2 sidecar cleared', {
						hadPersistentStore: result.hadPersistentStore,
						removed: result.removed,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Failed to clear the fast query index: ${msg}`);
					this.debug?.error('tier2', 'clear-failed', 'Tier 2 sidecar clear failed', { error: msg });
				} finally {
					// Must run on every path. Leaving this set would make the
					// plugin refuse to project for the rest of the session, and
					// the index would silently never rebuild.
					this.tier2TeardownInProgress = false;
				}
			},
		});

		// v0.1.6 Phase 3.5: debug log commands — open / export / clear
		this.addCommand({
			id: 'open-debug-log',
			name: 'Developer tools: open troubleshooting log',
			callback: async () => {
				const path = this.debug.getLogPath();
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					await this.app.workspace.getLeaf(true).openFile(file);
				} else {
					new Notice(`Debug log not found at vault root (${path}). Enable debug logging in settings and trigger any action to generate one.`);
				}
			},
		});

		this.addCommand({
			id: 'export-debug-log',
			name: 'Developer tools: copy troubleshooting log to clipboard',
			callback: async () => {
				const content = await this.debug.readForExport();
				if (!content) {
					new Notice('Debug log is empty or unreadable.');
					return;
				}
				try {
					await navigator.clipboard.writeText(content);
					new Notice(`Copied ${Math.round(content.length / 1024)} KB to clipboard (likely tokens redacted).`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Clipboard write failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'copy-diagnostics',
			name: 'Developer tools: copy troubleshooting details to clipboard',
			callback: async () => {
				const bundle = this.debug.assembleDiagnostics({
					pluginVersion: this.manifest.version,
					obsidianVersion: apiVersion,
					platform: diagnosticsPlatformLabel(),
					settings: this.settings as unknown as Record<string, unknown>,
				});
				try {
					await navigator.clipboard.writeText(bundle);
					new Notice(`Copied diagnostics (${Math.round(bundle.length / 1024)} KB) to clipboard. Redacted: no vault paths, file names, or cell values.`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Clipboard write failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'clear-debug-log',
			name: 'Developer tools: clear troubleshooting log',
			callback: async () => {
				await this.debug.clear();
				new Notice('Debug log cleared.');
			},
		});

		// v0.1.6 Phase 3.6: draft session commands. The wizard's Step 1 now
		// always shows a 'Drafts from previous sessions' section, so this
		// command just opens the wizard. The user picks Resume from Step 1.
		this.addCommand({
			id: 'resume-draft-import',
			name: 'Import setup: resume a draft import',
			callback: () => {
				new ImportWizardModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'clear-all-drafts',
			name: 'Maintenance: clear all import drafts',
			callback: async () => {
				const count = await this.draftStore.clearAll();
				new Notice(`Cleared ${count} draft import${count === 1 ? '' : 's'}.`);
			},
		});

		this.addCommand({
			id: 'purge-expired-drafts',
			name: 'Maintenance: remove expired import drafts',
			callback: async () => {
				const count = await this.draftStore.purgeExpired();
				new Notice(`Purged ${count} expired draft import${count === 1 ? '' : 's'}.`);
			},
		});

		// v0.1.7 Phase 1: crosswalk mapping file export (SSSOM-flavored TSV
		// under the hood — "crosswalk mapping file" is the ui-lexicon term;
		// no SSSOM/STRM/OSCAL vocabulary in user-facing strings). Interim
		// door: command palette only, no settings-UI destination picker yet
		// (parity gap per the UI-parity convention — flag for a follow-up
		// round, same as the SSSOM importer's own Phase 2 entry point).
		this.addCommand({
			id: 'export-folder-as-crosswalk-mapping-file',
			name: 'Import and export: export folder as a crosswalk mapping file',
			callback: () => {
				new ExportFolderPickerModal(this.app, (folder) => {
					void (async () => {
						const result = await exportFolderAsSssomTsv(this.app, folder.path);
						if (result.rowCount === 0) {
							new Notice(`No crosswalk mappings found under "${folder.path}". Nothing exported.`, 6000);
							return;
						}
						const destPath = exportSiblingPath(folder, 'tsv');
						await writeExportFile(this.app, destPath, result.tsv);
						new Notice(
							`Exported ${result.rowCount} mapping${result.rowCount === 1 ? '' : 's'} to ${destPath}` +
								(result.skipped.length > 0
									? ` (${result.skipped.length} note${result.skipped.length === 1 ? '' : 's'} skipped)`
									: ''),
							6000,
						);
					})();
				}).open();
			},
		});

		this.addCommand({
			id: 'export-folder-as-typed-mapping-table',
			name: 'Import and export: export folder as a typed mapping table',
			callback: () => {
				new ExportFolderPickerModal(this.app, (folder) => {
					void runFolderTypedTableExport({ app: this.app, folder })
						.then((outcome) => {
							new Notice(outcome.message, outcome.status === 'failed' ? 8000 : 6000);
						})
						.catch(() => {
							new Notice('Could not finish the export; check the destination file before trying again.', 8000);
						});
				}).open();
			},
		});

		this.addCommand({
			id: 'export-folder-as-csv',
			name: 'Import and export: export folder as CSV',
			callback: () => {
				new ExportFolderPickerModal(this.app, (folder) => {
					void (async () => {
						const result = await exportFolderAsCsv(this.app, folder.path);
						if (result.rowCount === 0) {
							new Notice(`No notes found under "${folder.path}". Nothing exported.`, 6000);
							return;
						}
						const destPath = exportSiblingPath(folder, 'csv');
						await writeExportFile(this.app, destPath, result.csv);
						new Notice(
							`Exported ${result.rowCount} note${result.rowCount === 1 ? '' : 's'} to ${destPath}` +
								(result.skipped.length > 0
									? ` (${result.skipped.length} note${result.skipped.length === 1 ? '' : 's'} skipped)`
									: ''),
							6000,
						);
					})();
				}).open();
			},
		});

		// Register settings tab
		this.addSettingTab(new CrosswalkerSettingTab(this.app, this));

		// Shape-first wizard spec §7n: dedicated workspace tab hosting the
		// import experience outside the modal (Kanban/Excalidraw/Bases precedent).
		this.registerView(
			VIEW_TYPE_CROSSWALKER_WORKSPACE,
			(leaf) => new CrosswalkerWorkspaceView(leaf, this),
		);
		// Ribbon tooltips carry no plugin context (unlike palette commands,
		// which Obsidian prefixes with the plugin name), so this one names it.
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Crosswalker is the plugin's proper name
		this.addRibbonIcon('network', 'Open Crosswalker workspace', () => {
			void this.activateWorkspaceView();
		});
		this.addCommand({
			id: 'open-crosswalker-workspace',
			name: 'Start here: open workspace',
			callback: () => {
				void this.activateWorkspaceView();
			},
		});

		// Discoverability entry point 1+2: the file-explorer right-click menu
		// and a file's "more options" (⋯) menu both fire the same workspace
		// 'file-menu' event (Obsidian dispatches it from both surfaces), so one
		// handler covers both without registering a dedicated view type for
		// CSV/XLSX/JSON files.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (!isImportableExtension(file.extension)) return;
				menu.addItem((item) => {
					item
						// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Crosswalker" is the plugin's proper name
						.setTitle('Import into vault with Crosswalker')
						.setIcon('import')
						.onClick(() => {
							// Prefer the workspace view (the primary import surface,
							// spec §7n) with the clicked file already selected;
							// fall back to the modal if the view isn't available.
							void (async () => {
								const leaf = await this.activateWorkspaceView();
								const view = leaf.view;
								if (view instanceof CrosswalkerWorkspaceView) {
									view.startImportWithFile(file);
								} else {
									new ImportWizardModal(this.app, this, { prefillFile: file }).open();
								}
							})();
						});
				});
			}),
		);

		// Discoverability entry point 3: subtle status bar indicator showing
		// how many frameworks are recognized from generated-note identity under
		// the configured output path. Click opens the workspace tab.
		this.ontologyStatusBarEl = this.addStatusBarItem();
		this.ontologyStatusBarEl.addClass('crosswalker-status-bar-item');
		this.ontologyStatusBarEl.addClass('mod-clickable');
		this.ontologyStatusBarEl.setAttr('aria-label', 'Open the Crosswalker workspace');
		this.ontologyStatusBarEl.setText(formatOntologyStatusLabel(0));
		this.ontologyStatusBarEl.addEventListener('click', () => {
			void this.activateWorkspaceView();
		});
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (this.pathAffectsInstalledFrameworks(file.path)) this.scheduleOntologyStatusBarRefresh();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (this.pathAffectsInstalledFrameworks(file.path)) this.scheduleOntologyStatusBarRefresh();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (this.pathAffectsInstalledFrameworks(file.path) || this.pathAffectsInstalledFrameworks(oldPath)) {
				this.scheduleOntologyStatusBarRefresh();
			}
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (this.pathAffectsInstalledFrameworks(file.path)) this.scheduleOntologyStatusBarRefresh();
		}));

		// v0.1.6 Phase 3: register the crosswalkerPivot custom Bases view
		// (per Settled #2 + Ch 30). Public API path; Obsidian 1.10.0+ required.
		// Bases-disabled fallback Notice surfaces if the user has the Bases
		// internal plugin disabled.
		this.registerCrosswalkerPivotView();

		// v0.1.5 Phase 4: auto-trigger Tier 2 projection on vault load.
		// `onLayoutReady` means the workspace is initialized, not that every
		// Markdown file has reached a projector-safe metadata-cache state. The
		// startup path therefore applies its own bounded readiness barrier before
		// opening the reporting database. Projection remains lazy and silent, with
		// every event retained in the diagnostics ring even when file logging is
		// disabled.
		this.app.workspace.onLayoutReady(() => {
			void this.autoProjectOnLayoutReady();
			// v0.1.6 Phase 3: ship reference .base files on first run
			// (idempotent — never overwrites user edits).
			void writeReferenceBaseFiles(this.app, this.debug);
			// v0.1.6 Phase 4.5: regenerate any stale .base files from
			// `crosswalker_query:` frontmatter (idempotent — skips notes whose
			// content already matches). Catches stale state after the user
			// hand-edits frontmatter or the recipe template changes.
			void regenerateAll(this.app, this.debug);
			// Discoverability entry point 3: now that the vault is indexed,
			// derive installed frameworks from generated-note identity.
			this.scheduleOntologyStatusBarRefresh(0);
		});

		// Discoverability entry point 4: first-run / post-update notice. Fires
		// once on a fresh install and once per version change, never twice for
		// the same version. `lastSeenVersion` is persisted in plugin data
		// alongside settings (loadSettings/saveSettings already merge the full
		// data.json blob onto `this.settings`), without adding a field to
		// settings-data.ts.
		this.maybeShowFirstRunNotice();

		this.debug.info('lifecycle', 'loaded', 'Crosswalker plugin loaded', { version: '0.1.6' });
	}

	/** Whether a vault event can change discovery beneath the configured output root. */
	private pathAffectsInstalledFrameworks(path: string): boolean {
		// AM-53. Through the one accessor, which maps the host's `'/'` for an empty
		// root back to `''`. Read raw through `normalizePath` alone, this guard was
		// dead for the supported "Vault root" state: `'/'` is truthy, so the emptiness
		// branch never fired and the test below asked whether the changed path started
		// with `'//'`, which is never true, so no vault event refreshed the count.
		const outputRoot = outputRootPath(this.settings);
		if (!outputRoot) return true;
		const candidate = normalizePath(path);
		return candidate === outputRoot || candidate.startsWith(`${outputRoot}/`);
	}

	/** Coalesce relevant vault event bursts before reading generated-note identity. */
	private scheduleOntologyStatusBarRefresh(delayMs = 250): void {
		if (this.ontologyStatusRefreshTimer !== null) window.clearTimeout(this.ontologyStatusRefreshTimer);
		this.ontologyStatusRefreshTimer = window.setTimeout(() => {
			this.ontologyStatusRefreshTimer = null;
			void this.refreshOntologyStatusBar();
		}, delayMs);
	}

	/**
	 * Repaint the status bar from the same identity-based rule as the workspace.
	 * Flat and hierarchical layouts therefore count identically, while a folder
	 * of ordinary hand-authored notes remains outside Crosswalker's installed set.
	 */
	private async refreshOntologyStatusBar(): Promise<void> {
		if (!this.ontologyStatusBarEl) return;
		const token = ++this.ontologyStatusRefreshToken;
		// AM-53. The same reading the engine writes under. A trailing separator in the
		// setting used to make this lookup answer null and the status bar report 0
		// ontologies over a vault that had just imported one.
		const outputRoot = outputRootFile(this.app, this.settings);
		const node = await toMinimalNode(outputRoot, this.app);
		if (token !== this.ontologyStatusRefreshToken || !this.ontologyStatusBarEl) return;
		this.ontologyStatusBarEl.setText(formatOntologyStatusLabel(deriveInstalledOntologies(node).length));
	}

	/**
	 * Discoverability entry point 4: a one-time, humble Notice (no modal
	 * takeover) pointing new/updated users at the workspace tab. Gate state
	 * (`lastSeenVersion`) is stored in plugin data directly rather than as a
	 * typed settings field — see settings-data.ts ownership boundary.
	 */
	private maybeShowFirstRunNotice(): void {
		const currentVersion = this.manifest.version;
		const settingsWithGate = this.settings as CrosswalkerSettings & { lastSeenVersion?: string };
		const check = checkFirstRun(settingsWithGate.lastSeenVersion ?? null, currentVersion);
		if (!check.shouldShow) return;

		settingsWithGate.lastSeenVersion = currentVersion;
		void this.saveSettings();

		// noticeEl (not the newer messageEl) is used for manifest.json's
		// declared minAppVersion (1.0.0) compatibility — messageEl only
		// exists since Obsidian 1.8.7.
		const notice = new Notice('', 12000);
		notice.noticeEl.createEl('div', { text: 'Crosswalker is ready.' });
		const link = notice.noticeEl.createEl('a', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Crosswalker" is the plugin's proper name
			text: 'Open the Crosswalker workspace to get started',
			href: '#',
		});
		// Inline minimal styling (no styles.css touch — see delivery report):
		// a bare <a> in a Notice inherits no link styling from Obsidian core.
		link.style.textDecoration = 'underline';
		link.style.cursor = 'pointer';
		link.addEventListener('click', (evt) => {
			evt.preventDefault();
			notice.hide();
			void this.activateWorkspaceView();
		});
	}

	/**
	 * Auto-projection on vault load. Per v0.1 schema spec §7 recovery
	 * property + Ch 24 §2: "if .crosswalker.sqlite is missing, corrupted,
	 * or stale, the projector rebuilds it from canonical Tier 1 on next
	 * vault load." This is the entry point that makes that property real.
	 *
	 * Settings-toggleable via `enableTier2Projection` (default true).
	 * Yields control to the UI thread between batches via the projector's
	 * cooperative-yield mechanism so the workspace stays responsive.
	 */
	private async autoProjectOnLayoutReady(): Promise<void> {
		if (!this.settings.enableTier2Projection) {
			this.debug?.info('tier2', 'auto-projection-disabled', 'Tier 2 auto-projection disabled in settings');
			return;
		}
		// Phase 3.5c: thread a trace_id through the auto-projection flow so all
		// downstream tier2 events correlate via `grep trace_id` in the log.
		const traceId = this.debug.newTraceId();
		await this.debug.withTrace(traceId, async () => {
			try {
				this.debug.info('tier2', 'auto-projection-start', 'Tier 2 auto-projection: starting');
				const shouldCancel = () => !this.settings.enableTier2Projection
					|| this.tier2TeardownInProgress
					|| this.tier2Unloaded;
				const readiness = await waitForTier2StartupReadiness(this.app, shouldCancel);
				if (readiness.cancelled || shouldCancel()) {
					this.debug.info('tier2', 'auto-projection-cancelled', 'Tier 2 auto-projection cancelled before database access', {
						readiness,
					});
					return;
				}
				if (readiness.timedOut && readiness.pending > 0) {
					this.debug.warn('tier2', 'auto-projection-readiness-timeout', 'Tier 2 startup readiness deadline reached; running the strict projector', {
						pending: readiness.pending,
						checks: readiness.checks,
						elapsedMs: readiness.elapsedMs,
						timedOut: true,
					});
				}
				const result = await this.runProjection();
				const errorDiagnostics = projectionErrorDiagnostics(result.errors);
				this.debug.info('tier2', 'auto-projection-complete', 'Tier 2 auto-projection: complete', {
					success: result.success,
					// An aborted pass is a success that saw only part of the vault.
					// Recorded so a short run with low counts is not later read as
					// evidence that the vault is nearly empty.
					aborted: result.aborted === true,
					counts: result.counts,
					durationMs: result.durationMs,
					readiness,
					...errorDiagnostics,
				});
				if (!result.aborted && !result.success && result.errors.length > 0) {
					new Notice(
						`Reporting database refresh finished with ${result.errors.length} note errors. `
						+ 'Your notes remain available. Run "Developer tools: copy troubleshooting details to clipboard" '
						+ 'and include the result in a bug report.',
						9000,
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.debug.error('tier2', 'auto-projection-failed', 'Tier 2 auto-projection failed', { error: msg });
				// Non-fatal — Tier 1 vault is still functional. Surface a notice
				// so the user knows queries against Tier 2 may not return fresh
				// results, but don't block the plugin lifecycle.
				new Notice(
					'Crosswalker reporting database did not start. Your notes remain available. Reload Obsidian. '
					+ 'If it fails again, run "Developer tools: copy troubleshooting details to clipboard" '
					+ 'and include the result in a bug report.',
					10000,
				);
			}
		});
	}

	/**
	 * Open the Crosswalker workspace tab, reusing an existing leaf if one is
	 * already open (per the shape-first wizard spec §7n). Returns the leaf so
	 * callers (e.g. the file-menu entry point) can reach the mounted view.
	 */
	private async activateWorkspaceView(): Promise<WorkspaceLeaf> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CROSSWALKER_WORKSPACE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return existing[0];
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_CROSSWALKER_WORKSPACE, active: true });
		workspace.revealLeaf(leaf);
		return leaf;
	}

	onunload() {
		// Cancel startup waiters and ask any active projector to stop at its next
		// cooperative yield before this instance closes its database handle.
		this.tier2Unloaded = true;
		this.tier2TeardownInProgress = true;
		// Deliberately does NOT detachLeavesOfType(VIEW_TYPE_CROSSWALKER_WORKSPACE):
		// the official plugin guidelines say "Don't detach leaves in onunload" —
		// Obsidian reinitializes open leaves in place on plugin update/reload.
		if (this.ontologyStatusRefreshTimer !== null) window.clearTimeout(this.ontologyStatusRefreshTimer);
		this.tier2Handle?.close();
		this.debug?.info('lifecycle', 'unloaded', 'Crosswalker plugin unloaded');
	}

	/**
	 * v0.1.6 Phase 3: register the crosswalkerPivot custom Bases view per
	 * Settled #2 + Ch 30. Uses the Obsidian 1.10.0+ public registerBasesView
	 * API. If Bases is disabled or the API is unavailable, surfaces a Notice
	 * with a hint to enable Bases in Settings → Core plugins.
	 *
	 * Idempotent: re-registering the same viewId is treated as success by
	 * the api wrapper (per the TaskNotes-precedent error-handling pattern).
	 */
	private registerCrosswalkerPivotView(): void {
		const factory = buildCrosswalkerPivotViewFactory(this);
		const options: () => CrosswalkerBasesViewOption[] = () => [
			{
				type: 'property',
				key: 'rowsBy',
				displayName: 'Rows by',
				placeholder: 'e.g. subject_id, control_id, framework',
				filter: (prop) => prop.startsWith('note.') || !prop.includes('.'),
			},
			{
				type: 'property',
				key: 'colsBy',
				displayName: 'Cols by',
				placeholder: 'e.g. object_id, target_framework',
				filter: (prop) => prop.startsWith('note.') || !prop.includes('.'),
			},
			{
				type: 'dropdown',
				key: 'cellOp',
				displayName: 'Cell aggregation',
				options: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'first', 'last'],
				default: 'count',
			},
			{
				type: 'property',
				key: 'cellOf',
				displayName: 'Cell value (for non-count ops)',
				placeholder: 'e.g. confidence, sssom_confidence',
				filter: (prop) => prop.startsWith('note.') || !prop.includes('.'),
			},
			{
				type: 'dropdown',
				key: 'empty',
				displayName: 'Empty cells',
				options: ['gap', 'blank', 'zero'],
				default: 'gap',
			},
			{
				type: 'toggle',
				key: 'heatmap',
				displayName: 'Heatmap shading',
				default: false,
			},
			{
				type: 'dropdown',
				key: 'rowSort',
				displayName: 'Row sort',
				options: ['asc', 'desc', 'none'],
				default: 'asc',
			},
			{
				type: 'dropdown',
				key: 'colSort',
				displayName: 'Col sort',
				options: ['asc', 'desc', 'none'],
				default: 'asc',
			},
		];

		const result = registerCrosswalkerBasesView(this, 'crosswalker-pivot', {
			name: 'Crosswalker pivot',
			icon: 'table',
			factory,
			options,
		});

		if (!result.success) {
			this.debug?.warn('view', 'register-pivot-failed', 'crosswalkerPivot Bases view registration failed', { reason: result.reason });
			if (result.reason === 'no-public-api') {
				new Notice(
					'Crosswalker: pivot view requires Obsidian 1.10.0 or later. Update Obsidian to use the pivot view; other features still work.',
					12000,
				);
			} else if (result.reason === 'bases-disabled') {
				const enabled = isBasesPluginAvailable(this.app);
				new Notice(
					enabled
						? 'Crosswalker: Bases view registration returned false. Try restarting Obsidian. The plugin still works without it.'
						: 'Crosswalker: enable the Bases core plugin (Settings → Core plugins → Bases) to use the pivot view. Other features still work.',
					12000,
				);
			} else if (result.reason === 'error') {
				new Notice(`Crosswalker: pivot view registration error: ${result.error?.message ?? 'unknown'}`);
			}
		}
		// Bind the factory to the Component lifecycle so onunload cleans it up
		// (the factory itself just constructs Component instances; Bases owns
		// their lifecycle. Crosswalker's onunload doesn't need to unregister
		// the view — Obsidian unloads the plugin and tears down everything.)
		void factory;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
