/**
 * destination-default.test.ts — where an import lands, tested at the CALL SITE.
 *
 * The defect this suite exists for: `renderDestinationBlock` guarded the
 * per-import root rule (owner, 2026-07-11) with `if (!this.outputPath.trim())`,
 * while the constructor had already seeded `outputPath` from
 * `settings.defaultOutputPath` — which ships as `'Ontologies'`, non-empty. The
 * guard could never fire, so `deriveDestinationDefault` never ran once and every
 * import flattened into the shared root. The second unrelated import then looked
 * like a refresh of the first.
 *
 * `deriveDestinationDefault` itself was correct the whole time and is unit-tested
 * in mapping-review.test.ts. That is exactly why re-testing the helper is
 * worthless here: a green helper test sat next to a caller that never called it.
 * Everything below asserts the DECISION — what the flow answers when asked where
 * this import lands — not the arithmetic of the helper.
 *
 * The flow's DOM is not mountable under the obsidian mock (no `createEl` on
 * HTMLElement), so the two places that record a user's edit (the inline
 * breadcrumb editor and the classic Step-4 text setting) are represented by the
 * state they write. The draft round-trip below exercises a real, non-DOM caller.
 */

import { ImportFlow, recognizedDestination, resolveDestinationDefault } from '../src/import/import-wizard';
import { RECIPE_REGISTRY, type RecipeRegistryEntry } from '../src/import/recipe-registry';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import { DRAFT_SCHEMA_VERSION, type WizardDraft } from '../src/import/draft-store';

type FlowApp = ConstructorParameters<typeof ImportFlow>[0];
type FlowPlugin = ConstructorParameters<typeof ImportFlow>[1];

/** Private state the DOM edit paths write, reachable without mounting them. */
interface FlowInternals {
	currentOutputPath(): string;
	destinationEdited: boolean;
	curatedDestination: string | null;
	hydrateFromDraft(draft: WizardDraft): Promise<void>;
}

const inner = (flow: ImportFlow): FlowInternals => flow as unknown as FlowInternals;

/** Where this flow says the import lands — the single accessor every write
 *  path, preview, tree and ownership check reads. */
const lands = (flow: ImportFlow): string => inner(flow).currentOutputPath();

function makeFlow(opts: { globalRoot?: string; sourceFileName?: string | null } = {}): ImportFlow {
	const plugin = {
		settings: {
			...DEFAULT_SETTINGS,
			defaultOutputPath: opts.globalRoot ?? DEFAULT_SETTINGS.defaultOutputPath,
		},
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as FlowPlugin;
	const app = {} as unknown as FlowApp;
	const flow = new ImportFlow(app, plugin, { containerEl: null as unknown as HTMLElement, close: () => {} });
	if (opts.sourceFileName) {
		flow.sourceFile = { name: opts.sourceFileName } as File;
	}
	return flow;
}

/** The user typed a destination (what both edit paths record). */
function chooseDestination(flow: ImportFlow, typed: string): void {
	inner(flow).destinationEdited = true;
	flow.outputPath = typed;
}

function entry(id: string): RecipeRegistryEntry {
	const e = RECIPE_REGISTRY.find((r) => r.id === id);
	if (!e) throw new Error(`no registry entry for ${id}`);
	return e;
}

function draft(overrides: Partial<WizardDraft>): WizardDraft {
	return {
		schemaVersion: DRAFT_SCHEMA_VERSION,
		id: 'draft_test',
		name: 'Test draft (Step 1)',
		createdAt: '2026-08-28T00:00:00.000Z',
		updatedAt: '2026-08-28T00:00:00.000Z',
		currentStep: 1,
		sourceFile: null,
		sourceType: 'csv',
		selectedSheet: null,
		columnInfos: [],
		columnConfigsDict: {},
		config: {},
		outputPath: '',
		overwriteMode: 'skip',
		frameworkId: '',
		appliedConfigId: null,
		...overrides,
	} as WizardDraft;
}

// ---------------------------------------------------------------------------
// 1. The case that was broken.
// ---------------------------------------------------------------------------

describe('an untouched destination (the defect)', () => {
	it('is the import own root, never the bare settings value', () => {
		const flow = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'attack-techniques.csv' });
		// The whole defect in one assertion: this returned 'Ontologies' before.
		expect(lands(flow)).not.toBe('Ontologies');
		expect(lands(flow)).toBe('Ontologies/attack-techniques');
	});

	it('ships correct out of the box, with nothing configured but a source file', () => {
		const flow = makeFlow({ sourceFileName: 'cis-controls-v8.csv' });
		expect(lands(flow)).toBe(`${DEFAULT_SETTINGS.defaultOutputPath}/cis-controls-v8`);
	});

	it('never puts two unrelated sources in one folder (the ownership consequence)', () => {
		const first = makeFlow({ sourceFileName: 'nist-csf-2.csv' });
		const second = makeFlow({ sourceFileName: 'mitre-attack.csv' });
		expect(lands(first)).not.toBe(lands(second));
		// And neither of them IS the shared root, which is what made the review
		// screen preselect refreshing whatever was already sitting there.
		expect(lands(first)).not.toBe(DEFAULT_SETTINGS.defaultOutputPath);
		expect(lands(second)).not.toBe(DEFAULT_SETTINGS.defaultOutputPath);
	});

	it('answers the question without writing the answer back', () => {
		// Rendering used to derive the default and assign it, which made the value
		// depend on which screen you had visited and let two surfaces disagree.
		const flow = makeFlow({ sourceFileName: 'scf-2026.csv' });
		lands(flow);
		lands(flow);
		expect(flow.outputPath).toBe('');
		expect(inner(flow).destinationEdited).toBe(false);
	});

	it('keeps a customized global output path as the PARENT of the per-import root (D-4)', () => {
		const flow = makeFlow({ globalRoot: 'Reference/Compliance', sourceFileName: 'nist-800-53-r5.csv' });
		expect(lands(flow)).toBe('Reference/Compliance/nist-800-53-r5');
	});
});

