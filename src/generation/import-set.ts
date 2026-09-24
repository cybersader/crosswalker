/**
 * import-set.ts — durable ownership for one import's vault footprint.
 *
 * An import set is the collection of notes one import owns. Its id is minted,
 * never derived from a recipe, destination, or source: all three can change on
 * a legitimate refresh. Markdown provenance is the registry; discovery prefers
 * Obsidian's metadata cache and reads cache-cold destination frontmatter directly.
 */

import { App, normalizePath, parseYaml, TFile } from 'obsidian';
import { slugifyForCurie } from './curie';
import { normalizeFolderSetting } from '../settings/folder-settings';
import { IDENTITY_SENTINELS } from './legacy-recipe-shim';
import type { KnownSource } from '../import/vault-source-scan';
import type { NestedRecordLevel } from '../types/generated/recipe';

export const IMPORT_SET_ID_PATTERN = /^iset-[a-z0-9]{6}$/;
export const IMPORT_SET_SCHEMES = ['endpoint-v1', 'set-qualified-v1'] as const;
export type ImportSetScheme = typeof IMPORT_SET_SCHEMES[number];

/** Default for callers that do not deliberately choose a scheme. Kept at
 * endpoint-v1 so every pre-existing import path preserves its identities. */
export const CURRENT_IMPORT_SET_SCHEME: ImportSetScheme = 'endpoint-v1';

/**
 * AM-27 (2026-08-31). HOW a set turns a source row into a CURIE local part.
 *
 * Pinned per set for exactly the reason `scheme` and `ontology` are: a run that
 * derives identities differently from the run that wrote the notes recognises
 * none of them, so it writes a second copy of the whole import and reports every
 * original as an orphan. Changing a derivation rule in place is therefore not a
 * bug fix, it is a vault-wide re-identification.
 *
 * - `filename-stem-v1` is the rule shipped since v0.1.0: the leaf filename stem
 *   passed through the FILESYSTEM sanitizer. It is many-to-one (`AC 2` and
 *   `AC-2` and `AC/2` all land on one curie) and it rewrites even a declared
 *   `curie` column. It is kept, byte-exact and forever, because it is a recorded
 *   fact about the notes already in people's vaults.
 * - `declared-facts-v1` is the rule every NEW set mints under: the source's own
 *   declared identity first, the filename stem only as a last resort, and any
 *   sanitization that does happen is injective.
 */
export const IMPORT_SET_DERIVATIONS = ['filename-stem-v1', 'declared-facts-v1'] as const;
export type ImportSetDerivation = typeof IMPORT_SET_DERIVATIONS[number];

/**
 * What an UNSTAMPED set derives under. Absence is not "unknown", it is a fact:
 * every note written before this pin existed was written by the legacy rule.
 */
export const LEGACY_IMPORT_SET_DERIVATION: ImportSetDerivation = 'filename-stem-v1';

/** What a new mint pins itself to. */
export const CURRENT_IMPORT_SET_DERIVATION: ImportSetDerivation = 'declared-facts-v1';

/**
 * The derivation a run must use. One reader, so no call site invents its own
 * default and re-identifies a legacy vault by omission.
 */
export function derivationOf(reference?: Pick<ImportSetReference, 'derivation'>): ImportSetDerivation {
	return reference?.derivation ?? LEGACY_IMPORT_SET_DERIVATION;
}

export interface ImportSetReference {
	id: string;
	scheme: ImportSetScheme;
	/** Framework import set whose run produced these crosswalk edges; absent otherwise. */
	parent_set?: string;
	/**
	 * The destination folder this set was last written to. Recorded rather than
	 * inferred: a refresh that cannot look up where its set already lives has to
	 * guess from a derived default, and a guess that disagrees with reality
	 * writes a second copy of the whole import beside the first. Optional because
	 * every note written before this existed has no stamp; those sets fall back
	 * to `recoverImportSetRoot`.
	 *
	 * A hint, never authority. Nothing reconciles it when a user renames the
	 * folder in the file explorer, so a reader must re-validate it against the
	 * set's actual note paths before writing anything there.
	 */
	destination?: string;
	/**
	 * AM-6. The ontology this set's curies are minted under, pinned at mint the
	 * same way `scheme` is.
	 *
	 * Failure mode prevented: a refresh recomputing the ontology from the run's
	 * own recipe and getting a different answer from the one the set's notes
	 * already carry. Every existing note then falls outside the run's identity
	 * index, so the run writes a second copy of the whole framework beside the
	 * first and reports every original as an orphan.
	 *
	 * Optional because notes written before this existed carry no pin. Such a
	 * set is pinned on its first refresh to the ontology prefix its own notes
	 * already show, because the notes are the fact.
	 */
	ontology?: string;
	/**
	 * AM-27. The identity-derivation rule this set is pinned to, stamped at mint
	 * beside `scheme` and `ontology`.
	 *
	 * Failure mode prevented: fixing the derivation rule for everyone. The legacy
	 * rule runs a concept's identity through a filename sanitizer, which is
	 * many-to-one; replacing it globally would give every note in every existing
	 * vault a new curie, so the next refresh would match nothing it owns, write a
	 * duplicate framework, and orphan the original.
	 *
	 * Absent means `filename-stem-v1` (see `derivationOf`). Absence is the
	 * recorded state of every set minted before this pin, not a missing answer.
	 */
	derivation?: ImportSetDerivation;
	/**
	 * AM-27. The identity mode of every nested-record level, pinned when the set
	 * is minted beside `derivation`.
	 *
	 * Failure mode prevented: a refresh reading an edited recipe that changes one
	 * level from global identity to path identity, or back again. That edit gives
	 * every note at the level a different CURIE, so the refresh recognises none of
	 * the notes it owns, writes duplicates, and reports the originals as orphans.
	 *
	 * Optional because sets minted before nested identity was pinned carry no map.
	 * Absence means every level is `global`; a refresh must keep that legacy fact.
	 */
	nest_identity?: Record<string, 'global' | 'path'>;
}

