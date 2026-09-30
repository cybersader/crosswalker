import { plural } from '../../utils/plural';
import { App, Modal, Notice, Setting } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { discoverImportSets, settleVaultIndex, type DiscoveredImportSet } from '../../generation/import-set';
import { MAPPING_PRESETS, RECIPE_REGISTRY } from '../recipe-registry';
import { StackSetupModal } from './stack-modal';
import { deleteStackRecord, importStackDefinition, mappingKey, type SlotRunFact, type StackDefinition } from './stack-persistence';
import {
	MappingConversionModal,
	cancelConversionForSet,
	conversionCanCancel,
	conversionStateText,
	conversionTargetOf,
	convertButtonLabel,
	finishConversionForSet,
} from './mapping-conversion-ui';

function fromSlotText(stack: StackDefinition, from: string): string {
	const slot = stack.slots.find((item) => RECIPE_REGISTRY.find((entry) => entry.id === item.presetId)?.ontology === from);
	const label = RECIPE_REGISTRY.find((entry) => entry.id === slot?.presetId)?.label ?? 'its framework';
	return `Comes with ${label}. Not tracked separately.`;
}

/** One slot state derives only from the recorded minted ID, not a path, name, or recipe match. */
export function installedStackRow(fact: SlotRunFact | undefined, known: ReadonlyMap<string, DiscoveredImportSet>): string {
	if (!fact) return 'Not imported yet';
	const set = known.get(fact.importSetId);
	if (!set) return `Set ${fact.importSetId} is no longer in this vault. Import as a new set.`;
	// Slice 4: while a conversion marker exists the row says so; the counts
	// describe the form readers use right now (see DiscoveredImportSet.converting).
	const converting = set.converting ? `. ${conversionStateText(set.converting)}` : '';
	// A table-form set owns no notes; "0 notes" would read as an empty set.
	if (set.mapping_form === 'table') return `set ${fact.importSetId}, 1 mapping table, ${plural(set.rowCount ?? 0, 'row')}${converting}`;
	return `set ${fact.importSetId}${typeof set.noteCount === 'number' ? `, ${plural(set.noteCount, 'note')}` : ''}${converting}`;
}

/** Framework depth only; mapping form is reported separately so the two never contradict. */
export function stackDetailLabel(detail: StackDefinition['detail']): string {
	return detail === 'max' ? 'Every framework level as notes' : 'Top framework levels as notes';
}

/** Card subtitle: framework depth, plus "Mappings: table" when any recorded mapping set is a table. */
export function stackSubtitle(stack: StackDefinition, run: CrosswalkerPlugin['settings']['stackRuns'][number] | undefined,
	known: ReadonlyMap<string, DiscoveredImportSet>): string {
	const anyTable = Object.values(run?.mappingSets ?? {}).some((fact) => known.get(fact.importSetId)?.mapping_form === 'table');
	return anyTable ? `${stackDetailLabel(stack.detail)}. Mappings: table` : stackDetailLabel(stack.detail);
}

export function stackSlotRows(stack: StackDefinition, run: CrosswalkerPlugin['settings']['stackRuns'][number] | undefined,
	known: ReadonlyMap<string, DiscoveredImportSet>): Array<{ label: string; state: string; mappingSet?: DiscoveredImportSet }> {
	return [
		...stack.slots.map((slot) => ({ label: RECIPE_REGISTRY.find((entry) => entry.id === slot.presetId)?.label ?? slot.presetId,
			state: installedStackRow(run?.slotSets[slot.presetId], known) })),
		...stack.mappings.map((slot) => {
			const mapping = MAPPING_PRESETS.find((entry) => entry.id === slot.presetId);
			const fact = slot.kind === 'from-slot' ? undefined : run?.mappingSets[mappingKey({ ...slot, id: slot.presetId })];
			// Only a recorded, present mapping set can be converted; a from-slot
			// link set stays notes (slice 4 out of scope).
			const mappingSet = fact ? known.get(fact.importSetId) : undefined;
			return { label: mapping?.label ?? slot.presetId,
				state: slot.kind === 'from-slot' ? fromSlotText(stack, slot.from) : installedStackRow(fact, known),
				...(mappingSet ? { mappingSet } : {}) };
		}),
	];
}

class ImportStackModal extends Modal {
	private json = '';
	private message = '';
	constructor(app: App, private plugin: CrosswalkerPlugin, private changed: () => void) { super(app); }
	onOpen(): void {
		this.contentEl.createEl('h2', { text: 'Import a stack' });
		this.contentEl.createEl('p', { text: 'Paste an exported stack definition or choose its JSON file. Vault-specific run history is not imported.' });
		const picker = this.contentEl.createEl('input', { type: 'file', attr: { accept: '.json', 'aria-label': 'Choose stack JSON' } });
		const input = this.contentEl.createEl('textarea', { attr: { 'aria-label': 'Stack JSON', rows: '8' } });
		picker.addEventListener('change', () => { const file = picker.files?.[0]; if (file) void file.text().then((text) => { this.json = text; input.value = text; }); });
		input.addEventListener('input', () => { this.json = input.value; });
		const feedback = this.contentEl.createEl('p', { cls: 'crosswalker-stack-warning' });
		new Setting(this.contentEl).addButton((button) => button.setButtonText('Import').setCta().onClick(async () => {
			try {
				const definition = importStackDefinition(this.json, this.plugin.settings.stacks);
				this.plugin.settings.stacks.push(definition);
				await this.plugin.saveSettings();
				this.changed(); this.close();
				new Notice(`Imported stack: ${definition.label}`);
			} catch (error) {
				this.message = error instanceof Error ? error.message : 'Could not import the stack. Choose a valid stack JSON file and try again.';
				feedback.textContent = this.message;
			}
		}));
	}
}

