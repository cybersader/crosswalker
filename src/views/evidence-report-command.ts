/**
 * evidence-report-command.ts — run the evidence-coverage report and open it.
 *
 * The seam between the pure pieces (queries in `src/tier2/evidence-coverage.ts`,
 * rendering in `src/views/evidence-report.ts`) and Obsidian. Everything that
 * touches a vault or a database lives here so the other two stay unit-testable.
 *
 * The report is written to a note rather than shown in a modal because a
 * compliance reader needs to keep it, link to it, and put it in front of
 * somebody else. It is regenerated wholesale each run — see the disposability
 * note in `evidence-report.ts`.
 */

import { App, FuzzySuggestModal, Notice, TFile } from 'obsidian';
// S15: the one composition of a configured folder plus a file name.
import { joinInFolder } from './evidence-link';
import {
	conceptsWithoutValidEvidence,
	diagnoseExcludedJunctions,
	evidenceCoverageByConcept,
	evidenceCoverageSummary,
	listSupersededSubjects,
	listUnbaselinedValidJunctions,
} from '../tier2/evidence-coverage';
import { readProjectionStatus } from '../tier2/projector';
import { readNoteFrontmatterState } from '../export/vault-reader';
import { renderEvidenceReport } from './evidence-report';

/** One ontology the index knows about, as offered in the chooser. */
export interface OntologyChoice {
	id: string;
	name: string;
	conceptCount: number;
}

/**
 * Ontologies present in the index, with their concept counts.
 *
 * Counted from `concepts` rather than read from `ontologies.control_count`,
 * because that column is a stored total that can fall out of step with the rows
 * actually projected. A chooser showing a number that disagrees with the report
 * it produces is worse than one showing no number.
 */
