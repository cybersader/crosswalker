/**
 * csv-exporter.ts — v0.1.7 exporters: concept notes → plain CSV.
 *
 * A note written by a saved recipe exports the source columns that recipe
 * read, rebuilt per column from the destinations the recipe declares (see
 * ./csv-inverse.ts). Which recipe wrote a note comes from the note's own
 * provenance (see ./recipe-for-note.ts), never from where it sits.
 *
 * A note whose recipe cannot be found exports as before: the managed fields
 * (curie, title, parent, children, aliases, tags) plus every other
 * frontmatter key the note carries (spec/tier1.schema.json's concept-note
 * shape is `additionalProperties: true` precisely so recipes can add these).
 *
 * Reuses `Papa.unparse` (papaparse is already a dependency) so quoting and
 * escaping of commas, quotes, and embedded newlines is handled by the same
 * code the CSV import path (src/import/parsers/csv-parser.ts) parses with.
 *
 * Column order: the recipe's columns in the order the recipe first
 * references them (layout, automatic heading, managed frontmatter, body), then
 * the fixed leading columns and any other frontmatter keys, alphabetically.
 * The recipe does not record the source file's own column order, so the
 * recipe's order is the closest faithful answer.
 *
 * Row order: the source row order the import recorded (`source_order`), then
 * path for notes without one.
 */

import Papa from 'papaparse';
import type { App } from 'obsidian';
import { readVaultTree, type ConceptRow, type HubRow, type SkippedNote } from './vault-reader';
import { NoteRecipeResolver, EMPTY_RECIPE_LIBRARY, type RecipeFallbackReason } from './recipe-for-note';
import {
	planRecipeColumns,
	parseManagedBody,
	inverseCell,
	type OmittedColumn,
	type RecipeColumnPlan,
} from './csv-inverse';
import type { RecipeLibraryFiles } from '../import/recipe-library';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';

/** Fixed leading columns of a properties-only row. */
const LEADING_COLUMNS = ['curie', 'title', 'parent', 'children', 'aliases', 'tags'] as const;

/** Keys already surfaced via the leading columns (or not appropriate as a flat CSV cell) — excluded from auto-detected extra columns. */
const RESERVED_KEYS = new Set<string>([...LEADING_COLUMNS, '_crosswalker', 'kind']);

export interface CsvExportOptions {
	/** Explicit column list/order. Default: recipe columns, then LEADING_COLUMNS, then every other frontmatter key seen, alphabetically. */
	columns?: string[];
	/** Where saved recipes live. Default: none saved (built-in recipes still resolve). */
	library?: RecipeLibraryFiles;
}

export interface CsvExportResult {
	csv: string;
	rowCount: number;
	columns: string[];
	skipped: SkippedNote[];
	/** Mapping notes found under the folder. The CSV holds concepts only, so a
	 *  folder of mappings exports nothing and the caller names the right export. */
	mappingCount?: number;
	/** Source columns a recipe declares that cannot be rebuilt exactly. */
	omittedColumns: OmittedColumn[];
	/** Columns read back from a folder or file name for at least one row. */
	recoveredFromNames: string[];
	/** Notes exported as properties only, by why their recipe was not used. */
	fallbacks: Record<RecipeFallbackReason, number>;
	/** True when the folder mixes notes from more than one recipe revision, or recipe and properties-only rows. */
	mixedRecipes: boolean;
}

function emptyFallbacks(): Record<RecipeFallbackReason, number> {
	return { 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 };
}

/** Array values join with `|` (readable, and distinct from CSV's own `,` delimiter so Papa's quoting stays predictable). Scalars stringify as-is. */
function joinValue(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (Array.isArray(v)) return v.map((x) => String(x)).join('|');
	return String(v);
}

/**
 * AM-34 (2026-09-01). The BASE form of a note's curie — set-qualification undone.
 *
 * Set-qualification (`endpoint-v1` -> `set-qualified-v1`, AM-13) puts the import
 * set's id inside the prefix so two releases of one framework occupy different
 * identity spaces. It is a uniform re-prefixing, and every note it touched
 * records the scheme and the id that produced it, so it inverts exactly.
 *
 * Export inverts it. Failure mode prevented: Crosswalker's own export becoming
 * un-importable. The exported `curie` column is what a re-import reads as a
 * declared identity, and a declared identity carrying a set id is (a) not
 * something the source ever asserted and (b) meaningless in any other vault,
 * where that set does not exist. Writing the base form back is what makes
 * export -> import a round-trip identity rather than a refusal.
 *
 * Anything that does not match the recorded transform is returned untouched: a
 * guess about someone else's identifier is worse than leaving it alone.
 */
