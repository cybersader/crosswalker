jest.mock('obsidian', () => {
	const actual = jest.requireActual('./__mocks__/obsidian');
	class Setting {
		private readonly settingEl: HTMLElement;
		private readonly nameEl: HTMLElement;
		private readonly descEl: HTMLElement;
		private readonly controlEl: HTMLElement;

		constructor(container: HTMLElement) {
			this.settingEl = document.createElement('div');
			this.settingEl.className = 'setting-item';
			const info = document.createElement('div');
			this.nameEl = document.createElement('div');
			this.nameEl.className = 'setting-item-name';
			this.descEl = document.createElement('div');
			this.descEl.className = 'setting-item-description';
			this.controlEl = document.createElement('div');
			info.append(this.nameEl, this.descEl);
			this.settingEl.append(info, this.controlEl);
			container.append(this.settingEl);
		}

		setName(name: string): this { this.nameEl.textContent = name; return this; }
		setDesc(description: string): this { this.descEl.textContent = description; return this; }
		setHeading(): this { return this; }
		addDropdown(callback: (dropdown: {
			addOption(value: string, label: string): void;
			setValue(value: string): void;
			onChange(handler: (value: string) => void): void;
		}) => void): this {
			const select = document.createElement('select');
			callback({
				addOption: (value, label) => select.add(new Option(label, value)),
				setValue: (value) => { select.value = value; },
				onChange: (handler) => select.addEventListener('change', () => handler(select.value)),
			});
			this.controlEl.append(select);
			return this;
		}
		addText(callback: (text: {
			inputEl: HTMLInputElement;
			setValue(value: string): void;
			onChange(handler: (value: string) => void): void;
		}) => void): this {
			const input = document.createElement('input');
			callback({
				inputEl: input,
				setValue: (value) => { input.value = value; },
				onChange: (handler) => input.addEventListener('change', () => handler(input.value)),
			});
			this.controlEl.append(input);
			return this;
		}
		addToggle(): this { return this; }
		addButton(): this { return this; }
		addTextArea(): this { return this; }
	}
	return { ...actual, Setting };
});

import type { TFile } from 'obsidian';
import { ImportFlow } from '../src/import/import-wizard';
import type { WizardDraft } from '../src/import/draft-store';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import type { WorkbookSuggestion } from '../src/import/workbook-suggestion';

interface FlowInternals {
	applySheetSuggestion(suggestion: WorkbookSuggestion): void;
	invalidateParse(): void;
	consumePendingPrefill(): Promise<void>;
	resetForNewSource(): void;
	snapshotDraft(): WizardDraft;
	hydrateFromDraft(draft: WizardDraft): Promise<void>;
	reparseFromVault(vaultPath: string, name: string): Promise<boolean>;
}

function internals(flow: ImportFlow): FlowInternals {
	return flow as unknown as FlowInternals;
}

function makeFlow(): ImportFlow {
	const app = {
		vault: {
			getFiles: () => [],
			getAbstractFileByPath: () => null,
		},
	} as unknown as ConstructorParameters<typeof ImportFlow>[0];
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, savedConfigs: [] },
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as ConstructorParameters<typeof ImportFlow>[1];
	return new ImportFlow(app, plugin, {
		containerEl: document.createElement('div'),
		close: () => {},
	});
}

function suggestion(): WorkbookSuggestion {
	return {
		sheetName: 'Profile',
		headerRow: 1,
		recipeId: 'synthetic-recipe',
		label: 'Synthetic profile',
		score: 100,
		confident: true,
	};
}

function draft(overrides: Partial<WizardDraft> = {}): WizardDraft {
	const now = '2026-09-21T00:00:00.000Z';
	return {
		schemaVersion: 1,
		id: 'draft_synthetic',
		name: 'synthetic draft',
		createdAt: now,
		updatedAt: now,
		currentStep: 1,
		sourceFile: null,
		sourceType: 'xlsx',
		selectedSheet: 'Profile',
		columnInfos: [],
		columnConfigsDict: {},
		config: {},
		outputPath: 'Frameworks/Synthetic',
		overwriteMode: 'skip',
		frameworkId: 'synthetic',
		appliedConfigId: null,
		...overrides,
	};
}

function installDomHelpers(): void {
	Object.assign(HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: {
			cls?: string;
			text?: string;
			attr?: Record<string, string>;
			type?: string;
			href?: string;
		} = {}) {
			const element = document.createElement(tag) as HTMLElement & { type?: string; href?: string };
			if (options.cls) element.className = options.cls;
			if (options.text !== undefined) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			if (options.type !== undefined) element.type = options.type;
			if (options.href !== undefined) element.href = options.href;
			this.appendChild(element);
			return element;
		},
		createDiv(this: HTMLElement, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			return (this as unknown as { createEl(tag: string, opts: typeof options): HTMLElement }).createEl('div', options);
		},
		createSpan(this: HTMLElement, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			return (this as unknown as { createEl(tag: string, opts: typeof options): HTMLElement }).createEl('span', options);
		},
		appendText(this: HTMLElement, text: string) {
			this.append(document.createTextNode(text));
		},
		setText(this: HTMLElement, text: string) {
			this.textContent = text;
		},
	});
}

beforeAll(installDomHelpers);

afterEach(() => {
	jest.restoreAllMocks();
});

