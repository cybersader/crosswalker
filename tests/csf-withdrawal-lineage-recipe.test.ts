/**
 * The claim under test: publisher release lineage is an ordinary mapping-set
 * import, not a special subsystem.
 *
 * This suite runs REAL NIST CSF 2.0 withdrawal lineage — 79 withdrawal markers
 * carrying 127 successor references, 34 of them genuine one-to-many splits —
 * through the SHIPPED crosswalk path with nothing but a recipe: the same AJV
 * recipe validator, the same `source.where` stage, the same pure `render()`,
 * and the same Tier 1 frontmatter schema every other crosswalk import uses.
 * No lineage-specific code path is exercised anywhere below the predicate enum,
 * which is the whole point.
 *
 * It also pins the two grammar limits the recipe had to be designed around, so
 * that if either is ever lifted the recipe (and the producer step it needs) can
 * be simplified deliberately rather than by accident:
 *
 *   1. One source row renders exactly one note, so a 1-to-5 withdrawal marker
 *      cannot become 5 edge notes without a producer that multiplies rows.
 *   2. `source.where` can now check literal substrings but still cannot
 *      multiply a row into one edge per successor; this recipe needs a producer.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCSV } from '../src/import/parsers/csv-parser';
import { prepareSourceStage, SourceStageError } from '../src/source';
import { render, type Recipe } from '../src/render';
import { validateRecipe, validateTier1Frontmatter } from '../src/validation/validator';
import type { ParsedData } from '../src/types/config';

const REPO = join(__dirname, '..');
const RECIPE_PATH = 'recipes/import/nist-csf-2-withdrawal-lineage.json';
const EDGE_LIST_PATH = 'recipes/import/crosswalks/nist-csf-2-withdrawal-lineage.csv';

interface LineageRecipe extends Recipe {
	source: { ontology: string; levels: string[]; where?: string };
}

const recipe = JSON.parse(readFileSync(join(REPO, RECIPE_PATH), 'utf8')) as LineageRecipe;

/** Provenance the generation engine supplies; fixed here so notes validate. */
const PROVENANCE = {
	spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
	source_ref: {
		file: 'nist-csf-2-withdrawal-lineage.csv',
		curie: 'nist-csf-1-1:_',
		source_hash: `sha256-${'0'.repeat(64)}`,
	},
	produced_at: '2026-08-28T00:00:00.000Z',
	recipe: { id: recipe.recipe },
};

let parsed: ParsedData;
let admitted: Record<string, unknown>[];
let excluded: number;
let notes: { path: string; frontmatter: Record<string, unknown>; body: string }[];

beforeAll(async () => {
	parsed = await parseCSV(readFileSync(join(REPO, EDGE_LIST_PATH), 'utf8'), {});
	const stage = await prepareSourceStage(parsed, recipe.source);
	admitted = [];
	for await (const row of stage.rows as AsyncIterable<Record<string, unknown>>) admitted.push(row);
	stage.finalize();
	excluded = stage.excludedCount;
	notes = admitted.map((row) => {
		const address = render(recipe, { curie: `xwalk:${String(row.curie)}`, scope: row });
		return {
			path: address.primary.path,
			frontmatter: { ...address.frontmatter, _crosswalker: PROVENANCE },
			body: address.body.map((b) => b.content).join('\n'),
		};
	});
});

