import * as Obsidian from 'obsidian';
import { TFile } from 'obsidian';
import {
	CURRENT_IMPORT_SET_SCHEME,
	ImportSetProvenanceError,
	discoverImportSets,
	mintImportSetId,
	recoverImportSetRoot,
	resolveImportSet,
} from '../src/generation/import-set';

interface Stamp {
	id?: string;
	scheme?: string;
	raw?: unknown;
}

function mockApp(notes: Record<string, Stamp | null>, rawContents: Record<string, string> = {}) {
	const paths = Array.from(new Set([...Object.keys(notes), ...Object.keys(rawContents)]));
	const files = paths.map((path) => new TFile(path));
	const cachedRead = jest.fn(async (file: { path: string }) => rawContents[file.path] ?? '');
	return {
		vault: {
			getMarkdownFiles: () => files,
			cachedRead,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				if (Object.prototype.hasOwnProperty.call(rawContents, file.path)) return undefined;
				const stamp = notes[file.path];
				if (stamp === null) return { frontmatter: { curie: 'legacy:X', _crosswalker: {} } };
				if (stamp === undefined) return undefined;
				const importSet = stamp.raw !== undefined
					? stamp.raw
					: { id: stamp.id, scheme: stamp.scheme };
				return { frontmatter: { _crosswalker: { import_set: importSet } } };
			},
		},
	} as any;
}

/** A note whose provenance also records the destination the set was written to. */
function stampedWithDestination(id: string, destination: string, scheme = 'endpoint-v1'): string {
	return `---\n_crosswalker:\n  import_set:\n    id: ${id}\n    scheme: ${scheme}\n    destination: "${destination}"\n---\n# Generated\n`;
}

function rawStampedNote(id: string, scheme = 'endpoint-v1'): string {
	return `---\n_crosswalker:\n  import_set:\n    id: ${id}\n    scheme: ${scheme}\n---\n# Generated\n`;
}

