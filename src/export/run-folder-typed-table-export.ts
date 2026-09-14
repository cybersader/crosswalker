import type { App, TFolder } from 'obsidian';
import { Modal, Setting, TFile } from 'obsidian';
import { exportFolderAsStrmTsv, type StrmExportResult } from './strm-tsv-exporter';
import {
	exportSiblingPath,
	writeExportFile,
	type WriteExportFileOptions,
} from './write-export-file';

export type FolderTypedTableExportStatus = 'written' | 'empty' | 'cancelled' | 'failed';

/** Stable command result so UI wiring and deterministic tests share one truth. */
export interface FolderTypedTableExportOutcome {
	status: FolderTypedTableExportStatus;
	destinationPath: string;
	rowCount: number;
	skippedCount: number;
	message: string;
}

export interface RunFolderTypedTableExportOptions {
	app: App;
	folder: TFolder;
	/** Test seam for the command-specific confirmation modal. */
	confirmReplace?: (destinationPath: string) => Promise<boolean>;
	/** Test seam; production always uses the existing exporter unchanged. */
	exportFolder?: (app: App, rootPath: string) => Promise<StrmExportResult>;
	/** Test seam; production always uses the shared vault writer. */
	writeFile?: (
		app: App,
		path: string,
		content: string,
		options?: WriteExportFileOptions,
	) => Promise<void>;
}

class TypedTableReplaceConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly destinationPath: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	private finish(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(confirmed);
		this.close();
	}

	onOpen(): void {
		this.modalEl.addClass('crosswalker-typed-table-replace-confirmation');
		this.contentEl.empty();
		new Setting(this.contentEl).setName('Replace typed mapping table?').setHeading();
		this.contentEl.createEl('p', {
			text: `${this.destinationPath} already exists. Replace it with this export?`,
		});
		this.contentEl.createEl('p', {
			text: 'Cancel or close this window to keep the existing file.',
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
			.addButton((button) => button.setButtonText('Replace file').setWarning()
				.onClick(() => this.finish(true)));
	}

	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolve(false);
		}
		this.contentEl.empty();
	}
}

function confirmTypedTableReplacement(app: App, destinationPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		new TypedTableReplaceConfirmModal(app, destinationPath, resolve).open();
	});
}

function skippedSuffix(skippedCount: number): string {
	if (skippedCount === 0) return '';
	return ` (${skippedCount} note${skippedCount === 1 ? '' : 's'} skipped)`;
}

interface CommandFolderTarget {
	exporterRootPath: string;
	destinationPath: string;
	sourceLabel: string;
}

/**
 * Adapt Obsidian's root folder identity to the existing export contracts.
 * `TFolder.path` has differed across host/test representations, so root is the
 * API fact (`isRoot()`), never a path spelling. This adapter is command-local:
 * shared CSV/crosswalk destination behavior remains unchanged.
 */
function commandFolderTarget(folder: TFolder): CommandFolderTarget {
	if (folder.isRoot()) {
		return {
			exporterRootPath: '',
			destinationPath: 'vault.export.typed-mappings.tsv',
			sourceLabel: 'vault root',
		};
	}
	return {
		exporterRootPath: folder.path,
		destinationPath: exportSiblingPath(folder, 'typed-mappings.tsv'),
		sourceLabel: folder.path,
	};
}

/**
 * Execute one typed mapping table export without allowing the command callback
 * to infer success from a started write. Every expected branch resolves to an
 * explicit outcome, and only an awaited successful write returns `written`.
 */
export async function runFolderTypedTableExport(
	options: RunFolderTypedTableExportOptions,
): Promise<FolderTypedTableExportOutcome> {
	const { app, folder } = options;
	const target = commandFolderTarget(folder);
	const { destinationPath } = target;
	const exportFolder = options.exportFolder ?? exportFolderAsStrmTsv;
	const writeFile = options.writeFile ?? writeExportFile;
	const confirmReplace = options.confirmReplace
		?? ((path: string) => confirmTypedTableReplacement(app, path));

	let result: StrmExportResult;
	try {
		result = await exportFolder(app, target.exporterRootPath);
	} catch {
		return {
			status: 'failed',
			destinationPath,
			rowCount: 0,
			skippedCount: 0,
			message: `Could not read typed mappings under "${target.sourceLabel}". Check that the source notes are readable, then try again.`,
		};
	}

	const skippedCount = result.skipped.length;
	if (result.rowCount === 0) {
		return {
			status: 'empty',
			destinationPath,
			rowCount: 0,
			skippedCount,
			message: `No typed mappings found under "${target.sourceLabel}". No export was written.${skippedSuffix(skippedCount)}`,
		};
	}

	const existing = app.vault.getAbstractFileByPath(destinationPath);
	if (existing && !(existing instanceof TFile)) {
		return {
			status: 'failed',
			destinationPath,
			rowCount: result.rowCount,
			skippedCount,
			message: `Could not export typed mappings because ${destinationPath} is not a file. Rename that item or choose a different folder, then try again.`,
		};
	}

	if (existing instanceof TFile) {
		let confirmed: boolean;
		try {
			confirmed = await confirmReplace(destinationPath);
		} catch {
			return {
				status: 'failed',
				destinationPath,
				rowCount: result.rowCount,
				skippedCount,
				message: `Could not confirm replacement of ${destinationPath}. Close other open windows and try again.`,
			};
		}
		if (!confirmed) {
			return {
				status: 'cancelled',
				destinationPath,
				rowCount: result.rowCount,
				skippedCount,
				message: `Export cancelled. ${destinationPath} was not replaced.`,
			};
		}
	}

	try {
		await writeFile(app, destinationPath, result.tsv, {
			overwriteExisting: existing instanceof TFile,
		});
	} catch {
		return {
			status: 'failed',
			destinationPath,
			rowCount: result.rowCount,
			skippedCount,
			message: existing instanceof TFile
				? `Could not replace ${destinationPath}. Check that the file is writable, then try again.`
				: `Could not create ${destinationPath}. Check that the destination is writable and does not already exist, then try again.`,
		};
	}

	return {
		status: 'written',
		destinationPath,
		rowCount: result.rowCount,
		skippedCount,
		message: `Exported ${result.rowCount} typed mapping${result.rowCount === 1 ? '' : 's'} to ${destinationPath}.${skippedSuffix(skippedCount)}`,
	};
}
