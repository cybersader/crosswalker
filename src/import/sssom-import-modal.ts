/* eslint-disable obsidianmd/ui/sentence-case --
 * UI text in this modal frequently references SSSOM (Simple Standard for
 * Sharing Ontological Mappings — proper-noun acronym, MUST stay all-caps),
 * TSV (proper-noun acronym), BioPortal/OxO/OBO Foundry/Biomappings (product
 * names with canonical casing). The sentence-case rule fires on these
 * legitimate proper nouns; rule-disable is correct here. Per CLAUDE.md
 * convention "Use eslint-disable-next-line for intentional exceptions
 * (e.g., code examples)."
 */
/**
 * sssom-import-modal.ts — Phase 2 v0.1.6 (per Ch 35)
 *
 * Modal UX for SSSOM TSV import:
 *   1. File picker (vault file or paste TSV content)
 *   2. Parse + preview (row count + detected ontology pair + warnings)
 *   3. Confirm + execute (calls importSssom)
 *   4. Progress notice during execution
 *   5. Result summary (created/skipped/errors)
 *
 * Per Ch 32 UX direction: keep this picker-style. The modal does NOT
 * surface raw schema editing — for that, users edit the .sssom.tsv file
 * directly, then re-import.
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { detectOntologyPair, parseSssomTsv } from './sssom-parser';
import { importSssom, SSSOM_CURIE_PREFIX, type SssomImportResult } from './sssom-importer';
import {
	discoverImportSets,
	newSetSchemeFor,
	type DiscoveredImportSet,
	type ImportSetOption,
} from '../generation/import-set';
import type { GenerationError, GenerationResult } from '../types/config';

/**
 * AM-8. One row error, as a user can read it.
 *
 * Failure mode prevented: `errors.join()` on an array of objects, which prints
 * `[object Object]` and tells the user nothing they can act on. A negative row
 * number is a whole-run error rather than a row, so it carries no row label.
 */
function formatGenerationError(error: GenerationError): string {
	return error.row >= 0 ? `Row ${error.row}: ${error.message}` : error.message;
}

/** The same, for the handful of errors a Notice has room for. */
function formatGenerationErrors(errors: readonly GenerationError[] | undefined): string {
	if (!errors || errors.length === 0) return 'unknown error';
	const shown = errors.slice(0, 3).map(formatGenerationError).join('; ');
	return errors.length > 3 ? `${shown} (and ${errors.length - 3} more)` : shown;
}

/** Source for the SSSOM TSV content. */
type Source =
	| { kind: 'vault-file'; path: string }
	| { kind: 'paste'; content: string }
	| { kind: 'none' };


/**
 * Human-readable label for one import set in a chooser.
 *
 * The minted id is intentionally meaningless — that is what keeps identity stable
 * when recipes, destinations and sources change. But a user choosing WHICH release
 * to refresh cannot act on `iset-8f3ka2`, and choosing wrong overwrites the wrong
 * release. So the chooser shows the facts that distinguish sets in practice: how
 * many notes it owns and where they live. The id stays visible because it is what
 * appears in note frontmatter.
 */
export function describeImportSet(set: { id: string; noteCount: number; paths: string[]; scheme?: string }): string {
	const folder = commonFolder(set.paths);
	const where = folder ? ` in ${folder}` : '';
	const noteWord = set.noteCount === 1 ? 'note' : 'notes';
	return `${set.id} — ${set.noteCount} ${noteWord}${where}`;
}

/** Longest shared folder prefix of the given paths, or '' when they share none. */
function commonFolder(paths: string[]): string {
	if (paths.length === 0) return '';
	const split = paths.map((path) => path.split('/').slice(0, -1));
	const first = split[0] ?? [];
	let shared = first.length;
	for (const parts of split.slice(1)) {
		let i = 0;
		while (i < shared && i < parts.length && parts[i] === first[i]) i += 1;
		shared = i;
	}
	return first.slice(0, shared).join('/');
}

export class SssomImportModal extends Modal {
	private plugin: CrosswalkerPlugin;
	private source: Source = { kind: 'none' };
	private parsedTsv: string | null = null;
	private detectedSource: string | null = null;
	private detectedTarget: string | null = null;
	private rowCount: number = 0;
	private parseWarnings: string[] = [];
	private parseErrors: string[] = [];
	private importSetChoice: ImportSetOption | null = null;
	private importSetChoiceBasePath: string = '';

