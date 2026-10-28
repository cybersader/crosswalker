/**
 * Classic column-mapping body columns become canonical `also_emit.body`.
 *
 * The classic shim used to drop `mapping.body`, so the recipe copy a classic
 * import keeps could not restore those columns on export. These tests pin
 * (1) the translation rule, and (2) that the written note is byte-identical to
 * what the legacy body writer produced before the translation existed.
 */

import { TFile, TFolder } from 'obsidian';
import { generateNotes, buildNoteData, composeDocumentBody } from '../src/generation/generation-engine';
import type { GenerationOptions } from '../src/generation/generation-engine';
import * as shim from '../src/generation/legacy-recipe-shim';
import { legacyConfigToRecipe, legacyBodyToProjections } from '../src/generation/legacy-recipe-shim';
import { discoverImportSets } from '../src/generation/import-set';
import type { BodyMapping, ImportRecipe, LinkMapping, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => files.set(file.path, content),
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => folders.add(path),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				const match = text && /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				return { frontmatter: match ? (yaml.load(match[1]) as Record<string, unknown>) : {} };
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { app: app as any, files };
}

const START = '<!-- crosswalker:body:start v=1 -->';
const END = '<!-- crosswalker:body:end -->';

const row = {
	id: 'AC-2',
	title: 'Account management',
	description: 'Manage accounts.\nReview them yearly.',
	snippet: 'enable_audit = true',
	guidance: 'Line one\nLine two',
	steps: 'First\n  Second  ',
	summary: 'Summary prose.',
	related: 'AC-1',
	empty: '',
};

function parsed(): ParsedData {
	return { columns: Object.keys(row), rows: [{ ...row }], rowCount: 1 };
}

function config(body: BodyMapping[], links: LinkMapping[] = []): Partial<ImportRecipe> {
	return {
		mapping: {
			hierarchy: [],
			frontmatter: [{ column: 'id', key: 'id' }],
			links,
			body,
			filename: { template: '{title}', sanitize: true },
		},
	};
}

const options: GenerationOptions = {
	basePath: 'Frameworks',
	overwriteMode: 'replace',
	createFolders: true,
	sourceFileName: 'source.csv',
};

/** The managed body region of the one note a run wrote. */
async function writtenBody(cfg: Partial<ImportRecipe>): Promise<string> {
	const { app, files } = makeApp();
	const result = await generateNotes(app, parsed(), cfg, options);
	expect(result.errors).toEqual([]);
	const note = [...files.entries()].find(([p]) => p.endsWith('Account management.md'))![1];
	const start = note.indexOf(START);
	const end = note.indexOf(END);
	expect(start).toBeGreaterThan(-1);
	return note.slice(start + START.length + 1, end);
}

/** What the legacy body writer produces for the same config, independently. */
function legacyBody(cfg: Partial<ImportRecipe>): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = buildNoteData({ ...row }, 1, cfg.mapping as any, options, '', [], true);
	return `${composeDocumentBody('Account management', data.body).replace(/\n+$/, '')}\n`;
}

const allFormats: BodyMapping[] = [
	{ column: 'description', heading: 'Description' },
	{ column: 'snippet', heading: 'Snippet', format: 'code' },
	{ column: 'guidance', heading: 'Guidance', format: 'quote' },
	{ column: 'steps', heading: 'Steps', format: 'list' },
	{ column: 'empty', heading: 'Empty' },
];

describe('classic body columns translate to canonical also_emit.body', () => {
	it('maps headings to sections, bare columns to append, and keeps the recipe minimal', () => {
		const recipe = legacyConfigToRecipe(config([
			...allFormats,
			{ column: 'Control Text', heading: '' },
		]) as ImportRecipe);
		expect(recipe.target.also_emit?.body).toEqual([
			{ template: '{description|optional}', position: 'section', heading: 'Description' },
			{ template: '{snippet|optional}', position: 'section', heading: 'Snippet', format: 'code' },
			{ template: '{guidance|optional}', position: 'section', heading: 'Guidance', format: 'quote' },
			{ template: '{steps|optional}', position: 'section', heading: 'Steps', format: 'list' },
			{ template: '{empty|optional}', position: 'section', heading: 'Empty' },
			{ template: '{Control Text|optional}', position: 'append' },
		]);
	});

	it('quotes a column name the template grammar cannot hold bare', () => {
		expect(legacyBodyToProjections(config([{ column: 'a|b', heading: 'X' }]) as ImportRecipe))
			.toEqual([{ template: "{['a|b']|optional}", position: 'section', heading: 'X' }]);
	});

	it('emits nothing (legacy writer keeps the body) when any column carries a transform', () => {
		const cfg = config([
			{ column: 'description', heading: 'Description' },
			{ column: 'summary', heading: 'Summary', transform: [{ type: 'trim' } as never] },
		]);
		expect(legacyConfigToRecipe(cfg as ImportRecipe).target.also_emit?.body).toBeUndefined();
	});

	it('emits nothing for a heading-less column when links also go to the body', () => {
		const links: LinkMapping[] = [{ column: 'related', type: 'wikilink', location: 'body' }];
		expect(legacyBodyToProjections(config([{ column: 'summary' }], links) as ImportRecipe)).toEqual([]);
	});

	it('emits nothing when a body heading equals a body-link section heading', () => {
		const links: LinkMapping[] = [{ column: 'related', type: 'wikilink', location: 'both', bodySection: 'See' }];
		expect(legacyBodyToProjections(config([{ column: 'summary', heading: 'See' }], links) as ImportRecipe)).toEqual([]);
	});
});

