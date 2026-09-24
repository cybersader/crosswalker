import { plural } from '../utils/plural';
import type { App } from 'obsidian';
import { buildIdentityIndex, type IdentityIndex } from './identity-index';

export interface UnresolvedEndpoint {
	curie: string;
	cause: 'not in vault' | 'ambiguous identity';
}

/** Resolve against provenance-stamped CURIEs, never a guessed address or filename. */
export async function edgeEndpointIndex(app: App): Promise<{ index: IdentityIndex; unreadable: number }> {
	const index = await buildIdentityIndex(app);
	const unreadable = app.vault.getMarkdownFiles().filter((file) => index.provenanceAt(file.path) === 'unreadable').length;
	return { index, unreadable };
}

const collisionCache = new WeakMap<IdentityIndex, Set<string>>();
function collisionsOf(index: IdentityIndex): Set<string> {
	let set = collisionCache.get(index);
	if (!set) {
		set = new Set(index.collisions.map((entry) => entry.curie));
		collisionCache.set(index, set);
	}
	return set;
}

export function resolveEdgeEndpoints(
	index: IdentityIndex,
	row: Record<string, unknown>,
): { subject_note: string; object_note: string; edge_body: string; unresolved: UnresolvedEndpoint[] } {
	const unresolved: UnresolvedEndpoint[] = [];
	const collisions = collisionsOf(index);
	const resolve = (curie: string): string => {
		const file = collisions.has(curie) ? null : index.get(curie);
		if (!file) {
			unresolved.push({ curie, cause: collisions.has(curie) ? 'ambiguous identity' : 'not in vault' });
			return '';
		}
		const withoutExtension = file.path.replace(/\.md$/i, '');
		const basename = withoutExtension.split('/').pop()!;
		return `[[${withoutExtension}|${basename}]]`;
	};
	const subject = String(row.subject_id ?? '');
	const object = String(row.object_id ?? '');
	const subject_note = resolve(subject);
	const object_note = resolve(object);
	const predicate = String(row.predicate_id ?? 'intersects_with');
	const edge_body = `${subject_note || `\`${subject}\``} ${predicate} ${object_note || `\`${object}\``}`;
	return { subject_note, object_note, edge_body, unresolved };
}

/**
 * Each missing end is retained on its edge; this summary tells the user how to connect it later.
 * Counts are distinct concepts, so the headline and the per-cause lines agree.
 */
export function summarizeUnresolvedEndpoints(endpoints: UnresolvedEndpoint[], unreadableNotes = 0): string[] {
	if (endpoints.length === 0) return [];
	const distinct = new Map<string, UnresolvedEndpoint['cause']>();
	for (const { curie, cause } of endpoints) distinct.set(curie, cause);
	const messages = [`${plural(distinct.size, 'mapping endpoint')} could not link to concepts in this vault. The edge notes were kept.`];
	const groups = new Map<string, number>();
	for (const [curie, cause] of distinct) {
		const ontology = curie.includes(':') ? curie.split(':', 1)[0] : 'unknown ontology';
		const key = `${cause}\u0000${ontology}`;
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}
	for (const [key, count] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		const [cause, ontology] = key.split('\u0000');
		const action = cause === 'ambiguous identity'
			? `Resolve duplicate ${ontology} concept CURIEs, then explicitly refresh the mapping import.`
			: `Import ${ontology} concepts at the needed detail, then explicitly refresh the mapping import.`;
		messages.push(`${plural(count, `${ontology} endpoint`)}: ${cause}. ${action}`);
	}
	if (unreadableNotes > 0) {
		messages.push(`${plural(unreadableNotes, 'note')} in this vault have properties that could not be read, so some of these concepts may already exist. Fix the properties on those notes, then explicitly refresh the mapping import.`);
	}
	return messages;
}
