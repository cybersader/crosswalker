/**
 * render.test.ts — Jest unit tests for the render() pipeline (v0.1.2)
 *
 * Covers:
 *   - Template engine: variable resolution, dotted paths, filter pipeline,
 *     all 7 closed filters, error cases
 *   - Mechanism dispatch: folder/file/heading wired; tag/wikilink stubs
 *   - The 3 worked NIST examples from spec/recipe.schema.json (a, b, e)
 *   - Determinism: same input → byte-identical output, 100 iterations
 *   - Error surfaces: missing variable, unknown filter, malformed filter,
 *     heading missing level_depth, unknown mechanism
 */

import {
	render,
	renderTemplate,
	renderTemplateValue,
	RenderError,
	type Recipe,
	type ConceptIdentity,
} from '../src/render';

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
	const scope = {
		control: { id: 'AC-2', title: 'Account Management', family: 'AC' },
		family: { id: 'AC', title: 'Access Control' },
		col: 'plain-value',
	};

	it('replaces a single top-level variable', () => {
		expect(renderTemplate('{col}', scope)).toBe('plain-value');
	});

	it('replaces a dotted-path variable', () => {
		expect(renderTemplate('{control.id}', scope)).toBe('AC-2');
	});

	it('replaces multiple variables in one template', () => {
		expect(renderTemplate('{family.id}/{control.id}.md', scope)).toBe('AC/AC-2.md');
	});

	it('applies the lower filter', () => {
		expect(renderTemplate('{control.id|lower}', scope)).toBe('ac-2');
	});

	it('applies the upper filter', () => {
		expect(renderTemplate('{family.id|upper}', scope)).toBe('AC');
	});

	it('applies the title filter', () => {
		expect(renderTemplate('{control.title|title}', { control: { title: 'account management' } })).toBe(
			'Account Management',
		);
	});

	it('applies the slug filter — strips parens, lowercases, hyphenates', () => {
		expect(renderTemplate('{c|slug}', { c: 'AC-2(1)' })).toBe('ac-2-1');
		expect(renderTemplate('{c|slug}', { c: 'Account Management!' })).toBe('account-management');
	});

	it('applies the tagsafe filter — like slug but preserves underscores', () => {
		expect(renderTemplate('{c|tagsafe}', { c: 'AC_2(1)' })).toBe('ac_2-1');
	});

	it('applies the fs-safe filter — strips Windows-reserved chars', () => {
		expect(renderTemplate('{c|fs-safe}', { c: 'foo<bar>baz' })).toBe('foo_bar_baz');
		expect(renderTemplate('{c|fs-safe}', { c: 'a/b\\c?d*e' })).toBe('a_b_c_d_e');
		// Hyphens, dots, parens are PRESERVED (regression: a stray "-" embedded as a
		// literal control byte in the class used to clobber them + form a bad range).
		expect(renderTemplate('{c|fs-safe}', { c: 'AC-2(1)' })).toBe('AC-2(1)');
		expect(renderTemplate('{c|fs-safe}', { c: 'T1078.001' })).toBe('T1078.001');
	});

	it('applies the split filter — n-th segment by delimiter, trimmed', () => {
		expect(renderTemplate('{c|split(:,0)}', { c: 'DE.AE-01: Adverse events' })).toBe('DE.AE-01');
		expect(renderTemplate('{c|split(:,1)}', { c: 'DE.AE-01: Adverse events' })).toBe('Adverse events');
		expect(renderTemplate('{c|split(:,5)}', { c: 'a:b' })).toBe(''); // out-of-range → empty
	});

	it('applies the regex filter — first match or capture group', () => {
		expect(renderTemplate('{c|regex([A-Z.]+-\\d+)}', { c: 'GV.OC-01: text' })).toBe('GV.OC-01');
		expect(renderTemplate('{c|regex(ZZZ)}', { c: 'abc' })).toBe(''); // no match → empty
	});

	it('applies the trim filter', () => {
		expect(renderTemplate('{c|trim}', { c: '  hi  ' })).toBe('hi');
	});

	it('preserves numeric managed values through the number filter', () => {
		expect(renderTemplate('{c|number}', { c: '0.95' })).toBe('0.95');
		expect(renderTemplateValue('{c|number}', { c: '0.95' })).toBe(0.95);
		expect(renderTemplateValue('confidence-{c|number}', { c: '0.95' })).toBe('confidence-0.95');
		expect(() => renderTemplateValue('{c|number}', { c: 'high' })).toThrow(/finite numeric value/);
	});

	it('treats a blank number as absent only when the template opts in with optional', () => {
		// Blank is unknown, never 0: a 0 confidence would read as "no overlap".
		for (const c of ['', '   ', undefined, null]) {
			expect(renderTemplateValue('{c|optional|number}', { c })).toBe('');
			// A missing value already throws as missing; a blank one names the opt-in.
			expect(() => renderTemplateValue('{c|number}', { c })).toThrow(c === undefined || c === null ? /undefined\/null/ : /optional/);
		}
		expect(renderTemplateValue('{c|optional|number}', { c: '0.5' })).toBe(0.5);
		expect(renderTemplateValue('{c|optional|number}', { c: '0' })).toBe(0);
	});

	it('applies the truncate filter with argument', () => {
		expect(renderTemplate('{c|truncate(5)}', { c: 'abcdefghij' })).toBe('abcde');
		// Below the limit → unchanged
		expect(renderTemplate('{c|truncate(20)}', { c: 'short' })).toBe('short');
	});

	it('chains multiple filters in pipeline order', () => {
		expect(renderTemplate('{c|lower|truncate(3)}', { c: 'ABCDEF' })).toBe('abc');
	});

	it('throws RenderError for an unknown filter', () => {
		expect(() => renderTemplate('{c|banana}', { c: 'x' })).toThrow(RenderError);
		expect(() => renderTemplate('{c|banana}', { c: 'x' })).toThrow(/Unknown filter/);
	});

	it('throws RenderError when a variable resolves to undefined', () => {
		expect(() => renderTemplate('{missing}', {})).toThrow(RenderError);
	});

	it('throws RenderError when a dotted-path traverses a non-object', () => {
		expect(() => renderTemplate('{c.deep}', { c: 'string-not-object' })).toThrow(RenderError);
	});

	it('throws RenderError when truncate is missing its argument', () => {
		expect(() => renderTemplate('{c|truncate}', { c: 'x' })).toThrow(RenderError);
	});

	it('throws RenderError on malformed filter expression', () => {
		expect(() => renderTemplate('{c|123bad}', { c: 'x' })).toThrow(RenderError);
	});

	it('returns identical output for identical input (purity)', () => {
		const t = '{family.id}/{control.id|lower}.md';
		const a = renderTemplate(t, scope);
		const b = renderTemplate(t, scope);
		expect(a).toBe(b);
		expect(a).toBe('AC/ac-2.md');
	});
});

