/**
 * replace-preserves-body.test.ts — the acceptance gate for the managed body
 * region contract (2026-08-27), run against BOTH generation entry points.
 *
 * THE STAKE. Before this slice, a re-import with `Replace` rebuilt the whole
 * note body, so an implementation note, an evidence pointer, or an audit remark
 * someone typed into a generated control note was destroyed with no warning and
 * no undo. That is why the shipped rollout guidance said to treat generated
 * notes as read-only.
 *
 * C1 IS THE POINT OF THIS FILE. Every case below runs against `generateNotes`
 * (wizard/workbench path) AND `generateFromRecipe` (native recipe path). A case
 * that passes on one path only is a FAIL: an earlier attempt at this behaviour
 * fixed one path and not the other, and the "removed" behaviour came back from
 * the second call site.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import { discoverImportSets, type ImportSetOption } from '../src/generation/import-set';
import type { GenerationOptions } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { GenerationResult, ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

const START = '<!-- crosswalker:body:start v=1 -->';
const END = '<!-- crosswalker:body:end -->';

/**
 * Neutralise the one wall-clock field in provenance so a byte-identity check
 * means what it says. `produced_at` is deliberately non-deterministic in src;
 * the golden harness normalises it the same way.
 */
function stable(note: string): string {
	return note.replace(/produced_at: "[^"]*"/g, 'produced_at: "SENTINEL"');
}

// ---------------------------------------------------------------------------
// Vault double
// ---------------------------------------------------------------------------

interface FakeVault {
	app: any;
	files: Map<string, string>;
	/** When true, getFileCache reports nothing — the cache-lag case (C2). */
	blindCache: { on: boolean };
}

function makeApp(): FakeVault {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const blindCache = { on: false };
	const getAbstractFileByPath = (path: string) => {
		if (files.has(path)) return new TFile(path);
		if (folders.has(path)) return new TFolder(path);
		return null;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath,
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => {
				files.set(file.path, content);
			},
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => folders.add(path),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				if (blindCache.on) return null;
				const text = files.get(file.path);
				const match = text && /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				let fm: unknown;
				try {
					fm = yaml.load(match[1]);
				} catch {
					// A real metadata cache does not index unparseable frontmatter.
					return { frontmatter: undefined };
				}
				return { frontmatter: (fm ?? {}) as Record<string, unknown> };
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
	return { app: app as any, files, blindCache };
}

// ---------------------------------------------------------------------------
// One source row, one recipe, driven through both entry points
// ---------------------------------------------------------------------------

const BASE = 'Frameworks';
const NOTE = `${BASE}/AC-2.md`;

function parsed(prose = 'Manages accounts.'): ParsedData {
	const row = { id: 'AC-2', name: 'Account management', prose };
	return { columns: Object.keys(row), rows: [row], rowCount: 1 };
}

function recipe(opts: { autoHeading?: string | false; body?: boolean; userPreserve?: string[] } = {}): Recipe {
	const target: Recipe['target'] = {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
		also_emit: {
			frontmatter: {
				managed: { title: '{name}' },
				...(opts.userPreserve ? { user_preserve: opts.userPreserve } : {}),
			},
			...(opts.body === false ? {} : { body: [{ template: '{prose}', position: 'append' as const, format: 'text' as const }] }),
		},
	};
	if (opts.autoHeading !== undefined) target.auto_heading = opts.autoHeading;
	return { recipe: 'regions', source: { ontology: 'regions', levels: ['leaf'] }, target };
}

/** The workbench config the wizard path needs; the recipe override does the work. */
const wizardConfig: Partial<ImportRecipe> = {
	name: 'regions',
	mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: '{id}.md', sanitize: true } },
};

type Mode = 'skip' | 'replace' | 'error';

