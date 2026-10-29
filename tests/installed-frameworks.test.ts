/**
 * Whole-vault framework discovery by note identity: the one answer the status
 * bar, the workspace list and the graph color command share.
 *
 * Regression: the status bar read "no frameworks yet" in vaults built by the
 * command line or the demo builder, because discovery looked only under the
 * output folder setting (default "Ontologies") while those vaults write to
 * "Frameworks/". It also showed zero while Obsidian was still indexing.
 */

import { discoverFrameworksFromCache, type DiscoveryCacheEntry } from '../src/discovery/installed-frameworks';
import { identityFactsFromFrontmatter, deriveInstalledOntologiesFromNotes } from '../src/views/workspace-view-helpers';

type File = { path: string; name: string };

function file(path: string): File {
	return { path, name: path.slice(path.lastIndexOf('/') + 1) };
}

function concept(curie: string, extra: Record<string, unknown> = {}, links = 0): DiscoveryCacheEntry {
	return {
		frontmatter: { curie, _crosswalker: { producer: { kind: 'cli' } }, ...extra },
		frontmatterLinks: Array.from({ length: links }, () => ({})),
	};
}

function discover(entries: [string, DiscoveryCacheEntry | null][]) {
	const map = new Map(entries.map(([p, e]) => [p, e]));
	return discoverFrameworksFromCache(entries.map(([p]) => file(p)), (f) => map.get(f.path));
}

describe('discoverFrameworksFromCache', () => {
	it('finds frameworks outside the output folder (the demo and command line layout)', () => {
		const result = discover([
			['Frameworks/NIST CSF 2.0/GV/GV.OC.md', concept('nist-csf-2:GV.OC', {}, 2)],
			['Frameworks/NIST CSF 2.0/GV/GV.RM.md', concept('nist-csf-2:GV.RM', {}, 1)],
			['Frameworks/MITRE ATT&CK/T1055.md', concept('mitre-attack:T1055')],
			['Notes/my note.md', { frontmatter: { title: 'mine' } }],
		]);
		expect(result.state).toBe('ready');
		if (result.state !== 'ready') return;
		const byId = Object.fromEntries(result.frameworks.map((f) => [f.id, f]));
		expect(Object.keys(byId).sort()).toEqual(['mitre-attack', 'nist-csf-2']);
		expect(byId['nist-csf-2']).toMatchObject({ noteCount: 2, linkCount: 3 });
	});

	it('answers "indexing" while any file has no cache entry, never zero', () => {
		const result = discover([
			['Frameworks/a.md', concept('nist-csf-2:GV')],
			['Frameworks/b.md', null],
		]);
		expect(result).toEqual({ state: 'indexing', pending: 1 });
	});

	it('returns an empty list for a fully indexed vault with no frameworks', () => {
		expect(discover([['Notes/a.md', { frontmatter: undefined }]])).toEqual({ state: 'ready', frameworks: [] });
	});

	it('ignores notes without a producer stamp, even with a curie', () => {
		const result = discover([['Notes/a.md', { frontmatter: { curie: 'nist-csf-2:GV' } }]]);
		expect(result).toEqual({ state: 'ready', frameworks: [] });
	});

	it('does not count bookkeeping notes in underscore folders or relationship notes', () => {
		const result = discover([
			['_crosswalker/import-sets/set.md', concept('nist-csf-2:GV')],
			['Frameworks/_edges/e1.md', concept('nist-csf-2:GV', { kind: 'crosswalk-edge' })],
			['Frameworks/Mappings/m.md', concept('nist-csf-2:GV', { kind: 'crosswalk-edge' })],
		]);
		expect(result).toEqual({ state: 'ready', frameworks: [] });
	});
});

describe('identityFactsFromFrontmatter', () => {
	it('reads the producer, kind, recipe and ontology from the curie', () => {
		expect(identityFactsFromFrontmatter({
			curie: 'nist-800-53:AC-1',
			kind: 'concept',
			_crosswalker: { producer: { kind: 'plugin-engine' }, recipe: { id: 'nist-flat' } },
		})).toEqual({ producerKind: 'plugin-engine', noteKind: 'concept', ontologyId: 'nist-800-53', recipeId: 'nist-flat' });
	});

	it('falls back to the source reference curie', () => {
		expect(identityFactsFromFrontmatter({ _crosswalker: { source_ref: { curie: 'mitre-attack:T1' } } }))
			.toEqual({ ontologyId: 'mitre-attack' });
	});

	it('returns nothing for missing or non-object frontmatter', () => {
		expect(identityFactsFromFrontmatter(undefined)).toEqual({});
		expect(identityFactsFromFrontmatter('x')).toEqual({});
	});
});

describe('deriveInstalledOntologiesFromNotes', () => {
	it('groups by identity regardless of folder', () => {
		const out = deriveInstalledOntologiesFromNotes([
			{ path: 'A/x.md', name: 'x.md', producerKind: 'cli', ontologyId: 'zeta' },
			{ path: 'B/C/y.md', name: 'y.md', producerKind: 'cli', ontologyId: 'zeta' },
		], []);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: 'zeta', noteCount: 2 });
	});
});
