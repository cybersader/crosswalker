import {
	AbstractInputSuggest,
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TFolder,
	setIcon,
} from 'obsidian';
import type { DebugLevel } from '../utils/debug';
import { exportConfigToString, importConfig } from '../config/config-manager';
import { ConfigBrowserModal } from '../config/config-browser-modal';
import { ImportWizardModal } from '../import/import-wizard';
import { renderPresetGuide } from '../import/import-preset-guide';
import { VaultSourceScanModal } from '../import/vault-source-scan-modal';
import { StackSetupModal } from '../import/stack/stack-modal';
import { SavedConfig } from '../types/config';
import CrosswalkerPlugin from '../main';
import {
	outputPathTree,
	keyNamingSample,
	arrayHandlingSample,
	emptyHandlingSample,
	frontmatterStyleSample,
	linkSyntaxSample,
	debugLogPathDisplay,
	sidecarPathDisplay,
	draftPathDisplay,
	type PreviewTreeNode,
} from './setting-previews';
import {
	outputRootPath,
	DEFAULT_EVIDENCE_JUNCTION_FOLDER,
	DEFAULT_EVIDENCE_REPORT_FOLDER,
	DEFAULT_TIER2_SIDECAR_PATH,
	tier2SidecarPath,
} from './folder-settings';
import type { Enrichment } from '../import/mapping/types';
import {
	buildParentPlacementPreview,
	preferredParentNote,
	detectWaypointPlugin,
	type PathTreeNode,
} from '../import/mapping/view-model';

// Human labels for card summaries (a glimpse of each section's current values).
const KEY_STYLE_LABEL: Record<string, string> = {
	'as-is': 'As is',
	lowercase: 'Lowercase',
	snake_case: 'Snake case',
	camelCase: 'Camel case',
	'kebab-case': 'Kebab case',
};
const FM_STYLE_LABEL: Record<string, string> = {
	flat: 'flat',
	dot_to_nest: 'nested',
	group_by_prefix: 'grouped',
};
const ARRAY_LABEL: Record<string, string> = {
	as_array: 'keep as list',
	stringify: 'keep as text',
	first: 'take first',
	last: 'take last',
	join: 'join values',
};
const EMPTY_LABEL: Record<string, string> = {
	omit: 'drop empty',
	empty_string: 'empty string',
	null: 'null',
	default: 'default value',
};
const LINK_LABEL: Record<string, string> = {
	simple: 'Simple',
	standard: 'Standard',
	full: 'Full',
	custom: 'Custom',
};
const LOG_LEVEL_LABEL: Record<DebugLevel, string> = {
	error: 'Errors only',
	warn: 'Warnings and errors',
	info: 'Standard',
	trace: 'Verbose',
};

/**
 * Canned two-level sample for the vault-default parent-placement preview
 * (settings § Connections). There is no import in progress on this page, so
 * `buildParentPlacementPreview` runs over a fixed stand-in pair (a parent
 * with one child) instead of live sample rows the workbench would use.
 */
const PLACEMENT_PREVIEW_SAMPLE = ['Category/Parent.md', 'Category/Parent/Child.md'];

/**
 * Folder autocomplete for path-taking text fields. Suggests vault folders
 * as the user types (case-insensitive substring match), using Obsidian's
 * standard AbstractInputSuggest popover.
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private onPick: (value: string) => void,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		const folders: TFolder[] = [];
		// getAllLoadedFiles includes the vault root and every folder.
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder && f.path.toLowerCase().includes(q)) {
				folders.push(f);
			}
		}
		folders.sort((a, b) => a.path.localeCompare(b.path));
		return folders.slice(0, 100);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		const row = el.createDiv({ cls: 'crosswalker-suggest-row' });
		const ico = row.createSpan({ cls: 'crosswalker-suggest-ico' });
		setIcon(ico, 'folder');
		row.createSpan({ text: folder.path === '' ? '/ (vault root)' : folder.path });
	}

	selectSuggestion(folder: TFolder): void {
		const value = folder.path;
		this.inputEl.value = value;
		this.inputEl.trigger('input');
		this.onPick(value);
		this.close();
	}
}

/**
 * Crosswalker settings tab.
 *
 * Two jobs (spec 2026-07-05 §7l): a launchpad (open the wizard, manage
 * presets, resume a draft) and a teaching surface. Every setting that
 * controls a vault-visible construct renders a small live preview built from
 * the user's actual values, so the tab shows the Obsidian primitive it
 * affects rather than only describing it.
 *
 * Uses sentence case per Obsidian plugin guidelines.
 */
/** One navigable section: a card on the overview + a page you can open. */
interface SettingSection {
	id: string;
	title: string;
	icon: string;
	/** One-line summary with a glimpse of the section's current values. */
	summary: () => string;
	/** Render the section's settings onto its page. */
	render: (root: HTMLElement) => void;
}

export class CrosswalkerSettingTab extends PluginSettingTab {
	plugin: CrosswalkerPlugin;

	/** Null = overview hub; otherwise the open section id. */
	private activePage: string | null = null;

	constructor(app: App, plugin: CrosswalkerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// Scope the wizard's --cw-* design tokens onto the settings tab so the
		// previews and chrome read as one deliberate surface.
		containerEl.addClass('crosswalker-settings');

		const section = this.sections().find((s) => s.id === this.activePage);
		if (section) {
			this.renderSectionPage(containerEl, section);
		} else {
			this.renderOverview(containerEl);
		}
	}

