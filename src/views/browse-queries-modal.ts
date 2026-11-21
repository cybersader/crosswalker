/**
 * browse-queries-modal.ts — Phase 4.7 (redesigned)
 *
 * Obsidian-native list aesthetic: clickable rows (primary action = open
 * canonical index.md), hover-revealed icon buttons on the right edge for
 * secondary actions (embed in active note, delete). Search filter at top.
 * Subtle dividers, relative timestamps, no verbose query_id clutter
 * (revealed via hover tooltip).
 */

import { App, Modal, Notice, TFile, ButtonComponent, setIcon } from 'obsidian';
import type { Editor } from 'obsidian';
import type { QueryEntry } from './query-scanner';
import { scanQueries, formatParamsSummary } from './query-scanner';

export interface BrowseModalContext {
	editor: Editor | null;
	activeFile: TFile | null;
	insertEmbed: (slug: string, viewFile: string) => Promise<void>;
}

export class BrowseQueriesModal extends Modal {
	private entries: QueryEntry[] = [];
	private filterValue = '';
	private listContainer: HTMLElement | null = null;

	constructor(app: App, private context: BrowseModalContext) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('crosswalker-browse-modal');
		this.entries = await scanQueries(this.app);
		this.renderUI();
	}

	private async refresh(): Promise<void> {
		this.entries = await scanQueries(this.app);
		this.renderList();
	}

	private renderUI(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Header — title + count
		const header = contentEl.createDiv({ cls: 'crosswalker-browse-header' });
		header.createEl('h2', { text: 'Browse queries', cls: 'crosswalker-browse-title' });
		const countText =
			this.entries.length === 0
				? 'No saved queries in this vault'
				: `${this.entries.length} quer${this.entries.length === 1 ? 'y' : 'ies'} · stored under _crosswalker/queries/`;
		header.createEl('div', { text: countText, cls: 'crosswalker-browse-count' });

		new ButtonComponent(contentEl).setButtonText('Unmapped framework entries').setTooltip('Run built-in report').onClick(async () => {
			const { UnmappedFrameworkModal } = await import('./unmapped-framework-modal');
			this.close();
			new UnmappedFrameworkModal(this.app).open();
		});

		if (this.entries.length === 0) {
			const empty = contentEl.createDiv({ cls: 'crosswalker-browse-empty' });
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- quotes the literal command palette entry name
			empty.createEl('p', { text: 'Run "Crosswalker: Explore data: create a query in the current note" to create your first query.' });
			this.renderFooter(contentEl);
			return;
		}

		// Filter input
		const filterRow = contentEl.createDiv({ cls: 'crosswalker-browse-filter' });
		const filterInput = filterRow.createEl('input', {
			type: 'text',
			placeholder: 'Filter by name, recipe, or shape...',
			cls: 'crosswalker-browse-filter-input',
		});
		filterInput.addEventListener('input', () => {
			this.filterValue = filterInput.value.trim().toLowerCase();
			this.renderList();
		});

		// List
		this.listContainer = contentEl.createDiv({ cls: 'crosswalker-browse-list' });
		this.renderList();

		this.renderFooter(contentEl);
	}

	private renderList(): void {
		if (!this.listContainer) return;
		this.listContainer.empty();

		const filtered = this.filterValue
			? this.entries.filter(
					(e) =>
						e.slug.toLowerCase().includes(this.filterValue) ||
						e.recipe.toLowerCase().includes(this.filterValue) ||
						e.shape.toLowerCase().includes(this.filterValue),
			  )
			: this.entries;

		if (filtered.length === 0) {
			this.listContainer.createEl('div', {
				text: `No queries match "${this.filterValue}".`,
				cls: 'crosswalker-browse-no-results',
			});
			return;
		}

		for (const entry of filtered) {
			this.renderRow(this.listContainer, entry);
		}
	}

	private renderRow(parent: HTMLElement, entry: QueryEntry): void {
		const row = parent.createDiv({ cls: 'crosswalker-browse-row' });
		row.setAttr('tabindex', '0');
		row.setAttr('role', 'button');
		row.setAttr('aria-label', `Open query: ${entry.slug}`);
		row.setAttr('title', `Query ID: ${entry.queryId}\nParams: ${formatParamsSummary(entry.params)}`);

		// Primary action — click anywhere on row to open canonical
		const openCanonical = async (): Promise<void> => {
			const file = this.app.vault.getAbstractFileByPath(entry.indexFile);
			if (file && 'path' in file) {
				this.close();
				await this.app.workspace.getLeaf(false).openFile(file as TFile);
			} else {
				new Notice(`Could not open ${entry.indexFile}`, 4000);
			}
		};
		row.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('.crosswalker-browse-row-actions')) return;
			void openCanonical();
		});
		row.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void openCanonical();
			}
		});

		// Main content — title + meta line
		const content = row.createDiv({ cls: 'crosswalker-browse-row-content' });
		const titleLine = content.createDiv({ cls: 'crosswalker-browse-row-title' });
		titleLine.setText(entry.slug);

		const metaLine = content.createDiv({ cls: 'crosswalker-browse-row-meta' });
		metaLine.createSpan({ text: entry.recipe, cls: 'crosswalker-browse-meta-recipe' });
		metaLine.createSpan({ text: '·', cls: 'crosswalker-browse-meta-sep' });
		metaLine.createSpan({ text: entry.shape, cls: 'crosswalker-browse-meta-shape' });
		metaLine.createSpan({ text: '·', cls: 'crosswalker-browse-meta-sep' });
		metaLine.createSpan({
			text: formatRelativeTime(entry.generatedAt),
			cls: 'crosswalker-browse-meta-time',
		});

		// Hover-revealed action icons (right-aligned)
		const actions = row.createDiv({ cls: 'crosswalker-browse-row-actions' });

		this.renderIconButton(actions, 'link', 'Embed in active note', async () => {
			if (!this.context.editor || !this.context.activeFile) {
				new Notice('Open a Markdown note to embed into.', 4000);
				return;
			}
			this.close();
			await this.context.insertEmbed(entry.slug, entry.viewFile);
		}, !this.context.editor);

		this.renderIconButton(actions, 'trash-2', 'Delete query folder', async () => {
			const confirmed = await this.confirmDelete(entry);
			if (confirmed) {
				await this.deleteQueryFolder(entry);
				await this.refresh();
			}
		});
	}

	private renderIconButton(
		parent: HTMLElement,
		iconName: string,
		tooltip: string,
		onClick: () => void | Promise<void>,
		disabled = false,
	): void {
		const btn = parent.createEl('button', { cls: 'crosswalker-browse-row-icon-btn' });
		setIcon(btn, iconName);
		btn.setAttr('aria-label', tooltip);
		btn.setAttr('title', tooltip);
		if (disabled) {
			btn.addClass('is-disabled');
			btn.setAttr('disabled', 'true');
		}
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!disabled) void onClick();
		});
	}

	private async confirmDelete(entry: QueryEntry): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.modalEl.addClass('crosswalker-confirm-modal');
			modal.contentEl.createEl('h3', { text: 'Delete query?' });
			modal.contentEl.createEl('p', {
				text: `Permanently deletes the folder _crosswalker/queries/${entry.slug}/ and everything inside it.`,
			});
			modal.contentEl.createEl('p', {
				text: 'Embeds of this query in other notes will become broken links. This action cannot be undone.',
				cls: 'crosswalker-confirm-warning',
			});

			const footer = modal.contentEl.createDiv({ cls: 'crosswalker-modal-footer' });
			new ButtonComponent(footer).setButtonText('Cancel').onClick(() => {
				modal.close();
				resolve(false);
			});
			new ButtonComponent(footer)
				.setButtonText('Delete')
				.setWarning()
				.onClick(() => {
					modal.close();
					resolve(true);
				});
			modal.open();
		});
	}

	private async deleteQueryFolder(entry: QueryEntry): Promise<void> {
		const folderPath = `_crosswalker/queries/${entry.slug}`;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			new Notice(`Folder not found: ${folderPath}`, 4000);
			return;
		}
		try {
			await this.app.vault.delete(folder, true);
			new Notice(`Deleted ${folderPath}`, 4000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Delete failed: ${msg}`, 6000);
		}
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'crosswalker-modal-footer' });
		new ButtonComponent(footer).setButtonText('Close').onClick(() => this.close());
	}
}

/**
 * Format an ISO timestamp as a human-friendly relative string.
 * "3 minutes ago" / "2 hours ago" / "5 days ago" / "May 18".
 */
function formatRelativeTime(isoString: string): string {
	const then = new Date(isoString).getTime();
	if (Number.isNaN(then)) return '';
	const now = Date.now();
	const diff = now - then;
	const sec = Math.floor(diff / 1000);
	const min = Math.floor(sec / 60);
	const hr = Math.floor(min / 60);
	const day = Math.floor(hr / 24);

	if (sec < 30) return 'just now';
	if (min < 1) return `${sec}s ago`;
	if (hr < 1) return `${min}m ago`;
	if (day < 1) return `${hr}h ago`;
	if (day < 7) return `${day}d ago`;
	const d = new Date(isoString);
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