	constructor(app: App, plugin: CrosswalkerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Import SSSOM mapping file' });

		this.contentEl.createEl('p', {
			text:
				'SSSOM is the open-standard TSV format for sharing ontological mappings. ' +
				'Used by BioPortal, OxO, OBO Foundry, and Biomappings. Crosswalker imports SSSOM ' +
				'mappings as crosswalk-edge junction notes in your vault.',
		});

		// Step 1: Source selection
		new Setting(this.contentEl)
			.setName('Source TSV file')
			.setDesc('Pick a .sssom.tsv file from your vault, or paste TSV content directly.')
			.addButton((btn) =>
				btn.setButtonText('Pick from vault').onClick(() => {
					this.openFilePicker();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Paste TSV').onClick(() => {
					this.openPasteEditor();
				}),
			);

		// Step 2: Preview area (rendered after parsing)
		this.contentEl.createDiv({ cls: 'crosswalker-sssom-preview', attr: { id: 'crosswalker-sssom-preview' } });

		// Step 3: Action buttons
		const buttonBar = this.contentEl.createDiv({ cls: 'modal-button-container' });
		new Setting(buttonBar)
			.addButton((btn) =>
				btn
					.setButtonText('Import')
					.setCta()
					.setDisabled(true)
					.onClick(async () => {
						await this.runImport();
					}),
			)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
	}

	private async openFilePicker() {
		const tsvFiles = this.app.vault.getFiles().filter((f: TFile) => f.path.endsWith('.sssom.tsv') || f.path.endsWith('.tsv'));
		if (tsvFiles.length === 0) {
			new Notice('No .tsv or .sssom.tsv files found in this vault. Add one or use Paste TSV.');
			return;
		}

		const pickerModal = new Modal(this.app);
		pickerModal.contentEl.createEl('h3', { text: 'Pick SSSOM TSV file' });
		for (const f of tsvFiles) {
			new Setting(pickerModal.contentEl).setName(f.path).addButton((btn) =>
				btn.setButtonText('Select').onClick(async () => {
					const content = await this.app.vault.read(f);
					this.source = { kind: 'vault-file', path: f.path };
					this.parsedTsv = content;
					await this.refreshPreview();
					pickerModal.close();
				}),
			);
		}
		pickerModal.open();
	}

	private openPasteEditor() {
		const pasteModal = new Modal(this.app);
		pasteModal.contentEl.createEl('h3', { text: 'Paste SSSOM TSV content' });
		const textarea = pasteModal.contentEl.createEl('textarea', {
			attr: { rows: '20', cols: '80', placeholder: 'subject_id\\tpredicate_id\\tobject_id\\n...' },
		});
		new Setting(pasteModal.contentEl).addButton((btn) =>
			btn
				.setButtonText('Use this TSV')
				.setCta()
				.onClick(async () => {
					this.source = { kind: 'paste', content: textarea.value };
					this.parsedTsv = textarea.value;
					await this.refreshPreview();
					pasteModal.close();
				}),
		);
		pasteModal.open();
	}

