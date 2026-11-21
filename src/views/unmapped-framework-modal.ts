import { ButtonComponent, Modal, Setting, TFile } from 'obsidian';
import { loadUnmappedFrameworkReport, UNMAPPED_REPORT_NAME, type FrameworkCoverage } from './unmapped-framework-report';

const PAGE = 50;
export class UnmappedFrameworkModal extends Modal {
	private closed = false;
	async onOpen(): Promise<void> {
		this.closed = false;
		this.setTitle(UNMAPPED_REPORT_NAME);
		this.contentEl.setText('Checking framework entries and crosswalks…');
		try {
			const groups = await loadUnmappedFrameworkReport(this.app);
			if (this.closed) return;
			this.contentEl.empty();
			if (!groups.length) { this.contentEl.setText('No installed framework entries found. Import a framework, then run this report again.'); return; }
			const clear = groups.filter(g => !g.mapped).length;
			const partial = groups.filter(g => g.mapped && g.unmapped.length).length;
			this.contentEl.createEl('p', { text: `${clear} frameworks with no crosswalk to another installed framework. ${partial} partially mapped. ${groups.length - clear - partial} fully mapped.` });
			this.contentEl.createEl('p', { text: 'A crosswalk counts in either direction. Parent links and evidence do not count. Hubs and facets are labeled separately from concepts.' });
			const details = this.contentEl.createDiv();
			const picker = new Setting(this.contentEl).setName('Framework').addDropdown(select => {
				for (const g of groups) select.addOption(g.framework, `${g.framework}: ${g.unmapped.length} of ${g.total} unmapped`);
				select.onChange(value => { const g = groups.find(item => item.framework === value); if (g) this.showEntries(details, g, 0); });
			});
			this.contentEl.insertBefore(picker.settingEl, details);
			this.showEntries(details, groups[0], 0);
		} catch (error) {
			if (this.closed) return;
			this.contentEl.setText(`No coverage results. ${error instanceof Error ? error.message : 'The vault could not be read.'} Check the vault and reopen this report.`);
		}
	}
	onClose(): void { this.closed = true; this.contentEl.empty(); }
	private showEntries(el: HTMLElement, group: FrameworkCoverage, offset: number): void {
		el.empty();
		if (!group.unmapped.length) { el.createEl('p', { text: 'Every entry in this framework has a recorded crosswalk to another installed framework.' }); return; }
		const end = Math.min(offset + PAGE, group.unmapped.length);
		el.createEl('p', { text: `${group.framework}: showing ${offset + 1}–${end} of ${group.unmapped.length} unmapped entries.` });
		const list = el.createEl('ul');
		for (const entry of group.unmapped.slice(offset, end)) {
			const li = list.createEl('li');
			new ButtonComponent(li).setButtonText(entry.id).setTooltip(entry.path).onClick(async () => {
				const file = this.app.vault.getAbstractFileByPath(entry.path);
				if (file instanceof TFile) { await this.app.workspace.getLeaf(false).openFile(file); this.close(); }
				else li.createSpan({ text: ' Note moved. Reopen the report to refresh.' });
			});
			if (entry.kind !== 'concept') li.createSpan({ text: ` (${entry.kind})` });
			if (entry.missingCounterpart) li.createSpan({ text: ' (crosswalk target not installed)' });
		}
		if (offset || end < group.unmapped.length) new Setting(el)
			.addButton(b => b.setButtonText('Previous').setDisabled(!offset).onClick(() => this.showEntries(el, group, offset - PAGE)))
			.addButton(b => b.setButtonText('Next').setDisabled(end === group.unmapped.length).onClick(() => this.showEntries(el, group, end)));
	}
}
