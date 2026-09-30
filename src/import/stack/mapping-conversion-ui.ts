/**
 * mapping-conversion-ui.ts — the screens around a mapping set conversion.
 *
 * Slice 4 of the mapping table form (2026-09-30), Part B. The job itself lives
 * in `src/mappings/mapping-conversion.ts`; this module only asks, shows
 * progress, and reports. Three entry points share it so their copy cannot
 * drift: the Convert, Finish and Cancel buttons on an installed stack's mapping
 * row, the startup notice for an interrupted job, and the "finish interrupted
 * mapping conversions" command.
 *
 * Failure modes prevented: a user converting to a table without being told, at
 * the decision point, that the mappings leave Bases views, graph view and
 * backlinks and that the notes go to the trash; an interrupted conversion that
 * nothing ever offers to finish; two runs of the same job racing each other in
 * one session.
 */
import { App, Modal, Notice, Setting } from 'obsidian';
import type CrosswalkerPlugin from '../../main';
import { plural } from '../../utils/plural';
import type { DiscoveredImportSet, MappingForm } from '../../generation/import-set';
import {
	cancelConversion,
	resumeConversion,
	startConversion,
	type ConversionDeps,
	type ConversionProgress,
	type ConversionResult,
} from '../../mappings/mapping-conversion';
import { readConversionReadState, type ConversionMarker, type ConversionPhase } from '../../mappings/conversion-marker';
import { MAPPING_TABLE_TRADE_OFF } from '../mapping-form-choice';
import { MAPPING_PRESETS } from '../recipe-registry';
import { mappingKey } from './stack-persistence';

/** The form a set converts to: always the other one. */
export function conversionTargetOf(set: Pick<DiscoveredImportSet, 'mapping_form'>): MappingForm {
	return set.mapping_form === 'table' ? 'notes' : 'table';
}

export function convertButtonLabel(to: MappingForm): string {
	return to === 'table' ? 'Convert to table' : 'Convert to notes';
}

const PHASE_LABELS: Record<ConversionPhase, string> = {
	writing: 'writing',
	verifying: 'verifying',
	retiring: 'moving the old form to the trash',
};

/** The row text while a marker exists, e.g. "Converting to table (writing)". */
export function conversionStateText(converting: { to: MappingForm; phase: ConversionPhase }): string {
	return `Converting to ${converting.to} (${PHASE_LABELS[converting.phase]})`;
}

/** Cancel is offered only before the source starts going to the trash. */
export function conversionCanCancel(phase: ConversionPhase): boolean {
	return phase !== 'retiring';
}

/**
 * Where a conversion to notes writes. An empty root is the vault root; a null
 * root means the set's files do not share one folder, which the job refuses.
 */
function notesDestinationText(set: Pick<DiscoveredImportSet, 'rowCount' | 'root'>): string {
	if (set.root === null) {
		return `Writes ${plural(set.rowCount, 'note')}. Crosswalker could not tell which folder they belong in, so the conversion will refuse until the set's files share one folder.`;
	}
	return `Writes ${plural(set.rowCount, 'note')} in ${set.root ? set.root : 'the vault root'}.`;
}

/**
 * The confirmation lines for converting `set` to `to`. To a table: the slice 3
 * trade-off line, then what goes to the trash. To notes: how many notes are
 * written where, then what goes to the trash.
 */
export function conversionConfirmLines(set: Pick<DiscoveredImportSet, 'noteCount' | 'rowCount' | 'root'>, to: MappingForm): string[] {
	if (to === 'table') {
		return [
			MAPPING_TABLE_TRADE_OFF,
			`Moves ${plural(set.noteCount, 'note')} to the trash after the table is verified.`,
		];
	}
	return [
		notesDestinationText(set),
		'Moves the mapping table to the trash after the notes are verified.',
	];
}

/**
 * Whether to ask before starting. Converting to a table always asks: it moves
 * notes to the trash and takes the mappings out of Bases views. Converting to
 * notes asks only above the stack file confirmation threshold (0 = always),
 * the same rule the stack import uses for the files it writes. A set whose
 * files do not share one folder is never asked about: the job refuses it
 * before writing anything, and that refusal says what to do.
 */
