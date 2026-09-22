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