describe('the recipe is an ordinary shipped recipe', () => {
	it('validates against spec/recipe.schema.json', () => {
		const result = validateRecipe(recipe);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('declares the crosswalk-edge note kind, so it lands in `mappings` like any other crosswalk', () => {
		expect(recipe.target.layout).toHaveLength(1);
		expect(recipe.target.layout[0]).toMatchObject({ mechanism: 'file', kind: 'crosswalk-edge' });
	});
});

describe('source.where selects the lineage rows out of a file it does not otherwise touch', () => {
	it('the edge list carries every sheet row, not a pre-filtered selection', () => {
		// 231 sheet rows, of which 79 withdrawal markers expand to 127 references.
		expect(parsed.columns).toEqual(['curie', 'Subcategory', 'successor_id']);
		expect(parsed.rows).toHaveLength(279);
	});

	it('admits exactly the 127 successor references and excludes the other 152 rows', () => {
		expect(admitted).toHaveLength(127);
		expect(excluded).toBe(152);
	});

	it('excludes the banner rows and the current subcategories, keeping only withdrawal markers', () => {
		for (const row of admitted) expect(String(row.Subcategory)).toContain('[Withdrawn:');
	});
});

describe('what the recipe emits', () => {
	it('one note per successor reference, each at its own path', () => {
		expect(notes).toHaveLength(127);
		expect(new Set(notes.map((n) => n.path)).size).toBe(127);
	});

	it('every note is valid Tier 1 crosswalk-edge frontmatter', () => {
		for (const note of notes) {
			const result = validateTier1Frontmatter(note.frontmatter);
			if (!result.valid) throw new Error(`${note.path}: ${result.errors.join('; ')}`);
		}
	});

	it('asserts superseded_by from the OLD release to the new one, on every edge', () => {
		for (const note of notes) {
			expect(note.frontmatter.predicate_id).toBe('superseded_by');
			expect(String(note.frontmatter.subject_id)).toMatch(/^nist-csf-1-1:/);
			expect(String(note.frontmatter.object_id)).toMatch(/^nist-csf-2:/);
		}
	});

	it('records the lineage as the publisher, not a local reviewer', () => {
		for (const note of notes) {
			expect(note.frontmatter.mapping_provider).toContain('NIST');
			expect(note.frontmatter.creator_id).toBe('NIST');
			expect(note.frontmatter.mapping_set_id).toBe(
				'https://crosswalker.dev/crosswalks/nist-csf-2-withdrawal-lineage',
			);
			// A producer must never write a review fact.
			expect(note.frontmatter.review_status).toBeUndefined();
			expect(note.frontmatter.reviewed_against).toBeUndefined();
		}
	});

	it("preserves NIST's own disposition verb instead of flattening it into the predicate", () => {
		const counts = new Map<string, number>();
		for (const note of notes) {
			const verb = String(note.frontmatter.lineage_disposition);
			counts.set(verb, (counts.get(verb) ?? 0) + 1);
		}
		// Counted from the workbook: 61 / 17 / 1 markers, expanded per successor.
		expect([...counts.keys()].sort()).toEqual(['Incorporated into', 'Moved into', 'Moved to']);
		expect(counts.get('Moved into')).toBe(1);
	});
});

describe('the cardinalities a flat previous_ids field cannot express', () => {
	const edgesFor = (subject: string) =>
		notes
			.filter((n) => n.frontmatter.subject_id === `nist-csf-1-1:${subject}`)
			.map((n) => String(n.frontmatter.object_id));

	it('one-to-one rename: ID.GV-03 moved to GV.OC-03', () => {
		expect(edgesFor('ID.GV-03')).toEqual(['nist-csf-2:GV.OC-03']);
	});

	it('one-to-many split: ID.AM-06 was incorporated into two successors', () => {
		expect(edgesFor('ID.AM-06')).toEqual(['nist-csf-2:GV.RR-02', 'nist-csf-2:GV.SC-02']);
	});

	it('the widest split in the framework, five successors, is five edges', () => {
		expect(edgesFor('ID.SC-01')).toEqual([
			'nist-csf-2:GV.RM-05',
			'nist-csf-2:GV.SC-01',
			'nist-csf-2:GV.SC-06',
			'nist-csf-2:GV.SC-09',
			'nist-csf-2:GV.SC-10',
		]);
	});

	it('many-to-one merge: three withdrawn subcategories all name PR.AT-02', () => {
		const subjects = notes
			.filter((n) => n.frontmatter.object_id === 'nist-csf-2:PR.AT-02')
			.map((n) => String(n.frontmatter.subject_id))
			.sort();
		expect(subjects).toEqual([
			'nist-csf-1-1:PR.AT-03',
			'nist-csf-1-1:PR.AT-04',
			'nist-csf-1-1:PR.AT-05',
		]);
	});

	it('79 markers produce 127 edges, so the split cardinality is not collapsed anywhere', () => {
		const subjects = new Set(notes.map((n) => n.frontmatter.subject_id));
		expect(subjects.size).toBe(79);
		expect(notes).toHaveLength(127);
	});

	it('category-level successors are emitted, not dropped for being unresolvable', () => {
		// GV.PO, GV.RR, ID.IM and DE.AE are categories, so a flat subcategory
		// import has no concept for them. The report names them as "not imported
		// in this vault"; silently dropping the assertion would be worse.
		const categoryTargets = notes
			.map((n) => String(n.frontmatter.object_id))
			.filter((id) => !/-\d\d$/.test(id))
			.sort();
		expect([...new Set(categoryTargets)]).toEqual([
			'nist-csf-2:DE.AE',
			'nist-csf-2:GV.PO',
			'nist-csf-2:GV.RR',
			'nist-csf-2:ID.IM',
		]);
	});
});

describe('the grammar limits this recipe is designed around', () => {
	it('render() returns ONE address per row, so a 1-to-5 marker cannot fan out in the recipe', () => {
		const marker = admitted.find((r) => String(r.Subcategory).includes('ID.SC-01:'))!;
		const address = render(recipe, { curie: 'xwalk:probe', scope: marker });
		// The successor list is right there in the row, and the address is still
		// singular. This is why tools/lineage-from-csf-workbook.ts exists.
		expect(String(marker.Subcategory)).toContain('GV.SC-10');
		expect(address.primary.path).toMatch(/^cw-nist-csf-1-1-id-sc-01--nist-csf-2-/);
		expect(Object.keys(address.primary)).not.toContain('paths');
	});

	it('source.where accepts a literal substring without regex', async () => {
		const stage = await prepareSourceStage(parsed, { where: "$contains(Subcategory, '[Withdrawn')" });
		expect(stage.active).toBe(true);
	});

	it.each([
		'$contains(Subcategory, /Withdrawn/)',
		'$contains(Subcategory, marker)',
		'$match(Subcategory, /Withdrawn/)',
		"$substring(Subcategory, 0, 10) = '[Withdrawn'",
	])('source.where rejects %s at preflight', async (where) => {
		await expect(prepareSourceStage(parsed, { where })).rejects.toBeInstanceOf(SourceStageError);
	});

	it('the template engine CAN read the bracketed prose, which is the half that works', () => {
		// Recorded because recipes/import/nist-csf-2.json long claimed otherwise:
		// the regex filter argument lexer has been balanced-paren aware since R2.4,
		// so capture groups are writable. The extraction is not the problem; the
		// fan-out is.
		const marker = admitted.find((r) => String(r.Subcategory).includes('ID.SC-01:'))!;
		const address = render(recipe, { curie: 'xwalk:probe', scope: marker });
		expect(address.frontmatter.lineage_disposition).toBe('Incorporated into');
		expect(address.frontmatter.subject_id).toBe('nist-csf-1-1:ID.SC-01');
	});
});
