import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { assignMappingRowIds, serializeMappingTable, MAPPING_TABLE_FORMAT, type MappingTableRowFacts } from '../../src/mappings/mapping-table';
export const SOURCE = 'iset-aaaaaa', TARGET = 'iset-bbbbbb', MAP = 'iset-mmmmmm';
export function provenance(id: string, form: 'notes' | 'table' = 'notes') {
	return { producer: { kind: 'cli' }, import_set: { id, scheme: 'endpoint-v1', ontology: id === SOURCE ? 'Policy release one' : id === TARGET ? 'Policy release two' : 'Recorded mappings', mapping_form: form } };
}
export function note(root: string, name: string, fm: Record<string, unknown>): void {
	const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `---\n${JSON.stringify(fm, null, 2)}\n---\n\nSynthetic fixture only.\n`);
}
export function concept(root: string, name: string, curie: string, set = SOURCE, title?: string): void {
	note(root, name, { curie, kind: 'concept', ...(title ? { title } : {}), _crosswalker: provenance(set) });
}
export function assertion(root: string, name: string, curie: string, extra: Record<string, unknown> = {}): void {
	note(root, name, { kind: 'crosswalk-edge', curie, subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', mapping_set_id: 'synthetic-release', _crosswalker: provenance(MAP), ...extra });
}
export function table(root: string, rows: MappingTableRowFacts[], id = MAP, extra: Record<string, unknown> = {}): string {
	const head = { crosswalker_format: MAPPING_TABLE_FORMAT, mapping_set_id: 'synthetic-release', import_set: id, crosswalker_provenance: provenance(id, 'table'), ...extra };
	const p = path.join(root, 'Moved/mappings.mapping-table.tsv'); fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, serializeMappingTable(head, assignMappingRowIds(rows, head.mapping_set_id)));
	return p;
}
export function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-connections-'));
	concept(root, 'Renamed/Access.md', 'same:A', SOURCE, 'Access policy');
	concept(root, 'Moved/Backups.md', 'same:B', TARGET, 'Backup policy');
	return root;
}
export function bytes(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (dir: string): void => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) visit(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
		}
	}; visit(root); return out;
}
