import { ATTACK_MAPPING_RELEASE, MAPPING_PRESETS, RECIPE_REGISTRY } from '../src/import/recipe-registry';
import {
	CONNECTOR_ONTOLOGY, DEFAULT_STACK_SELECTION, activeMappings,
	checklistPlainText, checklistRows, frameworkChoices, frameworkSlots,
	type StackSelection,
} from '../src/import/stack/stack-model';

const selection = (patch: Partial<StackSelection> = {}): StackSelection => ({ ...DEFAULT_STACK_SELECTION, ...patch });

describe('framework stack setup model', () => {
	it('groups recipes by their source ontology and uses publisher links from the registry', () => {
		const choices = frameworkChoices();
		expect(new Set(choices.map((entry) => entry.ontology)).size).toBe(choices.length);
		expect(choices.map((entry) => entry.ontology)).toEqual([
			'cri-profile', 'mitre-attack', 'nist-800-53', 'nist-csf-2', 'cis-v8', 'scf',
		]);
		for (const choice of choices) expect(choice.sourceLink?.url).toBeTruthy();
	});

	it('auto-adds CSF as a connector for CRI and 800-53; user can untick it', () => {
		const slots = frameworkSlots(selection());
		expect(slots.find((slot) => slot.ontology === CONNECTOR_ONTOLOGY)?.role).toBe('connector');
		expect(activeMappings(selection()).map((mapping) => mapping.id)).toEqual([
			'cri-csf', 'csf-80053', '80053-attack',
		]);
		const excluded = selection({ connectorExcluded: true });
		expect(frameworkSlots(excluded).map((slot) => slot.ontology)).not.toContain(CONNECTOR_ONTOLOGY);
		expect(activeMappings(excluded).map((mapping) => mapping.id)).toEqual(['80053-attack']);
	});

	it('unticking CRI removes its auto-added connector and every CRI mapping', () => {
		const withoutCri = selection({ chosen: ['mitre-attack', 'nist-800-53'], optionalMappings: ['cri-80053', 'cri-attack'] });
		expect(frameworkSlots(withoutCri).map((slot) => slot.ontology)).not.toContain(CONNECTOR_ONTOLOGY);
		expect(activeMappings(withoutCri).map((mapping) => mapping.id)).toEqual(['80053-attack']);
	});

	it('five mapping presets have recipe-matching ontology identifiers and explicit optional defaults', () => {
		const ids = new Set(RECIPE_REGISTRY.map((entry) => entry.ontology));
		expect(MAPPING_PRESETS).toHaveLength(5);
		for (const mapping of MAPPING_PRESETS) {
			expect(ids.has(mapping.from)).toBe(true);
			expect(ids.has(mapping.to)).toBe(true);
		}
		expect(MAPPING_PRESETS.filter((mapping) => mapping.optional).map((mapping) => mapping.id)).toEqual(['cri-80053', 'cri-attack']);
		expect(MAPPING_PRESETS.filter((mapping) => mapping.defaultSelected).map((mapping) => mapping.id)).toEqual(['cri-csf', 'csf-80053', '80053-attack']);
		expect(MAPPING_PRESETS.find((mapping) => mapping.id === '80053-attack')?.versionNote).toContain(ATTACK_MAPPING_RELEASE);
		expect(MAPPING_PRESETS.find((mapping) => mapping.id === 'csf-80053')?.refreshSource?.url)
			.toBe('https://csrc.nist.gov/Projects/Cybersecurity-Framework/Filters');
	});

	it('checklist follows sketch order: four frameworks then external, built-in and from-slot mappings', () => {
		const rows = checklistRows(selection());
		expect(rows.map((row) => row.id)).toEqual([
			'cri-profile', 'mitre-attack', 'nist-800-53', 'nist-csf-2',
			'80053-attack', 'csf-80053', 'cri-csf',
		]);
		expect(rows).toHaveLength(7);
		for (const row of rows) {
			if (row.kind === 'framework') expect(row.publisherLink?.url).toBeTruthy();
			if (row.kind === 'mapping' && row.mappingKind !== 'download') expect(row.publisherLink).toBeUndefined();
		}
		expect(rows[2].expectedFile).toContain('.xlsx');
	});

	it('optional mappings appear only when selected and both endpoints exist', () => {
		const rows = checklistRows(selection({ optionalMappings: ['cri-80053', 'cri-attack'] }));
		expect(rows.slice(7).map((row) => row.id)).toEqual(['cri-80053', 'cri-attack']);
		expect(rows.slice(7).every((row) => row.publisherLink?.url === 'https://cyberriskinstitute.org/the-profile/')).toBe(true);
	});

	it('copies plain text with actionable links but no HTML or Markdown link markup', () => {
		const text = checklistPlainText(checklistRows(selection()));
		expect(text).toContain('1. CRI Profile');
		expect(text).toContain('Publisher:');
		expect(text).toContain('No download needed');
		expect(text).not.toMatch(/<[^>]+>|\]\(/);
		expect(text.split('\n\n')).toHaveLength(8);
	});
});
