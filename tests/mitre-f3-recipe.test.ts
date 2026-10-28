/**
 * mitre-f3-recipe.test.ts — the MITRE Fight Fraud Framework (F3) recognized source.
 *
 * Runs a SYNTHETIC fixture shaped like the F3 Excel `Techniques` sheet
 * (`tools/fixtures/synthetic/mitre-f3-mini.csv`, invented ids, names, and
 * descriptions; no F3 content) through the registry matcher and pure `render()`.
 *
 * Pins three things: the F3 shape is recognized confidently as F3; it is NOT
 * confidently recognized as ATT&CK (F3 reuses ATT&CK technique ids, so a shape
 * confusion would silently mint F3 notes under the wrong ontology); and an
 * ATT&CK-shaped sheet is not confidently recognized as F3. It also pins the
 * multi-tactic encoding: one cell, comma-plus-space list, emitted as a real list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCSV } from '../src/import/parsers/csv-parser';
import { render, type Recipe } from '../src/render';
import { validateRecipe } from '../src/validation/validator';
import {
	RECIPE_REGISTRY,
	CONFIDENT_MATCH_THRESHOLD,
	bestRecognizedRecipe,
	matchScore,
	ontologyForHeader,
	type RecipeRegistryEntry,
} from '../src/import/recipe-registry';
import type { ParsedData } from '../src/types/config';

const REPO = join(__dirname, '..');
const FIXTURE = 'tools/fixtures/synthetic/mitre-f3-mini.csv';
const recipe = JSON.parse(
	readFileSync(join(REPO, 'recipes/import/mitre-f3-technique.json'), 'utf8'),
) as Recipe;

function entry(id: string): RecipeRegistryEntry {
	const e = RECIPE_REGISTRY.find((r) => r.id === id);
	if (!e) throw new Error(`no registry entry for ${id}`);
	return e;
}

/** Column set of the ATT&CK Excel `techniques` sheet, as the ATT&CK recipe binds it. */
const ATTACK_TECHNIQUES_COLUMNS = [
	'ID', 'STIX ID', 'name', 'description', 'url', 'created', 'last modified', 'domain', 'version',
	'tactics', 'detection', 'platforms', 'data sources', 'is sub-technique', 'sub-technique of',
	'defenses bypassed', 'contributors', 'permissions required', 'supports remote',
	'system requirements', 'impact type', 'effective permissions', 'relationship citations',
];

let parsed: ParsedData;
let rows: Record<string, unknown>[];

beforeAll(async () => {
	parsed = await parseCSV(readFileSync(join(REPO, FIXTURE), 'utf8'), {});
	rows = parsed.rows as Record<string, unknown>[];
});

describe('the F3 recipe is an ordinary bundled recipe', () => {
	it('validates against spec/recipe.schema.json', () => {
		const result = validateRecipe(recipe);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('is registered under its own ontology with a plain label', () => {
		const e = entry('mitre-f3-technique-flat');
		expect(e.ontology).toBe('mitre-f3');
		expect(e.label).toContain('F3');
		expect(e.routingKind).toBe('concept');
		expect(e.requiredColumns).toEqual(['Technique ID']);
		expect(e.signatureColumns).toEqual(
			expect.arrayContaining(['Technique ID', 'Technique', 'Description', 'Tactic ID', 'Tactic Name']),
		);
	});
});

describe('recognition', () => {
	it('recognizes the F3 techniques shape confidently as F3', () => {
		expect(matchScore(entry('mitre-f3-technique-flat'), parsed.columns)).toBe(100);
		const best = bestRecognizedRecipe(parsed.columns);
		expect(best?.entry.id).toBe('mitre-f3-technique-flat');
		expect(best!.score).toBeGreaterThanOrEqual(CONFIDENT_MATCH_THRESHOLD);
	});

	it('does not confidently match the F3 shape to the ATT&CK recipe', () => {
		expect(matchScore(entry('mitre-attack-technique-flat'), parsed.columns)).toBeLessThan(
			CONFIDENT_MATCH_THRESHOLD,
		);
	});

	it('does not confidently match an ATT&CK techniques sheet to the F3 recipe', () => {
		expect(matchScore(entry('mitre-f3-technique-flat'), ATTACK_TECHNIQUES_COLUMNS)).toBeLessThan(
			CONFIDENT_MATCH_THRESHOLD,
		);
		expect(bestRecognizedRecipe(ATTACK_TECHNIQUES_COLUMNS)?.entry.id).toBe('mitre-attack-technique-flat');
	});

	it('does not match the F3 Tactics sheet (a different shape)', () => {
		expect(matchScore(entry('mitre-f3-technique-flat'), ['Tactic ID', 'Tactic Name', 'Tactic Description']))
			.toBeLessThan(CONFIDENT_MATCH_THRESHOLD);
	});

	it('names F3 from a header, and leaves T ids to ATT&CK', () => {
		expect(ontologyForHeader('Fight Fraud technique', RECIPE_REGISTRY)?.ontology).toBe('mitre-f3');
		const f3 = new RegExp(entry('mitre-f3-technique-flat').idPattern!);
		expect(f3.test('F9002.001')).toBe(true);
		expect(f3.test('T9999')).toBe(false);
	});
});

describe('what the recipe emits', () => {
	function renderRow(row: Record<string, unknown>) {
		return render(recipe, { curie: `mitre-f3:${String(row['Technique ID'])}`, scope: row });
	}

	it('one flat note per technique, named by its id, including dotted sub-techniques', () => {
		expect(rows.map((r) => renderRow(r).primary.path)).toEqual([
			'F9001.md', 'F9002.md', 'F9002.001.md', 'T9999.md',
		]);
	});

	it('emits multiple tactics in one cell as a trimmed list, in both tactic properties', () => {
		const fm = renderRow(rows[2]).frontmatter;
		expect(fm.tactic_ids).toEqual(['TA9001', 'FA9001', 'FA9002']);
		expect(fm.tactics).toEqual(['Synthetic Tactic B', 'Synthetic Tactic A', 'Synthetic Tactic C']);
		expect(renderRow(rows[0]).frontmatter.tactics).toEqual(['Synthetic Tactic A']);
	});

	it('keeps the description in the body and appends the licence notice', () => {
		const body = renderRow(rows[0]).body.map((b) => b.content).join('\n');
		expect(body).toContain('Synthetic description written for tests.');
		expect(body).toContain('Apache License');
		expect(renderRow(rows[0]).frontmatter.description).toBeUndefined();
	});
});
