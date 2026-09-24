/** Framework stack picker, recognition, review and sequential framework import. */
import { plural } from '../../utils/plural';
import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { computeSourceByteDigest } from '../../generation/hash';
import { discoverImportSets, settleVaultIndex } from '../../generation/import-set';
import { outputRootPath } from '../../settings/folder-settings';
import { MAPPING_PRESETS } from '../recipe-registry';
import { ImportWizardModal, recognizedDestination, refreshRootProblem } from '../import-wizard';
import { runRecognizedImport } from '../run-recognized-import';
import { peekXLSXBytes } from '../parsers/xlsx-parser';
import { peekCSV, peekJSON } from '../vault-source-scan';
import { LARGE_FILE_BYTES } from '../vault-source-scan-runner';
import { recognizeStackSources, type StackCandidate, type StackRecognition, type StackSource } from './stack-recognize';
import { builtInMappingTsv, importMappingSlots, needsLateCrosswalkRefresh, reconnectMappings, stackMappingDependencies, waitForIndexedDestination, type CompletedMapping } from './stack-run';
import { frameworkImportError } from './stack-errors';
import { sssomRecipeDigest } from '../sssom-importer';
import { checkpointFrameworkOutcome, fromDefinition, mappingKey, replaceStackDefinition, slotRunChoices, toDefinition,
	type RunChoice, type StackDefinition, type StackRunRecord, type SlotRunFact } from './stack-persistence';
