import {
	finishWizardWithDriver,
	type WizardFinishDeadlines,
	type WizardFinishDriver,
	type WizardGenerationSnapshot,
} from './e2e/helpers/wizard-generation-outcome';

const deadlines: WizardFinishDeadlines = {
	navigationMs: 5,
	generationMs: 5,
	outputMs: 5,
	pollMs: 1,
};

function snapshot(overrides: Partial<WizardGenerationSnapshot> = {}): WizardGenerationSnapshot {
	return {
		modalPresent: true,
		step: 2,
		summary: '',
		errors: [],
		conflicts: [],
		errorCount: 0,
		conflictCount: 0,
		createdFiles: [],
		notices: [],
		...overrides,
	};
}

function driver(
	onGenerate: (state: WizardGenerationSnapshot) => void,
	onSleep?: (state: WizardGenerationSnapshot, now: number) => void,
): { driver: WizardFinishDriver; state: WizardGenerationSnapshot; next: jest.Mock; generate: jest.Mock } {
	let now = 0;
	const state = snapshot();
	const next = jest.fn(async () => {
		state.step += 1;
		return { ok: true };
	});
	const generate = jest.fn(async () => {
		onGenerate(state);
		return { ok: true };
	});
	return {
		state,
		next,
		generate,
		driver: {
			read: async () => ({ ...state, errors: [...state.errors], conflicts: [...state.conflicts], createdFiles: [...state.createdFiles], notices: [...state.notices] }),
			clickNext: next,
			setOutputPath: async () => ({ ok: true }),
			clickGenerate: generate,
			sleep: async (ms: number) => {
				now += ms;
				onSleep?.(state, now);
			},
			now: () => now,
		},
	};
}

describe('formats E2E wizard terminal outcomes', () => {
	it.each([
		['errors', { errors: ['Unknown field revoked'], errorCount: 1 }],
		['conflicts', { conflicts: ['Out/partial.md was left unchanged'], conflictCount: 1 }],
	])('%s outrank partial created files', async (_label, failure) => {
		const subject = driver((state) => {
			Object.assign(state, failure, {
				summary: 'Created: 1 notes',
				createdFiles: ['partial.md'],
			});
		});

		const result = await finishWizardWithDriver(subject.driver, 'Out', 1, deadlines);

		expect(result.kind).toBe('error');
		expect(result.phase).toBe('generation');
		expect(subject.next).toHaveBeenCalledTimes(2);
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('accepts a clean persistent results screen once owned output becomes visible', async () => {
		const subject = driver(
			(state) => { state.summary = 'Created: 1 notes'; },
			(state, now) => {
				if (now >= 1) state.createdFiles = ['kept.md'];
			},
		);

		const result = await finishWizardWithDriver(subject.driver, 'Out', 1, deadlines);

		expect(result.kind).toBe('success');
		expect(result.last.modalPresent).toBe(true);
		expect(result.last.createdFiles).toEqual(['kept.md']);
		expect(subject.next).toHaveBeenCalledTimes(2);
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('times out with the last phase and never retries Generate', async () => {
		const subject = driver(() => undefined);

		const result = await finishWizardWithDriver(subject.driver, 'Out', 1, deadlines);

		expect(result.kind).toBe('timeout');
		expect(result.phase).toBe('generation');
		expect(result.last.step).toBe(4);
		expect(result.detail).toContain('Timed out waiting for a terminal generation state');
		expect(subject.next).toHaveBeenCalledTimes(2);
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('classifies a fresh known Generation failed notice after the owned click as an error', async () => {
		const subject = driver(
			() => undefined,
			(state, now) => {
				if (now >= 1) state.notices = ['Generation failed: canonical recipe could not render'];
			},
		);

		const result = await finishWizardWithDriver(subject.driver, 'Out', 1, deadlines);

		expect(result.kind).toBe('error');
		expect(result.phase).toBe('generation');
		expect(result.detail).toContain('Generation failed: canonical recipe could not render');
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('ignores a preexisting failure notice and an unrelated fresh plugin notice', async () => {
		const subject = driver((state) => {
			state.summary = 'Created: 1 notes';
			state.createdFiles = ['kept.md'];
			state.notices.push('Another plugin completed with a warning');
		});
		subject.state.notices = ['Generation failed: stale earlier run'];

		const result = await finishWizardWithDriver(subject.driver, 'Out', 1, deadlines);

		expect(result.kind).toBe('success');
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('never treats modal closure with zero files as success even when zero files were expected', async () => {
		const subject = driver((state) => { state.modalPresent = false; });

		const result = await finishWizardWithDriver(subject.driver, 'Out', 0, deadlines);

		expect(result.kind).not.toBe('success');
		expect(result.last.createdFiles).toEqual([]);
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});

	it('never treats a clean Created: 0 results screen as success', async () => {
		const subject = driver((state) => { state.summary = 'Created: 0 notes'; });

		const result = await finishWizardWithDriver(subject.driver, 'Out', 0, deadlines);

		expect(result.kind).toBe('error');
		expect(result.detail).toContain('zero created notes');
		expect(subject.generate).toHaveBeenCalledTimes(1);
	});
});
