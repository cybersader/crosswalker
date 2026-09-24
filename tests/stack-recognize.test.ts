import { matchScore, RECIPE_REGISTRY, applyHeaderAliases, canonicalHeaderColumns } from '../src/import/recipe-registry';
import { frameworkSlots, type StackSelection } from '../src/import/stack/stack-model';
import { recognizeStackSources, type StackSource } from '../src/import/stack/stack-recognize';

const selection: StackSelection = { chosen: ['cri-profile', 'mitre-attack', 'nist-800-53'],
	connectorExcluded: true, optionalMappings: [], detail: 'max' };
const slots = frameworkSlots(selection);
function source(name: string, columns: string[], table = ''): StackSource {
	return { path: `Sources/${name}`, name, peeks: [{ table, rows: [columns] }] };
}
function signature(ontology: string): string[] {
	return slots.find((slot) => slot.ontology === ontology)!.entry.signatureColumns;
}

describe('stack recognition over synthetic source headers', () => {
	it('fills three slots from their distinct publisher-shaped headers', () => {
		const nist = ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];
		const sources = [source('invented-cri.xlsx', signature('cri-profile'), 'CRI Profile v2.2 Structure'),
			source('enterprise-attack.xlsx', signature('mitre-attack'), 'techniques'),
			source('invented-catalog.xlsx', nist, 'Controls')];
		const found = recognizeStackSources(sources, slots);
		expect(found.fills.map((fill) => fill.slot.ontology).sort()).toEqual(['cri-profile', 'mitre-attack', 'nist-800-53']);
		expect(found.fills.every((fill) => fill.score >= 90)).toBe(true);
		expect(found.fills.find((fill) => fill.slot.ontology === 'nist-800-53')?.headerRow).toBe(0);
		const entry = RECIPE_REGISTRY.find((item) => item.ontology === 'nist-800-53')!;
		const normalized = applyHeaderAliases({ columns: nist, rows: [{
			'Control Identifier': 'ZZ-1', 'Control (or Enhancement) Name': 'Invented title',
			'Control Text': 'Invented body', Discussion: 'Invented discussion', 'Related Controls': '',
		}] }, entry);
		expect(normalized.rows[0].identifier).toBe('ZZ-1');
		expect(normalized.rows[0].name).toBe('Invented title');
		expect(normalized.rows[0].control_text).toBe('Invented body');
	});

	it('recognizes CRLF, repeated whitespace, and nbsp in raw CRI headers and alias binding', () => {
		const cri = slots.find((slot) => slot.ontology === 'cri-profile')!;
		const varied = cri.entry.signatureColumns.map((column, index) => index < 2 ? column.replace(/ /g, '\r\n  ') : column);
		const found = recognizeStackSources([source('cri.xlsx', varied, 'CRI Profile v2.2 Structure')], [cri]);
		expect(found.fills).toHaveLength(1);
		expect(found.fills[0].score).toBe(100);
		expect(matchScore(cri.entry, varied)).toBe(100);
		const nist = slots.find((slot) => slot.ontology === 'nist-800-53')!;
		const data = { columns: ['Control  \r\n Name'], rows: [{ 'Control  \r\n Name': 'Synthetic' }] };
		expect(applyHeaderAliases(data, nist.entry).rows[0].name).toBe('Synthetic');
		expect(matchScore({ ...cri.entry, signatureColumns: ['Alpha Beta'], requiredColumns: ['Alpha Beta'] }, ['Alpha\u00a0  Beta'])).toBe(100);
	});

	it('names an ATT&CK STIX bundle as a wrong file, never a filled Excel slot', () => {
		const found = recognizeStackSources([source('enterprise-attack.json', ['type', 'id', 'objects'], '$.objects[*]')], slots);
		expect(found.fills).toHaveLength(0);
		expect(found.wrongFiles[0].message).toContain('STIX bundle');
		expect(found.wrongFiles[0].message).toContain('Download enterprise-attack.xlsx');
	});

	it('keeps a 75-score partial as Might match without filling it', () => {
		const slot = slots.find((item) => item.ontology === 'nist-800-53')!;
		const partial = source('catalog.xlsx', ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion'], 'Controls');
		const found = recognizeStackSources([partial], [slot]);
		expect(matchScore(slot.entry, canonicalHeaderColumns(partial.peeks[0].rows[0], slot.entry))).toBe(80);
		expect(found.fills).toHaveLength(0);
		expect(found.mightMatch[0].score).toBe(80);
		// Four of five columns would score 80. A true 75 is exercised on a four-column fixture below.
		const four = { ...slot.entry, signatureColumns: ['identifier', 'name', 'control_text', 'discussion'],
			requiredColumns: ['identifier'] };
		const measured = recognizeStackSources([source('partial.xlsx', ['Control Identifier', 'Control Name', 'Control Text'], 'Controls')],
			[{ ...slot, entry: four }]);
		expect(measured.mightMatch[0].score).toBe(75);
		expect(measured.fills).toHaveLength(0);
	});

	it('recognizes publisher mapping files in mapping slots and names unrelated OLIR input', () => {
		const cisSlot = frameworkSlots({ ...selection, chosen: ['cis-v8'] })[0];
		const cis = recognizeStackSources([source('cis.xlsx', ['Safeguard', 'Title'], 'Change Log')], [cisSlot]);
		expect(cis.wrongFiles[0].message).toContain('Choose the workbook sheet that lists safeguards');
		const csfSlot = frameworkSlots({ ...selection, chosen: ['nist-csf-2'] })[0];
		const olir = recognizeStackSources([source('crosswalk.xlsx', ['Focal Document', 'Reference Document'], 'Mappings')], [csfSlot]);
		expect(olir.wrongFiles[0].message).toContain('OLIR mapping workbook');
		const selected: StackSelection = { ...selection, connectorExcluded: false, optionalMappings: ['cri-80053'] };
		const chosenSlots = frameworkSlots(selected);
		const found = recognizeStackSources([
			source('Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53.xlsx', ['Focal Document Element', 'Reference Document Element'], 'Mappings'),
			source('CRI-Profile-to-SP-800-53.xlsx', ['Focal Document Element', 'Reference Document Element'], 'Mappings'),
			source('nist_800_53-rev5_attack-16.1-enterprise_json.json', ['capability_id', 'attack_object_id', 'mapping_type'], '$.mapping_objects[*]'),
		], chosenSlots, RECIPE_REGISTRY, selected);
		expect(found.mappingFills.map((item) => item.mapping.id).sort()).toEqual(['80053-attack', 'cri-80053', 'csf-80053']);
		expect(found.wrongFiles).toHaveLength(0);
	});

	it('fills a CIS workbook that also carries a Change Log sheet', () => {
		const cisSlot = frameworkSlots({ ...selection, chosen: ['cis-v8'] })[0];
		const workbook: StackSource = { path: 'Sources/cis.xlsx', name: 'cis.xlsx', peeks: [
			{ table: 'Change Log', rows: [['Version', 'Change']] },
			{ table: 'Controls', rows: [cisSlot.entry.signatureColumns] },
		] };
		const found = recognizeStackSources([workbook], [cisSlot]);
		expect(found.wrongFiles).toHaveLength(0);
		expect(found.fills[0].table).toBe('Controls');
	});

	it('does not silently replace a slot with a second matching file', () => {
		const found = recognizeStackSources([source('first.xlsx', signature('mitre-attack'), 'techniques'),
			source('second.xlsx', signature('mitre-attack'), 'techniques')], slots);
		expect(found.fills).toHaveLength(1);
		expect(found.ambiguities[0].message).toContain('already has first.xlsx');
	});
});