export function baseFormCurie(curie: string, frontmatter: Record<string, unknown>): string {
	const provenance = frontmatter._crosswalker;
	if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return curie;
	const block = (provenance as Record<string, unknown>).import_set;
	if (!block || typeof block !== 'object' || Array.isArray(block)) return curie;
	const set = block as Record<string, unknown>;
	if (set.scheme !== 'set-qualified-v1') return curie;
	const id = typeof set.id === 'string' ? set.id.trim() : '';
	if (id === '') return curie;
	const colon = curie.indexOf(':');
	if (colon <= 0) return curie;
	const prefix = curie.slice(0, colon);
	const suffix = `-${id}`;
	if (!prefix.endsWith(suffix) || prefix.length === suffix.length) return curie;
	return `${prefix.slice(0, prefix.length - suffix.length)}${curie.slice(colon)}`;
}

function cellValue(col: string, row: ConceptRow): string {
	switch (col) {
		case 'curie':
			// AM-34: the base form, so a re-import of this file is accepted verbatim.
			return baseFormCurie(row.curie, row.frontmatter);
		case 'title':
			return row.title ?? '';
		case 'parent':
			return joinValue(row.parent);
		case 'children':
			return row.children.join('|');
		case 'aliases':
			return row.aliases.join('|');
		case 'tags':
			return row.tags.join('|');
		default:
			return joinValue(row.frontmatter[col]);
	}
}

function sourceOrder(row: ConceptRow): string | undefined {
	const v = row.frontmatter.source_order;
	if (typeof v === 'string' && v !== '') return v;
	if (typeof v === 'number') return String(v);
	return undefined;
}

/** By the source row order the import recorded; notes without one follow, by path. */
function compareRows(a: ConceptRow, b: ConceptRow): number {
	const oa = sourceOrder(a);
	const ob = sourceOrder(b);
	if (oa !== undefined && ob !== undefined && oa !== ob) return oa < ob ? -1 : 1;
	if (oa !== undefined && ob === undefined) return -1;
	if (oa === undefined && ob !== undefined) return 1;
	return a.path.localeCompare(b.path);
}

/** One concept note plus, when its recipe was found, what is needed to rebuild its row. */
export interface RecipeAwareRow {
	row: ConceptRow;
	/** The note's full text. Needed for body sections and the heading. */
	text?: string;
	/** The recipe revision that wrote the note. Absent: export properties only. */
	recipe?: { key: string; recipe: CrosswalkerImportRecipe };
	/** Level values from the folder hubs above the note. */
	hubValues?: Map<string, string>;
}

/**
 * Serialize concept rows into CSV. Pure: no vault I/O. Rows whose recipe is
 * known get its source columns rebuilt; the rest export their properties.
 */
export function recipeAwareRowsToCsv(input: RecipeAwareRow[], options: CsvExportOptions = {}): CsvExportResult {
	const sorted = [...input].sort((a, b) => compareRows(a.row, b.row));

	const plans = new Map<string, RecipeColumnPlan>();
	const recipeColumns: string[] = [];
	/** Frontmatter keys a recipe writes. They are not free-standing source columns. */
	const managedKeys = new Set<string>();
	const omitted = new Map<string, string>();
	for (const item of sorted) {
		if (!item.recipe || plans.has(item.recipe.key)) continue;
		const plan = planRecipeColumns(item.recipe.recipe);
		plans.set(item.recipe.key, plan);
		for (const c of plan.columns) if (!recipeColumns.includes(c.column)) recipeColumns.push(c.column);
		for (const o of plan.omitted) if (!omitted.has(o.column)) omitted.set(o.column, o.reason);
		const frontmatter = item.recipe.recipe.target?.also_emit?.frontmatter as Record<string, unknown> | undefined;
		for (const block of ['managed', 'managed_links']) {
			const keys = frontmatter?.[block];
			if (keys && typeof keys === 'object') for (const key of Object.keys(keys)) managedKeys.add(key);
		}
	}
	// A column one recipe gives back is not omitted, whatever another recipe says.
	for (const c of recipeColumns) omitted.delete(c);

	let columns = options.columns;
	if (!columns) {
		const taken = new Set<string>([...recipeColumns, ...omitted.keys()]);
		const extra = new Set<string>();
		for (const item of sorted) {
			for (const key of Object.keys(item.row.frontmatter)) {
				if (RESERVED_KEYS.has(key) || taken.has(key)) continue;
				// On a recipe row, a key the recipe wrote is already accounted for
				// (given back under its source column, or named as not included).
				if (item.recipe && managedKeys.has(key)) continue;
				extra.add(key);
			}
		}
		const leading = LEADING_COLUMNS.filter((c) => !taken.has(c));
		columns = [...recipeColumns, ...leading, ...Array.from(extra).sort((a, b) => a.localeCompare(b))];
	}
	const finalColumns = columns;
	const recipeColumnSet = new Set(recipeColumns);

	const fromNames = new Set<string>();
	const rows = sorted.map((item) => {
		const record: Record<string, string> = {};
		const plan = item.recipe ? plans.get(item.recipe.key) : undefined;
		const body =
			plan && item.recipe && item.text !== undefined ? parseManagedBody(item.text, plan, item.recipe.recipe) : null;
		const byColumn = new Map((plan?.columns ?? []).map((c) => [c.column, c]));
		for (const col of finalColumns) {
			const colPlan = byColumn.get(col);
			if (colPlan && plan) {
				const cell = inverseCell(
					colPlan,
					{ path: item.row.path, frontmatter: item.row.frontmatter, text: item.text, hubValues: item.hubValues },
					body,
					plan,
				);
				record[col] = cell.value;
				if (cell.fromName) fromNames.add(col);
			} else if (recipeColumnSet.has(col)) {
				// A column from another recipe (or a properties-only row): no value here.
				record[col] = item.recipe ? '' : cellValue(col, item.row);
			} else {
				record[col] = cellValue(col, item.row);
			}
		}
		return record;
	});

	const csv = Papa.unparse(rows, { columns: finalColumns, newline: '\n' });
	return {
		csv,
		rowCount: rows.length,
		columns: finalColumns,
		skipped: [],
		omittedColumns: [...omitted].map(([column, reason]) => ({ column, reason })),
		recoveredFromNames: finalColumns.filter((c) => fromNames.has(c)),
		fallbacks: emptyFallbacks(),
		mixedRecipes: plans.size > 1 || (plans.size === 1 && sorted.some((i) => !i.recipe)),
	};
}

