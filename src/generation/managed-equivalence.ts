/**
 * managed-equivalence.ts: the one definition of "running again did not change
 * this note's managed content" (D3, run-again slice 2, R5).
 *
 * Two note texts are managed-content equivalent when, after excluding exactly
 * the things a re-run is allowed to change, nothing else differs:
 *
 *   - `_crosswalker.produced_at` (wall clock of the run)
 *   - `_crosswalker.producer.version` (the plugin build that ran)
 *   - every user_preserve key the caller names (user-owned properties)
 *   - body text outside managed regions (user-authored prose)
 *
 * Everything else is compared: every other frontmatter key, deeply, and the
 * text inside every managed region (`<!-- crosswalker:NAME:start -->` ...
 * `:end -->`), by region name.
 *
 * PURITY. No Obsidian imports and no YAML library: the caller injects the YAML
 * parser (Obsidian's `parseYaml` in the plugin, js-yaml in node tests). That
 * keeps this usable from unit tests, the e2e node process, and slice 3 proofs.
 */

import { scanRegions } from './managed-body';
import { splitNoteText } from './note-text';

export interface ManagedEquivalenceOptions {
	/** Parses a frontmatter YAML block into a plain object. */
	parseYaml: (text: string) => unknown;
	/** Top-level frontmatter keys the user owns; excluded from comparison. */
	userPreserve?: readonly string[];
}

export interface ManagedEquivalenceResult {
	equal: boolean;
	/**
	 * One entry per difference found. Frontmatter differences name the
	 * property path (`frontmatter: title`); region differences name the
	 * region (`region: body`). Stable order: frontmatter first, keys sorted.
	 */
	differences: string[];
}

/** Paths a re-run may legitimately change. Dotted, rooted at the frontmatter. */
const EXCLUDED_PATHS: readonly (readonly string[])[] = [
	['_crosswalker', 'produced_at'],
	['_crosswalker', 'producer', 'version'],
];

export function managedContentEquivalent(
	a: string,
	b: string,
	options: ManagedEquivalenceOptions,
): ManagedEquivalenceResult {
	const differences: string[] = [];
	const left = splitNoteText(a);
	const right = splitNoteText(b);

	const fmA = comparableFrontmatter(left.frontmatterText, options);
	const fmB = comparableFrontmatter(right.frontmatterText, options);
	diffValues(fmA, fmB, [], differences);

	const regionsA = managedRegions(left.body);
	const regionsB = managedRegions(right.body);
	if (regionsA === null || regionsB === null) {
		// A note whose markers cannot be understood has no provable managed
		// content. Fail closed: never call it equivalent unless the bodies are
		// byte-identical.
		if (left.body !== right.body) differences.push('region: markers could not be read');
	} else {
		const names = [...new Set([...regionsA.keys(), ...regionsB.keys()])].sort();
		for (const name of names) {
			if (regionsA.get(name) !== regionsB.get(name)) differences.push(`region: ${name}`);
		}
	}

	return { equal: differences.length === 0, differences };
}

function comparableFrontmatter(text: string, options: ManagedEquivalenceOptions): Record<string, unknown> {
	if (text.trim() === '') return {};
	const parsed = options.parseYaml(text);
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Note properties are not a key-value block.');
	}
	const copy = structuredCloneJson(parsed as Record<string, unknown>);
	for (const key of options.userPreserve ?? []) delete copy[key];
	for (const path of EXCLUDED_PATHS) deletePath(copy, path);
	return copy;
}

function managedRegions(body: string): Map<string, string> | null {
	const scan = scanRegions(body);
	if (!scan.ok) return null;
	const out = new Map<string, string>();
	for (const span of scan.spans) out.set(span.name, body.slice(span.contentStart, span.contentEnd));
	return out;
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
	let node: unknown = root;
	for (let i = 0; i < path.length - 1; i++) {
		if (!isPlainObject(node)) return;
		node = node[path[i]];
	}
	if (isPlainObject(node)) delete node[path[path.length - 1]];
}

function diffValues(a: unknown, b: unknown, path: string[], out: string[]): void {
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const key of keys) diffValues(a[key], b[key], [...path, key], out);
		return;
	}
	if (stableJson(a) !== stableJson(b)) out.push(`frontmatter: ${path.join('.') || '(all)'}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (isPlainObject(value)) {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
	const clone = (v: unknown): unknown => {
		if (v instanceof Date) return v.toISOString();
		if (Array.isArray(v)) return v.map(clone);
		if (isPlainObject(v)) {
			const o: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) o[k] = clone(x);
			return o;
		}
		return v;
	};
	return clone(value) as Record<string, unknown>;
}