interface RunArgs {
	app: any;
	data?: ParsedData;
	rec?: Recipe;
	mode?: Mode;
	/**
	 * Skips import-set DISCOVERY, exactly as the wizard does once the review step
	 * has chosen a set. Needed for the unreadable-frontmatter cases: discovery
	 * itself parses every note under the destination and raises a RUN-level
	 * ImportSetProvenanceError on unparseable YAML, which would mask the
	 * per-note conflict under test. See the finding in the slice report.
	 */
	importSet?: 'new';
}

/**
 * Ownership for one run, said out loud.
 *
 * AM-9 (2026-08-30): the engine used to look at the destination folder and, if
 * exactly one import set already lived there, silently refresh it. Every case
 * below that imports twice relied on that, which is why an omitted ownership
 * option used to mean "refresh". The branch is deleted -- a folder is an
 * address, and an address does not name an owner -- so an omitted option now
 * MINTS A NEW SET, and "Replace twice is byte-identical" would be comparing two
 * notes stamped with two different `import_set.id` values.
 *
 * The cases are not retired; a re-import under Replace is exactly what this
 * file is the acceptance gate for. It is now named, the same way the wizard
 * names it after its review step. The first run into a vault still mints,
 * because there is nothing yet to name, and an explicit `new` still skips
 * discovery entirely for the unreadable-frontmatter cases.
 */
async function ownershipFor(app: any, explicit?: 'new'): Promise<ImportSetOption | undefined> {
	if (explicit) return explicit;
	const [existing] = await discoverImportSets(app, undefined);
	return existing ? { id: existing.id } : undefined;
}

/** The two entry points, behind one signature, so every case runs on both. */
const PATHS: Array<{ name: string; run: (a: RunArgs) => Promise<GenerationResult> }> = [
	{
		name: 'generateNotes (wizard path)',
		run: async ({ app, data, rec, mode, importSet }) => {
			const owner = await ownershipFor(app, importSet);
			const options: GenerationOptions = {
				basePath: BASE,
				overwriteMode: mode ?? 'replace',
				createFolders: true,
				sourceFileName: 'source.csv',
				recipeOverride: rec ?? recipe(),
				...(owner ? { importSet: owner } : {}),
			};
			return generateNotes(app, data ?? parsed(), wizardConfig, options);
		},
	},
	{
		name: 'generateFromRecipe (native recipe path)',
		run: async ({ app, data, rec, mode, importSet }) => {
			const owner = await ownershipFor(app, importSet);
			return generateFromRecipe(app, data ?? parsed(), rec ?? recipe(), {
				basePath: BASE,
				overwriteMode: mode ?? 'replace',
				createFolders: true,
				sourceFileName: 'source.csv',
				...(owner ? { importSet: owner } : {}),
			});
		},
	},
];

