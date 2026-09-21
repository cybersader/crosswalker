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

	it('resets the workbook header row and suggestion for a newly selected source', () => {
		const flow = makeFlow();
		flow.xlsxHeaderRow = 5;
		flow.sheetSuggestion = { ...suggestion(), overridden: true };

		internals(flow).resetForNewSource();

		expect(flow.xlsxHeaderRow).toBe(0);
		expect(flow.sheetSuggestion).toBeNull();
	});
});
