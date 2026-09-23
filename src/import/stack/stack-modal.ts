/** Framework stack picker, recognition, review and sequential framework import. */
import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { computeSourceByteDigest } from '../../generation/hash';
import { discoverImportSets, settleVaultIndex } from '../../generation/import-set';
import { outputRootPath } from '../../settings/folder-settings';
import { MAPPING_PRESETS } from '../recipe-registry';
import { ImportWizardModal, recognizedDestination } from '../import-wizard';
import { runRecognizedImport } from '../run-recognized-import';
import { peekXLSXBytes } from '../parsers/xlsx-parser';
import { peekCSV, peekJSON } from '../vault-source-scan';
import { LARGE_FILE_BYTES } from '../vault-source-scan-runner';
import { recognizeStackSources, type StackCandidate, type StackRecognition, type StackSource } from './stack-recognize';
import { importMappingSlots, reconnectMappings, stackMappingDependencies, type CompletedMapping } from './stack-run';
import {
	CONNECTOR_ONTOLOGY, CONNECTOR_REASON, DEFAULT_STACK_SELECTION,
	activeMappings, checklistPlainText, checklistRows, frameworkChoices, frameworkSlots,
	type StackSelection,
} from './stack-model';

export class StackSetupModal extends Modal {
	private stackSelection: StackSelection = {
		...DEFAULT_STACK_SELECTION, chosen: [...DEFAULT_STACK_SELECTION.chosen], optionalMappings: [],
	};
	private screen: 'picker' | 'checklist' | 'recognize' | 'review' | 'complete' = 'picker';
	private sourceFiles = new Map<string, TFile>();
	private sourceViews: StackSource[] = [];
	private recognition: StackRecognition = recognizeStackSources([], []);
	private folder = '';
	private busy = false;
	private error = '';
	private largeSources = new Set<string>();
	private completed: { label: string; created: number; setId: string | null; folder: string }[] = [];
	private discoveredSets: number | null = null;
	private mappingSets: CompletedMapping[] = [];
	private discoveredCounts = new Map<string, number>();

	constructor(app: App, private plugin: CrosswalkerPlugin) {
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
		else if (this.screen === 'checklist') this.renderChecklist(root);
		else if (this.screen === 'recognize') this.renderRecognition(root);
		else if (this.screen === 'review') this.renderReview(root);
		else this.renderComplete(root);
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
		new Setting(scroll).setName('Detail').setDesc('Granularity controls are not available in this import yet. Current bundled recipes determine note detail.')
			.addDropdown((dropdown) => dropdown.addOption('max', 'Everything as notes')
				.addOption('top-levels', 'Notes for top levels only')
				.setValue(this.stackSelection.detail).setDisabled(true));
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
		buttons.addButton((button) => button.setButtonText('Next: add the files').setCta()
			.onClick(() => { this.screen = 'recognize'; this.render(); }));
	}

	private refreshRecognition(): void {
		this.recognition = recognizeStackSources(this.sourceViews, frameworkSlots(this.stackSelection), undefined, this.stackSelection);
		this.render();
	}

	private async addVaultFile(file: TFile): Promise<void> {
		if (!['csv', 'tsv', 'xlsx', 'xls', 'json'].includes(file.extension.toLowerCase())) return;
		try {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (bytes.byteLength > LARGE_FILE_BYTES) this.largeSources.add(file.name);
			const peeks = file.extension === 'xlsx' || file.extension === 'xls'
				? peekXLSXBytes(bytes)
				: file.extension === 'json' ? peekJSON(new TextDecoder().decode(bytes))
					: peekCSV(new TextDecoder().decode(bytes));
			this.sourceFiles.set(file.path, file);
			this.sourceViews = [...this.sourceViews.filter((view) => view.path !== file.path),
				{ path: file.path, name: file.name, peeks }];
			this.error = '';
		} catch {
			this.error = `Could not read ${file.name}: its sheet or file format could not be parsed. Choose another publisher export or repair the file and try again.`;
		}
		this.refreshRecognition();
	}

