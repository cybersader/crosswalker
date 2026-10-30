import * as XLSX from 'xlsx';
import { workbookTable, tabularMappings, subjectTags, resolveMappings, compareMappings, normalizeMappingId } from '../src/import/stack/licensed-workbook-readers';

const mapping = (subject = 'cri-profile:XX.YY-01', object = 'cis-v8:99.10') => ({ subject_id: subject, object_id: object, predicate_id: 'skos:relatedMatch', mapping_justification: 'semapv:ManualMappingCuration' });

describe('licensed workbook adapters (synthetic data only)', () => {
	it('finds multiline headers, reads displayed identifiers, and fails on a wrong binding', () => {
		const wb = XLSX.utils.book_new();
		const sheet = XLSX.utils.aoa_to_sheet([['Banner'], ['CIS\nId', 'Profile Id'], [99.1, 'XX.YY-01']]);
		sheet.A3.z = '0.00';
		XLSX.utils.book_append_sheet(wb, sheet, 'Pair');
		expect(workbookTable(wb, 'Pair', ['CIS Id', 'Profile Id'])).toEqual([{ 'CIS Id': '99.10', 'Profile Id': 'XX.YY-01' }]);
		expect(() => workbookTable(wb, 'Pair', ['Missing'])).toThrow('header');
	});
	it('expands declared merged endpoints, not unrelated empty cells', () => {
		const wb = XLSX.utils.book_new();
		const sheet = XLSX.utils.aoa_to_sheet([['Profile Id', 'ATT&CK Id'], ['XX.YY-01', 'T9999'], ['', 'T9998'], ['', 'T9997']]);
		sheet['!merges'] = [XLSX.utils.decode_range('A2:A3')];
		XLSX.utils.book_append_sheet(wb, sheet, 'Pair');
		expect(workbookTable(wb, 'Pair', ['Profile Id', 'ATT&CK Id']).map((row) => row['Profile Id'])).toEqual(['XX.YY-01', 'XX.YY-01', '']);
		expect(sheet.A3.v).toBe('');
	});
	it('uses OLIR semantics with the counterpart as focal and reverses directional predicates', () => {
		const rows = tabularMappings([{ 'Control Id': 'ZZ-009(02)', 'Profile Id': 'XX.YY-01', Relationship: 'subset of' }], 'Control Id', 'nist-800-53');
		expect(rows[0]).toMatchObject({ subject_id: 'cri-profile:XX.YY-01', object_id: 'nist-800-53:ZZ-9(2)', predicate_id: 'skos:narrowMatch' });
	});
	it('joins merged subject tags, reports stale lookup entries without losing tags, and emits sorted slug-safe tags', () => {
		const result = subjectTags([
			{ 'CRI Profile Subject Tags': '#Example & one', 'Profile Id': 'XX.YY-01' },
			{ 'CRI Profile Subject Tags': '', 'Profile Id': 'XX.YY-02' },
			{ 'CRI Profile Subject Tags': '#Other_tag', 'Profile Id': 'XX.YY-01' },
			{ 'CRI Profile Subject Tags': '#Unlisted', 'Profile Id': 'XX.YY-01' },
		], [{ 'CRI Profile Subject Tag': '#Example & one' }, { 'CRI Profile Subject Tag': '#Other_tag' }]);
		expect(result.tags.get('XX.YY-01')).toEqual(['cri/subject/example-one', 'cri/subject/other_tag', 'cri/subject/unlisted']);
		expect(result.tags.get('XX.YY-02')).toEqual(['cri/subject/example-one']);
		expect(result.unknown).toBe(1);
	});
	it('normalizes only known formatting, drops missing endpoints with mutually exclusive counts, and never migrates CRI ids', () => {
		const present = new Set(['cri-profile:XX.YY-01', 'cis-v8:99.10', 'nist-800-53:ZZ-9(2)']);
		const result = resolveMappings([mapping(), mapping('cri-profile:XX.YY-OLD'), mapping('cri-profile:XX.YY-01', 'cis-v8:99.11'), mapping('cri-profile:absent', 'cis-v8:absent'), mapping('cri-profile:XX.YY-01', 'nist-800-53:ZZ-009 (02)')], present);
		expect(result.rows).toHaveLength(2);
		expect(result.dropped).toEqual({ subject: 1, object: 1, both: 1 });
		expect(normalizeMappingId('nist-csf-2:XX.YY-1')).toBe('nist-csf-2:XX.YY-01');
		expect(normalizeMappingId('cri-profile:XX.YY-1')).toBe('cri-profile:XX.YY-1');
	});
	it('compares assertions, not row order or counts; retains nonduplicate JSON assertions', () => {
		expect(compareMappings([mapping()], [mapping(), mapping()])).toMatchObject({ identical: true, overlap: 1, unique: [] });
		expect(compareMappings([mapping()], [mapping(), { ...mapping(), predicate_id: 'skos:exactMatch' }])).toMatchObject({ identical: false, overlap: 1, unique: [{ ...mapping(), predicate_id: 'skos:exactMatch' }] });
	});
});
