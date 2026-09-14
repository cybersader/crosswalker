/**
 * import-wizard-escape.test.ts — Escape in the wizard MODAL host, tested at the
 * dispatch seam that actually broke.
 *
 * The defect: `ImportWizardModal` registered its Escape binding in a child
 * `Scope` and returned `undefined` when the workbench had nothing transient to
 * close, expecting Obsidian to fall through to `Modal`'s own Escape-to-close
 * binding. Obsidian's `Scope.handleKey` does not work that way. It stops at the
 * FIRST binding whose key matches, whatever that binding returned, and consults
 * the parent scope only when nothing matched:
 *
 *     for (binding of this.keys) if (isMatch(e)) {
 *       o = binding.func(e, t);
 *       if (o !== undefined) return o;
 *       if (binding.key !== null || binding.modifiers !== null) return o;
 *     }
 *     if (this.parent) return this.parent.handleKey(e, t);
 *
 * So the wizard modal swallowed Escape on every step and never closed; only the
 * native x button worked. The `Scope` installed below reproduces that dispatch
 * algorithm (read from the Obsidian 1.12.7 and 1.13.7 bundles, identical in
 * both), eliding only modifier matching, since one unmodified binding is all
 * that is in play here. A permissive mock would pass against the very bug this
 * suite exists for. The
 * `Modal` below likewise carries the parent-scope Escape-to-close binding real
 * Obsidian gives every modal, so these assertions prove the close happens once
 * and not by parent fallthrough.
 */

jest.mock('obsidian', () => {
	const actual = jest.requireActual('obsidian');

	type KeyHandler = (evt: KeyboardEvent, ctx: unknown) => boolean | void;

	class MockScope {
		parent?: MockScope;
		keys: Array<{ modifiers: string[] | null; key: string | null; func: KeyHandler }> = [];

		constructor(parent?: MockScope) {
			this.parent = parent;
		}

		register(modifiers: string[] | null, key: string | null, func: KeyHandler) {
			const binding = { modifiers, key, func };
			this.keys.push(binding);
			return binding;
		}

		handleKey(evt: KeyboardEvent, ctx: unknown): boolean | void {
			for (const binding of this.keys) {
				if (binding.key !== null && binding.key !== evt.key) continue;
				const outcome = binding.func(evt, ctx);
				if (outcome !== undefined) return outcome;
				if (binding.key !== null || binding.modifiers !== null) return outcome;
			}
			if (this.parent) return this.parent.handleKey(evt, ctx);
			return undefined;
		}
	}

	class MockModal extends actual.Modal {
		scope: MockScope;
		constructor(app: unknown) {
			super(app);
			// What real Obsidian installs on every Modal: Escape closes it.
			this.scope = new MockScope();
			this.scope.register([], 'Escape', () => {
				this.close();
				return false;
			});
		}
	}

	return { ...actual, Modal: MockModal, Scope: MockScope };
});

import { ImportWizardModal } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';

type ModalApp = ConstructorParameters<typeof ImportWizardModal>[0];
type ModalPlugin = ConstructorParameters<typeof ImportWizardModal>[1];

interface ScopeShape {
	parent?: ScopeShape;
	keys: Array<{ func: (evt: KeyboardEvent, ctx: unknown) => boolean | void }>;
	handleKey(evt: KeyboardEvent, ctx: unknown): boolean | void;
}

/** The flow state `closeWorkbenchTransient` reads, reachable without a DOM. */
interface FlowState {
	currentStep: number;
	workbench: { closeTransientUi(): boolean } | null;
}

interface ModalInternals {
	scope: ScopeShape;
	close: jest.Mock;
	flow: FlowState;
}

function makeModal(): ModalInternals {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as ModalPlugin;
	const modal = new ImportWizardModal({} as unknown as ModalApp, plugin);
	return modal as unknown as ModalInternals;
}

/** A real Escape keypress, dispatched the way Obsidian's keymap dispatches it. */
function pressEscape(modal: ModalInternals): boolean | void {
	return modal.scope.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }), null);
}

/** Step 2 with a transient surface (evidence card, column chooser) showing. */
function openTransientUi(modal: ModalInternals, consumes: boolean): jest.Mock {
	const closeTransientUi = jest.fn().mockReturnValue(consumes);
	modal.flow.currentStep = 2;
	modal.flow.workbench = { closeTransientUi };
	return closeTransientUi;
}

describe('ImportWizardModal Escape handling', () => {
	it('closes the modal when the workbench has nothing transient open', () => {
		const modal = makeModal();

		const outcome = pressEscape(modal);

		expect(modal.close).toHaveBeenCalledTimes(1);
		// Consumed, so Obsidian does not also hand Escape to anything upstream.
		expect(outcome).toBe(false);
	});

	it('closes the modal on a non-workbench step even with a workbench built', () => {
		const modal = makeModal();
		openTransientUi(modal, true);
		modal.flow.currentStep = 4;

		pressEscape(modal);

		expect(modal.close).toHaveBeenCalledTimes(1);
	});

	it('closes the modal on Step 2 when no transient surface consumed Escape', () => {
		const modal = makeModal();
		const closeTransientUi = openTransientUi(modal, false);

		pressEscape(modal);

		expect(closeTransientUi).toHaveBeenCalledTimes(1);
		expect(modal.close).toHaveBeenCalledTimes(1);
	});

	it('keeps the modal open when a transient surface consumed Escape', () => {
		const modal = makeModal();
		const closeTransientUi = openTransientUi(modal, true);

		const outcome = pressEscape(modal);

		expect(closeTransientUi).toHaveBeenCalledTimes(1);
		expect(modal.close).not.toHaveBeenCalled();
		expect(outcome).toBe(false);
	});

	it('closes on the next Escape after the transient surface is gone', () => {
		const modal = makeModal();
		const closeTransientUi = openTransientUi(modal, true);
		pressEscape(modal);
		expect(modal.close).not.toHaveBeenCalled();

		closeTransientUi.mockReturnValue(false);
		pressEscape(modal);

		expect(modal.close).toHaveBeenCalledTimes(1);
	});

	it('closes exactly once, not by falling through to the parent scope', () => {
		const modal = makeModal();
		const parent = modal.scope.parent;
		expect(parent).toBeDefined();
		const parentBinding = jest.spyOn(parent!.keys[0], 'func');

		pressEscape(modal);

		// The child binding matched a specific key, so dispatch ends there. If the
		// modal relied on the parent to close it, it would never close at all.
		expect(parentBinding).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalledTimes(1);
	});
});
