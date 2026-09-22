jest.mock('obsidian', () => ({
	...jest.requireActual('./__mocks__/obsidian'),
	setIcon: () => {},
}));

import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { splitIntoLevels } from '../src/import/mapping/view-model';
import type { StructureMapping, LevelRule } from '../src/import/mapping/types';
import type { ColumnInfo, ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';

const debug = {
	info() {},
	trace() {},
	warn() {},
	error() {},
} as unknown as DebugLog;

interface PanelPreview {
	column: string;
	delimiters: string;
	samples: string[];
	histogram: { depth: number; count: number; percent: number }[];
	modalDepth: number;
	caption: string | null;
}

interface PrivateWorkbench {
	splitPanel: { mi: number; li: number } | null;
	splitPanelPreview(mi: number, li: number, delimiters?: string): PanelPreview | null;
	applySplitPanel(
		mi: number,
		li: number,
		delimiters: string,
		depth: number,
		naming: ('part' | 'prefix')[],
		missing: 'skip' | 'error',
	): void;
	renderSplitPanel(
		tbody: HTMLElement,
		mapping: StructureMapping,
		mi: number,
		rule: LevelRule,
		li: number,
	): void;
	renderShapeCards(card: HTMLElement, mapping: StructureMapping, mi: number): void;
	folderSplitHint(mi: number): { text: string; li: number } | null;
	openFolderSplitPanel(mi: number): void;
}

function priv(workbench: MappingWorkbench): PrivateWorkbench {
	return workbench as unknown as PrivateWorkbench;
}

function baseMapping(): StructureMapping {
	return {
		levels: [
			{
				level: 'profile-id',
				source: [{ column: 'profile_id' }],
				destinations: [{ primitive: 'folder' }, { primitive: 'name' }],
				naming: 'part',
				missing: 'skip',
				materialize: false,
			},
		],
	};
}

function makeWorkbench(
	rows: Record<string, unknown>[] | AsyncIterable<Record<string, unknown>>,
	columnInfos?: ColumnInfo[],
): MappingWorkbench {
	const columns = ['profile_id'];
	const parsedData: ParsedData = {
		columns,
		rows,
		rowCount: Array.isArray(rows) ? rows.length : -1,
	};
	return new MappingWorkbench({
		parsedData,
		columnInfos: columnInfos ?? analyzeColumns(parsedData),
		outputPath: 'Ontologies',
		debug,
		defaultPresetId: 'browsable-framework',
		initialMapping: { mappings: [baseMapping()] },
		onChange: () => {},
	});
}

function a2Rows(): Record<string, unknown>[] {
	return [
		{ profile_id: 'GV.OC-01.01' },
		{ profile_id: 'GV.OC-02.03' },
		{ profile_id: 'PR.AA-01.02' },
	];
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

describe('Split into levels panel', () => {
	it('A2 previews four levels and applies the same mapping as splitIntoLevels', () => {
		const workbench = makeWorkbench(a2Rows());
		const panel = priv(workbench);
		const preview = panel.splitPanelPreview(0, 0);

		expect(preview?.delimiters).toBe('.-');
		expect(preview?.histogram).toEqual([{ depth: 4, count: 3, percent: 100 }]);
		expect(preview?.modalDepth).toBe(4);

		const before = workbench.getMapping().mappings[0];
		const options = {
			delimiters: '.-',
			depth: 4,
			naming: ['prefix', 'prefix', 'prefix'] as ('part' | 'prefix')[],
			missing: 'skip' as const,
		};
		panel.applySplitPanel(0, 0, options.delimiters, options.depth, options.naming, options.missing);

		const actual = workbench.getMapping().mappings[0];
		expect(actual).toEqual(splitIntoLevels(before, 0, options));
		expect(actual.levels).toHaveLength(4);
		for (const [index, level] of actual.levels.slice(0, 3).entries()) {
			expect(level).toMatchObject({
				source: [{ column: 'profile_id', part: index }],
				delimiters: '.-',
				naming: 'prefix',
				destinations: [{ primitive: 'folder' }],
			});
		}
		expect(actual.levels[3].source).toEqual([{ column: 'profile_id' }]);
		expect(actual.levels[3].destinations).toEqual(before.levels[0].destinations);
	});

	it('A4 shows all ragged depths, selects the deepest tied mode, and stamps skip everywhere', () => {
		const workbench = makeWorkbench([
			{ profile_id: 'GV' },
			{ profile_id: 'GV.OC' },
			{ profile_id: 'GV.OC-01' },
			{ profile_id: 'GV.OC-01.01' },
		]);
		const panel = priv(workbench);
		const preview = panel.splitPanelPreview(0, 0, '.-');

		expect(preview?.histogram).toEqual([
			{ depth: 1, count: 1, percent: 25 },
			{ depth: 2, count: 1, percent: 25 },
			{ depth: 3, count: 1, percent: 25 },
			{ depth: 4, count: 1, percent: 25 },
		]);
		expect(preview?.modalDepth).toBe(4);

		panel.applySplitPanel(0, 0, '.-', 4, ['prefix', 'prefix', 'prefix'], 'skip');
		expect(workbench.getMapping().mappings[0].levels).toHaveLength(4);
		expect(workbench.getMapping().mappings[0].levels.every((level) => level.missing === 'skip')).toBe(true);
	});

	it('A6 uses streaming sample values, shows the caption, and applies the A2 rules', () => {
		async function* rows(): AsyncIterable<Record<string, unknown>> {
			return;
		}
		const samples = a2Rows().map((row) => row.profile_id);
		const workbench = makeWorkbench(rows(), [{
			name: 'profile_id',
			sampleValues: samples,
			detectedType: 'string',
			hasEmptyValues: false,
			uniqueCount: samples.length,
		}]);
		const panel = priv(workbench);
		const preview = panel.splitPanelPreview(0, 0);

		expect(preview?.samples).toEqual(samples);
		expect(preview?.caption).toBe('Depth is estimated from 3 sample values. Streamed sources are not fully scanned.');
		expect(preview?.histogram).toEqual([{ depth: 4, count: 3, percent: 100 }]);
		const tbody = document.createElement('tbody');
		const renderedMapping = workbench.getMapping().mappings[0];
		panel.renderSplitPanel(tbody, renderedMapping, 0, renderedMapping.levels[0], 0);
		expect(tbody.textContent).toContain(preview?.caption);

		const before = workbench.getMapping().mappings[0];
		const options = {
			delimiters: '.-',
			depth: 4,
			naming: ['prefix', 'prefix', 'prefix'] as ('part' | 'prefix')[],
			missing: 'skip' as const,
		};
		panel.applySplitPanel(0, 0, options.delimiters, options.depth, options.naming, options.missing);
		expect(workbench.getMapping().mappings[0]).toEqual(splitIntoLevels(before, 0, options));
	});

	it('refuses the last delimiter, recomputes depth, and applies one changed naming choice', () => {
		const workbench = makeWorkbench(a2Rows());
		const panel = priv(workbench);
		const mapping = workbench.getMapping().mappings[0];
		const tbody = document.createElement('tbody');
		panel.renderSplitPanel(tbody, mapping, 0, mapping.levels[0], 0);

		const chip = (text: string): HTMLButtonElement => {
			const button = [...tbody.querySelectorAll<HTMLButtonElement>('.crosswalker-wb-split-delimiters button')]
				.find((candidate) => candidate.textContent === text);
			if (!button) throw new Error(`Missing delimiter chip ${text}`);
			return button;
		};
		expect(tbody.querySelectorAll('.crosswalker-wb-split-levels tbody tr')).toHaveLength(4);
		chip('-').click();
		expect(tbody.querySelectorAll('.crosswalker-wb-split-levels tbody tr')).toHaveLength(3);
		chip('.').click();
		expect(tbody.querySelector('.crosswalker-wb-split-message')?.textContent).toBe('Keep at least one delimiter on.');
		expect(chip('.').classList.contains('is-on')).toBe(true);

		const freshBody = document.createElement('tbody');
		panel.renderSplitPanel(freshBody, mapping, 0, mapping.levels[0], 0);
		const namingSelects = freshBody.querySelectorAll<HTMLSelectElement>('.crosswalker-wb-split-levels select');
		expect(namingSelects).toHaveLength(3);
		namingSelects[1].value = 'part';
		namingSelects[1].dispatchEvent(new Event('change'));
		freshBody.querySelector<HTMLButtonElement>('.crosswalker-wb-split-actions .mod-cta')?.click();

		const produced = workbench.getMapping().mappings[0].levels;
		expect(produced.slice(0, 3).map((level) => level.naming)).toEqual(['prefix', 'part', 'prefix']);
		expect(freshBody.textContent).not.toContain('—');
	});

	it('A11 describes the Folder split and opens the panel on the first matching row', () => {
		const workbench = makeWorkbench(a2Rows());
		const panel = priv(workbench);

		expect(panel.folderSplitHint(0)).toEqual({
			text: 'Splits into 4 levels on . and -',
			li: 0,
		});
		const card = document.createElement('div');
		panel.renderShapeCards(card, workbench.getMapping().mappings[0], 0);
		const hint = card.querySelector('.crosswalker-wb-shape-hint.is-split-hint');
		expect(hint?.textContent).toContain('Splits into 4 levels on . and -');
		hint?.querySelector<HTMLButtonElement>('button')?.click();
		expect(panel.splitPanel).toEqual({ mi: 0, li: 0 });
	});
});
