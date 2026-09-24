/**
 * Config Browser Modal
 *
 * A modal for browsing, viewing, selecting, editing, and managing saved configurations.
 * Can be opened from settings or from the import wizard.
 */
import { plural } from '../utils/plural';

import { App, Modal, Setting, Notice, ButtonComponent } from 'obsidian';
import CrosswalkerPlugin from '../main';
import { SavedConfig } from '../types/config';
import { exportConfigToString, importConfig } from './config-manager';

export type ConfigBrowserMode = 'browse' | 'select';

export interface ConfigBrowserResult {
	action: 'select' | 'cancel';
	config?: SavedConfig;
}

/**
 * Config Browser Modal
 *
 * Modes:
 * - 'browse': Just view/manage configs (from settings)
 * - 'select': Pick a config to use (from import wizard)
 */
export class ConfigBrowserModal extends Modal {
	plugin: CrosswalkerPlugin;
	mode: ConfigBrowserMode;
	selectedConfig: SavedConfig | null = null;
	onSelect?: (result: ConfigBrowserResult) => void;

	// UI state
	searchQuery: string = '';
	sortBy: 'name' | 'date' | 'columns' = 'date';
	expandedConfigId: string | null = null;

	constructor(
		app: App,
		plugin: CrosswalkerPlugin,
		mode: ConfigBrowserMode = 'browse',
		onSelect?: (result: ConfigBrowserResult) => void
	) {
		super(app);
		this.plugin = plugin;
		this.mode = mode;
		this.onSelect = onSelect;
	}

	onOpen() {
		this.render();
	}

	onClose() {
		if (this.mode === 'select' && this.onSelect) {
			this.onSelect({ action: 'cancel' });
		}
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('crosswalker-config-browser');
		this.modalEl.addClass('crosswalker-config-browser-modal');

		// Header
		const header = contentEl.createEl('div', { cls: 'crosswalker-browser-header' });
		header.createEl('h2', {
			text: this.mode === 'select' ? 'Select a configuration' : 'Saved configurations'
		});

		if (this.mode === 'select') {
			header.createEl('p', {
				text: 'Choose a saved configuration to apply to your import.',
				cls: 'setting-item-description'
			});
		}

		// Toolbar: Search + Sort + Import
		this.renderToolbar(contentEl);

		// Config list
		const listContainer = contentEl.createEl('div', { cls: 'crosswalker-config-list' });
		this.renderConfigList(listContainer);

		// Footer (for select mode)
		if (this.mode === 'select') {
			this.renderSelectFooter(contentEl);
		}
	}

	renderToolbar(container: HTMLElement) {
		const toolbar = container.createEl('div', { cls: 'crosswalker-browser-toolbar' });

		// Search
		const searchContainer = toolbar.createEl('div', { cls: 'crosswalker-search-container' });
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: 'Search configurations...',
			cls: 'crosswalker-search-input'
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener('input', (e) => {
			this.searchQuery = (e.target as HTMLInputElement).value;
			this.render();
		});

		// Sort dropdown
		const sortContainer = toolbar.createEl('div', { cls: 'crosswalker-sort-container' });
		sortContainer.createEl('span', { text: 'Sort by:', cls: 'crosswalker-sort-label' });
		const sortSelect = sortContainer.createEl('select', { cls: 'dropdown' });
		sortSelect.createEl('option', { text: 'Date', attr: { value: 'date' } });
		sortSelect.createEl('option', { text: 'Name', attr: { value: 'name' } });
		sortSelect.createEl('option', { text: 'Columns', attr: { value: 'columns' } });
		sortSelect.value = this.sortBy;
		sortSelect.addEventListener('change', (e) => {
			this.sortBy = (e.target as HTMLSelectElement).value as any;
			this.render();
		});

		// Import button
		const importBtn = toolbar.createEl('button', { text: 'Import', cls: 'mod-cta' });
		importBtn.addEventListener('click', () => this.importConfigFromFile());
	}

