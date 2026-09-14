/**
 * identity-index.ts — resolve a Crosswalker note by WHAT IT IS, not where it sits.
 *
 * Every generated note carries `curie` in its frontmatter. Until now, generation
 * found existing notes by PATH (`getAbstractFileByPath`), with one hard-coded
 * alternative shape consulted when enrichment is on. That works right up until an
 * address changes for any reason the path rule does not anticipate — a renamed
 * output folder, a user-chosen destination, a changed layout — at which point the
 * re-import cannot see the existing note and writes a second one beside it.
 *
 * Path patterns are guesses about a note; the curie is a fact about it. This index
 * makes identity the join key, so a re-import becomes a reconciliation between the
 * identities a source produces and the identities a vault already holds.
 *
 * Decision: re-import is identity reconciliation, not path migration (2026-08-21).
 *
 * SCOPE GUARD — the index only ever admits notes carrying a `_crosswalker`
 * provenance block. A note a user wrote by hand is structurally unreachable from
 * here, so reconciliation can never move, rewrite, or orphan it.
 *
 * COST — one pass over the vault's markdown list per generation run, reading
 * frontmatter from Obsidian's own metadata cache, plus a raw read of the files the
 * cache has not indexed yet (normally none). No second index of the vault is built;
 * this reuses the index Obsidian already maintains for every plugin.
 */

import { App, parseYaml, TFile } from 'obsidian';

/** A curie claimed by more than one note. Ambiguous: identity must be unique. */
export interface IdentityCollision {
	curie: string;
	paths: string[];
}

/**
 * What is known about the note at one vault address, for ownership purposes.
 *
 * AM-19 (2026-08-31). `'unreadable'` is a state of its own: the note exists and
 * was looked at, and nothing could be read off it. It is deliberately NOT
 * expressible as `{ importSetId: null }` (which means "a Crosswalker note from
 * before import sets existed", a different thing a user does something different
 * about) and NOT as the index's `null` (which means "not Crosswalker's").
 */
export type AddressStamp = { importSetId: string | null } | 'unreadable';

export interface IdentityIndex {
	/** The note currently holding this curie, or null if the vault has none. */
	get(curie: string): TFile | null;
	/**
	 * The import set that owns the note holding this curie, or null when the vault
	 * has no such note or the note carries no import-set stamp.
	 *
	 * AM-12 (2026-08-30). A vault-wide index is used for DETECTION: a run must be
	 * able to say WHO already claims an identity before it decides not to write it.
	 * Naming the owning set is what turns a refused row from "something is in the
	 * way" into an error a user can act on.
	 */
	owner(curie: string): string | null;
	/**
	 * AM-14 (2026-08-30). What sits at a vault ADDRESS, as far as ownership goes.
	 *
	 * Returns the note's import-set stamp (`{ importSetId }`, with a null id for a
	 * note carrying provenance but no `import_set` block), the string
	 * `'unreadable'` when the note was seen but nothing could be read off it, or
	 * null when the path holds no `_crosswalker` provenance at all — which the
	 * caller reads as "not Crosswalker's" only for a path it has already
	 * established holds a file.
	 *
	 * AM-19 (2026-08-31). `'unreadable'` is the fourth answer, and it is not a
	 * shade of null. A note whose properties will not parse may be owned by this
	 * very set; saying "not Crosswalker's, move or rename it" about a user's own
	 * imported note is a false cause attached to a destructive-sounding
	 * instruction. Absence of a fact is never a fact.
	 *
	 * Failure mode prevented: the address branch of write resolution adopting a
	 * note it does not own. Identity is not the only route into a note; the
	 * rendered address is the last one, and it was unguarded. Answered from THIS
	 * pass rather than by a fresh `getFileCache` at the call site, because that
	 * read has no raw-frontmatter fallback: a cache-cold owned note would read as
	 * "not Crosswalker's" and the ordinary re-import would refuse itself.
	 *
	 * Only provenance-carrying notes are held, so this costs nothing per plain
	 * user note.
	 */
	provenanceAt(path: string): AddressStamp | null;
	/** Every curie the index holds — the vault side of a reconciliation. */
	curies(): string[];
	/** Curies held by more than one note. Non-empty means the vault is ambiguous. */
	collisions: IdentityCollision[];
	/** Count of distinct curies indexed. */
	size: number;
}

