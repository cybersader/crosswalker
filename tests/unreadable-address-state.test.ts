/**
 * unreadable-address-state.test.ts — AM-19 (2026-08-31): a note nothing can be
 * read off is its own state, and never "not Crosswalker's".
 *
 * THE STAKE. AM-14 closed the address route into a note by asking the vault-wide
 * index who owns the file sitting at a rendered path. That index only recorded
 * notes it could parse: a note whose properties block a hand edit had broken was
 * absent from it, and absence read as "no provenance", which read as "a person's
 * own note". So a damaged note the run genuinely OWNED was refused with
 *
 *     "a note that is not Crosswalker's sits at <path>. Move or rename that note."
 *
 * — a false cause carrying a destructive-sounding instruction about the user's
 * own imported control. Before AM-14 the same note produced an
 * `frontmatter-unreadable` conflict saying Crosswalker could not safely update
 * it, which is both true and actionable.
 *
 * This is `project_cache_lag_is_not_absence` one level up, and its sixth
 * appearance: the absence of a fact is not a fact. `provenanceAt` therefore has
 * four answers, not three, and the fourth is routed to the conflict surface the
 * pre-AM-14 path used.
 *
 * WHAT IS ASSERTED HERE, AND WHAT IS ASSERTED ELSEWHERE
 *
 * `tests/replace-preserves-body.test.ts` C3 is the CONTRACT: it was written red
 * and defines the outcome (file untouched, one `frontmatter-unreadable`
 * conflict) on both entry points. It is deliberately not duplicated. This file
 * covers the three things C3 does not look at: the index state itself, the
 * WORDING the user reads, and that the note is refused as a note this run OWNS
 * rather than as a stranger's.
 */

import { TFile, TFolder } from 'obsidian';
import {
	crossSetAddressMessage,
	generateFromRecipe,
	generateNotes,
	type GenerationOptions,
} from '../src/generation/generation-engine';
import { buildIdentityIndex } from '../src/generation/identity-index';
import type { Recipe } from '../src/render';
import type { GenerationResult, ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Vault double. `getFileCache` mimics the real metadata cache in the one way
// that matters here: Obsidian does not index frontmatter it cannot parse, so a
// broken note answers with no frontmatter rather than throwing.
// ---------------------------------------------------------------------------

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: {
			renameFile: async (file: { path: string }, to: string) => {
				const text = files.get(file.path);
				files.delete(file.path);
				if (text !== undefined) files.set(to, text);
			},
		},
	};
	return { app: app as any, files };
}

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

// ---------------------------------------------------------------------------
// 1. The index itself: four answers, not three.
// ---------------------------------------------------------------------------

describe('what the index says about the note at an address', () => {
	it('says "unreadable" for a properties block that will not parse', async () => {
		// The note may well be one this very set owns. Nothing here can tell, and
		// the honest answer to "whose is it" is "we could not read it".
		const { app, files } = makeApp();
		files.set('Frameworks/AC-2.md', note(': : :\ncurie: nist:AC-2'));
		const index = await buildIdentityIndex(app);
		expect(index.provenanceAt('Frameworks/AC-2.md')).toBe('unreadable');
	});

	it('says "unreadable" when _crosswalker is there but is not a provenance block', async () => {
		// A hand edit turned the block into a string. The KEY being present is what
		// makes this a damaged Crosswalker note rather than a stranger's, so it gets
		// the same "fix this note" answer instead of "move or rename that note".
		const { app, files } = makeApp();
		files.set('Frameworks/AC-3.md', note('curie: nist:AC-3\n_crosswalker: oops'));
		const index = await buildIdentityIndex(app);
		expect(index.provenanceAt('Frameworks/AC-3.md')).toBe('unreadable');
	});

	it('still distinguishes the three readable answers', async () => {
		const { app, files } = makeApp();
		files.set('Frameworks/Owned.md', note('curie: nist:AC-4\n_crosswalker:\n  import_set:\n    id: iset-aaaaaa'));
		files.set('Frameworks/Unstamped.md', note('curie: nist:AC-5\n_crosswalker:\n  spec_version: x'));
		files.set('Notes/Mine.md', note('title: My own note'));
		files.set('Notes/Plain.md', 'No properties at all.\n');
		const index = await buildIdentityIndex(app);
		expect(index.provenanceAt('Frameworks/Owned.md')).toEqual({ importSetId: 'iset-aaaaaa' });
		expect(index.provenanceAt('Frameworks/Unstamped.md')).toEqual({ importSetId: null });
		// Not Crosswalker's, and a plain note with no properties at all: both null,
		// which is the answer that legitimately means "not ours".
		expect(index.provenanceAt('Notes/Mine.md')).toBeNull();
		expect(index.provenanceAt('Notes/Plain.md')).toBeNull();
	});

	it('does not let one damaged note hide the readable notes around it', async () => {
		// readRawFrontmatter's own docstring: one corrupt note anywhere in the vault
		// must not be able to block every import. Recording it must not become
		// throwing about it.
		const { app, files } = makeApp();
		files.set('Frameworks/Broken.md', note(': : :'));
		files.set('Frameworks/Fine.md', note('curie: nist:AC-6\n_crosswalker:\n  import_set:\n    id: iset-bbbbbb'));
		const index = await buildIdentityIndex(app);
		expect(index.get('nist:AC-6')?.path).toBe('Frameworks/Fine.md');
		expect(index.provenanceAt('Frameworks/Broken.md')).toBe('unreadable');
	});
});