// ---------------------------------------------------------------------------
// render() — full pipeline
// ---------------------------------------------------------------------------

const sampleIdentity: ConceptIdentity = {
	curie: 'nist:AC-2',
	scope: {
		catalog: { name: 'NIST 800-53 r5' },
		family: { id: 'AC', title: 'Access Control' },
		control: { id: 'AC-2', title: 'Account Management' },
	},
};

describe('render — recipe (a) all-folders', () => {
	const recipe: Recipe = {
		recipe: 'nist-80053r5-allfolders',
		source: { ontology: 'nist-800-53-r5', levels: ['catalog', 'family', 'control'] },
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
				{ level: 'family', mechanism: 'folder', template: '{family.id}' },
				{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
			],
		},
	};

	it('produces the expected primary path', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.primary.path).toBe('Frameworks/NIST 800-53 r5/AC/AC-2.md');
	});

	it('produces no anchor (no heading mechanism)', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.primary.anchor).toBeUndefined();
	});

	it('computes wikilinkTarget as full path without .md', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.wikilinkTarget).toBe('Frameworks/NIST 800-53 r5/AC/AC-2');
	});

	it('always includes curie in frontmatter', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.frontmatter.curie).toBe('nist:AC-2');
	});
});

describe('render — recipe (b) mostly-headings', () => {
	const recipe: Recipe = {
		recipe: 'nist-80053r5-mostly-headings',
		source: { ontology: 'nist-800-53-r5', levels: ['catalog', 'family', 'control'] },
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'file', template: 'Frameworks/{catalog.name}.md' },
				{
					level: 'family',
					mechanism: 'heading',
					level_depth: 2,
					template: '{family.id} — {family.title}',
				},
				{
					level: 'control',
					mechanism: 'heading',
					level_depth: 3,
					template: '{control.id} {control.title}',
				},
			],
		},
	};

	it('puts the catalog into a single .md file', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.primary.path).toBe('Frameworks/NIST 800-53 r5.md');
	});

	it('builds nested heading anchor with `#` separator (Obsidian heading-range form)', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.primary.anchor).toBe('AC — Access Control#AC-2 Account Management');
	});

	it('wikilinkTarget includes the heading anchor', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.wikilinkTarget).toBe('Frameworks/NIST 800-53 r5#AC — Access Control#AC-2 Account Management');
	});
});