export type ImportSetOption =
	| { id: string; scheme?: ImportSetScheme; parent_set?: string }
	| 'new'
	| 'new-set-qualified';

export interface DiscoveredImportSet extends ImportSetReference {
	noteCount: number;
	paths: string[];
	/**
	 * Where this set's notes actually live: the recorded destination when it is
	 * still consistent with those notes, otherwise recovered from them, otherwise
	 * null. Null means "refuse to guess", which is the correct answer when the
	 * set's notes do not share a root.
	 */
	root: string | null;
	/**
	 * Every distinct `_crosswalker.recipe.id` stamped on this set's notes, sorted.
	 *
	 * A set legitimately holds more than one: a refresh through a renamed or
	 * re-saved recipe restamps only the notes it rewrites, and a set that was
	 * seeded by one recipe and extended by another is a real state, not a fault.
	 * Membership, therefore, not equality: a source matches a set when the set
	 * carries that recipe id anywhere, which is the question a caller is actually
	 * asking ("has this source written here before?").
	 */
	recipeIds: string[];
	/** Distinct producing framework set ids stamped on this set's notes, sorted. */
	parentSets?: string[];
	/** Recipe hashes stamped by owned notes. An ambiguous or absent hash blocks stack refresh. */
	recipeHashes?: string[];
	/**
	 * Every distinct ontology prefix (the part of a note's `curie` before the
	 * colon) stamped on this set's notes, sorted. The second half of the same
	 * question, for a set whose recipe was renamed between imports: the ontology
	 * prefix is a pure function of the source, so it survives a recipe rename.
	 */
	ontologyPrefixes: string[];
	/** Distinct source file/hash pairs recorded by this set, newest observation per pair. */
	sources: Array<{
		file: string | null;
		sourceHash: string | null;
		producedAt: string | null;
	}>;
}

interface ImportSetObservation {
	id: string;
	scheme: string | null;
	path: string;
	destination: string | null;
	recipeId: string | null;
	recipeHash: string | null;
	ontologyPrefix: string | null;
	/** The ontology pinned in this note's import_set block, if any (AM-6). */
	ontology: string | null;
	/** The derivation pinned in this note's import_set block, if any (AM-27). */
	derivation: string | null;
	parentSet: string | null;
	/** Nested level identity modes pinned in this note's import_set block, if any. */
	nestIdentity: Record<string, 'global' | 'path'> | null;
	/** Source provenance stamped beside the import-set ownership block. */
	sourceFile: string | null;
	sourceHash: string | null;
	producedAt: string | null;
}

/** Stored import-set provenance is malformed or disagrees within one set. */
export class ImportSetProvenanceError extends Error {
	constructor(message: string, public readonly paths: string[]) {
		super(message);
		this.name = 'ImportSetProvenanceError';
	}
}

/**
 * Discover import sets represented by notes below one destination folder.
 * Notes with no import_set stamp are legacy and deliberately stay outside all
 * sets. They remain valid and can never become orphans by inference.
 */
export async function discoverImportSets(app: App, basePath?: string): Promise<DiscoveredImportSet[]> {
	return buildDiscoveredSets(await collectObservations(app, basePath));
}

/** Flatten discovered source provenance for vault-source reconciliation. */
export function knownSourcesOf(sets: readonly DiscoveredImportSet[]): KnownSource[] {
	return sets.flatMap((set) => set.sources.map((source) => ({
		setId: set.id,
		...source,
	})));
}

/**
 * Every form a placeholder identity can reach a prefix comparison in.
 *
 * The literals live at their mint site (`legacy-recipe-shim.ts`) and are
 * imported, never retyped: a second copy is a copy that drifts, and a drifted
 * copy silently re-admits the placeholder. Both the raw and the slugified form
 * are covered because an ontology reaches this test after `slugifyForCurie` -
 * that is how it is compared against stamped curies.
 */
const IDENTITY_SENTINEL_FORMS: ReadonlySet<string> = new Set([
	...IDENTITY_SENTINELS,
	...IDENTITY_SENTINELS.map((value) => slugifyForCurie(value)),
]);

/**
 * AM-24 (2026-08-31). What a decision surface says when it cannot see the vault.
 *
 * One message, so no caller invents its own wording for the same state.
 */
export const VAULT_STILL_INDEXING_MESSAGE =
	'Obsidian is still indexing your vault. Wait a moment, then run this again.';

/** Thrown by any rule that refuses to answer from a half-read vault. */
export class VaultStillIndexingError extends Error {
	constructor(message: string = VAULT_STILL_INDEXING_MESSAGE) {
		super(message);
		this.name = 'VaultStillIndexingError';
	}
}

