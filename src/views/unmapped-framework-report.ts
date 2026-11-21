import type { App } from 'obsidian';
import { readVaultTree, type ReadVaultTreeResult } from '../export/vault-reader';
import { discoverImportSets, requireVaultIndexed } from '../generation/import-set';
import { composeQuery } from './query-composer';
import { identityFactsFromFrontmatter, inUnderscoreFolder } from './workspace-view-helpers';

export const UNMAPPED_REPORT_NAME = 'Unmapped framework entries';
export interface UnmappedEntry { id: string; path: string; kind: 'concept' | 'facet' | 'hub'; missingCounterpart: boolean }
export interface FrameworkCoverage { framework: string; total: number; mapped: number; unmapped: UnmappedEntry[] }

/** A vault-wide anti-join: a parent, a backlink, and a cross-framework assertion are different facts. */
export function unmappedFrameworkEntries(tree: ReadVaultTreeResult): FrameworkCoverage[] {
	if (tree.skipped.length) {
		const first = tree.skipped[0];
		throw new Error(`Coverage is incomplete: ${first.path} (${first.reason}). Resolve the skipped input and run the report again.`);
	}
	const entries = new Map<string, { framework: string; entry: UnmappedEntry }>();
	for (const row of [...tree.concepts, ...tree.hubs]) {
		const { ontologyId, producerKind } = identityFactsFromFrontmatter(row.frontmatter);
		if (!producerKind?.trim() || !ontologyId || inUnderscoreFolder(row.path)) continue;
		if (entries.has(row.curie)) throw new Error(`Two framework notes claim ${row.curie}. Resolve the duplicate identifier and run the report again.`);
		entries.set(row.curie, { framework: ontologyId, entry: { id: row.curie, path: row.path, kind: row.kind, missingCounterpart: false } });
	}
	const mapped = new Set<string>();
	for (const edge of tree.crosswalkEdges) {
		if (edge.predicate_modifier === 'NOT' || edge.predicate_id === 'no_relationship') continue;
		const a = entries.get(edge.subject_id), b = entries.get(edge.object_id);
		if (a && b) {
			if (a.framework !== b.framework) { mapped.add(a.entry.id); mapped.add(b.entry.id); }
		} else if (edge.subject_id.split(':', 1)[0] !== edge.object_id.split(':', 1)[0]) {
			if (a) a.entry.missingCounterpart = true;
			if (b) b.entry.missingCounterpart = true;
		}
	}
	const ids = (keys: Iterable<string>) => Array.from(keys, id => ({ id }));
	const unmatched = new Set(composeQuery({ from: 'entries', joins: [{ withSource: 'endpoints', kind: 'anti', leftOn: 'id', rightOn: 'id' }] },
		{ entries: ids(entries.keys()), endpoints: ids(mapped) }).map(row => row.id));
	const groups = new Map<string, FrameworkCoverage>();
	for (const { framework, entry } of entries.values()) {
		let g = groups.get(framework);
		if (!g) { g = { framework, total: 0, mapped: 0, unmapped: [] }; groups.set(framework, g); }
		g.total++;
		if (unmatched.has(entry.id)) g.unmapped.push(entry); else g.mapped++;
	}
	for (const g of groups.values()) g.unmapped.sort((a, b) => a.id.localeCompare(b.id));
	return [...groups.values()].sort((a, b) => Number(b.mapped === 0) - Number(a.mapped === 0) || b.unmapped.length - a.unmapped.length || a.framework.localeCompare(b.framework));
}

export async function loadUnmappedFrameworkReport(app: App): Promise<FrameworkCoverage[]> {
	await requireVaultIndexed(app);
	// Reject conflicting note/table ownership rather than silently combining both forms.
	await discoverImportSets(app);
	return unmappedFrameworkEntries(await readVaultTree(app, '', { ignoreUnmanagedNotes: true }));
}
