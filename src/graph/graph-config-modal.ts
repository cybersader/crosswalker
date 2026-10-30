import { Modal, Notice, Setting, type App } from 'obsidian';
import { applyFrameworkGraph, previewFrameworkGraph, CLOSE_GLOBAL_GRAPHS_MESSAGE, type GraphColorHost } from './graph-color-command';

const LABELS: Record<string, string> = {
	showTags: 'Tag nodes', showAttachments: 'Attachment nodes', showArrow: 'File-link arrows', lineSizeMultiplier: 'Line thickness',
};
const display = (value: unknown): string => value === null ? 'Not set' : value === true ? 'On' : value === false ? 'Off' : String(value);

/** A compact explicit preview. Cancel/close never saves anything. */
export class GraphConfigModal extends Modal {
	private active = false;
	constructor(app: App, private host: GraphColorHost) { super(app); }

	onOpen(): void {
		this.active = true;
		this.setTitle('Configure framework graph');
		this.contentEl.addClass('crosswalker-graph-config');
		this.contentEl.createEl('p', { text: 'Loading saved global graph defaults…' });
		void this.renderPreview();
	}

	private async renderPreview(): Promise<void> {
		const preview = await previewFrameworkGraph(this.app, 'overview');
		if (!this.active) return;
		const el = this.contentEl;
		el.empty();
		if (preview.status !== 'preview') {
			el.createEl('p', { text: preview.message });
			new Setting(el).addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
			return;
		}
		el.createEl('p', { text: 'Make the global graph quieter. These changes update its saved defaults, not your notes. Your search, layout, zoom and local graphs stay unchanged.' });
		el.createEl('p', { text: 'Tags stay in your notes. Graph arrows show which note links to another, not what a mapping means.' });
		const { changes, generatedColorGroups, keptUserGroups } = preview.plan.preview;
		const list = el.createEl('ul');
		for (const change of changes) list.createEl('li', { text: `${LABELS[change.key]}: ${display(change.before)} → ${display(change.after)}` });
		if (changes.length === 0) list.createEl('li', { text: 'The overview display settings already match. No display changes.' });
		el.createEl('p', { text: `Update ${generatedColorGroups} automatic color rule${generatedColorGroups === 1 ? '' : 's'}. Keep ${keptUserGroups} existing color rule${keptUserGroups === 1 ? '' : 's'} in their current order.` });
		el.createEl('p', { text: 'This hides extra tag nodes; it does not reduce the number of notes shown.' });
		const openGraphs = this.app.workspace.getLeavesOfType('graph').length > 0;
		el.createEl('p', { text: openGraphs ? CLOSE_GLOBAL_GRAPHS_MESSAGE : 'After applying, open Graph view to see your changes.' });
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText('Apply overview and colors').setCta().setDisabled(openGraphs).onClick(async () => {
				b.setDisabled(true);
				const outcome = await applyFrameworkGraph(this.app, this.host, preview);
				new Notice(outcome.message, 8000);
				if (outcome.status === 'applied' || outcome.status === 'partial') this.close();
				else if (this.active) {
					el.createEl('p', { text: outcome.message });
					b.setDisabled(false);
				}
			}));
	}

	onClose(): void { this.active = false; this.contentEl.empty(); }
}
