/**
 * occupancy-case-fold.test.ts -- the wizard's new-set occupancy guard (A-6)
 * treats folder names that differ only by case as the same folder.
 *
 * THE DEFECT THIS PINS. Found driving the real wizard in a browser session:
 * a vault already held a set at `Frameworks/NIST-mini`, the wizard derived
 * `Frameworks/nist-mini` from the source file name, and the guard's
 * case-sensitive `startsWith` reported the folder free. On Windows and macOS
 * those two spellings are one folder on disk, so the new set was minted into
 * the first one's root: the collision A-6 exists to prevent.
 */

import { ImportFlow } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import type { DiscoveredImportSet } from '../src/generation/import-set';

type FlowApp = ConstructorParameters<typeof ImportFlow>[0];
type FlowPlugin = ConstructorParameters<typeof ImportFlow>[1];

interface FlowInternals {
	newSetOccupancyProblem(): string | null;
	discoveredSets: DiscoveredImportSet[] | null;
	destinationEdited: boolean;
}

const inner = (flow: ImportFlow): FlowInternals => flow as unknown as FlowInternals;

function makeFlow(): ImportFlow {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, defaultOutputPath: 'Frameworks' },
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as FlowPlugin;
	const app = {} as unknown as FlowApp;
	const flow = new ImportFlow(app, plugin, { containerEl: null as unknown as HTMLElement, close: () => {} });
	flow.sourceFile = { name: 'nist-mini.csv' } as File;
	return flow;
}

function occupantAt(root: string): DiscoveredImportSet {
	return {
		id: 'iset-nist01',
		scheme: 'endpoint-v1',
		noteCount: 2,
		paths: [`${root}/AC-1.md`, `${root}/AC-2.md`],
		root,
		recipeIds: [],
		ontologyPrefixes: ['nist'],
	};
}

function typeDestination(flow: ImportFlow, typed: string): void {
	inner(flow).destinationEdited = true;
	flow.outputPath = typed;
}

describe('A-6 occupancy guard: case-only differences are the same folder', () => {
	it('refuses a destination that differs from an occupied root only by case, naming both spellings', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt('Frameworks/NIST-mini')];
		typeDestination(flow, 'Frameworks/nist-mini');

		const problem = inner(flow).newSetOccupancyProblem();
		expect(problem).not.toBeNull();
		expect(problem).toContain('Frameworks/nist-mini is the same folder as Frameworks/NIST-mini on Windows and macOS');
		expect(problem).not.toContain('—');
	});

	it('keeps the original message when the spelling matches exactly', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt('Frameworks/NIST-mini')];
		typeDestination(flow, 'Frameworks/NIST-mini');

		const problem = inner(flow).newSetOccupancyProblem();
		expect(problem).toMatch(/^Frameworks\/NIST-mini already holds notes from the import set /);
	});

	it('does not treat a sibling that only shares a prefix as occupied', () => {
		const flow = makeFlow();
		inner(flow).discoveredSets = [occupantAt('Frameworks/NIST-mini-2')];
		typeDestination(flow, 'Frameworks/nist-mini');

		expect(inner(flow).newSetOccupancyProblem()).toBeNull();
	});
});
