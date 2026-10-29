/**
 * installed-frameworks.ts: which frameworks this vault holds, found by note
 * identity across the whole vault.
 *
 * One answer for every surface that reports frameworks: the status bar, the
 * workspace view's "Installed frameworks" list, and the graph color command.
 *
 * Two project rules shape it:
 * - Identity, never path. A framework is any group of producer-stamped
 *   concept notes sharing a curie prefix, wherever they live. Earlier
 *   discovery looked only under the output folder setting, so a vault built by
 *   the command line or the demo builder (which writes to its recipe's folder,
 *   with no plugin settings) reported "no frameworks yet".
 * - Cache lag is not absence. While any Markdown file has no metadata cache
 *   entry yet, the answer is "indexing", never an empty list.
 */

import type { App, TFile } from 'obsidian';
import {
	deriveInstalledOntologiesFromNotes,
	identityFactsFromFrontmatter,
	type InstalledOntologySummary,
	type MinimalVaultNode,
} from '../views/workspace-view-helpers';

export type InstalledFrameworksResult =
	| { state: 'indexing'; pending: number }
	| { state: 'ready'; frameworks: InstalledOntologySummary[] };

/** The slice of a metadata cache entry discovery reads. */
export interface DiscoveryCacheEntry {
	frontmatter?: unknown;
	frontmatterLinks?: readonly unknown[];
}

/**
 * Pure core: discovery over a file list and a cache lookup. A file whose cache
 * lookup returns null or undefined is not indexed yet.
 */
export function discoverFrameworksFromCache(
	files: readonly { path: string; name: string }[],
	getCache: (file: { path: string; name: string }) => DiscoveryCacheEntry | null | undefined,
): InstalledFrameworksResult {
	const notes: MinimalVaultNode[] = [];
	let pending = 0;
	for (const file of files) {
		const cache = getCache(file);
		if (!cache) {
			pending += 1;
			continue;
		}
		const facts = identityFactsFromFrontmatter(cache.frontmatter);
		if (!facts.producerKind || !facts.ontologyId) continue;
		notes.push({ path: file.path, name: file.name, ...facts, linkCount: cache.frontmatterLinks?.length ?? 0 });
	}
	if (pending > 0) return { state: 'indexing', pending };
	return { state: 'ready', frameworks: deriveInstalledOntologiesFromNotes(notes) };
}

/** Discover the frameworks in this vault from Obsidian's metadata cache. */
export function discoverInstalledFrameworks(app: App): InstalledFrameworksResult {
	const files = app.vault.getMarkdownFiles();
	return discoverFrameworksFromCache(files, (file) => app.metadataCache.getFileCache(file as TFile));
}
