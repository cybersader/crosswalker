/**
 * recipe-parameter-editor.ts — Phase 4b inline param editor.
 *
 * Renders the user-editable parameters of a LoadedRecipe inline (one widget
 * per param). Per Ch 32 deliverable B + the v0.1.6 milestone plan: ONLY
 * `query.params` fields are surfaced. `query.primitives` is never user-
 * editable from the inline UI — that breaks the wizard round-trip invariant.
 *
 * Type dispatch (commitment #5 — runtime-agnostic):
 *   - 'string'  → text input
 *   - 'number'  → number input (with step inferred from default)
 *   - 'boolean' → toggle
 *   - 'import-set' → dropdown of the frameworks or mapping sets in the vault
 *     (SchemaVer 1.19.0). Preselected only when exactly one exists; otherwise
 *     the user chooses, and `isComplete()` stays false until they do
 *   - anything else (future shapes) → text input (fallback)
 *
 * Returns a `getValues()` accessor so the picker modal can grab the final
 * params dict at "Insert" time.
 */

import { Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { LoadedRecipe, RecipeParam, RecipeParamType } from './recipe-loader';
import { getRecipeParams } from './recipe-loader';
import {
	importSetParamLabel,
	loadImportSetChoices,
	noImportSetMessage,
	type ImportSetChoices,
	type ImportSetKind,
} from './import-set-options';

export interface ParameterEditorHandle {
	getValues(): Record<string, unknown>;
	hasAnyParams(): boolean;
	reset(): void;
	/**
	 * False while a set choice is still loading, or while any `import-set`
	 * parameter has no chosen set. The picker keeps Apply disabled until true.
	 */
	isComplete(): boolean;
}

export interface ParameterEditorOptions {
	/** Needed to list the vault's sets for `import-set` parameters. */
	app?: App;
	/** Called whenever `isComplete()` may have changed. */
	onValidityChange?: (complete: boolean) => void;
	/** Test seam: replaces the vault lookup behind `import-set` parameters. */
	loadChoices?: (kind: ImportSetKind) => Promise<ImportSetChoices>;
}

interface ImportSetContext {
	pending: number;
	load: (kind: ImportSetKind) => Promise<ImportSetChoices>;
	/** The preselect per import-set param, restored by reset(). */
	defaults: Record<string, string | null>;
	notify: () => void;
}

/**
 * Render the parameter editor for a recipe into `container`. Returns a
 * handle the caller (the picker modal) can use to retrieve the current
 * values at insert time.
 *
 * `initialValues` (optional, Phase 4.5 UPDATE-mode addition): if provided,
 * seeds each input with the existing user value instead of the recipe's
 * default. Used by the picker when re-opening on a note with existing
 * `crosswalker_query:` frontmatter.
 */
export function renderParameterEditor(
	container: HTMLElement,
	recipe: LoadedRecipe,
	initialValues?: Record<string, unknown>,
	options: ParameterEditorOptions = {},
): ParameterEditorHandle {
	const params = getRecipeParams(recipe);
	const values: Record<string, unknown> = {};

	// Seed: prefer initialValues (UPDATE flow), fall back to recipe defaults.
	// A set choice has no default: it is chosen, never guessed.
	for (const p of params) {
		if (initialValues && p.name in initialValues) {
			values[p.name] = initialValues[p.name];
		} else if (p.type !== 'import-set') {
			values[p.name] = p.defaultValue ?? defaultForType(p.type);
		}
	}

	if (params.length === 0) {
		container.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Apply" quotes the literal button label
			text: 'This recipe has no exposed parameters to edit. Click Apply to add the block as-is.',
			cls: 'setting-item-description crosswalker-param-editor-empty',
		});
		return {
			getValues: () => ({}),
			hasAnyParams: () => false,
			reset: () => {},
			isComplete: () => true,
		};
	}

	const section = container.createEl('div', { cls: 'crosswalker-param-editor' });
	section.createEl('h4', { text: 'Parameters' });

	const setParams = params.filter((p) => p.type === 'import-set');
	const isComplete = (): boolean =>
		ctx.pending === 0 &&
		setParams.every((p) => typeof values[p.name] === 'string' && (values[p.name] as string).length > 0);
	const app = options.app;
	const ctx: ImportSetContext = {
		pending: 0,
		load: options.loadChoices ?? ((kind) => (app ? loadImportSetChoices(app, kind) : Promise.resolve(unavailableChoices()))),
		defaults: {},
		notify: () => options.onValidityChange?.(isComplete()),
	};

	for (const p of params) {
		if (p.type === 'import-set') {
			renderImportSetRow(section, p, values, ctx);
		} else {
			renderParamRow(section, p, values);
		}
	}

	return {
		getValues: () => ({ ...values }),
		hasAnyParams: () => params.length > 0,
		reset: () => {
			for (const p of params) {
				if (p.type === 'import-set') {
					const preselect = ctx.defaults[p.name];
					if (preselect) values[p.name] = preselect;
					else delete values[p.name];
				} else {
					values[p.name] = p.defaultValue ?? defaultForType(p.type);
				}
			}
			ctx.notify();
		},
		isComplete,
	};
}