/**
 * Markdown files Obsidian has not finished parsing yet.
 *
 * `getFileCache` returns null both for a file with no frontmatter and for one
 * the metadata cache has not reached, so this is the only way to tell "the vault
 * holds nothing" from "the vault has not been read yet". Found by screenshotting
 * the evidence window against a real vault mid-index, where it claimed an
 * imported vault had no controls.
 *
 * A host that exposes neither the file list nor the cache cannot be measured at
 * all; that answers 0 rather than blocking every caller on an unmeasurable
 * environment. Real Obsidian always exposes both.
 */
export function countUnindexedMarkdownFiles(app: App): number {
	const getMarkdownFiles = app.vault?.getMarkdownFiles?.bind(app.vault);
	const getFileCache = app.metadataCache?.getFileCache?.bind(app.metadataCache);
	if (!getMarkdownFiles || !getFileCache) return 0;
	let unindexed = 0;
	for (const file of getMarkdownFiles()) {
		if (!getFileCache(file)) unindexed += 1;
	}
	return unindexed;
}

/**
 * Wait for Obsidian's metadata cache to drain, then RE-CHECK.
 *
 * A `resolved` event can arrive while newly generated notes are still pending.
 * Keep checking until every file has a cache entry or the deadline expires;
 * never treat the event itself as proof that indexing finished. Polling also
 * covers hosts that do not emit `resolved` for an individual file.
 */
export async function settleVaultIndex(app: App, timeoutMs = 4000): Promise<number> {
	const initial = countUnindexedMarkdownFiles(app);
	if (initial === 0 || timeoutMs <= 0) return initial;
	const on = app.metadataCache?.on?.bind(app.metadataCache);
	const offref = app.metadataCache?.offref?.bind(app.metadataCache);
	const deadline = Date.now() + timeoutMs;
	return new Promise<number>((resolve, reject) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ref: ReturnType<NonNullable<typeof on>> | undefined;
		const finish = (pending: number, error?: unknown) => {
			if (done) return;
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			if (ref && offref) {
				try { offref(ref); } catch { /* optional host subscription cleanup */ }
			}
			if (error !== undefined) reject(error);
			else resolve(pending);
		};
		const check = () => {
			if (done) return;
			let pending: number;
			try { pending = countUnindexedMarkdownFiles(app); }
			catch (error) { finish(0, error); return; }
			if (pending === 0 || Date.now() >= deadline) { finish(pending); return; }
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(check, Math.min(100, deadline - Date.now()));
		};
		try { if (on && offref) ref = on('resolved', check); }
		catch (error) { finish(0, error); return; }
		check();
	});
}

/**
 * AM-24. Refuse to answer at all while the vault is half-read.
 *
 * Failure mode prevented: cache lag read as fact, SEVENTH appearance. Every
 * vault-wide rule here reads the metadata cache, and whole-vault discovery has
 * no raw-frontmatter fallback (deliberately, so it never becomes a whole-vault
 * content scan). A cold cache therefore shows a vault with fewer sets than it
 * has, and the qualification rule answers "nothing collides" about a vault it
 * never saw - minting an unqualified set into an occupied curie space, whereupon
 * every row is correctly refused and the user sees "0 notes created, N refused"
 * with no cause.
 *
 * The precondition lives INSIDE the rule rather than in its callers, because
 * callers forgetting it is exactly how the rule acquired three copies in the
 * first place. Both command-palette entry points can be fired during startup
 * indexing.
 */
export async function requireVaultIndexed(app: App): Promise<void> {
	if (await settleVaultIndex(app) > 0) throw new VaultStillIndexingError();
}

/**
 * AM-18 (2026-08-31). WHICH new set to mint: the ONE implementation.
 *
 * Would a new set minted for this source write curies into a space an existing
 * set already occupies? If so it is minted `set-qualified-v1`, so two releases of
 * one framework - or two crosswalks over one pair - coexist by construction
 * instead of meeting as an AM-12 collision on every row. `endpoint-v1` stays the
 * answer when nothing collides, so every pre-existing import path keeps the
 * identities it already wrote.
 *
 * Failure mode prevented: three copies of one rule, two of them wrong. Before
 * this, the wizard compared whole-vault ontology prefixes, the crosswalk modal
 * asked whether one folder was empty, and the dev fixture command asked nothing
 * at all. A folder is an ADDRESS, and this project's own rule is that an address
 * does not name an owner: move an earlier crosswalk's folder with a drag and the
 * folder-emptiness copy mints an unqualified set straight into the moved set's
 * curie space. One function, so the rule cannot disagree with itself.
 *
 * The signal is a shared REAL ontology prefix. The prefix is the whole left half
 * of every curie the source produces, and discovery carries the prefixes existing
 * sets' notes actually show, so this compares stamped fact against stamped fact.
 * A sentinel prefix is not a fact about anything (it is what a nameless classic
 * import stamps) and an unbuildable source has no prefix at all; both signal
 * nothing and degrade to the plain default.
 *
 * Deliberately compares against `ontologyPrefixes` (what the notes hold) and NOT
 * against a set's pinned `ontology`: a set already minted set-qualified carries
 * the unqualified ontology as its pin while its notes carry the qualified prefix,
 * and it is the notes that decide whether a space is taken.
 *
 * @param sets  Sets discovered over the WHOLE vault. A destination-scoped list
 *              answers a different question and must not be passed here.
 * @param ontologyPrefix  Already slugified (`slugifyForCurie`), or null when the
 *              source cannot produce one.
 */
