/**
 * graph-color-command.ts: the "Color the graph by framework" command.
 *
 * Finds the frameworks in the vault by note identity, builds one color group
 * per framework plus the mapping and evidence groups (`graph-colors.ts`, the
 * same builder the demo vault uses), and merges them into the user's graph
 * settings. It never replaces the settings wholesale: the user's own color
 * groups, search, forces and display choices are kept. Only groups this command
 * wrote before are replaced, recognized by exact query string.
 *
 * How the change reaches the graph (Obsidian 1.12, internal API, guarded):
 * - Live path. `app.internalPlugins.getPluginById('graph')` is the core Graph
 *   view plugin. Its `instance.options` holds the settings loaded from
 *   `<config>/graph.json`, and `instance.saveOptions()` persists them. Each open
 *   global graph (`getLeavesOfType('graph')`) has `view.dataEngine.setOptions()`,
 *   which re-renders that view. Open views must receive the new options: a view
 *   copies its own options back into the plugin and saves them on its next
 *   change, which would otherwise undo this command.
 * - Fallback. If any of that is missing or throws, read and write
 *   `<config>/graph.json` through the vault adapter and tell the user to close
 *   and reopen the graph view.
 *
 * The local graph (`localgraph`) keeps its own options in workspace state and
 * is not changed.
 */

import { Notice, type App } from 'obsidian';
import { discoverInstalledFrameworks, type InstalledFrameworksResult } from '../discovery/installed-frameworks';
import { settleVaultIndex, VAULT_STILL_INDEXING_MESSAGE } from '../generation/import-set';
import { graphColorGroups, mergeGraphOptions, type GraphMergeResult } from './graph-colors';

/** Plugin data key holding the queries this command last wrote. */
export const GRAPH_COLOR_MARKER_KEY = 'graphColorManagedQueries';

export interface GraphColorHost {
	settings: object;
	saveSettings(): Promise<void>;
}

export type GraphColorOutcome =
	| { status: 'indexing'; message: string }
	| { status: 'no-frameworks'; message: string }
	| { status: 'unreadable-settings'; message: string }
	| { status: 'failed'; message: string }
	| { status: 'applied'; message: string; frameworks: number; via: 'live' | 'file'; merge: GraphMergeResult };

export const NO_FRAMEWORKS_MESSAGE = 'No frameworks found in this vault. Import a framework first, then run this again.';

interface GraphPluginInstance {
	options?: Record<string, unknown>;
	saveOptions?: () => unknown;
}

interface GraphInternalPlugin {
	enabled?: boolean;
	instance?: GraphPluginInstance;
}

interface GraphDataEngine {
	setOptions?: (options: Record<string, unknown>) => unknown;
}

function graphPlugin(app: App): GraphInternalPlugin | null {
	const internal = (app as unknown as {
		internalPlugins?: { getPluginById?: (id: string) => unknown };
	}).internalPlugins;
	const plugin = internal?.getPluginById?.('graph');
	return plugin && typeof plugin === 'object' ? (plugin as GraphInternalPlugin) : null;
}

function storedMarker(host: GraphColorHost): string[] {
	const value = (host.settings as Record<string, unknown>)[GRAPH_COLOR_MARKER_KEY];
	return Array.isArray(value) ? value.filter((q): q is string => typeof q === 'string') : [];
}

/** "4 frameworks, mappings, evidence" */
export function describeColoring(frameworks: number): string {
	return `${frameworks} framework${frameworks === 1 ? '' : 's'}, mappings, evidence`;
}

/** Discovery that waits briefly for the index before answering "indexing". */
async function discoverSettled(app: App): Promise<InstalledFrameworksResult> {
	const first = discoverInstalledFrameworks(app);
	if (first.state === 'ready') return first;
	await settleVaultIndex(app, 4000);
	return discoverInstalledFrameworks(app);
}

/**
 * Run the command. Shows a notice with the outcome and returns it, so tests and
 * the e2e spec can assert on what happened.
 */
export async function colorGraphByFramework(app: App, host: GraphColorHost): Promise<GraphColorOutcome> {
	const outcome = await runColorGraph(app, host);
	new Notice(outcome.message, outcome.status === 'applied' ? 6000 : 8000);
	return outcome;
}

async function runColorGraph(app: App, host: GraphColorHost): Promise<GraphColorOutcome> {
	const discovery = await discoverSettled(app);
	if (discovery.state === 'indexing') return { status: 'indexing', message: VAULT_STILL_INDEXING_MESSAGE };
	if (discovery.frameworks.length === 0) return { status: 'no-frameworks', message: NO_FRAMEWORKS_MESSAGE };

	const groups = graphColorGroups(discovery.frameworks.map((f) => ({ name: f.name, prefix: f.id })));
	const count = groups.length - 2; // minus the mapping and evidence groups
	const previous = storedMarker(host);
	const plugin = graphPlugin(app);

	// Live path: the plugin is on and exposes its in-memory options.
	const instance = plugin?.instance;
	if (plugin?.enabled && instance && instance.options && typeof instance.saveOptions === 'function') {
		try {
			const merge = mergeGraphOptions(instance.options, groups, previous);
			Object.assign(instance.options, merge.options);
			await instance.saveOptions();
			for (const leaf of app.workspace.getLeavesOfType('graph')) {
				const engine = (leaf.view as unknown as { dataEngine?: GraphDataEngine }).dataEngine;
				engine?.setOptions?.(merge.options);
			}
			await recordMarker(host, merge);
			return {
				status: 'applied',
				via: 'live',
				frameworks: count,
				merge,
				message: `Graph colored: ${describeColoring(count)}.${keptNote(merge)}`,
			};
		} catch {
			// Fall through to the file path below.
		}
	}

	// Fallback: merge into the settings file directly.
	const path = `${app.vault.configDir}/graph.json`;
	let existing: Record<string, unknown> = {};
	try {
		if (await app.vault.adapter.exists(path)) {
			const parsed: unknown = JSON.parse(await app.vault.adapter.read(path));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
			else throw new Error('not an object');
		}
	} catch {
		return {
			status: 'unreadable-settings',
			message: 'Your graph settings file could not be read, so it was left unchanged. Open the graph view, change any graph setting to rewrite it, then run this again.',
		};
	}
	try {
		const merge = mergeGraphOptions(existing, groups, previous);
		await app.vault.adapter.write(path, `${JSON.stringify(merge.options, null, 2)}\n`);
		// Keep a disabled plugin's in-memory copy in step, so it cannot save stale options later.
		if (instance?.options) Object.assign(instance.options, merge.options);
		await recordMarker(host, merge);
		const next = plugin && plugin.enabled === false
			? 'Turn on Graph view in Settings, Core plugins, then open the graph.'
			: 'Close and reopen the graph view to see them.';
		return {
			status: 'applied',
			via: 'file',
			frameworks: count,
			merge,
			message: `Graph colors saved: ${describeColoring(count)}. ${next}${keptNote(merge)}`,
		};
	} catch {
		return {
			status: 'failed',
			message: 'The graph settings could not be saved. Check that the vault folder is writable, then run this again.',
		};
	}
}

function keptNote(merge: GraphMergeResult): string {
	const k = merge.keptUserGroups;
	return k > 0 ? ` Kept ${k} of your own color group${k === 1 ? '' : 's'}.` : '';
}

async function recordMarker(host: GraphColorHost, merge: GraphMergeResult): Promise<void> {
	(host.settings as Record<string, unknown>)[GRAPH_COLOR_MARKER_KEY] = merge.managedQueries;
	await host.saveSettings();
}