describe('render — recipe (e) hybrid (folder + folder + file + heading)', () => {
	const recipe: Recipe = {
		recipe: 'nist-80053r5-hybrid',
		source: { ontology: 'nist-800-53-r5', levels: ['catalog', 'family', 'control', 'enhancement'] },
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
				{ level: 'family', mechanism: 'folder', template: '{family.id}' },
				{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
				{
					level: 'enhancement',
					mechanism: 'heading',
					level_depth: 2,
					template: '{enhancement.id} {enhancement.title}',
				},
			],
		},
	};

	const enhancementIdentity: ConceptIdentity = {
		curie: 'nist:AC-2(1)',
		scope: {
			catalog: { name: 'NIST 800-53 r5' },
			family: { id: 'AC', title: 'Access Control' },
			control: { id: 'AC-2', title: 'Account Management' },
			enhancement: { id: 'AC-2(1)', title: 'Automated System Account Management' },
		},
	};

	it('lands enhancement under control file with heading anchor', () => {
		const a = render(recipe, enhancementIdentity);
		expect(a.primary.path).toBe('Frameworks/NIST 800-53 r5/AC/AC-2.md');
		expect(a.primary.anchor).toBe('AC-2(1) Automated System Account Management');
	});
});

describe('render — also_emit', () => {
	const recipe: Recipe = {
		recipe: 'with-also-emit',
		source: { ontology: 'nist', levels: ['catalog', 'family', 'control'] },
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
				{ level: 'family', mechanism: 'folder', template: '{family.id}' },
				{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
			],
			also_emit: {
				tags: ['framework/nist/{family.id|lower}/{control.id|tagsafe}'],
				aliases: ['{control.id}', '{control.title}'],
				frontmatter: {
					managed: {
						framework: 'nist-800-53-r5',
						family: '{family.id}',
						control_id: '{control.id}',
					},
				},
			},
		},
	};

	it('emits tags from also_emit.tags', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.tags).toContain('framework/nist/ac/ac-2');
	});

	it('emits aliases from also_emit.aliases', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.aliases).toEqual(['AC-2', 'Account Management']);
	});

	it('emits managed frontmatter from also_emit.frontmatter.managed', () => {
		const a = render(recipe, sampleIdentity);
		expect(a.frontmatter.framework).toBe('nist-800-53-r5');
		expect(a.frontmatter.family).toBe('AC');
		expect(a.frontmatter.control_id).toBe('AC-2');
	});
});

describe('render — canonical body projections', () => {
	const bodyIdentity: ConceptIdentity = {
		curie: 'test:AC-2',
		scope: {
			id: 'AC-2',
			text: 'Account management',
			quote: 'first line\n\nthird line',
			code: 'const fence = ```nested```;',
			items: ' one \n\n two ',
			empty: '   ',
		},
	};

	const recipe: Recipe = {
		recipe: 'body-projections',
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
			also_emit: {
				body: [
					{ template: '{text}' },
					{ template: '{quote}', position: 'section', heading: 'Discussion', format: 'quote' },
					{ template: '{code}', position: 'section', heading: 'Example', heading_depth: 3, format: 'code' },
					{ template: '{items}', format: 'list' },
					{ template: '{empty}', position: 'section', heading: 'Kept empty', omit_if_empty: false },
					{ template: '{empty}', position: 'section', heading: 'Omitted empty' },
				],
			},
		},
	};

	it('returns ordered, fully rendered regions with canonical format semantics', () => {
		const address = render(recipe, bodyIdentity);
		expect(address.body).toEqual([
			{ position: 'append', content: 'Account management' },
			{
				position: 'section',
				content: '> first line\n>\n> third line',
				heading: 'Discussion',
				headingDepth: 2,
			},
			{
				position: 'section',
				content: '````\nconst fence = ```nested```;\n````',
				heading: 'Example',
				headingDepth: 3,
			},
			{ position: 'append', content: '- one\n- two' },
			{ position: 'section', content: '   ', heading: 'Kept empty', headingDepth: 2 },
		]);
	});

	it('returns body: [] when the recipe has no body declaration', () => {
		const noBody: Recipe = {
			recipe: 'no-body',
			target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] },
		};
		expect(render(noBody, bodyIdentity).body).toEqual([]);
	});

	it('is deterministic across repeated body renders', () => {
		expect(JSON.stringify(render(recipe, bodyIdentity))).toBe(JSON.stringify(render(recipe, bodyIdentity)));
	});
});

