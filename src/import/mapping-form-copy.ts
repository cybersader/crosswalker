/**
 * mapping-form-copy.ts — pure copy constants for the mapping "Store as" choice.
 *
 * Split out of mapping-form-choice.ts (2026-09-30) so `stack-model.ts`, which
 * must stay free of Obsidian imports, can read this copy without pulling in
 * `Setting` from 'obsidian'. No Obsidian or filesystem state.
 */

/**
 * The surfaces a table-form mapping set leaves. One source for the trade-off
 * line and the Light stack profile description, so the two cannot drift.
 */
export const MAPPING_TABLE_HIDDEN_FROM = 'Bases views, graph view or backlinks';

export const MAPPING_TABLE_TRADE_OFF = `One file that opens in a spreadsheet. These mappings will not appear in ${MAPPING_TABLE_HIDDEN_FROM}.`;
