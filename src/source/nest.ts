import type { NestedRecordLevel } from '../types/generated/recipe';
import { SourceStageError } from './errors';
import { normalizeKey, type JoinFromDeclaration } from './joins';

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
	unparented: Record<string, number>;
}

export interface NestSecondaryResolver {
	resolve(from: JoinFromDeclaration, declaration: string): Promise<Row[]>;
}

interface SecondaryGrouping {
	byParent: Map<string, Row[]>;
	keys: Array<string | null>;
	matched: Set<string>;
}

/**
 * Expand nested source records into one row per note-bearing record.
 *
 * Every emitted row is a new object. Its own JSON child collection is removed
 * so a property destination cannot accidentally serialize the entire descendant
 * subtree. The reserved `_cw` object is the only lineage added to the row.
 */
export async function expandNestedRows(
	levelZeroRows: Row[],
	nest: NestedRecordLevel[],
	renderIdTemplate: (template: string, row: Row) => string,
	secondary: NestSecondaryResolver,
): Promise<NestExpansion> {
	const joinedChildren = new Map<number, SecondaryGrouping>();

	// A joined collection is read exactly once per declared level, then retained as
	// an insertion-ordered grouping for every parent at that level.
	for (let levelIndex = 0; levelIndex < nest.length - 1; levelIndex++) {
		const entry = nest[levelIndex];
		if (!entry || entry.children === undefined || typeof entry.children === 'string') continue;
		const next = nest[levelIndex + 1];
		if (!next || typeof next.parent_key !== 'string' || next.parent_key.trim() === '') {
			throw new SourceStageError(
				`Nest level "${next?.level ?? levelIndex + 1}" is joined from another collection and needs parent_key: the child field that names its parent's id.`,
				{ declaration: `source.nest.${levelIndex + 1}.parent_key` },
			);
		}

		const declaration = `source.nest.${levelIndex}.children`;
		const secondaryRows = await secondary.resolve(entry.children as JoinFromDeclaration, declaration);
		const byParent = new Map<string, Row[]>();
		const keys: Array<string | null> = [];
		for (let rowIndex = 0; rowIndex < secondaryRows.length; rowIndex++) {
			const row = secondaryRows[rowIndex];
			const raw = row[next.parent_key];
			if (raw === undefined || raw === null || typeof raw === 'string' && raw.trim() === '') {
				keys.push(null);
				continue;
			}
			const key = normalizeKey(raw, {
				declaration,
				expression: next.parent_key,
				row: rowIndex + 1,
				side: 'secondary',
			});
			keys.push(key);
			const bucket = byParent.get(key);
			if (bucket) bucket.push(row);
			else byParent.set(key, [row]);
		}
		joinedChildren.set(levelIndex, { byParent, keys, matched: new Set<string>() });
	}

	const rows: Row[] = [];
	const countsByLevel: Record<string, number> = {};
	const unparented: Record<string, number> = {};

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

		if ('_cw' in record) {
			throw new SourceStageError(
				'Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.',
				{ declaration: `source.nest.${levelIndex}.children` },
			);
		}
		const emitted: Row = { ...record, _cw: lineage };
		if (typeof entry.children === 'string') delete emitted[entry.children];
		if (entry.leaf !== 'none') rows.push(emitted);

		let children: Row[] = [];
		if (typeof entry.children === 'string') {
			const value = record[entry.children];
			if (value === undefined || value === null || Array.isArray(value) && value.length === 0) return;
			if (!Array.isArray(value)) {
				if (typeof value === 'object') {
					throw new SourceStageError(
						`Nest level "${entry.level}" expects "${entry.children}" to be a list of records; found an object at path ${formatPath(path)}.`,
						{ declaration: `source.nest.${levelIndex}.children` },
					);
				}
				return;
			}
			children = value.filter((child): child is Row => child !== null && typeof child === 'object' && !Array.isArray(child));
		} else if (entry.children && typeof entry.children === 'object') {
			const grouping = joinedChildren.get(levelIndex);
			if (!grouping) return;
			const parentKey = normalizeKey(id, {
				declaration: `source.nest.${levelIndex}.children`,
				expression: entry.id,
				row: countsByLevel[entry.level],
				side: 'primary',
			});
			children = grouping.byParent.get(parentKey) ?? [];
			if (children.length > 0) grouping.matched.add(parentKey);
		} else {
			return;
		}

		for (const child of children) walk(child, levelIndex + 1, path, ancestors);
	};

	for (const row of levelZeroRows) walk(row, 0, [], {});

	for (const [levelIndex, grouping] of joinedChildren) {
		const childLevel = nest[levelIndex + 1]?.level ?? String(levelIndex + 1);
		const count = grouping.keys.reduce(
			(total, key) => total + (key === null || !grouping.matched.has(key) ? 1 : 0),
			0,
		);
		if (count > 0) unparented[childLevel] = count;
	}

	return { rows, countsByLevel, unparented };
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
