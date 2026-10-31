/** Saved global graph defaults only. Open global views must be closed first:
 * each native view can later save its private options over the global defaults.
 * Neither global nor local view options are copied or changed by this adapter.
 */
import { Notice, type App } from 'obsidian';
import { discoverInstalledFrameworks, type InstalledFrameworksResult } from '../discovery/installed-frameworks';
import { settleVaultIndex, VAULT_STILL_INDEXING_MESSAGE } from '../generation/import-set';
import { graphColorGroups, sameGraphValue, type GraphConfigurationMode, type GraphMergeResult } from './graph-colors';
import { applyGraphConfiguration, planGraphConfiguration, type GraphConfigurationPlan } from './graph-configuration';

/** Legacy setting retained for backward readability, never ownership proof. */
export const GRAPH_COLOR_MARKER_KEY = 'graphColorManagedQueries';

export interface GraphColorHost {
	settings: object;
	saveSettings(): Promise<void>;
}

type GraphProblem = { status: 'indexing' | 'no-frameworks' | 'unreadable-settings' | 'failed' | 'open-graphs' | 'stale' | 'partial'; message: string };
export type GraphColorOutcome = GraphProblem | {
	status: 'applied'; message: string; frameworks: number; via: 'file'; merge: GraphMergeResult;
};
export type GraphPreviewOutcome = GraphProblem | { status: 'preview'; frameworks: number; plan: GraphConfigurationPlan };

export const NO_FRAMEWORKS_MESSAGE = 'No frameworks found in this vault. Import a framework first, then run this again.';
export const CLOSE_GLOBAL_GRAPHS_MESSAGE = 'Close all global graph views, then run this again to update saved global graph defaults. Open views can overwrite saved defaults. Local graphs can stay open.';

export function describeColoring(frameworks: number): string {
	return `${frameworks} framework${frameworks === 1 ? '' : 's'}, mappings, evidence`;
}

async function discoverSettled(app: App): Promise<InstalledFrameworksResult> {
	const first = discoverInstalledFrameworks(app);
	if (first.state === 'ready') return first;
	await settleVaultIndex(app, 4000);
	return discoverInstalledFrameworks(app);
}

/** No writes, including when called to populate the modal. */
export async function previewFrameworkGraph(app: App, mode: GraphConfigurationMode = 'overview'): Promise<GraphPreviewOutcome> {
	const discovery = await discoverSettled(app);
	if (discovery.state === 'indexing') return { status: 'indexing', message: VAULT_STILL_INDEXING_MESSAGE };
	if (discovery.frameworks.length === 0) return { status: 'no-frameworks', message: NO_FRAMEWORKS_MESSAGE };
	const groups = graphColorGroups(discovery.frameworks.map((f) => ({ name: f.name, prefix: f.id })));
	try {
		const plan = await planGraphConfiguration(app.vault.adapter, app.vault.configDir, groups, mode);
		return { status: 'preview', frameworks: groups.length - 2, plan };
	} catch {
		return { status: 'unreadable-settings', message: 'Your graph or Crosswalker settings could not be read, so they were left unchanged. Repair the settings file or restore a backup, then run this again.' };
	}
}

/** Reload the authoritative saved defaults, not the options of any open view.
 * Replacing the cache also removes stale keys absent from the saved document.
 * Native Graph supplies its own missing defaults when a new view opens.
 */
function reloadSavedGlobalDefaults(app: App, saved: Record<string, unknown>): boolean {
	if (app.workspace.getLeavesOfType('graph').length > 0) return false;
	try {
		const internal = (app as unknown as { internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: Record<string, unknown> } } | null } }).internalPlugins;
		if (typeof internal?.getPluginById !== 'function') return false;
		const plugin = internal.getPluginById('graph');
		if (!plugin?.instance) return true; // No loaded cache; enabling Graph loads its saved file.
		plugin.instance.options = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
		return sameGraphValue(plugin.instance.options, saved);
	} catch { return false; }
}

/** Explicit apply against the same snapshot the user previewed. */
export async function applyFrameworkGraph(app: App, host: GraphColorHost, preview: Extract<GraphPreviewOutcome, { status: 'preview' }>): Promise<GraphColorOutcome> {
	if (app.workspace.getLeavesOfType('graph').length > 0) return { status: 'open-graphs', message: CLOSE_GLOBAL_GRAPHS_MESSAGE };
	const { plan, frameworks } = preview;
	try {
		const result = await applyGraphConfiguration(app.vault.adapter, plan, async (data) => {
			const previous = host.settings;
			host.settings = { ...previous, ...data };
			try { await host.saveSettings(); }
			catch (error) { host.settings = previous; throw error; }
		});
		if (result === 'stale') return { status: 'stale', message: 'Graph or Crosswalker settings changed after the preview. Open a new preview, then apply it again.' };
		if (!reloadSavedGlobalDefaults(app, plan.merge.options)) {
			return {
				status: 'partial',
				message: 'Saved global graph defaults changed, but Graph view could not reload them safely. Close and reopen Obsidian before opening Graph view so stale defaults cannot overwrite your changes.'
					+ (result === 'partial' ? ' Color history also could not be saved. Check that Crosswalker settings are writable before trying again.' : ''),
			};
		}
		if (result === 'partial') return { status: 'partial', message: 'Saved global graph defaults changed, but the color history could not be saved. Reopen the graph to see the display changes. Check that Crosswalker settings are writable before trying again; existing colors will be kept conservatively.' };
		return {
			status: 'applied', via: 'file', frameworks, merge: plan.merge,
			message: `Saved global graph defaults updated: ${describeColoring(frameworks)}. Reopen the global graph to see them. Your search and local graphs were not changed.`,
		};
	} catch {
		return { status: 'failed', message: 'The graph settings could not be saved. Check that the vault folder is writable, then run this again.' };
	}
}

export async function colorGraphByFramework(app: App, host: GraphColorHost): Promise<GraphColorOutcome> {
	const preview = await previewFrameworkGraph(app, 'colors');
	const outcome = preview.status === 'preview' ? await applyFrameworkGraph(app, host, preview) : preview;
	new Notice(outcome.message, outcome.status === 'applied' ? 6000 : 8000);
	return outcome;
}
