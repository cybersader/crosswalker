export interface WizardGenerationSnapshot {
	modalPresent: boolean;
	step: number;
	summary: string;
	errors: string[];
	conflicts: string[];
	errorCount: number;
	conflictCount: number;
	createdFiles: string[];
	notices: string[];
}

export type WizardFinishPhase =
	| 'navigate-to-preview'
	| 'navigate-to-generate'
	| 'set-output'
	| 'generation'
	| 'output';

export interface WizardFinishOutcome {
	kind: 'success' | 'error' | 'timeout';
	phase: WizardFinishPhase;
	detail: string;
	last: WizardGenerationSnapshot;
	nextClicks: number;
	generateClicks: number;
}

export interface WizardFinishDriver {
	read(): Promise<WizardGenerationSnapshot>;
	clickNext(): Promise<{ ok: boolean; detail?: string }>;
	setOutputPath(path: string): Promise<{ ok: boolean; detail?: string }>;
	clickGenerate(): Promise<{ ok: boolean; detail?: string }>;
	sleep(ms: number): Promise<void>;
	now(): number;
	onPreview?: () => Promise<void>;
}

export interface WizardFinishDeadlines {
	navigationMs: number;
	generationMs: number;
	outputMs: number;
	pollMs: number;
}

export const DEFAULT_WIZARD_FINISH_DEADLINES: WizardFinishDeadlines = {
	navigationMs: 15_000,
	generationMs: 30_000,
	outputMs: 10_000,
	pollMs: 100,
};

function hasFailure(snapshot: WizardGenerationSnapshot): boolean {
	return snapshot.errorCount > 0
		|| snapshot.conflictCount > 0
		|| snapshot.errors.length > 0
		|| snapshot.conflicts.length > 0;
}

function createdInSummary(summary: string): number | null {
	const match = /Created:\s*(\d+)/i.exec(summary);
	return match ? Number(match[1]) : null;
}

function freshGenerationFailureNotice(
	snapshot: WizardGenerationSnapshot,
	baselineNotices: readonly string[],
): string | undefined {
	const remainingBaseline = new Map<string, number>();
	for (const notice of baselineNotices) {
		remainingBaseline.set(notice, (remainingBaseline.get(notice) ?? 0) + 1);
	}

	for (const notice of snapshot.notices) {
		const baselineCount = remainingBaseline.get(notice) ?? 0;
		if (baselineCount > 0) {
			remainingBaseline.set(notice, baselineCount - 1);
			continue;
		}
		if (notice.includes('Generation failed:')) return notice;
	}
	return undefined;
}

function describe(snapshot: WizardGenerationSnapshot): string {
	const parts = [
		`step=${snapshot.step}`,
		`modal=${snapshot.modalPresent ? 'open' : 'closed'}`,
		`files=${snapshot.createdFiles.length}`,
	];
	if (snapshot.summary) parts.push(`summary=${snapshot.summary}`);
	if (snapshot.errors.length > 0) parts.push(`errors=${snapshot.errors.join(' | ')}`);
	if (snapshot.conflicts.length > 0) parts.push(`conflicts=${snapshot.conflicts.join(' | ')}`);
	if (snapshot.notices.length > 0) parts.push(`notices=${snapshot.notices.join(' | ')}`);
	return parts.join('; ');
}

function outcome(
	kind: WizardFinishOutcome['kind'],
	phase: WizardFinishPhase,
	detail: string,
	last: WizardGenerationSnapshot,
	nextClicks: number,
	generateClicks: number,
): WizardFinishOutcome {
	return { kind, phase, detail, last, nextClicks, generateClicks };
}

