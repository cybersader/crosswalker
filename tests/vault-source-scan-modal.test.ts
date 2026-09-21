jest.mock('obsidian', () => ({
	...jest.requireActual('./__mocks__/obsidian'),
	setIcon: () => {},
	Notice: jest.fn(),
}));

jest.mock('../src/import/vault-source-scan-runner', () => {
	const actual = jest.requireActual('../src/import/vault-source-scan-runner');
	return {
		...actual,
		scanVaultForSources: jest.fn(),
	};
});

jest.mock('../src/import/run-recognized-import', () => ({
	runRecognizedImport: jest.fn(),
}));

import { TFile } from 'obsidian';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';
import { runRecognizedImport } from '../src/import/run-recognized-import';
import {
	scanVaultForSources,
	type ScanReport,
	type ScanRow,
} from '../src/import/vault-source-scan-runner';
import { VaultSourceScanModal } from '../src/import/vault-source-scan-modal';

const mockedScan = scanVaultForSources as jest.MockedFunction<typeof scanVaultForSources>;
const mockedImport = runRecognizedImport as jest.MockedFunction<typeof runRecognizedImport>;

interface PrivateModal {
	scanTask: Promise<void> | null;
	importSelected(): Promise<void>;
	createDrafts(): Promise<void>;
	openInWizard(row: ScanRow): Promise<void>;
}

function priv(modal: VaultSourceScanModal): PrivateModal {
	return modal as unknown as PrivateModal;
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
		addClass(this: HTMLElement, ...classes: string[]) {
			this.classList.add(...classes);
		},
	});
}

