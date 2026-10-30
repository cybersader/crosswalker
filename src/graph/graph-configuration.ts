/** Shared saved-default I/O. No graph view or note APIs are used here. */
import { GRAPH_COLOR_OWNERSHIP_KEY, configureFrameworkGraph, graphConfigurationPreview, type GraphColorGroup, type GraphConfigurationMode } from './graph-colors';

export interface GraphSettingsAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export interface GraphDocument {
	path: string;
	raw: string | null;
	value: Record<string, unknown>;
}

/** Malformed or non-object documents are never treated as missing. */
export async function readGraphDocument(adapter: GraphSettingsAdapter, path: string): Promise<GraphDocument> {
	try {
		const raw = await adapter.exists(path) ? await adapter.read(path) : null;
		const value: unknown = raw === null ? {} : JSON.parse(raw);
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		return { path, raw, value: value as Record<string, unknown> };
	} catch {
		throw new Error('Graph or Crosswalker settings could not be read. Repair the settings file or restore a backup, then try again. No settings were changed.');
	}
}

export async function planGraphConfiguration(adapter: GraphSettingsAdapter, configDir: string, groups: readonly GraphColorGroup[], mode: GraphConfigurationMode) {
	const graph = await readGraphDocument(adapter, `${configDir}/graph.json`);
	const data = await readGraphDocument(adapter, `${configDir}/plugins/crosswalker/data.json`);
	const merge = configureFrameworkGraph(graph.value, groups, data.value[GRAPH_COLOR_OWNERSHIP_KEY], mode);
	return { graph, data, merge, preview: graphConfigurationPreview(graph.value, merge, mode) };
}

export type GraphConfigurationPlan = Awaited<ReturnType<typeof planGraphConfiguration>>;

/** Snapshot check protects stale previews and changes by another writer. */
export async function graphPlanIsCurrent(adapter: GraphSettingsAdapter, plan: GraphConfigurationPlan): Promise<boolean> {
	for (const document of [plan.graph, plan.data]) {
		const raw = await adapter.exists(document.path) ? await adapter.read(document.path) : null;
		if (raw !== document.raw) return false;
	}
	return true;
}

/** Graph first, ownership second. A failure in the latter is partial, never rolled back. */
export async function applyGraphConfiguration(
	adapter: GraphSettingsAdapter,
	plan: GraphConfigurationPlan,
	saveData: (data: Record<string, unknown>) => Promise<void> = async (data) => {
		await adapter.write(plan.data.path, `${JSON.stringify(data, null, 2)}\n`);
	},
): Promise<'applied' | 'stale' | 'partial'> {
	if (!await graphPlanIsCurrent(adapter, plan)) return 'stale';
	await adapter.write(plan.graph.path, `${JSON.stringify(plan.merge.options, null, 2)}\n`);
	try {
		await saveData({ ...plan.data.value, [GRAPH_COLOR_OWNERSHIP_KEY]: plan.merge.ownership });
	} catch {
		return 'partial';
	}
	return 'applied';
}
