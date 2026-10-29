/**
 * workspace-view.ts — the Crosswalker workspace tab (spec
 * `.workspace/2026-07-05-shape-first-wizard-spec.md` §7n).
 *
 * A dedicated Obsidian ItemView (leaf/tab) that hosts the import experience
 * outside the settings modal, following the Kanban / Excalidraw / Bases
 * precedent of a first-class workspace tab.
 *
 * Two screens, one view: a home screen (launchpad + installed ontologies)
 * and a flow screen that hosts the full `ImportFlow` — the same wizard
 * logic the modal uses, rendered into a wide in-view pane instead of a
 * dialog. `ImportWizardModal` (settings, command palette) remains a thin
 * back-compat host of the same `ImportFlow`; this view is the primary
 * "actual interface, not mockup" surface (owner direction, 2026-07-11).
 */

import { ItemView, WorkspaceLeaf, TFile, setIcon } from 'obsidian';
import CrosswalkerPlugin from '../main';
import { ImportFlow, type ImportFlowHost, type PrefillBinding } from '../import/import-wizard';
import { ConfigBrowserModal } from '../config/config-browser-modal';
import { renderPresetGuide } from '../import/import-preset-guide';
import { VaultSourceScanModal } from '../import/vault-source-scan-modal';
import { StackSetupModal } from '../import/stack/stack-modal';
import { openImportStack, renderInstalledStacks } from '../import/stack/installed-stacks';
import {
	findRecipeForOntologyIdentity,
} from './workspace-view-helpers';
import { discoverInstalledFrameworks } from '../discovery/installed-frameworks';
import { settleVaultIndex } from '../generation/import-set';
import { colorGraphByFramework } from '../graph/graph-color-command';

export const VIEW_TYPE_CROSSWALKER_WORKSPACE = 'crosswalker-workspace';