export function newSetSchemeFrom(
	sets: readonly DiscoveredImportSet[],
	ontologyPrefix: string | null,
): 'new' | 'new-set-qualified' {
	if (ontologyPrefix === null || IDENTITY_SENTINEL_FORMS.has(ontologyPrefix)) return 'new';
	return sets.some((set) => set.ontologyPrefixes.includes(ontologyPrefix)) ? 'new-set-qualified' : 'new';
}

/**
 * AM-18. The same rule for a caller that holds no discovered-set snapshot of its
 * own: discover the WHOLE vault, then answer.
 *
 * Whole-vault deliberately. A caller that scopes discovery to its destination is
 * asking "is that folder empty", which is the address question this amendment
 * exists to delete.
 */
export async function newSetSchemeFor(
	app: App,
	ontologyPrefix: string | null,
): Promise<'new' | 'new-set-qualified'> {
	// AM-24. The precondition is the FIRST thing, not a step inside the branch
	// that happens to read the vault. A caller cannot tell which branch it hit, so
	// a function that sometimes checks and sometimes does not is a function whose
	// contract nobody can state.
	await requireVaultIndexed(app);
	if (ontologyPrefix === null || IDENTITY_SENTINEL_FORMS.has(ontologyPrefix)) return 'new';
	return newSetSchemeFrom(await discoverImportSets(app, undefined), ontologyPrefix);
}

/**
 * Resolve the import set one generation run writes under. Shared by both
 * generation entry points.
 *
 * AM-9. Exactly two behaviours, and no third:
 *   - an explicit `{id, scheme}` refreshes THAT set (existing notes stay
 *     authoritative for its scheme and pinned ontology; an explicit id may name
 *     an empty or wiped set, and a caller that knows the fixed scheme may carry
 *     it, otherwise the backwards-compatible endpoint-v1 default applies)
 *   - anything else, `undefined` included, MINTS A NEW SET
 *
 * There is deliberately no "look at the destination and adopt what is there"
 * path. See the note above the mint below for why.
 */
export async function resolveImportSet(
	app: App,
	basePath: string,
	option?: ImportSetOption,
	/**
	 * AM-6. The ontology this run WOULD use if the set had never been imported
	 * before. A proposal only: an existing set's pin always wins, because a
	 * refresh that changes the ontology changes every curie it writes and
	 * therefore stops recognising the notes it owns.
	 */
	proposedOntology?: string,
	/** Nested identity declarations this run would pin if it mints a new set. */
	proposedNest?: readonly NestedRecordLevel[],
): Promise<ImportSetReference> {
	// Where this run writes is stamped onto every note it writes. Recorded, not
	// inferred: without it a later refresh has no way to ask where its own set
	// already lives, and has to fall back to a derived default that may point
	// somewhere else entirely. Re-stamped on every run rather than only at mint,
	// so a set that legitimately moves records its new home instead of keeping a
	// stale one.
	const destination = normalizeFolder(basePath ?? '') || undefined;
	const proposed = proposedOntology?.trim() || undefined;
	const stamp = (reference: ImportSetReference, ontology?: string): ImportSetReference => ({
		...reference,
		...(destination ? { destination } : {}),
		...(ontology ? { ontology } : {}),
	});

	// AM-27. A mint is the ONLY place the new derivation enters a vault. Every
	// other branch below either carries an existing set's pin forward or leaves
	// the field absent, which is the legacy rule. That is the whole safety
	// argument: no note that already exists can change identity.
	const mint = (scheme: ImportSetScheme): ImportSetReference => ({
		id: mintImportSetId(collectKnownIds(app)),
		scheme,
		derivation: CURRENT_IMPORT_SET_DERIVATION,
		...(proposedNest?.length ? { nest_identity: nestIdentityOf(proposedNest) } : {}),
	});

	if (option === 'new') {
		return stamp(mint(CURRENT_IMPORT_SET_SCHEME), proposed);
	}

	if (option === 'new-set-qualified') {
		return stamp(mint('set-qualified-v1'), proposed);
	}

	if (option && typeof option === 'object') {
		assertImportSetId(option.id);
		if (option.scheme !== undefined) assertImportSetScheme(option.scheme);
		if (option.parent_set !== undefined) assertImportSetId(option.parent_set);
		const observations = await collectObservations(app, undefined, option.id);
		const existing = buildDiscoveredSets(observations)[0];
		if (existing) {
			if (option.scheme !== undefined && option.scheme !== existing.scheme) {
				throw new ImportSetProvenanceError(
					`Import set ${option.id} is fixed to ${existing.scheme}; refresh cannot change it to ${option.scheme}.`,
					existing.paths,
				);
			}
			// AM-27. The set's own pin, re-stamped unchanged. An existing set is
			// refreshed under the rule its notes were written by, whatever this
			// version's current rule happens to be.
			return stamp(
				{
					id: existing.id,
					...(option.parent_set ? { parent_set: option.parent_set } : (existing.parentSets?.length === 1 ? { parent_set: existing.parentSets[0] } : {})),
					scheme: existing.scheme,
					...(existing.derivation ? { derivation: existing.derivation } : {}),
					...(existing.nest_identity ? { nest_identity: { ...existing.nest_identity } } : {}),
				},
				pinnedOntologyOf(existing, proposed),
			);
		}
		// AM-27. An explicit id whose notes this call did not see: emptied, wiped, or
		// - and this is the case that decides the branch - simply not in the metadata
		// cache yet. Whole-vault discovery has no raw-frontmatter fallback by design,
		// so "no observations" is NOT proof of "no notes". The derivation is therefore
		// left ABSENT, which is the legacy rule.
		//
		// Failure mode prevented: cache lag re-identifying a whole framework. Minting
		// the current rule here would, on a cold cache, give a legacy set's refresh a
		// derivation none of its existing notes were written under, so the run would
		// match nothing it owns and write a duplicate of the entire import. An
		// actually-empty set pays nothing for the caution: it has no notes to
		// re-identify, and the rows it writes are consistent with what it stamps.
		return stamp({ id: option.id, scheme: option.scheme ?? CURRENT_IMPORT_SET_SCHEME, ...(option.parent_set ? { parent_set: option.parent_set } : {}) }, proposed);
	}

	// AM-9. THE ENGINE HAS NO OPINION ABOUT WHAT IS IN THE FOLDER.
	//
	// A destination-discovery branch used to sit here: look at the folder, and if
	// exactly one set already lives there, refresh it. That was the original guess,
	// and every preselect deleted from the wizard and the crosswalk modal above it
	// was a copy of this one. It is deleted rather than narrowed.
	//
	// Failure mode prevented: writing one framework into another framework's set
	// with nobody having chosen it. A folder is an address, and an address does not
	// name an owner. Two frameworks legitimately share a legacy flat root; a
	// deterministic mapping folder holds crosswalks from two different providers; a
	// user drags a folder somewhere new. In each case the engine, asked to write
	// somewhere, would silently take over the notes it found and report the rows it
	// no longer produced as orphans, by which time the originals are overwritten.
	// The cost of the opposite mistake is a duplicate folder the user can see and
	// delete, so the default here is always the harmless one.
	//
	// Ownership is decided by the caller, on screen, by a click. The engine
	// executes that decision: an explicit {id, scheme} refreshes that set, and
	// anything else - undefined included - mints a new one.
	return stamp(mint(CURRENT_IMPORT_SET_SCHEME), proposed);
}