// ---------------------------------------------------------------------------
// 2. The wording. `feedback_errors_must_be_actionable`: name a cause and an
//    action, and never a cause that was not established.
// ---------------------------------------------------------------------------

describe('what an unreadable note is told to the user', () => {
	const message = crossSetAddressMessage({ reason: 'unreadable', path: 'Frameworks/AC-2.md', setId: null });

	it('names the file and the one action that fixes it', () => {
		expect(message).toContain('Frameworks/AC-2.md');
		expect(message).toContain('properties');
		expect(message).toContain('import again');
		expect(message).toContain('Nothing was written');
	});

	it('never claims the note is not Crosswalker\'s, and never invites move or delete', () => {
		// The two sentences that made the pre-AM-19 refusal wrong. This may be the
		// user's own imported control, damaged by a hand edit.
		expect(message).not.toContain("not Crosswalker's");
		expect(message).not.toContain('Move or rename');
		expect(message).not.toContain('Move or delete');
	});

	it('is not the message any of the three ownership reasons produce', () => {
		for (const reason of ['not-crosswalker', 'unstamped', 'foreign-set'] as const) {
			expect(crossSetAddressMessage({ reason, path: 'Frameworks/AC-2.md', setId: 'iset-cccccc' }))
				.not.toBe(message);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Both entry points, on a note the run demonstrably OWNS.
// ---------------------------------------------------------------------------

const BASE = 'Frameworks';
const NOTE = `${BASE}/AC-2.md`;

function parsed(): ParsedData {
	const row = { id: 'AC-2', name: 'Account management' };
	return { columns: Object.keys(row), rows: [row], rowCount: 1 };
}

const RECIPE: Recipe = {
	recipe: 'damaged',
	source: { ontology: 'damaged', levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
		also_emit: { frontmatter: { managed: { title: '{name}' } } },
	},
};

const WIZARD_CONFIG: Partial<ImportRecipe> = {
	name: 'damaged',
	mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: '{id}.md', sanitize: true } },
};

type Run = (app: any, importSet: { id: string } | 'new') => Promise<GenerationResult>;

const PATHS: Array<{ name: string; run: Run }> = [
	{
		name: 'generateNotes (wizard path)',
		run: (app, importSet) => {
			const options: GenerationOptions = {
				basePath: BASE,
				overwriteMode: 'replace',
				createFolders: true,
				sourceFileName: 'source.csv',
				recipeOverride: RECIPE,
				importSet,
			};
			return generateNotes(app, parsed(), WIZARD_CONFIG, options);
		},
	},
	{
		name: 'generateFromRecipe (native recipe path)',
		run: (app, importSet) => generateFromRecipe(app, parsed(), RECIPE, {
			basePath: BASE,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'source.csv',
			importSet,
		}),
	},
];

/** The import set stamped on a note, read from the note's own bytes. */
function stampedSetId(text: string): string {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	const fm = match ? (yaml.load(match[1]) as any) : {};
	const id = fm?._crosswalker?.import_set?.id;
	expect(typeof id).toBe('string');
	return id as string;
}

describe.each(PATHS)('a damaged note this set owns — $name', ({ run }) => {
	/** Import once, then break the note's properties block by hand. */
	async function importThenDamage() {
		const { app, files } = makeApp();
		const first = await run(app, 'new');
		expect(first.errors).toEqual([]);
		const setId = stampedSetId(files.get(NOTE)!);
		// Exactly what a hand edit does: a line the YAML parser rejects, left in
		// place with everything else intact.
		const broken = files.get(NOTE)!.replace(/^---\n/, '---\n: : :\n');
		files.set(NOTE, broken);
		return { app, files, setId, broken };
	}

	it('is refused as a note to FIX, not as a note that is not ours', async () => {
		const { app, files, setId, broken } = await importThenDamage();
		const result = await run(app, { id: setId });

		// Untouched, byte for byte.
		expect(files.get(NOTE)).toBe(broken);

		// The pre-AM-14 outcome, restored: a per-note conflict, not a run error.
		expect(result.conflicts ?? []).toHaveLength(1);
		const conflict = result.conflicts![0];
		expect(conflict.code).toBe('frontmatter-unreadable');
		expect(conflict.path).toBe(NOTE);
		const said = `${conflict.detail ?? ''}`;
		expect(said).toContain('did not parse');
		expect(said).toContain('import again');
		expect(said).not.toContain("not Crosswalker's");
		expect(said).not.toContain('Move or rename');

		// And it is reported as nobody's ownership problem: an ownership refusal
		// goes to result.errors, and none of the four reasons applies here.
		expect(result.errors).toEqual([]);
		for (const error of result.errors) expect(error.message).not.toContain(NOTE);
	});

	it('is the note the run genuinely owns, not a stranger that happens to be there', async () => {
		// Without this the case above would prove nothing: refusing a foreign note
		// is exactly what AM-14 is for. The point of AM-19 is that the SAME refusal
		// was being handed to the set's own damaged note.
		const { app, files, setId } = await importThenDamage();
		const index = await buildIdentityIndex(app, { importSetId: setId });
		expect(index.provenanceAt(NOTE)).toBe('unreadable');
		// The id passed to the run is the one this very note was stamped with
		// before the hand edit broke it.
		expect(setId).toMatch(/^iset-[a-z0-9]{6}$/);
		expect(files.get(NOTE)).toContain(': : :');
	});
});