describe('import-set ownership discovery and selection', () => {
	it('ignores unstamped legacy notes and scopes discovery to the destination', async () => {
		const app = mockApp({
			'Frameworks/legacy.md': null,
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Frameworks/Sub/B.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Other/C.md': { id: 'iset-def456', scheme: 'endpoint-v1' },
		});

		await expect(discoverImportSets(app, 'Frameworks')).resolves.toEqual([{
			id: 'iset-abc123',
			scheme: CURRENT_IMPORT_SET_SCHEME,
			noteCount: 2,
			paths: ['Frameworks/A.md', 'Frameworks/Sub/B.md'],
			// No note recorded a destination (these predate the stamp), so the root
			// is recovered from the paths: the deepest folder both notes sit under.
			root: 'Frameworks',
			// Neither note records what produced it, so the two matching keys are
			// empty rather than absent: a set nothing can be matched against.
			recipeIds: [],
			ontologyPrefixes: [],
		}]);
	});

	it('discovers a destination note whose metadata cache is not warm', async () => {
		const app = mockApp({}, {
			'Frameworks/A.md': rawStampedNote('iset-abc123'),
		});

		await expect(discoverImportSets(app, 'Frameworks')).resolves.toEqual([{
			id: 'iset-abc123',
			scheme: 'endpoint-v1',
			noteCount: 1,
			paths: ['Frameworks/A.md'],
			root: 'Frameworks',
			recipeIds: [],
			ontologyPrefixes: [],
		}]);
		expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('mints again on an immediate cache-cold re-import rather than adopting what it finds', async () => {
		// AM-9: the engine has no opinion about what is in the folder. A caller that
		// wants the first set refreshed passes its id; passing nothing means mint.
		const files: TFile[] = [];
		const contents = new Map<string, string>();
		const app = {
			vault: {
				getMarkdownFiles: () => files,
				cachedRead: jest.fn(async (file: { path: string }) => contents.get(file.path) ?? ''),
			},
			metadataCache: { getFileCache: () => undefined },
		} as any;

		const first = await resolveImportSet(app, 'Frameworks');
		files.push(new TFile('Frameworks/A.md'));
		contents.set('Frameworks/A.md', rawStampedNote(first.id, first.scheme));

		const second = await resolveImportSet(app, 'Frameworks');
		expect(second.id).not.toBe(first.id);
		expect(second.scheme).toBe('endpoint-v1');

		// The explicit choice still refreshes the first set.
		await expect(resolveImportSet(app, 'Frameworks', { id: first.id })).resolves.toMatchObject({
			id: first.id,
			scheme: first.scheme,
		});
	});

	it('throws a provenance error with the path for malformed cache-cold YAML', async () => {
		const app = mockApp({}, {
			'Frameworks/bad.md': '---\n_crosswalker: [\n---\n',
		});
		const parseSpy = jest.spyOn(Obsidian, 'parseYaml').mockImplementationOnce(() => {
			throw new Error('bad YAML');
		});
		try {
			await expect(discoverImportSets(app, 'Frameworks')).rejects.toMatchObject({
				name: 'ImportSetProvenanceError',
				paths: ['Frameworks/bad.md'],
				message: expect.stringContaining('Frameworks/bad.md'),
			});
		} finally {
			parseSpy.mockRestore();
		}
	});

	it('never raw-reads cache-cold files outside the destination', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		}, {
			'Other/cache-cold.md': rawStampedNote('iset-def456'),
		});

		await expect(discoverImportSets(app, 'Frameworks')).resolves.toHaveLength(1);
		expect(app.vault.cachedRead).not.toHaveBeenCalled();
	});

	it('mints a new set whatever the destination already holds', async () => {
		// AM-9. One set in the folder used to mean "refresh it" and two used to mean
		// "refuse". Both were the engine answering an ownership question nobody asked
		// it, and the one-set answer is how a second framework was written into the
		// first. Neither branch exists; the destination is an address, not an owner.
		const one = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		});
		// AM-27 (2026-08-31): a mint is the one place the current identity-derivation
		// rule enters a vault, so every minted reference carries the pin. Asserted
		// with toEqual rather than toMatchObject so a mint that stopped pinning, or
		// pinned something else, fails here.
		await expect(resolveImportSet(one, 'Frameworks')).resolves.toEqual({
			id: expect.stringMatching(/^iset-[a-z0-9]{6}$/), scheme: 'endpoint-v1', destination: 'Frameworks',
			derivation: 'declared-facts-v1',
		});
		await expect(resolveImportSet(one, 'Frameworks')).resolves.not.toMatchObject({ id: 'iset-abc123' });

		const many = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Frameworks/B.md': { id: 'iset-def456', scheme: 'endpoint-v1' },
		});
		const resolved = await resolveImportSet(many, 'Frameworks');
		expect(['iset-abc123', 'iset-def456']).not.toContain(resolved.id);
		expect(resolved.destination).toBe('Frameworks');
	});

	it('allows explicit empty-set refresh and new-set minting', async () => {
		const app = mockApp({
			'Other/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		});
		// AM-27: an explicit id whose notes this call did not see keeps NO derivation.
		// Absence is the legacy rule, and "no observations" is not proof of "no
		// notes" - the cache may simply not have reached them yet.
		await expect(resolveImportSet(app, 'Frameworks', { id: 'iset-zzzz99' })).resolves.toEqual({
			id: 'iset-zzzz99', scheme: 'endpoint-v1', destination: 'Frameworks',
		});
		// A mint, by contrast, pins the current rule on both schemes.
		await expect(resolveImportSet(app, 'Frameworks', 'new')).resolves.toEqual({
			id: expect.stringMatching(/^iset-[a-z0-9]{6}$/), scheme: 'endpoint-v1', destination: 'Frameworks',
			derivation: 'declared-facts-v1',
		});
		await expect(resolveImportSet(app, 'Frameworks', 'new-set-qualified')).resolves.toEqual({
			id: expect.stringMatching(/^iset-[a-z0-9]{6}$/), scheme: 'set-qualified-v1', destination: 'Frameworks',
			derivation: 'declared-facts-v1',
		});
	});

	it('reports every path when one set disagrees on scheme', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Frameworks/B.md': { id: 'iset-abc123', scheme: 'set-qualified-v1' },
		});
		await expect(discoverImportSets(app, 'Frameworks')).rejects.toThrow(ImportSetProvenanceError);
		try {
			await discoverImportSets(app, 'Frameworks');
		} catch (error) {
			expect((error as ImportSetProvenanceError).paths).toEqual([
				'Frameworks/A.md',
				'Frameworks/B.md',
			]);
		}
	});

	it('accepts a set whose fixed scheme is known but is not the default', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'set-qualified-v1' },
			'Frameworks/B.md': { id: 'iset-abc123', scheme: 'set-qualified-v1' },
		});

		await expect(discoverImportSets(app, 'Frameworks')).resolves.toEqual([{
			id: 'iset-abc123',
			scheme: 'set-qualified-v1',
			noteCount: 2,
			paths: ['Frameworks/A.md', 'Frameworks/B.md'],
			root: 'Frameworks',
			recipeIds: [],
			ontologyPrefixes: [],
		}]);
		await expect(resolveImportSet(app, 'Frameworks', { id: 'iset-abc123' })).resolves.toEqual({
			id: 'iset-abc123', scheme: 'set-qualified-v1', destination: 'Frameworks',
		});
	});

	it('refuses to change an existing set scheme during refresh', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		});

		await expect(resolveImportSet(app, 'Frameworks', {
			id: 'iset-abc123', scheme: 'set-qualified-v1',
		})).rejects.toThrow(/refresh cannot change/);
	});

	it('rejects a set whose single scheme is not in the closed enum', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'future-v1' },
		});
		await expect(discoverImportSets(app, 'Frameworks')).rejects.toThrow(/unsupported schemes/);
	});

	it('does not let malformed provenance for an unrelated set block an explicit refresh', async () => {
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Other/bad.md': { raw: { id: 'not-valid', scheme: 'future-v1' } },
		});
		await expect(resolveImportSet(app, 'Frameworks', { id: 'iset-abc123' })).resolves.toEqual({
			id: 'iset-abc123', scheme: 'endpoint-v1', destination: 'Frameworks',
		});
	});

	it('uses secure random bytes and retries a colliding id', () => {
		let call = 0;
		const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
			array.fill(call++);
			return array;
		}) as typeof globalThis.crypto.getRandomValues);
		try {
			expect(mintImportSetId(new Set(['iset-aaaaaa']))).toBe('iset-bbbbbb');
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});
});

