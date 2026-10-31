import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { buildSyntheticRecipe } from '../src/import/sssom-importer';
import { normalizeRecipe, serializeCanonicalRecipe } from '../src/import/recipe-document';
import { computeRecipeDocumentDigest, computeRecipeHash } from '../src/generation/hash';
import { importSetRecipePath } from '../src/import/import-set-recipes';
import { selectMappingRecipe } from '../src/mappings/mapping-recipe';
import { mappingTableFromContent } from '../src/mappings/mapping-table-reader';
import { MAPPING_TABLE_FORMAT, serializeMappingTable, assignMappingRowIds } from '../src/mappings/mapping-table';
import { CONVERSION_MARKER_FORMAT, serializeConversionMarker, type ConversionPhase } from '../src/mappings/conversion-marker';

const SET = 'iset-abc123';
const runtime = () => buildSyntheticRecipe('demo-a', 'demo-b');
function fixture() {
 const bytes = new Map<string, string>();
 const fm = new Map<string, Record<string, unknown>>();
 const recipe = normalizeRecipe(runtime());
 const digest = computeRecipeDocumentDigest(recipe);
 const stamp = { id: recipe.recipe, hash: computeRecipeHash(runtime().target, runtime().source), recipe_document_digest: digest };
 const provenance = () => ({ recipe: { ...stamp }, import_set: { id: SET, scheme: 'endpoint-v1' } });
 const add = (path: string, kind = 'crosswalk-edge', block = provenance()) => { bytes.set(path, 'synthetic'); fm.set(path, { kind, _crosswalker: block }); };
 bytes.set(importSetRecipePath(SET, digest)!, serializeCanonicalRecipe(recipe));
 add('moved/assertion.md');
 const files = () => [...bytes.keys()].map(path => new TFile(path));
 const app = { vault: {
  getFiles: files, getMarkdownFiles: () => files().filter(f => f.path.endsWith('.md')),
  read: async (f: TFile) => { if (!bytes.has(f.path)) throw new Error('unreadable'); return bytes.get(f.path)!; },
  adapter: { exists: async (p: string) => bytes.has(p), read: async (p: string) => bytes.get(p)!, write: jest.fn(), mkdir: jest.fn() },
 }, metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: fm.get(f.path) }) } } as unknown as App;
 const table = (hash = stamp.hash) => {
  const header = { crosswalker_format: MAPPING_TABLE_FORMAT, crosswalker_provenance: { ...provenance(), import_set: { id: SET, scheme: 'endpoint-v1', mapping_form: 'table' }, recipe: { ...stamp, hash } } };
  const text = serializeMappingTable(header, assignMappingRowIds([{ subject_id: 'demo-a:X', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y' }]));
  expect(mappingTableFromContent('target.mapping-table.tsv', text).errors).toEqual([]);
  bytes.set('target.mapping-table.tsv', text);
 };
 return { app, bytes, fm, recipe, digest, stamp, add, table };
}

describe('operation-aware mapping recipe selection (read only)', () => {
 it('accepts actual runtime pre-normalization hash with complete normalized retained original', async () => {
  const f = fixture();
  expect(f.stamp.hash).not.toBe(computeRecipeHash(f.recipe.target, f.recipe.source));
  const before = new Map(f.bytes);
  const selected = await selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' });
  expect(selected.provenanceRecipe).toEqual(f.stamp);
  expect(selected.original).toEqual(f.recipe);
  expect(f.bytes).toEqual(before);
 });
 it('accepts canonical effective hashes and custom retained layouts without current-default substitution', async () => {
  const f = fixture();
  f.recipe.target.layout[0].template = 'custom-{subject_id|slug}.md';
  const digest = computeRecipeDocumentDigest(f.recipe);
  const stamp = { id: f.recipe.recipe, hash: computeRecipeHash(f.recipe.target, f.recipe.source), recipe_document_digest: digest };
  f.bytes.set(importSetRecipePath(SET, digest)!, serializeCanonicalRecipe(f.recipe));
  f.fm.get('moved/assertion.md')!._crosswalker = { import_set: { id: SET }, recipe: stamp };
  expect((await selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).original).toEqual(f.recipe);
 });
 it('rejects output changes disguised as the frozen runtime hash before any writes', async () => {
  const f = fixture();
  f.recipe.target.layout[0].template = 'different.md';
  const digest = computeRecipeDocumentDigest(f.recipe);
  f.bytes.set(importSetRecipePath(SET, digest)!, serializeCanonicalRecipe(f.recipe));
  f.fm.get('moved/assertion.md')!._crosswalker = { import_set: { id: SET }, recipe: { ...f.stamp, recipe_document_digest: digest } };
  const before = new Map(f.bytes);
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/effective hash/);
  expect(f.bytes).toEqual(before);
  expect(f.app.vault.adapter.write).not.toHaveBeenCalled();
 });
 it.each([undefined, '', null, 42, 'sha256-bad'])('distinguishes missing and corrupt document stamps (%p)', async value => {
  const f = fixture();
  const stamp: Record<string, unknown> = { ...f.stamp };
  if (value === undefined) delete stamp.recipe_document_digest; else stamp.recipe_document_digest = value;
  f.fm.get('moved/assertion.md')!._crosswalker = { import_set: { id: SET }, recipe: stamp };
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(value === undefined ? /legacy/ : /corrupt/);
 });
 it('includes orphan assertions but excludes release and concept votes', async () => {
  const f = fixture();
  f.add('release.md', 'mapping-set', { recipe: { ...f.stamp, hash: 'invalid' }, import_set: { id: SET, scheme: 'endpoint-v1' } });
  f.add('concept.md', 'concept', { recipe: { ...f.stamp, hash: 'invalid' }, import_set: { id: SET, scheme: 'endpoint-v1' } });
  expect((await selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).paths).toEqual(['moved/assertion.md']);
  f.add('orphan.md', 'crosswalk-edge', { recipe: { ...f.stamp, hash: computeRecipeHash(f.recipe.target, f.recipe.source) }, import_set: { id: SET, scheme: 'endpoint-v1' } });
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/conflicting/);
 });
 it.each(['missing', 'corrupt', 'id'] as const)('refuses %s retained original', async issue => {
  const f = fixture(); const path = importSetRecipePath(SET, f.digest)!;
  if (issue === 'missing') f.bytes.delete(path);
  if (issue === 'corrupt') f.bytes.set(path, '{}');
  if (issue === 'id') (f.fm.get('moved/assertion.md')!._crosswalker as { recipe: { id: string } }).recipe.id = 'wrong-id';
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/original/);
 });
 it('does not use release notes to establish an empty assertion population', async () => {
  const f = fixture(); f.fm.get('moved/assertion.md')!.kind = 'mapping-set';
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/no authoritative/);
 });
 it.each(['writing', 'verifying', 'retiring'] as ConversionPhase[])('uses canonical conversion authority in %s', async phase => {
  const f = fixture();
  f.table(phase === 'retiring' ? f.stamp.hash : computeRecipeHash(f.recipe.target, f.recipe.source));
  if (phase === 'retiring') (f.fm.get('moved/assertion.md')!._crosswalker as { recipe: { hash: string } }).recipe.hash = 'partial-source';
  f.bytes.set(`${SET}.converting.json`, serializeConversionMarker({ format: CONVERSION_MARKER_FORMAT, import_set: SET, from: 'notes', to: 'table', phase, target_path: 'target.mapping-table.tsv', source_count: 1, started_at: '', plugin_version: '', path: `${SET}.converting.json` }));
  const selected = await selectMappingRecipe(f.app, { setId: SET, operation: 'resume' });
  expect(selected.form).toBe(phase === 'retiring' ? 'table' : 'notes');
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/conversion/);
 });
 it.each((['notes', 'table'] as const).flatMap(from => (['writing', 'verifying', 'retiring'] as const).map(phase => ({ from, phase }))))('selects $from conversion authority in $phase without partial-form votes', async ({ from, phase }) => {
  const f = fixture(); f.table();
  const to = from === 'notes' ? 'table' : 'notes';
  const authority = phase === 'retiring' ? to : from;
  if (authority === 'table') (f.fm.get('moved/assertion.md')!._crosswalker as { recipe: { hash: string } }).recipe.hash = 'partial-notes';
  else { const parsed = JSON.parse(JSON.stringify(f.stamp)); parsed.hash = computeRecipeHash(f.recipe.target, f.recipe.source); f.table(parsed.hash); }
  const target = to === 'table' ? 'target.mapping-table.tsv' : 'moved';
  f.bytes.set(`${SET}.converting.json`, serializeConversionMarker({ format: CONVERSION_MARKER_FORMAT, import_set: SET, from, to, phase, target_path: target, source_count: 1, started_at: '', plugin_version: '', path: `${SET}.converting.json` }));
  const before = new Map(f.bytes);
  const selected = await selectMappingRecipe(f.app, { setId: SET, operation: 'resume' });
  expect(selected.form).toBe(authority); expect(selected.provenanceRecipe).toEqual(f.stamp); expect(f.bytes).toEqual(before);
 });
 it.each(['count', 'target-path', 'duplicate-marker'] as const)('refuses a %s mismatch before resumed mutation', async mismatch => {
  const f = fixture(); f.table();
  const marker = { format: CONVERSION_MARKER_FORMAT, import_set: SET, from: 'notes' as const, to: 'table' as const, phase: 'retiring' as const, target_path: mismatch === 'target-path' ? 'other.mapping-table.tsv' : 'target.mapping-table.tsv', source_count: mismatch === 'count' ? 2 : 1, started_at: '', plugin_version: '', path: `${SET}.converting.json` };
  f.bytes.set(marker.path, serializeConversionMarker(marker));
  if (mismatch === 'duplicate-marker') f.bytes.set(`duplicate/${marker.path}`, serializeConversionMarker(marker));
  const before = new Map(f.bytes);
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'resume' })).rejects.toThrow(/conversion|marker/);
  expect(f.bytes).toEqual(before);
 });
 it('requires exactly one complete owned table header, not row votes', async () => {
  const f = fixture(); f.bytes.delete('moved/assertion.md'); f.table();
  expect((await selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-table' })).form).toBe('table');
  f.bytes.set('duplicate.mapping-table.tsv', f.bytes.get('target.mapping-table.tsv')!);
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-table' })).rejects.toThrow(/exactly one/);
 });
 it('refuses unavailable listings and unreadable metadata rather than assuming absence', async () => {
  const f = fixture(); f.app.vault.getFiles = undefined as never;
  await expect(selectMappingRecipe(f.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/listing/);
  const g = fixture(); g.app.metadataCache.getFileCache = () => null;
  await expect(selectMappingRecipe(g.app, { setId: SET, operation: 'refresh-notes' })).rejects.toThrow(/index/);
 });
});