/**
 * Serialize concept rows with no recipe information: every row exports its
 * properties. Pure. Kept for callers that already hold rows.
 */
export function conceptsToCsv(concepts: ConceptRow[], options: CsvExportOptions = {}): CsvExportResult {
	return recipeAwareRowsToCsv(
		concepts.map((row) => ({ row })),
		options,
	);
}

function importSetId(frontmatter: Record<string, unknown>): string | undefined {
	const provenance = frontmatter._crosswalker as Record<string, unknown> | undefined;
	if (!provenance || typeof provenance !== 'object') return undefined;
	const set = provenance.import_set as Record<string, unknown> | undefined;
	return set && typeof set === 'object' && typeof set.id === 'string' ? set.id : undefined;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

/**
 * Level values from every folder hub of the note's own import set that sits in
 * the note's folder or a folder above it. A deeper hub wins for the same level.
 * Hubs are matched by the set id they carry, never by a folder name.
 */
export function hubValuesFor(row: ConceptRow, hubs: HubRow[]): Map<string, string> | undefined {
	const set = importSetId(row.frontmatter);
	if (!set) return undefined;
	const dir = dirOf(row.path);
	const applicable = hubs
		.filter((h) => h.kind === 'hub' && importSetId(h.frontmatter) === set)
		.map((h) => ({ h, dir: dirOf(h.path) }))
		.filter((x) => x.dir === dir || x.dir === '' || dir.startsWith(`${x.dir}/`))
		.sort((a, b) => a.dir.length - b.dir.length);
	const out = new Map<string, string>();
	for (const { h } of applicable) {
		const levels = h.frontmatter.hub_levels;
		const values = h.frontmatter.hub_values;
		if (!Array.isArray(levels) || !Array.isArray(values) || levels.length !== values.length) continue;
		levels.forEach((level, i) => {
			const value: unknown = values[i];
			if (typeof level === 'string' && value !== undefined && value !== null) out.set(level, String(value));
		});
	}
	return out.size > 0 ? out : undefined;
}

async function readNoteText(app: App, path: string): Promise<string | undefined> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !('extension' in file)) return undefined;
	const vault = app.vault as unknown as {
		cachedRead?: (f: unknown) => Promise<string>;
		read: (f: unknown) => Promise<string>;
	};
	try {
		return vault.cachedRead ? await vault.cachedRead(file) : await vault.read(file);
	} catch {
		return undefined;
	}
}

/**
 * Walk `rootPath` and export every concept note under it as a CSV, rebuilding
 * each note's source columns from the recipe its provenance names.
 */
export async function exportFolderAsCsv(
	app: App,
	rootPath: string,
	options: CsvExportOptions = {},
): Promise<CsvExportResult> {
	const tree = await readVaultTree(app, rootPath);
	const resolver = new NoteRecipeResolver(options.library ?? EMPTY_RECIPE_LIBRARY);
	const input: RecipeAwareRow[] = [];
	for (const row of tree.concepts) {
		const found = await resolver.resolve(row.frontmatter);
		if (!found.ok) {
			input.push({ row });
			continue;
		}
		input.push({
			row,
			text: await readNoteText(app, row.path),
			recipe: { key: found.key, recipe: found.recipe },
			hubValues: hubValuesFor(row, tree.hubs),
		});
	}
	const result = recipeAwareRowsToCsv(input, options);
	result.fallbacks = { ...resolver.fallbacks };
	result.skipped.push(...tree.skipped);
	result.mappingCount = tree.crosswalkEdges.length + tree.junctionNotes.length;
	return result;
}