// ===========================================================================
// F-1: a set's root is RECORDED going forward and RECOVERED for legacy vaults.
//
// The damage this closes: a refresh had no way to ask where its own set already
// lives. Provenance stamped {id, scheme} and no destination, so the wizard fell
// through to a derived default. For a vault that imported before the per-import
// root rule existed, the derived default names a folder the set's notes are not
// in, and writing there does not relocate the import: it forks it.
// ===========================================================================

describe('recoverImportSetRoot -- the deepest folder every note sits under', () => {
	it('compares whole path SEGMENTS, so two sibling roots with a shared name prefix never merge', () => {
		// The falsifying case for a common-string-prefix implementation, which
		// returns 'Frameworks/NIST-min' here: a folder NEITHER set lives in.
		// A refresh sent there writes a third copy of the import.
		const root = recoverImportSetRoot([
			'Frameworks/NIST-mini/AC-2.md',
			'Frameworks/NIST-minimal/AC-3.md',
		]);
		expect(root).toBe('Frameworks');
		expect(root).not.toBe('Frameworks/NIST-min');
	});

	it('does not merge sibling roots even when one name is a strict prefix of the other', () => {
		expect(recoverImportSetRoot([
			'Ontologies/NIST/AC-2.md',
			'Ontologies/NISTED/AC-3.md',
		])).toBe('Ontologies');
	});

	it('returns the deepest shared folder, not merely the first segment', () => {
		expect(recoverImportSetRoot([
			'Ontologies/attack-mini/T1078.md',
			'Ontologies/attack-mini/T1078/T1078.001.md',
			'Ontologies/attack-mini/Persistence/Persistence.md',
		])).toBe('Ontologies/attack-mini');
	});

	it('recovers a flat pre-fix import that sits directly in the shared root', () => {
		expect(recoverImportSetRoot(['Ontologies/T1078.md', 'Ontologies/T1098.md'])).toBe('Ontologies');
	});

	// Fail closed. Refusing to answer is the correct answer when the notes do not
	// agree, because every wrong answer here MOVES a user's notes.
	it.each([
		['no notes at all', []],
		['one note dragged to the vault root', ['Ontologies/T1078.md', 'stray.md']],
		['notes under two unrelated top-level folders', ['Ontologies/A.md', 'Archive/B.md']],
		['a note sitting at the vault root', ['A.md']],
	])('returns null rather than guessing: %s', (_label, paths) => {
		expect(recoverImportSetRoot(paths as string[])).toBeNull();
	});
});

