/**
 * embed-existing-query-modal.ts — Phase 4.7 (redesigned)
 *
 * Obsidian-native list aesthetic. Each query = a single clickable row; click
 * or Enter embeds it at the cursor immediately. Search filter at top.
 *
 * Per the synthesis log §3-command split: embedding is just inserting a
 * reference — no template rendering, no vault scan beyond the cheap
 * frontmatter read.
 */

import { App, Modal, ButtonComponent } from 'obsidian';
import type { QueryEntry } from './query-scanner';
import { scanQueries, formatParamsSummary } from './query-scanner';

export type EmbedPickResult =
	| { action: 'embed'; slug: string; viewFile: string }
	| { action: 'cancel' };

export class EmbedExistingQueryModal extends Modal {
	private resolved = false;
	private entries: QueryEntry[] = [];
	private filterValue = '';
	private listContainer: HTMLElement | null = null;

	constructor(app: App, private onResult: (result: EmbedPickResult) => void) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('crosswalker-embed-modal');
		this.entries = await scanQueries(this.app);
		this.renderUI();
	}

	private renderUI(): void {
		const { contentEl } = this;
		contentEl.empty();

		const header = contentEl.createDiv({ cls: 'crosswalker-browse-header' });
		header.createEl('h2', { text: 'Embed an existing query', cls: 'crosswalker-browse-title' });
		header.createEl('div', {
			text: 'Click a query to insert its embed at your cursor. No scan happens here. Embedding is just a reference.',
			cls: 'crosswalker-browse-count',
		});

		if (this.entries.length === 0) {
			const empty = contentEl.createDiv({ cls: 'crosswalker-browse-empty' });
			empty.createEl('p', { text: 'No queries in this vault.' });
			empty.createEl('p', {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- quotes the literal command palette entry name
				text: 'Run "Crosswalker: Explore data: create a query in the current note" to create one.',
				cls: 'crosswalker-browse-hint',
			});
			this.renderCancelOnly(contentEl);
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

		this.listContainer = contentEl.createDiv({ cls: 'crosswalker-browse-list' });
		this.renderList();

		this.renderCancelOnly(contentEl);

		// Autofocus filter for fast keyboard nav
		setTimeout(() => filterInput.focus(), 50);
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
		row.setAttr('aria-label', `Embed query: ${entry.slug}`);
		row.setAttr('title', `Params: ${formatParamsSummary(entry.params)}`);

		const embed = (): void => {
			this.resolve({ action: 'embed', slug: entry.slug, viewFile: entry.viewFile });
		};
		row.addEventListener('click', embed);
		row.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				embed();
			}
		});

		const content = row.createDiv({ cls: 'crosswalker-browse-row-content' });
		content.createDiv({ text: entry.slug, cls: 'crosswalker-browse-row-title' });

		const metaLine = content.createDiv({ cls: 'crosswalker-browse-row-meta' });
		metaLine.createSpan({ text: entry.recipe, cls: 'crosswalker-browse-meta-recipe' });
		metaLine.createSpan({ text: '·', cls: 'crosswalker-browse-meta-sep' });
		metaLine.createSpan({ text: entry.shape, cls: 'crosswalker-browse-meta-shape' });
		metaLine.createSpan({ text: '·', cls: 'crosswalker-browse-meta-sep' });
		metaLine.createSpan({
			text: formatRelativeTime(entry.generatedAt),
			cls: 'crosswalker-browse-meta-time',
		});
	}

	private renderCancelOnly(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'crosswalker-modal-footer' });
		new ButtonComponent(footer)
			.setButtonText('Cancel')
			.onClick(() => this.resolve({ action: 'cancel' }));
	}

	private resolve(result: EmbedPickResult): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onResult(result);
		this.close();
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolved = true;
			this.onResult({ action: 'cancel' });
		}
	}
}

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
