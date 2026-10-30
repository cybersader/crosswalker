/**
 * graph-colors.ts: the color groups and graph view options that make each
 * framework read as its own colored tree in Obsidian's graph view.
 *
 * Pure, with no Obsidian imports, so two callers share one source:
 * - the demo builder (`tools/lib/demo-graph.ts`), which writes the demo vault's
 *   `.obsidian/graph.json`;
 * - the plugin command "Color the graph by framework", which merges the same
 *   groups into a user's existing graph settings (`mergeGraphOptions`).
 *
 * Groups select notes by tag, property or recipe provenance, never by folder path, so the
 * colors keep working when a user moves or renames framework folders.
 * Obsidian colors a note with the first group that matches it, which is why
 * the mapping and evidence groups come before the framework groups.
 *
 * Output is a pure function of the input: same frameworks, same groups, same
 * order, same colors.
 */

/** One color group, in the order Obsidian evaluates it. */
export interface GraphColorGroup {
	/** Stable key: `mapping`, `evidence`, a known framework key, or `prefix:<curie prefix>`. */
	key: string;
	/** What the color means, in plain words. */
	label: string;
	/** Obsidian search query. Tag, property or provenance, never a folder path. */
	query: string;
	/** Color as #rrggbb. Mid-tone so it reads on both the light and dark theme. */
	hex: string;
	/** Plain color name. */
	name: string;
}

/** A known public framework: its group plus the curie prefix that identifies it. */
export interface KnownFrameworkGroup extends GraphColorGroup {
	/** Curie prefix (the part before the colon) every note of this framework carries. */
	prefix: string;
}

/** A framework found in a vault, by identity. */
export interface GraphFramework {
	/** Display name shown to the user. */
	name: string;
	/** Curie prefix (ontology id) shared by every note of this framework. */
	prefix: string;
}

/** Always present: the link notes and the evidence notes. */
export const LINK_GROUPS: readonly GraphColorGroup[] = [
	{ key: 'mapping', label: 'Mapping links between frameworks', query: 'tag:#crosswalk OR [kind:crosswalk-edge] OR [kind:mapping-set]', hex: '#f28c28', name: 'Orange' },
	// Not green: Obsidian draws tag nodes in its own green, and tags are shown.
	{ key: 'evidence', label: 'Evidence and evidence links', query: 'tag:#evidence OR [kind:junction-note] OR [kind:evidence-document]', hex: '#ec4899', name: 'Pink' },
];

/**
 * Known public frameworks keep a fixed palette, so the same framework has the
 * same color in every vault. Every note a framework import writes, including
 * the level notes and hub note that carry no tags, has a `curie` that starts
 * with the framework's prefix.
 */
export const KNOWN_FRAMEWORK_GROUPS: readonly KnownFrameworkGroup[] = [
	{ key: 'csf', prefix: 'nist-csf-2', label: 'NIST CSF 2.0', query: 'tag:#nist-csf OR [curie:"nist-csf-2:"]', hex: '#3b82f6', name: 'Blue' },
	{ key: 'sp80053', prefix: 'nist-800-53', label: 'NIST SP 800-53 Rev. 5', query: 'tag:#nist-800-53 OR [curie:"nist-800-53:"]', hex: '#a855f7', name: 'Purple' },
	{ key: 'attack', prefix: 'mitre-attack', label: 'MITRE ATT&CK', query: 'tag:#mitre-attack OR [curie:"mitre-attack:"]', hex: '#e5484d', name: 'Red' },
	{ key: 'f3', prefix: 'mitre-f3', label: 'MITRE Fight Fraud Framework', query: '[curie:"mitre-f3:"]', hex: '#d9a400', name: 'Gold' },
	{ key: 'd3fend', prefix: 'mitre-d3fend', label: 'MITRE D3FEND', query: 'tag:#mitre-d3fend OR [curie:"mitre-d3fend:"]', hex: '#0f9d8f', name: 'Teal' },
	// Only present after the user adds a licensed framework they already hold.
	{ key: 'cis', prefix: 'cis-v8', label: 'CIS Controls', query: '[curie:"cis-v8:"]', hex: '#0f9d8f', name: 'Teal' },
	{ key: 'cri', prefix: 'cri-profile', label: 'Licensed framework added locally', query: '[curie:"cri-profile:"]', hex: '#06b6d4', name: 'Cyan' },
	{ key: 'scf', prefix: 'scf', label: 'Secure Controls Framework', query: '[curie:"scf:"]', hex: '#a66a25', name: 'Brown' },
];

/** Private demo only. Provenance is replaced on full import; no sticky tag. */
export const REFERENCED_FRAMEWORK_GROUP: GraphColorGroup = {
	key: 'referenced', label: 'Referenced, id only', query: '"cw-referenced-framework"', hex: '#7c8aa0', name: 'Muted slate',
};

/**
 * Colors for frameworks not in the known table, assigned in curie-prefix
 * order and wrapping when there are more frameworks than colors. Mid-tones,
 * distinct from the known palette and from the green Obsidian uses for tags.
 */
export const FALLBACK_PALETTE: readonly { hex: string; name: string }[] = [
	{ hex: '#6366f1', name: 'Indigo' },
	{ hex: '#0f9d8f', name: 'Teal' },
	{ hex: '#a0703c', name: 'Brown' },
	{ hex: '#7c8aa0', name: 'Slate' },
	{ hex: '#9f1239', name: 'Maroon' },
	{ hex: '#8a8f1e', name: 'Olive' },
	{ hex: '#c2410c', name: 'Rust' },
	{ hex: '#0369a1', name: 'Ocean' },
];

/** Prefixes safe to place inside a quoted property query. */
const SAFE_PREFIX = /^[A-Za-z0-9._-]+$/;

