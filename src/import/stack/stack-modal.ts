/** Two-screen stack setup preview. Import and recognition deliberately remain unavailable. */
import { App, Modal, Notice, Setting } from 'obsidian';
import { MAPPING_PRESETS } from '../recipe-registry';
import {
	CONNECTOR_ONTOLOGY, CONNECTOR_REASON, DEFAULT_STACK_SELECTION,
	activeMappings, checklistPlainText, checklistRows, frameworkChoices, frameworkSlots,
	type StackSelection,
} from './stack-model';

export class StackSetupModal extends Modal {
	private stackSelection: StackSelection = {
		...DEFAULT_STACK_SELECTION, chosen: [...DEFAULT_STACK_SELECTION.chosen], optionalMappings: [],
	};
	private screen: 'picker' | 'checklist' = 'picker';

	constructor(app: App) {
		super(app);
		this.modalEl.addClass('crosswalker-stack-modal');
	}

	onOpen(): void { this.render(); }
	onClose(): void { this.contentEl.empty(); }

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('crosswalker-stack-content');
		if (this.screen === 'picker') this.renderPicker(root);
		else this.renderChecklist(root);
	}

	private renderPicker(root: HTMLElement): void {
		root.createEl('h2', { text: 'Set up a framework stack' });
		root.createEl('p', { text: 'Pick the frameworks your team works with. Crosswalker adds the mappings that connect them.' });
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		scroll.createEl('h3', { text: 'Frameworks' });
		const slots = frameworkSlots(this.stackSelection);
		const chosen = new Set(this.stackSelection.chosen);
		for (const entry of frameworkChoices()) {
			const isConnector = slots.some((slot) => slot.ontology === entry.ontology && slot.role === 'connector');
			const row = scroll.createEl('label', { cls: 'crosswalker-stack-choice' + (isConnector ? ' is-connector' : '') });
			const checkbox = row.createEl('input', { type: 'checkbox', attr: { 'data-ontology': entry.ontology } });
			checkbox.checked = chosen.has(entry.ontology) || isConnector;
			checkbox.addEventListener('change', () => {
				if (entry.ontology === CONNECTOR_ONTOLOGY && isConnector && !checkbox.checked) {
					this.stackSelection.connectorExcluded = true;
				} else {
					const next = new Set(this.stackSelection.chosen);
					if (checkbox.checked) next.add(entry.ontology);
					else next.delete(entry.ontology);
					this.stackSelection.chosen = [...next];
					if (entry.ontology === CONNECTOR_ONTOLOGY && checkbox.checked) this.stackSelection.connectorExcluded = false;
					if (entry.ontology === 'cri-profile' && !checkbox.checked) this.stackSelection.connectorExcluded = false;
				}
				this.render();
			});
			const copy = row.createSpan({ cls: 'crosswalker-stack-choice-copy' });
			copy.createSpan({ cls: 'crosswalker-stack-choice-title', text: entry.label });
			if (isConnector) copy.createSpan({ cls: 'crosswalker-stack-muted', text: CONNECTOR_REASON });
			else if (entry.sourceLink?.note) copy.createSpan({ cls: 'crosswalker-stack-muted', text: entry.sourceLink.note });
		}
		scroll.createEl('h3', { text: 'Connections this stack will import' });
		const mappings = activeMappings(this.stackSelection);
		const endpoints = new Set(slots.map((slot) => slot.ontology));
		if (!mappings.length) scroll.createEl('p', { cls: 'crosswalker-stack-muted', text: 'Choose two connected frameworks to see their mappings.' });
		for (const mapping of mappings) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-connection' });
			row.createSpan({ text: mapping.label });
			row.createSpan({ cls: 'crosswalker-stack-muted', text: mapping.source });
			if (mapping.versionNote) row.createSpan({ cls: 'crosswalker-stack-muted', text: mapping.versionNote });
		}
		if (chosen.has('cri-profile') && chosen.has('nist-800-53') && !endpoints.has(CONNECTOR_ONTOLOGY)) {
			// NIST and CSF are publisher acronyms, not title-case UI copy.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			scroll.createEl('p', { cls: 'crosswalker-stack-warning', text: 'This profile will not connect to NIST 800-53 through CSF 2.0; tick the connector to restore that route.' });
		}
		const optional = MAPPING_PRESETS.filter((mapping) => mapping.optional && endpoints.has(mapping.from) && endpoints.has(mapping.to));
		if (optional.length) {
			scroll.createEl('h3', { text: 'Optional local mappings' });
			for (const mapping of optional) {
				const row = scroll.createEl('label', { cls: 'crosswalker-stack-choice' });
				const input = row.createEl('input', { type: 'checkbox', attr: { 'data-mapping': mapping.id } });
				input.checked = this.stackSelection.optionalMappings.includes(mapping.id);
				input.addEventListener('change', () => {
					this.stackSelection.optionalMappings = input.checked
						? [...this.stackSelection.optionalMappings, mapping.id]
						: this.stackSelection.optionalMappings.filter((id) => id !== mapping.id);
					this.render();
				});
				const copy = row.createSpan({ cls: 'crosswalker-stack-choice-copy' });
				copy.createSpan({ cls: 'crosswalker-stack-choice-title', text: mapping.label });
				copy.createSpan({ cls: 'crosswalker-stack-muted', text: mapping.source });
			}
		}
		new Setting(scroll).setName('Detail').setDesc('This choice will apply to all frameworks when importing becomes available.')
			.addDropdown((dropdown) => dropdown.addOption('max', 'Everything as notes')
				.addOption('top-levels', 'Notes for top levels only')
				.setValue(this.stackSelection.detail).onChange((value) => { this.stackSelection.detail = value as StackSelection['detail']; }));
		const footer = root.createDiv({ cls: 'crosswalker-stack-footer' });
		new Setting(footer).addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('Next: download checklist').setCta()
				.setDisabled(slots.length === 0).onClick(() => { this.screen = 'checklist'; this.render(); }));
	}

	private renderChecklist(root: HTMLElement): void {
		root.createEl('h2', { text: 'Download these files' });
		root.createEl('p', { text: 'Save publisher files in any vault folder. Mappings marked built in or from file need no additional download.' });
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		const rows = checklistRows(this.stackSelection);
		rows.forEach((item, index) => {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-checklist-row', attr: { 'data-slot': item.id } });
			row.createSpan({ cls: 'crosswalker-stack-number', text: String(index + 1) });
			const body = row.createDiv({ cls: 'crosswalker-stack-checklist-body' });
			body.createDiv({ cls: 'crosswalker-stack-choice-title', text: item.label + (item.kind === 'framework' && item.role === 'connector' ? ' (connector)' : '') });
			body.createDiv({ cls: 'crosswalker-stack-muted', text: item.expectedFile });
			if (item.kind === 'mapping' ? item.mappingKind === 'download' : !!item.source && !item.source.startsWith('Get the file')) {
				body.createDiv({ cls: 'crosswalker-stack-muted', text: item.source });
			}
			if (item.licenceNote) body.createDiv({ cls: 'crosswalker-stack-muted', text: item.licenceNote });
			if (item.versionNote) body.createDiv({ cls: 'crosswalker-stack-muted', text: item.versionNote });
			if (item.publisherLink) row.createEl('a', {
				cls: 'crosswalker-stack-publisher', text: item.publisherLink.label,
				attr: { href: item.publisherLink.url, target: '_blank', rel: 'noopener noreferrer' },
			});
			else row.createSpan({ cls: 'crosswalker-stack-muted crosswalker-stack-source', text: item.kind === 'mapping' && item.mappingKind === 'built-in' ? 'Built in' : 'From file above' });
		});
		const footer = root.createDiv({ cls: 'crosswalker-stack-footer' });
		const buttons = new Setting(footer);
		buttons.addButton((button) => button.setButtonText('Copy checklist').onClick(async () => {
			try {
				await navigator.clipboard.writeText(checklistPlainText(rows));
				new Notice('Checklist copied as plain text.');
			} catch {
				new Notice('Clipboard access failed. Check clipboard permissions and try again.');
			}
		}));
		buttons.addButton((button) => button.setButtonText('Back').onClick(() => { this.screen = 'picker'; this.render(); }));
		buttons.addButton((button) => button.setButtonText('Next: add the files').setDisabled(true));
		footer.createDiv({ cls: 'crosswalker-stack-muted', text: 'Adding and recognizing files comes in the next step. No files have been imported.' });
	}
}
