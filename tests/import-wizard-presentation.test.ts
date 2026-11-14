jest.mock('obsidian', () => {
	const actual = jest.requireActual('./__mocks__/obsidian');
	// Real input events for the source controls; other Settings keep the shared mock.
	class Setting extends actual.Setting {
		constructor(private readonly container: HTMLElement) { super(container); }
		addDropdown = (callback: (control: any) => void) => {
			const select = document.createElement('select');
			callback({
				addOption: (value: string, label: string) => select.add(new Option(label, value)),
				setValue: (value: string) => { select.value = value; },
				onChange: (handler: (value: string) => void) => select.addEventListener('change', () => handler(select.value)),
			});
			this.container.append(select); return this;
		};
		addText = (callback: (control: any) => void) => {
			const input = document.createElement('input');
			callback({
				inputEl: input,
				setValue: (value: string) => { input.value = value; },
				onChange: (handler: (value: string) => void) => input.addEventListener('input', () => handler(input.value)),
			});
			this.container.append(input); return this;
		};
	}
	return { ...actual, Setting, setIcon: jest.fn() };
});

import { ImportFlow } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';

// Real DOM, with only Obsidian's element conveniences adapted to jsdom.
beforeAll(() => Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); },
	createEl(this: HTMLElement, tag: string, options: any = {}) {
		const el = document.createElement(tag);
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.textContent = options.text;
		if (options.type) el.setAttribute('type', options.type);
		for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
		this.append(el); return el;
	},
	createDiv(this: any, options: any = {}) { return this.createEl('div', options); },
	createSpan(this: any, options: any = {}) { return this.createEl('span', options); },
	appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
	setText(this: HTMLElement, text: string) { this.textContent = text; },
	setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
	addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
}));

