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

	it('keeps merge available on a non-nested mapping', () => {
		const plain: ImportMapping = { mappings: [{ levels: [
			{ level: 'parent', source: { column: 'id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
		] }] };
		expect(renderMatrix(workbench(plain)).textContent).toContain('Merge');
	});
});
