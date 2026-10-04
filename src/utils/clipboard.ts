/**
 * Clipboard copy with a fallback the user can always finish by hand (W9,
 * 2026-10-03).
 *
 * Desktop Obsidian grants clipboard writes; a browser host may not (no user
 * gesture, a permissions policy, or no `navigator.clipboard` at all). When the
 * write fails, the text opens in a dialog already selected, so the user copies
 * it with the keyboard instead of being told something failed and left with
 * nothing.
 */

import { App, Modal, Setting } from 'obsidian';

export type CopyOutcome = 'copied' | 'shown';

/** Try the clipboard; on any failure show the text selected for manual copy. */
export async function copyTextWithFallback(app: App, text: string, title: string): Promise<CopyOutcome> {
	try {
		const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
		if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
		await clipboard.writeText(text);
		return 'copied';
	} catch {
		new CopyTextFallbackModal(app, text, title).open();
		return 'shown';
	}
}

class CopyTextFallbackModal extends Modal {
	constructor(app: App, private readonly text: string, private readonly title: string) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		new Setting(this.contentEl).setName(this.title).setHeading();
		this.contentEl.createEl('p', {
			text: 'This window could not copy to the clipboard. The text below is selected: press Ctrl+C (Cmd+C on a Mac) to copy it.',
		});
		const area = this.contentEl.createEl('textarea', { cls: 'crosswalker-copy-fallback' });
		area.value = this.text;
		area.readOnly = true;
		area.rows = 12;
		area.setCssStyles({ width: '100%', fontFamily: 'var(--font-monospace)' });
		new Setting(this.contentEl).addButton((button) => button.setButtonText('Close').onClick(() => this.close()));
		window.setTimeout(() => {
			area.focus();
			area.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