	private async refreshPreview() {
		const previewEl = this.contentEl.querySelector('#crosswalker-sssom-preview') as HTMLElement | null;
		if (!previewEl || !this.parsedTsv) return;

		previewEl.empty();
		const result = parseSssomTsv(this.parsedTsv);
		this.parseWarnings = result.warnings;
		this.parseErrors = result.errors;
		this.rowCount = result.rows.length;

		const pair = detectOntologyPair(result);
		this.detectedSource = pair?.source ?? null;
		this.detectedTarget = pair?.target ?? null;

		if (result.errors.length > 0) {
			previewEl.createEl('p', { text: 'Parse errors:', cls: 'mod-warning' });
			const ul = previewEl.createEl('ul');
			for (const err of result.errors) ul.createEl('li', { text: err });
			this.setImportButtonEnabled(false);
			return;
		}

		previewEl.createEl('h3', { text: 'Preview' });
		const list = previewEl.createEl('dl');
		this.dlEntry(list, 'Mapping rows', String(this.rowCount));
		let importSetReady = true;
		if (this.detectedSource && this.detectedTarget) {
			this.dlEntry(list, 'Source ontology', this.detectedSource);
			this.dlEntry(list, 'Target ontology', this.detectedTarget);
			const outputFolder = `_crosswalker/mappings/${this.detectedSource}-to-${this.detectedTarget}`;
			this.dlEntry(
				list,
				'Output organization',
				`${outputFolder}/ with one junction note per assertion`,
			);
			importSetReady = await this.renderImportSetChoice(previewEl, outputFolder);
		} else {
			this.dlEntry(list, 'Ontology pair', '(could not detect; add subject_source/object_source to header)');
		}
		if (typeof result.header.mapping_set_id === 'string') {
			this.dlEntry(list, 'Header mapping set id', `${result.header.mapping_set_id} (individual rows may override)`);
		}
		if (typeof result.header.mapping_provider === 'string') {
			this.dlEntry(list, 'Mapping provider', result.header.mapping_provider);
		}

		if (result.warnings.length > 0) {
			previewEl.createEl('h4', { text: `${result.warnings.length} warning(s)` });
			const ul = previewEl.createEl('ul');
			for (const w of result.warnings.slice(0, 10)) ul.createEl('li', { text: w });
			if (result.warnings.length > 10) {
				previewEl.createEl('p', { text: `(+ ${result.warnings.length - 10} more — see debug log)` });
			}
		}

		this.setImportButtonEnabled(
			this.rowCount > 0
			&& this.detectedSource !== null
			&& this.detectedTarget !== null
			&& importSetReady,
		);
	}

	/**
	 * AM-11. Ownership review for the crosswalk destination, the same shape as the
	 * wizard review: every set that lives here is listed, a new set is the default,
	 * and a refresh happens only because someone clicked for it.
	 *
	 * Failure mode prevented: this surface used to adopt the single set it found in
	 * the destination folder without anyone choosing it. A crosswalk folder is named
	 * after the ontology PAIR, so a vendor crosswalk and an in-house crosswalk
	 * between the same two frameworks land in the same folder while being different
	 * bodies of work. Adopting meant the second import silently replaced the first,
	 * assertion by assertion, and orphaned the rows the two did not share. The
	 * folder is deterministic; the owner is not.
	 *
	 * Returns whether the Import button may be enabled. There is always a default
	 * now, so the only answer that blocks is a discovery that threw.
	 */
	private async renderImportSetChoice(container: HTMLElement, basePath: string): Promise<boolean> {
		let sets: DiscoveredImportSet[];
		try {
			sets = await this.importSetsForDestination(basePath);
		} catch (error) {
			container.createEl('p', {
				text: error instanceof Error ? error.message : String(error),
				cls: 'mod-warning',
			});
			return false;
		}
		if (sets.length === 0) return true;

		const refreshing = this.refreshTargetSet(sets);
		const wrap = container.createDiv({ cls: 'crosswalker-import-set-review' });
		wrap.createEl('h4', { text: 'Existing crosswalk imports' });

		const line = wrap.createEl('p', { cls: 'setting-item-description' });
		if (refreshing) {
			line.setText(
				`Refreshing ${refreshing.id} (${refreshing.noteCount} existing notes). This replaces that release while preserving its identities.`,
			);
		} else {
			line.setText(sets.length === 1
				? 'Importing as a new set with set-qualified identities. The crosswalk import already here stays separate.'
				: `Importing as a new set with set-qualified identities. The ${sets.length} crosswalk imports already here stay separate.`);
		}

		// Every set, with the facts that tell them apart. A minted id is deliberately
		// meaningless, so a user deciding which release to replace needs its size and
		// its folder in front of them.
		const list = wrap.createEl('ul');
		for (const set of sets) list.createEl('li', { text: describeImportSet(set) });

		// A new set is FIRST and is what a fresh review shows, because it is the only
		// choice that cannot damage anything: a new set owns no notes.
		new Setting(wrap)
			.setName('Import set')
			.setDesc('A new set is the default and uses set-qualified identities. Choose an existing set only to refresh and replace the notes it already owns.')
			.addDropdown((dropdown) => {
				dropdown.addOption('__new__', 'Keep this release as a new set');
				for (const set of sets) dropdown.addOption(set.id, describeImportSet(set));
				dropdown.setValue(refreshing ? refreshing.id : '__new__').onChange((selected) => {
					const picked = sets.find((set) => set.id === selected);
					this.importSetChoice = picked ? { id: picked.id, scheme: picked.scheme } : 'new-set-qualified';
					void this.refreshPreview();
				});
			});

		// The existing button, in its original role and now its only one: the
		// one-click route into a refresh when a single set sits at this destination.
		if (!refreshing && sets.length === 1) {
			const set = sets[0];
			const refresh = wrap.createEl('button', { text: `Refresh ${describeImportSet(set)} instead` });
			refresh.addEventListener('click', () => {
				this.importSetChoice = { id: set.id, scheme: set.scheme };
				void this.refreshPreview();
			});
		}
		if (refreshing) {
			const fresh = wrap.createEl('button', { text: 'Keep both as a new set' });
			fresh.addEventListener('click', () => {
				this.importSetChoice = 'new-set-qualified';
				void this.refreshPreview();
			});
		}
		return true;
	}