describe.each(PATHS)('managed body regions — $name', ({ run }) => {
	// -----------------------------------------------------------------------
	// A4 — the create shape
	// -----------------------------------------------------------------------

	it('A4 — a fresh create wraps the body, and stripping the two marker lines is byte-identical to today', async () => {
		const { app, files } = makeApp();
		const result = await run({ app });
		expect(result.errors).toEqual([]);
		const note = files.get(NOTE)!;
		expect(note).toContain(`${START}\n`);
		expect(note).toContain(`${END}\n`);
		const stripped = note.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n');
		expect(stripped).toContain('# ');
		expect(stripped).toContain('Manages accounts.');
		// Exactly two marker lines, no more.
		expect(note.match(/^<!-- crosswalker:/gm)).toHaveLength(2);
	});

	// -----------------------------------------------------------------------
	// A1 — the whole point
	// -----------------------------------------------------------------------

	it('A1 — user prose below the region survives Replace BYTE-FOR-BYTE while the region updates', async () => {
		const { app, files } = makeApp();
		await run({ app });

		// A person opens the generated control note and writes into it.
		const prose = '\n## Our implementation  \r\nEvidence: ticket SEC-4192.\t\n\nOwner: alice\n';
		files.set(NOTE, files.get(NOTE)! + prose);
		const before = files.get(NOTE)!;

		const result = await run({ app, data: parsed('Manages accounts, revised.') });
		const after = files.get(NOTE)!;

		expect(result.conflicts ?? []).toEqual([]);
		// Byte-for-byte, including the CRLF and the trailing tab and spaces.
		expect(after.endsWith(prose)).toBe(true);
		expect(after).toContain('## Our implementation  \r\n');
		expect(after).toContain('Evidence: ticket SEC-4192.\t\n');
		// And the managed region actually changed.
		expect(before).toContain('Manages accounts.');
		expect(after).toContain('Manages accounts, revised.');
	});

	// -----------------------------------------------------------------------
	// B1 — idempotence
	// -----------------------------------------------------------------------

	it('B1 — Replace twice with an unchanged source is byte-identical and conflict-free', async () => {
		const { app, files } = makeApp();
		await run({ app });
		files.set(NOTE, `${files.get(NOTE)!}\nMy notes.\n`);
		await run({ app });
		const once = files.get(NOTE)!;
		const result = await run({ app });
		expect(stable(files.get(NOTE)!)).toBe(stable(once));
		expect(result.conflicts ?? []).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// B2 to B5 — legacy adoption
	// -----------------------------------------------------------------------

	it('B2 — an unmarked legacy note equal to the fresh render adopts, gaining exactly the two marker lines', async () => {
		const { app, files } = makeApp();
		await run({ app });
		// Rewind the vault to the pre-markers shape.
		const legacy = files.get(NOTE)!.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n');
		files.set(NOTE, legacy);

		const result = await run({ app });
		expect(result.conflicts ?? []).toEqual([]);
		const adopted = files.get(NOTE)!;
		expect(stable(adopted.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n'))).toBe(stable(legacy));
		// Running again changes nothing.
		await run({ app });
		expect(stable(files.get(NOTE)!)).toBe(stable(adopted));
	});

	/**
	 * Real sources in this corpus carry embedded CRLF. An un-normalised comparison
	 * reported prose loss on them where there was none: an ordinary Windows-authored
	 * note refused to adopt and the user was told it could not be updated. A
	 * conflict here is that regression, not safety.
	 *
	 * This also covers the whole-file CRLF read: if `readExistingNote`'s frontmatter
	 * pattern did not tolerate `\r\n`, the properties block would be read as body,
	 * the comparison would fail, and the note would conflict.
	 */
	it('B5 — a CRLF legacy note adopts rather than falsely reporting a changed body', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const legacy = files.get(NOTE)!.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n');
		files.set(NOTE, legacy.replace(/\n/g, '\r\n'));

		const result = await run({ app });
		expect(result.conflicts ?? []).toEqual([]);

		const adopted = files.get(NOTE)!;
		expect(adopted).toContain(`${START}\n`);
		expect(adopted).toContain(`${END}`);
		expect(adopted.match(/^<!-- crosswalker:/gm)).toHaveLength(2);
		// The CRLF frontmatter round-tripped: the properties are still properties,
		// not text that leaked into the body.
		expect(adopted.startsWith('---')).toBe(true);
		expect(stable(adopted)).toContain('Manages accounts.');

		// The next run settles and every run after it is byte-identical. The one
		// byte that changes on that run is the END MARKER LINE's own `\r`: the
		// marker lines belong to the region, and the contract's single sanctioned
		// normalisation is that a rebuilt region is LF by construction. No user
		// byte moves, which is what the assertion below actually guards.
		await run({ app });
		const settled = files.get(NOTE)!;
		expect(stable(settled)).toBe(stable(adopted.replace(`${END}\r\n`, `${END}\n`)));
		await run({ app });
		expect(stable(files.get(NOTE)!)).toBe(stable(settled));
	});

	// -----------------------------------------------------------------------
	// A2 — the conservative refusal
	// -----------------------------------------------------------------------

	it('A2 — an unmarked legacy note differing by ONE character is not modified at all', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const legacy = `${files.get(NOTE)!.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n')}x`;
		files.set(NOTE, legacy);

		const result = await run({ app });
		expect(files.get(NOTE)).toBe(legacy);          // full bytes, unchanged
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts![0].code).toBe('legacy-body-differs');
		expect(result.conflicts![0].path).toBe(NOTE);
		// A conflict is per-note: the run itself still succeeded.
		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('B6 — a legacy note differing only by one trailing space refuses rather than adopting', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const legacy = files.get(NOTE)!
			.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n')
			.replace('Manages accounts.', 'Manages accounts. ');
		files.set(NOTE, legacy);
		const result = await run({ app });
		expect(files.get(NOTE)).toBe(legacy);
		expect(result.conflicts![0].code).toBe('legacy-body-differs');
	});

	// -----------------------------------------------------------------------
	// A3 — the corruption matrix, through the engine
	// -----------------------------------------------------------------------

	describe('A3 — every corruption state leaves the file untouched under Replace', () => {
		const cases: Array<[string, (marked: string) => string]> = [
			['unclosed-region', (m) => m.replace(`${END}\n`, '')],
			['orphan-end-marker', (m) => m.replace(`${START}\n`, '')],
			['inverted-region', (m) => m.replace(`${START}\n`, `${END}\n\n${START}\n`) + `${END}\n`],
			['duplicate-region', (m) => m + `${START}\n# again\n${END}\n`],
			['duplicate-end-marker', (m) => `${m}${END}\n`],
			['nested-region', (m) => m.replace(`${END}\n`, '<!-- crosswalker:children:start v=1 -->\n<!-- crosswalker:children:end -->\n' + `${END}\n`)],
			['malformed-marker', (m) => m.replace(START, '<!-- crosswalker:body:start v=1 mode=x -->')],
			['future-region-version', (m) => m.replace(START, '<!-- crosswalker:body:start v=2 -->')],
		];

		it.each(cases)('%s', async (code, corrupt) => {
			const { app, files } = makeApp();
			await run({ app });
			const broken = corrupt(files.get(NOTE)!);
			files.set(NOTE, broken);

			const result = await run({ app });
			expect(files.get(NOTE)).toBe(broken);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts![0].code).toBe(code);
			expect(result.success).toBe(true);
		});

		it('the marker-only-inside-a-code-fence case names the fence in the diagnostic', async () => {
			const { app, files } = makeApp();
			await run({ app });
			files.set(NOTE, files.get(NOTE)!.replace(`${END}\n`, '```md\n' + `${END}\n` + '```\n'));
			const result = await run({ app });
			expect(result.conflicts![0].code).toBe('unclosed-region');
			expect(result.conflicts![0].detail).toContain('fenced code block');
		});
	});

	// -----------------------------------------------------------------------
	// B9, B10 — version and unknown regions
	// -----------------------------------------------------------------------

	it('B10 — a balanced UNKNOWN region is not corruption and survives Replace verbatim', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const evidence = '<!-- crosswalker:evidence:start v=1 -->\nSOC2 ticket 41\n<!-- crosswalker:evidence:end -->';
		files.set(NOTE, `${files.get(NOTE)!}\n${evidence}\n`);

		const result = await run({ app, data: parsed('Manages accounts, revised.') });
		expect(result.conflicts ?? []).toEqual([]);
		expect(files.get(NOTE)).toContain(evidence);
		expect(files.get(NOTE)).toContain('Manages accounts, revised.');
	});

	// -----------------------------------------------------------------------
	// B8 — the empty region
	// -----------------------------------------------------------------------

	it('B8 — auto_heading: false with no body projections still emits an empty region, and re-import is a no-op', async () => {
		const { app, files } = makeApp();
		const rec = recipe({ autoHeading: false, body: false });
		await run({ app, rec });
		const created = files.get(NOTE)!;
		expect(created).toContain(`${START}\n${END}\n`);
		const result = await run({ app, rec });
		expect(stable(files.get(NOTE)!)).toBe(stable(created));
		expect(result.conflicts ?? []).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// C2, C3 — the fail-closed frontmatter reader
	// -----------------------------------------------------------------------

	it('C2 — on a metadata-cache MISS the raw read recovers the frontmatter and user_preserve keys survive', async () => {
		const { app, files, blindCache } = makeApp();
		const rec = recipe({ userPreserve: ['title'] });
		await run({ app, rec });
		files.set(NOTE, files.get(NOTE)!.replace('title: Account management', 'title: My own title\nreviewer: alice'));

		// Cache lag is not absence. Before this slice `{}` came back, the merge was
		// skipped, and every user_preserve key on this note was overwritten.
		blindCache.on = true;
		const result = await run({ app, rec });
		blindCache.on = false;

		expect(result.conflicts ?? []).toEqual([]);
		const after = files.get(NOTE)!;
		expect(after).toContain('reviewer: alice');
		expect(after).toContain('My own title');
		expect(after).not.toContain('title: Account management');
	});

	it('C3 — unparseable frontmatter is a conflict, never "use the new frontmatter as-is"', async () => {
		const { app, files, blindCache } = makeApp();
		await run({ app, importSet: 'new' });
		const broken = files.get(NOTE)!.replace(/^---\n/, '---\n: : :\n');
		files.set(NOTE, broken);

		// The old code path here was `catch (mergeErr) { debug.warn(...); /* use
		// new frontmatter as-is */ }` — a silent user-frontmatter-loss path. It is
		// gone: the note is refused, not rewritten.
		blindCache.on = true;
		const result = await run({ app, importSet: 'new' });
		blindCache.on = false;

		expect(files.get(NOTE)).toBe(broken);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts![0].code).toBe('frontmatter-unreadable');
	});

	// -----------------------------------------------------------------------
	// C6, C7 — the other two modes
	// -----------------------------------------------------------------------

	it('C6 — Skip existing never inspects markers: every state stays byte-identical', async () => {
		const states = [
			(m: string) => m,                                                   // marked
			(m: string) => m.split('\n').filter((l) => !l.startsWith('<!--')).join('\n'), // legacy
			(m: string) => m.replace(`${END}\n`, ''),                           // corrupt
			(m: string) => m.replace(START, '<!-- crosswalker:body:start v=2 -->'), // future
		];
		for (const mutate of states) {
			const { app, files } = makeApp();
			await run({ app });
			const state = mutate(files.get(NOTE)!);
			files.set(NOTE, state);
			const result = await run({ app, mode: 'skip' });
			expect(files.get(NOTE)).toBe(state);
			expect(result.skipped).toContain(NOTE);
			expect(result.conflicts ?? []).toEqual([]);
		}
	});

	it('C7 — Error mode raises a run error and touches nothing, whatever the file state', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const state = files.get(NOTE)!.replace(`${END}\n`, '');
		files.set(NOTE, state);
		const result = await run({ app, mode: 'error' });
		expect(files.get(NOTE)).toBe(state);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// The regression this slice must not introduce
	// -----------------------------------------------------------------------

	it('a conflict blocks the FRONTMATTER write too, so no note ever looks current while being stale', async () => {
		const { app, files } = makeApp();
		await run({ app });
		const broken = files.get(NOTE)!.replace(`${END}\n`, '');
		files.set(NOTE, broken);
		const result = await run({ app, data: parsed('Different prose entirely.') });
		expect(files.get(NOTE)).toBe(broken);
		expect(files.get(NOTE)).not.toContain('Different prose entirely.');
		expect(result.conflicts).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// C4 — enrichment must not undo the merge (contract §7)
// ---------------------------------------------------------------------------

describe('C4 — Pass 1.5 enrichment does not destroy what the row write preserved', () => {
	const enrichRecipe: Recipe = {
		recipe: 'regions-enriched',
		source: { ontology: 'regions', levels: ['family', 'leaf'] },
		target: {
			layout: [
				{ level: 'family', mechanism: 'folder', template: '{family}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: {
				frontmatter: { managed: { title: '{name}', parent: '{family}' } },
				body: [{ template: '{prose}', position: 'append', format: 'text' }],
			},
			enrichment: { children_lists: 'frontmatter', level_hubs: 'notes' },
		},
	};

	function enrichData(prose: string): ParsedData {
		const rows = [
			{ id: 'AC-2', name: 'Account management', family: 'AC', prose },
			{ id: 'AC-3', name: 'Access enforcement', family: 'AC', prose },
		];
		return { columns: Object.keys(rows[0]), rows, rowCount: 2 };
	}

	it.each(PATHS)('$name', async ({ run }) => {
		const { app, files } = makeApp();
		await run({ app, data: enrichData('v1.'), rec: enrichRecipe });

		const target = [...files.keys()].find((p) => p.endsWith('AC-2.md'))!;
		const note = files.get(target)!;
		expect(note).toContain(START);
		files.set(target, `${note}\nEvidence: ticket SEC-4192.\n`);

		// A full run: row write + Pass 1.5. `EnrichRecord.body` must carry the body
		// AS WRITTEN; the fresh render would erase the line above.
		const result = await run({ app, data: enrichData('v2.'), rec: enrichRecipe });
		expect(result.conflicts ?? []).toEqual([]);
		const after = files.get(target)!;
		expect(after).toContain('Evidence: ticket SEC-4192.');
		expect(after).toContain('v2.');
	});
});

// ---------------------------------------------------------------------------
// C5 — facet hubs adopt by replay
// ---------------------------------------------------------------------------

describe('C5 — facet hubs adopt by replay and never conflict on their body', () => {
	const hubRecipe: Recipe = {
		recipe: 'regions-facets',
		source: { ontology: 'regions', levels: ['leaf'] },
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
			also_emit: {
				frontmatter: { managed: { title: '{name}' } },
				tags: ['tactic/{family|tagsafe}'],
			},
			enrichment: { facet_notes: 'notes', hub_note_folder: 'Tactics' },
		},
	};

	function facetData(): ParsedData {
		const rows = [
			{ id: 'T1078', name: 'Valid accounts', family: 'Persistence' },
			{ id: 'T1053', name: 'Scheduled task', family: 'Persistence' },
		];
		return { columns: Object.keys(rows[0]), rows, rowCount: 2 };
	}

	it.each(PATHS)('$name', async ({ run }) => {
		const { app, files } = makeApp();
		await run({ app, data: facetData(), rec: hubRecipe });
		const hubPath = [...files.keys()].find((p) => p.includes('Tactics/'));
		expect(hubPath).toBeDefined();

		// Rewind to the pre-markers shape AND add user prose below the H1 — the
		// exact thing `mergeHubBody` preserved before this slice. Adoption replays
		// that merger, so the preserved set is unchanged and this never conflicts.
		const legacy = files.get(hubPath!)!
			.split('\n').filter((l) => !l.startsWith('<!-- crosswalker:')).join('\n')
			+ '\nMy tradecraft notes.\n';
		files.set(hubPath!, legacy);

		const result = await run({ app, data: facetData(), rec: hubRecipe });
		expect(result.conflicts ?? []).toEqual([]);
		const adopted = files.get(hubPath!)!;
		expect(adopted).toContain('My tradecraft notes.');
		expect(adopted).toContain(START);

		// Second run is a no-op.
		await run({ app, data: facetData(), rec: hubRecipe });
		expect(stable(files.get(hubPath!)!)).toBe(stable(adopted));
	});
});
