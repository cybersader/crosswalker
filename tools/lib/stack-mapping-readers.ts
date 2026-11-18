import { mappingRowsToTsv, readCtidJson, readOlirWorkbook } from '../../src/import/stack/mapping-readers';
import type { SssomRow } from '../../src/import/sssom-parser';
import { d3fendAttackMappings, d3fendControlMappings, d3fendNames, publicCsv } from './demo-public-sources';
import { StackFileError, type DerivedStep, type Reader } from './stack-file';

export interface MappingRows {
	rows: SssomRow[];
	rowsRead: number;
	duplicatesSkipped?: number;
	filteredRows?: number;
	nonMappableRows?: number;
	emptyRows?: number;
}

type ReadMapping = (step: DerivedStep, read: (input: string) => Buffer) => MappingRows;

/** Closed registry: each adapter converts its named, pinned input shape to mapping rows. */
export const mappingReaders: Record<Reader, ReadMapping> = {
	'ctid-json': (step, read) => {
		const ctidText = read('bundle').toString('utf8');
		const ctidObjects = (JSON.parse(ctidText) as { mapping_objects: { capability_id?: unknown; mapping_type?: unknown }[] }).mapping_objects;
		const ctid = readCtidJson(ctidText, step.from);
		if (ctid.attackVersion !== '16.1') throw new StackFileError('The CTID mapping bundle must target ATT&CK 16.1. Select the pinned source release.');
		return {
			rows: ctid.rows, rowsRead: ctidObjects.length, duplicatesSkipped: ctid.duplicateRowsSkipped,
			filteredRows: ctidObjects.length - ctid.duplicateRowsSkipped - ctid.rows.length,
			nonMappableRows: ctidObjects.filter((row) => row.capability_id == null && row.mapping_type === 'non_mappable').length,
		};
	},
	'd3fend-controls': (_step, read) => {
		const catalog = publicCsv(read('catalog').toString('utf8'));
		const controlCsv = publicCsv(read('table').toString('utf8'));
		return { rows: d3fendControlMappings(controlCsv, d3fendNames(catalog)), rowsRead: controlCsv.length };
	},
	'd3fend-attack-mitigations': (_step, read) => {
		const attackCsv = publicCsv(read('table').toString('utf8'));
		return { ...d3fendAttackMappings(attackCsv), rowsRead: attackCsv.length };
	},
	'olir-workbook': (step, read) => {
		const rows = readOlirWorkbook(read('workbook'), { subjectOntology: step.from, objectOntology: step.to, depad: 'object' }, ['Relationships'], 0);
		return { rows, rowsRead: rows.length };
	},
};

export function derivedMappingTsv(step: DerivedStep, { rows }: MappingRows): string {
	const tsv = mappingRowsToTsv(rows, step.provider, step.from, step.to, step.release);
	if (step.reader !== 'd3fend-controls') return tsv;
	// Preserve the publisher relation as a comment without asserting its direction.
	let index = 0;
	return tsv.trimEnd().split('\n').map((line) => {
		if (line.startsWith('#')) return line;
		if (line.startsWith('subject_id\t')) return `${line}\tsource_relation\tcomment`;
		const relation = String(rows[index++].source_relation).replace(/[\t\r\n]/g, ' ');
		return `${line}\t${relation}\trelation=${relation}`;
	}).join('\n') + '\n';
}