	private async addExternalFiles(files: FileList | File[]): Promise<void> {
		this.busy = true;
		for (const file of Array.from(files)) {
			if (!/\.(csv|tsv|xlsx|xls|json)$/i.test(file.name)) continue;
			try {
				const folder = 'Sources/Stack files';
				if (!this.app.vault.getAbstractFileByPath('Sources')) await this.app.vault.createFolder('Sources');
				if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
				let name = file.name;
				let attempt = 1;
				while (this.app.vault.getAbstractFileByPath(`${folder}/${name}`)) {
					name = file.name.replace(/(\.[^.]+)$/, `-${attempt++}$1`);
				}
				const saved = await this.app.vault.createBinary(`${folder}/${name}`, await file.arrayBuffer());
				await this.addVaultFile(saved);
			} catch {
				this.error = `Could not add ${file.name} to the vault. Check that Sources/Stack files is writable, then try again.`;
			}
		}
		this.busy = false;
		this.refreshRecognition();
	}

	private renderRecognition(root: HTMLElement): void {
		root.createEl('h2', { text: 'Add the files' });
		root.createEl('p', { text: 'Choose files or a vault folder. A file fills a slot only when its columns match confidently.' });
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		const drop = scroll.createDiv({ cls: 'crosswalker-stack-drop' });
		drop.createSpan({ text: 'Drop files here, or ' });
		const picker = drop.createEl('input', { type: 'file', attr: { multiple: '', accept: '.csv,.tsv,.xlsx,.xls,.json', 'aria-label': 'Choose files' } });
		picker.addEventListener('change', () => { if (picker.files) void this.addExternalFiles(picker.files); });
		drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.addClass('is-dragging'); });
		drop.addEventListener('dragleave', () => drop.removeClass('is-dragging'));
		drop.addEventListener('drop', (event) => {
			event.preventDefault(); drop.removeClass('is-dragging');
			if (event.dataTransfer?.files.length) void this.addExternalFiles(event.dataTransfer.files);
		});
		new Setting(scroll).setName('Vault folder').setDesc('Read supported files directly from this folder; no source files are moved.')
			.addText((text) => text.setPlaceholder('Sources').setValue(this.folder).onChange((value) => { this.folder = value.trim(); }))
			.addButton((button) => button.setButtonText('Choose folder').onClick(async () => {
				const prefix = this.folder.replace(/^\/+|\/+$/g, '');
				if (!prefix || !this.app.vault.getAbstractFileByPath(prefix)) {
					this.error = 'Vault folder not found. Enter an existing folder, then choose it again.'; this.render(); return;
				}
				const found = this.app.vault.getFiles().filter((file) => file.path.startsWith(`${prefix}/`));
				if (!found.length) { this.error = 'No files found in that folder. Choose a folder containing publisher exports.'; this.render(); return; }
				for (const file of found.slice(0, 500)) await this.addVaultFile(file);
				if (found.length > 500) this.error = 'Only the first 500 files were checked. Move the source exports to a smaller folder and choose it again.';
				this.refreshRecognition();
			}));
		if (this.error) scroll.createEl('p', { cls: 'crosswalker-stack-warning', text: this.error });
		if (this.largeSources.size) scroll.createEl('p', { cls: 'crosswalker-stack-muted',
			text: `${[...this.largeSources].join(', ')} exceeds the 5 MB header-scan limit. The full file was read to identify its sheet and columns.` });
		for (const slot of frameworkSlots(this.stackSelection)) {
			const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
			const maybe = this.recognition.mightMatch.find((item) => item.slot.ontology === slot.ontology);
			const wrong = this.recognition.wrongFiles.find((item) => item.slot?.ontology === slot.ontology);
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-slot': slot.ontology } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: slot.entry.label });
			row.createDiv({ text: fill ? `${fill.source.name} · Recognized (${fill.score})` :
				maybe ? `${maybe.source.name} · Might match (${maybe.score}; ${maybe.matched} of ${maybe.expected} columns)` :
				wrong ? `${wrong.source.name} · Wrong file` : 'Missing' });
			if (fill?.table) row.createDiv({ cls: 'crosswalker-stack-muted', text: `Sheet ${fill.table}, header row ${fill.headerRow + 1}` });
			if (wrong) row.createDiv({ cls: 'crosswalker-stack-warning', text: wrong.message });
			if (maybe) {
				new Setting(row).addButton((button) => button.setButtonText('Use anyway').onClick(() => {
					this.recognition.mightMatch = this.recognition.mightMatch.filter((item) => item !== maybe);
					this.recognition.fills.push(maybe); this.render();
				}));
			}
		}
		for (const ambiguity of this.recognition.ambiguities) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-warning' });
			row.createSpan({ text: ambiguity.message });
			const replacement = ambiguity.candidates[ambiguity.candidates.length - 1];
			new Setting(row).addButton((button) => button.setButtonText('Use this file').onClick(() => {
					this.sourceViews = this.sourceViews.filter((view) => view.path !== ambiguity.candidates[0].source.path);
					this.refreshRecognition();
				})).addButton((button) => button.setButtonText('Keep first file').onClick(() => {
					this.sourceViews = this.sourceViews.filter((view) => view.path !== replacement.source.path);
					this.refreshRecognition();
				}));
		}
		for (const outside of this.recognition.notInStack) scroll.createEl('p', { cls: 'crosswalker-stack-muted',
			text: `Not in this stack: ${outside.source.name} looks like ${outside.entry.label}. Add its framework in the picker or ignore this file.` });
		for (const wrong of this.recognition.wrongFiles.filter((item) => !item.slot))
			scroll.createEl('p', { cls: 'crosswalker-stack-warning', text: wrong.message });
		for (const mapping of activeMappings(this.stackSelection)) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-mapping': mapping.id } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: mapping.label });
			const mappingFile = this.recognition.mappingFills.find((fill) => fill.mapping.id === mapping.id);
			row.createDiv({ cls: 'crosswalker-stack-muted', text: mappingFile ? `${mappingFile.source.name} · Ready (${mappingFile.table})` :
				mapping.kind === 'built-in' ? 'Ready (built in)' :
				mapping.kind === 'from-slot' && this.recognition.fills.some((fill) => fill.slot.ontology === mapping.from)
					? 'Ready (from framework file)' : 'Missing mapping file' });
		}
		const footer = root.createDiv({ cls: 'crosswalker-stack-footer' });
		new Setting(footer).addButton((button) => button.setButtonText('Back').onClick(() => { this.screen = 'checklist'; this.render(); }))
			.addButton((button) => button.setButtonText('Next: review').setCta()
				.setDisabled(this.busy || this.recognition.fills.length !== frameworkSlots(this.stackSelection).length)
				.onClick(() => { this.screen = 'review'; this.render(); }));
	}

	/** Choose a free address for a NEW set; never infer set identity from this path. */
	private destinationFor(candidate: StackCandidate): string {
		const preferred = recognizedDestination(candidate.slot.entry, outputRootPath(this.plugin.settings))
			?? outputRootPath(this.plugin.settings);
		if (!this.app.vault.getAbstractFileByPath(preferred)) return preferred;
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(`${preferred} (new ${suffix})`)) suffix++;
		return `${preferred} (new ${suffix})`;
	}

	private renderReview(root: HTMLElement): void {
		root.createEl('h2', { text: 'Review before import' });
		root.createEl('p', { text: 'Frameworks import first, followed by each ready mapping. Every mapping gets a new import set. Missing mapping files stop the run before import.' });
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		for (const slot of frameworkSlots(this.stackSelection)) {
			const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
			if (!fill) continue;
			const rootPath = this.destinationFor(fill);
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-slot': slot.ontology } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: slot.entry.label });
			row.createDiv({ text: `${slot.entry.description} Source: ${fill.source.name}. Lands in ${rootPath}.` });
			row.createDiv({ cls: 'crosswalker-stack-muted', text: 'Import set: New set' });
			new Setting(row).addButton((button) => button.setButtonText('Check for refresh').onClick(async () => {
				const file = this.sourceFiles.get(fill.source.path);
				if (!file) return;
				if (await settleVaultIndex(this.app) > 0) {
					row.createDiv({ cls: 'crosswalker-stack-warning', text: 'Vault index is still loading. Wait a moment, then check for refresh again.' });
					return;
				}
				const digest = computeSourceByteDigest(new Uint8Array(await this.app.vault.readBinary(file)));
				const known = (await discoverImportSets(this.app)).filter((set) =>
					set.sources.some((source) => source.sourceHash === digest));
				const offer = row.querySelector('.crosswalker-stack-refresh-offer') ?? row.createDiv({ cls: 'crosswalker-stack-refresh-offer' });
				if (known.length) {
					offer.textContent = `Looks like set ${known[0].id}. New set remains selected. Refresh requires choosing that set in Import structured data.`;
					new Setting(row).addButton((next) => next.setButtonText('Open import wizard to refresh').onClick(() => {
						this.close(); new ImportWizardModal(this.app, this.plugin).open();
					}));
				} else offer.textContent = 'No import set with this source fingerprint was found. Import as a new set.';
			}));
		}
		for (const mapping of activeMappings(this.stackSelection)) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-mapping': mapping.id } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: mapping.label });
			row.createDiv({ cls: 'crosswalker-stack-muted', text: mapping.kind === 'built-in' || mapping.kind === 'from-slot' || this.recognition.mappingFills.some((fill) => fill.mapping.id === mapping.id)
				? 'Ready' : 'Missing mapping file. Add the publisher export before importing.' });
		}
		if (this.error) scroll.createDiv({ cls: 'crosswalker-stack-warning', text: this.error });
		if (this.completed.length) scroll.createDiv({ text: `${this.completed.length} framework sets imported. Remaining mappings will run next.` });
		const footer = root.createDiv({ cls: 'crosswalker-stack-footer' });
		new Setting(footer).addButton((button) => button.setButtonText('Back').setDisabled(this.busy)
			.onClick(() => { this.screen = 'recognize'; this.render(); }))
			.addButton((button) => button.setButtonText(this.completed.length ? 'Retry remaining' : 'Import stack').setCta()
				.setDisabled(this.busy).onClick(() => { void this.importFrameworks(); }));
	}

	private async importFrameworks(): Promise<void> {
		const missing = activeMappings(this.stackSelection).find((mapping) => mapping.kind === 'download' &&
			!this.mappingSets.some((item) => item.id === mapping.id) &&
			!this.recognition.mappingFills.some((fill) => fill.mapping.id === mapping.id && this.sourceFiles.has(fill.source.path)));
		if (missing) {
			this.error = `${missing.label} has no recognized source file. Add the publisher mapping export before importing the frameworks.`;
			this.render(); return;
		}
		this.busy = true; this.error = ''; this.render();
		for (const slot of frameworkSlots(this.stackSelection)) {
			if (this.completed.some((item) => item.label === slot.entry.label)) continue;
			const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
			const file = fill && this.sourceFiles.get(fill.source.path);
			if (!fill || !file) { this.error = `${slot.entry.label} has no source file. Add its publisher export, then try again.`; break; }
			try {
				const outcome = await runRecognizedImport(this.app, this.plugin, {
					file, entry: slot.entry, table: fill.table, headerRow: fill.headerRow,
					destination: this.destinationFor(fill),
				});
				if (!outcome.ok || !outcome.importSetId) {
					this.error = `${slot.entry.label} could not be imported. ${outcome.errors.some((message) => message.includes('still indexing'))
						? 'Wait for the vault index to finish, then import again.'
						: 'Check that the file has the expected sheet and columns, and that the destination is writable. Inspect the destination for any notes already created, then try again.'} Remaining frameworks were not started.`;
					break;
				}
				this.completed.push({ label: slot.entry.label, created: outcome.created, setId: outcome.importSetId, folder: outcome.destination });
				this.plugin.debug.info('stack', 'framework', `Stack framework: ${slot.ontology}`);
			} catch {
				this.error = `${slot.entry.label} could not be imported. Check the source and destination, then try again. Remaining frameworks were not started.`;
				break;
			}
			this.render();
		}
		if (!this.error) {
			try {
				this.mappingSets = await importMappingSlots(activeMappings(this.stackSelection), this.recognition.mappingFills,
					this.sourceFiles, { ...stackMappingDependencies(this.app, this.plugin),
						onCompleted: (record) => { this.mappingSets.push(record); } }, this.mappingSets);
			} catch (err) {
				this.error = err instanceof Error ? err.message : 'A mapping import stopped. Check the mapping file and vault permissions, then try again.';
			}
		}
		this.busy = false;
		if (!this.error) {
			const ids = new Set([...this.completed.map((item) => item.setId), ...this.mappingSets.map((item) => item.setId)]);
			try {
				// Scoped discovery reads freshly written notes when metadata indexing lags.
				const roots = new Set([...this.completed.map((item) => item.folder), ...this.mappingSets.map((item) => item.folder)]);
				const discovered = (await Promise.all([...roots].map((folder) => discoverImportSets(this.app, folder))))
					.flat().filter((set) => ids.has(set.id));
				const byId = new Map(discovered.map((set) => [set.id, set.noteCount]));
				this.discoveredSets = byId.size === ids.size ? byId.size : null;
				this.discoveredCounts = byId;
			} catch { this.discoveredSets = null; }
			this.screen = 'complete';
		}
		this.render();
	}

	private renderComplete(root: HTMLElement): void {
		root.createEl('h2', { text: 'Framework stack imported' });
		root.createEl('p', { text: `${this.completed.length} framework sets and ${this.mappingSets.length} mapping sets. ${this.discoveredSets === null ? 'Vault index is still loading; set counts cannot be confirmed yet.' : `${this.discoveredSets} sets confirmed in the vault.`}` });
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		scroll.createEl('h3', { text: 'Frameworks' });
		for (const item of this.completed) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result' });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: item.label });
			const count = item.setId ? this.discoveredCounts.get(item.setId) : undefined;
			row.createDiv({ cls: 'crosswalker-stack-muted', text: `${count ?? 'Count pending'} ${count === 1 ? 'note' : 'notes'} · Set ${item.setId}` });
		}
		scroll.createEl('h3', { text: 'Mappings' });
		for (const item of this.mappingSets) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result' });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: item.label });
			const count = this.discoveredCounts.get(item.setId) ?? item.noteCount;
			row.createDiv({ cls: 'crosswalker-stack-muted', text: `${count} edge ${count === 1 ? 'note' : 'notes'} · Set ${item.setId}` });
			for (const message of item.unresolved) row.createDiv({ cls: 'crosswalker-stack-warning', text: message });
		}
		if (this.error) scroll.createDiv({ cls: 'crosswalker-stack-warning', text: this.error });
		new Setting(root.createDiv({ cls: 'crosswalker-stack-footer' }))
			.addButton((button) => button.setButtonText('Reconnect mappings').setDisabled(this.busy || !this.mappingSets.length)
				.onClick(async () => {
					this.busy = true; this.error = ''; this.render();
					try {
						this.mappingSets = await reconnectMappings(this.mappingSets, stackMappingDependencies(this.app, this.plugin));
						const sets = await discoverImportSets(this.app);
						this.discoveredCounts = new Map(sets.map((set) => [set.id, set.noteCount]));
					} catch (err) {
						this.error = err instanceof Error ? err.message : 'Mappings could not reconnect. Check the source files and vault permissions, then try again.';
					}
					this.busy = false; this.render();
				}))
			.addButton((button) => button.setButtonText('Done').onClick(() => this.close()));
	}
}
