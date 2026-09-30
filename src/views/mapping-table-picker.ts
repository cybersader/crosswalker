/**
 * mapping-table-picker.ts — choose a mapping table to review.
 *
 * Slice 5 of the mapping table form (2026-09-30). The "Review a mapping table"
 * command lists every `*.mapping-table.tsv` in the vault. With none, it says
 * why and how to get one instead of opening an empty picker.
 */

import { App, FuzzySuggestModal, Notice, TFile } from 'obsidian';
import { MAPPING_TABLE_SUFFIX } from '../mappings/mapping-table-reader';

export class MappingTablePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder('Choose a mapping table to review');
	}

	/** Open the picker, or explain in a notice when the vault holds no mapping table. */
	openOrExplain(): void {
		if (!this.getItems().length) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- names the Store as control, its Table choice and the Installed stacks panel
			new Notice('This vault has no mapping tables. Import a mapping with Store as set to Table, or convert a mapping set to a table from Installed stacks.', 8000);
			return;
		}
		this.open();
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles()
			.filter((file) => file.path.endsWith(MAPPING_TABLE_SUFFIX))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}