	renderConfigList(container: HTMLElement) {
		const configs = this.getFilteredAndSortedConfigs();

		if (configs.length === 0) {
			const empty = container.createEl('div', { cls: 'crosswalker-empty-state' });
			if (this.searchQuery) {
				empty.createEl('p', { text: 'No configurations match your search.' });
			} else {
				empty.createEl('p', { text: 'No saved configurations yet.' });
				empty.createEl('p', {
					text: 'Configurations can be saved after a successful import, or imported from JSON files.',
					cls: 'setting-item-description'
				});
			}
			return;
		}

		for (const config of configs) {
			this.renderConfigCard(container, config);
		}
	}

	renderConfigCard(container: HTMLElement, config: SavedConfig) {
		const isExpanded = this.expandedConfigId === config.id;
		const isSelected = this.selectedConfig?.id === config.id;

		const card = container.createEl('div', {
			cls: `crosswalker-config-card ${isExpanded ? 'expanded' : ''} ${isSelected ? 'selected' : ''}`
		});

		// Card header (always visible)
		const cardHeader = card.createEl('div', { cls: 'crosswalker-card-header' });

		// Selection indicator (for select mode)
		if (this.mode === 'select') {
			const radio = cardHeader.createEl('input', {
				type: 'radio',
				attr: { name: 'config-select' }
			});
			radio.checked = isSelected;
			radio.addEventListener('change', () => {
				this.selectedConfig = config;
				this.render();
			});
		}

		// Title and meta
		const titleArea = cardHeader.createEl('div', { cls: 'crosswalker-card-title-area' });
		titleArea.createEl('h3', { text: config.name, cls: 'crosswalker-card-title' });

		const meta = titleArea.createEl('div', { cls: 'crosswalker-card-meta' });
		meta.createEl('span', {
			text: plural(config.fingerprint.columnCount, 'column'),
			cls: 'crosswalker-meta-item'
		});
		meta.createEl('span', { text: '·', cls: 'crosswalker-meta-sep' });
		meta.createEl('span', {
			text: config.fingerprint.sourceType?.toUpperCase() || 'Unknown',
			cls: 'crosswalker-meta-item'
		});
		meta.createEl('span', { text: '·', cls: 'crosswalker-meta-sep' });
		meta.createEl('span', {
			text: this.formatDate(config.updatedAt),
			cls: 'crosswalker-meta-item'
		});

		// Expand/collapse button
		const expandBtn = cardHeader.createEl('button', {
			text: isExpanded ? '▲' : '▼',
			cls: 'crosswalker-expand-btn'
		});
		expandBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.expandedConfigId = isExpanded ? null : config.id;
			this.render();
		});

		// Make header clickable for selection
		if (this.mode === 'select') {
			cardHeader.addEventListener('click', () => {
				this.selectedConfig = config;
				this.render();
			});
			cardHeader.addClass('clickable');
		}

		// Card body (expanded details)
		if (isExpanded) {
			this.renderConfigDetails(card, config);
		}
	}

	renderConfigDetails(card: HTMLElement, config: SavedConfig) {
		const details = card.createEl('div', { cls: 'crosswalker-card-details' });

		// Description (user-provided)
		if (config.description) {
			details.createEl('p', {
				text: config.description,
				cls: 'crosswalker-config-description'
			});
		}

		// Two-column layout for fingerprint vs config
		const twoCol = details.createEl('div', { cls: 'crosswalker-details-two-col' });

		// LEFT: Fingerprint (auto-detected, used for matching)
		const fingerprintCol = twoCol.createEl('div', { cls: 'crosswalker-detail-col' });
		fingerprintCol.createEl('div', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: '🔍 Fingerprint (for matching)',
			cls: 'crosswalker-col-header fingerprint'
		});

		// Column names
		const columnsSection = fingerprintCol.createEl('div', { cls: 'crosswalker-detail-section' });
		columnsSection.createEl('h4', { text: 'Expected columns' });
		const columnList = columnsSection.createEl('div', { cls: 'crosswalker-column-chips' });
		for (const col of config.fingerprint.columnNames) {
			columnList.createEl('span', { text: col, cls: 'crosswalker-chip' });
		}

		// Data patterns (if any)
		if (config.fingerprint.samplePatterns && config.fingerprint.samplePatterns.length > 0) {
			const patternsSection = fingerprintCol.createEl('div', { cls: 'crosswalker-detail-section' });
			patternsSection.createEl('h4', { text: 'Detected patterns' });
			const patternList = patternsSection.createEl('ul', { cls: 'crosswalker-pattern-list' });
			for (const pattern of config.fingerprint.samplePatterns) {
				patternList.createEl('li', {
					text: `${pattern.column}: ${pattern.examples.slice(0, 3).join(', ')}`
				});
			}
		}

		// Source type
		if (config.fingerprint.sourceType) {
			const typeSection = fingerprintCol.createEl('div', { cls: 'crosswalker-detail-section' });
			typeSection.createEl('h4', { text: 'Source type' });
			typeSection.createEl('span', {
				text: config.fingerprint.sourceType.toUpperCase(),
				cls: 'crosswalker-chip'
			});
		}

		// RIGHT: User Configuration (what gets applied)
		const configCol = twoCol.createEl('div', { cls: 'crosswalker-detail-col' });
		configCol.createEl('div', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: '⚙️ Configuration (applied on use)',
			cls: 'crosswalker-col-header config'
		});

		// Mapping summary
		if (config.config?.mapping) {
			const mappingSection = configCol.createEl('div', { cls: 'crosswalker-detail-section' });
			mappingSection.createEl('h4', { text: 'Column mappings' });

			const mapping = config.config.mapping;
			const summaryList = mappingSection.createEl('ul', { cls: 'crosswalker-mapping-summary' });

			if (mapping.hierarchy && mapping.hierarchy.length > 0) {
				summaryList.createEl('li', {
					text: `Hierarchy: ${mapping.hierarchy.map(h => h.column).join(' → ')}`
				});
			}
			if (mapping.frontmatter && mapping.frontmatter.length > 0) {
				const fmItems = mapping.frontmatter.map(f => `${f.column} → ${f.key}`);
				summaryList.createEl('li', {
					text: `Frontmatter: ${fmItems.join(', ')}`
				});
			}
			if (mapping.links && mapping.links.length > 0) {
				summaryList.createEl('li', {
					text: `Links: ${mapping.links.map(l => l.column).join(', ')}`
				});
			}
			if (mapping.body && mapping.body.length > 0) {
				summaryList.createEl('li', {
					text: `Body: ${mapping.body.map(b => b.column).join(', ')}`
				});
			}
			if (mapping.filename?.template) {
				summaryList.createEl('li', {
					text: `Filename: ${mapping.filename.template}`
				});
			}
		} else {
			configCol.createEl('p', {
				text: 'No mapping configuration stored',
				cls: 'setting-item-description'
			});
		}

		// Output path
		if (config.config?.output?.basePath) {
			const outputSection = configCol.createEl('div', { cls: 'crosswalker-detail-section' });
			outputSection.createEl('h4', { text: 'Output path' });
			outputSection.createEl('code', { text: config.config.output.basePath });
		}

		// Timestamps (below both columns)
		const timestampSection = details.createEl('div', { cls: 'crosswalker-detail-section crosswalker-timestamps' });
		timestampSection.createEl('span', {
			text: `Created: ${this.formatDate(config.createdAt)}`,
			cls: 'setting-item-description'
		});
		timestampSection.createEl('span', { text: ' · ' });
		timestampSection.createEl('span', {
			text: `Updated: ${this.formatDate(config.updatedAt)}`,
			cls: 'setting-item-description'
		});
		if (config.lastUsedAt) {
			timestampSection.createEl('span', { text: ' · ' });
			timestampSection.createEl('span', {
				text: `Last used: ${this.formatDate(config.lastUsedAt)}`,
				cls: 'setting-item-description'
			});
		}

		// Action buttons
		const actions = details.createEl('div', { cls: 'crosswalker-card-actions' });

		new ButtonComponent(actions)
			.setButtonText('Export')
			.onClick(() => this.exportConfigToFile(config));

		new ButtonComponent(actions)
			.setButtonText('Duplicate')
			.onClick(() => this.duplicateConfig(config));

		new ButtonComponent(actions)
			.setButtonText('Delete')
			.setWarning()
			.onClick(() => this.deleteConfig(config));
	}

	renderSelectFooter(container: HTMLElement) {
		const footer = container.createEl('div', { cls: 'crosswalker-browser-footer' });

		const cancelBtn = footer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => {
			if (this.onSelect) {
				this.onSelect({ action: 'cancel' });
			}
			this.close();
		});

		const selectBtn = footer.createEl('button', {
			text: 'Use selected',
			cls: 'mod-cta'
		});
		selectBtn.disabled = !this.selectedConfig;
		selectBtn.addEventListener('click', () => {
			if (this.selectedConfig && this.onSelect) {
				this.onSelect({ action: 'select', config: this.selectedConfig });
				this.close();
			}
		});
	}

	// =========================================================================
	// Helper methods
	// =========================================================================

	getFilteredAndSortedConfigs(): SavedConfig[] {
		let configs = [...this.plugin.settings.savedConfigs];

		// Filter by search query
		if (this.searchQuery) {
			const query = this.searchQuery.toLowerCase();
			configs = configs.filter(c =>
				c.name.toLowerCase().includes(query) ||
				c.description?.toLowerCase().includes(query) ||
				c.fingerprint.columnNames.some(col => col.toLowerCase().includes(query))
			);
		}

		// Sort
		switch (this.sortBy) {
			case 'name':
				configs.sort((a, b) => a.name.localeCompare(b.name));
				break;
			case 'date':
				configs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
				break;
			case 'columns':
				configs.sort((a, b) => b.fingerprint.columnCount - a.fingerprint.columnCount);
				break;
		}

		return configs;
	}

	formatDate(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return 'Today';
		if (diffDays === 1) return 'Yesterday';
		if (diffDays < 7) return `${diffDays} days ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

		return date.toLocaleDateString();
	}

	// =========================================================================
	// Actions
	// =========================================================================

	async deleteConfig(config: SavedConfig) {
		// Simple confirmation via native confirm
		if (!confirm(`Delete configuration "${config.name}"?`)) {
			return;
		}

		this.plugin.settings.savedConfigs =
			this.plugin.settings.savedConfigs.filter(c => c.id !== config.id);
		await this.plugin.saveSettings();

		this.plugin.debug.info('config', 'deleted', `Config ${config.name} deleted`, { configId: config.id, configName: config.name });
		new Notice(`Deleted: ${config.name}`);
		this.render();
	}

	async duplicateConfig(config: SavedConfig) {
		const newConfig: SavedConfig = {
			...JSON.parse(JSON.stringify(config)), // Deep clone
			id: `config_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
			name: `${config.name} (copy)`,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			lastUsedAt: undefined
		};

		this.plugin.settings.savedConfigs.push(newConfig);
		await this.plugin.saveSettings();

		this.plugin.debug.info('config', 'duplicated', `Config duplicated`, { originalId: config.id, newId: newConfig.id });
		new Notice(`Duplicated: ${newConfig.name}`);
		this.render();
	}

	exportConfigToFile(config: SavedConfig) {
		const jsonStr = exportConfigToString(config);
		const blob = new Blob([jsonStr], { type: 'application/json' });
		const url = URL.createObjectURL(blob);

		const a = document.createElement('a');
		a.href = url;
		a.download = `crosswalker-config-${config.name.toLowerCase().replace(/\s+/g, '-')}.json`;
		a.click();

		URL.revokeObjectURL(url);

		this.plugin.debug.info('config', 'exported', `Config ${config.name} exported`, { configId: config.id, configName: config.name });
		new Notice(`Exported: ${config.name}`);
	}

	importConfigFromFile() {
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

					this.plugin.debug.info('config', 'imported', `Config ${imported.name} imported from ${file.name}`, {
						configId: imported.id,
						configName: imported.name,
						fileName: file.name
					});

					new Notice(`Imported: ${imported.name}`);
					this.render();
				} else {
					new Notice('Invalid configuration file format');
				}
			} catch (err) {
				new Notice('Failed to parse configuration file');
				this.plugin.debug.error('config', 'import-failed', 'Config import failed', {
					error: err instanceof Error ? err.message : String(err),
					...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
				});
			}
		};

		input.click();
	}
}