describe('a discovered set knows where it lives', () => {
	it('prefers the destination its own notes recorded', async () => {
		const app = mockApp({}, {
			'Ontologies/attack-mini/T1078.md': stampedWithDestination('iset-abc123', 'Ontologies/attack-mini'),
			'Ontologies/attack-mini/Persistence/T1098.md': stampedWithDestination('iset-abc123', 'Ontologies/attack-mini'),
		});
		const [set] = await discoverImportSets(app, 'Ontologies');
		expect(set.destination).toBe('Ontologies/attack-mini');
		expect(set.root).toBe('Ontologies/attack-mini');
	});

	it('ignores a recorded destination its notes no longer corroborate (a renamed folder)', async () => {
		// Nothing reconciles the stamp when a user renames the folder in the file
		// explorer, so the stamp is a hint and the paths are the evidence. Writing
		// to a folder the set has left is how a refresh silently forks an import.
		const app = mockApp({}, {
			'Ontologies/renamed/T1078.md': stampedWithDestination('iset-abc123', 'Ontologies/attack-mini'),
			'Ontologies/renamed/T1098.md': stampedWithDestination('iset-abc123', 'Ontologies/attack-mini'),
		});
		const [set] = await discoverImportSets(app, 'Ontologies');
		expect(set.root).toBe('Ontologies/renamed');
	});

	it('falls back to the paths when members disagree about the destination (a half-migrated set)', async () => {
		const app = mockApp({}, {
			'Ontologies/T1078.md': stampedWithDestination('iset-abc123', 'Ontologies'),
			'Ontologies/T1098.md': stampedWithDestination('iset-abc123', 'Ontologies/attack-mini'),
		});
		const [set] = await discoverImportSets(app, 'Ontologies');
		expect(set.destination).toBeUndefined();
		expect(set.root).toBe('Ontologies');
	});

	it('reports a null root rather than inventing one when the set is spread across the vault', async () => {
		const app = mockApp({
			'Ontologies/T1078.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Archive/T1098.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		});
		const [set] = await discoverImportSets(app, undefined);
		expect(set.root).toBeNull();
	});

	it('records the destination it wrote to on every run, not only at mint', async () => {
		// Re-stamped each run so a set that legitimately moves records its new home
		// instead of carrying a stale one forever.
		const app = mockApp({ 'Ontologies/T1078.md': { id: 'iset-abc123', scheme: 'endpoint-v1' } });
		await expect(resolveImportSet(app, 'Ontologies/attack-mini', { id: 'iset-abc123' })).resolves.toEqual({
			id: 'iset-abc123', scheme: 'endpoint-v1', destination: 'Ontologies/attack-mini',
		});
	});

	it('records no destination for an import into the vault root, rather than an empty string', async () => {
		const app = mockApp({});
		await expect(resolveImportSet(app, '', 'new')).resolves.toEqual({
			id: expect.stringMatching(/^iset-[a-z0-9]{6}$/), scheme: 'endpoint-v1',
			derivation: 'declared-facts-v1',
		});
	});
});

// ===========================================================================
// A-2: a discovered set carries the two STAMPED FACTS an import is matched on.
//
// Ownership review used to be scoped to the destination folder, so "one set in
// this folder" meant "refresh that set, whatever it was" -- which is how a
// second framework was attributed to the first. Matching now asks what the
// notes were stamped with, and these are the fields that answer.
// ===========================================================================

/** A vault whose notes carry full frontmatter, not only the ownership stamp. */
function mockStampedApp(notes: Record<string, { setId: string; recipeId?: string; curie?: string }>) {
	const files = Object.keys(notes).map((path) => new TFile(path));
	return {
		vault: { getMarkdownFiles: () => files, cachedRead: jest.fn(async () => '') },
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const note = notes[file.path];
				if (!note) return undefined;
				return {
					frontmatter: {
						...(note.curie !== undefined ? { curie: note.curie } : {}),
						_crosswalker: {
							import_set: { id: note.setId, scheme: 'endpoint-v1' },
							...(note.recipeId !== undefined ? { recipe: { id: note.recipeId } } : {}),
						},
					},
				};
			},
		},
	} as any;
}