	/** The set an explicit refresh choice names, or null when none was chosen. */
	private refreshTargetSet(sets: readonly DiscoveredImportSet[]): DiscoveredImportSet | null {
		const choice = this.importSetChoice;
		if (!this.isExistingSetChoice(choice)) return null;
		return sets.find((set) => set.id === choice.id) ?? null;
	}

	private async importSetsForDestination(basePath: string): Promise<DiscoveredImportSet[]> {
		if (basePath !== this.importSetChoiceBasePath) {
			// A different destination is a different ownership question, so an answer
			// given about the previous one does not carry over.
			this.importSetChoiceBasePath = basePath;
			this.importSetChoice = null;
		}
		const sets = await discoverImportSets(this.app, basePath);
		// AM-11. NOTHING PRESELECTS A REFRESH HERE. A `sets.length === 1` branch used
		// to assign that set as the choice, which made "one crosswalk already lives in
		// this folder" mean "you meant to overwrite it".
		const choice = this.importSetChoice;
		if (this.isExistingSetChoice(choice) && !sets.some((set) => set.id === choice.id)) {
			// The chosen set is not at this destination any more, so the choice names
			// nothing. Falling back to the default is the safe direction.
			this.importSetChoice = null;
		}
		return sets;
	}

	/**
	 * The ownership option the import runs with. AM-11: an explicit choice, or a new
	 * set. There is no "adopt whichever one is already there" answer, here or in the
	 * engine below it.
	 */
	private async selectedImportSet(): Promise<ImportSetOption> {
		if (this.detectedSource && this.detectedTarget) {
			const basePath = `_crosswalker/mappings/${this.detectedSource}-to-${this.detectedTarget}`;
			const sets = await this.importSetsForDestination(basePath);
			const choice = this.importSetChoice;
			if (this.isExistingSetChoice(choice)) {
				const set = sets.find((candidate) => candidate.id === choice.id);
				if (!set) throw new Error('Choose an import set to refresh, or choose to keep this release as a new set.');
				return { id: set.id, scheme: set.scheme };
			}
			// AM-18. `new-set-qualified` is already an answer to the qualification
			// question - the user clicked "keep both as a new set" on a screen that
			// promised set-qualified identities - so it passes through untouched
			// rather than being re-derived and possibly downgraded to `new`. Same
			// pass-through the wizard's AM-15 branch does.
			if (choice === 'new-set-qualified') return choice;
		}
		// No click, so a new set - and WHICH new set is the one shared rule.
		//
		// AM-18 (2026-08-31). This used to read `sets.length === 0 ? 'new' :
		// 'new-set-qualified'` against a list scoped to the pair folder: a
		// folder-emptiness answer to an identity question, which is this project's
		// own thesis inverted. Move or rename an earlier crosswalk's folder with a
		// plain drag and the next import of that pair saw an empty destination,
		// minted an unqualified set into the moved set's occupied curie space, and
		// met it as an AM-12 collision on every row. The shared rule asks the whole
		// vault about the identity space these edges actually occupy, which for
		// every SSSOM import is `SSSOM_CURIE_PREFIX` rather than the ontology pair.
		//
		// The undetected-pair case lands here too. It used to return a bare `new`,
		// and there is no reason for it to answer the qualification question
		// differently from any other route to a new set.
		return newSetSchemeFor(this.app, SSSOM_CURIE_PREFIX);
	}

	private isExistingSetChoice(choice: ImportSetOption | null = this.importSetChoice): choice is { id: string } {
		return !!choice && typeof choice === 'object' && 'id' in choice;
	}