/**
 * AM-6. The ontology a refresh must mint curies under.
 *
 * Order: the stamped pin, else the one ontology prefix the set's own notes
 * already agree on (a legacy set predates the pin, and its notes are the fact),
 * else this run's proposal.
 *
 * Several disagreeing prefixes pin nothing. There is no single fact to recover
 * there, and inventing one would be the guess this whole design removes; the
 * behaviour in that case stays exactly what it was before AM-6.
 */
function pinnedOntologyOf(set: DiscoveredImportSet, proposed?: string): string | undefined {
	if (set.ontology) return set.ontology;
	if (set.ontologyPrefixes.length === 1) return set.ontologyPrefixes[0];
	return proposed;
}

/** Mint a meaningless crypto-random id, retrying if a vault already uses it. */
export function mintImportSetId(existingIds: ReadonlySet<string> = new Set()): string {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) {
		throw new Error('Secure random generation is unavailable; cannot mint an import set id.');
	}

	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	for (let attempt = 0; attempt < 100; attempt++) {
		const bytes = new Uint8Array(6);
		cryptoApi.getRandomValues(bytes);
		let suffix = '';
		for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
		const id = `iset-${suffix}`;
		if (!existingIds.has(id)) return id;
	}
	throw new Error('Could not mint a unique import set id after 100 attempts.');
}

