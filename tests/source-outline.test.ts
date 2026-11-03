import { prepareSourceStage, SourceStageError, type SourceStageDeclaration } from '../src/source';
import type { ParsedData } from '../src/types/config';
import { validateRecipe } from '../src/validation/validator';
import { computeRecipeHash, recipeHashCanonicalInput } from '../src/generation/hash';

type Row = Record<string, unknown>;
const outline = { levels: ['top', 'middle', 'bottom'], id: '{ID|trim}' };
const rows: Row[] = [
	{ ID: 'A', top: 'Root', middle: '', bottom: '' },
	{ ID: 'B', top: '', middle: 'Parent', bottom: '' },
	{ ID: 'C', top: '', middle: '', bottom: 'Child' },
	{ ID: 'D', top: '', middle: 'Sibling', bottom: '' },
	{ ID: 'E', top: 'Next root', middle: '', bottom: '' },
];
function parsed(input = rows): ParsedData {
	return { columns: ['ID', ...outline.levels], rows: input, rowCount: input.length };
}
async function drain(data: ParsedData, source: SourceStageDeclaration = { outline }) {
	const stage = await prepareSourceStage(data, source);
	const out: Row[] = [];
	for await (const row of stage.rows) out.push(row);
	stage.finalize();
	return { stage, out };
}

