import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONVERSION_MARKER_FORMAT, conversionMarkerPath, serializeConversionMarker } from '../src/mappings/conversion-marker';
import * as importSets from '../src/generation/import-set';
import * as importSetRecipes from '../src/import/import-set-recipes';
import * as mappingSets from '../src/mappings/mapping-set';
import { createFsApp } from '../cli/fs-app';
import { loadConnectionsSnapshot, selectConnections, connectionPredicateGloss } from '../src/graph/connections-query';
import { SOURCE, TARGET, MAP, fixture, concept, assertion, note, table, bytes, provenance } from './helpers/connections-fixture';
const roots: string[] = [];
const make = () => { const r = fixture(); roots.push(r); return r; };
const snapshot = (root: string) => loadConnectionsSnapshot(createFsApp(root) as never);
const selection = { sourceSet: SOURCE, targetSet: TARGET };
afterEach(() => { jest.restoreAllMocks(); roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })); });

describe('read-only canonical Connections query', () => {
	it('resolves moved notes by set identity, preserves direction when selectors reverse and never writes', async () => {
		const root = make(); assertion(root, 'Changed names/assertion.md', 'edge:one', { mapping_provider: 'Recorded publisher', subject_label: 'Old source label', sssom_predicate: 'skos:exactMatch' });
		fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true }); fs.writeFileSync(path.join(root, '.obsidian/graph.json'), '{"search":"chosen"}');
		const before = bytes(root), s = await snapshot(root), result = await selectConnections(s, selection);
		expect(result.totals).toMatchObject({ positive: 1, negative: 0, unresolved: 0 });
		expect(result.rows[0].subject).toMatchObject({ title: 'Access policy', path: 'Renamed/Access.md', setId: SOURCE, recordedLabel: 'Old source label' });
		expect(result.rows[0].provenance).toMatchObject({ mapping_provider: 'Recorded publisher', mapping_set_version: null, classification: 'Synthetic/publisher status not recorded.', sssom_predicate: 'skos:exactMatch' });
		const reversed = await selectConnections(s, { sourceSet: TARGET, targetSet: SOURCE });
		expect(reversed.rows).toEqual(result.rows); expect(bytes(root)).toEqual(before);
	});
	it('searches recorded values only, never disclaimer copy, field names or generated glosses', async () => {
		const root = make(); assertion(root, 'empty.md', 'edge:empty', { predicate_id: 'custom:raw_relation', mapping_set_id: 'release:neutral' });
		assertion(root, 'provider.md', 'edge:provider', { mapping_set_id: 'release:neutral', mapping_provider: 'Publisher evidence', mapping_set_description: 'Synthetic study description' });
		const s = await snapshot(root);
		for (const term of ['publisher', 'synthetic']) expect((await selectConnections(s, { ...selection, search: term })).rows.map((r) => r.identity)).toEqual(['edge:provider']);
		for (const term of ['independently verified', 'mapping_provider', 'not recorded', 'same requirement']) expect((await selectConnections(s, { ...selection, search: term })).rows).toHaveLength(0);
		expect((await selectConnections(s, { ...selection, search: 'custom:raw_relation' })).rows.map((r) => r.identity)).toEqual(['edge:empty']);
	});
	it.each([
		['matching', { mapping_set_id: 'release:A' }, true, false],
		['mismatched identity', { mapping_set_id: 'release:B' }, false, true],
		['mismatched version', { mapping_set_id: 'release:A', mapping_set_version: '2' }, false, true],
		['missing identity', { mapping_set_id: undefined }, false, false],
	] as const)('associates release metadata by declared identity: %s', async (_name, extra, associated, conflict) => {
		const root = make(); assertion(root, 'edge.md', 'edge:one', extra);
		const release = mappingSets.buildMappingSetRecord({ mapping_set_id: 'release:A', mapping_set_version: '1', mapping_provider: 'Provider A', subject_source_version: 'A-2026', creator_id: ['author:A'] }, [], MAP);
		jest.spyOn(mappingSets, 'readMappingSet').mockResolvedValue(release);
		const r = (await selectConnections(await snapshot(root), selection)).rows[0];
		expect(r.provenance.mapping_set_id).toBe(extra.mapping_set_id ?? null);
		expect(r.provenance.mapping_provider).toBe(associated ? 'Provider A' : null);
		expect(r.provenance.subject_source_version).toBe(associated ? 'A-2026' : null);
		expect(r.provenance.creator_id).toEqual(associated ? ['author:A'] : null);
		expect(r.provenance.mapping_set_version).toBe('mapping_set_version' in extra ? extra.mapping_set_version : associated ? '1' : null);
		expect(r.provenance.owner_release).toMatchObject({ mapping_set_id: 'release:A', mapping_provider: 'Provider A' });
		expect(r.provenance.release_conflict).toBe(conflict);
	});
	it('keeps explicit row evidence and absent fields distinct from conflicting owner evidence', async () => {
		const root = make(); assertion(root, 'edge.md', 'edge:one', { mapping_set_id: 'release:B', mapping_provider: 'Provider B' });
		jest.spyOn(mappingSets, 'readMappingSet').mockResolvedValue(mappingSets.buildMappingSetRecord({ mapping_set_id: 'release:A', mapping_set_version: '1', mapping_provider: 'Provider A' }, [], MAP));
		const s = await snapshot(root), r = (await selectConnections(s, selection)).rows[0];
		expect(r.provenance).toMatchObject({ mapping_set_id: 'release:B', mapping_provider: 'Provider B', mapping_set_version: null, subject_source_version: null, release_conflict: true });
		expect((await selectConnections(s, { ...selection, search: 'Provider A' })).rows).toHaveLength(0);
		expect((await selectConnections(s, { ...selection, search: 'Provider B' })).rows).toHaveLength(1);
	});
	it('does not invent absent fields for a matching release or a row with no release record', async () => {
		const root = make(); assertion(root, 'edge.md', 'edge:one', { mapping_set_id: 'release:A' });
		jest.spyOn(mappingSets, 'readMappingSet').mockResolvedValue(mappingSets.buildMappingSetRecord({ mapping_set_id: 'release:A' }, [], MAP));
		const r = (await selectConnections(await snapshot(root), selection)).rows[0];
		expect(r.provenance).toMatchObject({ mapping_provider: null, mapping_set_version: null, creator_id: null });
		jest.mocked(mappingSets.readMappingSet).mockResolvedValue(undefined);
		expect((await selectConnections(await snapshot(root), selection)).rows[0].provenance).toMatchObject({ owner_release: null, mapping_provider: null, mapping_set_version: null });
	});
	it('never lets runtime short-link ranking choose a duplicate identity, but honours explicit paths', async () => {
		const root = make(); concept(root, 'Elsewhere/A.md', 'same:A', SOURCE); concept(root, 'Mappings/A.md', 'same:A', SOURCE);
		assertion(root, 'Mappings/edge.md', 'edge:one', { subject_note: '[[A]]' });
		const s = await snapshot(root);
		for (const chosen of ['Elsewhere/A.md', 'Mappings/A.md']) {
			jest.spyOn(s.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(s.app.vault.getAbstractFileByPath(chosen) as never);
			const r = (await selectConnections(s, selection)).rows[0]; expect(r.category).toBe('unresolved'); expect(r.subject.path).toBeUndefined();
		}
		for (const link of ['[[Mappings/A]]', '[[./A]]', '[[../Elsewhere/A.md]]']) {
			assertion(root, 'Mappings/edge.md', 'edge:one', { subject_note: link });
			const r = (await selectConnections(await snapshot(root), selection)).rows[0]; expect(r.category).toBe('resolved'); expect(r.subject.path).toBe(link.includes('Elsewhere') ? 'Elsewhere/A.md' : 'Mappings/A.md');
		}
		fs.renameSync(path.join(root, 'Mappings/A.md'), path.join(root, 'Mappings/Moved.md'));
		assertion(root, 'Mappings/edge.md', 'edge:one', { subject_note: '[[Mappings/A]]' });
		expect((await selectConnections(await snapshot(root), selection)).rows[0].category).toBe('unresolved');
		assertion(root, 'Mappings/edge.md', 'edge:one', { subject_note: '[[Mappings/Moved]]' });
		expect((await selectConnections(await snapshot(root), selection)).rows[0].subject.path).toBe('Mappings/Moved.md');
	});
	it('presents recorded recipe titles and source types, without inferring them from paths or ids', async () => {
		const root = make(), digest = `sha256-${'a'.repeat(64)}`;
		for (const [file, curie, set, recipe] of [['Renamed/Access.md', 'same:A', SOURCE, 'recipe-one'], ['Moved/Backups.md', 'same:B', TARGET, 'recipe-two']]) {
			note(root, file, { curie, kind: 'concept', _crosswalker: { ...provenance(set), recipe: { id: recipe, recipe_document_digest: digest } } });
		}
		jest.spyOn(importSetRecipes, 'readImportSetRecipe').mockImplementation(async (_files, id) => ({ recipe: id === SOURCE ? 'recipe-one' : 'recipe-two', metadata: { title: 'Common recorded title' }, source: { ontology: 'common', levels: [id === SOURCE ? 'technique' : 'mitigation'] }, target: { layout: [] } }));
		const s = await snapshot(root);
		expect(s.choices.find((c) => c.id === SOURCE)?.label).toContain('Common recorded title · Source types: technique');
		expect(s.choices.find((c) => c.id === TARGET)?.label).toContain('Common recorded title · Source types: mitigation');
		expect(s.choices.find((c) => c.id === SOURCE)?.label).toContain(SOURCE);
		jest.mocked(importSetRecipes.readImportSetRecipe).mockResolvedValue(null);
		const missing = await snapshot(root); expect(missing.choices.find((c) => c.id === SOURCE)?.label).toContain('Recipes: recipe-one');
		expect(missing.choices.find((c) => c.id === SOURCE)?.label).not.toContain('technique');
	});
	it('keeps 180 resolved filtered assertions separate from thousands of excluded candidates', async () => {
		const root = make();
		table(root, [...Array.from({ length: 180 }, () => ({ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', mapping_provider: 'Resolved family' })), ...Array.from({ length: 3000 }, (_, n) => ({ subject_id: 'same:A', object_id: `absent:${n}`, predicate_id: 'is_equivalent_to', mapping_provider: 'Other family' }))]);
		const s = await snapshot(root), filtered = await selectConnections(s, { ...selection, search: 'Resolved family' });
		expect(filtered.filteredTotals).toMatchObject({ positive: 180, unresolved: 0, assertions: 180 });
		expect(filtered.totals).toMatchObject({ positive: 180, unresolved: 3000 });
		expect((await selectConnections(s, selection)).filteredTotals).toEqual(filtered.totals);
	});
	it('does not infer membership from a shared prefix or use basename as a title', async () => {
		const root = make(); concept(root, 'Different name.md', 'same:C', 'iset-cccccc');
		assertion(root, 'maps/one.md', 'edge:one', { object_id: 'same:C', object_label: 'Recorded label only' });
		const r = await selectConnections(await snapshot(root), selection);
		expect(r.totals).toMatchObject({ positive: 0, unresolved: 1 }); expect(r.rows[0].object).toMatchObject({ title: 'same:C', state: 'absent-from-selected-sets' });
		expect(r.rows[0].object.path).toBeUndefined();
	});
	it('exposes same-set collisions before a single-value lookup, and validates recorded links', async () => {
		const root = make(); concept(root, 'Duplicate/A.md', 'same:A', SOURCE, 'Duplicate'); assertion(root, 'edge.md', 'edge:one');
		let r = await selectConnections(await snapshot(root), selection);
		expect(r.totals.unresolved).toBe(1); expect(r.rows[0].subject.state).toBe('ambiguous'); expect(r.rows[0].subject.path).toBeUndefined();
		assertion(root, 'edge.md', 'edge:one', { subject_note: '[[Renamed/Access]]', object_note: '[[Wrong identity]]' });
		r = await selectConnections(await snapshot(root), selection); expect(r.totals.resolved).toBe(1);
		assertion(root, 'edge.md', 'edge:one', { subject_note: '[[Moved/Backups]]' });
		r = await selectConnections(await snapshot(root), selection); expect(r.totals.unresolved).toBe(1);
	});
	it('requires disambiguated focus and filters set plus identifier, not identifier alone', async () => {
		const root = make(); concept(root, 'Other release/A.md', 'same:A', TARGET, 'Other A'); concept(root, 'Other release/C.md', 'same:C', SOURCE, 'C');
		assertion(root, 'one.md', 'edge:one', { subject_note: '[[Renamed/Access]]' });
		assertion(root, 'two.md', 'edge:two', { subject_id: 'same:C', object_id: 'same:A', object_note: '[[Other release/A]]' });
		const s = await snapshot(root);
		await expect(selectConnections(s, { ...selection, focusCurie: 'same:A' })).rejects.toThrow('both selected sets');
		expect((await selectConnections(s, { ...selection, focusCurie: 'same:A', focusSet: SOURCE })).rows.map((r) => r.identity)).toEqual(['edge:one']);
		expect((await selectConnections(s, { ...selection, focusCurie: 'same:A', focusSet: TARGET })).rows.map((r) => r.identity)).toEqual(['edge:two']);
	});
	it('treats multiple possible cross-set assignments as ambiguous, but repeated selection itself is not ambiguous', async () => {
		const root = make(); concept(root, 'Release2/A.md', 'same:A', TARGET); concept(root, 'Release1/B.md', 'same:B', SOURCE); assertion(root, 'edge.md', 'edge:one');
		const s = await snapshot(root); expect((await selectConnections(s, selection)).totals.unresolved).toBe(1);
		const within = await selectConnections(s, { sourceSet: SOURCE, targetSet: SOURCE }); expect(within.totals.resolved).toBe(1);
	});
	it('preserves distinct assertion identities/releases and counts overlapping negatives as a union', async () => {
		const root = make();
		for (const [n, extra] of Object.entries({ a: {}, b: { predicate_modifier: 'NOT' }, c: { predicate_id: 'no_relationship' }, d: { predicate_id: 'no_relationship', predicate_modifier: 'NOT' }, e: { predicate_id: 'custom:no_relationship' }, f: { predicate_id: 'custom:is_equivalent_to', mapping_set_id: 'different-release', mapping_set_version: '2' } })) assertion(root, `${n}.md`, `edge:${n}`, extra);
		const r = await selectConnections(await snapshot(root), selection);
		expect(r.totals).toMatchObject({ assertions: 6, positive: 3, negative: 3, not: 2, noRelationship: 2 });
		expect(connectionPredicateGloss('custom:is_equivalent_to')).toContain('not recorded');
		expect(r.rows[5].provenance.mapping_set_version).toBe('2');
	});
	it('keeps stable totals across bounded search/pages without canonical rereads', async () => {
		const root = make(); for (let n = 0; n < 105; n++) assertion(root, `maps/${n}.md`, `edge:${String(n).padStart(3, '0')}`);
		const metadata = jest.spyOn(mappingSets, 'readMappingSet');
		const s = await snapshot(root); expect(metadata).toHaveBeenCalledTimes(1);
		const read = jest.spyOn(s.app.vault, 'read');
		const page = await selectConnections(s, { ...selection, limit: 100 }); expect(page.rows).toHaveLength(100); expect(page.hasMore).toBe(true);
		const next = await selectConnections(s, { ...selection, limit: 100, offset: 100 }); expect(next.rows).toHaveLength(5);
		const search = await selectConnections(s, { ...selection, search: 'edge:104' }); expect(search.totals.assertions).toBe(105); expect(search.filteredTotals.assertions).toBe(1);
		expect(read).not.toHaveBeenCalled();
		for (const extra of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 0.2 }]) await expect(selectConnections(s, { ...selection, ...extra })).rejects.toThrow();
	});
	it('matches notes/table semantics and exposes actual table locator plus row id', async () => {
		const root = make(); table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', predicate_modifier: 'NOT', mapping_provider: 'Recorded provider', mapping_set_id: 'synthetic-release' }]);
		const before = bytes(root), r = await selectConnections(await snapshot(root), selection);
		expect(r.totals).toMatchObject({ resolved: 1, negative: 1 }); expect(r.rows[0].locator).toMatchObject({ kind: 'table', path: 'Moved/mappings.mapping-table.tsv', rowId: expect.any(String) });
		expect(r.rows[0].provenance.mapping_provider).toBe('Recorded provider'); expect(bytes(root)).toEqual(before);
	});
	it('reports malformed whole-table exclusion, unclassified reads and excluded evidence separately', async () => {
		const root = make(); table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to' }]);
		const tablePath = path.join(root, 'Moved/mappings.mapping-table.tsv');
		const lastRow = fs.readFileSync(tablePath, 'utf8').replace(/\r?\n$/, '').split('\n').pop()!;
		fs.appendFileSync(tablePath, `${lastRow}\n`);
		note(root, 'evidence.md', { curie: 'e:one', kind: 'junction-note', subject: '[[Renamed/Access]]', predicate: 'supports', object: '[[Moved/Backups]]' });
		fs.writeFileSync(path.join(root, 'plain.md'), 'Plain note.'); assertion(root, 'candidate.md', 'edge:missing', { object_id: 'same:missing', _crosswalker: provenance('iset-nnnnnn') });
		const r = await selectConnections(await snapshot(root), selection);
		expect(r.coverage.complete).toBe(false); expect(r.coverage.mappingExclusions).toHaveLength(1); expect(r.coverage.unclassifiedSkips).toHaveLength(1); expect(r.coverage.junctionNotesNotEvaluated).toBe(1);
		expect(r.totals).toMatchObject({ assertions: 1, unresolved: 1 }); expect(r.rows[0].object.state).toBe('unreadable-evidence');
	});
	it('does not turn discovery errors into zero connections, and honours cancellation', async () => {
		const root = make(); assertion(root, 'one.md', 'edge:a'); table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to' }]);
		await expect(snapshot(root)).rejects.toMatchObject({ details: { cause: 'The same imported set is recorded in conflicting storage forms.', paths: expect.arrayContaining(['one.md', 'Moved/mappings.mapping-table.tsv']), action: expect.stringContaining('conversion') } });
		const c = new AbortController(); c.abort(); await expect(loadConnectionsSnapshot(createFsApp(root) as never, c.signal)).rejects.toThrow('cancelled');
	});
	it('uses the canonical conversion form exactly once, including partial conversions', async () => {
		const root = make(); assertion(root, 'original.md', 'edge:original');
		table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', predicate_modifier: 'NOT' }]);
		const markerPath = conversionMarkerPath('Moved', MAP);
		const marker = { format: CONVERSION_MARKER_FORMAT, import_set: MAP, from: 'notes' as const, to: 'table' as const, phase: 'writing' as const, target_path: 'Moved/mappings.mapping-table.tsv', source_count: 1, started_at: '2026-10-30T00:00:00.000Z', plugin_version: '0.0.0-test', path: markerPath };
		fs.writeFileSync(path.join(root, markerPath), serializeConversionMarker(marker));
		const writing = await selectConnections(await snapshot(root), selection);
		expect(writing.rows).toHaveLength(1); expect(writing.rows[0].locator.kind).toBe('note'); expect(writing.totals.positive).toBe(1);
		fs.writeFileSync(path.join(root, markerPath), serializeConversionMarker({ ...marker, phase: 'retiring' }));
		const retiring = await selectConnections(await snapshot(root), selection);
		expect(retiring.rows).toHaveLength(1); expect(retiring.rows[0].locator.kind).toBe('table'); expect(retiring.totals.negative).toBe(1);
	});
	it('does not include the wrong focus set when opposite membership uniquely resolves an unlinked endpoint', async () => {
		const root = make(); concept(root, 'Other A.md', 'same:A', TARGET); concept(root, 'Source C.md', 'same:C', SOURCE);
		assertion(root, 'edge.md', 'edge:one', { object_id: 'same:C' });
		const s = await snapshot(root);
		expect((await selectConnections(s, { ...selection, focusCurie: 'same:A', focusSet: SOURCE })).rows).toHaveLength(0);
		expect((await selectConnections(s, { ...selection, focusCurie: 'same:A', focusSet: TARGET })).rows).toHaveLength(1);
		const cancel = new AbortController(); cancel.abort(); const before = bytes(root);
		await expect(selectConnections(s, selection, cancel.signal)).rejects.toThrow('cancelled'); expect(bytes(root)).toEqual(before);
	});
	it('reports indexing explicitly before discovery, never as an empty list', async () => {
		const root = make();
		jest.spyOn(importSets, 'requireVaultIndexed').mockRejectedValueOnce(new importSets.VaultStillIndexingError(1));
		await expect(snapshot(root)).rejects.toBeInstanceOf(importSets.VaultStillIndexingError);
	});
	it('rejects unknown sets and invalid focus rather than broadening', async () => {
		const root = make(); const s = await snapshot(root);
		for (const extra of [{ sourceSet: 'unknown' }, { focusSet: SOURCE }, { focusCurie: 'missing' }, { focusCurie: 'same:A', focusSet: TARGET }]) await expect(selectConnections(s, { ...selection, ...extra })).rejects.toThrow();
	});
});
