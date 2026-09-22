import {
	diagnoseCanonicalRecipe,
	type RecipeDocumentDiagnostic,
} from '../src/import/recipe-document';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';

function sectionRecipe(): CrosswalkerImportRecipe {
	return {
		recipe: 'synthetic-section-projection',
		source: {
			ontology: 'synthetic-controls',
			levels: ['group', 'control', 'part'],
			nest: [
				{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
				{ level: 'control', id: '{id}', children: 'parts' },
				{ level: 'part', id: '{id}', leaf: 'section' },
			],
		},
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: '{id}' },
				{ level: 'control', mechanism: 'file', template: '{id}.md' },
				{ level: 'part', mechanism: 'heading', level_depth: 2, template: '{name|title}' },
			],
			also_emit: {
				body: [{ template: '{prose}', position: 'append', level: 'part' }],
			},
		},
	};
}

function diagnostic(recipe: CrosswalkerImportRecipe, code: string): RecipeDocumentDiagnostic {
	const found = diagnoseCanonicalRecipe(recipe).find((entry) => entry.code === code);
	expect(found).toBeDefined();
	return found!;
}

describe('nested section recipe diagnostics', () => {
	it('reports nest-section-on-root', () => {
		const recipe = sectionRecipe();
		recipe.source.levels = ['part'];
		recipe.source.nest = [{ level: 'part', id: '{id}', leaf: 'section' }];
		recipe.target.layout = [
			{ level: 'part', mechanism: 'heading', level_depth: 2, template: '{name|title}' },
		];
		expect(diagnostic(recipe, 'nest-section-on-root')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" is the top level and has no parent note to become sections in. Set leaf to folder-note or none.',
		});
	});

	it('reports nest-section-parent-not-note', () => {
		const recipe = sectionRecipe();
		recipe.source.nest![1].leaf = 'none';
		expect(diagnostic(recipe, 'nest-section-parent-not-note')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" cannot become sections because "control" has no note of its own. Give "control" a note or leave "part" out.',
		});
	});

	it('reports nest-section-no-heading-entry', () => {
		const recipe = sectionRecipe();
		recipe.target.layout = recipe.target.layout.filter((entry) => entry.level !== 'part');
		expect(diagnostic(recipe, 'nest-section-no-heading-entry')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" becomes sections but target.layout has no heading entry for it. Add a heading entry for "part" below the note\'s file entry.',
		});
	});

	it('reports nest-section-has-file-entry', () => {
		const recipe = sectionRecipe();
		recipe.target.layout.push({ level: 'part', mechanism: 'file', template: '{id}.md' });
		expect(diagnostic(recipe, 'nest-section-has-file-entry')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" becomes sections, so it cannot also have a file entry. Remove that entry or set leaf to folder-note.',
		});
	});

	it('reports nest-section-child-is-note', () => {
		const recipe = sectionRecipe();
		recipe.source.levels.push('subpart');
		recipe.source.nest![2].children = 'subparts';
		recipe.source.nest!.push({ level: 'subpart', id: '{id}' });
		recipe.target.layout.push({ level: 'subpart', mechanism: 'file', template: '{id}.md' });
		expect(diagnostic(recipe, 'nest-section-child-is-note')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" becomes sections, so no level below it can be a note. Set "subpart" to sections or leave it out.',
		});
	});

	it('reports nest-section-depth-order', () => {
		const recipe = sectionRecipe();
		recipe.source.levels.push('subpart');
		recipe.source.nest![2].children = 'subparts';
		recipe.source.nest!.push({ level: 'subpart', id: '{id}', leaf: 'section' });
		recipe.target.layout.push({
			level: 'subpart', mechanism: 'heading', level_depth: 2, template: '{name|title}',
		});
		recipe.target.also_emit!.body!.push({
			template: '{text}', position: 'append', level: 'subpart',
		});
		expect(diagnostic(recipe, 'nest-section-depth-order')).toMatchObject({
			severity: 'blocking',
			message: 'Heading depth for "subpart" must be deeper than "part" (level_depth 2). Set level_depth to 3 or more.',
		});
	});

	it('reports nest-section-heading-kind', () => {
		const recipe = sectionRecipe();
		recipe.target.layout[2].kind = 'junction-note';
		expect(diagnostic(recipe, 'nest-section-heading-kind')).toMatchObject({
			severity: 'blocking',
			message: 'Level "part" becomes sections and cannot declare kind. Remove kind from its heading entry.',
		});
	});

	it('reports body-level-not-section', () => {
		const recipe = sectionRecipe();
		recipe.target.also_emit!.body!.push({
			template: '{title}', position: 'append', level: 'control',
		});
		expect(diagnostic(recipe, 'body-level-not-section')).toMatchObject({
			severity: 'blocking',
			message: 'Body projection level "control" is not a level that becomes sections. Use one of: part, or remove level.',
		});
	});

	it('reports body-level-not-section when no nested section levels exist', () => {
		const recipe = sectionRecipe();
		delete recipe.source.nest;
		recipe.target.also_emit!.body = [{
			template: '{prose}', position: 'append', level: 'part',
		}];
		expect(diagnostic(recipe, 'body-level-not-section')).toMatchObject({ severity: 'blocking' });
	});

	it('reports nest-section-no-body as a warning', () => {
		const recipe = sectionRecipe();
		delete recipe.target.also_emit;
		expect(diagnostic(recipe, 'nest-section-no-body')).toEqual(expect.objectContaining({
			severity: 'warning',
			message: 'Level "part" becomes sections, but nothing is projected under each heading. Add a body projection with level "part".',
		}));
		expect(diagnoseCanonicalRecipe(recipe).filter((entry) => entry.severity === 'blocking')).toEqual([]);
	});
});
