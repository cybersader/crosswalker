import type { App } from 'obsidian';
import { readNoteFrontmatterState } from '../export/vault-reader';
import type { IdentityIndex } from './identity-index';

const DIGEST = /^sha256-[a-f0-9]{64}$/;

/**
 * Choose one provenance hash before any writes. Old kept copies can spell out
 * defaults while having the same canonical document digest. A single verified
 * set-wide stamp must also reach NEW rows and synthetic hubs; preserving hashes
 * during each note's merge instead splits an extended set into two revisions.
 * Missing, conflicting or changed stamps never establish equivalence.
 */
export async function recipeHashForRun(
	app: App, owned: IdentityIndex, recipeId: string, documentDigest: string | undefined, freshHash: string,
): Promise<string> {
	if (!documentDigest || !DIGEST.test(documentDigest) || owned.collisions.length) return freshHash;
	const hashes = new Set<string>();
	for (const curie of owned.curies()) {
		const file = owned.get(curie);
		if (!file) return freshHash;
		const read = await readNoteFrontmatterState(app, file);
		if (read.state !== 'ok') return freshHash;
		const provenance = read.frontmatter._crosswalker as {
			recipe?: { id?: unknown; hash?: unknown; recipe_document_digest?: unknown };
		} | undefined;
		const stamp = provenance?.recipe;
		if (stamp?.id !== recipeId || stamp.recipe_document_digest !== documentDigest
			|| typeof stamp.hash !== 'string' || !DIGEST.test(stamp.hash)) return freshHash;
		hashes.add(stamp.hash);
	}
	return hashes.size === 1 ? [...hashes][0] : freshHash;
}
