/**
 * recipe-picker-modal.ts — Phase 4b modal UI.
 *
 * Entry point for `Crosswalker: Explore data: create a query in the current note`. Lists shipped + user
 * recipes; selecting one expands inline parameter controls; "Insert" calls
 * back with the final block text. Also offers a "Raw YAML escape" option for
 * power users (desktop-only — hidden on mobile per commitment #3).
 *
 * Architectural commitments respected:
 *   - #5 runtime-agnostic recipe schema: dispatch on `query.shape` STRING
 *     value from validated JSON; unknown shapes render as "Unknown shape"
 *     placeholders. New shapes never need picker code changes.
 *   - #3 mobile parity: picker modal works on mobile; raw-YAML escape is
 *     desktop-only with a "Edit on desktop" hint.
 *   - #2 closed mechanism set: `hierarchy` shape marked "Renderer coming
 *     soon" — still insertable (Bases native fallback to table view).
 *   - #6 Bases-not-Dataview: block emission is ` ```base ` only.
 *
 * Reuses Phase 3 modal CSS (.crosswalker-config-browser-modal et al) for
 * visual consistency with the saved-config browser + draft picker patterns.
 */

import { App, Modal, ButtonComponent } from 'obsidian';
import CrosswalkerPlugin from '../main';
import {
	loadAllRecipes,
	type LoadedRecipe,
	type RecipeLoadError,
} from './recipe-loader';
import {
	renderParameterEditor,
	type ParameterEditorHandle,
} from './recipe-parameter-editor';
import { isMobile } from './mobile-detection';
import type { CrosswalkerQueryFrontmatter } from './query-frontmatter-schema';

export type PickerAction =
	| { action: 'insert'; recipeId: string; recipeName: string; shape: string; params: Record<string, unknown> }
	| { action: 'cancel' };

const SHAPE_BADGES: Record<string, { label: string; cls?: string; reserved?: boolean }> = {
	pivot: { label: 'Pivot' },
	table: { label: 'Table' },
	list: { label: 'List' },
	cards: { label: 'Cards' },
	hierarchy: { label: 'Hierarchy · renderer coming soon', cls: 'crosswalker-renderer-coming-soon', reserved: true },
	graph: { label: 'Graph · renderer coming soon', cls: 'crosswalker-renderer-coming-soon', reserved: true },
	timeline: { label: 'Timeline · renderer coming soon', cls: 'crosswalker-renderer-coming-soon', reserved: true },
};

export class RecipePickerModal extends Modal {
	plugin: CrosswalkerPlugin;
	private onResolve: (result: PickerAction) => void;
	private resolved = false;
	private recipes: LoadedRecipe[] = [];
	private errors: RecipeLoadError[] = [];
	private expandedRecipeId: string | null = null;
	private currentEditor: ParameterEditorHandle | null = null;
	/** Phase 4.5 fix: prior query state for UPDATE-mode UI. When present,
	 *  picker auto-expands the matching recipe + seeds the param editor with
	 *  the user's existing params + shows an 'Updating' badge. */
	private existing: CrosswalkerQueryFrontmatter | null = null;

	constructor(
		app: App,
		plugin: CrosswalkerPlugin,
		onResolve: (result: PickerAction) => void,
		existing: CrosswalkerQueryFrontmatter | null = null,
	) {
		super(app);
		this.plugin = plugin;
		this.onResolve = onResolve;
		this.existing = existing;
		if (existing) {
			this.expandedRecipeId = existing.recipe;
		}
	}