import type { DiscoveredImportSet } from '../../generation/import-set';
import { STACK_PRESETS, type MappingPreset } from '../recipe-registry';
import {
	CONNECTOR_ONTOLOGY, CONNECTOR_REASON, DEFAULT_STACK_SELECTION,
	activeMappings, checklistPlainText, checklistRows, frameworkChoices, frameworkSlots,
	stackDetailDescription, slotDetailSummary, stackSourceWhere, stackRecipeHash, refreshRecipeProblem,
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
	private indexing = false;
	private error = '';
	private largeSources = new Set<string>();
	private completed: { label: string; created: number; upToDate: number; crosswalkLinks: number; crosswalkLinksUpToDate: number; setId: string | null; folder: string; warnings: string[] }[] = [];
	private discoveredSets: number | null = null;
	private mappingSets: CompletedMapping[] = [];
	private discoveredCounts = new Map<string, number>();
	private definition: StackDefinition | null;
	private readonly revisiting: boolean;
	private stackLabel: string;
	private knownSets = new Map<string, DiscoveredImportSet>();
	private sourceDigests = new Map<string, string>();
	private choices = new Map<string, RunChoice>();
	private runWarnings: string[] = [];
	private skipped = 0;
	private pendingFrameworkLinks: Array<{ slot: ReturnType<typeof frameworkSlots>[number]; fill: StackCandidate; file: TFile; setId: string; folder: string }> = [];

	constructor(app: App, private plugin: CrosswalkerPlugin, definition?: StackDefinition, private onChanged?: () => void) {
		super(app);
		this.modalEl.addClass('crosswalker-stack-modal');
		this.definition = definition ?? null;
		this.revisiting = !!definition;
		this.stackLabel = definition?.label ?? STACK_PRESETS[0].label;
		if (definition) {
			this.stackSelection = fromDefinition(definition);
			this.screen = 'recognize';
		}
	}

	onOpen(): void { this.render(); }
	onClose(): void { this.contentEl.empty(); this.onChanged?.(); }

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
		new Setting(scroll).setName('Detail').setDesc(stackDetailDescription(this.stackSelection))
			.addDropdown((dropdown) => dropdown.addOption('max', 'Everything as notes')
				.addOption('top-levels', 'Notes for top levels only')
				.setValue(this.stackSelection.detail).onChange((value) => {
				this.stackSelection.detail = value as StackSelection['detail']; this.render();
			}));
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
			this.sourceDigests.set(file.path, computeSourceByteDigest(bytes));
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
				.setDisabled(this.busy || (!this.revisiting && this.recognition.fills.length !== frameworkSlots(this.stackSelection).length))
				.onClick(() => { void this.openReview(); }));
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

	private get storedRun(): StackRunRecord | undefined {
		return this.plugin.settings.stackRuns.find((run) => run.stackId === this.definition?.id);
	}

	private async openReview(): Promise<void> {
		if (this.revisiting) {
			this.busy = true;
			try {
				if (await settleVaultIndex(this.app) > 0) {
					this.error = 'Vault index is still loading. Wait a moment, then review this stack again.';
					return;
				}
				this.knownSets = new Map((await discoverImportSets(this.app)).map((set) => [set.id, set]));
				this.error = '';
				this.choices.clear();
				for (const slot of frameworkSlots(this.stackSelection)) {
					const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
					const fact = this.storedRun?.slotSets[slot.entry.id];
					const set = fact && this.knownSets.get(fact.importSetId);
					const hash = stackRecipeHash(slot, this.stackSelection.detail);
					const guard = set ? refreshRootProblem(set) ?? refreshRecipeProblem(slot.entry.id, set.recipeIds, hash, set.recipeHashes) : null;
					this.choices.set(slot.entry.id, slotRunChoices(fact, !!set, fill && this.sourceDigests.get(fill.source.path), hash, guard).selected);
				}
				for (const mapping of activeMappings(this.stackSelection)) {
					if (mapping.kind === 'from-slot') continue;
					const fill = this.recognition.mappingFills.find((item) => item.mapping.id === mapping.id);
					const source = fill?.source.path;
					const digest = mapping.kind === 'built-in' ? computeSourceByteDigest(new TextEncoder().encode(builtInMappingTsv()))
						: source && this.sourceDigests.get(source);
					const hash = sssomRecipeDigest(mapping.from, mapping.to);
					const fact = this.storedRun?.mappingSets[mappingKey(mapping)];
					const set = fact && this.knownSets.get(fact.importSetId);
					const recipeId = `sssom-${mapping.from}-to-${mapping.to}`;
					const guard = set ? refreshRootProblem(set) ?? refreshRecipeProblem(recipeId, set.recipeIds, hash, set.recipeHashes) : null;
					this.choices.set(mappingKey(mapping), slotRunChoices(fact, !!set, digest, hash, guard).selected);
				}
				this.screen = 'review';
			} catch {
				this.error = 'Could not check the vault import sets. Wait for indexing or repair unreadable notes, then review again.';
			} finally { this.busy = false; this.render(); }
		} else { this.screen = 'review'; this.render(); }
	}

	private renderRunChoice(row: HTMLElement, key: string, fact: SlotRunFact | undefined, digest: string | undefined,
		hash: string, recipeId: string, available: boolean): void {
		const set = fact && this.knownSets.get(fact.importSetId);
		const guard = set ? refreshRootProblem(set) ?? refreshRecipeProblem(recipeId, set.recipeIds, hash, set.recipeHashes) : null;
		const state = slotRunChoices(fact, !!set, digest, hash, guard);
		if (state.message) row.createDiv({ cls: 'crosswalker-stack-warning', text: state.message });
		if (!available && state.selected !== 'skip') {
			row.createDiv({ cls: 'crosswalker-stack-muted', text: 'Add the source file to import this slot.' });
			return;
		}
		const selector = new Setting(row).setName('Import set');
		selector.addDropdown((dropdown) => {
			for (const mode of state.choices) dropdown.addOption(mode,
				mode === 'skip' ? 'Skip (already imported, unchanged)' : mode === 'refresh' ? `Refresh set ${fact!.importSetId}` : 'New set');
			dropdown.setValue(this.choices.get(key) ?? state.selected).onChange((mode) => this.choices.set(key, mode as RunChoice));
		});
	}

	private renderReview(root: HTMLElement): void {
		root.createEl('h2', { text: 'Review before import' });
		root.createEl('p', { text: this.revisiting ? 'Check each source and import-set choice. Refresh is never selected automatically.'
			: 'Frameworks import first, followed by each ready mapping. Every mapping gets a new import set. Missing mapping files stop the run before import.' });
		new Setting(root).setName('Stack name').addText((text) => text.setValue(this.stackLabel)
			.onChange((value) => { this.stackLabel = value; }));
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		for (const slot of frameworkSlots(this.stackSelection)) {
			const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
			if (!fill && !this.revisiting) continue;
			const rootPath = fill ? this.destinationFor(fill) : '';
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-slot': slot.ontology } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: slot.entry.label });
			row.createDiv({ text: `${slotDetailSummary(slot, this.stackSelection.detail)} ${fill ? `Source: ${fill.source.name}. Lands in ${rootPath}.` : 'No source file added.'}` });
			if (this.revisiting) {
				this.renderRunChoice(row, slot.entry.id, this.storedRun?.slotSets[slot.entry.id],
					fill && this.sourceDigests.get(fill.source.path), stackRecipeHash(slot, this.stackSelection.detail),
					slot.entry.id, !!fill);
				continue;
			}
			if (!fill) continue;
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
					const expectedHash = stackRecipeHash(slot, this.stackSelection.detail);
					const matching = known.find((set) => !refreshRecipeProblem(
						slot.entry.id, set.recipeIds, expectedHash, set.recipeHashes));
					const closest = known.find((set) => set.recipeIds.includes(slot.entry.id)) ?? known[0];
					const mismatch = refreshRecipeProblem(
						slot.entry.id, closest.recipeIds, expectedHash, closest.recipeHashes);
					offer.textContent = matching
						? `Looks like set ${matching.id}. New set remains selected. Refresh requires choosing that set in Import structured data.`
						: mismatch ?? '';
					if (matching) new Setting(row).addButton((next) => next.setButtonText('Open import wizard to refresh').onClick(() => {
						this.close(); new ImportWizardModal(this.app, this.plugin, {
								presetRecipeId: matching.recipeIds.find((id) => id === slot.entry.id)!, prefillFile: file,
							sourceWhere: stackSourceWhere(slot.ontology, this.stackSelection.detail),
							prefillBinding: { sheet: fill.table || null, headerRow: fill.headerRow, iterator: file.extension === 'json' ? fill.table : null },
						}).open();
					}));
				} else offer.textContent = 'No import set with this source fingerprint was found. Import as a new set.';
			}));
		}
		for (const mapping of activeMappings(this.stackSelection)) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result', attr: { 'data-mapping': mapping.id } });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: mapping.label });
			if (mapping.kind === 'from-slot') {
				const sourceSlot = frameworkSlots(this.stackSelection).find((slot) => slot.ontology === mapping.from);
				row.createDiv({ cls: 'crosswalker-stack-muted', text: `Comes with ${sourceSlot!.entry.label}. Not tracked separately.` });
				continue;
			}
			const fill = this.recognition.mappingFills.find((item) => item.mapping.id === mapping.id);
			const source = fill?.source.path;
			const ready = mapping.kind === 'built-in' || !!source;
			row.createDiv({ cls: 'crosswalker-stack-muted', text: ready ? 'Ready' : 'Missing mapping file. Add the publisher export before importing.' });
			if (this.revisiting) this.renderRunChoice(row, mappingKey(mapping), this.storedRun?.mappingSets[mappingKey(mapping)],
				mapping.kind === 'built-in' ? computeSourceByteDigest(new TextEncoder().encode(builtInMappingTsv()))
					: source && this.sourceDigests.get(source),
				sssomRecipeDigest(mapping.from, mapping.to),
				`sssom-${mapping.from}-to-${mapping.to}`, ready);
		}
		if (this.error) scroll.createDiv({ cls: 'crosswalker-stack-warning', text: this.error });
		if (this.indexing) scroll.createDiv({ cls: 'crosswalker-stack-muted', text: 'Waiting for the vault to index the notes just written...' });
		if (this.completed.length) scroll.createDiv({ text: `${plural(this.completed.reduce((sum, item) => sum + item.created, 0), 'framework note')} created or updated. ${plural(this.skipped, 'slot')} skipped. Remaining mappings will run next.` });
		const footer = root.createDiv({ cls: 'crosswalker-stack-footer' });
		new Setting(footer).addButton((button) => button.setButtonText('Back').setDisabled(this.busy)
			.onClick(() => { this.screen = 'recognize'; this.render(); }))
			.addButton((button) => button.setButtonText(this.completed.length ? 'Retry remaining' : 'Import stack').setCta()
				.setDisabled(this.busy).onClick(() => { void this.importFrameworks(); }));
	}

	private async saveDefinition(): Promise<boolean> {
		if (!this.stackLabel.trim()) {
			this.error = 'Stack name is empty. Enter a name before importing.';
			this.render(); return false;
		}
		const next = toDefinition(this.stackSelection, this.definition?.id, this.stackLabel.trim(), this.definition?.createdAt);
		const saved = replaceStackDefinition(this.plugin.settings.stacks, this.plugin.settings.stackRuns, next);
		this.plugin.settings.stacks = saved.stacks;
		this.plugin.settings.stackRuns = saved.stackRuns;
		await this.plugin.saveSettings();
		this.definition = next;
		return true;
	}

	private async recordFact(key: string, fact: SlotRunFact, mapping: boolean): Promise<void> {
		if (!this.definition) return;
		const previous = this.storedRun;
		const run: StackRunRecord = {
			stackId: this.definition.id, finishedAt: new Date().toISOString(), detail: this.stackSelection.detail,
			slotSets: { ...previous?.slotSets }, mappingSets: { ...previous?.mappingSets },
		};
		if (mapping) run.mappingSets[key] = fact;
		else run.slotSets[key] = fact;
		this.plugin.settings.stackRuns = [...this.plugin.settings.stackRuns.filter((entry) => entry.stackId !== run.stackId), run];
		await this.plugin.saveSettings();
	}

	private async importFrameworks(): Promise<void> {
		if (!await this.saveDefinition()) return;
		const missing = !this.revisiting && activeMappings(this.stackSelection).find((mapping) => mapping.kind === 'download' &&
			!this.mappingSets.some((item) => item.id === mapping.id) &&
			!this.recognition.mappingFills.some((fill) => fill.mapping.id === mapping.id && this.sourceFiles.has(fill.source.path)));
		if (missing) {
			this.error = `${missing.label} has no recognized source file. Add the publisher mapping export before importing the frameworks.`;
			this.render(); return;
		}
		this.skipped = this.revisiting
			? frameworkSlots(this.stackSelection).filter((slot) => this.choices.get(slot.entry.id) === 'skip'
				&& !this.completed.some((item) => item.label === slot.entry.label)).length
				+ activeMappings(this.stackSelection).filter((mapping) => mapping.kind !== 'from-slot'
					&& this.choices.get(mappingKey(mapping)) === 'skip').length
			: 0;
		this.busy = true; this.error = ''; this.runWarnings = []; this.render();
		const frameworkOrder = frameworkSlots(this.stackSelection);
		for (const [position, slot] of frameworkOrder.entries()) {
			if (this.completed.some((item) => item.label === slot.entry.label)) continue;
			const fill = this.recognition.fills.find((item) => item.slot.ontology === slot.ontology);
			const file = fill && this.sourceFiles.get(fill.source.path);
			const mode = this.revisiting ? this.choices.get(slot.entry.id) : 'new';
			if (mode === 'skip') {
				const fact = this.storedRun?.slotSets[slot.entry.id];
				this.completed.push({ label: slot.entry.label, created: 0, upToDate: 0, crosswalkLinks: 0, crosswalkLinksUpToDate: 0, setId: fact?.importSetId ?? null,
					folder: this.knownSets.get(fact?.importSetId ?? '')?.root ?? '', warnings: [] });
				continue;
			}
			if (!fill || !file) {
				if (this.revisiting) { this.runWarnings.push(`${slot.entry.label} needs its publisher file. Add the file and run again to import this slot.`); continue; }
				this.error = `${slot.entry.label} has no source file. Add its publisher export, then try again.`; break;
			}
			try {
				const fact = this.storedRun?.slotSets[slot.entry.id];
				const set = fact && this.knownSets.get(fact.importSetId);
				const sourceDigest = this.sourceDigests.get(fill.source.path);
				const recipeDigest = stackRecipeHash(slot, this.stackSelection.detail);
				const rootProblem = mode === 'refresh' ? refreshRootProblem(set) : null;
				if (rootProblem) { this.error = rootProblem; break; }
				const legal = slotRunChoices(fact, !!set, sourceDigest, recipeDigest,
					set ? refreshRootProblem(set) ?? refreshRecipeProblem(slot.entry.id, set.recipeIds, recipeDigest, set.recipeHashes) : null);
				if (this.revisiting && !legal.choices.includes(mode as RunChoice)) {
					this.error = `${slot.entry.label} import choice is no longer available. Review the stack again before importing.`; break;
				}
				const target = mode === 'refresh' ? set : undefined;
				const outcome = await runRecognizedImport(this.app, this.plugin, {
					file, entry: slot.entry, table: fill.table, headerRow: fill.headerRow,
					destination: mode === 'refresh' ? target!.root! : this.destinationFor(fill),
					...(target && fact ? { refreshSetId: fact.importSetId, overwriteMode: 'replace' as const } : {}),
					sourceWhere: stackSourceWhere(slot.ontology, this.stackSelection.detail),
				});
				if (!outcome.ok) {
					this.error = frameworkImportError(slot.entry.label, outcome.errors);
					break;
				}
				this.completed.push({ label: slot.entry.label, created: outcome.created, upToDate: outcome.upToDate, crosswalkLinks: outcome.crosswalkEdges ?? 0, crosswalkLinksUpToDate: outcome.crosswalkLinksUpToDate ?? 0, setId: outcome.importSetId, folder: outcome.destination, warnings: outcome.warnings });
				if (!await checkpointFrameworkOutcome(outcome, sourceDigest, recipeDigest, file.name,
					(fact) => this.recordFact(slot.entry.id, fact, false)))
					this.runWarnings.push(`${slot.entry.label} was imported, but its set could not be confirmed yet. Wait for vault indexing, then run again later to record it.`);
				// The next framework's set qualification reads the vault-wide metadata
				// index. Newly written notes may arrive after one `resolved` event, so
				// wait for this slot's actual output instead of treating lag as absence.
				this.indexing = true;
				this.render();
				let cold: number;
				try { cold = await waitForIndexedDestination(this.app, outcome.destination); }
				finally { this.indexing = false; this.render(); }
				if (cold > 0) {
					this.error = `${slot.entry.label} was imported, but its notes are still indexing. Wait for the vault index to finish, then retry the remaining frameworks.`;
					break;
				}
				// Inline crosswalks written before a later framework has concepts need
				// one identity-based refresh after that framework is indexed.
				if (outcome.importSetId && needsLateCrosswalkRefresh(
					(slot.entry.recipe.target.crosswalks ?? []).map((edge) => edge.to_ontology),
					frameworkOrder.slice(position + 1).filter((later) => this.choices.get(later.entry.id) !== 'skip')
						.map((later) => later.ontology))) {
					this.pendingFrameworkLinks.push({ slot, fill, file, setId: outcome.importSetId, folder: outcome.destination });
				}
				this.plugin.debug.info('stack', 'framework', `Stack framework: ${slot.ontology}`);
			} catch {
				this.error = `${slot.entry.label} could not be imported. Check the source and destination, then try again. Remaining frameworks were not started.`;
				break;
			}
			this.render();
		}
		// Refresh the original framework set, never infer an owner from its path,
		// publisher file, or label. This also leaves all-skip Run again untouched.
		while (!this.error && this.pendingFrameworkLinks.length) {
			const pending = this.pendingFrameworkLinks[0];
			const outcome = await runRecognizedImport(this.app, this.plugin, {
				file: pending.file, entry: pending.slot.entry, table: pending.fill.table, headerRow: pending.fill.headerRow,
				destination: pending.folder, refreshSetId: pending.setId, overwriteMode: 'replace',
				sourceWhere: stackSourceWhere(pending.slot.ontology, this.stackSelection.detail),
			});
			if (!outcome.ok) {
				this.error = frameworkImportError(`${pending.slot.entry.label} crosswalk links`, outcome.errors);
				break;
			}
			this.pendingFrameworkLinks.shift();
		}
		if (!this.error) {
			try {
				const available = activeMappings(this.stackSelection).filter((mapping) => {
					if (mapping.kind === 'from-slot') return true;
					if (this.revisiting && this.choices.get(mappingKey(mapping)) === 'skip') return false;
					const found = mapping.kind === 'built-in' || this.recognition.mappingFills.some((fill) =>
						fill.mapping.id === mapping.id && this.sourceFiles.has(fill.source.path));
					if (!found && this.revisiting) this.runWarnings.push(`${mapping.label} needs its mapping file. Add the file and run again to import this slot.`);
					return found;
				});
				const mappingChoices = new Map<string, { mode: RunChoice; setId?: string; folder?: string }>();
				for (const mapping of available.filter((item) => item.kind !== 'from-slot')) {
					const key = mappingKey(mapping);
					const mode = this.revisiting ? this.choices.get(key) ?? 'new' : 'new';
					const fact = this.storedRun?.mappingSets[key];
					const set = fact && this.knownSets.get(fact.importSetId);
					const fill = this.recognition.mappingFills.find((item) => item.mapping.id === mapping.id);
					const digest = mapping.kind === 'built-in' ? computeSourceByteDigest(new TextEncoder().encode(builtInMappingTsv()))
						: fill && this.sourceDigests.get(fill.source.path);
					const hash = sssomRecipeDigest(mapping.from, mapping.to);
					const rootProblem = mode === 'refresh' ? refreshRootProblem(set) : null;
					if (rootProblem) throw new Error(rootProblem);
					const legal = slotRunChoices(fact, !!set, digest, hash,
						set ? refreshRootProblem(set) ?? refreshRecipeProblem(`sssom-${mapping.from}-to-${mapping.to}`, set.recipeIds, hash, set.recipeHashes) : null);
					if (this.revisiting && !legal.choices.includes(mode)) throw new Error(`${mapping.label} import choice is no longer available. Review the stack again before importing.`);
					mappingChoices.set(mapping.id, { mode, ...(mode === 'refresh' && set && fact
						? { setId: fact.importSetId, folder: set.root ?? undefined } : {}) });
				}
				this.mappingSets = await importMappingSlots(available, this.recognition.mappingFills,
					this.sourceFiles, { ...stackMappingDependencies(this.app, this.plugin),
						onCompleted: async (record) => {
						this.mappingSets.push(record);
						if (record.sourceDigest && record.recipeDigest && record.sourceName)
							await this.recordFact(mappingKey({ from: available.find((item) => item.id === record.id)!.from,
								to: available.find((item) => item.id === record.id)!.to, id: record.id }),
								{ importSetId: record.setId, sourceDigest: record.sourceDigest,
									recipeDigest: record.recipeDigest, sourceName: record.sourceName }, true);
						} }, this.mappingSets, mappingChoices);
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
		root.createEl('p', { text: `${plural(this.completed.length, 'framework set')} and ${plural(this.mappingSets.length, 'mapping set')}. ${plural(this.completed.reduce((sum, item) => sum + item.created, 0), 'framework note')} created or updated; ${plural(this.completed.reduce((sum, item) => sum + item.upToDate, 0), 'framework note')} already up to date. ${plural(this.mappingSets.reduce((sum, item) => sum + item.noteCount - (item.upToDate ?? 0), 0), 'separately imported mapping note')} created or updated; ${plural(this.mappingSets.reduce((sum, item) => sum + (item.upToDate ?? 0), 0), 'separately imported mapping note')} already up to date. ${plural(this.completed.reduce((sum, item) => sum + item.crosswalkLinks, 0), 'framework crosswalk link')} created or updated; ${plural(this.completed.reduce((sum, item) => sum + item.crosswalkLinksUpToDate, 0), 'framework crosswalk link')} already up to date. ${plural(this.skipped, 'slot')} skipped. ${this.discoveredSets === null ? 'Vault index is still loading; set counts cannot be confirmed yet.' : `${plural(this.discoveredSets, 'set')} confirmed in the vault.`}` });
		if (this.stackSelection.detail === 'top-levels' && this.completed.some((item) =>
			item.label === frameworkChoices().find((choice) => choice.ontology === 'nist-800-53')?.label ||
			item.label === frameworkChoices().find((choice) => choice.ontology === 'cri-profile')?.label)) {
			root.createEl('p', { text: 'Links to left-out enhancements or diagnostic statements stay unlinked on purpose. Import a new set with everything as notes to create those targets.' });
		}
		const scroll = root.createDiv({ cls: 'crosswalker-stack-scroll' });
		scroll.createEl('h3', { text: 'Frameworks' });
		for (const item of this.completed) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result' });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: item.label });
			const count = item.setId ? this.discoveredCounts.get(item.setId) : undefined;
			row.createDiv({ cls: 'crosswalker-stack-muted', text: `${count ?? 'Count pending'} ${count === 1 ? 'note' : 'notes'} · Set ${item.setId}` });
			for (const message of item.warnings.slice(0, 5)) row.createDiv({ cls: 'crosswalker-stack-warning', text: `${message}. Check the source row and recipe layout before refreshing.` });
			if (item.warnings.length > 5) row.createDiv({ cls: 'crosswalker-stack-warning', text: `${item.warnings.length - 5} more warnings. Check the source rows and recipe layout before refreshing.` });
		}
		scroll.createEl('h3', { text: 'Mappings' });
		for (const item of this.mappingSets) {
			const row = scroll.createDiv({ cls: 'crosswalker-stack-result' });
			row.createDiv({ cls: 'crosswalker-stack-choice-title', text: item.label });
			const count = this.discoveredCounts.get(item.setId) ?? item.noteCount;
			row.createDiv({ cls: 'crosswalker-stack-muted', text: `${count} edge ${count === 1 ? 'note' : 'notes'} · Set ${item.setId}` });
			if (item.duplicateRowsSkipped) row.createDiv({ cls: 'crosswalker-stack-muted', text: `${plural(item.duplicateRowsSkipped, 'duplicate row')} skipped` });
			for (const message of item.unresolved) row.createDiv({ cls: 'crosswalker-stack-warning', text: message });
		}
		for (const warning of this.runWarnings) scroll.createDiv({ cls: 'crosswalker-stack-warning', text: warning });
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