	private setImportButtonEnabled(enabled: boolean) {
		const btn = this.contentEl.querySelector('button.mod-cta') as HTMLButtonElement | null;
		if (btn) btn.disabled = !enabled;
	}

	private dlEntry(parent: HTMLElement, label: string, value: string) {
		parent.createEl('dt', { text: label });
		parent.createEl('dd', { text: value });
	}

	private async runImport() {
		if (!this.parsedTsv) {
			new Notice('No TSV content to import.');
			return;
		}

		let importSet: ImportSetOption;
		try {
			importSet = await this.selectedImportSet();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			return;
		}
		// AM-11. Not a hardcoded 'replace'. The importer's own default rewrote
		// whatever it landed on, which combined with the deleted preselect above to
		// replace another provider's crosswalk with nobody having asked for it. A
		// new set owns no notes, so nothing can be overwritten and the harmless
		// value is correct; a refresh is a click on a line that says it replaces
		// that release, so replace is what that click means.
		const refreshing = this.isExistingSetChoice(importSet);

		const progressNotice = new Notice('SSSOM import: starting…', 0);
		try {
			const result: SssomImportResult = await importSssom(
				this.app,
				this.parsedTsv,
				this.plugin.runProjection,
				this.plugin.precomputeClosure,
				{
					importSet,
					overwriteMode: refreshing ? 'replace' : 'skip',
					onProgress: (current, total, msg) => {
						progressNotice.setMessage(`SSSOM import: ${msg} (${current}/${total})`);
					},
				},
				this.plugin.debug,
			);

			progressNotice.hide();

			if (result.skipped === 'parse-error') {
				new Notice(`SSSOM import aborted: ${result.parse.errors.join('; ')}`);
				return;
			}
			if (result.skipped === 'no-rows') {
				new Notice('SSSOM file had no valid mapping rows.');
				return;
			}

			// AM-8. Every entry point shows its errors; there is no exempt surface.
			// A row error here (an ambiguous identity is the case that found this)
			// used to be summarized as a "warning" and the window closed on it, so
			// the only record of a refusal was the debug log, which is off by
			// default. Same family as the purge that reported success.
			const gen = result.generation;
			if (!gen?.success) {
				new Notice(`SSSOM import failed: ${formatGenerationErrors(gen?.errors)}`, 10000);
				if (gen) this.renderImportErrors(gen, result.folder);
				return;
			}

			if (gen.errors.length > 0) {
				new Notice(`SSSOM import finished with ${gen.errors.length} errors. See results.`, 10000);
				this.renderImportErrors(gen, result.folder);
				return;
			}

			new Notice(
				`SSSOM import: ${gen.created.length} junction notes created under ${result.folder}`,
				8000,
			);
			this.close();
		} catch (err) {
			progressNotice.hide();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`SSSOM import error: ${msg}`);
			this.plugin.debug?.error('sssom-import', 'unhandled-error', 'SSSOM import: unhandled error', { error: msg });
		}
	}

	/**
	 * AM-8. The results screen this modal never had.
	 *
	 * A run that ends must show its errors somewhere the user can read them. A
	 * Notice truncates, expires, and cannot be scrolled, so a run with twenty
	 * refusals reached the user as one line and then vanished.
	 */
	private renderImportErrors(gen: GenerationResult, folder: string | null | undefined): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'SSSOM import results' });

		const summary = contentEl.createDiv({ cls: 'crosswalker-results-summary' });
		summary.createEl('p', {
			text: `Created: ${gen.created.length} junction notes${folder ? ` under ${folder}` : ''}`,
		});
		if (gen.skipped.length > 0) {
			summary.createEl('p', { text: `Skipped: ${gen.skipped.length} existing notes` });
		}
		summary.createEl('p', { text: `Errors: ${gen.errors.length}`, cls: 'mod-warning' });

		contentEl.createEl('h4', { text: 'Errors' });
		const list = contentEl.createDiv({ cls: 'crosswalker-error-list' });
		for (const error of gen.errors.slice(0, 20)) {
			list.createEl('p', { text: formatGenerationError(error), cls: 'crosswalker-error-item' });
		}
		if (gen.errors.length > 20) {
			list.createEl('p', {
				text: `... and ${gen.errors.length - 20} more`,
				cls: 'setting-item-description',
			});
		}

		const footer = contentEl.createDiv({ cls: 'modal-button-container' });
		const closeBtn = footer.createEl('button', { text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());
	}
}