async function collectObservations(app: App, basePath?: string, onlyId?: string): Promise<ImportSetObservation[]> {
	const observations: ImportSetObservation[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isWithinDestination(file.path, basePath)) continue;
		let fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if ((!fm || typeof fm !== 'object') && basePath !== undefined) {
			// Cache lag is not evidence that a destination has no owned notes. Read only
			// cache-cold files inside the destination so mint-vs-reuse stays correct
			// without turning discovery into a whole-vault raw-content scan.
			fm = await readRawFrontmatter(app, file);
		}
		if (!fm || typeof fm !== 'object' || Array.isArray(fm)) continue;
		const provenance = (fm as Record<string, unknown>)._crosswalker;
		if (!provenance || typeof provenance !== 'object') continue;
		const raw = (provenance as Record<string, unknown>).import_set;
		if (raw === undefined) continue;
		if (!raw || typeof raw !== 'object') {
			throw new ImportSetProvenanceError(`Invalid _crosswalker.import_set at ${file.path}: expected an object.`, [file.path]);
		}

		const id = readString((raw as Record<string, unknown>).id);
		// Explicit refresh validates only the named set. Corrupt provenance for an
		// unrelated set elsewhere in the vault cannot block this import.
		if (onlyId !== undefined && id !== onlyId) continue;
		const scheme = readString((raw as Record<string, unknown>).scheme);
		if (!id || !IMPORT_SET_ID_PATTERN.test(id)) {
			throw new ImportSetProvenanceError(`Invalid import set id at ${file.path}: expected iset- followed by 6 lowercase letters or digits.`, [file.path]);
		}
		const destination = readString((raw as Record<string, unknown>).destination);
		const ontology = readString((raw as Record<string, unknown>).ontology);
		const derivation = readString((raw as Record<string, unknown>).derivation);
		const parentSet = readString((raw as Record<string, unknown>).parent_set);
		const nestIdentity = readNestIdentity((raw as Record<string, unknown>).nest_identity, file.path);
		// Two stamped facts about WHAT produced this note, kept beside the ownership
		// id so a caller can ask "has this source written here before?" without
		// re-deriving anything from the note's address. Both are optional: a note
		// written by a producer that stamps neither simply contributes nothing.
		const provenanceRecord = provenance as Record<string, unknown>;
		const recipeBlock = provenanceRecord.recipe;
		const recipeId = recipeBlock && typeof recipeBlock === 'object'
			? readString((recipeBlock as Record<string, unknown>).id)
			: null;
		const sourceRef = provenanceRecord.source_ref;
		const sourceRecord = sourceRef && typeof sourceRef === 'object' && !Array.isArray(sourceRef)
			? sourceRef as Record<string, unknown>
			: null;
		observations.push({
			id,
			scheme,
			path: file.path,
			destination,
			recipeId,
			recipeHash: recipeBlock && typeof recipeBlock === 'object'
				? readString((recipeBlock as Record<string, unknown>).hash) : null,
			ontologyPrefix: curiePrefix(readString((fm as Record<string, unknown>).curie)),
			ontology,
			derivation,
			parentSet,
			nestIdentity,
			sourceFile: readString(sourceRecord?.file),
			sourceHash: readString(sourceRecord?.source_hash),
			producedAt: readString(provenanceRecord.produced_at),
		});
	}
	return observations;
}

async function readRawFrontmatter(app: App, file: TFile): Promise<Record<string, unknown> | undefined> {
	const content = await app.vault.cachedRead(file);
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return undefined;

	try {
		const parsed = parseYaml(match[1]);
		if (parsed === null || parsed === undefined) return undefined;
		if (typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('frontmatter root must be a mapping');
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImportSetProvenanceError(`Invalid frontmatter YAML at ${file.path}: ${detail}.`, [file.path]);
	}
}

function buildDiscoveredSets(observations: ImportSetObservation[]): DiscoveredImportSet[] {
	const byId = new Map<string, ImportSetObservation[]>();
	for (const observation of observations) {
		const group = byId.get(observation.id);
		if (group) group.push(observation);
		else byId.set(observation.id, [observation]);
	}

	const sets: DiscoveredImportSet[] = [];
	for (const [id, group] of byId) {
		const schemes = new Set(group.map((entry) => entry.scheme));
		const scheme = schemes.size === 1 ? group[0].scheme : null;
		if (schemes.size !== 1 || !isImportSetScheme(scheme)) {
			const paths = group.map((entry) => entry.path).sort();
			const details = group
				.map((entry) => `${entry.path} (${entry.scheme ?? 'missing scheme'})`)
				.sort()
				.join(', ');
			throw new ImportSetProvenanceError(`Import set ${id} has inconsistent or unsupported schemes: ${details}.`, paths);
		}
		const paths = group.map((entry) => entry.path).sort();
		const recorded = recordedDestination(group);
		const pinnedOntology = agreedOntology(group);
		const pinnedDerivation = agreedDerivation(id, group);
		const pinnedNestIdentity = agreedNestIdentity(id, group);
		sets.push({
			id,
			scheme,
			noteCount: paths.length,
			paths,
			root: resolveSetRoot(recorded, paths),
			recipeIds: distinctSorted(group.map((entry) => entry.recipeId)),
			...(group.some((entry) => entry.parentSet) ? { parentSets: distinctSorted(group.map((entry) => entry.parentSet)) } : {}),
			...(group.every((entry) => entry.recipeHash)
				? { recipeHashes: distinctSorted(group.map((entry) => entry.recipeHash)) } : {}),
			ontologyPrefixes: distinctSorted(group.map((entry) => entry.ontologyPrefix)),
			sources: sourceObservations(group),
			...(recorded ? { destination: recorded } : {}),
			...(pinnedOntology ? { ontology: pinnedOntology } : {}),
			...(pinnedDerivation ? { derivation: pinnedDerivation } : {}),
			...(pinnedNestIdentity ? { nest_identity: pinnedNestIdentity } : {}),
		});
	}
	sets.sort((a, b) => a.id.localeCompare(b.id));
	return sets;
}

function isImportSetScheme(value: unknown): value is ImportSetScheme {
	return typeof value === 'string' && (IMPORT_SET_SCHEMES as readonly string[]).includes(value);
}

function assertImportSetScheme(value: unknown): asserts value is ImportSetScheme {
	if (!isImportSetScheme(value)) {
		throw new Error(`Unsupported import set scheme: ${String(value)}.`);
	}
}

function collectKnownIds(app: App): Set<string> {
	// Collision avoidance may stay cache-only: a cold-cache miss creates only a
	// negligibly unlikely random-id collision risk and cannot change set selection.
	const ids = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		const provenance = fm && typeof fm === 'object'
			? (fm as Record<string, unknown>)._crosswalker
			: undefined;
		const raw = provenance && typeof provenance === 'object'
			? (provenance as Record<string, unknown>).import_set
			: undefined;
		const id = raw && typeof raw === 'object'
			? readString((raw as Record<string, unknown>).id)
			: null;
		if (id && IMPORT_SET_ID_PATTERN.test(id)) ids.add(id);
	}
	return ids;
}