describe('a discovered set knows what produced it', () => {
	it('collects the recipe id and the ontology prefix its notes are stamped with', async () => {
		const app = mockStampedApp({
			'Ontologies/A.md': { setId: 'iset-abc123', recipeId: 'custom-attack-mini', curie: 'attack-mini:T1078' },
			'Ontologies/B.md': { setId: 'iset-abc123', recipeId: 'custom-attack-mini', curie: 'attack-mini:T1098' },
		});
		const [set] = await discoverImportSets(app, undefined);
		expect(set.recipeIds).toEqual(['custom-attack-mini']);
		expect(set.ontologyPrefixes).toEqual(['attack-mini']);
	});

	it('keeps every distinct value, because a set legitimately carries more than one', async () => {
		// A refresh through a renamed recipe restamps only the notes it rewrites,
		// so a half-restamped set is a real state. Matching is membership, and
		// membership needs the whole list.
		const app = mockStampedApp({
			'Ontologies/A.md': { setId: 'iset-abc123', recipeId: 'custom-attack-mini', curie: 'attack-mini:T1078' },
			'Ontologies/B.md': { setId: 'iset-abc123', recipeId: 'attack-mini-v2', curie: 'attack-mini:T1098' },
		});
		const [set] = await discoverImportSets(app, undefined);
		expect(set.recipeIds).toEqual(['attack-mini-v2', 'custom-attack-mini']);
		expect(set.ontologyPrefixes).toEqual(['attack-mini']);
	});

	it('contributes nothing for a note that records neither, rather than a null', async () => {
		// A producer that stamps ownership and nothing else is allowed. A null in
		// these lists would match a source whose own key failed to build, which is
		// precisely the "match everything" failure the lists exist to prevent.
		const app = mockStampedApp({
			'Ontologies/A.md': { setId: 'iset-abc123' },
			'Ontologies/B.md': { setId: 'iset-abc123', curie: 'attack-mini:T1098' },
		});
		const [set] = await discoverImportSets(app, undefined);
		expect(set.recipeIds).toEqual([]);
		expect(set.ontologyPrefixes).toEqual(['attack-mini']);
	});

	it('reads no prefix out of a curie that has no ontology half', async () => {
		const app = mockStampedApp({
			'Ontologies/A.md': { setId: 'iset-abc123', curie: 'no-colon-here' },
			'Ontologies/B.md': { setId: 'iset-abc123', curie: ':leading-colon' },
		});
		const [set] = await discoverImportSets(app, undefined);
		expect(set.ontologyPrefixes).toEqual([]);
	});

	it('does not let one set inherit another set stamps', async () => {
		const app = mockStampedApp({
			'Ontologies/A.md': { setId: 'iset-abc123', recipeId: 'custom-attack-mini', curie: 'attack-mini:T1078' },
			'Ontologies/cis/B.md': { setId: 'iset-def456', recipeId: 'custom-cis-controls', curie: 'cis-controls:CIS-1' },
		});
		const sets = await discoverImportSets(app, undefined);
		const byId = new Map(sets.map((s) => [s.id, s]));
		expect(byId.get('iset-abc123')!.ontologyPrefixes).toEqual(['attack-mini']);
		expect(byId.get('iset-def456')!.ontologyPrefixes).toEqual(['cis-controls']);
	});
});

