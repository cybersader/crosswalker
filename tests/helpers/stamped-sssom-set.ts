/** Synthetic existing-set fixture produced by the real engine, including its retained original. */
import type { App } from 'obsidian';
import { generateFromRecipe } from '../../src/generation/generation-engine';
import { buildSyntheticRecipe, sssomEdgeCurie } from '../../src/import/sssom-importer';
import type { ImportSetScheme } from '../../src/generation/import-set';
export async function seedStampedSssomSet(app: App, id: string, scheme: ImportSetScheme) {
 const row = { subject_id: 'x:A', object_id: 'y:B', predicate_id: 'is_equivalent_to', subject_label: 'A', object_label: 'B', mapping_justification: 'semapv:ManualMappingCuration', confidence: '1', mapping_provider: '', mapping_set_id: 'release:one', predicate_modifier: '', sssom_predicate: 'skos:exactMatch', edge_body: '`x:A` is_equivalent_to `y:B`' };
 const result = await generateFromRecipe(app, { columns: Object.keys(row), rows: [row], rowCount: 1 }, buildSyntheticRecipe('x', 'y'), {
  basePath: '_crosswalker/mappings/x-to-y', importSet: { id, scheme } as never, overwriteMode: 'replace', createFolders: true,
  curieLocalPart: (record, _row, set) => sssomEdgeCurie(record, set), curiePrefix: 'sssom', strictValidation: true,
 });
 expect(result.errors).toEqual([]); expect(result.success).toBe(true); expect(result.runRecipeKeepFailed).not.toBe(true);
}