function isWithinDestination(path: string, basePath?: string): boolean {
	if (basePath === undefined) return true;
	// S13 (2026-09-04). THE ONE NORMALIZER. This was the host's `normalizePath`
	// plus a redundant trailing-separator strip and no trim at all - a second
	// spelling, compared against fully normalized vault paths to decide which notes
	// a refresh believes belong to a destination. A normalization applied to what
	// you record must be applied to what you compare it against, through the SAME
	// function; S6 routed this module's other normalizer for exactly this reason
	// and missed this one.
	const destination = normalizeFolderSetting(basePath);
	if (!destination) return true;
	return path.startsWith(`${destination}/`);
}

function assertImportSetId(id: string): void {
	if (!IMPORT_SET_ID_PATTERN.test(id)) {
		throw new Error(`Invalid import set id "${id}": expected iset- followed by 6 lowercase letters or digits.`);
	}
}

function nestIdentityOf(nest: readonly NestedRecordLevel[]): Record<string, 'global' | 'path'> {
	return Object.fromEntries(nest.map((entry) => [entry.level, entry.identity ?? 'global']));
}

function readNestIdentity(value: unknown, path: string): Record<string, 'global' | 'path'> | null {
	if (value === undefined) return null;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ImportSetProvenanceError(
			`Invalid _crosswalker.import_set.nest_identity at ${path}: expected an object of level names to global or path.`,
			[path],
		);
	}
	const out: Record<string, 'global' | 'path'> = {};
	for (const [level, identity] of Object.entries(value as Record<string, unknown>)) {
		if (identity !== 'global' && identity !== 'path') {
			throw new ImportSetProvenanceError(
				`Invalid _crosswalker.import_set.nest_identity at ${path}: level ${level} must be global or path.`,
				[path],
			);
		}
		out[level] = identity;
	}
	return out;
}

function readString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** The ontology half of a curie (`nist-mini:AC-1` -> `nist-mini`), or null. */
function curiePrefix(curie: string | null): string | null {
	if (!curie) return null;
	const colon = curie.indexOf(':');
	if (colon <= 0) return null;
	return curie.slice(0, colon);
}