export class CrosswalkerWorkspaceView extends ItemView {
	private plugin: CrosswalkerPlugin;
	/** The flow currently mounted in this view, or null when showing the home screen. */
	private activeFlow: ImportFlow | null = null;
	/** Bumped on every `renderHome()` so a stale async installed-list render
	 *  (see `renderInstalledOntologies`) can detect it's been superseded. */
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, plugin: CrosswalkerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CROSSWALKER_WORKSPACE;
	}

	getDisplayText(): string {
		return 'Crosswalker';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		await this.renderHome();
	}

	async onClose(): Promise<void> {
		// Invalidate any still-pending home-screen installed-list render.
		this.renderToken++;
		// The flow owns its own draft-save-on-close; forward so a tab close mid-import
		// doesn't silently drop an in-progress draft (mirrors the modal's onClose).
		this.activeFlow?.onClose();
		this.activeFlow = null;
		this.contentEl.empty();
	}

	// =========================================================================
	// Home screen — launchpad + installed ontologies
	// =========================================================================

	/**
	 * Redraw the home screen so the installed stacks panel shows fresh vault
	 * facts after work that finished outside it (a mapping set conversion
	 * resumed from the startup notice or the command). Leaves an import flow
	 * alone: redrawing would throw the user's in-progress import away.
	 */
	refreshInstalledStacks(): void {
		if (this.activeFlow) return;
		void this.renderHome();
	}

	private async renderHome(): Promise<void> {
		this.activeFlow = null;
		const token = ++this.renderToken;
		const root = this.contentEl;
		root.empty();
		root.removeClass('is-flow-active');
		root.addClass('crosswalker-workspace-view');

		this.renderHeader(root);
		this.renderLaunchpad(root);
		renderInstalledStacks(root, this.app, this.plugin, () => { void this.renderHome(); });
		await this.renderInstalledOntologies(root, token);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'crosswalker-workspace-header' });
		header.createDiv({ cls: 'crosswalker-workspace-title', text: 'Crosswalker' });
		header.createDiv({
			cls: 'crosswalker-workspace-subtitle',
			text: 'Import frameworks, taxonomies, and structured data into this vault.',
		});
	}

	private renderLaunchpad(root: HTMLElement): void {
		const bar = root.createDiv({ cls: 'crosswalker-settings-launchpad' });
		bar.createDiv({ cls: 'crosswalker-settings-launchpad-eyebrow', text: 'Start here' });
		const row = bar.createDiv({ cls: 'crosswalker-settings-launchpad-row' });

		// The flow now runs in this view (spec §7n) — the launchpad's primary
		// action opens the wide in-tab experience, not the modal.
		this.launchButton(row, 'download', 'Import structured data', true, () => {
			this.startFlow();
		});

		this.launchButton(row, 'layers', 'Set up a framework stack', false, () => {
			new StackSetupModal(this.app, this.plugin, undefined, () => { void this.renderHome(); }).open();
		});
		this.launchButton(row, 'file-up', 'Import a stack', false, () =>
			openImportStack(this.app, this.plugin, () => { void this.renderHome(); }));

		this.launchButton(row, 'search', 'Find sources in this vault', false, () => {
			new VaultSourceScanModal(this.app, this.plugin).open();
		});

		this.launchButton(row, 'palette', 'Color the graph by framework', false, () => {
			void colorGraphByFramework(this.app, this.plugin);
		});

		this.launchButton(row, 'bookmark', 'Manage saved configs', false, () => {
			new ConfigBrowserModal(this.app, this.plugin, 'browse').open();
		});

		if (this.plugin.settings.enableDraftSessions) {
			this.launchButton(row, 'history', 'Resume a draft', false, () => {
				// Drafts are resumed from the flow's own step 1 picker — same
				// in-view flow, it just lands on the drafts list first.
				this.startFlow();
			});
		}

		renderPresetGuide(bar);
	}

	private launchButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		cta: boolean,
		onClick: () => void,
	): void {
		const btn = parent.createEl('button', {
			cls: 'crosswalker-launch-btn' + (cta ? ' mod-cta' : ''),
		});
		const ico = btn.createSpan({ cls: 'crosswalker-launch-ico' });
		setIcon(ico, icon);
		btn.createSpan({ text: label });
		btn.addEventListener('click', onClick);
	}

	/**
	 * Discovery may wait for the metadata cache to finish indexing, so this
	 * section can render after the rest of the home screen. `token` guards against a stale render finishing after a newer
	 * `renderHome()`/`startFlow()` has already taken the view over.
	 */
	private async renderInstalledOntologies(root: HTMLElement, token: number): Promise<void> {
		const section = root.createDiv({ cls: 'crosswalker-workspace-installed' });
		section.createDiv({ cls: 'crosswalker-workspace-installed-heading', text: 'Installed frameworks' });

		// Whole-vault discovery by note identity, shared with the status bar and
		// the graph color command. It does not depend on the output folder
		// setting, so frameworks built outside it (command line, demo) still list.
		// Cache lag is not absence: while notes are unindexed, say so and wait.
		let result = discoverInstalledFrameworks(this.app);
		if (result.state === 'indexing') {
			const waiting = section.createDiv({
				cls: 'crosswalker-workspace-empty-text',
				text: 'Obsidian is still indexing your vault. Frameworks will list here when it finishes.',
			});
			await settleVaultIndex(this.app, 30_000);
			if (token !== this.renderToken) return; // superseded by a newer render
			result = discoverInstalledFrameworks(this.app);
			if (result.state === 'indexing') return; // the message stays; reopening the view retries
			waiting.remove();
		}
		if (token !== this.renderToken) return; // superseded by a newer render
		const summaries = result.frameworks;

		if (summaries.length === 0) {
			const empty = section.createDiv({ cls: 'crosswalker-workspace-empty' });
			const ico = empty.createSpan({ cls: 'crosswalker-workspace-empty-ico' });
			setIcon(ico, 'folder-plus');
			empty.createDiv({
				cls: 'crosswalker-workspace-empty-text',
				text: 'Nothing imported yet. Run "Find sources in this vault" to see the framework exports already here, or "Import structured data" to pick a file.',
			});
			return;
		}

		const list = section.createDiv({ cls: 'crosswalker-workspace-ontology-list' });
		for (const summary of summaries) {
			const item = list.createDiv({ cls: 'crosswalker-workspace-ontology-item' });
			const ico = item.createSpan({ cls: 'crosswalker-workspace-ontology-ico' });
			setIcon(ico, 'network');

			const body = item.createDiv({ cls: 'crosswalker-workspace-ontology-body' });
			body.createDiv({ cls: 'crosswalker-workspace-ontology-name', text: summary.name });
			body.createDiv({
				cls: 'crosswalker-workspace-ontology-count',
				text: `${summary.noteCount} note${summary.noteCount === 1 ? '' : 's'} · `
					+ `${summary.linkCount} link${summary.linkCount === 1 ? '' : 's'}`,
			});

			const actions = item.createDiv({ cls: 'crosswalker-workspace-ontology-actions' });
			const match = findRecipeForOntologyIdentity(summary.id, summary.recipeId);
			if (match) {
				const btn = actions.createEl('button', {
					cls: 'crosswalker-workspace-ontology-reimport',
					attr: { title: `Import again using the ${match.label} configuration` },
				});
				const btnIco = btn.createSpan({ cls: 'crosswalker-wb-ico' });
				setIcon(btnIco, 'refresh-cw');
				btn.createSpan({ text: 'Import again' });
				btn.addEventListener('click', () => this.startFlow({ presetRecipeId: match.id }));
			}
		}
	}

	// =========================================================================
	// Flow screen — the full import experience, hosted in the wide pane
	// =========================================================================

	/**
	 * Mount an `ImportFlow` into this view's content area. `presetRecipeId`
	 * (spec §7n item 3, "Import again") seeds the flow to lead with a specific
	 * recognized recipe instead of running fingerprint detection from scratch.
	 * `prefillFile` (the file-explorer context-menu entry point) seeds the flow
	 * with a vault file already selected, skipping straight to Step 2.
	 */
	private startFlow(opts?: { presetRecipeId?: string; prefillFile?: TFile; prefillBinding?: PrefillBinding }): void {
		// Invalidate any still-pending home-screen installed-list render (its
		// `root` is about to be repurposed for the flow below) — see the
		// `renderToken` guard in `renderInstalledOntologies`.
		this.renderToken++;
		const root = this.contentEl;
		root.empty();
		root.addClass('crosswalker-workspace-view', 'is-flow-active');

		const flowRoot = root.createDiv({ cls: 'crosswalker-workspace-flow' });

		const host: ImportFlowHost = {
			containerEl: flowRoot,
			close: () => {
				// The flow reached a terminal "done" action — return to the home
				// screen (not literally close the tab), with fresh counts.
				void this.renderHome();
			},
			// Persistent escape hatch on every step: without it the flow takes
			// over the tab with no way back to the workspace home.
			exitLabel: '← Workspace',
		};

		const flow = new ImportFlow(this.app, this.plugin, host);
		if (opts?.presetRecipeId) flow.presetRecipeId = opts.presetRecipeId;
		if (opts?.prefillFile) flow.pendingPrefill = opts.prefillFile;
		if (opts?.prefillBinding) flow.pendingPrefillBinding = opts.prefillBinding;
		this.activeFlow = flow;
		flow.onOpen();
	}

	/**
	 * Public entry point for the file-explorer context menu ("Import into vault
	 * with Crosswalker") — mounts the flow in this view with the clicked file
	 * already selected. `main.ts` prefers this over the modal whenever the
	 * workspace view leaf is available.
	 */
	startImportWithFile(file: TFile, prefillBinding?: PrefillBinding): void {
		this.startFlow({ prefillFile: file, prefillBinding });
	}
}