export interface BuildIdentityIndexOptions {
	/** Restrict to notes owned by one durable import set. */
	importSetId?: string;
	/**
	 * @deprecated Recipe ids name reusable instructions, not ownership. Retained
	 * for one release of compatibility. When importSetId is present it takes
	 * precedence, so unstamped legacy notes remain outside every ownership set.
	 */
	recipeId?: string;
}

/** Read a plain string frontmatter value, or null when absent/blank/non-string. */
function readString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * AM-19 (2026-08-31). Three outcomes, never two.
 *
 * `none` is a FACT about the file: it has no frontmatter block, so it carries no
 * provenance and is nobody's. `unreadable` is the absence of a fact: the bytes
 * could not be read, or the block is there but will not parse, so nothing at all
 * is known about who owns it. Collapsing the second into the first is what let a
 * damaged note the run genuinely owns be reported as "not Crosswalker's. Move or
 * rename that note." See `project_cache_lag_is_not_absence` - this is the same
 * rule one level up, and its sixth appearance.
 */
type RawFrontmatter =
	| { state: 'ok'; frontmatter: Record<string, unknown> }
	| { state: 'none' }
	| { state: 'unreadable' };

/**
 * Frontmatter straight from the file, for a note Obsidian has not indexed yet.
 * Malformed YAML is reported as `unreadable` rather than thrown: one corrupt
 * note anywhere in the vault must not be able to block every import, and it must
 * not be silently reclassified as a note that has no properties either.
 */