// ---------------------------------------------------------------------------
// 2. A recorded choice, not an inferred one (D-1).
// ---------------------------------------------------------------------------

describe('a chosen destination (D-1: gate on recorded intent)', () => {
	it('is returned as typed and is never replaced by the derived default', () => {
		const flow = makeFlow({ sourceFileName: 'nist-csf-2.csv' });
		chooseDestination(flow, 'My Frameworks/CSF');
		expect(lands(flow)).toBe('My Frameworks/CSF');
		// Repeated reads (every render is one) must not erode the choice.
		lands(flow);
		expect(lands(flow)).toBe('My Frameworks/CSF');
	});

	it('outranks a curated recipe root', () => {
		const flow = makeFlow({ sourceFileName: 'cis-controls-v8.csv' });
		inner(flow).curatedDestination = 'Ontologies/CIS Controls v8';
		chooseDestination(flow, 'Audit/CIS');
		expect(lands(flow)).toBe('Audit/CIS');
	});

	it('falls back to the derived default when the chosen value is blanked, not to the vault root', () => {
		const flow = makeFlow({ sourceFileName: 'cri-profile.csv' });
		chooseDestination(flow, '   ');
		expect(lands(flow)).toBe(`${DEFAULT_SETTINGS.defaultOutputPath}/cri-profile`);
	});

	it('survives a draft resume', async () => {
		const flow = makeFlow();
		await inner(flow).hydrateFromDraft(draft({ outputPath: 'My Frameworks/CSF', destinationEdited: true }));
		expect(lands(flow)).toBe('My Frameworks/CSF');
	});

	it('does not replay the flattened root from a draft saved before the flag existed', async () => {
		// Pre-flag drafts recorded the bare global root because the constructor
		// seeded it, not because anyone chose it. Resuming must re-derive.
		const flow = makeFlow();
		await inner(flow).hydrateFromDraft(draft({ outputPath: DEFAULT_SETTINGS.defaultOutputPath }));
		expect(inner(flow).destinationEdited).toBe(false);
		expect(lands(flow)).not.toBe(DEFAULT_SETTINGS.defaultOutputPath);
	});
});

// ---------------------------------------------------------------------------
// 3. A refresh keeps the destination the set already uses (D-2).
// ---------------------------------------------------------------------------

describe('refreshing an existing import set (D-2)', () => {
	it('re-importing the same source resolves to the same folder, so it finds its own set', () => {
		// D-2 needs no lookup: the derived root is pure over (global root, source
		// name), so the second import of a source lands on top of the first and
		// refreshes it. If this ever stops holding, a refresh silently mints a
		// duplicate set instead.
		const first = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'nist-csf-2.csv' });
		const second = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'nist-csf-2.csv' });
		expect(lands(second)).toBe(lands(first));
	});

	it('is not disturbed by unrelated session state', () => {
		const flow = makeFlow({ sourceFileName: 'nist-csf-2.csv' });
		const before = lands(flow);
		flow.overwriteMode = 'replace';
		flow.frameworkId = 'nist-csf-2';
		flow.currentStep = 3;
		expect(lands(flow)).toBe(before);
	});

	it('re-importing through the same recognized recipe stays put too', () => {
		const e = entry('cis-controls-v8-flat');
		const root = recognizedDestination(e, 'Ontologies');
		const first = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'cis.csv' });
		const second = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'cis.csv' });
		inner(first).curatedDestination = root;
		inner(second).curatedDestination = recognizedDestination(e, 'Ontologies');
		expect(lands(second)).toBe(lands(first));
	});
});

