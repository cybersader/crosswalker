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
	renderDepthDial(card: HTMLElement, mapping: StructureMapping, mappingIndex: number): void;
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

function nestedMapping(): ImportMapping {
	return {
		mappings: [{ levels: [
			{ level: 'group', source: { column: 'group' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'control', source: { column: 'control' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
			{ level: 'part', source: { column: 'part' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
		] }],
		nest: [
			{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
			{ level: 'control', id: '{id}', children: 'parts', leaf: 'folder-note' },
			{ level: 'part', id: '{id}' },
		],
	};
}

function workbench(mapping: ImportMapping): MappingWorkbench {
	const rows = [{ group: 'g1', control: 'c1', part: 'p1' }];
	const parsedData: ParsedData = { columns: ['group', 'control', 'part'], rows, rowCount: 1 };
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

function renderDepth(wb: MappingWorkbench): HTMLElement {
	const host = document.createElement('div');
	const mapping = wb.getMapping().mappings[0];
	(wb as unknown as PrivateWorkbench).renderDepthDial(host, mapping, 0);
	return host;
}

describe('workbench Depth dial', () => {
	it('renders every simple depth and the required hint', () => {
		const host = renderDepth(workbench(nestedMapping()));
		const select = host.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
		expect(host.querySelector('label')?.textContent).toBe('Depth');
		expect(host.textContent).not.toContain('—');
		expect(select.classList.contains('dropdown')).toBe(true);
		expect([...select.options].map((option) => option.text)).toEqual([
			'No folders',
			'1 folder',
			'2 folders',
		]);
		expect(select.value).toBe('2');
		expect(host.querySelector('.crosswalker-wb-depth-hint')?.textContent).toBe(
			'Each group and control becomes a folder; each part becomes a note.',
		);
	});

	it('writes mapping and nested leaves through one change', () => {
		const wb = workbench(nestedMapping());
		const host = renderDepth(wb);
		const select = host.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
		select.value = '1';
		select.dispatchEvent(new Event('change'));
		const result = wb.getMapping();
		expect(result.mappings[0].levels[0].destinations).toContainEqual({ primitive: 'folder' });
		expect(result.mappings[0].levels[1].destinations).toContainEqual({ primitive: 'name' });
		expect(result.mappings[0].levels[2].destinations).toEqual([]);
		expect(result.nest?.[0].leaf).toBe('folder-note');
		expect(result.nest?.[1].leaf).toBeUndefined();
		expect(result.nest?.[2].leaf).toBe('none');
		expect(renderDepth(wb).querySelector('.crosswalker-wb-depth-hint')?.textContent).toBe(
			'Each group becomes a folder; each control becomes a note; part is left out of this import.',
		);
	});

	it('describes demoted non-nested levels as properties', () => {
		const mapping = nestedMapping();
		delete mapping.nest;
		mapping.mappings[0].levels[1].destinations = [{ primitive: 'name' }];
		mapping.mappings[0].levels[2].destinations = [{ primitive: 'property', key: 'part' }];
		const host = renderDepth(workbench(mapping));
		expect(host.querySelector('.crosswalker-wb-depth-hint')?.textContent).toBe(
			'Each group becomes a folder; each control becomes a note; part kept as properties.',
		);
	});

	it('shows a disabled leading Custom option for a non-simple arrangement', () => {
		const mapping = nestedMapping();
		mapping.mappings[0].levels[2].destinations.push({ primitive: 'folder' });
		const host = renderDepth(workbench(mapping));
		const select = host.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
		expect(select.options[0].text).toBe('Custom');
		expect(select.options[0].disabled).toBe(true);
		expect(select.value).toBe('custom');
		expect(host.textContent).toContain(
			'Custom arrangement. Pick a depth to reset which levels become folders and which becomes the note.',
		);
	});

	it('hides the dial on a metadata-only mapping', () => {
		const mapping: ImportMapping = { mappings: [{ levels: [{
			level: 'owner',
			source: { column: 'owner' },
			destinations: [{ primitive: 'property', key: 'owner' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}] }] };
		expect(renderDepth(workbench(mapping)).children).toHaveLength(0);
	});
});
