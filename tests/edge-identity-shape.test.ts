/**
 * edge-identity-shape.test.ts — AM-29 (2026-08-31): an endpoint is never an
 * edge's identity.
 *
 * WHAT THE PASS-11 SUITE PINNED. `subject_id` sat in the self-identity chain
 * (`curie ?? id ?? subject_id ?? control_id ?? code`), so a crosswalk row was
 * identified by its SUBJECT. Every edge leaving one control therefore derived
 * that control's identity:
 *
 *     tools/fixtures/realistic/csf-to-800-53-crosswalk.csv   30 rows, 22 subjects
 *     sidecar-phase-3-queries.spec.ts inline fixture          5 rows,  3 subjects
 *
 * Before the within-run duplicate guard existed those rows were written on top of
 * each other and the last writer won — silently, so a crosswalk import could drop
 * a third of its assertions and tell nobody. After the guard, every edge but the
 * first was correctly refused, and six E2E declarations went red for the right
 * reason. Either way the identity was wrong: a relationship is identified by its
 * endpoints TOGETHER, never by one of them.
 *
 * THE SHAPE IS READ FROM WHAT THE RUN DECLARES — the row carries both a subject
 * and an object — and never from a filename, a folder or a recipe's note kind.
 * That is the rule this whole arc exists to enforce, and reintroducing a
 * path-shaped signal here would defeat it at the point it was just fixed.
 *
 * Organised as: the shape decision and the composite identity alone, then the two
 * real fixtures' arithmetic, then the same properties end to end through the
 * generation engine, then the legacy record of what the frozen rule still does.
 */

import { TFile, TFolder } from 'obsidian';
import { readFileSync } from 'fs';
import { join } from 'path';
import { generateFromRecipe } from '../src/generation/generation-engine';
import {
	declaredIdentity,
	edgeIdentityLocalPart,
	edgeShapeOf,
	isValidCurieLocalPart,
} from '../src/generation/curie';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

// ---------------------------------------------------------------------------
// 1. Which rows are edge-shaped, and what an edge's identity is made of.
// ---------------------------------------------------------------------------

describe('AM-29: a row is edge-shaped when it states both endpoints', () => {
	it('reads the shape from the row\'s own columns, not from where the note will go', () => {
		expect(edgeShapeOf({ subject_id: 'a:1', predicate_id: 'p', object_id: 'b:2' }))
			.toEqual({ subject: 'a:1', predicate: 'p', object: 'b:2' });
		expect(edgeShapeOf({ subject_curie: 'a:1', object_curie: 'b:2' }))
			.toEqual({ subject: 'a:1', predicate: '', object: 'b:2' });
	});

	it('does not call a row an edge because it names ONE endpoint', () => {
		// The defect in miniature. A subject alone is a fact about some other
		// concept, not an identity for this row.
		expect(edgeShapeOf({ subject_id: 'a:1' })).toBeNull();
		expect(edgeShapeOf({ object_id: 'b:2' })).toBeNull();
	});

	it('treats a stated-but-empty predicate as a value, not as a missing field', () => {
		// An edge with no predicate is still an edge; its identity carries an empty
		// predicate field, which is a different triple from one that states a
		// predicate rather than an unknown one.
		const withPredicate = edgeIdentityLocalPart('a:1', 'p', 'b:2');
		const without = edgeIdentityLocalPart('a:1', '', 'b:2');
		expect(withPredicate).not.toBe(without);
	});
});

