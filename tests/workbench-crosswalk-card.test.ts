jest.mock('obsidian', () => ({
	...jest.requireActual('./__mocks__/obsidian'),
	setIcon: () => {},
}));

import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import type { ImportMapping, StructureMapping } from '../src/import/mapping/types';
import type { ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';

const debug = {
	info() {},
	trace() {},
	warn() {},
	error() {},
} as unknown as DebugLog;

interface PrivateWorkbench {
	renderShapeCards(card: HTMLElement, mapping: StructureMapping, mappingIndex: number): void;
}

function priv(workbench: MappingWorkbench): PrivateWorkbench {
	return workbench as unknown as PrivateWorkbench;
}

function installDomHelpers(): void {
	Object.assign(HTMLElement.prototype, {
		empty(this: HTMLElement) {
			this.replaceChildren();
		},
		createEl(this: HTMLElement, tag: string, options: {
			cls?: string;
			text?: string;
			attr?: Record<string, string>;
			type?: string;
			value?: string;
		} = {}) {
			const element = document.createElement(tag) as HTMLElement & { value?: string; type?: string };
			if (options.cls) element.className = options.cls;
			if (options.text !== undefined) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			if (options.type !== undefined) element.type = options.type;
			if (options.value !== undefined) element.value = options.value;
			this.appendChild(element);
			return element;
		},
		createDiv(this: HTMLElement, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			return (this as unknown as { createEl(tag: string, opts: typeof options): HTMLElement }).createEl('div', options);
		},
		createSpan(this: HTMLElement, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			return (this as unknown as { createEl(tag: string, opts: typeof options): HTMLElement }).createEl('span', options);
		},
		setText(this: HTMLElement, text: string) {
			this.textContent = text;
		},
		setAttr(this: HTMLElement, name: string, value: string) {
			this.setAttribute(name, value);
		},
	});
}

beforeAll(installDomHelpers);

afterEach(() => {
	jest.clearAllTimers();
});

function x1Rows(): Record<string, unknown>[] {
	return Array.from({ length: 8 }, (_, index) => ({
		'Profile Id': `GV.OC-${String(index + 1).padStart(2, '0')}.01`,
		'NIST CSF v2 Mapping': 'GV.OC-01.01 (Synthetic note)\nGV.OC-02.01',
	}));
}

function x5Rows(): Record<string, unknown>[] {
	return Array.from({ length: 6 }, (_, index) => ({
		id: `SRC${String(index + 1).padStart(3, '0')}`,
		'Maps to ISO 27001': 'A.5.1, A.5.2',
	}));
}

function workbench(
	rows: Record<string, unknown>[],
	initialMapping?: ImportMapping,
	sourceOntology?: string,
): MappingWorkbench {
	const parsedData: ParsedData = {
		columns: Object.keys(rows[0]),
		rows,
		rowCount: rows.length,
	};
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Frameworks',
		debug,
		defaultPresetId: 'browsable-framework',
		...(initialMapping ? { initialMapping } : {}),
		...(sourceOntology ? { sourceOntology } : {}),
		onChange: () => {},
	});
}

function crosswalkMapping(column: string, toOntology: string | null): StructureMapping {
	return {
		levels: [{
			level: column,
			source: { column },
			destinations: [{ primitive: 'crosswalk', toOntology, predicate: 'is_approximate_to' }],
			naming: 'part',
			missing: 'skip',
			materialize: false,
		}],
	};
}

function renderedCard(wb: MappingWorkbench, mapping: StructureMapping, mappingIndex: number): HTMLElement {
	const host = document.createElement('div');
	priv(wb).renderShapeCards(host, mapping, mappingIndex);
	return host;
}

