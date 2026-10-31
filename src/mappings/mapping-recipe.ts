/** Read-only mapping revision preflight. Callers must finish this before any writes.
 * Shared by stamped standalone refresh and mapping form conversion.
 */
import type { App } from 'obsidian';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { computeRecipeDocumentDigest, computeRecipeHash } from '../generation/hash';
import { countUnindexedMarkdownFiles, type MappingForm } from '../generation/import-set';
import { readNoteFrontmatterState } from '../export/vault-reader';
import { normalizeRecipe, diagnoseCanonicalRecipe } from '../import/recipe-document';
import { importSetRecipePath, readImportSetRecipe, vaultImportSetRecipeFiles } from '../import/import-set-recipes';
import { validateRecipe } from '../validation/validator';
import { formToReadFor, importSetIdOf, readConversionReadState } from './conversion-marker';
import { readMappingTables } from './mapping-table-reader';

export interface MappingRecipeRequest {
 setId: string;
 operation: 'refresh-notes' | 'refresh-table' | 'notes-to-table' | 'table-to-notes' | 'resume';
 /** Child discovery remains the caller's existing parent/producer lookup. */
 expectedParentSet?: string;
 expectedRecipeId?: string;
}
export interface SelectedMappingRecipe {
 original: CrosswalkerImportRecipe;
 provenanceRecipe: { id: string; hash: string; recipe_document_digest: string };
 form: MappingForm;
 paths: string[];
}
/** Explicit boundary: persisted snake_case is never structurally passed to the engine. */
export function mappingRecipeForGeneration(selected: SelectedMappingRecipe): NonNullable<import('../generation/generation-engine').RecipeImportOptions['provenanceRecipe']> {
 return {
  id: selected.provenanceRecipe.id,
  hash: selected.provenanceRecipe.hash,
  recipeDocumentDigest: selected.provenanceRecipe.recipe_document_digest,
 };
}
const DIGEST = /^sha256-[a-f0-9]{64}$/;
function object(value: unknown): Record<string, unknown> | undefined {
 return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function refuse(cause: string): never {
 throw new Error(`Mapping recipe cannot be verified: ${cause}. The set and its saved recipes remain unchanged. Restore the exact original from backup, or import into a new set.`);
}
/** Validate before normalization, then hash the same normalized complete document. */
export function normalizedMappingRecipe(recipe: unknown): CrosswalkerImportRecipe {
 if (!validateRecipe(recipe).valid) refuse('the original recipe is invalid');
 const normalized = normalizeRecipe(recipe as CrosswalkerImportRecipe);
 if (!validateRecipe(normalized).valid || diagnoseCanonicalRecipe(normalized).some(d => d.severity === 'blocking')) refuse('the original recipe has unsupported canonical semantics');
 return normalized;
}

export async function selectMappingRecipe(app: App, request: MappingRecipeRequest): Promise<SelectedMappingRecipe> {
 if (!/^iset-[a-z0-9]{6}$/.test(request.setId)) refuse('the import set identity is invalid');
 if (typeof app.vault.getFiles !== 'function' || typeof app.vault.getMarkdownFiles !== 'function'
  || typeof app.metadataCache?.getFileCache !== 'function') refuse('the complete vault listing is unavailable');
 // Do not wait or reinterpret a cold cache as an empty vault. The caller can retry.
 if (countUnindexedMarkdownFiles(app) > 0) refuse('vault indexing is incomplete; wait for indexing and try again');
 const state = await readConversionReadState(app);
 if (state.unusable.some(m => !m.setIds.length || m.setIds.includes(request.setId))) refuse('a conversion marker is unreadable; recover that conversion first');
 const markers = state.markers.filter(m => m.import_set === request.setId);
 if (markers.length > 1) refuse('conflicting conversion markers exist');
 const marker = markers[0];
 if (marker && request.operation !== 'resume') refuse('an active conversion must finish before refresh or another conversion');
 if (!marker && request.operation === 'resume') refuse('no conversion marker establishes the authoritative form');
 const form: MappingForm = marker ? formToReadFor(marker)
  : request.operation === 'refresh-table' || request.operation === 'table-to-notes' ? 'table' : 'notes';
 const votes: Array<{ path: string; provenance: unknown }> = [];
 const notes: Array<{ path: string; provenance: unknown }> = [];
 for (const file of app.vault.getMarkdownFiles()) {
  const read = await readNoteFrontmatterState(app, file);
  if (read.state === 'unreadable') refuse('note metadata is unreadable; restore readable properties before retrying');
  if (read.state !== 'ok') continue;
  const fm = read.frontmatter;
  if (fm.kind === 'crosswalk-edge' && importSetIdOf(fm._crosswalker) === request.setId) notes.push({ path: file.path, provenance: fm._crosswalker });
 }
 const tables = await readMappingTables(app);
 if (tables.some(t => !t.readable || t.provenance !== 'valid')) refuse('a mapping table has unreadable ownership or provenance');
 const owned = tables.filter(t => importSetIdOf(t.header.crosswalker_provenance) === request.setId);
 if (!marker && (form === 'notes' ? owned.length > 0 : notes.length > 0)) refuse('both mapping forms exist without conversion authority');
 if (form === 'notes') votes.push(...notes);
 else {
  if (owned.length !== 1) refuse('the table form requires exactly one owned table header');
  if (owned[0].errors.length || owned[0].rowErrors.length) refuse('the owned table is incomplete or has unreadable rows');
  votes.push({ path: owned[0].path, provenance: owned[0].header.crosswalker_provenance });
 }
 if (!votes.length) refuse('there are no authoritative mapping assertions');
 if (marker && (form === 'notes' ? votes.length : owned[0].rows.length) !== marker.source_count) refuse('the authoritative conversion population is incomplete');
 if (marker?.phase === 'retiring' && form === 'table' && owned[0].path !== marker.target_path) refuse('the verified target table does not match the conversion marker');
 if (marker?.phase === 'retiring' && form === 'notes' && votes.some(v => marker.target_path && !v.path.startsWith(`${marker.target_path.replace(/\/$/, '')}/`))) refuse('the verified target notes do not match the conversion marker path');
 const stamps = votes.map(vote => {
  const block = object(vote.provenance);
  const stamp = object(block?.recipe);
  if (request.expectedParentSet && object(block?.import_set)?.parent_set !== request.expectedParentSet) refuse('the child set has conflicting parent ownership');
  if (!stamp || typeof stamp.id !== 'string' || !stamp.id.trim() || typeof stamp.hash !== 'string' || !DIGEST.test(stamp.hash)) refuse('the recorded recipe identity or effective hash is corrupt');
  if (request.expectedRecipeId && stamp.id !== request.expectedRecipeId) refuse('the recorded child producer identity does not agree');
  if (!Object.prototype.hasOwnProperty.call(stamp, 'recipe_document_digest')) return { id: stamp.id, hash: stamp.hash, recipe_document_digest: undefined };
  if (typeof stamp.recipe_document_digest !== 'string' || !DIGEST.test(stamp.recipe_document_digest)) refuse('the complete-document stamp is corrupt');
  return { id: stamp.id, hash: stamp.hash, recipe_document_digest: stamp.recipe_document_digest };
 });
 const first = stamps[0];
 if (stamps.some(s => s.id !== first.id || s.hash !== first.hash || s.recipe_document_digest !== first.recipe_document_digest)) refuse('conflicting recipe revisions are recorded across owned assertions');
 // No unstamped history is enabled until actual fixed-clock byte-preservation
 // refresh fixtures prove it. Do not turn a reconstructed recipe into an original.
 if (!first.recipe_document_digest) refuse('legacy recipe history is not yet supported by a proven no-op fixture');
 const files = vaultImportSetRecipeFiles(app);
 const path = importSetRecipePath(request.setId, first.recipe_document_digest)!;
 if (!files) refuse('the original recipe storage is unavailable');
 let exists: boolean;
 try { exists = await files.exists(path); } catch { refuse('the original recipe storage cannot be read'); }
 if (!exists) refuse('the exact retained original is missing');
 const retained = await readImportSetRecipe(files, request.setId, first.recipe_document_digest);
 if (!retained) refuse('the exact retained original is unreadable, invalid or has a different document digest');
 const original = normalizedMappingRecipe(retained);
 if (original.recipe !== first.id) refuse('the retained original recipe identity does not agree');
 const effective = computeRecipeHash(original.target, original.source);
 if (effective !== first.hash) {
  const frozen = [frozenStandaloneRecipe(original), frozenReadableStandaloneRecipe(original)].find(candidate =>
   candidate && candidate.recipe === first.id && computeRecipeHash(candidate.target, candidate.source) === first.hash
   && computeRecipeDocumentDigest(normalizeRecipe(candidate)) === first.recipe_document_digest);
  if (!frozen) refuse('the original effective hash does not agree with the recorded producer');
 }
 return { original, provenanceRecipe: { ...first, recipe_document_digest: first.recipe_document_digest }, form, paths: votes.map(v => v.path).sort() };
}

/** Frozen 2026-10-30 standalone producer representation. Not a reconstruction
 * rule: the ENTIRE normalized snapshot must equal the selected document digest.
 * Keep independent of future bundled defaults. Child runtime hashes remain
 * unsupported until their own exact producer regression is supplied.
 */
function frozenStandaloneRecipe(original: CrosswalkerImportRecipe): CrosswalkerImportRecipe | undefined {
 const managed = original.target.also_emit?.frontmatter?.managed;
 const source = managed?.source_framework;
 const target = managed?.target_framework;
 if (typeof source !== 'string' || typeof target !== 'string') return undefined;
 return {
  recipe: `sssom-${source}-to-${target}`,
  source: { ontology: source, levels: ['mapping'] },
  target: {
   layout: [{ level: 'mapping', mechanism: 'file', template: '{_crosswalker_curie_local_part|slug}.md', kind: 'crosswalk-edge' }],
   also_emit: {
    tags: [`crosswalk/${source}-to-${target}`],
    frontmatter: {
     managed: {
      title: '{subject_id} -> {object_id}', predicate_id: '{predicate_id}', subject_id: '{subject_id}', object_id: '{object_id}',
      subject_note: '{subject_note|optional}', object_note: '{object_note|optional}', subject_label: '{subject_label}', object_label: '{object_label}',
      mapping_justification: '{mapping_justification}', mapping_provider: '{mapping_provider}', mapping_set_id: '{mapping_set_id}', predicate_modifier: '{predicate_modifier}',
      source_framework: source, target_framework: target, sssom_predicate: '{sssom_predicate}', match_confidence: '{confidence|optional|number}',
     },
     user_preserve: ['review_status', 'reviewer', '*notes*'],
    },
    body: [{ template: '{edge_body}', position: 'append', format: 'text' }],
   },
  },
 };
}

/** Frozen 2026-10-31 readable standalone producer. Keep independent of bundled defaults. */
function frozenReadableStandaloneRecipe(original: CrosswalkerImportRecipe): CrosswalkerImportRecipe | undefined {
 const managed = original.target.also_emit?.frontmatter?.managed;
 const source = managed?.source_framework;
 const target = managed?.target_framework;
 if (typeof source !== 'string' || typeof target !== 'string') return undefined;
 return {
  recipe: `sssom-${source}-to-${target}`,
  source: { ontology: source, levels: ['mapping'] },
  target: {
   layout: [{ level: 'mapping', mechanism: 'file', template: '{subject_id|regex(^(?:[^:]*:)?([\\s\\S]*)$)|truncate(60)|name-safe|trim(.)|default(unnamed)} · {object_id|regex(^(?:[^:]*:)?([\\s\\S]*)$)|truncate(60)|name-safe|trim(.)|default(unnamed)} ({_crosswalker_curie_local_part|hash(8)}).md', kind: 'crosswalk-edge' }],
   also_emit: {
    tags: [`crosswalk/${source}-to-${target}`],
    frontmatter: {
     managed: {
      title: '{subject_id} -> {object_id}', predicate_id: '{predicate_id}', subject_id: '{subject_id}', object_id: '{object_id}',
      subject_note: '{subject_note|optional}', object_note: '{object_note|optional}', subject_label: '{subject_label}', object_label: '{object_label}',
      mapping_justification: '{mapping_justification}', mapping_provider: '{mapping_provider}', mapping_set_id: '{mapping_set_id}', predicate_modifier: '{predicate_modifier}',
      source_framework: source, target_framework: target, sssom_predicate: '{sssom_predicate}', match_confidence: '{confidence|optional|number}',
     },
     user_preserve: ['review_status', 'reviewer', '*notes*'],
    },
    body: [{ template: '{edge_body}', position: 'append', format: 'text' }],
   },
  },
 };
}
