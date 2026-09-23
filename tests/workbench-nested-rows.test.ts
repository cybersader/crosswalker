jest.mock('obsidian', () => ({
	...jest.requireActual('./__mocks__/obsidian'),
	setIcon: () => {},
}));

import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ImportMapping, StructureMapping } from '../src/import/mapping/types';
import type { ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';
import fixture from './fixtures/oscal-mini.json';

const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;

interface PrivateWorkbench {
	renderMatrix(card: HTMLElement, mapping: StructureMapping, mappingIndex: number): void;
	sampleForLevel(rule: StructureMapping['levels'][number]): string;
	renderCombinedPreview(card: HTMLElement, mappingIndex: number): void;
	renderMappingCard(parent: HTMLElement, mapping: StructureMapping, mappingIndex: number): void;
	renderPreviewRail(rail: HTMLElement): void;
	sectionKeys(level: string): string[];
	detections: unknown[];
	expandedRows: Record<string, unknown>[] | null;
	mapping: ImportMapping;
	expanded: Set<number>;
}

function installDomHelpers(): void {
	Object.assign(HTMLElement.prototype, {
		empty(this: HTMLElement) { this.replaceChildren(); },
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string } = {}) {
			const element = document.createElement(tag) as HTMLElement & { value?: string; type?: string };
			if (options.cls) element.className = options.cls;
			if (options.text !== undefined) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			if (options.type !== undefined) element.type = options.type;
			if (options.value !== undefined) element.value = options.value;
			this.appendChild(element);
			return element;
		},
		createDiv(this: HTMLElement, options = {}) { return (this as any).createEl('div', options); },
		createSpan(this: HTMLElement, options = {}) { return (this as any).createEl('span', options); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
	});
}

beforeAll(installDomHelpers);
afterEach(() => jest.clearAllTimers());