/** Distinct non-null values in a stable order, so two runs compare equal. */
function distinctSorted(values: readonly (string | null)[]): string[] {
	return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

/** Distinct source file/hash pairs, retaining the latest ISO produced_at per pair. */
function sourceObservations(group: readonly ImportSetObservation[]): DiscoveredImportSet['sources'] {
	const byPair = new Map<string, DiscoveredImportSet['sources'][number]>();
	for (const observation of group) {
		if (observation.sourceFile === null && observation.sourceHash === null) continue;
		const key = JSON.stringify([observation.sourceFile, observation.sourceHash]);
		const current = byPair.get(key);
		if (
			!current
			|| (observation.producedAt !== null
				&& (current.producedAt === null || observation.producedAt > current.producedAt))
		) {
			byPair.set(key, {
				file: observation.sourceFile,
				sourceHash: observation.sourceHash,
				producedAt: observation.producedAt,
			});
		}
	}
	return [...byPair.values()].sort((a, b) => {
		const byFile = (a.file ?? '').localeCompare(b.file ?? '');
		return byFile !== 0 ? byFile : (a.sourceHash ?? '').localeCompare(b.sourceHash ?? '');
	});
}

/**
 * The destination every member of a set agrees on, or null when they disagree
 * or none recorded one. Disagreement is not an error: a half-migrated set is a
 * real state, and the answer there is to fall back to what the paths show.
 */
function recordedDestination(group: readonly ImportSetObservation[]): string | null {
	const stamped = new Set(group.map((entry) => entry.destination).filter((d): d is string => d !== null));
	if (stamped.size !== 1) return null;
	return normalizeFolder([...stamped][0]);
}

/**
 * The ontology every member of a set agrees on, or null when they disagree or
 * none recorded one (AM-6). Disagreement reads as no pin at all: a set holding
 * two answers has no single fact to carry forward, and picking one would be a
 * guess about which half of the set is authoritative.
 */
function agreedOntology(group: readonly ImportSetObservation[]): string | null {
	const stamped = new Set(group.map((entry) => entry.ontology).filter((value): value is string => value !== null));
	return stamped.size === 1 ? [...stamped][0] : null;
}

/**
 * AM-27. The derivation every member of a set agrees on, or null when none is
 * stamped (a legacy set, which `derivationOf` reads as `filename-stem-v1`).
 *
 * Disagreement REFUSES, the way `scheme` does, rather than degrading to a
 * default the way `ontology` does. The difference is that ontology has a second
 * observable to recover from - the prefixes the notes' own curies show - while a
 * derivation rule leaves no trace in the note it produced. Picking either answer
 * for a mixed set re-identifies the half that disagreed: every one of those notes
 * falls outside the run's index, so the run writes duplicates and reports the
 * originals as orphans. Refusing by name costs the user one message and damages
 * nothing.
 *
 * A partly-stamped set counts as disagreement for the same reason: unstamped IS
 * `filename-stem-v1`, so "some stamped, some not" is two rules in one set.
 */
function agreedDerivation(id: string, group: readonly ImportSetObservation[]): ImportSetDerivation | null {
	const stamped = new Set(group.map((entry) => entry.derivation ?? LEGACY_IMPORT_SET_DERIVATION));
	if (stamped.size === 1) {
		const only = [...stamped][0];
		if (!isImportSetDerivation(only)) {
			const paths = group.map((entry) => entry.path).sort();
			throw new ImportSetProvenanceError(
				`Import set ${id} records an identity derivation this version does not know: ${only}. `
				+ 'It was probably written by a newer Crosswalker. Update the plugin, then run this again.',
				paths,
			);
		}
		return only === LEGACY_IMPORT_SET_DERIVATION && group.every((entry) => entry.derivation === null)
			? null
			: only;
	}
	const paths = group.map((entry) => entry.path).sort();
	const details = group
		.map((entry) => `${entry.path} (${entry.derivation ?? LEGACY_IMPORT_SET_DERIVATION})`)
		.sort()
		.join(', ');
	throw new ImportSetProvenanceError(
		`Import set ${id} records two different identity derivations, so its notes cannot all be recognised by one rule: ${details}. `
		+ 'Restore the notes that disagree from a backup, or move them out of this folder, then run the import again.',
		paths,
	);
}

function agreedNestIdentity(
	id: string,
	group: readonly ImportSetObservation[],
): Record<string, 'global' | 'path'> | null {
	const canonical = group.map((entry) => entry.nestIdentity === null
		? null
		: JSON.stringify(Object.fromEntries(Object.entries(entry.nestIdentity).sort(([a], [b]) => a.localeCompare(b)))));
	const distinct = new Set(canonical);
	if (distinct.size === 1) {
		const first = group[0].nestIdentity;
		return first === null ? null : { ...first };
	}
	const paths = group.map((entry) => entry.path).sort();
	const details = group
		.map((entry) => `${entry.path} (${entry.nestIdentity === null ? 'missing nest_identity' : JSON.stringify(entry.nestIdentity)})`)
		.sort()
		.join(', ');
	throw new ImportSetProvenanceError(
		`Import set ${id} records different nested identity rules, so its notes cannot all be recognised by one recipe: ${details}. `
		+ 'Restore the notes that disagree from a backup, or move them out of this folder, then run the import again.',
		paths,
	);
}

function isImportSetDerivation(value: unknown): value is ImportSetDerivation {
	return typeof value === 'string' && (IMPORT_SET_DERIVATIONS as readonly string[]).includes(value);
}

/**
 * Where a set actually lives. Prefers the recorded destination, but only while
 * the set's own notes still corroborate it: a recorded folder goes stale the
 * moment a user renames it in the file explorer, and writing to a folder that no
 * longer exists is how a refresh silently forks an import.
 */
function resolveSetRoot(recorded: string | null, paths: readonly string[]): string | null {
	if (recorded && paths.every((path) => path.startsWith(`${recorded}/`))) return recorded;
	return recoverImportSetRoot(paths);
}

/**
 * Recover a set's root from the notes it owns: the deepest folder every one of
 * them sits under.
 *
 * Compared SEGMENT-WISE on purpose. A common string prefix would happily merge
 * `Frameworks/NIST-mini` with `Frameworks/NIST-minimal` into
 * `Frameworks/NIST-min`, a folder neither set lives in.
 *
 * Fails closed: an empty result or the vault root returns null rather than a
 * destination. One note dragged out of the import root collapses the prefix, and
 * refusing to answer is right there. Callers should say WHICH note broke the
 * prefix rather than silently reverting to a derived default.
 */
export function recoverImportSetRoot(paths: readonly string[]): string | null {
	if (paths.length === 0) return null;
	let common: string[] | null = null;
	for (const path of paths) {
		const segments = path.split('/').slice(0, -1).filter(Boolean);
		if (common === null) {
			common = segments;
			continue;
		}
		let i = 0;
		while (i < common.length && i < segments.length && common[i] === segments[i]) i++;
		common = common.slice(0, i);
		if (common.length === 0) return null;
	}
	if (!common || common.length === 0) return null;
	return common.join('/');
}

/**
 * Normalize a folder so a recorded destination compares equal to a vault path
 * prefix.
 *
 * S6 ruling (2026-09-04). THE AM-53 NORMALIZATION, not a local spelling of it.
 *
 * Failure mode prevented: this was trim plus edge separators, which performs a
 * fraction of one of the host's four mutations, and its result is compared against
 * fully normalized vault paths on the question "where does this set live"
 * (`resolveSetRoot`'s `startsWith`). A destination recorded with an NBSP, an NFD
 * accent, a backslash or an internal `//` failed that comparison. It degrades
 * safely - `recoverImportSetRoot` recovers the real root segment-wise from the
 * notes themselves and fails closed to null - and that degrade path stays exactly
 * where it is; what changes is that the comparison now succeeds in the ordinary
 * case instead of relying on the fallback for it.
 */
function normalizeFolder(value: string): string {
	return normalizeFolderSetting(value);
}
