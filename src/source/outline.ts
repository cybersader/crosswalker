import type { LineageObject, Row } from './nest';
import { SourceStageError } from './errors';

/** Row-ordered sparse depth columns, independent of the target layout. */
export interface OutlineDeclaration {
	levels: readonly string[];
	id: string;
}

/**
 * Attach lineage before predicates run. Only the active ancestor stack is kept:
 * memory is bounded by the declared depth, never by the number of source rows.
 * Eager and streamed inputs intentionally use the identical walk.
 */
export async function* expandOutlineRows(
	rows: Iterable<Row> | AsyncIterable<Row>,
	outline: OutlineDeclaration,
	renderId: (template: string, row: Row) => string,
): AsyncIterable<Row> {
	const stack: Array<{ id: string; values: Record<string, unknown> }> = [];
	const field = /^\{([^{}|]+)\}$/.exec(outline.id.trim())?.[1]?.trim() ?? 'id';
	let rowNumber = 0;
	for await (const row of rows) {
		rowNumber++;
		const fail = (message: string): never => {
			throw new SourceStageError(message, { declaration: 'source.outline', row: rowNumber });
		};
		if ('_cw' in row) fail('Column "_cw" is reserved for source lineage. Rename it in the source and import again.');
		const filled = outline.levels.flatMap((column, depth) => {
			const value = row[column];
			return value !== undefined && value !== null && String(value).trim() !== '' ? [depth] : [];
		});
		if (filled.length === 0) fail('This row has no filled outline level. Fix the row so exactly one declared depth column has a value.');
		if (filled.length > 1) fail('This row has more than one filled outline level. Fix the row so only its own depth column has a value.');
		const depth = filled[0];
		if (depth > stack.length) {
			fail(`Outline level "${outline.levels[depth]}" has no preceding row at its parent depth. Fix the row order or fill the correct depth column.`);
		}
		let id = '';
		try { id = String(renderId(outline.id, row)).trim(); } catch { /* Named cause and action below. */ }
		if (!id) fail('The outline id template produced an empty id. Fix the id template or fill this row\'s identity value.');
		stack.length = depth;
		stack.push({ id, values: { [field]: id } });
		const lineage: LineageObject = {
			level: outline.levels[depth],
			path: stack.map((entry) => entry.id),
			parent: stack[depth - 1]?.id ?? '',
			ancestors: Object.fromEntries(stack.map((entry, index) => [outline.levels[index], { ...entry.values }])),
		};
		yield { ...row, _cw: lineage };
	}
}
