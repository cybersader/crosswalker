import { render, type Recipe, type RenderReport } from '../src/render';

const NEST = [
	{ level: 'group', id: '{id}', children: 'controls', carry: ['title'], leaf: 'folder-note' as const },
	{ level: 'control', id: '{id}', children: 'parts', carry: ['title'], leaf: 'folder-note' as const },
	{ level: 'part', id: '{id}' },
];

const RECIPE: Recipe = {
	recipe: 'test:nested-render',
	source: { ontology: 'oscal-mini', levels: ['group', 'control', 'part'], nest: NEST },
	target: {
		layout: [
			{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id}' },
			{ level: 'control', mechanism: 'folder', template: '{_cw.ancestors.control.id}' },
			{ level: 'part', mechanism: 'file', template: '{id}.md' },
		],
		also_emit: { frontmatter: { managed: { group_title: '{_cw.ancestors.group.title}' } } },
	},
};

const ancestors = {
	group: { id: 'ac', title: 'Access coordination' },
	control: { id: 'ac-1', title: 'Account setup' },
	part: { id: 'ac-1_smt' },
};

function scope(level: 'group' | 'control' | 'part') {
	const ids = { group: 'ac', control: 'ac-1', part: 'ac-1_smt' };
	const paths = {
		group: ['ac'],
		control: ['ac', 'ac-1'],
		part: ['ac', 'ac-1', 'ac-1_smt'],
	};
	const allowed = level === 'group'
		? { group: ancestors.group }
		: level === 'control'
			? { group: ancestors.group, control: ancestors.control }
			: ancestors;
	return {
		id: ids[level],
		title: `${level} title`,
		_cw: {
			level,
			path: paths[level],
			parent: paths[level][paths[level].length - 2] ?? '',
			ancestors: allowed,
		},
	};
}

describe('render nested rows', () => {
	it('renders a part through all three declared levels', () => {
		const address = render(RECIPE, { curie: 'oscal-mini:ac-1_smt', scope: scope('part') });
		expect(address.primary.path).toBe('ac/ac-1/ac-1_smt.md');
		expect(address.frontmatter.group_title).toBe('Access coordination');
	});

	it('renders a control as its declared folder-note leaf', () => {
		const report: RenderReport = { notes: [] };
		const address = render(RECIPE, { curie: 'oscal-mini:ac-1', scope: scope('control') }, report);
		expect(address.primary.path).toBe('ac/ac-1/ac-1.md');
		expect(report.notes).toContainEqual(expect.objectContaining({
			code: 'nest-folder-note-leaf',
			level: 'control',
		}));
	});

	it('renders a group as its declared folder-note leaf', () => {
		const address = render(RECIPE, { curie: 'oscal-mini:ac', scope: scope('group') });
		expect(address.primary.path).toBe('ac/ac.md');
	});

	it('refuses a folder-note level whose own folder template renders empty', () => {
		const recipe: Recipe = {
			...RECIPE,
			target: {
				...RECIPE.target,
				layout: [
					{ level: 'group', mechanism: 'folder', template: '{empty}' },
					...RECIPE.target.layout.slice(1),
				],
			},
		};
		expect(() => render(recipe, {
			curie: 'oscal-mini:ac',
			scope: { ...scope('group'), empty: '' },
		})).toThrow(
			'Level "group" rendered no folder of its own, so it has no folder-note address. Fix its folder template or set leaf to none.',
		);
	});

	it('uses the landed folder segment for a directory-prefixed folder-note template', () => {
		const recipe: Recipe = {
			...RECIPE,
			target: {
				...RECIPE.target,
				layout: [
					{ level: 'group', mechanism: 'folder', template: 'Frameworks/{_cw.ancestors.group.id}' },
					...RECIPE.target.layout.slice(1),
				],
			},
		};
		const address = render(recipe, { curie: 'oscal-mini:ac', scope: scope('group') });
		expect(address.primary.path).toBe('Frameworks/ac/ac.md');
	});

	it('renders every layout entry byte-identically when _cw is absent', () => {
		const flat: Recipe = {
			...RECIPE,
			source: { ontology: 'oscal-mini', levels: ['group', 'control', 'part'] },
			target: {
				...RECIPE.target,
				layout: [
					{ level: 'group', mechanism: 'folder', template: '{group}' },
					{ level: 'control', mechanism: 'folder', template: '{control}' },
					{ level: 'part', mechanism: 'file', template: '{id}.md' },
				],
				also_emit: undefined,
			},
		};
		const nestedDeclaration = { ...flat, source: { ...flat.source, nest: NEST } };
		const identity = { curie: 'oscal-mini:ac-1_smt', scope: { group: 'ac', control: 'ac-1', id: 'ac-1_smt' } };
		expect(render(nestedDeclaration, identity)).toEqual(render(flat, identity));
	});
});

