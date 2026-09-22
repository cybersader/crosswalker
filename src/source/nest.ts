import type { NestedRecordLevel } from '../types/generated/recipe';
import { SourceStageError } from './errors';

export type Row = Record<string, unknown>;

export interface LineageObject {
	level: string;
	path: string[];
	parent: string;
	ancestors: Record<string, Record<string, unknown>>;
}

export interface NestExpansion {
	rows: Row[];
	countsByLevel: Record<string, number>;
}

/**
 * Expand nested source records into one row per note-bearing record.
 *
 * Every emitted row is a new object. Its own child collection is removed so a
 * property destination cannot accidentally serialize the entire descendant
 * subtree. The reserved `_cw` object is the only lineage added to the row.
 */
export function expandNestedRows(
	levelZeroRows: Row[],
	nest: NestedRecordLevel[],
	renderIdTemplate: (template: string, row: Row) => string,
): NestExpansion {
	for (const [index, entry] of nest.entries()) {
		if (entry.identity === 'path') {
			throw new SourceStageError(
				'identity: path is not available in this build yet. Use identity: global, or wait for the next build.',
				{ declaration: `source.nest.${index}.identity` },
			);
		}
		if (entry.children !== undefined && typeof entry.children === 'object') {
			throw new SourceStageError(
				`Nest level "${entry.level}" is joined from another collection. That arrives in a later build; declare JSON field children for now.`,
				{ declaration: `source.nest.${index}.children` },
			);
		}
	}

	const rows: Row[] = [];
	const countsByLevel: Record<string, number> = {};

	const walk = (
		record: Row,
		levelIndex: number,
		ancestorPath: string[],
		ancestorValues: Record<string, Record<string, unknown>>,
	): void => {
		const entry = nest[levelIndex];
		if (!entry) return;

		let id: string;
		try {
			id = String(renderIdTemplate(entry.id, record)).trim();
		} catch {
			id = '';
		}
		if (!id) {
			throw new SourceStageError(
				`Nest level "${entry.level}" has a record with an empty id at path ${formatPath(ancestorPath)}. Every record needs an id; check the id template.`,
				{ declaration: `source.nest.${levelIndex}.id` },
			);
		}

		countsByLevel[entry.level] = (countsByLevel[entry.level] ?? 0) + 1;
		const path = [...ancestorPath, id];
		const carried = carryRecord(entry, record, id);
		const ancestors = cloneAncestors(ancestorValues);
		ancestors[entry.level] = carried;
		const lineage: LineageObject = {
			level: entry.level,
			path,
			parent: path[path.length - 2] ?? '',
			ancestors,
		};

		const emitted: Row = { ...record, _cw: lineage };
		if (typeof entry.children === 'string') delete emitted[entry.children];
		if (entry.leaf !== 'none') rows.push(emitted);

		if (typeof entry.children !== 'string') return;
		const children = record[entry.children];
		if (children === undefined || children === null || Array.isArray(children) && children.length === 0) return;
		if (!Array.isArray(children)) {
			if (typeof children === 'object') {
				throw new SourceStageError(
					`Nest level "${entry.level}" expects "${entry.children}" to be a list of records; found an object at path ${formatPath(path)}.`,
					{ declaration: `source.nest.${levelIndex}.children` },
				);
			}
			return;
		}

		for (const child of children) {
			if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
			walk(child as Row, levelIndex + 1, path, ancestors);
		}
	};

	for (const row of levelZeroRows) walk(row, 0, [], {});
	return { rows, countsByLevel };
}

function carryRecord(entry: NestedRecordLevel, record: Row, renderedId: string): Record<string, unknown> {
	const carried: Record<string, unknown> = {};
	const idField = singleFieldTemplate(entry.id);
	carried[idField ?? 'id'] = renderedId;
	for (const field of entry.carry ?? []) {
		carried[field] = readPath(record, field);
	}
	return carried;
}

function singleFieldTemplate(template: string): string | null {
	const match = /^\{([^{}|]+)\}$/.exec(template.trim());
	return match ? match[1].trim() : null;
}

function readPath(record: Row, path: string): unknown {
	let value: unknown = record;
	for (const segment of path.split('.')) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
		value = (value as Row)[segment];
	}
	return value;
}

function cloneAncestors(
	ancestors: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
	return Object.fromEntries(Object.entries(ancestors).map(([level, values]) => [level, { ...values }]));
}

function formatPath(path: readonly string[]): string {
	return path.length > 0 ? path.join('/') : '(root)';
}
