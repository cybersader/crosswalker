import * as XLSX from 'xlsx';
import { depad80053, olirRowsToSssom, readOlirWorkbook, readCtidJson, mappingRowsToTsv } from '../src/import/stack/mapping-readers';
import { parseSssomTsv } from '../src/import/sssom-parser';

describe('OLIR mapping reader', () => {
	it('de-pads only the chosen 800-53 endpoint, including enhancements, while leaving family ids and CSF zeros intact', () => {
		const rows = olirRowsToSssom([
			{ 'Focal Document Element': 'GV.OC-01', 'Reference Document Element': 'AC-02(01)', Relationship: 'Subset Of', 'Strength of Relationship': '8' },
			{ 'Focal Document Element': 'GV.OC-02', 'Reference Document Element': 'PT', Relationship: 'Intersects With' },
		], { subjectOntology: 'nist-csf-2', objectOntology: 'nist-800-53', depad: 'object' });
		expect(rows.map((row) => [row.subject_id, row.predicate_id, row.object_id])).toEqual([
			['nist-csf-2:GV.OC-01', 'skos:broadMatch', 'nist-800-53:AC-2(1)'],
			['nist-csf-2:GV.OC-02', 'skos:relatedMatch', 'nist-800-53:PT'],
		]);
		expect(rows[0].confidence).toBe(0.8);
		expect(depad80053('IR-04(02)')).toBe('IR-4(2)');
	});

	it('reads a banner-row workbook using formatted text and normalizes multiline headers', () => {
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
			['Banner'], ['Focal Document\nElement', 'Reference Document Element', 'Relationship'],
			['GV.OC-01', 'AC-02', 'Equal'],
		]), 'Mappings');
		const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
		const rows = readOlirWorkbook(bytes, { subjectOntology: 'nist-csf-2', objectOntology: 'nist-800-53', depad: 'object' }, ['Mappings'], 1);
		expect(rows).toHaveLength(1);
		expect(rows[0].object_id).toBe('nist-800-53:AC-2');
		expect(rows[0].predicate_id).toBe('skos:exactMatch');
	});
});

describe('CTID JSON reader', () => {
	it('maps canonical control to technique with overlap default and ATT&CK version', () => {
		const parsed = readCtidJson(JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
			{ capability_id: 'AC-02', attack_object_id: 'T1234.001', mapping_type: 'mitigates' },
			{ capability_id: 'PT', attack_object_id: 'T1235' },
		] }));
		expect(parsed.attackVersion).toBe('16.1');
		expect(parsed.rows.map((row) => [row.subject_id, row.predicate_id, row.object_id])).toEqual([
			['nist-800-53:AC-2', 'skos:relatedMatch', 'mitre-attack:T1234.001'],
			['nist-800-53:PT', 'skos:relatedMatch', 'mitre-attack:T1235'],
		]);
		const tsv = mappingRowsToTsv(parsed.rows, 'CTID', 'nist-800-53', 'mitre-attack', '16.1');
		expect(parseSssomTsv(tsv).rows).toHaveLength(2);
	});
	it('rejects STIX bundles and nonmatching ids instead of silently importing zero edges', () => {
		expect(() => readCtidJson('{"objects":[]}')).toThrow('mapping_objects');
		expect(() => readCtidJson('{"mapping_objects":[{"capability_id":"bad","attack_object_id":"bad"}]}')).toThrow('No valid');
	});
	it('keeps non-800-53 capability ids in their own form', () => {
		const parsed = readCtidJson(JSON.stringify({ mapping_objects: [
			{ capability_id: 'ZZ.AB-01.02', attack_object_id: 'T9999.001', mapping_type: 'mitigates' },
		] }), 'cri-profile');
		expect(parsed.rows[0].subject_id).toBe('cri-profile:ZZ.AB-01.02');
		expect(parsed.rows[0].object_id).toBe('mitre-attack:T9999.001');
	});
});