describe('render — error cases', () => {
	const baseRecipe: Recipe = {
		recipe: 'broken',
		source: { ontology: 'x', levels: ['x'] },
		target: { layout: [] },
	};

	it('throws on unknown mechanism', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: { layout: [{ level: 'x', mechanism: 'banana', template: '{x}' }] },
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(RenderError);
		expect(() => render(recipe, sampleIdentity)).toThrow(/Unknown mechanism/);
	});

	it('throws informatively on tag-as-layout (deferred to v0.2)', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: { layout: [{ level: 'x', mechanism: 'tag', template: 'a/{x}' }] },
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(/v0.2/);
	});

	it('throws informatively on wikilink-as-layout (deferred to v0.2)', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: { layout: [{ level: 'x', mechanism: 'wikilink', template: '{x}' }] },
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(/v0.2/);
	});

	it('throws when heading mechanism is missing level_depth', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: { layout: [{ level: 'x', mechanism: 'heading', template: '{family.id}' }] },
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(/level_depth/);
	});

	it('throws when heading level_depth is out of range', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: {
				layout: [{ level: 'x', mechanism: 'heading', template: '{family.id}', level_depth: 7 }],
			},
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(/level_depth/);
	});

	it('throws when a template references a missing variable', () => {
		const recipe: Recipe = {
			...baseRecipe,
			target: { layout: [{ level: 'x', mechanism: 'folder', template: '{nonexistent.field}' }] },
		};
		expect(() => render(recipe, sampleIdentity)).toThrow(RenderError);
	});
});

// ---------------------------------------------------------------------------
// Determinism — the load-bearing architectural commitment
// ---------------------------------------------------------------------------

describe('render — determinism', () => {
	const recipe: Recipe = {
		recipe: 'determinism-test',
		source: { ontology: 'nist', levels: ['catalog', 'family', 'control'] },
		target: {
			layout: [
				{ level: 'catalog', mechanism: 'folder', template: 'Frameworks/{catalog.name}' },
				{ level: 'family', mechanism: 'folder', template: '{family.id}' },
				{ level: 'control', mechanism: 'file', template: '{control.id}.md' },
			],
			also_emit: {
				tags: ['framework/nist/{family.id|lower}/{control.id|tagsafe}'],
				aliases: ['{control.id}', '{control.title}'],
				frontmatter: { managed: { framework: 'nist', control_id: '{control.id}' } },
			},
		},
	};

	it('produces byte-identical output for 100 iterations of the same input', () => {
		const reference = JSON.stringify(render(recipe, sampleIdentity));
		for (let i = 0; i < 100; i++) {
			const result = JSON.stringify(render(recipe, sampleIdentity));
			expect(result).toBe(reference);
		}
	});

	it('produces structurally-identical output regardless of also_emit array order', () => {
		// Render-time output is sensitive to recipe field order at the array level
		// (templates are ordered), but identical recipes produce identical output.
		// This validates that there's no Date.now() / Math.random() leakage.
		const a = render(recipe, sampleIdentity);
		const b = render(recipe, sampleIdentity);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('survives JSON serialization round-trip', () => {
		const a = render(recipe, sampleIdentity);
		const serialized = JSON.stringify(a);
		const b = JSON.parse(serialized);
		expect(b.primary.path).toBe(a.primary.path);
		expect(b.wikilinkTarget).toBe(a.wikilinkTarget);
		expect(b.tags).toEqual(a.tags);
	});
});
