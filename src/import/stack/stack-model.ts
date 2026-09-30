/** Pure stack-picker and download-checklist derivation. No Obsidian or filesystem state. */
import { computeRecipeHash } from '../../generation/hash';
import type { MappingForm } from '../../generation/import-set-block';
import { MAPPING_TABLE_HIDDEN_FROM } from '../mapping-form-copy';
import type { Recipe } from '../../render';
import {
	MAPPING_PRESETS, RECIPE_REGISTRY, STACK_PRESETS,
	type MappingPreset, type RecipeRegistryEntry,
} from '../recipe-registry';

export const CONNECTOR_ONTOLOGY = 'nist-csf-2';
export const CONNECTOR_REASON = 'Added automatically to connect CRI Profile to NIST 800-53. Untick to leave that route disconnected.';

export interface StackSelection {
	chosen: readonly string[];
	connectorExcluded: boolean;
	optionalMappings: readonly string[];
	detail: 'max' | 'top-levels';
}

export interface FrameworkSlot {
	ontology: string;
	entry: RecipeRegistryEntry;
	role: 'chosen' | 'connector';
}

export type ChecklistRow =
	| { kind: 'framework'; id: string; label: string; expectedFile: string; source: string; publisherLink: { label: string; url: string }; licenceNote?: string; versionNote?: never; role: 'chosen' | 'connector' }
	| { kind: 'mapping'; id: string; label: string; expectedFile: string; source: string; publisherLink?: { label: string; url: string }; licenceNote?: string; versionNote?: string; mappingKind: MappingPreset['kind'] };

/** The registry remains the source of truth for labels and publisher links. */
const NESTED_STACK_RECIPES: Readonly<Record<string, string>> = {
	'cri-profile': 'cri-profile-v2-2-nested',
	'nist-800-53': 'nist-800-53-r5-nested',
};

const PREFERRED_RECIPES = [
	'cri-profile-v2-2-flat', 'mitre-attack-technique-flat', 'nist-800-53-r5-flat',
	'nist-csf-2-cprt-hierarchical', 'cis-controls-v8-controls', 'scf-2026-flat',
];

export const DEFAULT_STACK_SELECTION: StackSelection = {
	chosen: STACK_PRESETS[0].frameworks,
	connectorExcluded: false,
	optionalMappings: [],
	detail: STACK_PRESETS[0].detail,
};

export function frameworkChoices(registry: readonly RecipeRegistryEntry[] = RECIPE_REGISTRY): RecipeRegistryEntry[] {
	const byOntology = new Map<string, RecipeRegistryEntry>();
	for (const id of PREFERRED_RECIPES) {
		const entry = registry.find((item) => item.id === id && item.routingKind === 'concept');
		if (entry && !byOntology.has(entry.ontology)) byOntology.set(entry.ontology, entry);
	}
	return [...byOntology.values()];
}

export function frameworkSlots(
	selection: StackSelection,
	registry: readonly RecipeRegistryEntry[] = RECIPE_REGISTRY,
): FrameworkSlot[] {
	const entries = frameworkChoices(registry);
	const chosen = new Set(selection.chosen);
	const connector = chosen.has('cri-profile') && chosen.has('nist-800-53')
		&& !chosen.has(CONNECTOR_ONTOLOGY) && !selection.connectorExcluded;
	return entries.filter((entry) => chosen.has(entry.ontology) || (connector && entry.ontology === CONNECTOR_ONTOLOGY))
		.map((entry) => ({
			ontology: entry.ontology,
			entry: registry.find((variant) => variant.id === NESTED_STACK_RECIPES[entry.ontology]) ?? entry,
			role: chosen.has(entry.ontology) ? 'chosen' as const : 'connector' as const,
		}));
}

/** Plain-language summary of what one slot creates at the selected detail. */
export function slotDetailSummary(slot: FrameworkSlot, detail: StackSelection['detail']): string {
	switch (slot.ontology) {
		case 'nist-800-53': return detail === 'top-levels'
			? 'Each family becomes a folder; each control becomes a folder note. Enhancements are left out.'
			: 'Each family becomes a folder; each control becomes a folder note; each enhancement becomes a note.';
		case 'cri-profile': return detail === 'top-levels'
			? 'Each function, category, and subcategory becomes a folder note. Diagnostic statements are left out.'
			: 'Each function, category, and subcategory becomes a folder note; each diagnostic statement becomes a note.';
		case 'mitre-attack': return 'Each technique and sub-technique becomes a note.';
		case 'nist-csf-2': return 'Functions and categories become folders; subcategories become notes.';
		default: return slot.entry.description;
	}
}