export function openImportStack(app: App, plugin: CrosswalkerPlugin, redraw: () => void): void {
	new ImportStackModal(app, plugin, redraw).open();
}

class DeleteStackModal extends Modal {
	constructor(app: App, private plugin: CrosswalkerPlugin, private stack: StackDefinition, private changed: () => void) { super(app); }
	onOpen(): void {
		this.contentEl.createEl('h2', { text: 'Delete this stack?' });
		this.contentEl.createEl('p', { text: 'Its notes and import sets stay in the vault. Only this saved definition and its run history are removed.' });
		new Setting(this.contentEl).addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('Delete stack').setWarning().onClick(async () => {
				const next = deleteStackRecord(this.plugin.settings.stacks, this.plugin.settings.stackRuns, this.stack.id);
				this.plugin.settings.stacks = next.stacks;
				this.plugin.settings.stackRuns = next.stackRuns;
				await this.plugin.saveSettings(); this.changed(); this.close();
			}));
	}
}

/**
 * One mapping set row with its conversion actions: Convert while no job
 * exists; Finish, and Cancel before the source starts going to the trash,
 * while one does. Slice 4 of the mapping table form.
 */
function renderMappingSetRow(rows: HTMLElement, app: App, plugin: CrosswalkerPlugin, label: string, state: string,
	set: DiscoveredImportSet, redraw: () => void): void {
	const row = rows.createDiv({ cls: 'crosswalker-stack-result crosswalker-mapping-set-row',
		attr: { 'data-import-set': set.id, 'data-set-form': set.mapping_form, ...(set.converting ? { 'data-converting': set.converting.phase } : {}) } });
	row.createSpan({ text: `${label}: ${state}` });
	const actions = row.createDiv({ cls: 'crosswalker-conversion-actions' });
	const name = `${label} (set ${set.id})`;
	if (set.converting) {
		actions.createEl('button', { text: 'Finish', cls: 'mod-cta' }).addEventListener('click', () => {
			void finishConversionForSet(app, plugin, set.id, name, redraw);
		});
		if (conversionCanCancel(set.converting.phase)) {
			actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
				void cancelConversionForSet(app, set.id, name, redraw, plugin);
			});
		}
		return;
	}
	const to = conversionTargetOf(set);
	actions.createEl('button', { text: convertButtonLabel(to) }).addEventListener('click', () =>
		new MappingConversionModal(app, plugin, { kind: 'start', set, to, label: name }, redraw).open());
}

/** Shared launchpad section; redrawn after a modal closes to show fresh settings and vault facts. */
export function renderInstalledStacks(root: HTMLElement, app: App, plugin: CrosswalkerPlugin, redraw: () => void): void {
	const host = root.createDiv({ cls: 'crosswalker-workspace-installed crosswalker-installed-stacks' });
	host.createDiv({ cls: 'crosswalker-workspace-installed-heading', text: 'Installed stacks' });
	if (!plugin.settings.stacks.length) { host.remove(); return; }
	const list = host.createDiv({ cls: 'crosswalker-workspace-ontology-list' });
	const cards = plugin.settings.stacks.map((stack) => {
		const card = list.createDiv({ cls: 'crosswalker-workspace-ontology-item', attr: { 'data-stack-id': stack.id } });
		card.createEl('h3', { text: stack.label });
		const subtitle = card.createDiv({ cls: 'crosswalker-stack-muted', text: stackDetailLabel(stack.detail) });
		const rows = card.createDiv({ cls: 'crosswalker-installed-stack-rows' });
		const buttons = card.createDiv({ cls: 'crosswalker-workspace-ontology-actions' });
		buttons.createEl('button', { text: 'Run again' }).addEventListener('click', () =>
			new StackSetupModal(app, plugin, stack, redraw).open());
		buttons.createEl('button', { text: 'Export' }).addEventListener('click', async () => {
			const json = JSON.stringify(stack, null, 2);
			try {
				const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
				const link = document.createElement('a'); link.href = url; link.download = `crosswalker-stack-${stack.id}.json`;
				document.body.appendChild(link);
				link.click(); link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 0);
			} catch { new Notice('Could not download this stack. Check download permissions, then try again.'); return; }
			try {
				await navigator.clipboard.writeText(json);
				new Notice('Stack definition downloaded and copied to the clipboard.');
			} catch { new Notice('Stack definition downloaded, but clipboard copy failed. Check clipboard permissions, then try again.'); }
		});
		buttons.createEl('button', { text: 'Delete' }).addEventListener('click', () =>
			new DeleteStackModal(app, plugin, stack, redraw).open());
		return { stack, rows, subtitle };
	});
	void (async () => {
		try {
			if (await settleVaultIndex(app) > 0) throw new Error('indexing');
			const known = new Map((await discoverImportSets(app)).map((set) => [set.id, set]));
			if (!host.isConnected) return;
			for (const { stack, rows, subtitle } of cards) {
				rows.empty();
				const run = plugin.settings.stackRuns.find((entry) => entry.stackId === stack.id);
				subtitle.textContent = stackSubtitle(stack, run, known);
				for (const row of stackSlotRows(stack, run, known)) {
					if (!row.mappingSet) { rows.createDiv({ cls: 'crosswalker-stack-result', text: `${row.label}: ${row.state}` }); continue; }
					renderMappingSetRow(rows, app, plugin, row.label, row.state, row.mappingSet, redraw);
				}
			}
		} catch {
			if (host.isConnected) host.createDiv({ cls: 'crosswalker-stack-warning', text: 'Vault is still indexing. Wait a moment, then reopen the launchpad to check installed stacks.' });
		}
	})();
}