const nested: ImportMapping = {
	mappings: [{ levels: [
		{ level: 'group', source: { column: '_cw.ancestors.group.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
		{ level: 'control', source: { column: '_cw.ancestors.control.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
		{ level: 'part', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
	] }],
	nest: [
		{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note', identity: 'global' },
		{ level: 'control', id: '{id}', children: 'parts', leaf: 'folder-note', identity: 'global' },
		{ level: 'part', id: '{id}', identity: 'global' },
	],
};

function sectionReadyMapping(): ImportMapping {
	return {
		mappings: [{ levels: [
			{ level: 'group', source: { column: '_cw.ancestors.group.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'control', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'part', source: { column: 'name' }, destinations: [], naming: 'part', missing: 'skip', materialize: false },
		] }],
		nest: [
			{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
			{ level: 'control', id: '{id}', children: 'parts' },
			{ level: 'part', id: '{id}', leaf: 'none' },
		],
	};
}

function sectionOnlyMapping(): ImportMapping {
	const mapping = sectionReadyMapping();
	mapping.mappings[0].levels[2].destinations = [{ primitive: 'heading', hostRule: 'control', depth: 2 }];
	mapping.nest![2].leaf = 'section';
	return mapping;
}

function sectionFixtureData(): ParsedData {
	const groups = fixture.catalog.groups as unknown as Record<string, unknown>[];
	return {
		columns: ['id', 'title', 'controls'],
		rows: groups,
		rowCount: groups.length,
		container: { kind: 'json', readDocument: async () => fixture },
	};
}

function workbench(
	mapping: ImportMapping,
	parsedData: ParsedData = { columns: ['id', 'title'], rows: [{ id: 'p1', title: 'Part one' }], rowCount: 1 },
): MappingWorkbench {
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Out',
		debug,
		defaultPresetId: 'browsable-framework',
		initialMapping: mapping,
		...(parsedData.container?.kind === 'json' ? { jsonNest: '' } : {}),
		onChange: () => {},
	});
}

function renderMatrix(wb: MappingWorkbench): HTMLElement {
	const host = document.createElement('div');
	const mapping = wb.getMapping().mappings[0];
	(wb as unknown as PrivateWorkbench).renderMatrix(host, mapping, 0);
	return host;
}

describe('nested workbench rows', () => {
	it('renders nested controls, writes through the view model, and hides merge and split', () => {
		const wb = workbench(nested);
		const host = renderMatrix(wb);
		expect(host.querySelectorAll('tr.crosswalker-wb-nest-row')).toHaveLength(3);
		expect(host.querySelectorAll('[data-nest-control="leaf"]')).toHaveLength(2);
		expect(host.querySelectorAll('[data-nest-control="identity"]')).toHaveLength(3);
		expect(host.textContent).not.toContain('Merge');
		expect(host.textContent).not.toContain('Split');
		expect(host.textContent).not.toContain('—');

		const leaf = host.querySelector<HTMLSelectElement>('[aria-label="Own note for control"]')!;
		expect([...leaf.options].map((option) => option.text)).toEqual([
			'Yes, as a folder note',
			'No, folder only',
		]);
		leaf.value = 'none';
		leaf.dispatchEvent(new Event('change'));
		expect(wb.getMapping().nest?.find((entry) => entry.level === 'control')?.leaf).toBe('none');

		const identity = host.querySelector<HTMLSelectElement>('[aria-label="Identified by for part"]')!;
		expect([...identity.options].map((option) => option.text)).toEqual([
			'Its own identifier',
			'Its path from the top level',
		]);
		identity.value = 'path';
		identity.dispatchEvent(new Event('change'));
		expect(wb.getMapping().nest?.find((entry) => entry.level === 'part')?.identity).toBe('path');
	});

	it('renders Placement and Section text controls and writes their choices (B14)', async () => {
		const wb = workbench(sectionReadyMapping(), sectionFixtureData());
		await Promise.resolve();
		await Promise.resolve();
		let host = renderMatrix(wb);
		const placement = host.querySelector<HTMLSelectElement>('[aria-label="Placement for part"]')!;
		expect(placement.previousElementSibling?.textContent).toBe('Placement');
		expect([...placement.options].map((option) => option.text)).toEqual([
			'Left out',
			'Sections inside each control note',
		]);
		expect(placement.value).toBe('none');
		expect(host.querySelector('[aria-label="Section text for part"]')).toBeNull();

		placement.value = 'section';
		placement.dispatchEvent(new Event('change'));
		host = renderMatrix(wb);
		const text = host.querySelector<HTMLSelectElement>('[aria-label="Section text for part"]')!;
		expect(text.previousElementSibling?.textContent).toBe('Section text');
		expect([...text.options].map((option) => option.text)).toEqual(['id', 'prose']);
		expect(text.value).toBe('prose');
		expect(host.querySelector('[data-nest-warning="section-text"]')).toBeNull();
		expect(wb.getMapping().nest?.find((entry) => entry.level === 'part')?.leaf).toBe('section');
		expect(wb.getMapping().mappings.flatMap((mapping) => mapping.levels)
			.find((level) => JSON.stringify(level.source) === JSON.stringify({ column: 'prose' })
				&& level.destinations.some((destination) => destination.primitive === 'body'))
			?.destinations).toContainEqual({ primitive: 'body', position: 'append', level: 'part' });

		text.value = 'id';
		text.dispatchEvent(new Event('change'));
		expect(wb.getMapping().mappings.flatMap((mapping) => mapping.levels)
			.find((level) => JSON.stringify(level.source) === JSON.stringify({ column: 'id' })
				&& level.destinations.some((destination) => destination.primitive === 'body'))
			?.destinations).toContainEqual({ primitive: 'body', position: 'append', level: 'part' });
		expect(host.textContent).not.toContain('—');
	});

	it('disables a child section when its parent is left out', () => {
		const mapping = sectionReadyMapping();
		mapping.mappings[0].levels.push({
			level: 'subpart',
			source: { column: 'text' },
			destinations: [],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		});
		mapping.nest?.push({ level: 'subpart', id: '{id}', leaf: 'none' });
		const host = renderMatrix(workbench(mapping));
		const child = host.querySelector<HTMLSelectElement>('[aria-label="Placement for subpart"]')!;
		expect(child.disabled).toBe(true);
		expect(child.title).toBe('Left out because part is left out. Set part to sections first.');
	});

	it('describes placement inside a parent section as a section, not a note', () => {
		const mapping = sectionOnlyMapping();
		mapping.nest![2].children = 'subparts';
		mapping.nest!.push({ level: 'subpart', id: '{id}', leaf: 'section' });
		mapping.mappings[0].levels.push({
			level: 'subpart',
			source: { column: 'label' },
			destinations: [{ primitive: 'heading', hostRule: 'control', depth: 3 }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		});

		const host = renderMatrix(workbench(mapping));
		const placement = host.querySelector<HTMLSelectElement>('[aria-label="Placement for subpart"]')!;
		expect([...placement.options].map((option) => option.text)).toEqual([
			'Left out',
			'Sections inside each part section',
		]);
	});

	it('uses actionable section-text warnings with and without eligible fields', () => {
		const withKeys = renderMatrix(workbench(sectionOnlyMapping(), sectionFixtureData()));
		expect(withKeys.querySelector('[data-nest-warning="section-text"]')?.textContent).toBe(
			'Pick a field under Section text so each part section has content.',
		);

		const noKeysWorkbench = workbench(sectionOnlyMapping(), sectionFixtureData());
		const noKeysPrivate = noKeysWorkbench as unknown as PrivateWorkbench;
		noKeysPrivate.detections = [];
		noKeysPrivate.expandedRows = [{ name: 'Statement', _cw: { level: 'part' } }];
		const withoutKeys = renderMatrix(noKeysWorkbench);
		expect(withoutKeys.querySelector<HTMLSelectElement>('[aria-label="Section text for part"]')?.disabled).toBe(true);
		expect(withoutKeys.querySelector('[data-nest-warning="section-text"]')?.textContent).toBe(
			'No text fields were found on part records. Set Placement to Left out.',
		);
	});

	it('excludes a nested level child collection from Section text choices', () => {
		const wb = workbench(sectionReadyMapping(), sectionFixtureData());
		const privateWorkbench = wb as unknown as PrivateWorkbench;
		privateWorkbench.detections = [];
		privateWorkbench.expandedRows = [{
			id: 'c1',
			title: 'Control one',
			parts: [{ id: 'p1' }],
			_cw: { level: 'control' },
		}];
		expect(privateWorkbench.sectionKeys('control')).toEqual(['title']);
	});

	it('keeps Own note controls available for nested rows in a Custom arrangement', () => {
		const custom = JSON.parse(JSON.stringify(nested)) as ImportMapping;
		custom.mappings[0].levels[2].destinations.push({ primitive: 'folder' });
		const host = renderMatrix(workbench(custom));
		expect(host.querySelector('[aria-label="Own note for group"]')).not.toBeNull();
		expect(host.querySelector('[aria-label="Own note for control"]')).not.toBeNull();
	});

	it('shows a canonical blocking error instead of rendering a nested preview around it', () => {
		const wb = workbench(sectionReadyMapping(), sectionFixtureData());
		const invalid = sectionOnlyMapping();
		invalid.mappings.push({ levels: [{
			level: 'control-body',
			source: { column: 'title' },
			destinations: [{ primitive: 'body', position: 'append', level: 'control' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}] });
		const privateWorkbench = wb as unknown as PrivateWorkbench;
		privateWorkbench.mapping = invalid;
		expect(() => wb.buildRecipe()).toThrow(/Body projection level "control" is not a level that becomes sections/);

		const host = document.createElement('div');
		privateWorkbench.renderPreviewRail(host);
		expect(host.querySelector('.crosswalker-render-banner.is-warning')?.textContent).toContain(
			'Body projection level "control" is not a level that becomes sections',
		);
	});

	it('keeps the source row count as the non-nested preview total', () => {
		const plain: ImportMapping = { mappings: [{ levels: [{
			level: 'id',
			source: { column: 'id' },
			destinations: [{ primitive: 'name' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}] }] };
		const parsedData: ParsedData = { columns: ['id'], rows: [{ id: 'one' }], rowCount: 12 };
		expect(workbench(plain, parsedData).computePreview()?.total).toBe(12);
	});

	it('puts the Depth dial before shape cards and describes nested arrangement controls', () => {
		const wb = workbench(nested);
		const privateWorkbench = wb as unknown as PrivateWorkbench;
		privateWorkbench.expanded.add(0);
		const host = document.createElement('div');
		privateWorkbench.renderMappingCard(host, wb.getMapping().mappings[0], 0);
		const depth = host.querySelector('.crosswalker-wb-depth')!;
		const shapes = host.querySelector('.crosswalker-wb-shapes')!;
		expect(depth.compareDocumentPosition(shapes) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(host.querySelector('.crosswalker-wb-arrange')?.textContent).toBe(
			'▸ Arrange levels (which get a note, how each is named)',
		);
	});

	it('previews every level from the deepest expanded nested row', async () => {
		const groups = fixture.catalog.groups as unknown as Record<string, unknown>[];
		const parsedData: ParsedData = {
			columns: ['id', 'title', 'controls'],
			rows: groups,
			rowCount: groups.length,
			container: { kind: 'json', readDocument: async () => fixture },
		};
		const wb = workbench(nested, parsedData);
		await Promise.resolve();
		await Promise.resolve();
		const privateWorkbench = wb as unknown as PrivateWorkbench;
		const levels = wb.getMapping().mappings[0].levels;
		expect(levels.map((level) => privateWorkbench.sampleForLevel(level))).toEqual([
			'ac',
			'ac-1',
			'ac-1_smt.md',
		]);
		const host = document.createElement('div');
		privateWorkbench.renderCombinedPreview(host, 0);
		expect(host.textContent).toContain('ac/ac-1/ac-1_smt.md');
		expect(host.textContent).not.toContain('cannot preview');
	});

	it('defaults the sample note to the first note-level row, never an empty parent folder note', async () => {
		const leftOut = workbench(sectionReadyMapping(), sectionFixtureData());
		await Promise.resolve();
		await Promise.resolve();
		let rail = document.createElement('div');
		(leftOut as unknown as PrivateWorkbench).renderPreviewRail(rail);
		expect(rail.querySelector('[data-preview-note="sample"] .crosswalker-wb-note-title')?.textContent).toBe('ac-1.md');
		expect(rail.querySelector('.crosswalker-wb-tree-row.is-selected')?.textContent).toBe('ac-1.md');
		// No properties or body on this mapping: the sample says so instead of rendering blank.
		expect(rail.querySelector('[data-preview-content="sample-note"]')?.textContent)
			.toBe('No properties or body text on this note yet.');

		// Switch the part level to sections through the real Placement control.
		const placement = renderMatrix(leftOut).querySelector<HTMLSelectElement>('[data-nest-control="placement"]')!;
		placement.value = 'section';
		placement.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();
		rail = document.createElement('div');
		(leftOut as unknown as PrivateWorkbench).renderPreviewRail(rail);
		expect(rail.querySelector('[data-preview-note="sample"] .crosswalker-wb-note-title')?.textContent).toBe('ac-1.md');
		expect(rail.querySelector('[data-preview-content="sample-note"]')?.textContent).toMatch(/^## Statement\n\nCreate a synthetic account record\./m);
	});

	it('keeps merge available on a non-nested mapping', () => {
		const plain: ImportMapping = { mappings: [{ levels: [
			{ level: 'parent', source: { column: 'id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
		] }] };
		expect(renderMatrix(workbench(plain)).textContent).toContain('Merge');
	});
});