describe('Crosswalks card', () => {
	it('renders only when a crosswalk detection or destination exists', () => {
		const detected = workbench(x1Rows());
		const detectedIndex = detected.getMapping().mappings.findIndex((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		const detectedHost = renderedCard(detected, detected.getMapping().mappings[detectedIndex], detectedIndex);
		expect(detectedHost.textContent).toContain('Crosswalks');

		const plainRows = [{ id: 'SYN-001', title: 'Synthetic title' }];
		const plainMapping: StructureMapping = {
			levels: [{
				level: 'id',
				source: { column: 'id' },
				destinations: [{ primitive: 'name' }],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			}],
		};
		const plain = workbench(plainRows, { mappings: [plainMapping] });
		expect(renderedCard(plain, plainMapping, 0).textContent).not.toContain('Crosswalks');

		const destination = crosswalkMapping('id', 'target-framework');
		const destinationWb = workbench(plainRows, { mappings: [destination] });
		expect(renderedCard(destinationWb, destination, 0).textContent).toContain('Crosswalks');
	});

	it('writes a registry framework through the view model', () => {
		const wb = workbench(x1Rows());
		const index = wb.getMapping().mappings.findIndex((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		const host = renderedCard(wb, wb.getMapping().mappings[index], index);
		const framework = host.querySelector<HTMLSelectElement>('.crosswalker-wb-crosswalk-controls select')!;
		framework.value = 'mitre-attack';
		framework.dispatchEvent(new Event('change'));

		const destination = wb.getMapping().mappings[index].levels[0].destinations.find(
			(candidate) => candidate.primitive === 'crosswalk',
		);
		expect(destination).toMatchObject({
			primitive: 'crosswalk',
			toOntology: 'mitre-attack',
			predicate: 'is_approximate_to',
		});
	});

	it('shows only valid target frameworks with plain labels and relationship copy', () => {
		const mapping = crosswalkMapping('id', null);
		const wb = workbench(x5Rows(), { mappings: [mapping] }, 'nist-csf-2');
		const host = renderedCard(wb, mapping, 0);
		const labels = [...host.querySelectorAll<HTMLLabelElement>('.crosswalker-wb-crosswalk-controls label')];
		const frameworkLabel = labels.find((label) => label.querySelector('span')?.textContent === 'These ids point to');
		const predicateLabel = labels.find((label) => label.querySelector('span')?.textContent === 'How they relate');
		const framework = frameworkLabel?.querySelector<HTMLSelectElement>('select');
		const predicate = predicateLabel?.querySelector<HTMLSelectElement>('select');

		expect([...framework!.options].map((option) => option.value)).not.toEqual(expect.arrayContaining([
			'xwalk', 'evidence-mappings', 'nist-csf-2',
		]));
		expect([...framework!.options].map((option) => option.text)).toEqual(expect.arrayContaining([
			'Choose a framework', 'CIS Controls v8', 'CRI Profile v2.2',
		]));
		expect(Object.fromEntries([...predicate!.options].map((option) => [option.value, option.text]))).toEqual({
			is_approximate_to: 'Roughly the same requirement',
			is_equivalent_to: 'Exactly the same requirement',
			is_broader_than: 'This one is broader',
			is_narrower_than: 'This one is narrower',
			intersects_with: 'They partly overlap',
		});
	});

	it('summarizes recipe-declared crosswalks even without a detection', () => {
		const rows = [{ id: 'SRC-001', title: 'Synthetic title' }];
		const mapping = crosswalkMapping('id', 'nist-csf-2');
		const wb = workbench(rows, { mappings: [mapping] }, 'synthetic-source');
		const host = renderedCard(wb, mapping, 0);

		expect(host.querySelector('.crosswalker-wb-crosswalk-summary')?.textContent).toBe(
			'id: one edge note per reference, filed under _crosswalker/mappings/ and queryable in Bases.',
		);
	});

	it('adds per-row and qualifier detail when detection evidence exists', () => {
		const wb = workbench(x1Rows(), undefined, 'cri-profile-v2-2');
		const index = wb.getMapping().mappings.findIndex((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		const mapping = wb.getMapping().mappings[index];
		const host = renderedCard(wb, mapping, index);
		const summary = host.querySelector('.crosswalker-wb-crosswalk-summary')?.textContent ?? '';

		expect(summary).toContain('NIST CSF v2 Mapping: one edge note per reference, filed under _crosswalker/mappings/ and queryable in Bases.');
		expect(summary).toContain('NIST CSF v2 Mapping holds 2.0 references per row to NIST CSF 2.0');
		expect(summary).toContain('are kept as the mapping justification.');
	});

	it('slugs Other framework text and renders no em dash', () => {
		const wb = workbench(x5Rows());
		const index = wb.getMapping().mappings.findIndex((mapping) =>
			mapping.levels.some((level) => level.destinations.some((destination) => destination.primitive === 'crosswalk')),
		);
		const host = renderedCard(wb, wb.getMapping().mappings[index], index);
		const framework = host.querySelector<HTMLSelectElement>('.crosswalker-wb-crosswalk-controls select')!;
		framework.value = '__other__';
		framework.dispatchEvent(new Event('change'));
		const input = host.querySelector<HTMLInputElement>('.crosswalker-wb-crosswalk-controls input')!;
		input.value = 'ISO 27001';
		input.dispatchEvent(new Event('change'));

		const destination = wb.getMapping().mappings[index].levels[0].destinations.find(
			(candidate) => candidate.primitive === 'crosswalk',
		);
		expect(destination).toMatchObject({ primitive: 'crosswalk', toOntology: 'iso-27001' });
		expect(host.outerHTML).not.toContain('—');
		expect(host.textContent).toContain('Pick the framework these ids point to. No crosswalk edges are written for this column until you do.');
	});
});
