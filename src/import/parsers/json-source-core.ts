/**
 * json-source-core.ts — pure logical-source + iterator reader for nested JSON.
 *
 * Lives in src so BOTH consumers share one implementation (UI first, config as
 * escape hatch — same logic behind both doors):
 *   - the import wizard's JSON parser (src/import/parsers/json-parser.ts)
 *   - the headless harness (tools/generate-fixtures.ts, via the tools/lib/json-source.ts re-export)
 *
 * Iterator grammar (closed, fail-fast — same philosophy as render()):
 *   $.objects[*]                        top-level key, fan out an array
 *   $.catalog.groups[*].controls[*]     nested multi-fan (flattens)
 *   (omitted)                           document root must itself be an array
 * Errors list the keys that ARE available. Indices/filters are rejected —
 * row filtering belongs to `where` clauses.
 *
 * Zero imports — pure data-in/data-out; safe for the plugin bundle.
 */
export interface JsonRowsResult {
	rows: Array<Record<string, unknown>>;
	/** Items the iterator yielded that were not plain objects (skipped). */
	skippedNonObjects: number;
}

interface PathToken {
	key?: string;
	fan: boolean;
}

function tokenizeIterator(iterator: string): PathToken[] {
	const trimmed = iterator.trim();
	if (!trimmed.startsWith('$')) {
		throw new Error(`Iterator must start with "$" (got "${iterator}"). Example: $.objects[*]`);
	}
	let rest = trimmed.slice(1);
	const tokens: PathToken[] = [];
	while (rest.length > 0) {
		if (rest.startsWith('[*]')) {
			tokens.push({ fan: true });
			rest = rest.slice(3);
			continue;
		}
		if (rest.startsWith('.')) {
			rest = rest.slice(1);
			const m = /^[^.[\]]+/.exec(rest);
			if (!m) {
				throw new Error(`Malformed iterator near ".${rest}". Expected a key name after ".".`);
			}
			const key = m[0];
			rest = rest.slice(key.length);
			let fan = false;
			if (rest.startsWith('[*]')) {
				fan = true;
				rest = rest.slice(3);
			}
			tokens.push({ key, fan });
			continue;
		}
		throw new Error(
			`Unsupported iterator syntax at "${rest}" in "${iterator}". ` +
			`Supported: dotted keys + [*] fan-out only (e.g. $.catalog.groups[*].controls[*]). ` +
			`Indices ([0]) and filters ([?...]) are not supported: filter rows with --where instead.`,
		);
	}
	return tokens;
}

function availableKeys(v: unknown): string {
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		return Object.keys(v as Record<string, unknown>).join(', ') || '(none)';
	}
	return `(value is ${Array.isArray(v) ? 'an array' : typeof v})`;
}

/**
 * Walk `root` per the iterator path and return the yielded items (un-coerced).
 * Throws on a missing key (listing the keys that ARE available) or on `[*]`
 * applied to a non-array — fail-fast, same philosophy as render().
 */
export function iterateJsonPath(root: unknown, iterator: string): unknown[] {
	const tokens = tokenizeIterator(iterator);
	let current: unknown[] = [root];
	for (const t of tokens) {
		const next: unknown[] = [];
		for (const node of current) {
			let v: unknown = node;
			if (t.key !== undefined) {
				if (v === null || typeof v !== 'object' || Array.isArray(v)) {
					throw new Error(
						`Iterator key "${t.key}" applied to a non-object (${Array.isArray(v) ? 'array' : typeof v}) in "${iterator}".`,
					);
				}
				v = (v as Record<string, unknown>)[t.key];
				if (v === undefined) {
					throw new Error(
						`Iterator key "${t.key}" not found in "${iterator}". Available keys: ${availableKeys(node)}`,
					);
				}
			}
			if (t.fan) {
				if (!Array.isArray(v)) {
					throw new Error(
						`"[*]" applied to a non-array at "${t.key ?? '$'}" in "${iterator}" (value is ${typeof v}).`,
					);
				}
				next.push(...v);
			} else {
				next.push(v);
			}
		}
		current = next;
	}
	return current;
}

/**
 * Coerce iterator items into source rows. Top-level scalar values become
 * trimmed strings (matching the XLSX reader, so `--map`, `--where`, and the
 * legacy id/title roles behave identically across formats); nested objects
 * and arrays are kept AS-IS so recipe templates can reach into them via
 * dotted paths. Non-object items (scalars yielded by a too-shallow iterator)
 * are skipped and counted.
 */
export function toSourceRows(items: unknown[]): JsonRowsResult {
	const rows: Array<Record<string, unknown>> = [];
	let skippedNonObjects = 0;
	for (const item of items) {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) {
			skippedNonObjects++;
			continue;
		}
		const row: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
			if (v === null || v === undefined) row[k] = '';
			else if (typeof v === 'object') row[k] = v; // nested: keep for dotted templates
			else row[k] = String(v).trim(); // scalar: match the XLSX/CSV string contract
		}
		rows.push(row);
	}
	return { rows, skippedNonObjects };
}

/**
 * Parse a JSON source document into rows. When `iterator` is omitted: a
 * top-level array iterates directly (the degenerate case); a top-level
 * object throws with its keys listed, prompting an explicit --iterator.
 */
export function jsonToRows(jsonText: string, iterator?: string): JsonRowsResult {
	const root: unknown = JSON.parse(jsonText);
	let effective = iterator?.trim();
	if (!effective) {
		if (Array.isArray(root)) {
			effective = '$[*]';
		} else {
			throw new Error(
				`JSON source is an object, not an array: pass --iterator to locate the rows. ` +
				`Top-level keys: ${availableKeys(root)}. Example: --iterator '$.objects[*]'`,
			);
		}
	}
	const items = iterateJsonPath(root, effective);
	return toSourceRows(items);
}