export function conversionNeedsConfirmation(set: Pick<DiscoveredImportSet, 'rowCount'> & { root?: string | null }, to: MappingForm, threshold: number): boolean {
	if (set.root === null) return false;
	if (to === 'table') return true;
	return threshold === 0 || set.rowCount > threshold;
}

export function conversionProgressText(progress: Pick<ConversionProgress, 'phase' | 'done' | 'total'>): string {
	const phase = progress.phase === 'writing' ? 'Writing' : progress.phase === 'verifying' ? 'Verifying' : 'Moving the old form to the trash';
	return progress.total > 0 ? `${phase}: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : `${phase}...`;
}

/** The short result line posted when a job finishes or stops. */
export function conversionResultText(result: ConversionResult, label: string): string {
	if (!result.ok) return result.reason ?? `Converting ${label} stopped. Finish the conversion from the installed stacks panel.`;
	const form = result.to === 'table' ? 'a table' : 'notes';
	const reviews = result.reviewsCarried ? ` ${plural(result.reviewsCarried, 'review')} carried over.` : '';
	const trashed = result.trashed ? ` ${plural(result.trashed, 'old file')} moved to the trash.` : '';
	return `Converted ${label} to ${form}: ${plural(result.rows, 'mapping')}.${reviews}${trashed}${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`;
}

/** A human name for a set: its stack mapping label when a stack recorded it. */
export function conversionSetLabel(plugin: Pick<CrosswalkerPlugin, 'settings'>, setId: string): string {
	for (const stack of plugin.settings.stacks ?? []) {
		const run = plugin.settings.stackRuns?.find((entry) => entry.stackId === stack.id);
		if (!run) continue;
		for (const slot of stack.mappings) {
			if (slot.kind === 'from-slot') continue;
			if (run.mappingSets[mappingKey({ ...slot, id: slot.presetId })]?.importSetId !== setId) continue;
			const label = MAPPING_PRESETS.find((entry) => entry.id === slot.presetId)?.label;
			if (label) return `${label} (set ${setId})`;
		}
	}
	return `import set ${setId}`;
}

/**
 * A job that threw instead of returning a result. The thrown text is written
 * for developers, so the user gets a stopped result that names the cause and
 * what to do; the raw error goes to the debug log only.
 */
export function conversionErrorResult(setId: string, from: MappingForm | null, to: MappingForm, label: string): ConversionResult {
	return {
		ok: false, setId, from, to, rows: 0, reviewsCarried: 0, targetPath: null, trashed: 0, phaseReached: 'not-started', warnings: [],
		reason: `Converting ${label} to ${to === 'table' ? 'a table' : 'notes'} stopped on an unexpected error, most often a file that could not be written or moved. `
			+ 'No mappings were lost: the old form goes to the trash only after the new one is verified. '
			+ 'Check that the vault folder is writable and no file in it is open in another program, then convert again or finish the conversion from the installed stacks panel.',
	};
}

/** Why Cancel did not work, without the raw error text. */
export function cancelFailureText(label: string, to: MappingForm): string {
	return `Could not cancel converting ${label}: moving what was written for the ${to} form to the trash failed, most often because a file is open in another program or the vault folder is not writable. `
		+ 'Close any program using those files, then cancel again, or finish the conversion instead.';
}

/**
 * Run one conversion job and turn a throw into a stopped result, so a caller
 * never loses its notice or leaves a set marked as running.
 */
export async function runConversionJob(
	plugin: Pick<CrosswalkerPlugin, 'debug'>,
	job: () => Promise<ConversionResult>,
	fallback: { setId: string; from: MappingForm | null; to: MappingForm; label: string },
): Promise<ConversionResult> {
	try {
		return await job();
	} catch (error) {
		plugin.debug?.warn('mappings', 'conversion-threw', 'A mapping set conversion threw instead of returning a result', {
			setId: fallback.setId, to: fallback.to, error: error instanceof Error ? error.message : String(error),
		});
		return conversionErrorResult(fallback.setId, fallback.from, fallback.to, fallback.label);
	}
}

export function conversionDeps(plugin: CrosswalkerPlugin): ConversionDeps {
	return { runProjection: plugin.runProjection, precomputeClosure: plugin.precomputeClosure };
}

/**
 * Sets with a job running in this session. The marker stops a second job
 * across sessions; this stops a double click from starting a second run of the
 * same job before the first has written anything.
 */
const running = new Set<string>();

export type ConversionRequest =
	| { kind: 'start'; set: DiscoveredImportSet; to: MappingForm; label: string }
	| { kind: 'resume'; marker: ConversionMarker; label: string };

function requestSetId(request: ConversionRequest): string {
	return request.kind === 'start' ? request.set.id : request.marker.import_set;
}

function requestTarget(request: ConversionRequest): MappingForm {
	return request.kind === 'start' ? request.to : request.marker.to;
}

/**
 * Confirm (when needed), run and report one conversion. The job keeps running
 * if the window is closed; the result is also posted as a notice, so it is
 * never lost with the window.
 */
export class MappingConversionModal extends Modal {
	private finished = false;
	constructor(app: App, private plugin: CrosswalkerPlugin, private request: ConversionRequest, private onDone: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crosswalker-conversion-modal');
		const { request } = this;
		if (request.kind === 'start') {
			const threshold = this.plugin.settings.stackConfirmFileThreshold ?? 1000;
			if (conversionNeedsConfirmation(request.set, request.to, threshold)) {
				this.renderConfirm(request.set, request.to);
				return;
			}
		}
		void this.run();
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing mid-run leaves the job running; the row is refreshed when it ends.
		if (this.finished) this.onDone();
	}

	private renderConfirm(set: DiscoveredImportSet, to: MappingForm): void {
		this.titleEl.setText(to === 'table' ? 'Convert these mappings to a table?' : 'Convert these mappings to notes?');
		this.contentEl.createEl('p', { cls: 'crosswalker-conversion-set', text: this.request.label });
		for (const line of conversionConfirmLines(set, to)) this.contentEl.createEl('p', { text: line });
		this.contentEl.createEl('p', {
			cls: 'crosswalker-stack-muted',
			text: 'Reviews carry over. If the conversion is interrupted, finish it from the installed stacks panel or the command palette.',
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => button.setButtonText(convertButtonLabel(to)).setCta().onClick(() => { void this.run(); }));
	}

	private async run(): Promise<void> {
		const { request } = this;
		const setId = requestSetId(request);
		const to = requestTarget(request);
		this.contentEl.empty();
		this.titleEl.setText(`Converting to ${to}`);
		this.contentEl.createEl('p', { cls: 'crosswalker-conversion-set', text: request.label });
		if (running.has(setId)) {
			this.contentEl.createDiv({ cls: 'crosswalker-stack-warning', text: `${request.label} is already converting. Wait for it to finish, then check the installed stacks panel.` });
			this.finished = true;
			return;
		}
		const progress = this.contentEl.createEl('p', { cls: 'crosswalker-conversion-progress', text: 'Starting...' });
		this.contentEl.createEl('p', { cls: 'crosswalker-stack-muted', text: 'You can close this window. The conversion keeps running.' });
		running.add(setId);
		let result: ConversionResult;
		try {
			const onProgress = (update: ConversionProgress) => { progress.setText(conversionProgressText(update)); };
			const from = request.kind === 'start' ? request.set.mapping_form ?? null : request.marker.from;
			result = await runConversionJob(this.plugin, () => request.kind === 'start'
				? startConversion(this.app, conversionDeps(this.plugin), setId, request.to, onProgress)
				: resumeConversion(this.app, conversionDeps(this.plugin), request.marker, onProgress),
			{ setId, from, to, label: request.label });
		} finally {
			running.delete(setId);
		}
		const text = conversionResultText(result, request.label);
		new Notice(text, result.ok ? 8000 : 0);
		this.finished = true;
		if (!this.contentEl.isConnected) { this.onDone(); return; }
		this.contentEl.empty();
		this.titleEl.setText(result.ok ? 'Conversion finished' : 'Conversion stopped');
		this.contentEl.createEl('p', { cls: 'crosswalker-conversion-set', text: request.label });
		this.contentEl.createDiv({ cls: result.ok ? 'crosswalker-conversion-result' : 'crosswalker-stack-warning', text });
		new Setting(this.contentEl).addButton((button) => button.setButtonText('Done').setCta().onClick(() => this.close()));
	}
}

/** The marker for one set, re-read from the vault. */
async function markerFor(app: App, setId: string): Promise<ConversionMarker | { reason: string }> {
	const state = await readConversionReadState(app);
	const marker = state.markers.find((entry) => entry.import_set === setId);
	if (marker) return marker;
	const unusable = state.unusable.find((entry) => entry.setIds.includes(setId));
	if (unusable) return { reason: unusable.error };
	return { reason: `No conversion is waiting to finish for import set ${setId}. Reopen the installed stacks panel to see its current form.` };
}

/** The Finish button: resume the set's job from its marker. */
export async function finishConversionForSet(app: App, plugin: CrosswalkerPlugin, setId: string, label: string, onDone: () => void): Promise<void> {
	const marker = await markerFor(app, setId);
	if ('reason' in marker) { new Notice(marker.reason, 0); onDone(); return; }
	new MappingConversionModal(app, plugin, { kind: 'resume', marker, label }, onDone).open();
}

/** The Cancel button: trash what was written so far and keep the source. */
export async function cancelConversionForSet(app: App, setId: string, label: string, onDone: () => void, plugin?: Pick<CrosswalkerPlugin, 'debug'>): Promise<void> {
	if (running.has(setId)) {
		new Notice(`${label} is converting right now. Wait for it to finish or stop, then cancel it.`, 8000);
		return;
	}
	const marker = await markerFor(app, setId);
	if ('reason' in marker) { new Notice(marker.reason, 0); onDone(); return; }
	if (!conversionCanCancel(marker.phase)) {
		new Notice(`${label} is past the point where it can be cancelled: the old form is already going to the trash. Finish the conversion instead.`, 0);
		onDone();
		return;
	}
	try {
		await cancelConversion(app, marker);
		new Notice(`Cancelled converting ${label}. The ${marker.from === 'table' ? 'mapping table was' : 'mapping notes were'} left as they were, and anything written for the ${marker.to} form was moved to the trash.`, 8000);
	} catch (error) {
		plugin?.debug?.warn('mappings', 'conversion-cancel-failed', 'Cancelling a mapping set conversion failed', {
			setId, error: error instanceof Error ? error.message : String(error),
		});
		new Notice(cancelFailureText(label, marker.to), 0);
	}
	onDone();
}

/**
 * Startup: one persistent notice per interrupted job, each with a button that
 * finishes it; one notice per marker Crosswalker cannot read. Returns how many
 * notices were posted.
 */
export async function announceInterruptedConversions(app: App, plugin: CrosswalkerPlugin): Promise<number> {
	const state = await readConversionReadState(app);
	for (const marker of state.markers) {
		const label = conversionSetLabel(plugin, marker.import_set);
		const notice = new Notice(createFragment((fragment) => {
			fragment.createDiv({ text: `A mapping set conversion was interrupted. Finish converting ${label}.` });
			const button = fragment.createEl('button', { text: 'Finish converting', cls: 'mod-cta crosswalker-conversion-finish' });
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				notice.hide();
				new MappingConversionModal(app, plugin, { kind: 'resume', marker, label }, () => plugin.refreshInstalledStacksPanels()).open();
			});
		}), 0);
	}
	for (const entry of state.unusable) new Notice(entry.error, 0);
	return state.markers.length + state.unusable.length;
}

/**
 * The command: finish every interrupted job, one at a time, and post a result
 * notice for each.
 */
export async function finishInterruptedConversions(app: App, plugin: CrosswalkerPlugin): Promise<ConversionResult[]> {
	const state = await readConversionReadState(app);
	for (const entry of state.unusable) new Notice(entry.error, 0);
	if (!state.markers.length) {
		if (!state.unusable.length) new Notice('No mapping set conversion is waiting to finish.', 5000);
		return [];
	}
	const results: ConversionResult[] = [];
	for (const marker of state.markers) {
		const label = conversionSetLabel(plugin, marker.import_set);
		if (running.has(marker.import_set)) {
			new Notice(`${label} is already converting. Wait for it to finish.`, 8000);
			continue;
		}
		running.add(marker.import_set);
		new Notice(`Finishing the conversion of ${label}...`, 4000);
		try {
			const result = await runConversionJob(plugin, () => resumeConversion(app, conversionDeps(plugin), marker),
				{ setId: marker.import_set, from: marker.from, to: marker.to, label });
			new Notice(conversionResultText(result, label), result.ok ? 8000 : 0);
			results.push(result);
		} finally {
			running.delete(marker.import_set);
		}
	}
	plugin.refreshInstalledStacksPanels();
	return results;
}
