/** Pure identity-based discovery for the workspace's installed-framework list. */

import { deriveInstalledOntologies, type MinimalVaultNode } from '../src/views/workspace-view-helpers';

const registry = [
	{ id: 'nist-flat', label: 'NIST 800-53 Rev 5', ontology: 'nist-800-53' },
	{ id: 'mitre', label: 'MITRE ATT&CK techniques', ontology: 'mitre-attack' },
];

function generated(path: string, ontologyId: string, extras: Partial<MinimalVaultNode> = {}): MinimalVaultNode {
	return {
		path,
		name: path.slice(path.lastIndexOf('/') + 1),
		producerKind: 'plugin-engine',
		ontologyId,
		...extras,
	};
}

describe('deriveInstalledOntologies', () => {
	it('returns an empty array when the output root does not exist or has no children', () => {
		expect(deriveInstalledOntologies(null, registry)).toEqual([]);
		expect(deriveInstalledOntologies({ path: 'Ontologies', name: 'Ontologies' }, registry)).toEqual([]);
	});

	it('registers a flat import whose generated notes live directly under the output root', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [
				generated('Ontologies/AC-1.md', 'nist-800-53', { recipeId: 'nist-flat', linkCount: 2 }),
				generated('Ontologies/AC-2.md', 'nist-800-53', { recipeId: 'nist-flat', linkCount: 1 }),
			],
		};

		expect(deriveInstalledOntologies(root, registry)).toEqual([{
			id: 'nist-800-53',
			name: 'NIST 800-53 Rev 5',
			noteCount: 2,
			linkCount: 3,
			recipeId: 'nist-flat',
		}]);
	});

	it('groups nested and loose generated notes by ontology identity rather than path', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [
				generated('Ontologies/T1055.md', 'mitre-attack', { recipeId: 'mitre' }),
				{
					path: 'Ontologies/Techniques',
					name: 'Techniques',
					children: [generated('Ontologies/Techniques/T1055.011.md', 'mitre-attack', { recipeId: 'mitre' })],
				},
			],
		};

		expect(deriveInstalledOntologies(root, registry)).toEqual([{
			id: 'mitre-attack',
			name: 'MITRE ATT&CK techniques',
			noteCount: 2,
			linkCount: 0,
			recipeId: 'mitre',
		}]);
	});

	it('keeps two identities separate even when their notes share one folder', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [
				generated('Ontologies/AC-1.md', 'nist-800-53', { recipeId: 'nist-flat' }),
				generated('Ontologies/T1055.md', 'mitre-attack', { recipeId: 'mitre' }),
			],
		};
		expect(deriveInstalledOntologies(root, registry).map((item) => item.id))
			.toEqual(['mitre-attack', 'nist-800-53']);
	});

	it('does not register a hand-authored folder with no Crosswalker provenance', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [{
				path: 'Ontologies/Scratch',
				name: 'Scratch',
				children: [{ path: 'Ontologies/Scratch/note.md', name: 'note.md', ontologyId: 'scratch' }],
			}],
		};
		expect(deriveInstalledOntologies(root, registry)).toEqual([]);
	});

	it('counts notes from any Crosswalker producer, not only the plugin', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [
				generated('Ontologies/NIST-mini/AC-1.md', 'nist-800-53', { producerKind: 'external-cli' }),
				generated('Ontologies/NIST-mini/AC-2.md', 'nist-800-53', { producerKind: 'agent' }),
				generated('Ontologies/MITRE/T1001.md', 'mitre-attack'),
			],
		};
		const ids = deriveInstalledOntologies(root, registry).map((s) => s.id).sort();
		expect(ids).toEqual(['mitre-attack', 'nist-800-53']);
	});

	it('omits junction, crosswalk edge, and mapping set notes even though they carry a CURIE', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: ['junction-note', 'crosswalk-edge', 'mapping-set'].map((noteKind) =>
				generated(`Ontologies/Edges/${noteKind}.md`, 'nist-800-53', { noteKind })),
		};
		expect(deriveInstalledOntologies(root, registry)).toEqual([]);
	});

	it('omits notes with a CURIE but no producer stamp', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [generated('Ontologies/hand.md', 'nist-800-53', { producerKind: '  ' })],
		};
		expect(deriveInstalledOntologies(root, registry)).toEqual([]);
	});

	it('omits generated notes without an ontology identity', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [{ path: 'Ontologies/unknown.md', name: 'unknown.md', producerKind: 'plugin-engine' }],
		};
		expect(deriveInstalledOntologies(root, registry)).toEqual([]);
	});

	it('preserves the underscore-prefixed protected-subtree exclusion', () => {
		const root: MinimalVaultNode = {
			path: 'Ontologies',
			name: 'Ontologies',
			children: [{
				path: 'Ontologies/_licensed',
				name: '_licensed',
				children: [generated('Ontologies/_licensed/CIS/1.1.md', 'cis-v8')],
			}],
		};
		expect(deriveInstalledOntologies(root, registry)).toEqual([]);
	});
});