	onOpen(): void {
		this.modalEl.addClass('crosswalker-recipe-picker-modal');
		// Reuse Phase 3 modal CSS classes for consistent width/height
		this.modalEl.addClass('crosswalker-config-browser-modal');
		void this.loadAndRender();
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolved = true;
			this.onResolve({ action: 'cancel' });
		}
	}

	private resolve(result: PickerAction): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onResolve(result);
		this.close();
	}

	private async loadAndRender(): Promise<void> {
		try {
			// `recipeSchemaStyle` setting removed (settings-redesign report, 2026-07-11); style 'A' hardcoded.
			const result = await loadAllRecipes(
				this.app,
				'A',
				this.plugin.debug,
			);
			this.recipes = result.recipes;
			this.errors = result.errors;
		} catch (err) {
			this.plugin.debug.error('view', 'recipe-load-failed', 'Recipe picker failed to load recipes', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('crosswalker-config-browser');

		// Header — title + UPDATE-mode badge when there's an existing query
		const header = contentEl.createEl('div', { cls: 'crosswalker-browser-header' });
		const titleRow = header.createEl('div', { cls: 'crosswalker-picker-title-row' });
		titleRow.createEl('h2', { text: this.existing ? 'Update query' : 'Insert query into note' });
		if (this.existing) {
			const badge = titleRow.createEl('span', { cls: 'crosswalker-update-badge' });
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- leading pencil glyph confuses the linter's first-letter detection; "Updating" is already correctly capitalized
			badge.createEl('span', { text: '✎ Updating existing query', cls: 'crosswalker-update-badge-label' });
			header.createEl('p', {
				text: `Current template: ${this.existing.recipe} · query_id: ${this.existing.query_id}. Adjust params below + click Apply. The same .base file regenerates.`,
				cls: 'setting-item-description',
			});
		} else {
			header.createEl('p', {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Apply" quotes the literal button label
				text: 'Pick a query template; adjust params; click Apply. The plugin writes frontmatter + generates a .base file + inserts a ![[...]] embed at your cursor.',
				cls: 'setting-item-description',
			});
		}

		// Errors (if any recipes failed to load)
		if (this.errors.length > 0) {
			const errBox = contentEl.createEl('div', { cls: 'crosswalker-recipe-load-errors' });
			errBox.createEl('p', {
				text: `${this.errors.length} recipe${this.errors.length === 1 ? '' : 's'} failed to load:`,
				cls: 'crosswalker-warning',
			});
			const list = errBox.createEl('ul');
			for (const e of this.errors.slice(0, 5)) {
				list.createEl('li', {
					text: `${e.originPath}: ${e.error}`,
					cls: 'setting-item-description',
				});
			}
		}

		// Recipe list
		const listContainer = contentEl.createEl('div', { cls: 'crosswalker-config-list crosswalker-recipe-list' });
		if (this.recipes.length === 0) {
			const empty = listContainer.createEl('div', { cls: 'crosswalker-empty-state' });
			empty.createEl('p', { text: 'No query templates available.' });
		} else {
			for (const r of this.recipes) {
				this.renderRecipeCard(listContainer, r);
			}
		}

		// Footer — Raw YAML escape (desktop only) + Cancel
		this.renderFooter(contentEl);
	}

	private renderRecipeCard(container: HTMLElement, recipe: LoadedRecipe): void {
		const expanded = this.expandedRecipeId === recipe.id;
		const card = container.createEl('div', {
			cls: 'crosswalker-config-card crosswalker-recipe-card',
		});

		// Header row — title + shape badge + source pill
		const head = card.createEl('div', { cls: 'crosswalker-card-header' });
		const titleArea = head.createEl('div', { cls: 'crosswalker-card-title-area' });
		titleArea.createEl('h3', { text: recipe.title, cls: 'crosswalker-card-title' });

		const meta = titleArea.createEl('div', { cls: 'crosswalker-card-meta' });
		const badge = SHAPE_BADGES[recipe.shape] ?? { label: `Unknown shape (${recipe.shape})`, cls: 'crosswalker-renderer-coming-soon' };
		const badgeEl = meta.createEl('span', { text: badge.label });
		if (badge.cls) badgeEl.addClass(badge.cls);
		meta.createEl('span', { text: '·', cls: 'crosswalker-meta-sep' });
		meta.createEl('span', { text: recipe.source === 'shipped' ? 'Shipped' : 'User' });
		if (recipe.description) {
			titleArea.createEl('p', {
				text: recipe.description,
				cls: 'setting-item-description crosswalker-recipe-description',
			});
		}

		// Configure / Collapse button
		const actions = head.createEl('div', { cls: 'crosswalker-card-actions' });
		new ButtonComponent(actions)
			.setButtonText(expanded ? 'Collapse' : 'Configure')
			.onClick(() => {
				this.expandedRecipeId = expanded ? null : recipe.id;
				this.currentEditor = null;
				this.render();
			});

		// Expanded view — parameter editor + Apply button. Phase 4.5: when
		// this card matches the existing `crosswalker_query:` frontmatter recipe,
		// seed the parameter editor with the user's existing params (UPDATE
		// mode); otherwise use recipe defaults (CREATE mode).
		if (expanded) {
			const details = card.createEl('div', { cls: 'crosswalker-card-details' });
			const initialValues =
				this.existing && this.existing.recipe === recipe.id ? this.existing.params : undefined;
			this.currentEditor = renderParameterEditor(details, recipe, initialValues);

			const insertRow = details.createEl('div', { cls: 'crosswalker-card-actions crosswalker-insert-row' });
			const isUpdateForThisRecipe = this.existing && this.existing.recipe === recipe.id;
			new ButtonComponent(insertRow)
				.setButtonText(isUpdateForThisRecipe ? 'Update' : 'Apply')
				.setCta()
				.onClick(() => {
					const params = this.currentEditor?.getValues() ?? {};
					this.resolve({
						action: 'insert',
						recipeId: recipe.id,
						recipeName: recipe.title,
						shape: recipe.shape,
						params,
					});
				});
		}
	}

	private renderFooter(container: HTMLElement): void {
		const footer = container.createEl('div', { cls: 'crosswalker-browser-footer' });
		// Phase 4.5: no raw-YAML escape — power-users hand-edit the
		// `.base` file at _crosswalker/views/ directly OR write a JSON
		// recipe to _crosswalker/recipes/ and use the picker. Either path
		// is documented in `_crosswalker/SKILL.md`.
		footer.createEl('span', {
			text: isMobile() ? '' : 'Tip: edit the .base file at _crosswalker/views/ directly for advanced changes.',
			cls: 'setting-item-description',
		});
		const cancelBtn = footer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => {
			this.resolve({ action: 'cancel' });
		});
	}
}