describe('classic body output is byte-identical to the legacy body writer', () => {
	it('every format, an empty column, and a body-located link section', async () => {
		const links: LinkMapping[] = [{ column: 'related', type: 'wikilink', location: 'body', bodySection: 'Related' }];
		const cfg = config(allFormats, links);
		expect(legacyConfigToRecipe(cfg as ImportRecipe).target.also_emit?.body).toHaveLength(5);
		const expected = [
			'# Account management',
			'',
			'## Related',
			'',
			'[[AC-1]]',
			'',
			'## Description',
			'',
			'Manage accounts.',
			'Review them yearly.',
			'',
			'## Snippet',
			'',
			'```',
			'enable_audit = true',
			'```',
			'',
			'## Guidance',
			'',
			'> Line one',
			'> Line two',
			'',
			'## Steps',
			'',
			'- First',
			'- Second',
			'',
		].join('\n');
		expect(legacyBody(cfg)).toBe(expected);
		expect(await writtenBody(cfg)).toBe(expected);
	});

	it('a heading-less append followed by a section', async () => {
		const cfg = config([{ column: 'summary' }, { column: 'description', heading: 'Description' }]);
		expect(legacyConfigToRecipe(cfg as ImportRecipe).target.also_emit?.body?.[0]).toEqual(
			{ template: '{summary|optional}', position: 'append' },
		);
		const expected = '# Account management\n\nSummary prose.\n\n## Description\n\nManage accounts.\nReview them yearly.\n';
		expect(legacyBody(cfg)).toBe(expected);
		expect(await writtenBody(cfg)).toBe(expected);
	});

	it('the transform fallback still writes the legacy body', async () => {
		const cfg = config([{ column: 'summary', heading: 'Summary', transform: [{ type: 'trim' } as never] }]);
		expect(await writtenBody(cfg)).toBe('# Account management\n\n## Summary\n\nSummary prose.\n');
	});
});

describe('known value-level differences from the legacy body writer', () => {
	// These are the canonical renderer's documented format semantics; the
	// legacy writer had none of them. They only show for the values below.
	const cases: Array<[string, BodyMapping, string, string]> = [
		['quote, blank line', { column: 'v', heading: 'H', format: 'quote' }, 'a\n\nb', '> a\n>\n> b'],
		['list, blank line', { column: 'v', heading: 'H', format: 'list' }, 'a\n\nb', '- a\n- b'],
		['code, embedded fence', { column: 'v', heading: 'H', format: 'code' }, 'x ``` y', '````\nx ``` y\n````'],
	];
	it.each(cases)('%s', async (_label, mapping, value, canonical) => {
		const { app, files } = makeApp();
		const data: ParsedData = { columns: ['title', 'v'], rows: [{ title: 'T', v: value }], rowCount: 1 };
		await generateNotes(app, data, config([mapping]), options);
		const note = files.get('Frameworks/T.md')!;
		expect(note).toContain(`## H\n\n${canonical}\n${END}`);
	});

	it('a whitespace-only value is omitted rather than written as an empty-looking section', async () => {
		const { app, files } = makeApp();
		const data: ParsedData = { columns: ['title', 'v'], rows: [{ title: 'T', v: '   ' }], rowCount: 1 };
		await generateNotes(app, data, config([{ column: 'v', heading: 'H' }]), options);
		expect(files.get('Frameworks/T.md')).not.toContain('## H');
	});
});

describe('re-importing a classic set imported before body columns were translated', () => {
	afterEach(() => jest.restoreAllMocks());

	it('updates the recipe digest without duplicating sections or losing user prose', async () => {
		const links: LinkMapping[] = [{ column: 'related', type: 'wikilink', location: 'body', bodySection: 'Related' }];
		const cfg = config(allFormats, links);
		const { app, files } = makeApp();
		const NOTE = 'Frameworks/Account management.md';

		// Run 1 as it ran before: the shim emitted no body, so the legacy writer
		// wrote the body columns and the recipe (and digest) had no body.
		const real = shim.legacyConfigToRecipe;
		const spy = jest.spyOn(shim, 'legacyConfigToRecipe').mockImplementation((c, o) => {
			const r = real(c, o);
			const alsoEmit = r.target.also_emit ? { ...r.target.also_emit } : undefined;
			if (alsoEmit) delete alsoEmit.body;
			return { ...r, target: { ...r.target, also_emit: alsoEmit } };
		});
		const first = await generateNotes(app, parsed(), cfg, options);
		expect(first.errors).toEqual([]);
		spy.mockRestore();
		const before = files.get(NOTE)!;
		const digestOf = (text: string) =>
			(yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as { _crosswalker: { recipe: { recipe_document_digest: string } } })
				._crosswalker.recipe.recipe_document_digest;

		// The user writes below the managed region.
		const userProse = '\n## My notes\n\nEvidence lives in the audit folder.\n';
		files.set(NOTE, before + userProse);

		// Run 2 with today's shim, refreshing the same set.
		const [existing] = await discoverImportSets(app, undefined);
		const second = await generateNotes(app, parsed(), cfg, { ...options, importSet: { id: existing.id } });
		expect(second.errors).toEqual([]);
		expect(second.conflicts ?? []).toEqual([]);
		const after = files.get(NOTE)!;

		expect(digestOf(after)).not.toBe(digestOf(before));
		// The managed region is unchanged byte for byte, and appears once.
		const region = (t: string) => t.slice(t.indexOf(START), t.indexOf(END) + END.length);
		expect(region(after)).toBe(region(before));
		expect(after.split(START)).toHaveLength(2);
		expect(after.split('## Description')).toHaveLength(2);
		expect(after.split('## Related')).toHaveLength(2);
		expect(after.endsWith(userProse)).toBe(true);
	});
});