async function readRawFrontmatter(app: App, file: TFile): Promise<RawFrontmatter> {
	let content: string;
	try {
		content = await app.vault.cachedRead(file);
	} catch {
		return { state: 'unreadable' };
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return { state: 'none' };
	try {
		const parsed = parseYaml(match[1]);
		// A YAML document that is not a mapping is a properties block nothing can
		// be read out of, which is a failure to read, not an absence of properties.
		if (parsed === null || parsed === undefined) return { state: 'none' };
		if (typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable' };
		return { state: 'ok', frontmatter: parsed as Record<string, unknown> };
	} catch {
		return { state: 'unreadable' };
	}
}

/**
 * Build a curie -> file index over the Crosswalker-generated notes in the vault.
 *
 * Deterministic on collision: the first file encountered wins `get()`, and every
 * claimant is recorded in `collisions` so a caller can refuse to proceed rather
 * than silently pick one. Callers SHOULD treat a non-empty `collisions` as an
 * error — writing through an ambiguous identity is how duplicates become
 * permanent.
 */
export async function buildIdentityIndex(app: App, options: BuildIdentityIndexOptions = {}): Promise<IdentityIndex> {
	const byCurie = new Map<string, TFile>();
	const ownerByCurie = new Map<string, string>();
	const claims = new Map<string, string[]>();
	// AM-14. Address -> import-set stamp, for every provenance-carrying note in the
	// vault. Recorded BEFORE the ownership and curie filters below, because the
	// address question is "who owns the note at this path", which a filtered index
	// by construction cannot answer about the sets it excluded.
	const stampByPath = new Map<string, AddressStamp>();

	for (const file of app.vault.getMarkdownFiles()) {
		let fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
			// A null metadata cache means "Obsidian has not indexed this file yet",
			// never "this file has no properties". Treating lag as absence is what
			// makes a re-import miss the note that already holds an identity and
			// write a second one beside it, permanently. Costs one read per
			// not-yet-indexed file, which is normally zero.
			const raw = await readRawFrontmatter(app, file);
			if (raw.state === 'unreadable') {
				// AM-19. Recorded, not skipped. This note may be one this run owns;
				// nothing here can tell, and the honest answer to "whose is it" is
				// "we could not read it" rather than "not ours".
				stampByPath.set(file.path, 'unreadable');
				continue;
			}
			if (raw.state === 'none') continue;
			fm = raw.frontmatter;
		}

		// Scope guard: no provenance block means the note is not ours to reconcile.
		const provenance = (fm as Record<string, unknown>)._crosswalker;
		if (provenance === undefined) continue;
		if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
			// AM-19. The key is THERE and its value is not a provenance block: a hand
			// edit turned it into a string, a list, or null. That is a damaged
			// Crosswalker note, not a stranger's note, so it gets the same "fix this
			// note" answer rather than "move or rename that note".
			stampByPath.set(file.path, 'unreadable');
			continue;
		}

		// Read once, whether or not this build filters on it: `owner()` reports it
		// for every indexed curie, and a second read of the same block would be a
		// second place for the shape of the provenance to be assumed.
		const importSetBlock = (provenance as Record<string, unknown>).import_set;
		const importSetId = importSetBlock && typeof importSetBlock === 'object'
			? readString((importSetBlock as Record<string, unknown>).id)
			: null;

		// AM-14. Recorded for every Crosswalker note, curie or not: a note with no
		// curie still occupies an address, and adopting it would cross exactly the
		// same boundary as adopting one that has a curie.
		stampByPath.set(file.path, { importSetId });

		if (options.importSetId !== undefined) {
			if (importSetId !== options.importSetId) continue;
		} else if (options.recipeId !== undefined) {
			const recipe = (provenance as Record<string, unknown>).recipe;
			const id = recipe && typeof recipe === 'object'
				? readString((recipe as Record<string, unknown>).id)
				: null;
			if (id !== options.recipeId) continue;
		}

		const curie = readString((fm as Record<string, unknown>).curie);
		if (!curie) continue;

		const existing = claims.get(curie);
		if (existing) {
			existing.push(file.path);
		} else {
			claims.set(curie, [file.path]);
			byCurie.set(curie, file);
			// The FIRST claimant, matching `get()`. A collision is reported rather
			// than arbitrated, so the two stay consistent with each other.
			if (importSetId) ownerByCurie.set(curie, importSetId);
		}
	}

	const collisions: IdentityCollision[] = [];
	for (const [curie, paths] of claims) {
		if (paths.length > 1) collisions.push({ curie, paths: [...paths].sort() });
	}
	collisions.sort((a, b) => a.curie.localeCompare(b.curie));

	return {
		get: (curie: string) => byCurie.get(curie) ?? null,
		owner: (curie: string) => ownerByCurie.get(curie) ?? null,
		provenanceAt: (path: string) => stampByPath.get(path) ?? null,
		curies: () => [...byCurie.keys()],
		collisions,
		size: byCurie.size,
	};
}

/**
 * Classify one source-produced identity against the vault, given its desired
 * address. This is the whole reconciliation vocabulary in one place.
 *
 * `keep-in-place` exists for a real case rather than as a hedge: enrichment
 * deliberately relocates a concept to its folder-note shape, so a note sitting at
 * a Crosswalker-chosen alternative address is where it is SUPPOSED to be. Moving
 * it back would fight the pass that put it there.
 */
export type ReconcileAction = 'create' | 'merge-in-place' | 'move-then-merge' | 'keep-in-place';

export interface Reconciliation {
	action: ReconcileAction;
	/** The note holding this identity today, when one exists. */
	existingFile: TFile | null;
	/** Where the note should end up. Equals the current path unless moving. */
	writePath: string;
}

export function reconcile(
	index: IdentityIndex,
	curie: string,
	desiredPath: string,
	isAcceptableAlternatePath?: (currentPath: string, desiredPath: string) => boolean,
): Reconciliation {
	const existingFile = index.get(curie);
	if (!existingFile) return { action: 'create', existingFile: null, writePath: desiredPath };

	if (existingFile.path === desiredPath) {
		return { action: 'merge-in-place', existingFile, writePath: desiredPath };
	}

	if (isAcceptableAlternatePath?.(existingFile.path, desiredPath)) {
		return { action: 'keep-in-place', existingFile, writePath: existingFile.path };
	}

	return { action: 'move-then-merge', existingFile, writePath: desiredPath };
}
