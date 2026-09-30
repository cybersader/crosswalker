/**
 * mapping-form-choice.ts — the one "Store as" control for a NEW mapping set.
 *
 * Slice 3 of the mapping table form (2026-09-30). The stack review and the
 * standalone crosswalk mapping import both offer the choice; they share this
 * module so the copy and the trade-off line cannot drift apart. Failure mode
 * prevented: a user picking Table on one screen without being told, at the
 * decision point, that those mappings leave Bases views, graph view and
 * backlinks.
 *
 * A refresh never renders this control: it keeps the form its set was minted
 * with (see `refreshFormText`), because switching forms is a conversion job.
 */
import { Setting } from 'obsidian';
import { MAPPING_FORMS, type MappingForm } from '../generation/import-set-block';

export const MAPPING_FORM_LABELS: Record<MappingForm, string> = {
	notes: 'Notes',
	table: 'Table',
};

export const MAPPING_TABLE_TRADE_OFF = 'One file that opens in a spreadsheet. These mappings will not appear in Bases views, graph view or backlinks.';

/** Text shown on a refresh row in place of the control. */
export function refreshFormText(form: MappingForm): string {
	return form === 'table' ? 'Stored as: Table (kept on refresh)' : 'Stored as: Notes (kept on refresh)';
}

/**
 * Render the "Store as" dropdown with its trade-off line. The line is present
 * only while Table is selected and updates in place, so a caller never has to
 * re-render the whole screen for it.
 */
export function renderMappingFormChoice(
	container: HTMLElement,
	value: MappingForm,
	onChange: (form: MappingForm) => void,
): void {
	const wrap = container.createDiv({ cls: 'crosswalker-mapping-form' });
	const tradeOff = (form: MappingForm) => {
		wrap.querySelector('.crosswalker-mapping-form-trade-off')?.remove();
		if (form === 'table') wrap.createDiv({ cls: 'crosswalker-mapping-form-trade-off crosswalker-stack-muted', text: MAPPING_TABLE_TRADE_OFF });
	};
	new Setting(wrap).setName('Store as').addDropdown((dropdown) => {
		for (const form of MAPPING_FORMS) dropdown.addOption(form, MAPPING_FORM_LABELS[form]);
		dropdown.selectEl.addClass('crosswalker-mapping-form-select');
		dropdown.setValue(value).onChange((next) => {
			const form: MappingForm = next === 'table' ? 'table' : 'notes';
			tradeOff(form);
			onChange(form);
		});
	});
	tradeOff(value);
}
