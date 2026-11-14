import { browser } from '@wdio/globals';

/** Test-only probe. Observe the real modal/flow without changing product decisions. */
export async function installWizardObservation(): Promise<void> {
	await browser.executeObsidian(({ obsidian }) => {
		const host = window as any;
		if (host.__cwObservation) throw new Error('Previous wizard observation was not stopped');
		const events: any[] = [];
		const record = (kind: string, value: unknown) => {
			if (events.length >= 512) throw new Error('Wizard observation exceeded its bounded event budget');
			events.push({ at: performance.now(), kind, value });
		};
		const originalOpen = obsidian.Modal.prototype.open;
		const probe: any = { events, flow: null, record };
		obsidian.Modal.prototype.open = function () {
			const result = originalOpen.call(this);
			const flow = (this as any).flow;
			if (flow) {
				obsidian.Modal.prototype.open = originalOpen;
				probe.flow = flow;
				const originalGenerate = flow.generate;
				const originalDoGenerate = flow.doGenerate;
				flow.doGenerate = function (...args: unknown[]) {
					record('generation-write-phase-entry', null);
					return originalDoGenerate.apply(this, args);
				};
				flow.generate = async function (...args: unknown[]) {
					record('generate-entry', { step: this.currentStep, parsed: !!this.parsedData });
					try { return await originalGenerate.apply(this, args); }
					catch (error) { record('generate-exception', String(error)); throw error; }
					finally { record('generate-return', { step: this.currentStep, generating: this.isGenerating, discoveryError: this.setDiscoveryError, planningProblem: this.identityPlanningProblem }); }
				};
				probe.restoreGenerate = () => { flow.generate = originalGenerate; flow.doGenerate = originalDoGenerate; };
			}
			return result;
		};
		const noticeText = new WeakMap<Element, string>();
		const notices = () => document.querySelectorAll('.notice').forEach(el => {
			const text = el.textContent ?? '';
			if (noticeText.get(el) !== text) { noticeText.set(el, text); record('notice', text); }
		});
		const observer = new MutationObserver(notices);
		observer.observe(document.body, { subtree: true, childList: true, characterData: true });
		notices();
		const onError = (event: ErrorEvent) => record('window-error', event.message);
		const onRejection = (event: PromiseRejectionEvent) => record('unhandled-rejection', String(event.reason));
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onRejection);
		probe.stop = () => {
			obsidian.Modal.prototype.open = originalOpen;
			probe.restoreGenerate?.(); observer.disconnect();
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
			delete host.__cwObservation;
		};
		host.__cwObservation = probe;
	});
}

export async function readWizardObservation(): Promise<any> {
	return browser.executeObsidian(() => {
		const probe = (window as any).__cwObservation;
		if (!probe?.flow) throw new Error('Observation did not capture the actual import flow');
		const flow = probe.flow;
		const root = document.querySelector('.crosswalker-wizard-modal');
		const dropdown = root?.querySelector<HTMLSelectElement>('.crosswalker-import-set-review select');
		return {
			events: probe.events,
			state: { step: flow.currentStep, choice: flow.importSetChoice, runAgain: flow.runAgain?.importSetId ?? null, runAgainOverridden: flow.runAgainSetOverridden, discoveredCount: flow.discoveredSets?.length ?? null, discoveredIds: flow.discoveredSets?.map((set: any) => set.id) ?? null, discoveryError: flow.setDiscoveryError, planningProblem: flow.identityPlanningProblem, generating: flow.isGenerating },
			dropdown: dropdown ? { value: dropdown.value, options: Array.from(dropdown.options, o => o.value) } : null,
			warnings: Array.from(root?.querySelectorAll('.crosswalker-warning') ?? [], el => el.textContent),
			buttons: Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-nav-right button, .crosswalker-wizard-footer button') ?? [], b => ({ text: b.textContent, disabled: b.disabled, title: b.title })),
			text: root?.textContent ?? '',
			result: root?.querySelector('.crosswalker-results-summary')?.textContent ?? '',
		};
	});
}

export async function stopWizardObservation(): Promise<void> {
	await browser.executeObsidian(() => { (window as any).__cwObservation?.stop(); });
}