/** Stack-wide picker copy names only the selected frameworks whose detail changes. */
export function stackDetailDescription(selection: StackSelection): string {
	const selected = selection.chosen.filter((ontology) => ontology === 'nist-800-53' || ontology === 'cri-profile');
	if (!selected.length) return 'These frameworks use the same note detail at either setting.';
	return selection.detail === 'max'
		? 'Every framework level as notes: every level of each selected framework becomes a note. Other frameworks stay the same.'
		: 'Top framework levels as notes: 800-53 enhancements and CRI diagnostic statements are left out where selected. Other frameworks stay the same.';
}

/** Source selection is run-scoped but contributes to the stamped recipe hash. */
export function stackRecipeHash(slot: FrameworkSlot, detail: StackSelection['detail']): string {
	const recipe = slot.entry.recipe as unknown as Recipe;
	const where = stackSourceWhere(slot.ontology, detail);
	return computeRecipeHash(recipe.target, where ? { ...recipe.source, where } : recipe.source);
}

/** A refresh must preserve both recipe identity and note-selection semantics. */
export function refreshRecipeProblem(
	recipeId: string, recordedRecipeIds: readonly string[],
	recipeHash?: string, recordedRecipeHashes?: readonly string[],
): string | null {
	if (!recipeId || !recordedRecipeIds.includes(recipeId)) {
		return 'This set was imported with a different recipe. Start a new set, or refresh it with the recipe it was made with.';
	}
	if (recipeHash && (recordedRecipeHashes?.length !== 1 || recordedRecipeHashes[0] !== recipeHash)) {
		return 'This set used different or unrecorded detail. Start a new set, or refresh it with the same detail as before.';
	}
	return null;
}

export function stackSourceWhere(ontology: string, detail: StackSelection['detail']): string | undefined {
	if (detail !== 'top-levels') return undefined;
	if (ontology === 'cri-profile') return "Level != 'DS'";
	if (ontology === 'nist-800-53') return "$not($contains(identifier, '('))";
	return undefined;
}

/** Optional mapping ids whose two endpoints are both in the stack right now. */
export function availableOptionalMappings(selection: StackSelection, slots: readonly FrameworkSlot[] = frameworkSlots(selection)): string[] {
	const endpoints = new Set(slots.map((slot) => slot.ontology));
	return MAPPING_PRESETS.filter((mapping) => mapping.optional && endpoints.has(mapping.from) && endpoints.has(mapping.to))
		.map((mapping) => mapping.id);
}

/**
 * Stack profiles: shorthand for three fields the stack already has (detail,
 * the mapping form for this run's new sets, and whether optional mappings are
 * included). A profile is never stored. It is derived from the fields every
 * time the picker renders (`profileOf`), and choosing one only writes the
 * fields (`applyProfile`). Failure mode prevented: a stored profile drifting
 * from its fields, so the control says Light while the run imports every level
 * as notes. Nothing here touches `StackDefinition`, `StackRunRecord` or the
 * `defaultMappingForm` setting.
 */
export type StackProfileId = 'light' | 'standard' | 'complete';

export interface StackProfile {
	id: StackProfileId;
	label: string;
	description: string;
	detail: StackSelection['detail'];
	mappingForm: MappingForm;
	optional: 'none' | 'all';
}

export const STACK_PROFILES: readonly StackProfile[] = [
	{
		id: 'light', label: 'Light', detail: 'top-levels', mappingForm: 'table', optional: 'none',
		description: `Top framework levels as notes; mappings as one table each. Fewest files; mappings are not visible to ${MAPPING_TABLE_HIDDEN_FROM}.`,
	},
	{
		id: 'standard', label: 'Standard', detail: 'max', mappingForm: 'notes', optional: 'none',
		description: 'Every framework level as notes; one note per mapping. The default.',
	},
	{
		id: 'complete', label: 'Complete', detail: 'max', mappingForm: 'notes', optional: 'all',
		description: 'Everything in Standard plus the optional mappings.',
	},
];

export const CUSTOM_PROFILE_LABEL = 'Custom';
export const CUSTOM_PROFILE_DESCRIPTION = 'Fields set by hand.';

/**
 * The form a NEW mapping set runs with: an explicit per-row Store as choice,
 * else the profile form for this run, else the setting, else notes. A profile
 * therefore never overrides a choice made by hand on the review screen and
 * never writes the setting. Refresh rows do not use this: they keep the form
 * their set was minted with.
 */
export function newMappingForm(
	explicit: MappingForm | undefined, runMappingForm: MappingForm | null, settingForm: MappingForm | undefined,
): MappingForm {
	return explicit ?? runMappingForm ?? settingForm ?? 'notes';
}

/**
 * Which profile the current fields match, or 'custom'. Derived, never read
 * from storage. `optionalIds` defaults to the optional mappings available for
 * the selection; with none available Standard and Complete coincide and the
 * first match (Standard) is reported.
 */