describe('AM-29: an edge identity is a function of all three endpoints', () => {
	it('separates two edges that share a subject', () => {
		// THE property the six E2E declarations were failing on.
		expect(edgeIdentityLocalPart('a:1', 'p', 'b:2')).not.toBe(edgeIdentityLocalPart('a:1', 'p', 'b:3'));
	});

	it('separates two edges that share both endpoints but assert different things', () => {
		expect(edgeIdentityLocalPart('a:1', 'exact', 'b:2')).not.toBe(edgeIdentityLocalPart('a:1', 'close', 'b:2'));
	});

	it('separates two triples whose readable heads are identical', () => {
		// The readable head is a courtesy and IS many-to-one: it runs the endpoints
		// through the charset filter, so `a b` and `a-b` produce the same text. The
		// digest over the exact triple is the only thing keeping these two edges
		// apart, which is exactly the load the head must not be asked to carry.
		const spaced = edgeIdentityLocalPart('a b', 'p', 'c');
		const hyphened = edgeIdentityLocalPart('a-b', 'p', 'c');
		expect(spaced).not.toBe(hyphened);
		// Stated explicitly, so a future change that made the heads differ would not
		// silently turn this into a test of the head instead of the digest.
		expect(spaced.slice(0, spaced.lastIndexOf('-'))).toBe(hyphened.slice(0, hyphened.lastIndexOf('-')));
	});

	it('is a legal CURIE local part, and readable enough to recognise in a folder', () => {
		const local = edgeIdentityLocalPart('nist-csf:GV.OC-01', 'is_equivalent_to', 'nist:PM-1');
		expect(isValidCurieLocalPart(local)).toBe(true);
		expect(local).toContain('GV.OC-01');
		expect(local).toContain('PM-1');
	});

	it('gives the identical triple the identical identity, so a repeated row still collides', () => {
		// Deliberate. The guard must still fire on a genuinely duplicated edge row;
		// making every row unique would hide a real defect in a source.
		expect(edgeIdentityLocalPart('a:1', 'p', 'b:2')).toBe(edgeIdentityLocalPart('a:1', 'p', 'b:2'));
	});
});

