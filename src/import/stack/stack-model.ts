/** Pure stack-picker and download-checklist derivation. No Obsidian or filesystem state. */
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
		.map((entry) => ({ ontology: entry.ontology, entry, role: chosen.has(entry.ontology) ? 'chosen' : 'connector' }));
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