/** The query that selects every note of a framework by its curie prefix. */
export function prefixQuery(prefix: string): string {
	return `[curie:"${prefix}:"]`;
}

/**
 * The color groups for the frameworks found, in evaluation order: mapping,
 * evidence, known frameworks in table order, then the rest sorted by prefix.
 * Duplicate prefixes and prefixes that cannot be quoted safely are skipped.
 */
export function graphColorGroups(frameworks: readonly GraphFramework[]): GraphColorGroup[] {
	const byPrefix = new Map<string, GraphFramework>();
	for (const f of frameworks) {
		if (!SAFE_PREFIX.test(f.prefix) || byPrefix.has(f.prefix)) continue;
		byPrefix.set(f.prefix, f);
	}
	const known = KNOWN_FRAMEWORK_GROUPS.filter((g) => byPrefix.has(g.prefix)).map(stripPrefix);
	const knownPrefixes = new Set(KNOWN_FRAMEWORK_GROUPS.map((g) => g.prefix));
	const unknown = [...byPrefix.values()]
		.filter((f) => !knownPrefixes.has(f.prefix))
		.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))
		.map((f, i): GraphColorGroup => {
			const color = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
			return { key: `prefix:${f.prefix}`, label: f.name, query: prefixQuery(f.prefix), hex: color.hex, name: color.name };
		});
	return [...LINK_GROUPS, ...known, ...unknown];
}

function stripPrefix(g: KnownFrameworkGroup): GraphColorGroup {
	return { key: g.key, label: g.label, query: g.query, hex: g.hex, name: g.name };
}

/** `#rrggbb` to the integer Obsidian stores. */
export function hexToRgb(hex: string): number {
	if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`Color ${hex} is not #rrggbb.`);
	return parseInt(hex.slice(1), 16);
}

/** Obsidian's stored shape for one color group. */
export interface GraphColorGroupOption {
	query: string;
	color: { a: number; rgb: number };
}

export function toColorGroupOption(g: GraphColorGroup): GraphColorGroupOption {
	return { query: g.query, color: { a: 1, rgb: hexToRgb(g.hex) } };
}

/**
 * Hides Crosswalker's own bookkeeping notes (the import set records). A fixed
 * plugin-owned location, not user content.
 */
export const PLUGIN_GRAPH_SEARCH = '-path:"_crosswalker/import-sets"';

/**
 * A full graph options object with keys in a fixed order. `viewState` adds the
 * keys that describe how the panel and camera start (`scale`, `close`), which
 * only a freshly built vault should set.
 */
export function graphOptions(
	groups: readonly GraphColorGroup[],
	search: string,
	opts: { viewState?: boolean } = {},
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		'collapse-filter': false,
		search,
		showTags: true,
		showAttachments: false,
		hideUnresolved: true,
		showOrphans: false,
		'collapse-color-groups': false,
		colorGroups: groups.map(toColorGroupOption),
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
	};
	if (opts.viewState) {
		out.scale = 0.1;
		// The panel starts closed so the graph has the whole view.
		out.close = true;
	}
	return out;
}

/** Every query this module can generate for known groups. */
export function knownGeneratedQueries(): string[] {
	return [...LINK_GROUPS, ...KNOWN_FRAMEWORK_GROUPS].map((g) => g.query);
}

export interface GraphMergeResult {
	/** The merged options to apply and persist. */
	options: Record<string, unknown>;
	/** Queries this merge wrote; store them so the next run can replace them. */
	managedQueries: string[];
	/** Color groups the user wrote that were kept. */
	keptUserGroups: number;
	/** Whether the noise filter was applied (only when the search was empty). */
	searchApplied: boolean;
}

/**
 * Merge generated color groups into a user's existing graph options without
 * overwriting them wholesale.
 *
 * - Color groups the user wrote are kept, in their order, ahead of the
 *   generated ones (so a user's own rule still wins where it matches).
 * - Groups this command wrote before are replaced. They are recognized by
 *   exact query string: the stored `previousManaged` list, plus every query
 *   this module can generate for the known groups and the current frameworks.
 * - `showTags` and `hideUnresolved` are turned on.
 * - The noise filter is applied only when the user's search is empty.
 * - Every other key the user has (forces, display, panel state) is left as is;
 *   missing ones are filled from the defaults.
 */
export function mergeGraphOptions(
	existing: Record<string, unknown> | null | undefined,
	groups: readonly GraphColorGroup[],
	previousManaged: readonly string[] = [],
	search: string = PLUGIN_GRAPH_SEARCH,
): GraphMergeResult {
	const base = existing && typeof existing === 'object' ? existing : {};
	const generated = groups.map(toColorGroupOption);
	const managed = new Set<string>([...previousManaged, ...knownGeneratedQueries(), ...generated.map((g) => g.query)]);
	const existingGroups = Array.isArray(base.colorGroups) ? (base.colorGroups as unknown[]) : [];
	const userGroups = existingGroups.filter((g) => {
		const q = g && typeof g === 'object' ? (g as { query?: unknown }).query : undefined;
		return !(typeof q === 'string' && managed.has(q));
	});

	const currentSearch = typeof base.search === 'string' ? base.search : '';
	const searchApplied = currentSearch.trim() === '';

	const out: Record<string, unknown> = { ...base };
	out.colorGroups = [...userGroups, ...generated];
	out.showTags = true;
	out.hideUnresolved = true;
	if (searchApplied) out.search = search;
	for (const [k, v] of Object.entries(graphOptions([], search))) {
		if (!(k in out)) out[k] = v;
	}
	return {
		options: out,
		managedQueries: generated.map((g) => g.query),
		keptUserGroups: userGroups.length,
		searchApplied,
	};
}