const SECTION_RECIPE: Recipe = {
	recipe: 'test:nested-sections',
	source: {
		ontology: 'synthetic',
		levels: ['group', 'control', 'part'],
		nest: [
			{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
			{ level: 'control', id: '{id}', children: 'parts' },
			{ level: 'part', id: '{id}', leaf: 'section' },
		],
	},
	target: {
		layout: [
			{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id}' },
			{ level: 'control', mechanism: 'file', template: '{id}.md' },
			{ level: 'part', mechanism: 'heading', level_depth: 2, template: '{name|title}' },
		],
		also_emit: {
			body: [
				{ template: 'Host: {title}', position: 'append' },
				{ template: '{prose}', position: 'append', level: 'part' },
			],
		},
	},
};

function sectionHost(parts: Array<Record<string, unknown>>) {
	return {
		id: 'c1',
		title: 'Control one',
		_cw: {
			level: 'control',
			path: ['g1', 'c1'],
			parent: 'g1',
			ancestors: {
				group: { id: 'g1', title: 'Group one' },
				control: { id: 'c1', title: 'Control one' },
			},
			sections: parts,
		},
	};
}

function part(id: string, name: string, prose: string, sections?: Array<Record<string, unknown>>) {
	return {
		id,
		name,
		prose,
		_cw: {
			level: 'part',
			path: ['g1', 'c1', id],
			parent: 'c1',
			ancestors: {
				group: { id: 'g1', title: 'Group one' },
				control: { id: 'c1', title: 'Control one' },
				part: { id },
			},
			...(sections ? { sections } : {}),
		},
	};
}

describe('render attached section records', () => {
	it('B1/B11 renders host projections first, then headings and content in source order', () => {
		const address = render(SECTION_RECIPE, {
			curie: 'synthetic:c1',
			scope: sectionHost([
				part('p2', 'guidance', 'Consider the other thing.'),
				part('p1', 'statement', 'Do the thing.'),
			]),
		});

		expect(address.primary.anchor).toBeUndefined();
		expect(address.body).toEqual([
			{ position: 'append', content: 'Host: Control one' },
			{ position: 'section', heading: 'Guidance', headingDepth: 2, content: 'Consider the other thing.' },
			{ position: 'section', heading: 'Statement', headingDepth: 2, content: 'Do the thing.' },
		]);
	});

	it('B2 emits no sections for a host without attached records', () => {
		const address = render(SECTION_RECIPE, { curie: 'synthetic:c3', scope: sectionHost([]) });
		expect(address.body).toEqual([{ position: 'append', content: 'Host: Control one' }]);
	});

	it('always emits a heading when scoped content is empty', () => {
		const address = render(SECTION_RECIPE, {
			curie: 'synthetic:c1',
			scope: sectionHost([part('p1', 'statement', '')]),
		});
		expect(address.body[1]).toEqual({
			position: 'section',
			heading: 'Statement',
			headingDepth: 2,
			content: '',
		});
	});

	it('uses the heading mechanism exact empty-heading error', () => {
		expect(() => render(SECTION_RECIPE, {
			curie: 'synthetic:c1',
			scope: sectionHost([part('p1', '', 'Body')]),
		})).toThrow('heading mechanism produced empty heading for level "part". Template: "{name|title}".');
	});

	it('B9 renders deeper attached section levels depth-first', () => {
		const recipe: Recipe = {
			...SECTION_RECIPE,
			source: {
				...SECTION_RECIPE.source,
				levels: ['group', 'control', 'part', 'subpart'],
				nest: [
					...SECTION_RECIPE.source!.nest!,
					{ level: 'subpart', id: '{id}', leaf: 'section' },
				],
			},
			target: {
				...SECTION_RECIPE.target,
				layout: [
					...SECTION_RECIPE.target.layout,
					{ level: 'subpart', mechanism: 'heading', level_depth: 3, template: '{name|title}' },
				],
				also_emit: {
					body: [
						...SECTION_RECIPE.target.also_emit!.body!,
						{ template: '{text}', position: 'append', level: 'subpart' },
					],
				},
			},
		};
		const subpart = {
			id: 'sp1',
			name: 'detail',
			text: 'Nested detail.',
			_cw: {
				level: 'subpart',
				path: ['g1', 'c1', 'p1', 'sp1'],
				parent: 'p1',
				ancestors: {},
			},
		};
		const address = render(recipe, {
			curie: 'synthetic:c1',
			scope: sectionHost([part('p1', 'statement', 'Do the thing.', [subpart])]),
		});
		expect(address.body.slice(1)).toEqual([
			{ position: 'section', heading: 'Statement', headingDepth: 2, content: 'Do the thing.' },
			{ position: 'section', heading: 'Detail', headingDepth: 3, content: 'Nested detail.' },
		]);
	});
});
