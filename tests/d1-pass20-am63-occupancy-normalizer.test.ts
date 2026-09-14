/**
 * d1-pass20-am63-occupancy-normalizer.test.ts -- AM-63 (2026-09-04, pass 20,
 * Task C item 3): the wizard's new-set occupancy guard reads the destination
 * through the SAME normalizer (`normalizeFolderSetting`, the AM-45 mirror)
 * that the engine writes with, not a second, weaker spelling of it.
 *
 * THE DEFECT THIS PINS. `newSetOccupancyProblem` built its comparison prefix
 * from a local `.trim().replace(/\/+$/, '')` -- a fraction of one of the four
 * mutations a vault path actually receives (see `normalizeVaultPath`'s own
 * header: separator collapse/fold, backslash-to-forward-slash, NBSP/NFD
 * fold, NFC normalize). A destination typed with a doubled separator, a
 * backslash, or a pasted non-breaking space compared UNEQUAL to the fully
 * normalized paths every discovered set's notes actually live at, so the
 * guard reported the folder FREE, the user proceeded, and the engine then
 * normalized the very same string and minted a second import set into the
 * first one's folder -- two sets sharing one root collide on hub paths
 * forever, invisible until a later refresh reports notes it never wrote.
 *
 * THE RULE (`import-wizard.ts:1866-1883`, `:1951-1953`). `currentOutputPath()`
 * always returns `normalizeFolderSetting(this.currentOutputPathRaw())`, and
 * `newSetOccupancyProblem` reads that accessor directly rather than carrying
 * its own second spelling. Normalizing at the ONE accessor also makes the
 * string the wizard DISPLAYS the string the engine WRITES.
 */

import { ImportFlow } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import type { DiscoveredImportSet } from '../src/generation/import-set';

type FlowApp = ConstructorParameters<typeof ImportFlow>[0];
type FlowPlugin = ConstructorParameters<typeof ImportFlow>[1];

interface FlowInternals {
	currentOutputPath(): string;
	newSetOccupancyProblem(): string | null;
	discoveredSets: DiscoveredImportSet[] | null;
	destinationEdited: boolean;
}

const inner = (flow: ImportFlow): FlowInternals => flow as unknown as FlowInternals;

function makeFlow(): ImportFlow {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, defaultOutputPath: 'Ontologies' },
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as FlowPlugin;
	const app = {} as unknown as FlowApp;
	const flow = new ImportFlow(app, plugin, { containerEl: null as unknown as HTMLElement, close: () => {} });
	flow.sourceFile = { name: 'second-framework.csv' } as File;
	return flow;
}

/** The set already occupying `Frameworks/NIST`, exactly as `discoverImportSets` would shape it. */
function occupantAt(root: string): DiscoveredImportSet {
	return {
		id: 'iset-nist01',
		scheme: 'endpoint-v1',
		noteCount: 2,
		paths: [`${root}/AC-1.md`, `${root}/AC-2.md`],
		root,
		recipeIds: ['nist-800-53-r5'],
		ontologyPrefixes: ['nist'],
	};
}

/** The user typed `typed` as a NEW set's destination (never a refresh -- no importSetChoice set). */
function typeDestination(flow: ImportFlow, typed: string): void {
	inner(flow).destinationEdited = true;
	flow.outputPath = typed;
}

describe('AM-63: the new-set occupancy guard reads the destination through the ONE normalizer', () => {
	const OCCUPIED_ROOT = 'Frameworks/NIST';

	it('a doubled internal separator ("Frameworks//NIST") is recognized as the occupied folder and refused, naming the occupant', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt(OCCUPIED_ROOT)];
		typeDestination(flow, 'Frameworks//NIST');

		// The accessor itself already normalizes -- what the wizard would DISPLAY
		// is the same string the engine would write, and it collapses the doubled
		// separator.
		expect(inner(flow).currentOutputPath()).toBe(OCCUPIED_ROOT);

		const problem = inner(flow).newSetOccupancyProblem();
		expect(problem).toContain(OCCUPIED_ROOT);
		expect(problem).toContain('iset-nist01');
		expect(problem).toContain('already holds notes');
	});

	it('a backslash-separated destination ("Frameworks\\\\NIST") is recognized as the same occupied folder', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt(OCCUPIED_ROOT)];
		typeDestination(flow, 'Frameworks\\NIST');

		expect(inner(flow).currentOutputPath()).toBe(OCCUPIED_ROOT);
		const problem = inner(flow).newSetOccupancyProblem();
		expect(problem).toContain(OCCUPIED_ROOT);
		expect(problem).toContain('iset-nist01');
	});

	it('a pasted non-breaking space folds to an ordinary one and still matches an occupied folder whose real name uses a plain space', () => {
		// An ordinary, unremarkable existing folder name -- one word, one space,
		// exactly what `discoverImportSets` would report from real vault paths (it
		// never normalizes what it reads). The user pastes the same name from a
		// rendered source (a web page, a PDF, a spreadsheet) that substituted a
		// U+00A0 for the space -- an ordinary and common copy-paste artifact.
		// `set.paths` is never normalized by this guard (it is read as-is), so the
		// only string AM-63 can fix is the TYPED side; the test is honest to that:
		// the occupied folder's real name carries no NBSP of its own.
		const CLEAN_ROOT = 'Frameworks/NIST CSF';
		const typedWithNbsp = 'Frameworks/NIST CSF';
		expect(typedWithNbsp).not.toBe(CLEAN_ROOT); // the premise: genuinely different bytes.

		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt(CLEAN_ROOT)];
		typeDestination(flow, typedWithNbsp);

		// The accessor folds the NBSP to an ordinary space -- the string the wizard
		// would display is the string the engine would write, and it is now
		// byte-identical to the occupied folder's real, clean name.
		expect(inner(flow).currentOutputPath()).toBe(CLEAN_ROOT);
		const problem = inner(flow).newSetOccupancyProblem();
		expect(problem).toContain('iset-nist01');
		expect(problem).toContain(CLEAN_ROOT);
	});

	it('CONTROL: an unrelated destination is never refused -- the guard is not simply always-on', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt(OCCUPIED_ROOT)];
		typeDestination(flow, 'Ontologies/second-framework');
		expect(inner(flow).newSetOccupancyProblem()).toBeNull();
	});
});