/** No app to read the vault with: nothing can be offered, so nothing is complete. */
function unavailableChoices(): ImportSetChoices {
	return { state: 'ready', options: [], preselect: null };
}

/**
 * One dropdown of the vault's frameworks or mapping sets. The list loads
 * asynchronously; until it settles the row says it is looking, and the editor
 * reports itself incomplete. An indexing vault is said to be indexing, never
 * empty. A value seeded from a saved query is kept only if that set still exists.
 */
function renderImportSetRow(
	container: HTMLElement,
	param: RecipeParam,
	values: Record<string, unknown>,
	ctx: ImportSetContext,
): void {
	const kind: ImportSetKind = param.kind ?? 'framework';
	const setting = new Setting(container).setName(importSetParamLabel(kind));
	setting.setDesc(kind === 'mapping' ? 'Looking for imported mapping sets.' : 'Looking for imported frameworks.');

	const wanted = values[param.name];
	delete values[param.name];
	ctx.pending += 1;

	const settle = (choices: ImportSetChoices): void => {
		ctx.pending -= 1;
		if (choices.state === 'indexing') {
			setting.setDesc(choices.message);
			ctx.notify();
			return;
		}
		if (choices.options.length === 0) {
			setting.setDesc(noImportSetMessage(kind));
			ctx.notify();
			return;
		}
		const initial =
			typeof wanted === 'string' && choices.options.some((o) => o.id === wanted) ? wanted : choices.preselect;
		ctx.defaults[param.name] = choices.preselect;
		if (initial) values[param.name] = initial;
		setting.setDesc(param.description || '');
		setting.addDropdown((d) => {
			if (!initial) d.addOption('', kind === 'mapping' ? 'Choose a mapping set' : 'Choose a framework');
			for (const o of choices.options) d.addOption(o.id, o.label);
			d.setValue(initial ?? '');
			d.onChange((v: string) => {
				if (v) values[param.name] = v;
				else delete values[param.name];
				ctx.notify();
			});
		});
		ctx.notify();
	};

	ctx.load(kind).then(settle, () => {
		ctx.pending -= 1;
		setting.setDesc(
			kind === 'mapping'
				? 'Could not list your mapping sets. Close this window and try again.'
				: 'Could not list your frameworks. Close this window and try again.',
		);
		ctx.notify();
	});
}

function renderParamRow(
	container: HTMLElement,
	param: RecipeParam,
	values: Record<string, unknown>,
): void {
	const setting = new Setting(container).setName(humanLabel(param.name));
	if (param.description) {
		setting.setDesc(param.description);
	}

	switch (param.type) {
		case 'boolean':
			setting.addToggle((t) =>
				t
					.setValue(Boolean(values[param.name]))
					.onChange((v: boolean) => {
						values[param.name] = v;
					}),
			);
			break;

		case 'number':
			setting.addText((t) => {
				t.inputEl.type = 'number';
				const cur = values[param.name];
				t.setValue(cur === undefined || cur === null ? '' : String(cur));
				// Choose a step that respects the default's precision.
				// Integers → step=1; decimals → step=0.05 (good enough for
				// confidence thresholds, depth limits, percentile cutoffs).
				const defaultVal = param.defaultValue;
				if (typeof defaultVal === 'number' && Number.isInteger(defaultVal)) {
					t.inputEl.step = '1';
				} else {
					t.inputEl.step = '0.05';
				}
				t.onChange((raw: string) => {
					const parsed = Number(raw);
					if (Number.isFinite(parsed)) {
						values[param.name] = parsed;
					} else if (raw === '') {
						values[param.name] = param.defaultValue ?? 0;
					}
				});
			});
			break;

		case 'string':
		default:
			setting.addText((t) => {
				const cur = values[param.name];
				t.setValue(cur === undefined || cur === null ? '' : String(cur));
				t.onChange((raw: string) => {
					values[param.name] = raw;
				});
			});
			break;
	}
}

/**
 * Best-effort transformation of a `snake_case_param` name into a human
 * label for the Setting.setName slot.
 */
export function humanLabel(name: string): string {
	if (!name) return '';
	return name
		.replace(/_/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function defaultForType(type: RecipeParamType): unknown {
	switch (type) {
		case 'number':
			return 0;
		case 'boolean':
			return false;
		case 'string':
		default:
			return '';
	}
}