function fixture() {
	const mutations = { create: jest.fn(), modify: jest.fn(), delete: jest.fn(), createFolder: jest.fn() };
	const plugin = { settings: { ...DEFAULT_SETTINGS, savedConfigs: [] }, debug: { info: jest.fn(), trace: jest.fn(), warn: jest.fn(), error: jest.fn() } };
	const root = document.createElement('div');
	const flow = new ImportFlow({ vault: { ...mutations, getFiles: () => [], getAbstractFileByPath: () => null } } as any, plugin as any, {
		containerEl: root, close: jest.fn(),
	});
	return { flow, inner: flow as any, mutations, plugin, root };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function before(a: Element | null, b: Element | null) {
	expect(a).not.toBeNull(); expect(b).not.toBeNull();
	expect(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}
function mirrored(flow: ImportFlow): HTMLButtonElement[] {
	const root = document.createElement('div');
	(flow as any).createPrimaryButton(root.createDiv({ cls: 'crosswalker-nav-right' }));
	flow.renderFooter(root);
	return Array.from(root.querySelectorAll('button'));
}

describe('source-first presentation', () => {
	it('places actual vault/computer controls before saved recipes and closed publisher guidance', () => {
		const { flow } = fixture(); const root = document.createElement('div');
		flow.renderStep1_SelectFile(root);
		const vault = root.querySelector('.crosswalker-vault-pick-row button');
		const computer = root.querySelector('input[type=file]');
		const saved = root.querySelector('.crosswalker-saved-recipe-row');
		const guide = root.querySelector('details');
		before(vault, computer); before(computer, saved); before(saved, guide);
		before(saved, root.querySelector('a[href*="framework-data-sources"]'));
		expect(computer?.getAttribute('aria-label')).toBe('Pick a file from your computer');
		expect((guide as HTMLDetailsElement).open).toBe(false);
		expect(guide?.textContent).toMatch(/registration/i);
	});

	it('retains the Run again exit after both pickers, without first-import help', () => {
		const { flow, inner } = fixture(); inner.runAgain = { importSetId: 'chosen-set' };
		const exit = jest.spyOn(inner, 'exitRunAgain');
		jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		const root = document.createElement('div'); flow.renderStep1_SelectFile(root);
		before(root.querySelector('input[type=file]'), root.querySelector('.crosswalker-run-again-exit'));
		expect(root.querySelector('details')).toBeNull();
		expect(root.querySelector('a[href*="framework-data-sources"]')).toBeNull();
		(root.querySelector('.crosswalker-run-again-exit') as HTMLButtonElement).click();
		expect(exit).toHaveBeenCalledTimes(1); expect(inner.runAgain).toBeNull();
	});

	it.each([
		[1, false, false, false, 'Read source'],
		[1, true, false, false, 'Choose layout'],
		[2, true, false, false, 'Review import'],
		[3, true, false, false, 'Continue to generation'],
		[1, false, true, false, 'Parsing...'],
		[4, true, false, false, 'Generate'],
		[4, true, false, true, 'Generating…'],
	])('mirrors step %s parsed=%s parsing=%s generating=%s', (step, parsed, parsing, generating, label) => {
		const { flow } = fixture(); flow.currentStep = step as number;
		flow.parsedData = parsed ? { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 } : null;
		flow.isParsing = parsing as boolean; flow.isGenerating = generating as boolean;
		const buttons = mirrored(flow);
		expect(buttons.map(b => b.textContent)).toEqual([label, label]);
		expect(buttons.map(b => b.disabled)).toEqual([!!parsing || !!generating, !!parsing || !!generating]);
	});

	it.each(['json-list', 'json-path', 'xlsx-sheet', 'xlsx-header'])('updates existing continuation labels after %s changes without rebuilding inputs', control => {
		const { flow, inner, root, mutations } = fixture();
		const json = control.startsWith('json');
		flow.sourceType = json ? 'json' : 'xlsx';
		flow.sourceFile = new File(['synthetic'], `synthetic.${flow.sourceType}`);
		flow.parsedData = { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 };
		inner.jsonIterator = 'first';
		inner.jsonStructure = { rootIsArray: false, candidates: ['first', 'second'].map(name => ({
			name, label: name, iterator: name, count: 1, sample: { id: 'a' }, sampleKeys: ['id'], fieldCount: 1,
		})) };
		flow.availableSheets = ['First', 'Second']; flow.selectedSheet = 'First';
		flow.importSetChoice = { id: 'chosen-set' }; inner.presetLibraryRecipeId = 'saved-recipe';
		const rerender = jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		const parse = jest.spyOn(flow, 'parseSourceFile');
		inner.createPrimaryButton(root.createDiv());
		flow.renderStep1_SelectFile(root.createDiv());
		flow.renderFooter(root);
		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.crosswalker-step-continue'));
		expect(buttons.map(button => button.textContent)).toEqual(['Choose layout', 'Choose layout']);
		const selector = control === 'json-list' ? '.crosswalker-json-pick:last-child'
			: control === 'json-path' ? '.crosswalker-advanced input'
				: control === 'xlsx-sheet' ? 'select' : 'input[type=number]';
		const input = root.querySelector<HTMLElement>(selector)!;
		expect(input).not.toBeNull();
		document.body.append(root);
		try {
			// Same-value events and the generation-only filter do not invalidate the parse.
			if (json) {
				const filter = root.querySelector<HTMLInputElement>('input[placeholder="e.g. status=active"]')!;
				filter.value = 'id=a'; filter.dispatchEvent(new Event('input'));
				expect(buttons.map(button => button.textContent)).toEqual(['Choose layout', 'Choose layout']);
			}
			if (control !== 'json-list') {
				input.dispatchEvent(new Event(control === 'xlsx-sheet' ? 'change' : 'input'));
				expect(buttons.map(button => button.textContent)).toEqual(['Choose layout', 'Choose layout']);
			}
			input.focus();
			if (control === 'json-list') input.click();
			else {
				(input as HTMLInputElement).value = control === 'json-path' ? 'second' : control === 'xlsx-sheet' ? 'Second' : '2';
				input.dispatchEvent(new Event(control === 'xlsx-sheet' ? 'change' : 'input'));
			}
			expect(flow.parsedData).toBeNull();
			expect(buttons.map(button => button.textContent)).toEqual(['Read source', 'Read source']);
			expect(Array.from(root.querySelectorAll('.crosswalker-step-continue'))).toEqual(buttons);
			expect(buttons.every(button => !button.disabled)).toBe(true);
			if (control !== 'json-list') {
				expect(root.querySelector(selector)).toBe(input);
				expect(document.activeElement).toBe(input);
			}
			expect(rerender).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
			expect(flow.importSetChoice).toEqual({ id: 'chosen-set' });
			expect(inner.presetLibraryRecipeId).toBe('saved-recipe');
			for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
		} finally { root.remove(); }
	});

	it.each([false, true])('keeps JSON cards and the path synchronized in place (root array=%s)', rootIsArray => {
		const { flow, inner, root, mutations } = fixture();
		const first = rootIsArray ? '' : '$.first[*]';
		inner.jsonIterator = first;
		inner.jsonStructure = { rootIsArray, rootCount: 1, candidates: (rootIsArray ? [''] : [first, '$.second[*]']).map(iterator => ({
			iterator, name: iterator || 'Root', label: iterator || 'Root', count: 1, sample: { id: 'a' }, sampleKeys: ['id'], fieldCount: 1,
		})) };
		flow.importSetChoice = { id: 'chosen-set' }; inner.presetLibraryRecipeId = 'saved-recipe';
		const rerender = jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		inner.renderJsonRecordPicker(root);
		const advanced = root.querySelector<HTMLDetailsElement>('details')!;
		const input = advanced.querySelector<HTMLInputElement>('input')!;
		const cards = Array.from(root.querySelectorAll<HTMLElement>('.crosswalker-json-pick'));
		const indicators = cards.map(card => card.querySelector('.crosswalker-json-radio')!);
		const selected = () => cards.map(card => card.classList.contains('crosswalker-json-pick-selected'));
		advanced.open = true; document.body.append(root);
		try {
			input.focus();
			if (!rootIsArray) {
				cards[1].click();
				expect(input.value).toBe('$.second[*]'); expect(inner.jsonIterator).toBe(input.value);
				expect(selected()).toEqual([false, true]);
				expect(indicators.map(el => el.textContent)).toEqual(['○', '●']);
			}
			for (const value of ['$.unmatched[*]', `  ${first}  `]) {
				input.value = value; input.setSelectionRange(2, 2);
				input.dispatchEvent(new Event('input'));
				expect(inner.jsonIterator).toBe(value.trim());
				expect(input.value).toBe(value); // Never rewrite text mid-keystroke.
				expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(2);
				expect(selected()).toEqual(cards.map((_, i) => value.trim() === first && i === 0));
				expect(indicators.map(el => el.textContent)).toEqual(selected().map(on => on ? '●' : '○'));
				expect(document.activeElement).toBe(input); expect(advanced.open).toBe(true);
				expect(advanced.querySelector('input')).toBe(input);
				expect(Array.from(root.querySelectorAll('.crosswalker-json-pick'))).toEqual(cards);
			}
			input.value = '$.unmatched[*]'; input.dispatchEvent(new Event('input'));
			expect(selected().every(on => !on)).toBe(true);
			cards[0].click();
			expect(inner.jsonIterator).toBe(first); expect(input.value).toBe(first);
			expect(selected()).toEqual(cards.map((_, i) => i === 0));
			expect(indicators.map(el => el.textContent)).toEqual(cards.map((_, i) => i === 0 ? '●' : '○'));
			expect(document.activeElement).toBe(input); expect(advanced.open).toBe(true);
			expect(advanced.querySelector('input')).toBe(input);
			expect(Array.from(root.querySelectorAll('.crosswalker-json-pick'))).toEqual(cards);
			expect(flow.importSetChoice).toEqual({ id: 'chosen-set' });
			expect(inner.presetLibraryRecipeId).toBe('saved-recipe');
			expect(rerender).not.toHaveBeenCalled();
			for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
		} finally { root.remove(); }
	});

	it('synchronizes nested JSON choices with cards and path without replacing radios', () => {
		const { inner, root } = fixture();
		inner.jsonIterator = '$.first[*]'; inner.jsonNest = '$.first[*]';
		inner.jsonStructure = { rootIsArray: false, candidates: ['first', 'second'].map(name => ({
			name, label: name, iterator: `$.${name}[*]`, count: 1, sample: { id: 'a' }, sampleKeys: ['id'], fieldCount: 1,
			...(name === 'first' ? { nested: [{ field: 'children', count: 1, sampleKeys: ['id'], idKey: 'id' }] } : {}),
		})) };
		const save = jest.spyOn(inner, 'scheduleDraftSave').mockImplementation(() => {});
		inner.renderJsonRecordPicker(root);
		const input = root.querySelector<HTMLInputElement>('.crosswalker-advanced input')!;
		const nested = root.querySelector<HTMLInputElement>('input[value=nested]')!;
		const flat = root.querySelector<HTMLInputElement>('input[value=flat]')!;
		document.body.append(root);
		try {
			expect(nested.checked).toBe(true);
			input.value = '$.second[*]'; input.dispatchEvent(new Event('input'));
			expect(inner.jsonNest).toBeNull(); expect(nested.checked).toBe(false); expect(flat.checked).toBe(true);
			nested.click();
			expect(inner.jsonIterator).toBe('$.first[*]'); expect(inner.jsonNest).toBe('$.first[*]');
			expect(input.value).toBe('$.first[*]');
			expect(root.querySelector('.crosswalker-json-pick-selected .crosswalker-json-pick-label')?.textContent).toBe('first');
			expect(root.querySelector('input[value=nested]')).toBe(nested);
			expect(nested.checked).toBe(true); expect(flat.checked).toBe(false);
			expect(save).toHaveBeenCalledTimes(1);
		} finally { root.remove(); }
	});

	it.each(['parsing', 'stale-set'])('invalidation preserves existing %s disabled guards', state => {
		const { flow, inner, root } = fixture();
		flow.parsedData = { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 };
		flow.isParsing = state === 'parsing';
		if (state === 'stale-set') {
			inner.runAgain = { importSetId: 'chosen-set' };
			flow.importSetChoice = { id: 'chosen-set' }; inner.discoveredSets = [];
		}
		inner.createPrimaryButton(root.createDiv()); flow.renderFooter(root);
		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.crosswalker-step-continue'));
		const titles = buttons.map(button => button.title);
		flow.setHeaderRow('2');
		expect(buttons.map(button => button.textContent)).toEqual(Array(2).fill(state === 'parsing' ? 'Parsing...' : 'Read source'));
		expect(buttons.every(button => button.disabled)).toBe(true);
		expect(buttons.map(button => button.title)).toEqual(titles);
	});

	it('keeps both stale-set buttons disabled with the existing actionable reason', () => {
		const { flow, inner } = fixture(); inner.runAgain = { importSetId: 'chosen-set' };
		flow.importSetChoice = { id: 'chosen-set' }; inner.discoveredSets = [];
		const validate = jest.spyOn(flow, 'validateCurrentStep');
		for (const button of mirrored(flow)) {
			expect(button.disabled).toBe(true); expect(button.title).toMatch(/set/i); button.click();
		}
		expect(validate).not.toHaveBeenCalled();
	});

	it('Read source can hold for recognition; ordinary continuation still saves a draft', async () => {
		const { flow, inner } = fixture();
		flow.sourceFile = new File(['id\na'], 'synthetic.csv');
		jest.spyOn(inner, 'computeRecognizedMatch').mockImplementation(() => {});
		jest.spyOn(flow, 'parseSourceFile').mockImplementation(async () => {
			flow.parsedData = { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 };
			inner.recognizedMatch = { entry: RECIPE_REGISTRY[0], score: 100 }; return true;
		});
		jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		const draft = jest.spyOn(inner, 'saveDraftNow').mockResolvedValue(undefined);
		mirrored(flow)[0].click(); await settle(); expect(flow.currentStep).toBe(1);
		inner.recognizedDismissed = true;
		mirrored(flow)[1].click(); await settle(); expect(flow.currentStep).toBe(2);
		expect(draft).toHaveBeenCalledTimes(1);
	});

	it('computer selection resets parsed state but does not parse or advance, and keeps chosen recipe/config/refresh identity', () => {
		const { flow, inner } = fixture();
		inner.presetLibraryRecipeId = 'saved-recipe'; flow.importSetChoice = { id: 'chosen-set' };
		const source = new File(['id\na'], 'synthetic.csv');
		const parse = jest.spyOn(flow, 'parseSourceFile');
		jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		const root = document.createElement('div'); flow.renderStep1_SelectFile(root);
		const input = root.querySelector('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [source] }); input.dispatchEvent(new Event('change'));
		expect(flow.sourceFile).toBe(source); expect(flow.sourceType).toBe('csv');
		expect(flow.currentStep).toBe(1); expect(parse).not.toHaveBeenCalled();
		expect(inner.presetLibraryRecipeId).toBe('saved-recipe'); expect(flow.importSetChoice).toEqual({ id: 'chosen-set' });
	});

	it('vault selection still parses and advances, or applies the explicitly chosen recipe', async () => {
		const { flow, inner } = fixture();
		const parse = jest.spyOn(inner, 'reparseFromVault').mockResolvedValue(true);
		jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
		await inner.selectVaultFile({ name: 'synthetic.csv', path: 'synthetic.csv' });
		expect(parse).toHaveBeenCalledWith('synthetic.csv', 'synthetic.csv'); expect(flow.currentStep).toBe(2);
		flow.currentStep = 1; inner.presetLibraryRecipeId = 'saved-recipe';
		const apply = jest.spyOn(inner, 'applyLibraryPreset').mockResolvedValue(true);
		await inner.selectVaultFile({ name: 'synthetic.csv', path: 'synthetic.csv' }); expect(apply).toHaveBeenCalledTimes(1);
	});

	it.each(['replace', 'skip', 'error'])('Run again copy follows chosen ownership without losing bindings (%s)', mode => {
		for (const digest of ['previous-digest', 'changed-digest']) {
			const { flow, inner, mutations } = fixture();
			const run = { importSetId: 'chosen-set', recipeId: 'saved-recipe', finishedAt: '2026-01-01T00:00:00.000Z', source: { name: 'synthetic.csv', digest: 'previous-digest', iterator: 'items' } };
			inner.runAgain = run;
			inner.runAgainContext = { recipeName: 'Saved layout', setName: 'Original set', noteCount: 2 };
			inner.presetLibraryRecipeId = 'saved-recipe';
			inner.pickedSourceDigest = digest;
			inner.jsonIterator = 'items';
			inner.overwriteMode = mode;
			jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
			jest.spyOn(inner, 'runAgainRecipeChanged').mockReturnValue(false);
			const renderCopy = () => {
				const root = document.createElement('div');
				inner.renderRunAgainLead(root);
				inner.renderRunAgainStatus(root);
				return root.textContent!;
			};
			// Run again's explicit initial intent remains readable before discovery.
			expect(renderCopy()).toContain('again into Original set');
			for (const choice of ['new', 'new-set-qualified', { id: 'other-set' }, null]) {
				inner.chooseImportSet(choice);
				const text = renderCopy();
				expect(text).toContain('Review your chosen import set');
				expect(text).toContain(digest === 'previous-digest' ? 'This file matches' : 'This file changed');
				for (const staleClaim of ['Original set', 'adds nothing new', 'will not change your notes', 'will be updated', 'New rows are added', 'may restore missing notes', 'missing notes may be created']) {
					expect(text).not.toContain(staleClaim);
				}
				expect(inner.runAgain).toBe(run);
				expect(inner.presetLibraryRecipeId).toBe('saved-recipe');
				expect(inner.jsonIterator).toBe('items');
			}
			inner.chooseImportSet({ id: run.importSetId });
			expect(renderCopy()).toContain('again into Original set');
			// A settled missing target is not a valid refresh promise either.
			inner.discoveredSets = [];
			expect(renderCopy()).not.toContain('Original set');
			for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
		}
	});

	it.each(['bundled', 'user'])('recognized %s actions retain routes, recipe and refresh identity without managed-note mutations', async origin => {
		for (const [label, step] of [['Review with this recipe', 3], ['Adjust layout', 2]] as const) {
			const { flow, inner, mutations, plugin } = fixture();
			const entry = { ...RECIPE_REGISTRY[0], origin };
			inner.recognizedMatch = { entry, score: 100 };
			flow.parsedData = { columns: ['id'], rows: [{ id: 'a' }], rowCount: 1 };
			flow.importSetChoice = { id: 'chosen-set' };
			const workbench = jest.spyOn(inner, 'makeWorkbench').mockReturnValue({});
			const draft = jest.spyOn(inner, 'scheduleDraftSave').mockImplementation(() => {});
			const prepare = jest.spyOn(inner, 'prepareStep3').mockResolvedValue(undefined);
			jest.spyOn(flow, 'renderStep').mockImplementation(() => {});
			const generation = jest.spyOn(flow, 'generate');
			const root = document.createElement('div'); inner.renderRecognizedSourceCard(root);
			const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-actions button')).find(b => b.textContent === label)!;
			button.click(); await settle();
			expect(flow.currentStep).toBe(step); expect(flow.importSetChoice).toEqual({ id: 'chosen-set' });
			expect(workbench.mock.calls[0][4]).toBe(entry.recipe);
			expect(draft).toHaveBeenCalledTimes(1); expect(plugin.debug.info).toHaveBeenCalled();
			expect(prepare).toHaveBeenCalledTimes(step === 3 ? 1 : 0);
			expect(generation).not.toHaveBeenCalled();
			for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
		}
	});
});
