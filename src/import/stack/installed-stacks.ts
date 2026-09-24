import { plural } from '../../utils/plural';
import { App, Modal, Notice, Setting } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { discoverImportSets, settleVaultIndex, type DiscoveredImportSet } from '../../generation/import-set';
import { MAPPING_PRESETS, RECIPE_REGISTRY } from '../recipe-registry';
import { StackSetupModal } from './stack-modal';
import { deleteStackRecord, importStackDefinition, mappingKey, type SlotRunFact, type StackDefinition } from './stack-persistence';

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
	return `set ${fact.importSetId}${typeof set.noteCount === 'number' ? `, ${plural(set.noteCount, 'note')}` : ''}`;
}

export function stackSlotRows(stack: StackDefinition, run: CrosswalkerPlugin['settings']['stackRuns'][number] | undefined,
	known: ReadonlyMap<string, DiscoveredImportSet>): Array<{ label: string; state: string }> {
	return [
		...stack.slots.map((slot) => ({ label: RECIPE_REGISTRY.find((entry) => entry.id === slot.presetId)?.label ?? slot.presetId,
			state: installedStackRow(run?.slotSets[slot.presetId], known) })),
		...stack.mappings.map((slot) => {
			const mapping = MAPPING_PRESETS.find((entry) => entry.id === slot.presetId);
			return { label: mapping?.label ?? slot.presetId,
				state: slot.kind === 'from-slot' ? fromSlotText(stack, slot.from)
					: installedStackRow(run?.mappingSets[mappingKey({ ...slot, id: slot.presetId })], known) };
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

/** Shared launchpad section; redrawn after a modal closes to show fresh settings and vault facts. */
export function renderInstalledStacks(root: HTMLElement, app: App, plugin: CrosswalkerPlugin, redraw: () => void): void {
	const host = root.createDiv({ cls: 'crosswalker-workspace-installed crosswalker-installed-stacks' });
	host.createDiv({ cls: 'crosswalker-workspace-installed-heading', text: 'Installed stacks' });
	if (!plugin.settings.stacks.length) { host.remove(); return; }
	const list = host.createDiv({ cls: 'crosswalker-workspace-ontology-list' });
	const cards = plugin.settings.stacks.map((stack) => {
		const card = list.createDiv({ cls: 'crosswalker-workspace-ontology-item', attr: { 'data-stack-id': stack.id } });
		card.createEl('h3', { text: stack.label });
		card.createDiv({ cls: 'crosswalker-stack-muted', text: stack.detail === 'max' ? 'Everything as notes' : 'Notes for top levels only' });
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
		return { stack, rows };
	});
	void (async () => {
		try {
			if (await settleVaultIndex(app) > 0) throw new Error('indexing');
			const known = new Map((await discoverImportSets(app)).map((set) => [set.id, set]));
			if (!host.isConnected) return;
			for (const { stack, rows } of cards) {
				rows.empty();
				const run = plugin.settings.stackRuns.find((entry) => entry.stackId === stack.id);
				for (const row of stackSlotRows(stack, run, known))
					rows.createDiv({ cls: 'crosswalker-stack-result', text: `${row.label}: ${row.state}` });
			}
		} catch {
			if (host.isConnected) host.createDiv({ cls: 'crosswalker-stack-warning', text: 'Vault is still indexing. Wait a moment, then reopen the launchpad to check installed stacks.' });
		}
	})();
}