export function listOntologiesForReport(db: any): OntologyChoice[] {
	const rows = db.exec({
		sql: `
			SELECT o.id, o.name, COUNT(c.curie) AS concept_count
			FROM ontologies o
			LEFT JOIN concepts c ON c.ontology_id = o.id
			GROUP BY o.id, o.name
			ORDER BY o.id
		`,
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];

	return rows.map((r) => ({
		id: String(r[0]),
		name: String(r[1] ?? r[0]),
		conceptCount: Number(r[2] ?? 0),
	}));
}

/**
 * Vault path for one ontology's report. Stable, so re-runs replace in place.
 *
 * S15 (2026-09-04). Composed through the SAME `joinInFolder` the junction path
 * uses. This used to compose `${folder}/...` and normalize with the host, which
 * is a second composition rule for the same class of settings value: it and the
 * junction path agreed only because both callers happened to pre-normalize
 * through the accessors first.
 */
export function evidenceReportPath(folder: string, ontologyId: string): string {
	const safe = ontologyId.replace(/[\\/:*?"<>|]/g, '-');
	return joinInFolder(folder, `Evidence coverage - ${safe}.md`);
}

/** Chooser shown only when the vault holds more than one ontology. */
class OntologyPickerModal extends FuzzySuggestModal<OntologyChoice> {
	constructor(
		app: App,
		private readonly choices: OntologyChoice[],
		private readonly onChoose: (choice: OntologyChoice) => void,
	) {
		super(app);
		this.setPlaceholder('Choose a framework to report on');
	}

	getItems(): OntologyChoice[] {
		return this.choices;
	}

	getItemText(choice: OntologyChoice): string {
		const noun = choice.conceptCount === 1 ? 'control' : 'controls';
		return `${choice.name} (${choice.conceptCount} ${noun})`;
	}

	onChooseItem(choice: OntologyChoice): void {
		this.onChoose(choice);
	}
}

/** Everything the runner needs from the plugin, narrowed for testability. */
export interface EvidenceReportDeps {
	app: App;
	openTier2: () => Promise<{ db: any }>;
	/**
	 * Refresh canonical notes into the report data before reading it. Explicit
	 * report actions do this even when background refresh-on-load is disabled.
	 */
	refreshForReport?: () => Promise<{ success: boolean; errors?: unknown[] }>;
	reportFolder: string;
	/** Injected so tests are deterministic. */
	now?: () => Date;
}

/**
 * Build the report for one ontology and write it. Returns the note path.
 *
 * Creates the containing folder when absent: a command that fails because a
 * conventional folder does not exist yet is a command nobody runs twice.
 */
export async function writeEvidenceReport(
	deps: EvidenceReportDeps,
	ontologyId: string,
): Promise<string> {
	const { db } = await deps.openTier2();
	const now = deps.now ?? (() => new Date());

	// Diagnosed once and passed to both readers. The superseded section is
	// derived from these exact rows rather than from a query of its own, so its
	// counts cannot describe a different population than the exclusions table
	// printed a few lines below it.
	const excluded = diagnoseExcludedJunctions(db);

	const markdown = renderEvidenceReport({
		ontologyId,
		summary: evidenceCoverageSummary(db, ontologyId),
		rows: evidenceCoverageByConcept(db, ontologyId),
		excluded,
		unbaselined: listUnbaselinedValidJunctions(db),
		superseded: listSupersededSubjects(db, excluded),
		status: readProjectionStatus(db),
		generatedAt: now().toISOString(),
	});

	const path = evidenceReportPath(deps.reportFolder, ontologyId);
	// S11 (2026-09-04). The separator is LOCATED before it is sliced at: the vault
	// root is now a folder a person can choose, so this path can be
	// `Evidence coverage - x.md` with no separator, and `slice(0, -1)` on that
	// yields a truthy truncated file name that would be created as a folder.
	const sep = path.lastIndexOf('/');
	const folder = sep === -1 ? '' : path.slice(0, sep);
	if (folder && !deps.app.vault.getAbstractFileByPath(folder)) {
		await deps.app.vault.createFolder(folder);
	}

	const existing = deps.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		// AM-17 sweep (2026-08-31). The report is regenerated wholesale, so this
		// `modify` replaces the file's entire contents. `reportFolder` is a user
		// setting and the filename is derived from an ontology id, so a note of the
		// user's own can legitimately sit here - and it was being destroyed with no
		// warning, the same failure the evidence-link window carried.
		//
		// A report has no curie, so the identity it is checked against is the marker
		// it stamps on itself. Only a note that says it is a generated report may be
		// overwritten by one.
		//
		// AM-26 (2026-08-31). Read in THREE states, not two. The two-state read
		// answered null both for a stranger's plain note and for a report of ours
		// whose YAML a user had damaged, and the caller then told the second one "a
		// note that Crosswalker did not generate sits here. Move or rename that
		// note." - AM-19's exact false cause plus its banned instruction, at a site
		// added by the same pass that wrote AM-19. Absence of a fact is never a fact.
		const read = await readNoteFrontmatterState(deps.app, existing);
		if (read.state === 'unreadable') {
			throw new Error(
				`Crosswalker could not read the properties of ${path}, so it could not tell whether that note is a report it generated. `
				+ "Nothing was written. Fix that note's properties block, then run the report again.",
			);
		}
		if (read.state !== 'ok' || read.frontmatter.crosswalker_generated !== true) {
			throw new Error(
				`a note that Crosswalker did not generate already sits at ${path}. `
				+ 'Nothing was written. Move or rename that note, or change the report folder in settings.',
			);
		}
		await deps.app.vault.modify(existing, markdown);
	} else {
		await deps.app.vault.create(path, markdown);
	}
	return path;
}

/**
 * Command entry point: choose an ontology if needed, generate, open.
 *
 * Every failure surfaces as a Notice naming what to do next. The report is the
 * one surface where a silent no-op is most costly, because "no report appeared"
 * and "you have no gaps" are easy to confuse.
 */
export async function runEvidenceReportCommand(deps: EvidenceReportDeps): Promise<void> {
	if (deps.refreshForReport) {
		try {
			const refreshed = await deps.refreshForReport();
			if (!refreshed.success) {
				const count = refreshed.errors?.length ?? 0;
				new Notice(`Could not refresh the coverage data${count > 0 ? ` (${count} errors)` : ''}. Check the troubleshooting log and try again.`);
				return;
			}
		} catch (err) {
			new Notice(`Could not refresh the coverage data: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
	}

	let db: any;
	try {
		({ db } = await deps.openTier2());
	} catch (err) {
		new Notice(`Could not open the coverage data: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const choices = listOntologiesForReport(db);
	if (choices.length === 0) {
		new Notice('No imported frameworks found. Import structured data first, then run this report.');
		return;
	}

	const generate = async (choice: OntologyChoice): Promise<void> => {
		try {
			const path = await writeEvidenceReport(deps, choice.id);
			const file = deps.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await deps.app.workspace.getLeaf(true).openFile(file);
			new Notice(`Evidence coverage report written to ${path}`);
		} catch (err) {
			new Notice(`Could not write the report: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	if (choices.length === 1) {
		await generate(choices[0]);
		return;
	}
	new OntologyPickerModal(deps.app, choices, (choice) => { void generate(choice); }).open();
}