// ===========================================================================
// AM-9: THE ENGINE HAS EXACTLY TWO BEHAVIOURS.
//
// `resolveImportSet` is the single point where a generation run decides which
// set it owns, and both generation entry points go through it. Four passes of
// preselect-removal above it failed because a third behaviour lived here: given
// no explicit option, discover the sets under the destination folder and
// silently refresh the one you find.
//
// It is deleted rather than narrowed, so the claim these cases pin is
// STRUCTURAL: an explicit `{id, scheme}` refreshes that set, and no other input
// -- `undefined` included, whatever the folder holds -- can reach one.
// ===========================================================================

describe('resolveImportSet, the one place ownership is decided', () => {
	/** A destination holding exactly one set: the shape adoption used to act on. */
	const oneSetInTheDestination = () => mockApp({
		'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
		'Frameworks/Sub/B.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
	});

	it.each([
		['no option at all', undefined],
		['an explicit new set', 'new' as const],
		['an explicit set-qualified new set', 'new-set-qualified' as const],
	])('mints rather than adopting, given %s', async (_label, option) => {
		const app = oneSetInTheDestination();
		const resolved = await resolveImportSet(app, 'Frameworks', option);
		expect(resolved.id).toMatch(/^iset-[a-z0-9]{6}$/);
		expect(resolved.id).not.toBe('iset-abc123');
		expect(resolved.destination).toBe('Frameworks');
	});

	it('mints a DIFFERENT set every time, so nothing converges on the folder occupant', async () => {
		// One call minting is not the claim; the claim is that no repetition of
		// "just write here" ever lands on what is already there.
		const app = oneSetInTheDestination();
		const ids = new Set<string>();
		for (let i = 0; i < 5; i++) ids.add((await resolveImportSet(app, 'Frameworks')).id);
		expect(ids.size).toBe(5);
		expect(ids.has('iset-abc123')).toBe(false);
	});

	it('does not refuse an ambiguous destination either, because it is not asking the question', async () => {
		// Two sets in the folder used to be a hard error, because the engine was
		// trying to pick an owner and could not. Refusing was the safe half of a
		// wrong question: nobody asked it to choose.
		const app = mockApp({
			'Frameworks/A.md': { id: 'iset-abc123', scheme: 'endpoint-v1' },
			'Frameworks/B.md': { id: 'iset-def456', scheme: 'endpoint-v1' },
		});
		const resolved = await resolveImportSet(app, 'Frameworks');
		expect(['iset-abc123', 'iset-def456']).not.toContain(resolved.id);
	});

	it('refreshes the set an explicit id names, wherever in the vault that set lives', async () => {
		// The control, and the other half of the contract: the explicit path is
		// whole-vault by id, never scoped to the folder being written to. A refresh
		// whose set sits somewhere else is the ordinary case for a legacy flat vault.
		const app = mockApp({
			'Elsewhere/A.md': { id: 'iset-abc123', scheme: 'set-qualified-v1' },
		});
		await expect(resolveImportSet(app, 'Frameworks', { id: 'iset-abc123' })).resolves.toMatchObject({
			id: 'iset-abc123',
			scheme: 'set-qualified-v1',
		});
	});

	it('keeps the ontology an explicitly named set already carries, and does not pin one on a mint', async () => {
		// AM-6 rides on the explicit branch, which is the only branch left that can
		// see an existing set at all. A mint has nothing to inherit, so it takes the
		// run's own proposal.
		const app = mockStampedApp({
			'Elsewhere/A.md': { setId: 'iset-abc123', curie: 'attack-mini:T1078' },
		});
		await expect(resolveImportSet(app, 'Frameworks', { id: 'iset-abc123' }, 'cis-controls-v8'))
			.resolves.toMatchObject({ id: 'iset-abc123', ontology: 'attack-mini' });
		await expect(resolveImportSet(app, 'Frameworks', undefined, 'cis-controls-v8'))
			.resolves.toMatchObject({ ontology: 'cis-controls-v8' });
	});
});