	/** Navigate to a section page (or back to the hub with null) and re-render. */
	private goTo(page: string | null): void {
		this.activePage = page;
		this.display();
		// Keep the settings scroll near the top when switching pages.
		const sc = this.containerEl.closest('.vertical-tab-content-container') as HTMLElement | null;
		if (sc) sc.scrollTop = 0;
	}

	// =========================================================================
	// Section registry — cards on the hub, pages you open
	// =========================================================================

	private sections(): SettingSection[] {
		const s = this.plugin.settings;
		return [
			{
				id: 'output',
				title: 'Output',
				icon: 'folder',
				// AM-53. The summary states the root the product will actually use, so a
			// setting that reads `Frameworks/` on the card and resolves to
			// `Frameworks` everywhere else cannot look like two different folders.
			summary: () => outputRootPath(s) || 'Vault root',
				render: (root) => this.renderOutput(root),
			},
			{
				id: 'naming',
				title: 'Naming',
				icon: 'type',
				summary: () => `${KEY_STYLE_LABEL[s.defaultKeyNamingStyle]} keys, ${FM_STYLE_LABEL[s.defaultFrontmatterStyle]}`,
				render: (root) => this.renderNaming(root),
			},
			{
				id: 'values',
				title: 'Cell values',
				icon: 'list',
				summary: () => `${ARRAY_LABEL[s.defaultArrayHandling]}, ${EMPTY_LABEL[s.defaultEmptyHandling]}`,
				render: (root) => this.renderValues(root),
			},
			{
				id: 'links',
				title: 'Links between notes',
				icon: 'link',
				summary: () => `${LINK_LABEL[s.linkSyntaxPreset]} links`,
				render: (root) => this.renderLinks(root),
			},
			{
				id: 'connections',
				title: 'Connections',
				icon: 'git-branch',
				summary: () => this.connectionsSummary(),
				render: (root) => this.renderConnections(root),
			},
			{
				id: 'import',
				title: 'Import behavior',
				icon: 'wand-2',
				summary: () =>
					`${s.enableShapeWorkbench ? 'Workbench on' : 'Classic mapping'}, ${s.confirmBeforeGenerate ? 'confirm first' : 'no confirm'}`,
				render: (root) => this.renderImportBehavior(root),
			},
			{
				id: 'suggestions',
				title: 'Suggestions',
				icon: 'sparkles',
				summary: () => `${s.enableConfigSuggestions ? 'On' : 'Off'}, match ${s.configMatchThreshold}%`,
				render: (root) => this.renderSuggestions(root),
			},
			{
				id: 'drafts',
				title: 'Drafts',
				icon: 'history',
				summary: () =>
					s.enableDraftSessions
						? `Auto-save on, ${s.draftExpiryDays === 0 ? 'never expire' : `${s.draftExpiryDays}-day expiry`}`
						: 'Auto-save off',
				render: (root) => this.renderDrafts(root),
			},
			{
				id: 'advanced',
				title: 'Advanced',
				icon: 'sliders-horizontal',
				summary: () => `${s.enableTier2Projection ? 'Fast index on' : 'Fast index off'}, stream at ${s.streamingThresholdMB} MB`,
				render: (root) => this.renderAdvanced(root),
			},
			{
				id: 'diagnostics',
				title: 'Diagnostics',
				icon: 'stethoscope',
				summary: () =>
					s.enableDebugLog ? `Log on, ${LOG_LEVEL_LABEL[s.debugLogLevel].toLowerCase()}` : 'Log off',
				render: (root) => this.renderDiagnostics(root),
			},
			{
				id: 'configs',
				title: 'Saved configurations',
				icon: 'bookmark',
				summary: () => {
					const n = s.savedConfigs.length;
					return n === 0 ? 'None saved yet' : `${n} saved`;
				},
				render: (root) => this.renderSavedConfigs(root),
			},
		];
	}

	// =========================================================================
	// Overview hub — launchpad + section cards
	// =========================================================================

	private renderOverview(root: HTMLElement): void {
		this.renderLaunchpad(root);

		const grid = root.createDiv({ cls: 'crosswalker-settings-cardgrid' });
		for (const section of this.sections()) {
			const card = grid.createEl('button', { cls: 'crosswalker-settings-card' });
			const ico = card.createSpan({ cls: 'crosswalker-settings-card-ico' });
			setIcon(ico, section.icon);
			const body = card.createDiv({ cls: 'crosswalker-settings-card-body' });
			body.createDiv({ cls: 'crosswalker-settings-card-title', text: section.title });
			body.createDiv({ cls: 'crosswalker-settings-card-summary', text: section.summary() });
			const chevron = card.createSpan({ cls: 'crosswalker-settings-card-chevron' });
			setIcon(chevron, 'chevron-right');
			card.addEventListener('click', () => this.goTo(section.id));
		}
	}

	// =========================================================================
	// Section page — back nav + the section's settings and previews
	// =========================================================================

	private renderSectionPage(root: HTMLElement, section: SettingSection): void {
		const nav = root.createDiv({ cls: 'crosswalker-settings-pagenav' });
		const back = nav.createEl('button', { cls: 'crosswalker-settings-back' });
		const ico = back.createSpan({ cls: 'crosswalker-settings-back-ico' });
		setIcon(ico, 'chevron-left');
		back.createSpan({ text: 'All sections' });
		back.addEventListener('click', () => this.goTo(null));

		section.render(root);
	}

