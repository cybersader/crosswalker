import { Modal, Notice, TFile, TFolder, normalizePath, type App } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { ImportWizardModal, type PrefillBinding } from './import-wizard';
import { RECIPE_REGISTRY, type RecipeRegistryEntry } from './recipe-registry';
import { runRecognizedImport } from './run-recognized-import';
import {
	draftFromScanRow,
	scanVaultForSources,
	type ScanReport,
	type ScanRow,
} from './vault-source-scan-runner';

interface RowControls {
	row: ScanRow;
	entry: RecipeRegistryEntry;
	checkbox: HTMLInputElement;
	result: HTMLElement;
}

interface WorkspaceLeafLike {
	view?: { startImportWithFile?: (file: TFile, prefillBinding?: PrefillBinding) => void };
}

interface WorkspaceActivator {
	activateWorkspaceView?: () => Promise<WorkspaceLeafLike>;
}

const SUBTITLE =
	'Framework exports already in this vault, and what each would become. Open any row in the wizard to decide, column by column, what turns into folders, tags, links, and crosswalk edges.';
const CAP_NOTICE =
	'Stopped at 500 files. Move the export files you want into one folder and scan again, or import them one at a time.';

function relativeTime(producedAt: string | null): string {
	if (!producedAt) return 'previously';
	const elapsed = Date.now() - new Date(producedAt).getTime();
	if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now';
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

function stateText(row: ScanRow): string {
	switch (row.state.kind) {
		case 'not-imported':
			return 'Not imported';
		case 'imported-unchanged':
			return `Imported ${relativeTime(row.state.producedAt)}, unchanged`;
		case 'imported-changed':
			return `Imported ${relativeTime(row.state.producedAt)}, source changed`;
		case 'index-cold':
			return 'Checking vault index';
	}
}

function skippedReason(reason: ScanReport['skipped'][number]['reason']): string {
	switch (reason) {
		case 'over-cap':
			return 'The 500-file scan limit was reached. Move this source into a smaller source folder and scan again.';
		case 'inside-import-set':
			return 'This file is inside an existing import set. Move the source export outside generated folders and scan again.';
		case 'managed-folder':
			return 'This file is inside Crosswalker-managed storage. Move the source export outside _crosswalker and scan again.';
	}
}

export class VaultSourceScanModal extends Modal {
	private readonly plugin: CrosswalkerPlugin;
	private readonly controller = new AbortController();
	private bodyEl: HTMLElement | null = null;
	private rowControls: RowControls[] = [];
	private importButton: HTMLButtonElement | null = null;
	private draftButton: HTMLButtonElement | null = null;
	private scanning = false;
	private scanTask: Promise<void> | null = null;

	constructor(app: App, plugin: CrosswalkerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.modalEl.addClass('crosswalker-scan-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Sources found in this vault' });
		this.contentEl.createEl('p', { cls: 'crosswalker-modal-subtitle', text: SUBTITLE });
		this.bodyEl = this.contentEl.createDiv({ cls: 'crosswalker-scan-body' });
		this.scanning = true;
		this.renderProgress(0, 0, 'Preparing vault scan');
		this.scanTask = this.runScan();
	}

	onClose(): void {
		if (this.scanning) this.controller.abort();
	}

	private async runScan(): Promise<void> {
		try {
			const report = await scanVaultForSources(this.app, this.plugin, {
				signal: this.controller.signal,
				onProgress: ({ scanned, total, currentPath }) => {
					this.renderProgress(scanned, total, currentPath);
				},
			});
			this.scanning = false;
			this.renderResults(report);
		} catch (error) {
			this.scanning = false;
			const cause = error instanceof Error ? error.message : String(error);
			this.bodyEl?.empty();
			this.bodyEl?.createDiv({
				cls: 'crosswalker-scan-error',
				text: `Could not scan the vault: ${cause}. Close this window and try again.`,
			});
			this.renderCloseOnlyFooter();
		}
	}

	private renderProgress(scanned: number, total: number, currentPath: string): void {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		const progress = this.bodyEl.createDiv({ cls: 'crosswalker-scan-progress' });
		progress.createDiv({ text: `Scanned ${scanned} of ${total} files` });
		progress.createEl('code', { cls: 'crosswalker-scan-path', text: currentPath });
		const cancel = progress.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.controller.abort());
	}

	private renderResults(report: ScanReport): void {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		this.rowControls = [];

		if (report.cancelled) {
			this.bodyEl.createDiv({
				cls: 'crosswalker-scan-stopped',
				text: `Stopped after ${report.scanned} of ${report.total} files. Showing what was found so far.`,
			});
		}
		if (report.skipped.some((item) => item.reason === 'over-cap')) {
			this.bodyEl.createDiv({ cls: 'crosswalker-scan-cap', text: CAP_NOTICE });
		}

		const table = this.bodyEl.createEl('table', { cls: 'crosswalker-scan-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const label of ['', 'File', 'Match', 'Source details', 'State', 'Action', 'Result']) {
			header.createEl('th', { text: label });
		}
		const tbody = table.createEl('tbody');
		for (const row of report.rows) this.renderRow(tbody, row);
		if (report.rows.length === 0) {
			const empty = tbody.createEl('tr').createEl('td', { attr: { colspan: '7' } });
			empty.setText('No recognized framework exports were found. Move an export into the vault and scan again, or open it directly in the wizard.');
		}

		this.renderForeignSets(report);
		this.renderSkipped(report);
		this.renderFooter();
	}

	private renderRow(tbody: HTMLElement, row: ScanRow): void {
		const entry = RECIPE_REGISTRY.find((candidate) => candidate.id === row.candidate.entryId);
		if (!entry) return;
		const tr = tbody.createEl('tr');
		const checkboxCell = tr.createEl('td');
		const checkbox = checkboxCell.createEl('input', { type: 'checkbox' });
		checkbox.checked = row.candidate.confident && row.state.kind === 'not-imported';
		if (row.state.kind === 'index-cold') {
			checkbox.disabled = true;
			checkbox.title = 'Checking vault index';
		}

		tr.createEl('td', { cls: 'crosswalker-scan-file' }).createEl('code', { text: row.path });
		const match = tr.createEl('td');
		match.createDiv({
			text: `${row.candidate.confident ? 'Looks like' : 'Possible match:'} ${row.candidate.label}`,
		});
		match.createDiv({ cls: 'crosswalker-scan-score', text: `Score ${row.candidate.score}` });

		const details = tr.createEl('td', { cls: 'crosswalker-scan-details' });
		if (row.candidate.table !== '' || row.candidate.headerRow > 0) {
			details.setText(`sheet '${row.candidate.table}', header row ${row.candidate.headerRow}`);
		} else {
			details.setText('Headers on the first row');
		}

		const state = tr.createEl('td');
		state.createSpan({
			cls: `crosswalker-scan-state is-${row.state.kind}`,
			text: stateText(row),
		});
		if (row.state.kind === 'index-cold') {
			state.createDiv({
				cls: 'crosswalker-scan-state-help',
				text: 'Wait for indexing to finish, then scan again.',
			});
		}

		const actionCell = tr.createEl('td');
		const action = actionCell.createEl('button', { text: this.actionLabel(row) });
		if (row.state.kind === 'index-cold') {
			action.disabled = true;
			action.title = 'The vault index is not ready. Wait for indexing to finish, then scan again.';
		} else {
			action.addEventListener('click', () => {
				void this.runRowAction(row);
			});
		}

		const result = tr.createEl('td', { cls: 'crosswalker-scan-result' });
		this.rowControls.push({ row, entry, checkbox, result });
	}

	private actionLabel(row: ScanRow): string {
		if (row.state.kind === 'imported-unchanged') return 'Open';
		if (row.state.kind === 'imported-changed') return 'Refresh';
		return 'Open in wizard';
	}

	private async runRowAction(row: ScanRow): Promise<void> {
		if (row.state.kind === 'imported-unchanged') {
			await this.openWorkspace();
			return;
		}
		await this.openInWizard(row);
	}

	private async openWorkspace(): Promise<void> {
		const activate = (this.plugin as unknown as WorkspaceActivator).activateWorkspaceView;
		if (typeof activate !== 'function') {
			new Notice('The workspace could not be opened because its view is unavailable. Run the workspace command and find the imported framework.', 7000);
			return;
		}
		try {
			this.close();
			await activate.call(this.plugin);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			new Notice(`The workspace could not be opened: ${cause}. Run the workspace command and find the imported framework.`, 7000);
		}
	}

	private async openInWizard(row: ScanRow): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(row.path);
		if (!(file instanceof TFile)) {
			new Notice(`The source file is no longer at ${row.path}. Restore it and scan again.`, 7000);
			return;
		}
		this.close();
		const isJson = row.name.toLowerCase().endsWith('.json');
		const binding: PrefillBinding = {
			sheet: row.candidate.table || null,
			headerRow: row.candidate.headerRow,
			iterator: isJson ? row.candidate.table || null : null,
		};
		const activate = (this.plugin as unknown as WorkspaceActivator).activateWorkspaceView;
		if (typeof activate === 'function') {
			try {
				const leaf = await activate.call(this.plugin);
				const start = leaf.view?.startImportWithFile;
				if (typeof start === 'function') {
					start.call(leaf.view, file, binding);
					return;
				}
			} catch {
				// The modal fallback below remains a complete import entry point.
			}
		}
		new ImportWizardModal(this.app, this.plugin, { prefillFile: file, prefillBinding: binding }).open();
	}

	private renderForeignSets(report: ScanReport): void {
		if (!this.bodyEl || report.foreignSets.length === 0) return;
		const section = this.bodyEl.createDiv({ cls: 'crosswalker-scan-foreign' });
		section.createEl('h3', { text: 'Managed by another producer' });
		for (const set of report.foreignSets) {
			const row = section.createDiv({ cls: 'crosswalker-scan-foreign-row' });
			row.createDiv({
				text: `${set.setId}: ${set.noteCount} notes under ${set.root ?? 'no shared folder'}`,
			});
			const open = row.createEl('button', { text: 'Open' });
			open.addEventListener('click', () => {
				void this.revealForeignSet(set.root, set.setId);
			});
		}
	}

	private async revealForeignSet(root: string | null, setId: string): Promise<void> {
		if (!root) {
			new Notice(`Import set ${setId} has no shared folder. Search for its import set id to open its notes.`, 7000);
			return;
		}
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(root));
		if (!(folder instanceof TFolder)) {
			new Notice(`The managed folder ${root} could not be found. Search for import set ${setId} to open its notes.`, 7000);
			return;
		}
		const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
		if (!leaf) {
			new Notice(`The file explorer is unavailable. Search for import set ${setId} to open its notes.`, 7000);
			return;
		}
		await this.app.workspace.revealLeaf(leaf);
		const deferred = leaf as unknown as { loadIfDeferred?: () => Promise<void> };
		if (typeof deferred.loadIfDeferred === 'function') await deferred.loadIfDeferred();
		const view = leaf.view as unknown as { revealInFolder?: (file: TFolder) => void };
		if (typeof view.revealInFolder !== 'function') {
			new Notice(`The file explorer cannot reveal folders in this layout. Search for import set ${setId} to open its notes.`, 7000);
			return;
		}
		view.revealInFolder(folder);
	}

	private renderSkipped(report: ScanReport): void {
		if (!this.bodyEl) return;
		const noteEntries = Object.entries(report.notes);
		if (report.skipped.length === 0 && noteEntries.length === 0) return;
		const details = this.bodyEl.createEl('details', { cls: 'crosswalker-scan-skipped' });
		details.createEl('summary', {
			text: `Skipped (${report.skipped.length + noteEntries.length})`,
		});
		for (const item of report.skipped) {
			const line = details.createDiv({ cls: 'crosswalker-scan-skipped-row' });
			line.createEl('code', { text: item.path });
			line.createSpan({ text: skippedReason(item.reason) });
		}
		for (const [path, note] of noteEntries) {
			const line = details.createDiv({ cls: 'crosswalker-scan-skipped-row' });
			line.createEl('code', { text: path });
			line.createSpan({ text: note });
		}
	}

	private renderFooter(): void {
		const footer = this.contentEl.createDiv({ cls: 'crosswalker-modal-footer crosswalker-scan-footer' });
		this.importButton = footer.createEl('button', { cls: 'mod-cta', text: 'Import selected' });
		this.importButton.addEventListener('click', () => {
			void this.importSelected();
		});
		this.draftButton = footer.createEl('button', { text: 'Create drafts for selected' });
		this.draftButton.addEventListener('click', () => {
			void this.createDrafts();
		});
		const close = footer.createEl('button', { text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	private renderCloseOnlyFooter(): void {
		const footer = this.contentEl.createDiv({ cls: 'crosswalker-modal-footer crosswalker-scan-footer' });
		const close = footer.createEl('button', { text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	private selectedRows(): RowControls[] {
		return this.rowControls.filter((control) => control.checkbox.checked && !control.checkbox.disabled);
	}

	private setFooterBusy(busy: boolean): void {
		if (this.importButton) this.importButton.disabled = busy;
		if (this.draftButton) this.draftButton.disabled = busy;
	}

	private async importSelected(): Promise<void> {
		this.setFooterBusy(true);
		try {
			for (const control of this.selectedRows()) {
				const file = this.app.vault.getAbstractFileByPath(control.row.path);
				if (!(file instanceof TFile)) {
					control.result.setText(`Could not import ${control.row.path}: the file is no longer in the vault. Restore it and run Import selected again for the rest.`);
					break;
				}
				control.result.setText('Importing selected source');
				const outcome = await runRecognizedImport(this.app, this.plugin, {
					file,
					entry: control.entry,
					table: control.row.candidate.table,
					headerRow: control.row.candidate.headerRow,
					onProgress: (current, total, message) => {
						control.result.setText(`Importing: ${message} (${current}/${total})`);
					},
				});
				if (!outcome.ok) {
					control.result.setText(outcome.errors[0] ?? `Import failed for ${control.row.name}. Fix the source or configuration, then run Import selected again for the rest.`);
					break;
				}
				control.result.setText(`Imported ${outcome.created} notes`);
				control.checkbox.checked = false;
			}
		} finally {
			this.setFooterBusy(false);
		}
	}

	private async createDrafts(): Promise<void> {
		this.setFooterBusy(true);
		try {
			const selected = this.selectedRows();
			for (const control of selected) {
				await this.plugin.draftStore.save(
					draftFromScanRow(control.row, control.entry, this.plugin.settings),
				);
			}
			new Notice(`Created ${selected.length} drafts. Open them from Resume a draft.`);
			this.close();
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			new Notice(`Could not create drafts: ${cause}. Fix vault access and try again.`, 7000);
		} finally {
			this.setFooterBusy(false);
		}
	}
}