function registryEntry(id: string) {
	const found = RECIPE_REGISTRY.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing registry entry ${id}`);
	return found;
}

function sourceFile(path: string): TFile {
	const result = new TFile(path) as TFile & { name: string };
	result.extension = path.split('.').pop() ?? '';
	result.name = path.split('/').pop() ?? path;
	result.basename = result.name.replace(/\.[^.]+$/, '');
	return result;
}

function row(path: string, id: string, state: ScanRow['state'] = { kind: 'not-imported' }): ScanRow {
	const entry = registryEntry(id);
	return {
		path,
		name: path.split('/').pop() ?? path,
		candidate: {
			path,
			entryId: entry.id,
			label: entry.label,
			table: path.endsWith('.xlsx') ? 'Profile' : '',
			headerRow: path.endsWith('.xlsx') ? 1 : 0,
			score: 100,
			confident: true,
		},
		state,
		digest: 'sha256-synthetic',
		note: null,
	};
}

function report(rows: ScanRow[]): ScanReport {
	return {
		rows,
		skipped: [],
		notes: {},
		scanned: rows.length,
		total: rows.length,
		cancelled: false,
		indexReady: true,
		foreignSets: [],
	};
}

function makeModal(scanReport: ScanReport) {
	const files = new Map(scanReport.rows.map((scanRow) => [scanRow.path, sourceFile(scanRow.path)]));
	const save = jest.fn().mockResolvedValue(undefined);
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		},
		workspace: {
			getLeavesOfType: () => [],
			revealLeaf: jest.fn(),
		},
	} as any;
	const startImportWithFile = jest.fn();
	const plugin = {
		settings: { defaultOutputPath: 'Ontologies' },
		draftStore: { save },
		activateWorkspaceView: jest.fn(async () => ({ view: { startImportWithFile } })),
	} as any;
	mockedScan.mockResolvedValue(scanReport);
	const modal = new VaultSourceScanModal(app, plugin);
	const content = document.createElement('div');
	const modalEl = document.createElement('div');
	(modal as unknown as { contentEl: HTMLElement }).contentEl = content;
	(modal as unknown as { modalEl: HTMLElement }).modalEl = modalEl;
	modal.onOpen();
	return { modal, content, save, startImportWithFile };
}

beforeAll(installDomHelpers);

beforeEach(() => {
	jest.clearAllMocks();
});

describe('vault source scan modal', () => {
	it('renders V1 rows with confident, not-imported sources ticked by default', async () => {
		const { modal, content } = makeModal(report([
			row('a.csv', 'nist-csf-2-flat'),
			row('b.xlsx', 'cri-profile-v2-2-flat'),
			row('c.json', 'mitre-attack-technique-flat'),
		]));
		await priv(modal).scanTask;

		const checks = [...content.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
		expect(checks).toHaveLength(3);
		expect(checks.every((checkbox) => checkbox.checked)).toBe(true);
		expect(content.textContent).toContain('Looks like NIST CSF 2.0');
		expect(content.textContent).toContain('Looks like CRI Profile v2.2');
		expect(content.textContent).toContain('Looks like MITRE ATT&CK techniques');
	});

	it('imports selected rows serially and stops at the first failure', async () => {
		const { modal, content } = makeModal(report([
			row('a.csv', 'nist-csf-2-flat'),
			row('b.xlsx', 'cri-profile-v2-2-flat'),
			row('c.json', 'mitre-attack-technique-flat'),
		]));
		await priv(modal).scanTask;
		mockedImport
			.mockResolvedValueOnce({
				ok: true,
				destination: 'Ontologies/A',
				importSetId: 'set-a',
				created: 2,
				skipped: 0,
				errors: [],
				parsedRowCount: 2,
			})
			.mockResolvedValueOnce({
				ok: false,
				destination: 'Ontologies/B',
				importSetId: null,
				created: 0,
				skipped: 0,
				errors: ['The synthetic source is incomplete. Add the missing column and run the import again.'],
				parsedRowCount: 0,
			});

		await priv(modal).importSelected();

		expect(mockedImport).toHaveBeenCalledTimes(2);
		expect(mockedImport.mock.calls.map((call) => call[2].file.path)).toEqual(['a.csv', 'b.xlsx']);
		expect(mockedImport.mock.calls.some((call) => call[2].overwriteMode === 'replace')).toBe(false);
		const results = [...content.querySelectorAll('.crosswalker-scan-result')].map((cell) => cell.textContent);
		expect(results).toEqual([
			'Imported 2 notes',
			'The synthetic source is incomplete. Add the missing column and run the import again.',
			'',
		]);
		const checks = [...content.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
		expect(checks.map((checkbox) => checkbox.checked)).toEqual([false, true, true]);
	});

	it('creates one neutral draft per selected row without presetRecipeId', async () => {
		const { modal, save } = makeModal(report([
			row('a.csv', 'nist-csf-2-flat'),
			row('b.xlsx', 'cri-profile-v2-2-flat'),
		]));
		await priv(modal).scanTask;

		await priv(modal).createDrafts();

		expect(save).toHaveBeenCalledTimes(2);
		for (const [draft] of save.mock.calls) {
			expect(draft).not.toHaveProperty('presetRecipeId');
			expect(draft).not.toHaveProperty('workbenchMapping');
			expect(draft).not.toHaveProperty('workbenchRecipe');
		}
	});

	it('passes the recognized workbook binding when opening a row in the wizard', async () => {
		const workbookRow = row('b.xlsx', 'cri-profile-v2-2-flat');
		const { modal, startImportWithFile } = makeModal(report([workbookRow]));
		await priv(modal).scanTask;

		await priv(modal).openInWizard(workbookRow);

		expect(startImportWithFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'b.xlsx' }),
			{ sheet: 'Profile', headerRow: 1, iterator: null },
		);
	});

	it('renders required copy in sentence case without em dashes', async () => {
		const { modal, content } = makeModal(report([
			row('a.csv', 'nist-csf-2-flat'),
			row('b.xlsx', 'cri-profile-v2-2-flat'),
		]));
		await priv(modal).scanTask;

		const rendered = content.textContent ?? '';
		expect(rendered).not.toContain('—');
		expect(rendered).toContain('Sources found in this vault');
		expect(rendered).toContain('Framework exports already in this vault, and what each would become.');
		expect(rendered).toContain('Import selected');
		expect(rendered).toContain('Create drafts for selected');
		expect(rendered).toContain('Open in wizard');
		for (const button of content.querySelectorAll('button')) {
			const label = button.textContent ?? '';
			expect(label).toMatch(/^[A-Z]/);
		}
	});
});