export function profileOf(
	selection: StackSelection, runMappingForm: MappingForm | null, settingForm: MappingForm | undefined,
	optionalIds: readonly string[] = availableOptionalMappings(selection),
): StackProfileId | 'custom' {
	const form = newMappingForm(undefined, runMappingForm, settingForm);
	const included = optionalIds.filter((id) => selection.optionalMappings.includes(id));
	for (const profile of STACK_PROFILES) {
		if (profile.detail !== selection.detail || profile.mappingForm !== form) continue;
		if (profile.optional === 'none' ? included.length === 0 : included.length === optionalIds.length) return profile.id;
	}
	return 'custom';
}

/**
 * Apply a profile: returns a new selection with `detail` and `optionalMappings`
 * set, plus the run-scoped mapping form. Frameworks and the connector choice
 * are left exactly as they were. Pure; the inputs are not mutated.
 */
export function applyProfile(
	selection: StackSelection, id: StackProfileId, optionalIds: readonly string[] = availableOptionalMappings(selection),
): { selection: StackSelection; runMappingForm: MappingForm } {
	const profile = STACK_PROFILES.find((item) => item.id === id);
	if (!profile) throw new Error(`Unknown stack profile ${id}.`);
	return {
		selection: {
			...selection,
			chosen: [...selection.chosen],
			detail: profile.detail,
			optionalMappings: profile.optional === 'all' ? [...optionalIds] : [],
		},
		runMappingForm: profile.mappingForm,
	};
}

export function activeMappings(selection: StackSelection, slots: readonly FrameworkSlot[] = frameworkSlots(selection)): MappingPreset[] {
	const available = new Set(slots.map((slot) => slot.ontology));
	return MAPPING_PRESETS.filter((mapping) => available.has(mapping.from) && available.has(mapping.to)
		&& (!mapping.optional || selection.optionalMappings.includes(mapping.id)));
}

function expectedFrameworkFile(entry: RecipeRegistryEntry): string {
	switch (entry.ontology) {
		case 'cri-profile': return 'CRI Profile v2.2 workbook (.xlsx), Structure sheet';
		case 'mitre-attack': return 'Enterprise ATT&CK Excel export (.xlsx), not STIX';
		case 'nist-800-53': return 'NIST 800-53 control catalog workbook (.xlsx)';
		case 'nist-csf-2': return 'NIST CPRT export';
		case 'cis-v8': return 'CIS Controls workbook';
		case 'scf': return 'SCF workbook';
		default: return 'Publisher export';
	}
}

/** Frameworks first, then external mapping, built-in mapping and from-slot mapping. */
export function checklistRows(selection: StackSelection): ChecklistRow[] {
	const slots = frameworkSlots(selection);
	const frameworks: ChecklistRow[] = slots.map(({ entry, role }) => ({
		kind: 'framework', id: entry.ontology, label: entry.label, role,
		expectedFile: expectedFrameworkFile(entry), source: entry.ontology === 'cri-profile' ? '' : entry.sourceLink?.note ?? '',
		publisherLink: entry.sourceLink ?? { label: 'Publisher instructions', url: entry.docsUrl },
		licenceNote: entry.ontology === 'cri-profile'
			? 'CRI registration and licence terms apply. Crosswalker does not distribute this file.' : undefined,
	}));
	const order = ['80053-attack', 'csf-80053', 'cri-csf', 'cri-80053', 'cri-attack'];
	const mappings: ChecklistRow[] = activeMappings(selection, slots)
		.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
		.map((mapping) => ({
			kind: 'mapping', id: mapping.id, label: mapping.label, mappingKind: mapping.kind,
			expectedFile: mapping.expectedFile, source: mapping.source,
			publisherLink: mapping.kind === 'download' ? mapping.publisherLink : undefined,
			licenceNote: mapping.licenceNote, versionNote: mapping.versionNote,
		}));
	return [...frameworks, ...mappings];
}

/** Clipboard output deliberately has no HTML, Markdown links or invisible rich formatting. */
export function checklistPlainText(rows: readonly ChecklistRow[]): string {
	return ['Framework stack download checklist', ...rows.map((row, index) => [
		`${index + 1}. ${row.label}`,
		`   Expected: ${row.expectedFile}`,
		...(row.source ? [`   ${row.source}`] : []),
		...(row.publisherLink ? [`   Publisher: ${row.publisherLink.label} (${row.publisherLink.url})`] : []),
		...(row.licenceNote ? [`   ${row.licenceNote}`] : []),
		...(row.versionNote ? [`   ${row.versionNote}`] : []),
	].join('\n'))].join('\n\n');
}
