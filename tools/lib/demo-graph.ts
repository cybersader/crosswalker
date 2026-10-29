/**
 * demo-graph.ts: the graph view settings the demo vault ships with.
 *
 * The demo builder writes the result to `.obsidian/graph.json`, the only file
 * it writes under `.obsidian`. Opening the graph view then shows each framework
 * as its own colored tree, mapping notes bridging the trees in one color, and
 * evidence in another, with the bookkeeping notes filtered out.
 *
 * The groups, palette and option keys live in `src/graph/graph-colors.ts`,
 * shared with the plugin command "Color the graph by framework". This file
 * only maps the demo's framework keys onto that builder and adds the demo's
 * own fixed filter.
 *
 * The output is a pure function of which frameworks are present: same input,
 * same bytes.
 */

import {
	KNOWN_FRAMEWORK_GROUPS,
	LINK_GROUPS as SHARED_LINK_GROUPS,
	PLUGIN_GRAPH_SEARCH,
	graphColorGroups,
	graphOptions,
	type GraphColorGroup,
} from '../../src/graph/graph-colors';

/** One color group, in the order Obsidian evaluates it. */
export type DemoGraphGroup = GraphColorGroup;

/** Always present: the link notes and the evidence notes. */
export const LINK_GROUPS: readonly DemoGraphGroup[] = SHARED_LINK_GROUPS;

/** One group per known framework, keyed by the demo's framework keys. */
export const FRAMEWORK_GROUPS: readonly DemoGraphGroup[] = KNOWN_FRAMEWORK_GROUPS.map((g) => ({
	key: g.key,
	label: g.label,
	query: g.query,
	hex: g.hex,
	name: g.name,
}));

/**
 * Notes the graph hides: import bookkeeping, the saved queries and the
 * welcome note. These are the demo's own fixed locations, not user content.
 */
export const GRAPH_SEARCH = `${PLUGIN_GRAPH_SEARCH} -path:"Queries" -file:"Start here"`;

/** The color groups for the frameworks present, in evaluation order. Unknown keys are ignored. */
export function demoGraphGroups(frameworks: readonly string[]): DemoGraphGroup[] {
	const present = new Set(frameworks);
	return graphColorGroups(
		KNOWN_FRAMEWORK_GROUPS.filter((g) => present.has(g.key)).map((g) => ({ name: g.label, prefix: g.prefix })),
	);
}

/** The `.obsidian/graph.json` object, with keys in a fixed order. */
export function demoGraphConfig(frameworks: readonly string[]): Record<string, unknown> {
	// viewState: the panel starts closed so the graph has the whole view; Start here lists the colors.
	return graphOptions(demoGraphGroups(frameworks), GRAPH_SEARCH, { viewState: true });
}

/** The exact bytes written to `.obsidian/graph.json`. */
export function demoGraphJson(frameworks: readonly string[]): string {
	return `${JSON.stringify(demoGraphConfig(frameworks), null, 2)}\n`;
}
