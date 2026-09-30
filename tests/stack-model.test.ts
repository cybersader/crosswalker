import { ATTACK_MAPPING_RELEASE, MAPPING_PRESETS, RECIPE_REGISTRY } from '../src/import/recipe-registry';
import { MAPPING_TABLE_TRADE_OFF } from '../src/import/mapping-form-choice';
import {
	CONNECTOR_ONTOLOGY, DEFAULT_STACK_SELECTION, STACK_PROFILES, activeMappings, applyProfile, availableOptionalMappings,
	checklistPlainText, checklistRows, frameworkChoices, frameworkSlots, newMappingForm, profileOf,
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
		expect(rows.find((row) => row.id === 'cri-80053')?.publisherLink?.url).toBe('https://cyberriskinstitute.org/the-profile/');
		expect(rows.find((row) => row.id === 'cri-attack')?.publisherLink?.url).toContain('mappings-explorer');
		expect(rows.find((row) => row.id === 'cri-80053')?.expectedFile).toContain('OLIR workbook');
		expect(rows.find((row) => row.id === 'cri-attack')?.expectedFile).toContain('Explorer JSON');
		expect(checklistPlainText(rows)).toContain('not supported here');
	});

	it('copies plain text with actionable links but no HTML or Markdown link markup', () => {
		const text = checklistPlainText(checklistRows(selection()));
		expect(text).toContain('1. CRI Profile');
		expect(text).toContain('Publisher:');
		expect(text).toContain('No download needed');
		expect(text).not.toMatch(/<[^>]+>|\]\(/);
		expect(text.split('\n\n')).toHaveLength(8);
	});

	describe('stack profiles', () => {
		const optional = ['cri-80053', 'cri-attack'];

		it('the default stack reads Standard with the notes setting, Custom with the table setting', () => {
			expect(availableOptionalMappings(selection())).toEqual(optional);
			expect(profileOf(selection(), null, 'notes')).toBe('standard');
			expect(profileOf(selection(), null, undefined)).toBe('standard');
			expect(profileOf(selection(), null, 'table')).toBe('custom');
		});

		it('derives each profile from its three fields', () => {
			expect(profileOf(selection({ detail: 'top-levels' }), 'table', 'notes')).toBe('light');
			expect(profileOf(selection(), 'notes', 'table')).toBe('standard');
			expect(profileOf(selection({ optionalMappings: optional }), 'notes', 'notes')).toBe('complete');
		});

		it('reads Custom when any one field diverges', () => {
			expect(profileOf(selection({ detail: 'max' }), 'table', 'notes')).toBe('custom');
			expect(profileOf(selection({ detail: 'top-levels' }), 'notes', 'notes')).toBe('custom');
			expect(profileOf(selection({ optionalMappings: ['cri-80053'] }), 'notes', 'notes')).toBe('custom');
			expect(profileOf(selection({ detail: 'top-levels', optionalMappings: optional }), 'table', 'notes')).toBe('custom');
		});

		it('ignores optional ids that are not available for the chosen frameworks', () => {
			const noCri = selection({ chosen: ['mitre-attack', 'nist-800-53'], optionalMappings: optional });
			expect(availableOptionalMappings(noCri)).toEqual([]);
			expect(profileOf(noCri, null, 'notes')).toBe('standard');
		});

		it('applyProfile sets exactly detail, optional mappings and the run form, and mutates nothing', () => {
			const start = selection({ chosen: ['cri-profile', 'nist-800-53'], connectorExcluded: true, optionalMappings: ['cri-80053'] });
			const frozen = JSON.stringify(start);
			for (const profile of STACK_PROFILES) {
				const { selection: next, runMappingForm } = applyProfile(start, profile.id, optional);
				expect(JSON.stringify(start)).toBe(frozen);
				expect(next).not.toBe(start);
				expect(next).toEqual({
					chosen: start.chosen, connectorExcluded: true, detail: profile.detail,
					optionalMappings: profile.optional === 'all' ? optional : [],
				});
				expect(runMappingForm).toBe(profile.mappingForm);
				expect(profileOf(next, runMappingForm, 'table', optional)).toBe(profile.id);
			}
		});

		it('an explicit per-row choice beats the profile form, which beats the setting', () => {
			expect(newMappingForm('notes', 'table', 'table')).toBe('notes');
			expect(newMappingForm(undefined, 'table', 'notes')).toBe('table');
			expect(newMappingForm(undefined, null, 'table')).toBe('table');
			expect(newMappingForm(undefined, null, undefined)).toBe('notes');
			const light = applyProfile(selection(), 'light');
			expect(newMappingForm('notes', light.runMappingForm, 'notes')).toBe('notes');
			expect(newMappingForm(undefined, light.runMappingForm, 'notes')).toBe('table');
		});

		it('Light shares the table trade-off wording and no description uses numbers or em dashes', () => {
			const light = STACK_PROFILES.find((profile) => profile.id === 'light')!;
			const hiddenFrom = MAPPING_TABLE_TRADE_OFF.match(/appear in (.+)\.$/)?.[1];
			expect(hiddenFrom).toBeTruthy();
			expect(light.description).toContain(hiddenFrom!);
			for (const profile of STACK_PROFILES) expect(profile.description).not.toMatch(/\d|\u2014/);
		});
	});
});
