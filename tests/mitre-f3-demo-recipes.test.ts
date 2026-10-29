import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { render, type Recipe, type RenderReport } from '../src/render';
import { validateRecipe } from '../src/validation/validator';

const REPO = join(__dirname, '..');
const load = (file: string) => JSON.parse(readFileSync(join(REPO, file), 'utf8'));
const shipped = load('recipes/import/mitre-f3-technique.json') as Recipe;
const techniques = load('tools/fixtures/demo/recipes/mitre-f3-demo-linked.json') as Recipe;
const tactics = load('tools/fixtures/demo/recipes/mitre-f3-demo-tactics.json') as Recipe;
const source = load('Frameworks/mitre-f3-source.json');
const workbook = XLSX.read(readFileSync(join(REPO, 'Frameworks/f3-excel-v1.2.xlsx')), { type: 'buffer' });
const techniqueRows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets.Techniques, { raw: false });
const tacticRows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets.Tactics, { raw: false });

function technique(id: string) {
	const row = techniqueRows.find((r) => r['Technique ID'] === id)!;
	const report: RenderReport = { notes: [] };
	return { address: render(techniques, { curie: `mitre-f3:${id}`, scope: row }, report), report };
}

describe('pinned F3 v1.2 public source', () => {
	it('carries exact upstream bytes and the Apache licence', () => {
		for (const file of source.files) {
			expect(createHash('sha256').update(readFileSync(join(REPO, file.path))).digest('hex')).toBe(file.sha256);
		}
		expect(source.license).toBe('Apache-2.0');
		expect(source.upstream_commit).toMatch(/^[a-f0-9]{40}$/);
		expect(readFileSync(join(REPO, 'Frameworks/LICENSES/mitre-f3-LICENSE.txt'), 'utf8')).toContain('Apache License');
	});

	it('has the complete recorded release, not the synthetic mini fixture or v1', () => {
		expect(source.verified_counts).toEqual({ techniques: 138, multi_tactic_techniques: 41, sub_techniques: 55, tactics: 8 });
		expect(techniqueRows).toHaveLength(source.verified_counts.techniques);
		expect(techniqueRows.filter((r) => r['Tactic ID'].includes(','))).toHaveLength(source.verified_counts.multi_tactic_techniques);
		expect(techniqueRows.filter((r) => r['Technique ID'].includes('.'))).toHaveLength(source.verified_counts.sub_techniques);
		expect(tacticRows).toHaveLength(source.verified_counts.tactics);
	});
});

describe('demo-only F3 recipes', () => {
	it.each([techniques, tactics])('validates $recipe against the existing grammar', (recipe) => {
		expect(validateRecipe(recipe)).toMatchObject({ valid: true, errors: [] });
		expect(recipe.source.ontology).toBe('mitre-f3');
	});

	it('extends the shipped technique projections without changing its contract', () => {
		expect(techniques.target.layout).toEqual(shipped.target.layout);
		expect(techniques.target.also_emit?.body).toEqual(shipped.target.also_emit?.body);
		expect(techniques.target.also_emit?.frontmatter?.managed).toMatchObject(shipped.target.also_emit!.frontmatter!.managed!);
		expect(shipped.target.also_emit?.frontmatter?.managed).not.toHaveProperty('parent');
		expect(shipped.target.enrichment).toBeUndefined();
	});

	it.each(['F1002', 'T1056'])('omits parents on top-level %s, without render warnings', (id) => {
		const { address, report } = technique(id);
		expect(address.frontmatter).not.toHaveProperty('parent');
		expect(address.frontmatter).not.toHaveProperty('parent_curie');
		expect(report.notes).toEqual([]);
	});

	it.each(['F1002.001', 'T1056.001'])('links dotted %s to its real parent, without a new filter', (id) => {
		const { address, report } = technique(id);
		expect(address.frontmatter.parent).toBe(`[[${id.split('.')[0]}]]`);
		expect(address.frontmatter.parent_curie).toBe(`mitre-f3:${id.split('.')[0]}`);
		expect(report.notes).toEqual([]);
	});

	it('renders every row with matching tactic links and no missing or self-parent links', () => {
		const ids = new Set(techniqueRows.map((r) => r['Technique ID']));
		const tacticIds = new Set(tacticRows.map((r) => r['Tactic ID']));
		for (const row of techniqueRows) {
			const id = row['Technique ID'];
			const { address, report } = technique(id);
			expect(address.primary.path).toBe(`${id}.md`);
			expect(report.notes).toEqual([]);
			const links = row['Tactic ID'].split(',').map((s) => s.trim());
			expect(address.frontmatter.tactic_notes).toEqual(links.map((s) => `[[${s}]]`));
			for (const tactic of links) expect(tacticIds.has(tactic)).toBe(true);
			if (id.includes('.')) expect(ids.has(id.split('.')[0])).toBe(true);
		}
		for (const row of tacticRows) {
			const result = render(tactics, { curie: `mitre-f3:${row['Tactic ID']}`, scope: row });
			expect(result.primary.path).toBe(`${row['Tactic ID']}.md`);
			expect(result.frontmatter.title).toBe(row['Tactic Name']);
			expect(result.body[0].content).toContain(row['Tactic Description'].trim());
			expect(result.body.map((b) => b.content).join('\n')).toContain('Apache License');
		}
	});
});