describe('source.outline lineage stage', () => {
	it('preserves pre-order, source rows and same-shape lineage without mutating input', async () => {
		const { stage, out } = await drain(parsed());
		expect(out.map((row) => row.ID)).toEqual(['A', 'B', 'C', 'D', 'E']);
		expect(out[2]._cw).toEqual({
			level: 'bottom', path: ['A', 'B', 'C'], parent: 'B',
			ancestors: { top: { id: 'A' }, middle: { id: 'B' }, bottom: { id: 'C' } },
		});
		expect((out[3]._cw as any).path).toEqual(['A', 'D']);
		expect((out[4]._cw as any).parent).toBe('');
		expect(out.map((row, index) => stage.sourceRowNumber(row, index))).toEqual([1, 2, 3, 4, 5]);
		expect(rows.every((row) => row._cw === undefined)).toBe(true);
	});

	it.each([
		['depth jump', [rows[0], rows[2]], 2, 'preceding row'],
		['first-row depth jump', [rows[1]], 1, 'preceding row'],
		['two filled levels', [{ ...rows[1], top: 'Also filled' }], 1, 'more than one'],
		['zero filled levels', [{ ...rows[0], top: '  ' }], 1, 'no filled'],
		['empty identity', [{ ...rows[0], ID: '' }], 1, 'id template'],
		['reserved lineage', [{ ...rows[0], _cw: {} }], 1, 'reserved'],
	] as const)('refuses %s with a row, cause and action', async (_name, input, row, message) => {
		try {
			await drain(parsed([...input]));
			throw new Error('Expected refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(SourceStageError);
			expect(error).toMatchObject({ row, declaration: 'source.outline' });
			expect((error as Error).message).toContain(message);
			expect((error as Error).message).toMatch(/Fix|Rename/);
		}
	});

	it('runs before where and re-parents to the nearest admitted ancestor', async () => {
		const { stage, out } = await drain(parsed(), { outline, where: "ID != 'B' and _cw.level != 'unused'" });
		expect(out.map((row) => row.ID)).toEqual(['A', 'C', 'D', 'E']);
		expect(out[1]._cw).toEqual({
			level: 'bottom', path: ['A', 'B', 'C'], parent: 'A',
			ancestors: { top: { id: 'A' }, middle: { id: '' }, bottom: { id: 'C' } },
		});
		expect(stage.sourceRowNumber(out[1], 1)).toBe(3);
		expect(stage.excludedCount).toBe(1);
	});

	it('reconnects past two consecutive excluded levels', async () => {
		const deep = { levels: ['top', 'middle', 'bottom', 'leaf'], id: '{ID|trim}' };
		const input = [...rows.slice(0, 3), { ID: 'F', top: '', middle: '', bottom: '', leaf: 'Leaf' }];
		const { out } = await drain({ columns: ['ID', ...deep.levels], rows: input, rowCount: input.length },
			{ outline: deep, where: "ID != 'B' and ID != 'C'" });
		expect(out.map((row) => row.ID)).toEqual(['A', 'F']);
		expect(out[1]._cw).toMatchObject({ parent: 'A', ancestors: { middle: { id: '' }, bottom: { id: '' } } });
	});

	it('prunes an excluded branch before processing the later sibling', async () => {
		const { out } = await drain(parsed(), { outline, where: "ID != 'B'" });
		expect(out.find((row) => row.ID === 'C')?._cw).toMatchObject({ parent: 'A', ancestors: { middle: { id: '' } } });
		expect(out.find((row) => row.ID === 'D')?._cw).toEqual({
			level: 'middle', path: ['A', 'D'], parent: 'A', ancestors: { top: { id: 'A' }, middle: { id: 'D' } },
		});
	});

	it('omits the parent when every ancestor is excluded', async () => {
		const { out } = await drain(parsed(), { outline, where: "ID = 'C'" });
		expect((out[0]._cw as any).parent).toBe('');
	});

	it.each([true, false])('streaming equals eager with published columns: %s', async (published) => {
		const eager = await drain(parsed());
		let consumed = 0;
		const streamed: ParsedData = {
			columns: published ? parsed().columns : [], rowCount: -1,
			rows: (async function* () { for (const row of rows) { consumed++; yield row; } })(),
		};
		const stage = await prepareSourceStage(streamed, { outline, where: "_cw.level != 'unused'" });
		if (published) expect(consumed).toBe(0);
		const out: Row[] = [];
		for await (const row of stage.rows) {
			out.push(row);
			if (published) expect(consumed).toBe(out.length);
		}
		stage.finalize();
		expect(out).toEqual(eager.out);
	});

	it('refuses nest and outline together even for an unvalidated programmatic caller', async () => {
		await expect(prepareSourceStage(parsed(), { outline, nest: [{ level: 'x', id: '{ID}' }] }))
			.rejects.toThrow('Choose either');
	});
});

describe('source.outline schema and hash', () => {
	const target = { layout: [{ level: 'technique', mechanism: 'file', template: '{ID}.md' }] };
	const recipe = { recipe: 'synthetic-outline', source: { ontology: 'synthetic', levels: ['technique'], outline }, target };
	it('validates an outline without changing the layout levels', () => expect(validateRecipe(recipe).valid).toBe(true));
	it.each([
		{ levels: [], id: '{ID}' }, { levels: ['a', 'a'], id: '{ID}' },
		{ levels: [''], id: '{ID}' }, { levels: ['a'] }, { levels: ['a'], id: '' },
		{ levels: ['a'], id: '{ID}', extra: true },
	])('rejects a malformed outline %j', (invalid) => {
		expect(validateRecipe({ ...recipe, source: { ...recipe.source, outline: invalid } }).valid).toBe(false);
	});
	it('rejects nest and outline together in the schema', () => {
		expect(validateRecipe({ ...recipe, source: { ...recipe.source, nest: [{ level: 'x', id: '{ID}' }] } }).valid).toBe(false);
	});
	it('keeps absent outline absent, including an explicit undefined', () => {
		expect(recipeHashCanonicalInput(target, { outline: undefined })).toBe(recipeHashCanonicalInput(target));
		expect(recipeHashCanonicalInput(target)).not.toContain('source_outline');
	});
	it('hashes outline and changes of its levels or identity template', () => {
		const hash = computeRecipeHash(target, { outline });
		expect(hash).not.toBe(computeRecipeHash(target));
		expect(hash).not.toBe(computeRecipeHash(target, { outline: { ...outline, levels: ['top', 'bottom'] } }));
		expect(hash).not.toBe(computeRecipeHash(target, { outline: { ...outline, id: '{other}' } }));
		expect(hash).toBe(computeRecipeHash(target, { outline: { id: outline.id, levels: outline.levels } }));
		expect(recipeHashCanonicalInput(target, { outline })).toContain('source_outline');
	});
});
