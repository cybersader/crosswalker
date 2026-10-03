/**
 * recipe-library-modal.ts — UI for the saved import recipe library (slice 1).
 *
 * - `obsidianRecipeLibraryFiles(app)`: the vault adapter behind the pure
 *   library in `recipe-library.ts`. Delete always goes to the trash.
 * - `SaveRecipeModal`: "Save as recipe" from the wizard review step and the
 *   results screen. The saved content is `patchRecipeDocument()` output.
 * - `RecipeLibraryModal`: browse and select. Groups "Your recipes", "Built in",
 *   then "Couldn't read". Search re-renders only the list so focus is kept.
 */

import { App, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import type { RecipeDocument, RecipePatchOptions, RecipePatchResult } from './recipe-document';
import {
	RECIPE_LIBRARY_FOLDER,
	builtInRecipes,
	deleteFromLibrary,
	destinationSteps,
	duplicate,
	exportRecipe,
	importRecipeFile,
	lineageLine,
	listLibrary,
	rename,
	saveLineageLine,
	saveToLibrary,
	sourceFormatLine,
	summarizeRecipeColumns,
	uniqueDisplayName,
	type DestinationStep,
	type LibraryEntry,
	type LibraryListing,
	type RecipeLibraryFiles,
} from './recipe-library';
import { discoverImportSets, settleVaultIndex } from '../generation/import-set';
import {
	CHECKING_VAULT_LINE,
	displayRecipeRuns,
	notesPhrase,
	formatRunDate,
	lastRunLine,
	pruneRecipeRuns,
	type RecipeRunDisplay,
	type RecipeRunRecord,
	type RecipeRunRow,
} from './recipe-runs';

// ============================================================================
// Vault adapter
// ============================================================================

interface TrashCapableAdapter {
	trashSystem?(path: string): Promise<boolean>;
	trashLocal?(path: string): Promise<void>;
}

/** The library's file API over the vault adapter (hidden `_` folders included). */
export function obsidianRecipeLibraryFiles(app: App): RecipeLibraryFiles {
	const adapter = app.vault.adapter;
	return {
		exists: (path) => adapter.exists(path),
		listFiles: async (folder) => (await adapter.list(folder)).files,
		read: (path) => adapter.read(path),
		write: (path, text) => adapter.write(path, text),
		mkdir: (path) => adapter.mkdir(path),
		rename: (from, to) => adapter.rename(from, to),
		mtime: async (path) => (await adapter.stat(path))?.mtime ?? null,
		trash: async (path) => {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await app.fileManager.trashFile(file);
				return;
			}
			const trashable = adapter as unknown as TrashCapableAdapter;
			if (trashable.trashSystem && (await trashable.trashSystem(path))) return;
			if (trashable.trashLocal) {
				await trashable.trashLocal(path);
				return;
			}
			throw new Error('No trash available');
		},
	};
}

// ============================================================================
// Small dialogs
// ============================================================================

/** A yes/no confirmation. Resolves false on close. */
export function confirmAction(
	app: App,
	opts: { title: string; body: string; confirmText: string; warning?: boolean },
): Promise<boolean> {
	return new Promise((resolve) => {
		class ConfirmModal extends Modal {
			private settled = false;
			private finish(value: boolean): void {
				if (this.settled) return;
				this.settled = true;
				resolve(value);
				this.close();
			}
			onOpen(): void {
				this.modalEl.addClass('crosswalker-recipe-confirm-modal');
				new Setting(this.contentEl).setName(opts.title).setHeading();
				this.contentEl.createEl('p', { text: opts.body });
				new Setting(this.contentEl)
					.addButton((b) => b.setButtonText('Cancel').onClick(() => this.finish(false)))
					.addButton((b) => {
						b.setButtonText(opts.confirmText).onClick(() => this.finish(true));
						if (opts.warning) b.setWarning();
						else b.setCta();
					});
			}
			onClose(): void {
				if (!this.settled) {
					this.settled = true;
					resolve(false);
				}
				this.contentEl.empty();
			}
		}
		new ConfirmModal(app).open();
	});
}

