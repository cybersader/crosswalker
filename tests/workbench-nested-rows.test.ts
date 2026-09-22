jest.mock('obsidian', () => ({
	...jest.requireActual('./__mocks__/obsidian'),
	setIcon: () => {},
}));

import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ImportMapping, StructureMapping } from '../src/import/mapping/types';
import type { ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';

const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;

interface PrivateWorkbench {
	renderMatrix(card: HTMLElement, mapping: StructureMapping, mappingIndex: number): void;
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

function workbench(mapping: ImportMapping): MappingWorkbench {
	const rows = [{ id: 'p1', title: 'Part one' }];
	const parsedData: ParsedData = { columns: ['id', 'title'], rows, rowCount: 1 };
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
		expect(host.querySelectorAll('[data-nest-control="leaf"]')).toHaveLength(2);
		expect(host.querySelectorAll('[data-nest-control="identity"]')).toHaveLength(3);
		expect(host.textContent).not.toContain('Merge');
		expect(host.textContent).not.toContain('Split');
		expect(host.textContent).not.toContain('—');

		const leaf = host.querySelector<HTMLSelectElement>('[aria-label="Own note for control"]')!;
		leaf.value = 'none';
		leaf.dispatchEvent(new Event('change'));
		expect(wb.getMapping().nest?.find((entry) => entry.level === 'control')?.leaf).toBe('none');

		const identity = host.querySelector<HTMLSelectElement>('[aria-label="Named by for part"]')!;
		identity.value = 'path';
		identity.dispatchEvent(new Event('change'));
		expect(wb.getMapping().nest?.find((entry) => entry.level === 'part')?.identity).toBe('path');
	});

	it('keeps merge available on a non-nested mapping', () => {
		const plain: ImportMapping = { mappings: [{ levels: [
			{ level: 'parent', source: { column: 'id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'leaf', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
		] }] };
		expect(renderMatrix(workbench(plain)).textContent).toContain('Merge');
	});
});