// ---------------------------------------------------------------------------
// 4. Recognized recipes: curated beats derived, both nest (D-3).
// ---------------------------------------------------------------------------

describe('recognized recipes (D-3: reconcile, do not pick a winner)', () => {
	it('uses the curated folder as the per-import root inside the global path', () => {
		const e = entry('cis-controls-v8-flat');
		expect(e.suggestedFolder).toBe('Frameworks/CIS Controls v8');
		expect(resolveDestinationDefault('Ontologies', 'cis-export.csv', e)).toBe('Ontologies/CIS Controls v8');
	});

	it('does not double-nest the registry own stand-in root', () => {
		const e = entry('nist-csf-2-flat');
		expect(resolveDestinationDefault('Ontologies', 'csf.csv', e)).not.toContain('Ontologies/Frameworks');
	});

	it('derives from the source file name when the recipe has no curated folder', () => {
		expect(resolveDestinationDefault('Ontologies', 'some-taxonomy.csv', null)).toBe('Ontologies/some-taxonomy');
	});

	it('derives when the curated folder is only the generic single-segment fallback', () => {
		const generic = { ...entry('cis-controls-v8-flat'), suggestedFolder: 'Frameworks' };
		expect(recognizedDestination(generic, 'Ontologies')).toBeNull();
		expect(resolveDestinationDefault('Ontologies', 'unknown-source.csv', generic)).toBe('Ontologies/unknown-source');
	});

	it('leaves non-ontology outputs in their curated homes', () => {
		// Crosswalk edges and evidence junctions are read by the mapping and
		// coverage surfaces; re-parenting them under the ontology root would move
		// those surfaces out from under their readers.
		expect(resolveDestinationDefault('Ontologies', 'olir.csv', entry('olir-crosswalk-edge'))).toBe('_crosswalker/mappings');
		expect(resolveDestinationDefault('Ontologies', 'evidence.csv', entry('evidence-junction-notes'))).toBe('Evidence/Junctions');
	});

	it('the recognized card and the write path name the same folder', () => {
		// The card in renderRecognizedCard and the accessor every write path reads
		// must agree, or the wizard promises one folder and writes to another.
		const e = entry('scf-2026-flat');
		const flow = makeFlow({ globalRoot: 'Ontologies', sourceFileName: 'scf-2026.csv' });
		const shownOnCard = resolveDestinationDefault('Ontologies', 'scf-2026.csv', e);
		inner(flow).curatedDestination = recognizedDestination(e, 'Ontologies');
		expect(lands(flow)).toBe(shownOnCard);
	});

	it('gives every bundled ontology recipe its own folder under the global root', () => {
		for (const e of RECIPE_REGISTRY.filter((r) => r.routingKind === 'concept')) {
			const dest = resolveDestinationDefault('Ontologies', 'source.csv', e);
			expect(dest).not.toBe('Ontologies');
			expect(dest.startsWith('Ontologies/')).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. The field never renders blank (D-5).
// ---------------------------------------------------------------------------

describe('the destination is never blank (D-5)', () => {
	const cases: Array<[string, ImportFlow]> = [
		['no source file selected yet', makeFlow()],
		['an empty global output path', makeFlow({ globalRoot: '', sourceFileName: 'a.csv' })],
		['a whitespace-only global output path', makeFlow({ globalRoot: '   ', sourceFileName: 'a.csv' })],
		['a trailing-slash global output path', makeFlow({ globalRoot: 'Ontologies/', sourceFileName: 'a.csv' })],
		['an extensionless source name', makeFlow({ sourceFileName: 'catalog' })],
		['neither a source nor a global root', makeFlow({ globalRoot: '' })],
	];

	it.each(cases)('shows a real path with %s', (_label, flow) => {
		const dest = lands(flow);
		expect(dest.trim().length).toBeGreaterThan(0);
		expect(dest).toBe(dest.trim());
		expect(dest.startsWith('/')).toBe(false);
	});

	it('shows a real path when the user cleared the field after choosing one', () => {
		const flow = makeFlow({ sourceFileName: 'a.csv' });
		chooseDestination(flow, '');
		expect(lands(flow).length).toBeGreaterThan(0);
	});
});
