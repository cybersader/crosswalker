/**
 * demo-graph.ts: the graph view settings the demo vault ships with.
 *
 * The demo builder writes the result to `.obsidian/graph.json`, the only file
 * it writes under `.obsidian`. Opening the graph view then shows each framework
 * as its own colored tree, mapping notes bridging the trees in one color, and
 * evidence in another, with the bookkeeping notes filtered out.
 *
 * Every group selects notes by tag or property, never by folder path, so the
 * colors keep working when a user moves or renames the framework folders.
 * Obsidian colors a note with the first group that matches it, which is why the
 * mapping and evidence groups come before the framework groups.
 *
 * The output is a pure function of which frameworks are present: same input,
 * same bytes.
 */

/** One color group, in the order Obsidian evaluates it. */
export interface DemoGraphGroup {
	/** Stable key, matched against the framework keys the builder imported. */
	key: string;
	/** What the color means, for the Start here note. */
	label: string;
	/** Obsidian search query. Tag or property only, never a folder path. */
	query: string;
	/** Color as #rrggbb. Mid-tone so it reads on both the light and dark theme. */
	hex: string;
	/** Plain color name, for the Start here note. */
	name: string;
}

/** Always present: the link notes and the evidence notes. */
export const LINK_GROUPS: readonly DemoGraphGroup[] = [
	{ key: 'mapping', label: 'Mapping links between frameworks', query: 'tag:#crosswalk OR [kind:crosswalk-edge] OR [kind:mapping-set]', hex: '#f28c28', name: 'Orange' },
	// Not green: Obsidian draws tag nodes in its own green, and tags are shown.
	{ key: 'evidence', label: 'Evidence and evidence links', query: 'tag:#evidence OR [kind:junction-note] OR [kind:evidence-document]', hex: '#ec4899', name: 'Pink' },
];

/**
 * One group per framework, selected by its identity prefix. Every note a
 * framework import writes, including the level notes and the hub note that
 * carry no tags, has a `curie` that starts with the framework's ontology.
 */
export const FRAMEWORK_GROUPS: readonly DemoGraphGroup[] = [
	{ key: 'csf', label: 'NIST CSF 2.0', query: 'tag:#nist-csf OR [curie:"nist-csf-2:"]', hex: '#3b82f6', name: 'Blue' },
	{ key: 'sp80053', label: 'NIST SP 800-53 Rev. 5', query: 'tag:#nist-800-53 OR [curie:"nist-800-53:"]', hex: '#a855f7', name: 'Purple' },
	{ key: 'attack', label: 'MITRE ATT&CK', query: 'tag:#mitre-attack OR [curie:"mitre-attack:"]', hex: '#e5484d', name: 'Red' },
	{ key: 'f3', label: 'MITRE Fight Fraud Framework', query: '[curie:"mitre-f3:"]', hex: '#d9a400', name: 'Gold' },
	// Only present after the opt-in local step adds a licensed framework the user
	// already holds. The demo build itself never includes it.
	{ key: 'cri', label: 'Licensed framework added locally', query: '[curie:"cri-profile:"]', hex: '#06b6d4', name: 'Cyan' },
];

/**
 * Notes the graph hides: import bookkeeping, the saved queries and the
 * welcome note. These are the demo's own fixed locations, not user content.
 */
export const GRAPH_SEARCH = '-path:"_crosswalker/import-sets" -path:"Queries" -file:"Start here"';

/** The color groups for the frameworks present, in evaluation order. */
export function demoGraphGroups(frameworks: readonly string[]): DemoGraphGroup[] {
	const present = new Set(frameworks);
	return [...LINK_GROUPS, ...FRAMEWORK_GROUPS.filter((g) => present.has(g.key))];
}

function rgb(hex: string): number {
	if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`Color ${hex} is not #rrggbb.`);
	return parseInt(hex.slice(1), 16);
}

/** The `.obsidian/graph.json` object, with keys in a fixed order. */
export function demoGraphConfig(frameworks: readonly string[]): Record<string, unknown> {
	return {
		'collapse-filter': false,
		search: GRAPH_SEARCH,
		showTags: true,
		showAttachments: false,
		hideUnresolved: true,
		showOrphans: false,
		'collapse-color-groups': false,
		colorGroups: demoGraphGroups(frameworks).map((g) => ({ query: g.query, color: { a: 1, rgb: rgb(g.hex) } })),
		'collapse-display': true,
		showArrow: true,
		textFadeMultiplier: -1,
		nodeSizeMultiplier: 1.2,
		lineSizeMultiplier: 1,
		'collapse-forces': true,
		centerStrength: 0.3,
		repelStrength: 15,
		linkStrength: 1,
		linkDistance: 80,
		scale: 0.1,
		// The panel starts closed so the graph has the whole view; Start here lists the colors.
		close: true,
	};
}

/** The exact bytes written to `.obsidian/graph.json`. */
export function demoGraphJson(frameworks: readonly string[]): string {
	return `${JSON.stringify(demoGraphConfig(frameworks), null, 2)}\n`;
}