describe('AM-29: the chain consults the right columns for the right shape', () => {
	it('takes a row at its word when it states its own identity, edge-shaped or not', () => {
		// An edge export that carries an explicit `id` per mapping is naming the
		// mapping, and that statement outranks anything derived.
		expect(declaredIdentity({ id: 'MAP-1', subject_id: 'a:1', object_id: 'b:2' }))
			.toEqual({ kind: 'column', column: 'id', raw: 'MAP-1' });
	});

	it('never lets a concept identifier answer for an edge', () => {
		// `control_id` on an edge row names the edge's SUBJECT. Taking it as the
		// edge's identity is the same defect `subject_id` caused, one column over.
		expect(declaredIdentity({ control_id: 'AC-2', subject_id: 'a:1', object_id: 'b:2' }))
			.toEqual({ kind: 'edge', subject: 'a:1', predicate: '', object: 'b:2' });
	});

	it('still lets a concept identifier answer for a concept row', () => {
		// The control. Removing `subject_id` from the chain must not disturb the
		// ordinary framework import, which is every other fixture in this repo.
		expect(declaredIdentity({ control_id: 'AC-2' })).toEqual({ kind: 'column', column: 'control_id', raw: 'AC-2' });
		expect(declaredIdentity({ code: 'A.9.2.1' })).toEqual({ kind: 'column', column: 'code', raw: 'A.9.2.1' });
	});

	it('declares nothing for a row that states one endpoint and no identity', () => {
		// `subject_id` has left the chain outright: a lone subject falls through to
		// the caller's last resort, rather than quietly becoming this row's name.
		expect(declaredIdentity({ subject_id: 'a:1' })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. The two real fixtures, by the numbers the suite report pinned.
// ---------------------------------------------------------------------------

/** Minimal CSV reader: these fixtures are plain, quoted-comma free, and the
 *  point is the arithmetic, not the parser (which `csv-parser.test.ts` owns). */
function readCsv(relativePath: string): Record<string, string>[] {
	const text = readFileSync(join(__dirname, '..', relativePath), 'utf8').replace(/\r\n/g, '\n').trim();
	const [header, ...lines] = text.split('\n');
	const columns = header.split(',');
	return lines.map((line) => {
		const cells = line.split(',');
		return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? '']));
	});
}

describe('AM-29: the bundled OLIR crosswalk derives one identity per edge', () => {
	const ROWS = readCsv('tools/fixtures/realistic/csf-to-800-53-crosswalk.csv');

	it('is still the fixture the arithmetic was measured on', () => {
		// Pinned so a later edit to the fixture cannot quietly turn the counts below
		// into a statement about a different file.
		expect(ROWS).toHaveLength(30);
		expect(new Set(ROWS.map((row) => row.subject_id)).size).toBe(22);
	});

	it('derives 30 identities from 22 subjects', () => {
		// The headline. Under the old chain this set had 22 members, and the eight
		// rows that lost were real crosswalk assertions.
		const identities = ROWS.map((row) => {
			const declared = declaredIdentity(row);
			if (declared?.kind !== 'edge') throw new Error(`row is not edge-shaped: ${JSON.stringify(row)}`);
			return edgeIdentityLocalPart(declared.subject, declared.predicate, declared.object);
		});
		expect(new Set(identities).size).toBe(30);
	});

	it('would have derived only 22 under the endpoint rule, which is why this matters', () => {
		// The frozen record of the defect, computed here rather than recalled, so
		// the number the amendment cites can be checked against the file.
		expect(new Set(ROWS.map((row) => row.subject_id)).size).toBe(22);
	});
});

// ---------------------------------------------------------------------------
// 3. End to end through the generation engine.
// ---------------------------------------------------------------------------

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['', 'Crosswalks']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
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
				const content = files.get(file.path);
				if (content === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
	};
	return { app: app as unknown as App, files };
}

function curiesIn(files: Map<string, string>): string[] {
	return [...files.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => {
			const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
			const fm = match ? (yaml.load(match[1]) as Record<string, unknown>) : {};
			return String(fm.curie ?? '');
		});
}

function parsed(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

/**
 * The address is built from BOTH endpoints, so the 30 rows have 30 addresses and
 * a collapse in the count of written notes can only be an identity collapse. A
 * template using the subject alone would replace the identity defect with a path
 * defect and prove nothing.
 */
const RECIPE: Recipe = {
	recipe: 'crosswalk',
	source: { ontology: 'cw', levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{subject_id|fs-safe}--{object_id|fs-safe}.md' }],
	},
};

const options = (importSet: unknown) => ({
	basePath: 'Crosswalks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	importSet: importSet as never,
});

/** The phase-3 spec's inline fixture: five edges over three subjects. */
const PHASE_3 = [
	{ subject_id: 'p3:A', predicate_id: 'is_equivalent_to', object_id: 'q3:1' },
	{ subject_id: 'p3:B', predicate_id: 'is_equivalent_to', object_id: 'q3:2' },
	{ subject_id: 'p3:C', predicate_id: 'is_equivalent_to', object_id: 'q3:3' },
	{ subject_id: 'p3:A', predicate_id: 'is_equivalent_to', object_id: 'q3:4' },
	{ subject_id: 'p3:A', predicate_id: 'is_equivalent_to', object_id: 'q3:5' },
];

describe('AM-29 end to end: five edges over three subjects are five notes', () => {
	it('writes every edge, with no duplicate-identity refusal', async () => {
		// The exact shape of the phase-3 barrier failure: `3/3 files ... (expected 5)`.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(PHASE_3), RECIPE, options('new'));
		expect(result.errors).toEqual([]);
		expect(files.size).toBe(5);
		expect(new Set(curiesIn(files)).size).toBe(5);
	});

	it('still refuses a genuinely duplicated edge row, naming the row that claimed it first', async () => {
		// The other half. Injectivity over the triple must not become "every row is
		// unique": a source that states one mapping twice has a defect, and the
		// second row would overwrite the first.
		const twice = [...PHASE_3, { ...PHASE_3[0] }];
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(twice), RECIPE, options('new'));

		expect(files.size).toBe(5);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].row).toBe(6);
		expect(result.errors[0].message).toContain('Duplicate identity in this import');
	});

	it('leaves an ordinary concept import exactly as it was', async () => {
		// The regression guard for every other fixture in the repo: a row with no
		// endpoints is not edge-shaped, and `control_id` still answers for it.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed([
			{ key: 'a', control_id: 'AC-2' },
			{ key: 'b', code: 'A.9.2.1' },
		]), {
			...RECIPE,
			target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{key}.md' }] },
		}, options('new'));

		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['cw:AC-2', 'cw:A.9.2.1']);
	});

	it('does not identify a row by a lone subject', async () => {
		// A source that names a subject and nothing else no longer borrows that
		// concept's identity; it falls through to the caller's last resort.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed([{ subject_id: 'p3:A' }]), {
			...RECIPE,
			target: { layout: [{ level: 'leaf', mechanism: 'file', template: 'lone.md' }] },
		}, options('new'));

		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['cw:row-1']);
	});
});

describe('AM-29: the frozen legacy rule still does what those vaults carry', () => {
	it('collapses the same five edges onto three identities under a legacy set', async () => {
		// Pinned as the record of the defect, driven through the shipped legacy rule
		// rather than asserted from memory. The two rows the old chain merged are now
		// named refusals instead of the silent overwrite they used to be — the guard
		// changes no identity, so it is safe on sets that must keep theirs forever.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(PHASE_3), RECIPE, options({ id: 'iset-legacy' }));

		expect(curiesIn(files).sort()).toEqual(['cw:A', 'cw:B', 'cw:C']);
		expect(result.errors).toHaveLength(2);
		for (const error of result.errors) expect(error.message).toContain('Duplicate identity in this import');
	});
});
