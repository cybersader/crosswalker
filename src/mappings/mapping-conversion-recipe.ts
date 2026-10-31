/** Closed table transport projection of a verified complete original. Never retained. */
import { render, type Recipe } from '../render';
import { buildDefaultBody } from '../generation/generation-engine';
import { edgeBodyOf } from '../generation/edge-endpoints';
import { derivedEdgeCurie, type MappingTableHeader, type MappingTableRowFacts } from './mapping-table';
import type { SelectedMappingRecipe } from './mapping-recipe';

const INPUTS = new Set(['subject_id', 'predicate_id', 'object_id', 'sssom_predicate', 'predicate_modifier', 'mapping_justification', 'confidence', 'subject_label', 'object_label', 'subject_note', 'object_note', 'mapping_provider', 'mapping_set_id', 'review_status', 'reviewer', 'edge_body', '_crosswalker_curie_local_part']);
function unsupported(reason: string): never {
 throw new Error(`The original mapping recipe cannot be converted with the recorded table inputs: ${reason}. Keep the current form, or import into a new set. Nothing was changed.`);
}
export function conversionManagedKeys(selected: SelectedMappingRecipe): Set<string> {
 return new Set([...Object.keys(selected.original.target.also_emit?.frontmatter?.managed ?? {}), 'review_status', 'reviewer']);
}
export function conversionRecipe(selected: SelectedMappingRecipe, carried = new Map<string, string>(), tags?: string[]): Recipe {
 const base = JSON.parse(JSON.stringify(selected.original)) as Recipe;
 const source = selected.original.source;
 if (Object.keys(source).some(key => !['ontology', 'version', 'levels'].includes(key)) || source.levels.length !== 1 || source.levels[0] !== 'mapping') unsupported('source shaping or multiple levels require unavailable source data');
 if (Object.keys(base.target).some(key => !['layout', 'also_emit', 'linkStyle', 'auto_heading'].includes(key))) unsupported('graph or enrichment dependencies are not represented');
 if (base.target.layout.length !== 1 || base.target.layout[0].mechanism !== 'file' || base.target.layout[0].kind !== 'crosswalk-edge' || Object.keys(base.target.layout[0]).some(key => !['level', 'mechanism', 'template', 'kind'].includes(key))) unsupported('only one mapping file per row is currently reproducible');
 // Even optional placeholders must be source-backed. Successful rendering alone
 // would otherwise hide missing dependencies behind an optional filter.
 const check = (value: unknown): void => {
  if (typeof value === 'string') {
   for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
    const column = match[1].split('|')[0];
    if (!INPUTS.has(column)) unsupported('a template needs a column not carried by the table');
   }
  } else if (Array.isArray(value)) value.forEach(check);
  else if (value && typeof value === 'object') Object.values(value).forEach(check);
 };
 check(base.target);
 const emissions = base.target.also_emit ??= {};
 const frontmatter = emissions.frontmatter ??= {};
 const identity = new Set(['subject_id', 'object_id', 'predicate_id']);
 const managed = { ...frontmatter.managed };
 for (const [key, template] of Object.entries(managed)) {
  const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template);
  if (match && !identity.has(match[1])) managed[key] = `{${match[1]}|optional}`;
 }
 managed.review_status = '{review_status|optional}';
 managed.reviewer = '{reviewer|optional}';
 for (const [key, column] of carried) managed[key] = `{${column}|optional}`;
 frontmatter.managed = managed;
 frontmatter.user_preserve = [];
 if (tags !== undefined) emissions.tags = [...tags];
 return base;
}
export function conversionRow(row: MappingTableRowFacts, carried = new Map<string, string>()): Record<string, unknown> {
 const record: Record<string, unknown> = {};
 for (const key of INPUTS) if (!['edge_body', '_crosswalker_curie_local_part'].includes(key)) record[key] = (row as unknown as Record<string, unknown>)[key] ?? '';
 record.edge_body = edgeBodyOf(row.subject_id, row.predicate_id, row.object_id, row.subject_note ?? '', row.object_note ?? '');
 for (const [key, value] of [...Object.entries(row.notes ?? {}), ...Object.entries(row.extra ?? {})]) {
  const column = carried.get(key);
  if (column) record[column] = value;
 }
 return record;
}
/** Selected-recipe render, not a hardcoded title or a bundled-builder guess. */
export function expectedConvertedNote(selected: SelectedMappingRecipe, header: MappingTableHeader, row: MappingTableRowFacts) {
 const recipe = conversionRecipe(selected, new Map(), header.tags);
 const curie = derivedEdgeCurie(row, header);
 if (!curie) unsupported('the row identity cannot be established');
 const scope = { ...conversionRow(row), _crosswalker_curie_local_part: curie.slice(curie.indexOf(':') + 1) };
 const address = render(recipe, { curie, scope });
 const frontmatter: Record<string, unknown> = { ...address.frontmatter, curie, kind: 'crosswalk-edge' };
 return { address, frontmatter, body: buildDefaultBody(frontmatter, address, recipe, scope) };
}
