/**
 * folder-picker-modal.ts — fuzzy-search modal over every folder in the vault.
 *
 * The export commands' "choose a folder" step. Mirrors src/ui/
 * vault-file-picker.ts's `VaultImportFilePicker` pattern (a FuzzySuggestModal
 * over a flat list, sorted by path) but over TFolder instead of importable
 * files. Lives under src/export/ (not src/ui/) because it's export-specific
 * UI, keeping this milestone's surface self-contained per the sibling-work
 * boundary (settings UI is owned elsewhere).
 */

import { App, FuzzySuggestModal, TFolder } from 'obsidian';

export class ExportFolderPickerModal extends FuzzySuggestModal<TFolder> {
	private onChoose: (folder: TFolder) => void;

	constructor(app: App, onChoose: (folder: TFolder) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('Choose a folder to export');
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder): void => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(this.app.vault.getRoot());
		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/ (vault root)' : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}