	// =========================================================================
	// Launchpad — first-class actions, not Setting rows
	// =========================================================================

	private renderLaunchpad(root: HTMLElement): void {
		const bar = root.createDiv({ cls: 'crosswalker-settings-launchpad' });
		bar.createDiv({
			cls: 'crosswalker-settings-launchpad-eyebrow',
			text: 'Start here',
		});
		const row = bar.createDiv({ cls: 'crosswalker-settings-launchpad-row' });

		this.launchButton(row, 'download', 'Import structured data', true, () => {
			new ImportWizardModal(this.app, this.plugin).open();
		});

		this.launchButton(row, 'layers', 'Set up a framework stack', false, () => {
			new StackSetupModal(this.app).open();
		});

		this.launchButton(row, 'search', 'Find sources in this vault', false, () => {
			new VaultSourceScanModal(this.app, this.plugin).open();
		});

		this.launchButton(row, 'bookmark', 'Manage saved configs', false, () => {
			new ConfigBrowserModal(this.app, this.plugin, 'browse').open();
		});

		if (this.plugin.settings.enableDraftSessions) {
			this.launchButton(row, 'history', 'Resume a draft', false, () => {
				// Drafts are resumed from the wizard's step 1 picker.
				new ImportWizardModal(this.app, this.plugin).open();
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

	// =========================================================================
	// Output
	// =========================================================================

	private renderOutput(root: HTMLElement): void {
		new Setting(root).setName('Output').setHeading();

		const setting = new Setting(root)
			.setName('Default output folder')
			.setDesc('Where new imports are created. Each import can override this in the wizard.');

		let refresh = () => {};
		setting.addText((text) => {
			text
				.setPlaceholder('Frameworks')
				.setValue(this.plugin.settings.defaultOutputPath)
				.onChange(async (value) => {
					this.plugin.settings.defaultOutputPath = value;
					await this.plugin.saveSettings();
					refresh();
				});
			new FolderSuggest(this.app, text.inputEl, async (value) => {
				this.plugin.settings.defaultOutputPath = value;
				await this.plugin.saveSettings();
				refresh();
			});
		});

		refresh = this.addPreview(root, 'Where imports land', (el) => {
			// AM-53. The preview shows where imports land, so it must read the root the
			// same way the import does.
			this.renderTree(el, outputPathTree(outputRootPath(this.plugin.settings)));
		});
	}

	// =========================================================================
	// Naming
	// =========================================================================

	private renderNaming(root: HTMLElement): void {
		new Setting(root).setName('Naming').setHeading();

		let refreshKey = () => {};
		new Setting(root)
			.setName('Property key style')
			.setDesc('How column names become frontmatter property keys.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('as-is', 'As is')
					.addOption('lowercase', 'Lowercase')
					.addOption('snake_case', 'Snake case')
					.addOption('camelCase', 'Camel case')
					.addOption('kebab-case', 'Kebab case')
					.setValue(this.plugin.settings.defaultKeyNamingStyle)
					.onChange(async (value) => {
						this.plugin.settings.defaultKeyNamingStyle = value as never;
						await this.plugin.saveSettings();
						refreshKey();
					}),
			);
		refreshKey = this.addPreview(root, 'Sample property', (el) => {
			this.renderCode(el, keyNamingSample(this.plugin.settings.defaultKeyNamingStyle));
		});

		let refreshFm = () => {};
		new Setting(root)
			.setName('Nested properties')
			.setDesc('How dotted column names, like source.id, become frontmatter.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('flat', 'Keep flat')
					.addOption('dot_to_nest', 'Nest by dots')
					.addOption('group_by_prefix', 'Group by prefix')
					.setValue(this.plugin.settings.defaultFrontmatterStyle)
					.onChange(async (value) => {
						this.plugin.settings.defaultFrontmatterStyle = value as never;
						await this.plugin.saveSettings();
						refreshFm();
					}),
			);
		refreshFm = this.addPreview(root, 'Sample frontmatter', (el) => {
			this.renderCode(el, frontmatterStyleSample(this.plugin.settings.defaultFrontmatterStyle));
		});
	}

	// =========================================================================
	// Values — multi-value cells and empty cells
	// =========================================================================

	private renderValues(root: HTMLElement): void {
		new Setting(root).setName('Cell values').setHeading();

		let refreshArr = () => {};
		new Setting(root)
			.setName('Multiple values in one cell')
			.setDesc('How to handle a cell that holds several values, like a comma-separated list.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('as_array', 'Keep as a list')
					.addOption('stringify', 'Keep as text')
					.addOption('first', 'Take the first')
					.addOption('last', 'Take the last')
					.addOption('join', 'Join with a delimiter')
					.setValue(this.plugin.settings.defaultArrayHandling)
					.onChange(async (value) => {
						this.plugin.settings.defaultArrayHandling = value as never;
						await this.plugin.saveSettings();
						refreshArr();
					}),
			);
		refreshArr = this.addPreview(root, 'Sample frontmatter', (el) => {
			this.renderCode(el, arrayHandlingSample(this.plugin.settings.defaultArrayHandling));
		});

		let refreshEmpty = () => {};
		new Setting(root)
			.setName('Empty cells')
			.setDesc('What to write when a cell has no value.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('omit', 'Leave the property out')
					.addOption('empty_string', 'Write an empty string')
					.addOption('null', 'Write null')
					.addOption('default', 'Use a default value')
					.setValue(this.plugin.settings.defaultEmptyHandling)
					.onChange(async (value) => {
						this.plugin.settings.defaultEmptyHandling = value as never;
						await this.plugin.saveSettings();
						refreshEmpty();
					}),
			);
		refreshEmpty = this.addPreview(root, 'Sample frontmatter', (el) => {
			this.renderCode(el, emptyHandlingSample(this.plugin.settings.defaultEmptyHandling));
		});
	}

	// =========================================================================
	// Links
	// =========================================================================

	private renderLinks(root: HTMLElement): void {
		new Setting(root).setName('Links between notes').setHeading();

		let refresh = () => {};
		new Setting(root)
			.setName('Link style')
			.setDesc('How a crosswalk to another concept is written into a note.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('simple', 'Simple')
					.addOption('standard', 'Standard')
					.addOption('full', 'Full, with a predicate')
					.addOption('custom', 'Custom')
					.setValue(this.plugin.settings.linkSyntaxPreset)
					.onChange(async (value) => {
						this.plugin.settings.linkSyntaxPreset = value as never;
						await this.plugin.saveSettings();
						refresh();
					}),
			);

		new Setting(root)
			.setName('Link property prefix')
			.setDesc('Used by the full and custom link styles to name the link property.')
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder('crosswalker')
					.setValue(this.plugin.settings.customLinkNamespace)
					.onChange(async (value) => {
						this.plugin.settings.customLinkNamespace = value;
						await this.plugin.saveSettings();
						refresh();
					}),
			);

		refresh = this.addPreview(root, 'Sample frontmatter', (el) => {
			this.renderCode(
				el,
				linkSyntaxSample(
					this.plugin.settings.linkSyntaxPreset,
					this.plugin.settings.customLinkNamespace,
				),
			);
		});
	}

	// =========================================================================
	// Connections — vault-wide defaults for the enrichment knobs
	//
	// Precedence (highest to lowest, mirrored in `WorkbenchOptions.
	// vaultDefaults` and `CrosswalkerSettings.defaultEnrichment`): a
	// recognized built-in configuration > the user's resumed draft or saved
	// mapping > these vault defaults > the chosen preset's own defaults >
	// adaptive detection (folder-notes-style plugin presence). A setting left
	// untouched here stays unset, so it defers to whatever comes next in the
	// chain — only settings you actually change become vault-wide overrides.
	// =========================================================================

	/** One-line card summary: which vault defaults are actually set. */
	private connectionsSummary(): string {
		const d = this.plugin.settings.defaultEnrichment;
		const parts: string[] = [];
		if (d.children_lists) parts.push('children linked');
		if (d.facet_notes && d.facet_notes !== 'none') parts.push('hub notes');
		if (d.level_hubs === 'notes') parts.push('folder indexes');
		if (d.parent_note) parts.push(d.parent_note === 'folder-note' ? 'folder-note placement' : 'sibling placement');
		return parts.length ? parts.join(', ') : 'Preset defaults';
	}

	private renderConnections(root: HTMLElement): void {
		new Setting(root).setName('Connections').setHeading();
		root.createDiv({
			cls: 'crosswalker-wb-connections-sub',
			text: 'Vault-wide defaults for how generated notes link to each other. Every import can still change these in the wizard\'s Connections card.',
		});
		root.createDiv({
			cls: 'crosswalker-settings-advanced-hint',
			text: 'Order of precedence: a recognized built-in configuration, then your saved mapping or an in-progress draft, then these vault defaults, then the chosen preset\'s own defaults, then automatic detection. Leave a setting untouched to defer to whatever comes next.',
		});

		const defaults = this.plugin.settings.defaultEnrichment;

		new Setting(root)
			.setName('Link parents and children')
			.setDesc('Every parent note lists its direct children, alongside the parent link already on each child.')
			.addToggle((toggle) =>
				toggle
					.setValue(defaults.children_lists === true)
					.onChange(async (value) => {
						this.plugin.settings.defaultEnrichment.children_lists = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Hub notes for shared values')
			.setDesc('When a column becomes a tag, gather every note that shares a value under one hub note.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('none', 'Off')
					.addOption('tags-only', 'Tags only, no hub notes')
					.addOption('notes', 'Hub notes for shared values')
					.setValue(defaults.facet_notes ?? 'none')
					.onChange(async (value) => {
						this.plugin.settings.defaultEnrichment.facet_notes = value as Enrichment['facet_notes'];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Folder index notes')
			.setDesc('Every folder gets an index note listing what is directly inside it, so browsing the vault or the graph never dead-ends.')
			.addToggle((toggle) =>
				toggle
					.setValue(defaults.level_hubs === 'notes')
					.onChange(async (value) => {
						this.plugin.settings.defaultEnrichment.level_hubs = value ? 'notes' : 'none';
						await this.plugin.saveSettings();
					}),
			);

		// Waypoint marker — only offered when a Waypoint-style community plugin
		// is actually enabled (same detection the workbench's Connections card
		// gates on; an unconditional toggle would do nothing for most vaults).
		// @ts-expect-error internal plugins API (enabledPlugins is a Set<string>)
		const enabled: Set<string> = this.app.plugins?.enabledPlugins ?? new Set();
		if (detectWaypointPlugin(enabled)) {
			new Setting(root)
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Waypoint" is the plugin's proper name
				.setName('Also mark folder notes for Waypoint')
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Waypoint" is the plugin's proper name
				.setDesc('Crosswalker already generates its own index notes above. This additionally lets Waypoint track notes you add to a folder by hand, later.')
				.addToggle((toggle) =>
					toggle
						.setValue(defaults.waypoint_marker === true)
						.onChange(async (value) => {
							this.plugin.settings.defaultEnrichment.waypoint_marker = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		this.renderParentPlacementDefault(root, enabled);
	}

	/**
	 * Vault default for where a note that is also a parent should live. Reuses
	 * `buildParentPlacementPreview` (the same helper behind the workbench's
	 * Connections card) over a canned two-level sample, since this page has no
	 * import in progress to preview against.
	 */
	private renderParentPlacementDefault(root: HTMLElement, enabled: Set<string>): void {
		const wrap = root.createDiv({ cls: 'crosswalker-wb-placement' });
		wrap.createDiv({
			cls: 'crosswalker-wb-connection-row-label',
			text: 'Where should a note that is also a parent live?',
		});

		const defaults = this.plugin.settings.defaultEnrichment;
		const current = defaults.parent_note;
		const adaptive = preferredParentNote(enabled);
		const adaptiveLabel = adaptive.value === 'folder-note' ? 'folder note' : 'sibling';
		wrap.createDiv({
			cls: 'crosswalker-wb-placement-reason',
			text: current
				? 'This vault default overrides whatever the preset would otherwise choose.'
				: `Not set. Imports use the preset's own placement (currently ${adaptiveLabel} by default).`,
		});

		const trees = buildParentPlacementPreview(PLACEMENT_PREVIEW_SAMPLE);
		const options: { id: 'sibling' | 'folder-note'; label: string; nodes: PathTreeNode[] }[] = [
			{ id: 'sibling', label: 'Sibling', nodes: trees.sibling },
			{ id: 'folder-note', label: 'Folder note', nodes: trees.folderNote },
		];

		const grid = wrap.createDiv({ cls: 'crosswalker-wb-placement-grid' });
		for (const opt of options) {
			const col = grid.createDiv({ cls: 'crosswalker-wb-placement-col' });
			const radioLabel = col.createEl('label', { cls: 'crosswalker-wb-placement-radio' });
			const radio = radioLabel.createEl('input', { type: 'radio', attr: { name: 'crosswalker-settings-parent-note' } });
			// Neither radio is pre-checked when unset — an honest "no vault
			// default chosen yet" rather than implying a value that isn't saved.
			radio.checked = current === opt.id;
			radioLabel.createSpan({ text: opt.label });
			radio.addEventListener('change', () => {
				if (!radio.checked) return;
				this.plugin.settings.defaultEnrichment.parent_note = opt.id;
				void this.plugin.saveSettings();
				this.display();
			});
			const treeEl = col.createDiv({ cls: 'crosswalker-wb-placement-tree crosswalker-wb-tree' });
			for (const node of opt.nodes) {
				let cls = 'crosswalker-wb-tree-row' + (node.isFile ? ' is-file' : '');
				if (node.relation === 'parent') cls += ' cw-rel-parent';
				const row = treeEl.createDiv({ cls });
				row.style.paddingLeft = `${node.depth * 14}px`;
				const ico = row.createSpan({ cls: 'crosswalker-wb-tree-ico' });
				setIcon(ico, node.isFile ? 'file' : 'folder');
				row.createSpan({ text: node.isFile ? node.label : `${node.label}/` });
			}
		}

		if (current) {
			new Setting(root)
				.setName('Reset placement default')
				.setDesc('Remove the vault default above and defer to the preset again.')
				.addButton((btn) =>
					btn.setButtonText('Use the preset\'s placement instead').onClick(async () => {
						delete this.plugin.settings.defaultEnrichment.parent_note;
						await this.plugin.saveSettings();
						this.display();
					}),
				);
		}
	}

	// =========================================================================
	// Import behavior
	// =========================================================================

	private renderImportBehavior(root: HTMLElement): void {
		new Setting(root).setName('Import behavior').setHeading();

		new Setting(root)
			.setName('Live mapping workbench')
			.setDesc('Replace the column table in step 2 with a live workbench: a source rail, shape cards, a per-level matrix, and a live vault preview. Turn off to keep the classic column mapping.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableShapeWorkbench)
					.onChange(async (value) => {
						this.plugin.settings.enableShapeWorkbench = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Confirm before creating files')
			.setDesc('Show a confirmation step before any notes are written.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmBeforeGenerate)
					.onChange(async (value) => {
						this.plugin.settings.confirmBeforeGenerate = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Show progress notices')
			.setDesc('Pop a notice while parsing and generating.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showProgressNotices)
					.onChange(async (value) => {
						this.plugin.settings.showProgressNotices = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Show column statistics')
			.setDesc('Show unique value counts and detected types in the wizard.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showColumnStatistics)
					.onChange(async (value) => {
						this.plugin.settings.showColumnStatistics = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Show sample values')
			.setDesc('Show a few real cell values alongside each column in the wizard.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSampleValues)
					.onChange(async (value) => {
						this.plugin.settings.showSampleValues = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Sample values shown')
			.setDesc('How many sample values to show per column.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.sampleValueCount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sampleValueCount = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	// =========================================================================
	// Suggestions — saved config matching
	// =========================================================================

	private renderSuggestions(root: HTMLElement): void {
		new Setting(root).setName('Suggestions').setHeading();

		new Setting(root)
			.setName('Suggest a saved config')
			.setDesc('When a new file looks like one you have imported before, offer the matching config.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableConfigSuggestions)
					.onChange(async (value) => {
						this.plugin.settings.enableConfigSuggestions = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Match confidence')
			.setDesc('How closely a file must match a saved config before it is suggested.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.configMatchThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.configMatchThreshold = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Detect data patterns')
			.setDesc('Look at value shapes, like control identifiers, for smarter matching.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enablePatternDetection)
					.onChange(async (value) => {
						this.plugin.settings.enablePatternDetection = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Offer to save a config')
			.setDesc('After a successful import, ask whether to save the mapping for next time.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.promptToSaveConfig)
					.onChange(async (value) => {
						this.plugin.settings.promptToSaveConfig = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Skip the recognized-source card on exact matches')
			.setDesc('When your file exactly matches a built-in configuration, skip straight to the review screen with it applied. Review still happens before anything is created; a close but not exact match always shows the card.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoApplyExactMatch)
					.onChange(async (value) => {
						this.plugin.settings.autoApplyExactMatch = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	// =========================================================================
	// Drafts
	// =========================================================================

	private renderDrafts(root: HTMLElement): void {
		new Setting(root).setName('Drafts').setHeading();

		const setting = new Setting(root)
			.setName('Auto-save import drafts')
			.setDesc('Save wizard progress every few seconds so you can close the modal and resume later.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDraftSessions)
					.onChange(async (value) => {
						this.plugin.settings.enableDraftSessions = value;
						await this.plugin.saveSettings();
						// Refresh so the launchpad "Resume a draft" button follows the toggle.
						this.display();
					}),
			);
		void setting;

		this.addPreview(root, 'Drafts are stored in', (el) => {
			this.renderPathChip(el, 'folder', draftPathDisplay());
		});

		new Setting(root)
			.setName('Draft expiry')
			.setDesc('Drafts older than this many days are removed when the wizard opens. Set to 0 to keep them forever.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 90, 1)
					.setValue(this.plugin.settings.draftExpiryDays)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.draftExpiryDays = value;
						this.plugin.draftStore.setConfig({
							draftExpiryDays: value,
							maxDrafts: this.plugin.settings.maxDrafts,
						});
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName('Maximum drafts')
			.setDesc('When there are more drafts than this, the oldest are removed. Set to 0 for no limit.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 50, 1)
					.setValue(this.plugin.settings.maxDrafts)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxDrafts = value;
						this.plugin.draftStore.setConfig({
							draftExpiryDays: this.plugin.settings.draftExpiryDays,
							maxDrafts: value,
						});
						await this.plugin.saveSettings();
					}),
			);
	}

	// =========================================================================
	// Advanced — rarely-touched knobs, collapsed by default
	// =========================================================================

	private renderAdvanced(root: HTMLElement): void {
		const details = root.createEl('details', { cls: 'crosswalker-settings-advanced' });
		const summary = details.createEl('summary', { cls: 'crosswalker-settings-advanced-summary' });
		const ico = summary.createSpan({ cls: 'crosswalker-settings-advanced-ico' });
		setIcon(ico, 'chevron-right');
		summary.createSpan({ text: 'Advanced' });

		new Setting(details)
			.setName('Streaming threshold')
			.setDesc('Files larger than this many megabytes are parsed with the streaming reader.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 50, 1)
					.setValue(this.plugin.settings.streamingThresholdMB)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.streamingThresholdMB = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(details)
			.setName('Preview row limit')
			.setDesc('How many rows the wizard preview loads. Lower is faster on large files.')
			.addSlider((slider) =>
				slider
					.setLimits(10, 500, 10)
					.setValue(this.plugin.settings.maxRowsForPreview)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxRowsForPreview = value;
						await this.plugin.saveSettings();
					}),
			);

		// --- Fast query index (Tier 2 sidecar) ---
		new Setting(details)
			.setName('Fast query index')
			.setDesc('Keep a background index so large vaults query quickly. The index rebuilds itself from your notes, so it is always safe to delete.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableTier2Projection)
					.onChange(async (value) => {
						this.plugin.settings.enableTier2Projection = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(details)
			.setName('Evidence link folder')
			.setDesc('Where evidence links are stored when created from the link command.')
			.addText((text) => {
				text
					.setPlaceholder('Evidence/junctions')
					.setValue(this.plugin.settings.evidenceJunctionFolder)
					.onChange(async (value) => {
						this.plugin.settings.evidenceJunctionFolder = value || DEFAULT_EVIDENCE_JUNCTION_FOLDER;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl, async (value) => {
					this.plugin.settings.evidenceJunctionFolder = value || DEFAULT_EVIDENCE_JUNCTION_FOLDER;
					await this.plugin.saveSettings();
				});
			});

		new Setting(details)
			.setName('Coverage report folder')
			.setDesc('Where generated evidence coverage reports are written. Each report is rebuilt from scratch every time it runs.')
			.addText((text) => {
				text
					.setPlaceholder('Reports')
					.setValue(this.plugin.settings.evidenceReportFolder)
					.onChange(async (value) => {
						this.plugin.settings.evidenceReportFolder = value || DEFAULT_EVIDENCE_REPORT_FOLDER;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl, async (value) => {
					this.plugin.settings.evidenceReportFolder = value || DEFAULT_EVIDENCE_REPORT_FOLDER;
					await this.plugin.saveSettings();
				});
			});

		let refreshSidecar = () => {};
		new Setting(details)
			.setName('Query index file')
			.setDesc('Where the background index is stored, relative to the vault root.')
			.addText((text) => {
				text
					.setPlaceholder('.crosswalker.sqlite')
					.setValue(this.plugin.settings.tier2SidecarPath)
					.onChange(async (value) => {
						this.plugin.settings.tier2SidecarPath = value || DEFAULT_TIER2_SIDECAR_PATH;
						await this.plugin.saveSettings();
						refreshSidecar();
					});
				new FolderSuggest(this.app, text.inputEl, async (value) => {
					this.plugin.settings.tier2SidecarPath = value || DEFAULT_TIER2_SIDECAR_PATH;
					await this.plugin.saveSettings();
					refreshSidecar();
				});
			});
		refreshSidecar = this.addPreview(details, 'Index file', (el) => {
			// S14 (2026-09-04). Through the accessor, like every other reader of this
			// setting. Reading the field raw showed the text as typed while
			// `openSidecar` and `clearSidecar` act on the normalized value, so the
			// chip could name a file the buttons beside it do not open.
			this.renderPathChip(el, 'database', sidecarPathDisplay(tier2SidecarPath(this.plugin.settings)));
		});
	}

	// =========================================================================
	// Diagnostics — debug log
	// =========================================================================

	private renderDiagnostics(root: HTMLElement): void {
		new Setting(root).setName('Diagnostics').setHeading();

		new Setting(root)
			.setName('Copy diagnostics')
			.setDesc('Copy a redacted bug-report bundle to your clipboard: plugin and Obsidian versions, platform, a settings snapshot, and the last events. Counts and shapes only, never vault paths, file names, or cell values. Works even with the debug log off.')
			.addButton((btn) =>
				btn
					.setButtonText('Copy diagnostics')
					.setCta()
					.onClick(async () => {
						(this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('crosswalker:copy-diagnostics');
					}),
			);

		const setting = new Setting(root)
			.setName('Write a debug log')
			.setDesc('Record structured events to a log note in your vault root. Helpful when reporting an issue. The last events stay in memory for the copy-diagnostics button above regardless of this setting.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLog)
					.onChange(async (value) => {
						this.plugin.settings.enableDebugLog = value;
						this.plugin.debug.setEnabled(value);
						await this.plugin.saveSettings();
						this.display();
					}),
			);
		void setting;

		this.addPreview(root, 'Log note path', (el) => {
			this.renderPathChip(el, 'scroll-text', debugLogPathDisplay());
		});

		new Setting(root)
			.setName('Log level')
			.setDesc('Minimum severity written to the log file. Standard is right for most bug reports; verbose adds a lot of volume, so leave it off unless you are chasing a specific issue. Only affects the file — the copy-diagnostics button above always has the recent events on hand regardless of level.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('error', LOG_LEVEL_LABEL.error)
					.addOption('warn', LOG_LEVEL_LABEL.warn)
					.addOption('info', LOG_LEVEL_LABEL.info)
					.addOption('trace', LOG_LEVEL_LABEL.trace)
					.setValue(this.plugin.settings.debugLogLevel)
					.onChange(async (value) => {
						const level = value as DebugLevel;
						this.plugin.settings.debugLogLevel = level;
						// Kept in sync for back-compat with the older verbose flag; the
						// underlying engine's trace gate still checks verbose directly.
						this.plugin.settings.verboseLogging = level === 'trace';
						this.plugin.debug.setMinLevel(level);
						this.plugin.debug.setVerbose(level === 'trace');
						await this.plugin.saveSettings();
					}),
			);

		// Category filters — suppress events from specific subsystems.
		const catDetails = root.createEl('details', { cls: 'crosswalker-settings-advanced' });
		const catSummary = catDetails.createEl('summary', { cls: 'crosswalker-settings-advanced-summary' });
		const catIco = catSummary.createSpan({ cls: 'crosswalker-settings-advanced-ico' });
		setIcon(catIco, 'chevron-right');
		catSummary.createSpan({ text: 'Log categories' });
		catDetails.createDiv({
			cls: 'crosswalker-settings-advanced-hint',
			text: 'Every category is recorded by default. Turn one off to silence its events.',
		});

		// `id` is the literal category string call sites pass to debug.info/warn/
		// error (must match exactly — it's the storage key + filter match). `label`
		// is what the toggle displays, following the UI lexicon (docs/src/content/
		// docs/agent-context/ui-lexicon.mdx) so this section never shows raw
		// internal identifiers like "sssom-import" or "tier2".
		const KNOWN_CATEGORIES: { id: string; label: string; desc: string }[] = [
			{ id: 'wizard', label: 'Import wizard', desc: 'Import wizard state transitions' },
			{ id: 'csv-parser', label: 'File parsing', desc: 'CSV, XLSX, and JSON parsing' },
			{ id: 'generation', label: 'Note generation', desc: 'Note generation pipeline' },
			{ id: 'sssom-import', label: 'Crosswalk mapping import', desc: 'Crosswalk mapping file import' },
			{ id: 'tier2', label: 'Fast query index', desc: 'Fast query index lifecycle and queries' },
			{ id: 'config', label: 'Saved configurations', desc: 'Saved configuration save, load, and match' },
			{ id: 'view', label: 'Query rendering', desc: 'Query view rendering' },
			{ id: 'drafts', label: 'Drafts', desc: 'Wizard draft save, resume, and expiry' },
			{ id: 'lifecycle', label: 'Plugin startup and shutdown', desc: 'Plugin load and unload' },
		];

		for (const cat of KNOWN_CATEGORIES) {
			new Setting(catDetails)
				.setName(cat.label)
				.setDesc(cat.desc)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.debugLogCategoryFilters[cat.id] !== false)
						.onChange(async (value) => {
							// Store opt-out only (false = suppressed); omit the key when
							// re-enabled to keep settings sparse.
							if (value) {
								delete this.plugin.settings.debugLogCategoryFilters[cat.id];
							} else {
								this.plugin.settings.debugLogCategoryFilters[cat.id] = false;
							}
							this.plugin.debug.setCategoryFilters(this.plugin.settings.debugLogCategoryFilters);
							await this.plugin.saveSettings();
						}),
				);
		}

		const logActions = new Setting(root)
			.setName('Log actions')
			.setDesc('View, export, or clear the debug log file. These are also in the command palette.');
		if (this.plugin.settings.enableDebugLog) {
			logActions.addButton((btn) =>
				btn.setButtonText('View log file').onClick(() => {
					(this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('crosswalker:open-debug-log');
				}),
			);
		}
		logActions
			.addButton((btn) =>
				btn.setButtonText('Export log to clipboard').onClick(() => {
					(this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('crosswalker:export-debug-log');
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Clear')
					.setWarning()
					.onClick(async () => {
						await this.plugin.debug.clear();
					}),
			);
	}

	// =========================================================================
	// Saved configurations
	// =========================================================================

	private renderSavedConfigs(root: HTMLElement): void {
		new Setting(root).setName('Saved configurations').setHeading();

		const configCount = this.plugin.settings.savedConfigs.length;

		new Setting(root)
			.setName('Your saved configs')
			.setDesc(
				configCount === 0
					? 'No saved configurations yet. Save one after your next import.'
					: `${configCount} saved configuration${configCount === 1 ? '' : 's'}.`,
			)
			.addButton((btn) =>
				btn
					.setButtonText('Open browser')
					.setCta()
					.onClick(() => {
						new ConfigBrowserModal(this.app, this.plugin, 'browse').open();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText('Import from file').onClick(() => {
					this.importConfigFromFile();
				}),
			);

		if (configCount > 0) {
			const listContainer = root.createDiv({ cls: 'crosswalker-config-quick-list' });
			listContainer.createEl('p', {
				text: 'Saved: ' + this.plugin.settings.savedConfigs.map((c) => c.name).join(', '),
				cls: 'setting-item-description',
			});
		}
	}

	// =========================================================================
	// Preview rendering helpers (DOM wiring; the builders are pure)
	// =========================================================================

	/**
	 * Create a preview box below a setting. Returns a `refresh` closure that
	 * re-renders only this box, so on-change updates are immediate and local.
	 */
	private addPreview(parent: HTMLElement, label: string, render: (el: HTMLElement) => void): () => void {
		const box = parent.createDiv({ cls: 'crosswalker-setting-preview' });
		box.createDiv({ cls: 'crosswalker-setting-preview-label', text: label });
		const body = box.createDiv({ cls: 'crosswalker-setting-preview-body' });
		render(body);
		return () => {
			body.empty();
			render(body);
		};
	}

	/** Render a mini folder tree, reusing the wizard preview look. */
	private renderTree(parent: HTMLElement, nodes: PreviewTreeNode[]): void {
		const tree = parent.createDiv({ cls: 'crosswalker-wb-tree' });
		for (const node of nodes) {
			const row = tree.createDiv({
				cls: 'crosswalker-wb-tree-row' + (node.isFile ? ' is-file' : ''),
			});
			row.style.paddingLeft = `${node.depth * 14}px`;
			const ico = row.createSpan({ cls: 'crosswalker-wb-tree-ico' });
			setIcon(ico, node.isFile ? 'file' : 'folder');
			row.createSpan({ text: node.isFile ? node.label : `${node.label}/` });
		}
	}

	/** Render a code sample, reusing the wizard `.crosswalker-wb-mini` block. */
	private renderCode(parent: HTMLElement, text: string): void {
		parent.createEl('pre', { cls: 'crosswalker-wb-mini', text });
	}

	/** Render a path as a single mono chip with a leading icon. */
	private renderPathChip(parent: HTMLElement, icon: string, path: string): void {
		const chip = parent.createDiv({ cls: 'crosswalker-wb-chip mono' });
		const ico = chip.createSpan({ cls: 'crosswalker-wb-ico' });
		setIcon(ico, icon);
		chip.createSpan({ text: path });
	}

	/**
	 * Export a config to a downloadable JSON file.
	 */
	private exportConfigToFile(config: SavedConfig): void {
		const jsonStr = exportConfigToString(config);
		const blob = new Blob([jsonStr], { type: 'application/json' });
		const url = URL.createObjectURL(blob);

		const a = document.createElement('a');
		a.href = url;
		a.download = `crosswalker-config-${config.name.toLowerCase().replace(/\s+/g, '-')}.json`;
		a.click();

		URL.revokeObjectURL(url);
	}

	/**
	 * Import a config from a JSON file.
	 */
	private importConfigFromFile(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';

		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) return;

			try {
				const text = await file.text();
				const json = JSON.parse(text);
				const imported = importConfig(json);

				if (imported) {
					this.plugin.settings.savedConfigs.push(imported);
					await this.plugin.saveSettings();
					this.display();
					new Notice(`Imported configuration: ${imported.name}`);
				} else {
					new Notice('Invalid configuration file');
				}
			} catch {
				new Notice('Failed to import configuration');
			}
		};

		input.click();
	}
}