describe('workbook suggestions in ImportFlow', () => {
	it('applies a suggestion to both controls without marking it overridden', () => {
		const flow = makeFlow();
		internals(flow).applySheetSuggestion(suggestion());

		expect(flow.selectedSheet).toBe('Profile');
		expect(flow.xlsxHeaderRow).toBe(1);
		expect(flow.sheetSuggestion).toMatchObject({ overridden: false });
	});

	it('marks a changed header row overridden and clears the flag when restored', () => {
		const flow = makeFlow();
		internals(flow).applySheetSuggestion(suggestion());

		flow.setHeaderRow(2);
		expect(flow.sheetSuggestion?.overridden).toBe(true);

		flow.setHeaderRow(1);
		expect(flow.sheetSuggestion?.overridden).toBe(false);
	});

	it('keeps the suggestion when parse-derived state is invalidated', () => {
		const flow = makeFlow();
		internals(flow).applySheetSuggestion(suggestion());

		internals(flow).invalidateParse();

		expect(flow.sheetSuggestion).toMatchObject({ sheetName: 'Profile', headerRow: 1 });
	});

	it('applies a pending binding before reparsing the vault file', async () => {
		const flow = makeFlow();
		flow.pendingPrefill = { path: 'Sources/synthetic.xlsx', name: 'synthetic.xlsx' } as TFile;
		flow.pendingPrefillBinding = { sheet: 'Profile', headerRow: 2, iterator: null };
		const reparse = jest.spyOn(internals(flow), 'reparseFromVault').mockImplementation(async () => {
			expect(flow.selectedSheet).toBe('Profile');
			expect(flow.xlsxHeaderRow).toBe(2);
			expect(flow.jsonIterator).toBe('');
			return true;
		});

		await internals(flow).consumePendingPrefill();

		expect(reparse).toHaveBeenCalledWith('Sources/synthetic.xlsx', 'synthetic.xlsx');
		expect(flow.pendingPrefill).toBeNull();
		expect(flow.pendingPrefillBinding).toBeNull();
		expect(flow.currentStep).toBe(1);
	});

	it('persists and restores the workbook header row, with old drafts defaulting to row 0', async () => {
		const flow = makeFlow();
		flow.xlsxHeaderRow = 3;
		const snapshot = internals(flow).snapshotDraft();
		expect(snapshot.xlsxHeaderRow).toBe(3);

		await internals(flow).hydrateFromDraft(draft({ xlsxHeaderRow: 4 }));
		expect(flow.xlsxHeaderRow).toBe(4);

		await internals(flow).hydrateFromDraft(draft());
		expect(flow.xlsxHeaderRow).toBe(0);
	});

	it('keeps draft storage 0-based while the header-row control shows spreadsheet numbering', async () => {
		const flow = makeFlow();
		await internals(flow).hydrateFromDraft(draft({ xlsxHeaderRow: 1 }));
		expect(flow.xlsxHeaderRow).toBe(1);

		flow.sourceFile = new File(['synthetic'], 'synthetic.xlsx');
		flow.sourceType = 'xlsx';
		flow.availableSheets = ['Profile'];
		flow.selectedSheet = 'Profile';
		const container = document.createElement('div');
		flow.renderStep1_SelectFile(container);

		const headerSetting = [...container.querySelectorAll<HTMLElement>('.setting-item')]
			.find((item) => item.querySelector('.setting-item-name')?.textContent === 'Header row');
		const input = headerSetting?.querySelector<HTMLInputElement>('input');
		expect(input?.value).toBe('2');
		expect(input?.min).toBe('1');
		expect(headerSetting?.querySelector('.setting-item-description')?.textContent).toBe(
			'The spreadsheet row that holds the column names, as numbered in Excel. Raise it to skip banner rows above them.',
		);

		input!.value = '3';
		input!.dispatchEvent(new Event('change'));
		expect(flow.xlsxHeaderRow).toBe(2);
	});

	it('renders the numbered suggestion above the Sheet control and restates it after override', () => {
		const flow = makeFlow();
		flow.sourceFile = new File(['synthetic'], 'synthetic.xlsx');
		flow.sourceType = 'xlsx';
		flow.availableSheets = ['Profile', 'Other'];
		internals(flow).applySheetSuggestion(suggestion());
		const container = document.createElement('div');
		flow.renderStep1_SelectFile(container);

		const line = container.querySelector<HTMLElement>('.crosswalker-sheet-suggestion')!;
		const sheetSetting = [...container.querySelectorAll<HTMLElement>('.setting-item')]
			.find((item) => item.querySelector('.setting-item-name')?.textContent === 'Sheet')!;
		expect(line.textContent).toBe(
			"Suggested from Synthetic profile: sheet 'Profile', headers on row 2 as numbered in the spreadsheet. Change either if this is not the file you expect.",
		);
		expect(line.compareDocumentPosition(sheetSetting) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

		flow.selectSheet('Other');
		const overridden = document.createElement('div');
		flow.renderStep1_SelectFile(overridden);
		expect(overridden.querySelector('.crosswalker-sheet-suggestion')?.textContent).toBe(
			"Using your choice: sheet 'Other', headers on row 2. Suggested: sheet 'Profile', row 2. Use suggestion",
		);
	});

	it('resets the workbook header row and suggestion for a newly selected source', () => {
		const flow = makeFlow();
		flow.xlsxHeaderRow = 5;
		flow.sheetSuggestion = { ...suggestion(), overridden: true };

		internals(flow).resetForNewSource();

		expect(flow.xlsxHeaderRow).toBe(0);
		expect(flow.sheetSuggestion).toBeNull();
	});
});