/** A one-field text prompt. Resolves null on cancel. */
export function promptText(
	app: App,
	opts: { title: string; label: string; value: string; submitText: string },
): Promise<string | null> {
	return new Promise((resolve) => {
		class PromptModal extends Modal {
			private settled = false;
			private value = opts.value;
			private finish(value: string | null): void {
				if (this.settled) return;
				this.settled = true;
				resolve(value);
				this.close();
			}
			onOpen(): void {
				this.modalEl.addClass('crosswalker-recipe-prompt-modal');
				new Setting(this.contentEl).setName(opts.title).setHeading();
				new Setting(this.contentEl).setName(opts.label).addText((t) => {
					t.setValue(this.value).onChange((v) => { this.value = v; });
					t.inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && this.value.trim()) this.finish(this.value);
					});
					window.setTimeout(() => t.inputEl.select(), 0);
				});
				new Setting(this.contentEl)
					.addButton((b) => b.setButtonText('Cancel').onClick(() => this.finish(null)))
					.addButton((b) => b.setButtonText(opts.submitText).setCta().onClick(() => {
						if (this.value.trim()) this.finish(this.value);
					}));
			}
			onClose(): void {
				if (!this.settled) {
					this.settled = true;
					resolve(null);
				}
				this.contentEl.empty();
			}
		}
		new PromptModal(app).open();
	});
}