async function waitForStep(
	driver: WizardFinishDriver,
	target: number,
	phase: 'navigate-to-preview' | 'navigate-to-generate',
	deadlines: WizardFinishDeadlines,
	clicks: { next: number; generate: number },
): Promise<WizardGenerationSnapshot | WizardFinishOutcome> {
	const clicked = await driver.clickNext();
	clicks.next += 1;
	let last = await driver.read();
	if (!clicked.ok) {
		return outcome('error', phase, clicked.detail ?? 'Next button was unavailable.', last, clicks.next, clicks.generate);
	}
	const deadline = driver.now() + deadlines.navigationMs;
	for (;;) {
		if (hasFailure(last)) {
			return outcome('error', phase, describe(last), last, clicks.next, clicks.generate);
		}
		if (last.step >= target) return last;
		if (!last.modalPresent || last.summary) {
			return outcome('error', phase, `Wizard became terminal before step ${target}. ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		if (driver.now() >= deadline) {
			return outcome('timeout', phase, `Timed out waiting for step ${target}. ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		await driver.sleep(deadlines.pollMs);
		last = await driver.read();
	}
}

/**
 * Drive only the Step-2-to-terminal portion of the formats E2E wizard.
 * Every browser action is delegated exactly once; all waits run on the host.
 */
export async function finishWizardWithDriver(
	driver: WizardFinishDriver,
	outputPath: string,
	expectedFileCount: number,
	deadlines: WizardFinishDeadlines = DEFAULT_WIZARD_FINISH_DEADLINES,
): Promise<WizardFinishOutcome> {
	const clicks = { next: 0, generate: 0 };
	let reached = await waitForStep(driver, 3, 'navigate-to-preview', deadlines, clicks);
	if ('kind' in reached) return reached;
	if (driver.onPreview) await driver.onPreview();

	reached = await waitForStep(driver, 4, 'navigate-to-generate', deadlines, clicks);
	if ('kind' in reached) return reached;

	const pathSet = await driver.setOutputPath(outputPath);
	let last = await driver.read();
	if (!pathSet.ok) {
		return outcome('error', 'set-output', pathSet.detail ?? 'Output path input was unavailable.', last, clicks.next, clicks.generate);
	}

	const baselineNotices = [...last.notices];
	const generated = await driver.clickGenerate();
	clicks.generate += 1;
	last = await driver.read();
	if (!generated.ok) {
		return outcome('error', 'generation', generated.detail ?? 'Generate button was unavailable.', last, clicks.next, clicks.generate);
	}

	const generationDeadline = driver.now() + deadlines.generationMs;
	for (;;) {
		if (hasFailure(last)) {
			return outcome('error', 'generation', describe(last), last, clicks.next, clicks.generate);
		}
		const failureNotice = freshGenerationFailureNotice(last, baselineNotices);
		if (failureNotice) {
			return outcome('error', 'generation', `Fresh generation failure notice: ${failureNotice}. ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		if (last.summary || !last.modalPresent) break;
		if (driver.now() >= generationDeadline) {
			return outcome('timeout', 'generation', `Timed out waiting for a terminal generation state. ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		await driver.sleep(deadlines.pollMs);
		last = await driver.read();
	}

	const summaryCount = createdInSummary(last.summary);
	if (summaryCount === 0) {
		return outcome('error', 'generation', `Generation reported zero created notes. ${describe(last)}`, last, clicks.next, clicks.generate);
	}

	const outputDeadline = driver.now() + deadlines.outputMs;
	for (;;) {
		if (hasFailure(last)) {
			return outcome('error', 'output', describe(last), last, clicks.next, clicks.generate);
		}
		const failureNotice = freshGenerationFailureNotice(last, baselineNotices);
		if (failureNotice) {
			return outcome('error', 'output', `Fresh generation failure notice: ${failureNotice}. ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		if (expectedFileCount > 0 && last.createdFiles.length >= expectedFileCount) {
			return outcome('success', 'output', describe(last), last, clicks.next, clicks.generate);
		}
		if (driver.now() >= outputDeadline) {
			return outcome('timeout', 'output', `Terminal state did not expose ${expectedFileCount} expected output file(s). ${describe(last)}`, last, clicks.next, clicks.generate);
		}
		await driver.sleep(deadlines.pollMs);
		last = await driver.read();
	}
}