function downloadText(fileName: string, text: string): void {
	const blob = new Blob([text], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function failNotice(cause: string, action: string): void {
	new Notice(`${cause} ${action}`, 8000);
}

// ============================================================================
// Save dialog
// ============================================================================

export interface SaveRecipeInput {
	document: RecipeDocument;
	options: RecipePatchOptions;
	result: RecipePatchResult;
}

/**
 * "Save as recipe". Name, optional description, lineage line, then Save. When
 * the setup came from a saved recipe and was changed, also offers Replace.
 */
export class SaveRecipeModal extends Modal {
	private files: RecipeLibraryFiles;
	private input: SaveRecipeInput;
	private name: string;
	private description: string;
	private listing: LibraryListing = { entries: [], problems: [] };
	private busy = false;
	private onSaved?: (saved: { id: string; name: string }) => void;

	constructor(
		app: App,
		input: SaveRecipeInput,
		opts: { defaultName: string; onSaved?: (saved: { id: string; name: string }) => void },
	) {
		super(app);
		this.files = obsidianRecipeLibraryFiles(app);
		this.input = input;
		this.name = opts.defaultName;
		this.description = input.document.origin === 'user'
			? input.document.original.metadata?.description ?? ''
			: '';
		this.onSaved = opts.onSaved;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('crosswalker-save-recipe-modal');
		this.listing = await listLibrary(this.files);
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private replaceTarget(): LibraryEntry | null {
		if (this.input.document.origin !== 'user' || !this.input.result.dirty) return null;
		return this.listing.entries.find((e) => e.id === this.input.document.original.recipe) ?? null;
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		new Setting(el).setName('Save as recipe').setHeading();

		const onEnter = (e: KeyboardEvent) => {
			if (e.key !== 'Enter' || e.isComposing) return;
			e.preventDefault();
			if (saveBtn && !saveBtn.disabled) void this.doSave();
		};
		let collisionEl: HTMLElement | null = null;
		const nameSetting = new Setting(el).setName('Name').addText((t) => {
			t.setValue(this.name).onChange((v) => {
				this.name = v;
				saveBtn?.toggleAttribute('disabled', blocked || !v.trim());
				this.renderCollision(collisionEl);
			});
			t.inputEl.addClass('crosswalker-save-recipe-name');
			t.inputEl.addEventListener('keydown', onEnter);
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		nameSetting.settingEl.addClass('crosswalker-save-recipe-field');
		collisionEl = el.createEl('p', { cls: 'setting-item-description crosswalker-save-recipe-collision' });
		this.renderCollision(collisionEl);
		new Setting(el)
			.setName('Description')
			.setDesc('Optional. One line about when to use it.')
			.addText((t) => {
				t.setValue(this.description).onChange((v) => { this.description = v; });
				t.inputEl.addClass('crosswalker-save-recipe-desc');
				t.inputEl.addEventListener('keydown', onEnter);
			})
			.settingEl.addClass('crosswalker-save-recipe-field', 'crosswalker-save-recipe-desc-setting');

		const lineage = saveLineageLine(this.input.document, this.listing.entries);
		if (lineage) el.createEl('p', { cls: 'crosswalker-save-recipe-lineage', text: lineage });
		el.createEl('p', {
			cls: 'setting-item-description crosswalker-save-recipe-note',
			text: 'Saves how columns become folders, notes, properties and links. Your source file is not saved.',
		});

		const blocking = this.input.result.diagnostics.filter((d) => d.severity === 'blocking');
		const blocked = !this.input.result.ok || blocking.length > 0;
		if (blocked) {
			const box = el.createDiv({ cls: 'crosswalker-save-recipe-blocked' });
			box.createEl('p', { text: blocking[0]?.message ?? 'Part of this setup is incomplete, so it cannot be saved yet.' });
			box.createEl('p', {
				cls: 'setting-item-description',
				text: 'Fix it in the review step, then save again.',
			});
		}

		let saveBtn: HTMLButtonElement | null = null;
		const actions = el.createDiv({ cls: 'crosswalker-save-recipe-actions' });
		actions.createEl('button', { text: 'Cancel', cls: 'crosswalker-save-recipe-cancel' })
			.addEventListener('click', () => this.close());
		const target = this.replaceTarget();
		if (target) {
			const replaceBtn = actions.createEl('button', { text: `Replace "${target.name}"` });
			replaceBtn.disabled = blocked;
			replaceBtn.addEventListener('click', () => { void this.doReplace(target); });
		}
		saveBtn = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
		saveBtn.disabled = blocked || !this.name.trim();
		saveBtn.addEventListener('click', () => { void this.doSave(); });
	}

	/** The name a new save would get, when the typed one is already in use. */
	private renderCollision(line: HTMLElement | null): void {
		if (!line) return;
		const typed = this.name.trim();
		const final = typed ? uniqueDisplayName(typed, this.listing.entries) : typed;
		if (!typed || final === typed) {
			line.empty();
			line.hide();
			return;
		}
		const existing = this.listing.entries.find((e) => e.name.trim().toLowerCase() === typed.toLowerCase())?.name ?? typed;
		line.setText(`You already have a recipe named "${existing}". This one will be saved as "${final}".`);
		line.show();
	}

	private async doSave(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const result = await saveToLibrary(this.files, this.input.document, {
			name: this.name,
			description: this.description,
			mode: 'new',
			patch: this.input.options,
		});
		this.busy = false;
		if (!result.ok) {
			failNotice(result.cause, result.action);
			return;
		}
		new Notice(`Saved recipe "${result.name}".`);
		this.onSaved?.({ id: result.id, name: result.name });
		this.close();
	}

	private async doReplace(target: LibraryEntry): Promise<void> {
		if (this.busy) return;
		const ok = await confirmAction(this.app, {
			title: 'Replace recipe',
			body: `Replace your recipe "${target.name}"? The old version goes to the trash.`,
			confirmText: 'Replace',
			warning: true,
		});
		if (!ok) return;
		this.busy = true;
		const result = await saveToLibrary(this.files, this.input.document, {
			name: this.name,
			description: this.description,
			mode: 'replace',
			patch: this.input.options,
		});
		this.busy = false;
		if (!result.ok) {
			failNotice(result.cause, result.action);
			return;
		}
		new Notice(`Saved recipe "${result.name}".`);
		this.onSaved?.({ id: result.id, name: result.name });
		this.close();
	}
}

// ============================================================================
// Browser
// ============================================================================

type BrowserMode = 'browse' | 'select';

/** Run records the library reads, and how it writes back a pruned list. */
export interface RecipeRunsSource {
	get: () => RecipeRunRecord[];
	save: (runs: RecipeRunRecord[]) => Promise<void>;
}

/** Expanded card: rows shown before "and N more". */
const RUN_ROWS_SHOWN = 5;

/** The set a Run again click refreshes, as the wizard names it before any vault scan. */
export interface RunAgainSet {
	name: string;
	noteCount?: number;
}

/** Run again's accessible name: what it does to which set. */
function refreshLabel(setName: string): string {
	return `Refresh ${setName} with a new copy of the source file`;
}
type SortKey = 'name' | 'newest';

interface CardItem {
	id: string;
	name: string;
	description: string;
	recipe: CrosswalkerImportRecipe;
	savedAt: number | null;
	user: boolean;
}

/**
 * Browse saved and built-in import recipes. In `select` mode the primary
 * action is "Use this recipe" and nothing destructive is shown.
 */
export class RecipeLibraryModal extends Modal {
	private files: RecipeLibraryFiles;
	private mode: BrowserMode;
	private onUse: (id: string) => void;
	private listing: LibraryListing = { entries: [], problems: [] };
	private search = '';
	private sort: SortKey = 'name';
	private expanded: string | null = null;
	private listEl: HTMLElement | null = null;
	private resolved = false;
	private outputRoot: string | null;
	private runSource: RecipeRunsSource | null;
	private onRunAgain: ((run: RecipeRunRecord, recipeName: string, set: RunAgainSet) => void) | null;
	/** Per recipe id. Absent while not yet resolved for a recipe that has records. */
	private runDisplay = new Map<string, RecipeRunDisplay>();
	private closed = false;

	constructor(app: App, opts: {
		mode: BrowserMode;
		onUse: (id: string) => void;
		outputRoot?: string;
		/** Run again (slice 2). Browse mode only. */
		runs?: RecipeRunsSource;
		onRunAgain?: (run: RecipeRunRecord, recipeName: string, set: RunAgainSet) => void;
	}) {
		super(app);
		this.files = obsidianRecipeLibraryFiles(app);
		this.mode = opts.mode;
		this.onUse = opts.onUse;
		this.outputRoot = opts.outputRoot?.trim() ? opts.outputRoot.trim() : null;
		this.runSource = opts.mode === 'browse' ? opts.runs ?? null : null;
		this.onRunAgain = opts.onRunAgain ?? null;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('crosswalker-config-browser-modal');
		this.modalEl.addClass('crosswalker-recipe-library-modal');
		this.closed = false;
		await this.reload();
		this.renderShell();
		void this.resolveRuns();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	/**
	 * R3. Which run records may be shown: only those whose set a settled vault
	 * index still finds by id. Until then a card says "Checking your vault...",
	 * never that a set is missing. A cold index is retried a few times while the
	 * modal stays open. A settled answer also prunes records for gone sets.
	 */
	private async resolveRuns(): Promise<void> {
		const source = this.runSource;
		if (!source) return;
		const runs = source.get();
		const ids = [...new Set(runs.map((run) => run.recipeId))];
		if (ids.length === 0) return;
		for (let attempt = 0; attempt < 5 && !this.closed; attempt++) {
			let settled: Promise<number> | null = null;
			let discovered: ReturnType<typeof discoverImportSets> | null = null;
			const vault = {
				settle: () => (settled ??= settleVaultIndex(this.app)),
				discover: () => (discovered ??= discoverImportSets(this.app, undefined)),
			};
			const next = new Map<string, RecipeRunDisplay>();
			for (const id of ids) next.set(id, await displayRecipeRuns(runs, id, vault, this.outputRoot ?? undefined));
			if (this.closed) return;
			this.runDisplay = next;
			this.renderList();
			if ([...next.values()].every((display) => display.state === 'ready')) {
				const live = new Set([...next.values()].flatMap((display) =>
					display.state === 'ready' ? display.rows.map((row) => row.run.importSetId) : []));
				const pruned = pruneRecipeRuns(runs, live);
				if (pruned.length !== runs.length) await source.save(pruned);
				return;
			}
		}
	}

	private async reload(): Promise<void> {
		this.listing = await listLibrary(this.files);
	}

	private renderShell(): void {
		const el = this.contentEl;
		el.empty();
		const root = el.createDiv({ cls: 'crosswalker-config-browser crosswalker-recipe-library' });
		const header = root.createDiv({ cls: 'crosswalker-browser-header' });
		new Setting(header).setName(this.mode === 'select' ? 'Use a saved recipe' : 'Import recipes').setHeading();

		const toolbar = root.createDiv({ cls: 'crosswalker-browser-toolbar' });
		const searchWrap = toolbar.createDiv({ cls: 'crosswalker-search-container' });
		const search = searchWrap.createEl('input', {
			type: 'text',
			cls: 'crosswalker-search-input',
			attr: { placeholder: 'Search recipes', 'aria-label': 'Search recipes' },
		});
		search.value = this.search;
		search.addEventListener('input', () => {
			this.search = search.value;
			this.renderList();
		});
		const sortWrap = toolbar.createDiv({ cls: 'crosswalker-sort-container' });
		sortWrap.createSpan({ cls: 'crosswalker-sort-label', text: 'Sort' });
		const sort = sortWrap.createEl('select', { cls: 'dropdown' });
		sort.createEl('option', { value: 'name', text: 'Name' });
		sort.createEl('option', { value: 'newest', text: 'Newest' });
		sort.value = this.sort;
		sort.addEventListener('change', () => {
			this.sort = sort.value as SortKey;
			this.renderList();
		});
		if (this.mode === 'browse') {
			const importBtn = toolbar.createEl('button', { text: 'Import recipe file', cls: 'crosswalker-recipe-import-btn' });
			const hidden = toolbar.createEl('input', { type: 'file', attr: { accept: '.json,application/json' } });
			hidden.addClass('crosswalker-hidden-file-input');
			importBtn.addEventListener('click', () => hidden.click());
			hidden.addEventListener('change', () => {
				const file = hidden.files?.[0];
				hidden.value = '';
				if (file) void this.importFile(file);
			});
		}

		this.listEl = root.createDiv({ cls: 'crosswalker-config-list crosswalker-library-list' });
		this.renderList();
	}

	private matches(item: { name: string; description: string; id: string }): boolean {
		const q = this.search.trim().toLowerCase();
		if (!q) return true;
		return `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(q);
	}

	private sorted(items: CardItem[]): CardItem[] {
		const out = [...items];
		if (this.sort === 'newest') out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || a.name.localeCompare(b.name));
		else out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		const user: CardItem[] = this.listing.entries.map((e) => ({
			id: e.id, name: e.name, description: e.description, recipe: e.recipe, savedAt: e.savedAt, user: true,
		}));
		const builtIn: CardItem[] = builtInRecipes().map((e) => ({
			id: e.id, name: e.label, description: e.description, recipe: e.recipe, savedAt: null, user: false,
		}));

		this.renderGroup(list, 'Your recipes', this.sorted(user.filter((i) => this.matches(i))), user.length === 0
			? 'Recipes you save from the import wizard appear here.'
			: 'No saved recipe matches your search.');
		const shownBuiltIn = this.sorted(builtIn.filter((i) => this.matches(i)));
		this.renderGroup(list, 'Built in', shownBuiltIn, 'No built-in recipe matches your search.');

		if (this.listing.problems.length > 0) {
			const group = list.createDiv({ cls: 'crosswalker-recipe-group is-problems' });
			group.createEl('div', { cls: 'crosswalker-recipe-group-title', text: "Couldn't read" });
			for (const problem of this.listing.problems) {
				const row = group.createDiv({ cls: 'crosswalker-recipe-problem' });
				const head = row.createDiv({ cls: 'crosswalker-recipe-problem-file' });
				setIcon(head.createSpan({ cls: 'crosswalker-recipe-problem-ico' }), 'alert-triangle');
				head.createSpan({ text: problem.file.startsWith(`${RECIPE_LIBRARY_FOLDER}/`)
					? problem.file.slice(RECIPE_LIBRARY_FOLDER.length + 1)
					: problem.file });
				row.createEl('p', { text: problem.cause });
				row.createEl('p', { cls: 'setting-item-description', text: problem.action });
			}
		}
	}

	private renderGroup(list: HTMLElement, title: string, items: CardItem[], emptyText: string): void {
		const group = list.createDiv({ cls: 'crosswalker-recipe-group' });
		group.createEl('div', { cls: 'crosswalker-recipe-group-title', text: title });
		if (items.length === 0) {
			group.createEl('p', { cls: 'crosswalker-empty-state setting-item-description', text: emptyText });
			return;
		}
		for (const item of items) this.renderCard(group, item);
	}

	private renderCard(parent: HTMLElement, item: CardItem): void {
		const key = `${item.user ? 'u' : 'b'}:${item.id}`;
		const open = this.expanded === key;
		const card = parent.createDiv({ cls: 'crosswalker-config-card crosswalker-library-card' });
		card.dataset.recipeId = item.id;
		if (open) card.addClass('is-expanded');

		const header = card.createDiv({ cls: 'crosswalker-card-header clickable' });
		const titleArea = header.createDiv({ cls: 'crosswalker-card-title-area' });
		titleArea.createDiv({ cls: 'crosswalker-card-title', text: item.name });
		if (item.description) titleArea.createDiv({ cls: 'crosswalker-recipe-card-desc', text: item.description });
		const meta = titleArea.createDiv({ cls: 'crosswalker-card-meta' });
		const lineage = lineageLine(item.recipe, this.listing.entries);
		if (lineage) meta.createSpan({ text: lineage });
		if (item.user && item.savedAt) {
			if (lineage) meta.createSpan({ cls: 'crosswalker-meta-sep', text: '·' });
			meta.createSpan({ text: `Saved ${new Date(item.savedAt).toLocaleDateString()}` });
		}
		const runs = this.runsFor(item);
		if (runs) {
			titleArea.createDiv({
				cls: 'crosswalker-card-meta crosswalker-recipe-last-run',
				text: runs.state === 'checking' ? CHECKING_VAULT_LINE : lastRunLine(runs.rows[0]),
			});
		}
		const expandBtn = header.createEl('button', {
			cls: 'crosswalker-expand-btn clickable-icon',
			attr: { 'aria-label': open ? 'Hide details' : 'Show details' },
		});
		setIcon(expandBtn, open ? 'chevron-up' : 'chevron-down');
		header.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('.crosswalker-card-actions')) return;
			this.expanded = open ? null : key;
			this.renderList();
		});

		if (open) this.renderDetails(card, item);
		this.renderActions(card, item);
	}

	/**
	 * What the card may say about this recipe's runs: null when there is nothing
	 * to show (no records, or every record's set is gone), "checking" while the
	 * vault index has not settled.
	 */
	private runsFor(item: CardItem): RecipeRunDisplay | null {
		if (!this.runSource) return null;
		const display = this.runDisplay.get(item.id);
		if (!display) return this.runSource.get().some((run) => run.recipeId === item.id) ? { state: 'checking' } : null;
		if (display.state === 'ready' && display.rows.length === 0) return null;
		return display;
	}

	private runAgain(row: RecipeRunRow, item: CardItem): void {
		if (this.resolved || !this.onRunAgain) return;
		this.resolved = true;
		this.close();
		this.onRunAgain(row.run, item.name, { name: row.setName, noteCount: row.noteCount });
	}

	/** Expanded card: one row per set this recipe ran into, newest first. */
	private renderRuns(details: HTMLElement, item: CardItem): void {
		const runs = this.runsFor(item);
		// One run is already the card's meta line and its Run again button; a
		// section repeating it is noise. The list earns its place at two sets.
		if (!runs || runs.state !== 'ready' || !this.onRunAgain || runs.rows.length < 2) return;
		const section = details.createDiv({ cls: 'crosswalker-recipe-runs' });
		section.createDiv({ cls: 'crosswalker-recipe-dest-title', text: 'Runs' });
		const shown = runs.rows.slice(0, RUN_ROWS_SHOWN);
		for (const row of shown) {
			const line = section.createDiv({ cls: 'crosswalker-recipe-run-row' });
			const text = line.createDiv({ cls: 'crosswalker-recipe-run-text' });
			text.createSpan({ cls: 'crosswalker-recipe-run-set', text: row.setName });
			const size = row.noteCount === undefined ? '' : `, ${notesPhrase(row.noteCount)}`;
			text.createSpan({ cls: 'crosswalker-recipe-run-date', text: `Last run ${formatRunDate(row.run.finishedAt)} from ${row.run.source.name}${size}` });
			line.createEl('button', { text: 'Run again', attr: { 'aria-label': refreshLabel(row.setName) } })
				.addEventListener('click', () => this.runAgain(row, item));
		}
		const more = runs.rows.length - shown.length;
		if (more > 0) section.createDiv({ cls: 'setting-item-description', text: `and ${more} more` });
	}

	private renderDetails(card: HTMLElement, item: CardItem): void {
		const details = card.createDiv({ cls: 'crosswalker-card-details crosswalker-recipe-details' });
		// Where this recipe already ran comes first: it is what Run again acts on.
		this.renderRuns(details, item);
		details.createEl('p', { cls: 'crosswalker-recipe-source-line', text: sourceFormatLine(item.recipe) });
		this.renderDestinationTree(details, destinationSteps(item.recipe));
		const rows = summarizeRecipeColumns(item.recipe);
		if (rows.length > 0) {
			const table = details.createEl('table', { cls: 'crosswalker-recipe-columns' });
			const head = table.createEl('thead').createEl('tr');
			head.createEl('th', { text: 'Column' });
			head.createEl('th', { text: 'Becomes' });
			const body = table.createEl('tbody');
			for (const row of rows) {
				const tr = body.createEl('tr');
				tr.createEl('td').createEl('code', { text: row.column });
				tr.createEl('td', { text: row.role });
			}
		}
	}

	/** "Where notes go": the location levels as a small vault tree, never template syntax. */
	private renderDestinationTree(parent: HTMLElement, steps: DestinationStep[]): void {
		if (steps.length === 0) return;
		const tree = parent.createDiv({ cls: 'crosswalker-recipe-dest' });
		tree.createDiv({ cls: 'crosswalker-recipe-dest-title', text: 'Where notes go' });
		let depth = 0;
		const row = (icon: string): HTMLElement => {
			const el = tree.createDiv({ cls: 'crosswalker-recipe-dest-row' });
			el.setCssProps({ '--cw-dest-depth': String(depth++) });
			setIcon(el.createSpan({ cls: 'crosswalker-recipe-dest-ico' }), icon);
			return el.createSpan({ cls: 'crosswalker-recipe-dest-text' });
		};
		const columnList = (text: HTMLElement, columns: string[]) => {
			columns.forEach((column, i) => {
				if (i > 0) text.appendText(i === columns.length - 1 ? ' and ' : ', ');
				text.createEl('code', { text: column });
			});
		};
		if (this.outputRoot) row('folder').setText(`In your import folder (${this.outputRoot})`);
		for (const step of steps) {
			const text = row(step.kind === 'folder' ? 'folder' : 'file-text');
			if (step.literal !== null) {
				text.setText(step.kind === 'folder' ? step.literal : `One note for each row, named ${step.literal}`);
			} else if (step.kind === 'folder') {
				text.appendText('One folder for each ');
				columnList(text, step.columns);
				text.appendText(' value');
			} else {
				text.appendText('One note for each row, named by ');
				columnList(text, step.columns);
			}
		}
	}

	private renderActions(card: HTMLElement, item: CardItem): void {
		const actions = card.createDiv({ cls: 'crosswalker-card-actions' });
		// Run again is the primary action once the recipe has run somewhere that
		// still exists: it refreshes the newest set. "Use for import" stays as
		// "start a new set with this recipe".
		const runs = this.runsFor(item);
		const newest = runs?.state === 'ready' && this.onRunAgain ? runs.rows[0] : null;
		if (newest) {
			actions.createEl('button', { text: 'Run again', cls: 'mod-cta crosswalker-recipe-run-again', attr: { 'aria-label': refreshLabel(newest.setName) } })
				.addEventListener('click', () => this.runAgain(newest, item));
		}
		// Beside Run again, "Use for import" would not say which button touches
		// existing notes. Name the safe one by what it does.
		const use = actions.createEl('button', {
			text: this.mode === 'select' ? 'Use this recipe' : newest ? 'Import as a new set' : 'Use for import',
			cls: newest ? '' : 'mod-cta',
		});
		if (newest && this.mode !== 'select') use.setAttr('aria-label', 'Start a new import set with this recipe. Your existing notes are not touched.');
		use.addEventListener('click', () => {
			if (this.resolved) return;
			this.resolved = true;
			this.close();
			this.onUse(item.id);
		});
		if (this.mode === 'select') return;

		actions.createEl('button', { text: 'Export' }).addEventListener('click', () => { void this.doExport(item); });
		actions.createEl('button', { text: 'Duplicate' }).addEventListener('click', () => { void this.doDuplicate(item); });
		// Rename and Delete only on the open card, and Delete stays quiet: the
		// filled red button belongs to the confirm dialog alone.
		if (!item.user || this.expanded !== `u:${item.id}`) return;
		actions.createEl('button', { text: 'Rename' }).addEventListener('click', () => { void this.doRename(item); });
		actions.createEl('button', { text: 'Delete', cls: 'crosswalker-recipe-delete' }).addEventListener('click', () => { void this.doDelete(item); });
	}

	private async refresh(): Promise<void> {
		await this.reload();
		this.renderList();
	}

	private async doExport(item: CardItem): Promise<void> {
		const result = await exportRecipe(this.files, item.id);
		if (!result.ok) return failNotice(result.cause, result.action);
		downloadText(result.fileName, result.text);
		new Notice(`Exported "${item.name}" as ${result.fileName}.`);
	}

	private async doDuplicate(item: CardItem): Promise<void> {
		const result = await duplicate(this.files, item.id);
		if (!result.ok) return failNotice(result.cause, result.action);
		new Notice(`Made an editable copy: "${result.name}".`);
		this.expanded = `u:${result.id}`;
		await this.refresh();
		const id = result.id;
		const card = Array.from(this.listEl?.querySelectorAll<HTMLElement>('.crosswalker-library-card') ?? [])
			.find((c) => c.dataset.recipeId === id);
		card?.scrollIntoView({ block: 'nearest' });
	}

	private async doRename(item: CardItem): Promise<void> {
		const name = await promptText(this.app, {
			title: 'Rename recipe',
			label: 'Name',
			value: item.name,
			submitText: 'Rename',
		});
		if (name === null || name.trim() === item.name) return;
		const result = await rename(this.files, item.id, name);
		if (!result.ok) return failNotice(result.cause, result.action);
		new Notice(`Renamed to "${result.name}".`);
		await this.refresh();
	}

	private async doDelete(item: CardItem): Promise<void> {
		const ok = await confirmAction(this.app, {
			title: 'Delete recipe',
			body: `Delete your recipe "${item.name}"? It goes to the trash, so you can restore it from there.`,
			confirmText: 'Delete',
			warning: true,
		});
		if (!ok) return;
		const result = await deleteFromLibrary(this.files, item.id);
		if (!result.ok) return failNotice(result.cause, result.action);
		new Notice(`Moved "${result.name}" to the trash.`);
		await this.refresh();
	}

	private async importFile(file: File): Promise<void> {
		let text: string;
		try {
			text = await file.text();
		} catch {
			return failNotice('Crosswalker could not read that file.', 'Choose a .json file exported from Crosswalker.');
		}
		const result = await importRecipeFile(this.files, text);
		if (!result.ok) return failNotice(result.cause, result.action);
		new Notice(`Added recipe "${result.name}".`);
		await this.refresh();
	}
}
