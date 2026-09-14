/**
 * enrich.ts — Pass 1.5 batch enrichment (pure logic).
 *
 * render() is per-row pure (Pass 1, hashable). Five artifacts need cross-row
 * knowledge, so they run here, AFTER every row renders, as a deterministic
 * batch-scope pass:
 *
 *   1. Index      — resolve each note's parent link → parent→children map
 *                   (keyed by CURIE, stable across relocation).
 *   2. Relocation — `parent_note: 'folder-note'`: for every concept that is a
 *                   parent of >=1 batch concept AND whose own basename-folder
 *                   already holds a child (`T1055.md` + `T1055/`), relocate
 *                   `T1055.md → T1055/T1055.md`. Symmetric flip-back: when the
 *                   CURRENT config asks for `'sibling'` (the default) but a
 *                   note is CURRENTLY folder-note-shaped (a prior import used
 *                   `'folder-note'`), it relocates back. Idempotent either way
 *                   — a note already in its desired shape is left alone.
 *                   Requires an eager (non-streamed) batch; a streamed source
 *                   keeps every parent as a sibling and records a deviation.
 *   3. Children   — a managed `children` array on each parent note (keyed by
 *                   its FINAL, post-relocation path), sorted by child curie
 *                   (fully managed; regenerated wholesale on re-import — user
 *                   extras inside the array are NOT preserved, unlike
 *                   tags/aliases which union; `user_preserve` covers separate
 *                   keys).
 *   4. Facet hubs — one synthetic note per facet VALUE (≥2 members), with a
 *                   managed `members` list, `kind: facet`, the facet tag, and an
 *                   H1 body. User prose below the H1 survives re-import.
 *   4.5 Level hubs — (2026-07-11, ICSB audit gap #1) `level_hubs: 'notes'`:
 *                   every FOLDER level in the generated structure gets an
 *                   index/MOC note, derived from the batch's own note paths
 *                   (never a filesystem scan). A folder whose basename already
 *                   matches an existing note in the batch (that note IS the
 *                   concept whose children the folder holds — sibling OR
 *                   folder-note shaped; basenames are the only identity that
 *                   matters in this basename-only-link codebase) is HOSTED:
 *                   that note gains a managed body "Contents" section listing
 *                   the folder's direct children. A folder with no such note
 *                   (a pure structural grouping folder, or the per-import
 *                   root) gets a brand-new SYNTHETIC hub note (`kind: 'hub'`)
 *                   at `<folder>/<folder>.md`. Root hub: when `rootFolder` is
 *                   given but isn't itself a tracked ancestor folder of any
 *                   note (the bare golden-vault test harness, which never
 *                   simulates a destination basePath), a fallback top-level
 *                   home note links every otherwise-parentless top-level
 *                   folder/file — in real usage (generation-engine, basePath
 *                   always set) `rootFolder` IS a tracked ancestor and is
 *                   handled by the uniform per-folder pass with no special
 *                   casing. A synthetic hub's CURIE is derived from its folder
 *                   path relative to `rootFolder` (the root's own hub takes the
 *                   reserved `hub/_root` local part), never from its full vault
 *                   path: identity must not move when an address does. The
 *                   superseded full-path form travels on `HubNote.legacyCuries`
 *                   so hubs already written under it stay reconcilable.
 *                   Deterministic, re-import safe (managed body
 *                   section is stripped-and-reappended by delimiter markers,
 *                   same discipline as facet hubs' H1 split).
 *   5. Stats      — edgeCount = parent links + children entries + member
 *                   entries + level-hub child-link entries (relocations are
 *                   not edges — they don't count).
 *
 * Links are basename-only in this codebase (`[[T1055]]`, never a full-path
 * form — `Address.wikilinkTarget`'s full-path form isn't consumed by anything
 * downstream yet, Pass-2 link minimizer territory per render()'s docstring).
 * That means relocation never needs to rewrite link TEXT anywhere — Obsidian
 * resolves `[[T1055]]` to `T1055/T1055.md` exactly as it resolved `T1055.md`,
 * as long as the basename stays unique. Relocation only ever needs to (a) move
 * the file and (b) make sure every consumer of that note's PATH (the children-
 * list write, generation-engine's re-import lookup) uses the new one.
 *
 * Determinism is a hard constraint: every derived list is sorted by curie,
 * relocations are processed in sorted-curie order, hubs are sorted by path, and
 * no wall-clock value is produced here. Same notes in → same result out,
 * regardless of input order.
 *
 * Pure module: NO Obsidian imports. The engine + golden harness apply the
 * result (move files, patch parents, write hubs) through the vault/merge path.
 */

import { findSpan, replaceRegion, scanRegions, wrapRegion } from './managed-body';
import type { RecipeEnrichment, LayoutValue } from '../render';
import type { FacetMembership } from '../import/mapping/facets';

export type { LayoutValue };

/** A rendered note handed to enrichment (pre-provenance, pre-enrichment). */
export interface EnrichNote {
	/** Vault-relative path (no output-base prefix), forward slashes, ends `.md`. CURRENT/actual location. */
	path: string;
	/** Canonical concept curie. */
	curie: string;
	/** Rendered frontmatter — carries the parent link + facet tags. */
	frontmatter: Record<string, unknown>;
	/** Facet memberships (namespace + raw value) this note belongs to. */
	facets: FacetMembership[];
	/**
	 * The SIBLING path `render()` itself computed for this row THIS import —
	 * Pass 1 always computes the sibling form, never knowing about
	 * `parent_note` (design §3). Omit when it's the same as `path` (the common
	 * case: nothing relocated this note away from render()'s own output).
	 *
	 * This is what makes flip-back SAFE: a note can be folder-note-SHAPED
	 * (`X/X.md`) for two entirely different reasons — (a) that's genuinely
	 * where a PRIOR `parent_note: 'folder-note'` import relocated it, or (b)
	 * that's just what this recipe's OWN layout templates always produce for
	 * this row (e.g. a fixed top-level folder whose value happens to equal the
	 * leaf filename — real committed-golden behavior, NIST-CSF's `GV/GV.md`).
	 * Path SHAPE alone can't tell those apart; only knowing render()'s own
	 * intended path can. Flip-back only ever fires when `renderedPath` is set
	 * AND differs from `path` — i.e. there is POSITIVE evidence something
	 * other than render() put this note where it currently is.
	 */
	renderedPath?: string;
	/**
	 * AM-33 / AM-37 (2026-09-01). The VALUES this row's layout produced, in order
	 * — exactly one per DIRECTORY SEGMENT of the path render() computed, whatever
	 * appended that segment (a folder mechanism, a literal separator inside a
	 * folder template, the directory prefix of a file template). The k-th value is
	 * byte-identical to the k-th segment, so the list can be checked against the
	 * path rather than trusted; a mismatch is a bug and the hub is refused by name.
	 *
	 * Carried beside the path rather than re-derived from it. Level-hub identity
	 * used to be `slugPath(dirname(note.path))`, recomputed every run and handed
	 * straight to the index as a lookup key, so anything that moved a note moved
	 * the key with it: a second hub note for a folder the vault already had one
	 * for, and the first orphaned with the user's prose still on it. A path may
	 * seed a one-time mint; it may never be needed again after it.
	 *
	 * Absent (never merely empty) when the caller has nothing to hand over (a
	 * harness that calls `enrich()` directly, a note produced by something other
	 * than `render()`). The hub pass then falls back to the path-derived form and
	 * says so. An EMPTY list is a positive statement that the layout produced no
	 * directories, and is checked like any other.
	 */
	layoutValues?: LayoutValue[];
}

/** A materialized facet or level hub note (pre-provenance — the caller attaches _crosswalker). */
export interface HubNote {
	/**
	 * Facet hubs (`result.hubs`): RELATIVE to `hub_note_folder` (basePath-
	 * relative) — the caller re-prefixes with basePath. Level hubs
	 * (`result.levelHubs.notes`): a FULL path already, matching `EnrichNote.path`'s
	 * convention — the caller must NOT re-prefix. See each field's doc.
	 */
	path: string;
	curie: string;
	frontmatter: Record<string, unknown>;
	body: string;
	/**
	 * Level hubs only: the same sorted wikilink list embedded in `body`'s
	 * managed section, carried alongside so a re-import merge can rebuild the
	 * fresh section without re-parsing `body`.
	 */
	childrenLinks?: string[];
	/**
	 * The ROOT level hub only (2026-07-11): this batch's facet hub notes
	 * (`result.hubs`, already sorted by path), as a separate "Facets" sub-list
	 * under Contents — see `buildManagedChildrenSection`'s `extraGroups`.
	 * Carried alongside `body` for the same re-import-merge reason as
	 * `childrenLinks`: the merge path rebuilds the managed section from these
	 * fields directly, never by re-parsing `body`.
	 */
	facetLinks?: string[];
	/**
	 * Level hubs only: identity forms this hub was written under by an EARLIER
	 * plugin version, newest-superseded first. A hub curie used to be derived
	 * from the hub's full vault path, so moving an import's destination changed
	 * the identity of every hub in it — the note at the old address kept a curie
	 * nothing would ever claim again, and a second note was created for the
	 * "new" identity. A caller reconciles these aliases to the same note before
	 * concluding that a hub does not exist yet.
	 */
	legacyCuries?: string[];
	/**
	 * AM-33 (2026-09-01). Level hubs only: the ordered layout values this hub
	 * covers — the facts its identity was minted from, carried so the caller can
	 * (a) write them onto the note and (b) find an existing hub by reading them
	 * back off owned hub notes when neither the current identity nor a legacy
	 * form matches.
	 *
	 * Failure mode prevented: the only record of what a hub is about being the
	 * folder it sits in, so the answer to "does this hub already exist" has to be
	 * recomputed from an address every single run.
	 */
	levelValues?: LayoutValue[];
	/**
	 * AM-62 (2026-09-04). Level hubs only: this hub describes a folder the run HELD
	 * (AM-55 row 1) rather than one any row of this run described. Its identity, its
	 * recorded values and everything the note already says about itself come from
	 * the note itself; this run has nothing new to say about it except, possibly, a
	 * changed children list.
	 *
	 * Failure mode prevented by the caller acting on this flag: a run that has
	 * nothing new to say saying it again. Rewriting such a note with identical
	 * content still moves `produced_at`, still restamps provenance fields the note
	 * never carried, and still touches a file the user was told would be left alone
	 * - so every mtime in an untouched collection moves on a refresh that changed
	 * one row somewhere else. A byte-identical write is not a write.
	 */
	heldFolder?: true;
	/**
	 * AM-64 (2026-09-04). Facet hubs only: at least one of this hub's members is a
	 * row the run WRITES.
	 *
	 * The caller needs it to answer one question and only one: may an ABSENT facet
	 * hub be created on this run? A facet hub whose every member the run held is a
	 * note about notes the run did not touch, so bringing it into existence is the
	 * run inventing a note on a pass that wrote nothing - including re-creating one
	 * the user deleted on purpose. An EXISTING facet hub is decided by the AM-62
	 * rule instead (write only when its managed region or members list differs),
	 * which is a comparison, not this flag.
	 */
	hasWriteSetMember?: true;
	/**
	 * AM-71 (2026-09-04). Level hubs only: this is the IMPORT ROOT's home note.
	 *
	 * The root's identity is the set's own reserved local part (`hub/_root`), not a
	 * chain any note recorded, so its absence is never the recategorisation AM-64's
	 * third row declines to judge - there is nothing recorded to have been about
	 * something else. The caller therefore creates it when it is absent on any run
	 * with a population, and preserves it as recorded on a run that wrote nothing
	 * into it.
	 *
	 * Failure mode prevented: an import with no home note and no message. On an
	 * all-skip refresh the root is held (no row the run writes lies within it), so
	 * AM-64's no-create rule refused it - and `refusalFor` exempts the root, so
	 * nothing was said either. A user with a pre-fix flat vault, or who deleted the
	 * home note, got silence.
	 */
	importRoot?: true;
}

/** One parent-note relocation the caller must physically apply to the vault. */
export interface Relocation {
	/** The concept's curie (stable identity across the move). */
	curie: string;
	/** Path the note currently lives at (in this batch). */
	from: string;
	/** Path it should move to. */
	to: string;
}

export interface EnrichmentResult {
	/** FINAL (post-relocation) path → sorted `children` wikilink array, to patch onto that parent note. */
	childrenByPath: Map<string, string[]>;
	/** Materialized facet hub notes (sorted by path). Empty unless facet_notes='notes'. */
	hubs: HubNote[];
	/** Materialized level (hierarchy MOC) hubs. Empty unless level_hubs='notes'. */
	levelHubs: {
		/**
		 * FINAL (post-relocation) path of a note that already exists in the batch
		 * and hosts a folder's index content → sorted `[[...]]` list of that
		 * folder's direct children, to append as a managed body section.
		 */
		hostedChildrenByPath: Map<string, string[]>;
		/**
		 * AM-76 (2026-09-04). The FOLDER each hosted path hosts, recorded by the one
		 * pass that knows it.
		 *
		 * A host note is left alone when it carries no managed region, and the
		 * sentence that says so names the folder. The caller has only the note's
		 * path, and a folder derived from a path is a guess: the sibling shape
		 * (`T1078.md` hosts `T1078/`) and the folder-note shape
		 * (`T1078/T1078.md` hosts `T1078/`) are different derivations of the same
		 * string, and picking between them by looking at the path is exactly the
		 * inference `project_reimport_identity_reconciliation` rules out. The pass
		 * that decided the hosting says which folder it decided about.
		 */
		hostedFolderByPath: Map<string, string>;
		/**
		 * Brand-new synthetic hub notes for folders with no hosting note (sorted
		 * by path). `path` is a FULL vault-relative path already — see `HubNote`'s
		 * doc comment; callers must NOT re-prefix with basePath.
		 */
		notes: HubNote[];
		/**
		 * AM-55 (2026-09-04). Curies of index notes this run LEFT EXACTLY AS THEY
		 * ARE, which the caller must still account for as produced.
		 *
		 * Failure mode prevented: a false orphan report on a note the run can see.
		 * The second row of AM-55's table is a folder whose notes were kept in place
		 * and whose index note carries no usable record (a hub written before
		 * `hub_values` existed, or a half-record). Nothing is written for it - the
		 * run has no identity to write - but the note demonstrably EXISTS, so
		 * reporting it as no longer in the source is a statement the run has
		 * evidence against. It emits no `HubNote`, so without this list the caller
		 * has nothing to mark and the orphan pass names it.
		 *
		 * Sorted, deterministic, and deduplicated.
		 */
		keptExistingCuries: string[];
		/**
		 * AM-70 (2026-09-04). Curies of index notes the caller READ this run whose
		 * folder no note of the population reaches - so this pass can say nothing
		 * about what they are for.
		 *
		 * Neither produced nor kept nor orphan. The caller excludes them from the
		 * orphan diff BY NAME and keeps `orphansChecked` true: the population was
		 * checked, and these notes were named rather than judged. Reporting one as no
		 * longer in the source is a claim the same run has evidence against, since it
		 * read the note this pass; marking it produced would be this run vouching for
		 * a note it wrote nothing into and cannot describe.
		 *
		 * Sorted, deterministic, and deduplicated.
		 */
		observedUnjudgedCuries: string[];
	};
	/** Graph edge count: parent links + children entries + member entries + level-hub child-link entries. */
	edgeCount: number;
	/** Human-readable deviations (e.g. folder-note fallback), deterministic order. */
	deviations: string[];
	/** Parent-note relocations to apply, sorted by curie (design §3 step 2). */
	relocations: Relocation[];
}

export interface EnrichOptions {
	/** Ontology id — the curie prefix for hub notes. */
	ontology: string;
	/** The recipe's enrichment config (target.enrichment). */
	config: RecipeEnrichment;
	/**
	 * True when the source batch was streamed (AsyncIterable rows) rather than
	 * an eager array. `parent_note: 'folder-note'` needs the whole batch's
	 * shape up front (does a folder already exist for this parent?), so a
	 * streamed source keeps every parent as a sibling and records a deviation
	 * instead (design §3 step 2 v1 restriction). Default false.
	 */
	streamed?: boolean;
	/**
	 * The per-import destination folder (matches `GenerationOptions.basePath`),
	 * a FULL vault-relative path with no trailing slash ('' for the vault
	 * root). Used only by `level_hubs: 'notes'` to scope which folders are "in
	 * this import", to compute hub curies relative to it, and to name the
	 * root/home hub note. Every `EnrichNote.path`
	 * is expected to already be prefixed by this value in real usage (the
	 * generation-engine callers always supply it); omit only in contexts (like
	 * the bare golden-vault test harness) that never simulate a destination
	 * folder — level hubs still work, they just fall back to a top-level home
	 * note when `rootFolder` isn't a tracked ancestor of any note (see the
	 * module header's step 4.5 note).
	 */
	rootFolder?: string;
	/**
	 * AM-52 (2026-09-04), reshaped by AM-55. WHAT THE VAULT ACTUALLY HOLDS at each
	 * folder: the index note sitting in it, keyed by that folder.
	 *
	 * Supplied by the caller because `enrich()` is pure and reads no vault. Consulted
	 * for one state only: a folder that holds a row THIS RUN KEPT at an address the
	 * layout no longer chooses (AM-54's chain). The recorded values are the hub's own
	 * record, so the identity derived from them is the identity the note on disk
	 * already carries, which is what makes the hub survive the refresh instead of
	 * being reported as vanished.
	 *
	 * Failure mode prevented by the SHAPE (AM-55): the map used to be
	 * folder -> values, which collapsed three different observations into one absent
	 * entry - "no index note is here", "one is here but records nothing this run can
	 * use", and "the caller could not read it". Each has a different consequence, and
	 * a refusal that cannot tell them apart tells the user something the run
	 * contradicts. An entry that is present is a fact about a note that exists; an
	 * ABSENT entry means only "no index note sits in this folder", and a note the
	 * caller could not READ is reported separately (it never reaches here, and the
	 * caller suppresses orphan reporting for the run instead).
	 */
	ownedHubsByFolder?: OwnedHubsByFolder;
	/**
	 * AM-61 (2026-09-04). THE PATHS THIS RUN WILL WRITE — the first of the three
	 * sets this derivation is told about.
	 *
	 * AM-60 widened the batch so every list could be computed from a population
	 * that can see everything the list names. That is right for READING and wrong
	 * for ACTING: the same widened batch was then handed to decisions about what
	 * the run will DO, and a plan computed for rows the pass may not touch is a
	 * plan the pass contradicts. `computeRelocations` reported moves the caller's
	 * write gate then refused, and a kept row's live layout values outranked its
	 * folder's recorded identity, re-identifying a legacy hub through a row nobody
	 * wrote.
	 *
	 * So the batch carries three sets, named here rather than inferred:
	 *   - WRITE SET (this field): note bodies, `valuesByFolder` (a folder is
	 *     DESCRIBED only by a row the run writes), the identity of a described
	 *     folder, and `computeRelocations`.
	 *   - HELD SET (every other note in `notes`): `keptFolders` (AM-54's chain) and
	 *     the recorded identity each kept folder keeps.
	 *   - WHOLE POPULATION (`notes`): `folders`, `hostByFolder`, `hubChildren` and
	 *     every Contents list, `edgeCount`, the curies the caller accounts for.
	 *
	 * AM-65 (2026-09-04). REQUIRED. There is no "absent means everything is
	 * writable" reading any more, and `enrich()` refuses by name when it is missing
	 * rather than deriving from a guess.
	 *
	 * Failure mode prevented: a fact the derivation needs arriving as a default.
	 * While the field was optional, every caller that had not been updated lost
	 * `keptFolders` silently - `isWritable` answered true for every note, so no
	 * folder was ever held, every kept row described its own folder, and AM-52's,
	 * AM-54's and AM-55's exemptions all collapsed into AM-50's "the note may have
	 * been moved" refusal. Twenty-four declarations across seven files went red on
	 * one omitted argument, and none of them named the cause.
	 *
	 * The pre-AM-61 inference this replaced - `dirOf(renderedPath) !== dirOf(path)`
	 * therefore kept - is gone with it and must not return as a fallback. That is
	 * the project's own anti-rule (identity, never path) at this module's centre: a
	 * fact recovered from a path comparison rather than recorded.
	 */
	writeSet: ReadonlySet<string>;
	/**
	 * AM-70 (2026-09-04). EVERY index note of this import the caller READ this run,
	 * with the folder it was found in - not only the ones whose folder the
	 * population reaches.
	 *
	 * Failure mode prevented: a note the run read this pass reported as no longer in
	 * the source. A `kind: 'hub'` note sitting in a folder no note of the population
	 * reaches (a user tidied it into an archive folder) is observed by the caller's
	 * walk, is judged by nothing here - `keptFolders` is gated on `folders`, which is
	 * built from the population's own ancestors - and then lands in the orphan diff
	 * with `orphansChecked: true`, while the same run holds the record that it read
	 * that very note. Such a curie is neither produced nor kept nor orphan: it is
	 * named (`observedUnjudgedCuries`) and left alone.
	 *
	 * Supplied by the caller because `enrich()` is pure and reads no vault.
	 */
	observedHubs?: readonly { curie: string; path: string; folder: string; hasRecordedChain: boolean }[];
}

/**
 * AM-55 (2026-09-04). The index note (or notes) a folder holds, as observed in the
 * vault by the caller.
 *
 * `one` carries the note's own identity and, when it records one, the chain it
 * covers. `many` is a refusal by name rather than a pick: two index notes in one
 * folder is a question about which one describes the folder, and picking the first
 * writes one note's identity over the other's meaning.
 *
 * AM-59 (2026-09-04). `many` carries the CURIES as well as the paths, index for
 * index. Failure mode prevented: a refusal and an orphan report about the same
 * notes on one results screen. The refusal names two notes and asks the user to
 * curate them; without the curies nothing could mark them produced, so the same
 * run also announced that both were no longer in the source. Each index note the
 * walk observed is a fact, and declining to choose between two facts is not
 * evidence that either one vanished.
 */
export type OwnedHubAtFolder = (
	| { state: 'one'; path: string; curie: string; values?: LayoutValue[] }
	| { state: 'many'; paths: string[]; curies: string[] }
	/**
	 * S18 (2026-09-04). ONE VOICE PER FOLDER: the caller read an index note here,
	 * found that its recorded chain describes a DIFFERENT folder (S12), withheld it,
	 * and has already named it in a warning.
	 *
	 * Without this state such a folder was simply ABSENT from the map, so the third
	 * row of AM-55's table spoke for it as well - "This import has no index note for
	 * the folder ..." printed beside a warning naming a note sitting in that very
	 * folder. Two messages about one folder, one of them contradicting the other.
	 * Present-but-withheld is a fact; absent is a different fact.
	 *
	 * Residual ruling 4 (2026-09-04). THIS ARM IS S12 ALONE. Pass 20 folded the
	 * unreadable note in here too, which silenced a folder the run has something
	 * true and specific to say about; see `hasUnreadableNote` below.
	 */
	| { state: 'withheld' }
	/**
	 * AM-68 (2026-09-04). No index note of this import could be READ in this folder,
	 * and at least one note here could not be read at all (`hasUnreadableNote`).
	 *
	 * The arm exists so the folder can carry the qualifier while still being what it
	 * is: a folder with no readable index note. It is AM-55's third row, whose voice
	 * names the observation and nothing more.
	 */
	| { state: 'absent' }
) & {
	/**
	 * AM-68 (2026-09-04). UNREADABLE IS A NOTE-LEVEL FACT, carried as a qualifier on
	 * whatever readable state the folder otherwise reaches - never as the folder's
	 * state.
	 *
	 * Failure mode prevented: a claim the run could not observe. Residual ruling 4
	 * (pass 21) made the folder-level `unreadable` state speak, and the state was set
	 * by ANY owned note the run could not read - the walk's `kind: 'hub'` filter sits
	 * below the unreadable branch, so a cache-cold concept note marked its folder.
	 * The results screen then said the folder's INDEX NOTE could not be read while
	 * the readable index note sitting beside it was discarded behind the sticky
	 * guard. The caller's own warning three hundred lines away refuses to make that
	 * claim, and names "notes", not "index notes", for exactly this reason.
	 *
	 * So: the folder's state is decided by its readable index note if one exists
	 * (rows 1, 2 and `many` are unaffected by this qualifier), and where none exists
	 * the qualifier only widens row 3's sentence to say what was observed - that a
	 * note in the folder could not be read this run, not which note it was.
	 */
	hasUnreadableNote?: true;
};

/** AM-55. Folder -> the index note(s) it holds. See `EnrichOptions.ownedHubsByFolder`. */
export type OwnedHubsByFolder = ReadonlyMap<string, OwnedHubAtFolder>;

/** Facet hub notes are materialized only for values with at least this many members. */
export const HUB_MIN_MEMBERS = 2;

/**
 * Run the enrichment pass over a batch of rendered notes.
 * Pure + deterministic. Never mutates the input notes.
 */
export function enrich(notes: EnrichNote[], opts: EnrichOptions): EnrichmentResult {
	// AM-65 (2026-09-04). REFUSED BY NAME, BEFORE ANYTHING IS DERIVED.
	//
	// Failure mode prevented: a missing write set read as "everything is writable".
	// The type makes the omission a compile error; this makes it a named refusal
	// for a caller the compiler never saw (a JavaScript caller, a test fixture
	// built through a cast). Deriving anything at all without it would produce a
	// result in which no folder is held, every kept row describes its own folder,
	// and a legacy hub is re-identified under the current scheme - silently, with
	// no evidence of the omission anywhere in the output.
	if (opts.writeSet === undefined || opts.writeSet === null) {
		throw new Error('enrich(): writeSet is required; without it every kept row would describe its own folder');
	}
	const config = opts.config ?? {};
	const result: EnrichmentResult = {
		childrenByPath: new Map(),
		hubs: [],
		levelHubs: {
			hostedChildrenByPath: new Map(),
			hostedFolderByPath: new Map(),
			notes: [],
			keptExistingCuries: [],
			observedUnjudgedCuries: [],
		},
		edgeCount: 0,
		deviations: [],
		relocations: [],
	};

	// --- 1. Index: basename → note, curie → note (first occurrence wins, deterministic). ---
	const byBasename = new Map<string, EnrichNote>();
	const byCurie = new Map<string, EnrichNote>();
	for (const note of notes) {
		const bn = basename(note.path);
		if (!byBasename.has(bn)) byBasename.set(bn, note);
		if (!byCurie.has(note.curie)) byCurie.set(note.curie, note);
	}

	// --- Derive parent→children from each note's parent link, keyed by the
	//     PARENT'S CURIE (stable identity — its path may still move below). ---
	const childrenByParentCurie = new Map<string, EnrichNote[]>();
	let parentLinkEdges = 0;
	for (const note of notes) {
		for (const target of parentTargets(note.frontmatter)) {
			const parent = byBasename.get(basename(target));
			if (!parent || parent === note) continue;
			parentLinkEdges++;
			let kids = childrenByParentCurie.get(parent.curie);
			if (!kids) {
				kids = [];
				childrenByParentCurie.set(parent.curie, kids);
			}
			kids.push(note);
		}
	}
	result.edgeCount += parentLinkEdges;

	// AM-61/AM-65. The write set, as a predicate. Membership is the WHOLE test: a
	// note is writable because the caller said so, never because its rendered and
	// final paths happen to agree. See `EnrichOptions.writeSet`.
	const writeSet = opts.writeSet;
	const isWritable = (note: EnrichNote): boolean => writeSet.has(note.path);

	// --- 2. Folder-note relocation (parent_note). Computes a curie→newPath
	//     override; children lists + downstream consumers use the FINAL path. ---
	const pathOverride = computeRelocations(notes, config, opts.streamed ?? false, result, isWritable);
	const finalPath = (note: EnrichNote): string => pathOverride.get(note.curie) ?? note.path;

	// --- 3. Children lists. ---
	if (config.children_lists) {
		for (const [parentCurie, kids] of childrenByParentCurie) {
			const parent = byCurie.get(parentCurie);
			if (!parent) continue;
			const sorted = [...kids].sort((a, b) => cmp(a.curie, b.curie));
			const links = sorted.map((k) => `[[${basename(k.path)}]]`);
			result.childrenByPath.set(finalPath(parent), links);
			result.edgeCount += links.length;
		}
	}

	// --- 4. Facet hub notes. ---
	if (config.facet_notes === 'notes') {
		// Group notes by facet (namespace, value). Track raw display value + members.
		interface Group {
			namespace: string;
			value: string;
			members: EnrichNote[];
		}
		const groups = new Map<string, Group>();
		for (const note of notes) {
			for (const facet of note.facets) {
				const key = `${facet.namespace} ${facet.value}`;
				let g = groups.get(key);
				if (!g) {
					g = { namespace: facet.namespace, value: facet.value, members: [] };
					groups.set(key, g);
				}
				g.members.push(note);
			}
		}
		const folder = config.hub_note_folder ? stripSlashes(config.hub_note_folder) : '';
		for (const g of groups.values()) {
			if (g.members.length < HUB_MIN_MEMBERS) continue;
			const sorted = [...g.members].sort((a, b) => cmp(a.curie, b.curie));
			const members = sorted.map((m) => `[[${basename(m.path)}]]`);
			const hubPath = (folder ? `${folder}/` : '') + `${fsSafe(g.value)}.md`;
			const hub: HubNote = {
				path: hubPath,
				curie: `${opts.ontology}:facet/${g.namespace}/${slug(g.value)}`,
				frontmatter: {
					curie: `${opts.ontology}:facet/${g.namespace}/${slug(g.value)}`,
					kind: 'facet',
					tags: [`${g.namespace}/${tagsafe(g.value)}`],
					members,
				},
				body: `# ${g.value}\n`,
				// AM-64. Recorded from the write set, for the caller's create decision
				// only. See `HubNote.hasWriteSetMember`.
				...(sorted.some((m) => isWritable(m)) ? { hasWriteSetMember: true as const } : {}),
			};
			result.hubs.push(hub);
			result.edgeCount += members.length;
		}
		// Deterministic hub order.
		result.hubs.sort((a, b) => cmp(a.path, b.path));
	}

	// --- 4.5. Level hub notes (hierarchy MOCs). ---
	computeLevelHubs(
		notes, finalPath, isWritable, byBasename, config, opts.ontology, opts.rootFolder,
		opts.ownedHubsByFolder, opts.observedHubs, result,
	);

	return result;
}

// ---------------------------------------------------------------------------
// Relocation (parent_note: sibling | folder-note)
// ---------------------------------------------------------------------------

/**
 * Compute the curie→newPath overrides for this batch's parent-note placement,
 * and record the corresponding `Relocation` entries + deviation notes on
 * `result`. Two directions, both idempotent and processed in sorted-curie
 * order for determinism:
 *
 *   - `parent_note: 'folder-note'` — every note with an already-colliding
 *     same-named folder (>=1 OTHER batch note's path nests under it) relocates
 *     `X.md → X/X.md`. PATH-STRUCTURAL eligibility, deliberately independent
 *     of `parent` link edges (mirrors the workbench preview's
 *     `toFolderNotePaths`, mapping/view-model.ts — the promise shown to the
 *     user in the placement chooser). A note already in that shape (a prior
 *     import already relocated it) is left alone — this is what makes
 *     re-import safe without needing a separate curie-lookup pass here: by
 *     the time this runs, the caller (generation-engine) has already resolved
 *     each row's write path to wherever the concept CURRENTLY lives (see
 *     `folderNoteCandidatePath` + generation-engine's `resolveWriteTarget`),
 *     so an already-relocated parent shows up here already folder-note-shaped.
 *
 *     Found 2026-07-11 (visual-report-and-graph.spec.ts repro): this branch
 *     used to derive its candidate set from `childrenByParentCurie` (built
 *     from `parent` wikilink edges, the same index `children_lists` uses). A
 *     packed/ragged hierarchy with no separate parent-id column — the COMMON
 *     case; ATT&CK sub-technique ids like `T1078.001` self-encode the
 *     hierarchy via the dot delimiter, no `parent_id` column needed — never
 *     produces a `parent` link, so `childrenByParentCurie` stayed empty and
 *     folder-note placement silently never fired: no error, no deviation,
 *     `T1078.md` stayed a sibling of `T1078/` even with "Folder note"
 *     explicitly selected. Switching to path-structural eligibility (which
 *     the UI preview already used) fixes it without touching
 *     `children_lists`, which legitimately stays link-based (see
 *     `recipe-registry.ts`'s note on self-referential prefix links).
 *   - otherwise (`'sibling'`, the default) — the symmetric flip-back: any note
 *     CURRENTLY folder-note-shaped (from a PRIOR import that used
 *     `'folder-note'`) relocates back to sibling form. Least-surprising per
 *     the 2026-07-05 variadic-split design §4 flip-back decision: placement
 *     always tracks the CURRENT recipe config, in either direction.
 *
 * A target path already occupied by another batch note is a collision guard,
 * not a crash: the relocation is skipped and a deviation records why.
 */
function computeRelocations(
	notes: EnrichNote[],
	config: RecipeEnrichment,
	streamed: boolean,
	result: EnrichmentResult,
	/**
	 * AM-61. THE WRITE SET. A relocation is not a derivation over the population,
	 * it is a PLAN: an override that every downstream list is keyed by, a
	 * `Relocation` the caller physically applies, and a deviation the user reads.
	 *
	 * Failure mode prevented: a plan computed for rows the pass may not touch. With
	 * the batch widened for reading (AM-60), a KEPT note took a `pathOverride`, a
	 * `result.relocations` entry and a deviation reading "relocated ... back to
	 * sibling form (A -> B)" — and the caller's write gate then correctly refused
	 * the rename. The run told the user it had moved a file it deliberately left
	 * alone, and `folders`, `filesOf`, `hostByFolder`, `keptFolders` and every
	 * Contents list were computed around an address the note is not at. Suppressing
	 * only the deviation would leave the derived lists wrong; the candidate is
	 * dropped instead, so `finalPath` stays the note's real address.
	 *
	 * The collision guard (`occupied`) and the folder-collision test (`folderPaths`)
	 * still see the WHOLE population: a kept note occupies its path whether or not
	 * this run may write it, and a relocation onto it would clobber it.
	 */
	isWritable: (note: EnrichNote) => boolean,
): Map<string, string> {
	const pathOverride = new Map<string, string>();
	// Batch-known occupied paths — the collision guard. Updated as relocations
	// are accepted so two relocations in the same pass can't target each other.
	const occupied = new Set(notes.map((n) => n.path));

	const relocate = (curie: string, from: string, to: string, direction: 'folder-note' | 'sibling'): void => {
		if (occupied.has(to)) {
			result.deviations.push(
				`parent_note: could not relocate ${curie} to ${direction} form — ${to} is already used by another note in this batch.`,
			);
			return;
		}
		pathOverride.set(curie, to);
		occupied.delete(from);
		occupied.add(to);
		result.relocations.push({ curie, from, to });
		result.deviations.push(
			direction === 'folder-note'
				? `parent_note: relocated ${curie} to folder-note form (${from} → ${to}).`
				: `parent_note: relocated ${curie} back to sibling form (${from} → ${to}).`,
		);
	};

	if (config.parent_note === 'folder-note') {
		if (streamed) {
			result.deviations.push(
				"parent_note: folder-note requires an eager (non-streamed) source; this streamed import kept parent notes as siblings.",
			);
			return pathOverride;
		}
		// Every directory implied by any batch note's path (mirrors
		// toFolderNotePaths' `folderPaths` set exactly) — the collision test.
		const folderPaths = new Set<string>();
		for (const n of notes) {
			const parts = n.path.split('/');
			for (let i = 1; i < parts.length; i++) folderPaths.add(parts.slice(0, i).join('/'));
		}
		const sortedNotes = [...notes].filter(isWritable).sort((a, b) => cmp(a.curie, b.curie));
		for (const note of sortedNotes) {
			const shape = pathShape(note.path);
			if (shape.isFolderNoteShaped) continue; // already relocated — idempotent no-op.
			if (!folderPaths.has(shape.folderDir)) continue; // no colliding folder — stays a sibling.
			relocate(note.curie, note.path, joinMd(shape.folderDir, shape.base), 'folder-note');
		}
	} else {
		const sortedNotes = [...notes].filter(isWritable).sort((a, b) => cmp(a.curie, b.curie));
		for (const note of sortedNotes) {
			const rendered = note.renderedPath;
			// Only flip back with POSITIVE evidence: render() computed a
			// DIFFERENT (sibling) path for this row than where the note
			// currently sits, and where it sits is exactly that sibling path's
			// folder-note form. Shape alone is not enough — see the
			// `renderedPath` doc comment (the GV/GV.md false-positive this
			// guards against).
			if (rendered === undefined || rendered === note.path) continue;
			if (folderNoteCandidatePath(rendered) !== note.path) continue;
			relocate(note.curie, note.path, rendered, 'sibling');
		}
	}

	return pathOverride;
}

// ---------------------------------------------------------------------------
// Level hubs (hierarchy MOCs) — enrichment.level_hubs
// ---------------------------------------------------------------------------

/** One folder's link identity — how it's referenced when it's a CHILD of another folder. */
interface FolderIdentity {
	curie: string;
	/** Link target (basename, no `.md`) — always `basename(folder)`. */
	label: string;
	/** Set when a note already in the batch hosts this folder's content (see step 4.5). */
	hostedPath?: string;
	/**
	 * Synthetic hubs only: the address-derived curies this hub may already carry,
	 * newest superseded first. AM-33 added a second form (root-relative), so this
	 * is a list rather than the single value it was.
	 */
	legacyCuries?: string[];
	/** AM-33. Synthetic hubs only: the ordered layout values this hub's identity was minted from. */
	levelValues?: LayoutValue[];
}

/**
 * Compute `result.levelHubs` (and fold its edges into `result.edgeCount`) for
 * `level_hubs: 'notes'`. No-op otherwise. See the module header's step 4.5 for
 * the hosted-vs-synthetic rule and the root-hub fallback. Pure; mutates only
 * `result`.
 */
function computeLevelHubs(
	notes: EnrichNote[],
	finalPath: (note: EnrichNote) => string,
	/**
	 * AM-61. THE WRITE SET, as a predicate (see `EnrichOptions.writeSet`). Three
	 * things below are told which half of the population they may read:
	 * `valuesByFolder` (only a row the run WRITES describes a folder),
	 * `keptFolders` (only a row the run HELD holds one), and, through them, the
	 * identity every folder ends up with. Everything else — `folders`,
	 * `hostByFolder`, `filesOf`, every Contents list — is the whole population,
	 * which is what AM-60 corrected and what stays corrected.
	 */
	isWritable: (note: EnrichNote) => boolean,
	byBasename: Map<string, EnrichNote>,
	config: RecipeEnrichment,
	ontology: string,
	rootFolder: string | undefined,
	ownedHubsByFolder: OwnedHubsByFolder | undefined,
	/** AM-70. Every index note of this import the caller read. See `EnrichOptions.observedHubs`. */
	observedHubs: readonly { curie: string; path: string; folder: string; hasRecordedChain: boolean }[] | undefined,
	result: EnrichmentResult,
): void {
	if (config.level_hubs !== 'notes') return;

	const entries = notes.map((n) => ({ note: n, path: finalPath(n) }));
	if (entries.length === 0) return;

	// AM-49 (2026-09-04). `rootFolder` arrives ALREADY NORMALIZED: the engine
	// normalizes the import root once at its own boundary (`normalizeBasePath`)
	// and hands the same string to the path composition and to this pass, so the
	// two can no longer be different spellings of one folder. `stripSlashes` is
	// kept as a defensive no-op on that input, for the harness callers that pass a
	// bare label; it is NOT the normalization, and it must never be mistaken for
	// one. It removes edge separators and nothing else, which is a fraction of one
	// of the host's four mutations, and treating it as sufficient is what made the
	// root the one string in this comparison nobody had normalized.
	const root = rootFolder !== undefined ? stripSlashes(rootFolder) : undefined;
	// `root` scopes folder collection ONLY when it's a genuine ancestor of at
	// least one note (the real generation-engine case: every note path is
	// already basePath-prefixed). When it isn't (the bare golden-vault test
	// harness, which never simulates a basePath and instead passes a bare
	// LABEL for the root-hub fallback below), scoping by it would exclude
	// every real folder — so scoping is a no-op and every ancestor folder is
	// collected unscoped instead; the fallback branch still fires correctly
	// off `!folders.has(root)`.
	const rootIsTrackedAncestor =
		root !== undefined && root !== '' && entries.some((e) => e.path === root || e.path.startsWith(`${root}/`));
	const inScope = (folder: string): boolean =>
		!rootIsTrackedAncestor || folder === root || folder.startsWith(`${root}/`);

	// Every ancestor folder of every note's FINAL path, scoped to the import root.
	const folders = new Set<string>();
	for (const e of entries) {
		let dir = dirOf(e.path);
		while (dir !== '' && inScope(dir)) {
			folders.add(dir);
			dir = dirOf(dir);
		}
	}
	if (folders.size === 0 && (root === undefined || root === '')) return;

	/**
	 * AM-70 (2026-09-04). AN INDEX NOTE IN A FOLDER NO CHAIN REACHES IS NAMED, NOT
	 * JUDGED.
	 *
	 * `folders` is the population's own ancestor set, so a `kind: 'hub'` note the
	 * caller read in some other folder is invisible to everything below: not
	 * described, not hosted, not kept (`keptFolders` is gated on `folders`), and so
	 * accounted for by nothing. The caller's orphan diff then reported a note this
	 * very pass read as no longer in the source, with `orphansChecked: true`.
	 *
	 * The run cannot say what such a note is about - no row of it places anything in
	 * that folder - so it neither claims it nor calls it vanished. It says what it
	 * observed and leaves the note exactly as it found it.
	 *
	 * Failure mode prevented: a refusal and an orphan report about the same note on
	 * one results screen (AM-59's rule, third site).
	 *
	 * SCOPED TO WHAT THE RUN CANNOT SAY (`hasRecordedChain`). "Unreached folder" on
	 * its own is also the shape of a genuine removal: a source release that drops
	 * every row of one folder leaves that folder holding an index note the
	 * population no longer reaches, and reporting THAT note is the falsifying case
	 * the orphan feature exists for (`tests/legacy-vault-refresh.test.ts`, "still
	 * reports a hub that genuinely has no members left"). The two are told apart by
	 * whether the note itself says what it is about: a hub carrying a usable
	 * recorded chain answers that from its own record, so an unreached folder means
	 * its subject left the source and it is judged as before. A hub carrying no
	 * usable chain (written before `hub_values` existed, or a half-record) in a
	 * folder nothing reaches is the one this pass genuinely cannot describe - the
	 * adversary's own scenario, and the only note named here. A hub WITH a chain
	 * that was dragged somewhere it does not describe never arrives here at all: the
	 * caller's S12 check withholds it and suppresses orphan reporting for the run.
	 *
	 * AM-78 (2026-09-04). THIS NARROWING IS THE RULE, not an implementation of a
	 * wider one. AM-70's wider wording - any read hub in a folder no chain reaches
	 * is unjudged - deletes the orphan report `tests/legacy-vault-refresh.test.ts`
	 * exists to prove, so it cannot stand: a hub whose recorded chain is PRESENT and
	 * whose folder no note reaches is what a source release that dropped every row
	 * of a folder leaves behind, and it is an orphan, judged by its recorded
	 * identity rather than by its path. The amendment now reads as the condition
	 * below does.
	 *
	 * Two inherited edges are named and DEFERRED to Part B; neither is opened here:
	 *   - `ownedHubs` is read only when `keptRecords.length > 0`
	 *     (`generation-engine.ts:898`, `:3236`), so the same chain-less hub is named
	 *     under Skip existing and orphaned under Replace.
	 *   - a hub hand-dragged to the vault root is skipped at
	 *     `generation-engine.ts:3605` and is never observed at all.
	 */
	const unjudged = new Set<string>();
	for (const observed of observedHubs ?? []) {
		if (folders.has(observed.folder) || observed.hasRecordedChain) continue;
		unjudged.add(observed.curie);
		result.deviations.push(
			`The index note "${observed.path}" sits in a folder no note of this import reaches; it was left as it was `
			+ 'and is not counted as removed from the source.',
		);
	}
	result.levelHubs.observedUnjudgedCuries = [...unjudged].sort(cmp);

	/**
	 * AM-64 (2026-09-04). The folders this run WRITES INTO: the same ancestor walk,
	 * over the write set alone. A folder outside this set is one no row the run
	 * writes lies within, at any depth.
	 *
	 * This is the fact the caller's held-only decision needs, and it is the one the
	 * amendment's own table names ("a row the run writes describes it"). Its
	 * complement covers the import root as well, which is the folder the older
	 * "identified from the note already in it" test could not reach: the root's
	 * identity is the set's own reserved local part, never a recorded one, so on an
	 * all-skip refresh it was the single hub still rewritten - restamped out of the
	 * legacy address-derived curie the vault held, on a run that wrote nothing.
	 */
	const writtenFolders = new Set<string>();
	for (const e of entries) {
		if (!isWritable(e.note)) continue;
		let dir = dirOf(e.path);
		while (dir !== '' && inScope(dir)) {
			writtenFolders.add(dir);
			dir = dirOf(dir);
		}
	}

	// Direct subfolders, one pass.
	const subfoldersOf = new Map<string, string[]>();
	for (const f of folders) {
		const parent = dirOf(f);
		if (folders.has(parent)) {
			const arr = subfoldersOf.get(parent);
			if (arr) arr.push(f);
			else subfoldersOf.set(parent, [f]);
		}
	}
	// Direct file children per folder — excludes (a) a folder's own hosting
	// note (basename equals the folder's own basename; see step 4.5) and (b)
	// a note that hosts a SIBLING subfolder instead (e.g. `T1078.md` living
	// directly inside a shared parent folder alongside a `T1078/` subfolder —
	// the exact production shape: a sibling-placed parent_note sitting beside
	// its own children folder). Without (b), that note would be counted BOTH
	// as a plain child file AND — via the subfolder's identity, which
	// resolves to the very same note — a second time as "the T1078 folder",
	// producing a duplicate `[[T1078]]` entry in the parent's Contents list.
	const subfolderLabelsOf = new Map<string, Set<string>>();
	for (const [parent, subs] of subfoldersOf) {
		subfolderLabelsOf.set(parent, new Set(subs.map((g) => basename(g))));
	}
	const filesOf = new Map<string, typeof entries>();
	for (const e of entries) {
		const dir = dirOf(e.path);
		if (!folders.has(dir)) continue;
		const lbl = basename(e.path);
		if (lbl === basename(dir)) continue;
		if (subfolderLabelsOf.get(dir)?.has(lbl)) continue;
		const arr = filesOf.get(dir);
		if (arr) arr.push(e);
		else filesOf.set(dir, [e]);
	}

	// The import root, stripped. Since AM-33 a hub's curie is derived from the
	// layout VALUES rather than from a path at all; this remains the input to the
	// LEGACY forms (the identities existing vaults were written under) and to the
	// documented fallback for a caller that hands over no values.
	// Identity must not be derived from address:
	// an address is a choice the user can change (a different destination, a
	// renamed output folder), and an identity that moves with it is not an
	// identity at all — the same hub acquires a second name, the re-import cannot
	// see the note that already exists, and the vault ends up holding two files
	// claiming one thing. The root folder itself has no relative path, so it gets
	// a reserved local part rather than an empty one, which every import under the
	// same ontology prefix would otherwise share by accident.
	const relativeToRoot = (f: string): string => {
		if (!rootIsTrackedAncestor || root === undefined || root === '') return f;
		if (f === root) return '';
		return f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f;
	};

	// AM-33. Folder -> the ordered layout VALUES that produced it.
	//
	// The values arrive from render() on each note (`EnrichNote.layoutValues`);
	// nothing here parses them back out of a path. Alignment is by construction:
	// AM-37 makes render append exactly one value per DIRECTORY SEGMENT of the
	// path it produced, whatever appended that segment, so the k-th ancestor of a
	// note's RENDERED directory is described by the first k values and the k-th
	// value is byte-identical to the k-th segment. `renderedPath` is the anchor
	// rather than `path` because a relocation pass may have inserted a folder
	// render() never emitted, and a value list aligned against that would describe
	// the wrong level. The root is stripped from both sides by `relativeToRoot`,
	// which is sound because the caller prefixes the root onto render's own output
	// (`basePath + '/' + address.primary.path`), so the segments it removes are
	// exactly the ones no layout entry produced.
	//
	// AM-37. A disagreement is a BUG, not a case. It used to `continue`, which
	// left the folder with no recorded values, which sent hub identity back to
	// parsing the path - the very rule these values exist to replace, reached
	// silently, on shapes shipped recipes use. Such a folder is refused by name
	// below instead: no hub note, and a deviation the caller surfaces as a
	// warning. Nothing is guessed and nothing is quiet.
	//
	// AM-44 (2026-09-02). The comparison is ELEMENTWISE AND LOCAL, on three
	// counts, each of which was a real defect in the arity version:
	//
	//   (a) BYTE-FOR-BYTE AT EACH INDEX, never by count. The invariant AM-38
	//       relies on is POSITIONAL IDENTITY - the k-th value IS the k-th segment
	//       - and arity cannot see a value that differs from its segment while
	//       the lengths match. An NFC-decomposed cell (`Zugänge` written as `a` +
	//       U+0308) and a layout that puts a `file` entry before a `folder` entry
	//       both land there, and both would have silently derived a DIFFERENT hub
	//       identity than the shipped path form did, with no duplicate note and no
	//       error to notice it by.
	//
	//   (b) FROM THE FIRST DISAGREEING INDEX DOWN, for this row's chain only. The
	//       old loop marked EVERY folder from the import root's first child to the
	//       row's own leaf, so one malformed cell at level 2 refused the level-1
	//       hub for the whole catalog - a folder thousands of clean rows describe
	//       perfectly. Folders ABOVE the disagreement are described correctly by
	//       this row and are recorded like any other.
	//
	//   (c) A FOLDER ANY ROW ESTABLISHED IS NEVER REFUSED for a sibling's deeper
	//       disagreement: `valuesByFolder` wins over `unalignedFolders` at the
	//       consultation site below. A refusal is for a folder nothing could
	//       describe, not for a folder something else described fine.
	//
	// Iterated in curie order so which note describes a shared folder is
	// deterministic, the same discipline every other derived list here follows.
	const valuesByFolder = new Map<string, LayoutValue[]>();
	const unalignedFolders = new Map<string, string>();
	// AM-50 (2026-09-04). Did this RUN collect values at all?
	//
	// Two states were being read as one. "This caller hands over no values" is a
	// fact about the caller (a bare harness, or notes produced by something other
	// than render()), and the documented path-derived fallback exists for exactly
	// it. "This caller collected values and none of them describe this folder" is
	// something else entirely, and it is the state a MOVED NOTE produces: a note
	// dragged out of its generated folder is found by curie at its new address on
	// the next refresh, `folders` gains the new folder from the note's final path,
	// no rendered chain ever described it, and nothing here disagreed with it
	// either. It was in neither map, so it was not refused, and its hub identity
	// was derived from its ADDRESS - in production, on the write path, with values
	// available. Which is the one thing A-8 says never happens.
	//
	// AM-61 (2026-09-04). A FOLDER IS DESCRIBED ONLY BY A ROW THIS RUN WRITES.
	//
	// Failure mode prevented: a kept row describing its own folder. AM-60 widened
	// the batch, and a kept row's `layoutValues` genuinely describe the folder it
	// already sits in, so `valuesByFolder` gained an entry for every kept folder and
	// AM-54's precedence ("a live chain outranks a recorded one") then preferred it
	// over the identity the note on disk already carries. On a vault whose hubs were
	// written under an earlier scheme that re-derived every one of them under the
	// current scheme and wrote the new curie onto notes the run had otherwise left
	// alone. A kept row HOLDS its folder (see `keptFolders`); it does not describe
	// it. `valuesWereCollected` stays a fact about the CALLER and is read over the
	// whole population, because "this caller hands over no values at all" is not a
	// statement about which half of the batch was written.
	const valuesWereCollected = entries.some((e) => e.note.layoutValues !== undefined);
	for (const e of [...entries].filter((x) => isWritable(x.note)).sort((a, b) => cmp(a.note.curie, b.note.curie))) {
		const lv = e.note.layoutValues;
		// Absent (not empty) means this caller collects no values at all - a
		// harness, or a note produced by something other than render(). That is a
		// fact about the caller, not a disagreement, and it keeps the documented
		// path-derived fallback (see `EnrichNote.layoutValues`).
		if (!lv) continue;
		const renderedDir = relativeToRoot(dirOf(e.note.renderedPath ?? e.path));
		const segs = renderedDir === '' ? [] : renderedDir.split('/');
		// The first index where the record and the path stop being the same string.
		// A value list DEEPER than the directory disagrees at no index that names a
		// folder, so its surplus tail simply describes nothing and is dropped by the
		// slice below; a value list SHORTER than the directory disagrees at the
		// first segment it does not reach.
		let firstDisagreement = -1;
		for (let i = 0; i < segs.length; i++) {
			if (i >= lv.length || lv[i].value !== segs[i]) { firstDisagreement = i; break; }
		}
		let abs = rootIsTrackedAncestor && root !== undefined ? root : '';
		for (let i = 0; i < segs.length; i++) {
			abs = abs === '' ? segs[i] : `${abs}/${segs[i]}`;
			if (firstDisagreement !== -1 && i >= firstDisagreement) {
				// Named, not counted: the folder, the row that disagreed, and the cell
				// whose recorded value did not match the directory it produced. A
				// deviation a user cannot trace to a source cell is a deviation they
				// cannot fix.
				if (!unalignedFolders.has(abs)) {
					const recorded = i < lv.length ? `the value "${lv[i].value}" for level "${lv[i].level}"` : 'no value at all';
					unalignedFolders.set(
						abs,
						`No index note was created for the folder "${abs}". While placing "${e.note.curie}" this import `
						+ `recorded ${recorded} at that folder level, but the level was written as "${segs[i]}", so `
						+ 'Crosswalker cannot say what the folder is about and will not guess from its path. The notes '
						+ 'themselves were written normally. Please report this with the recipe and the source row that '
						+ 'produced it.',
					);
				}
				continue;
			}
			if (!valuesByFolder.has(abs)) valuesByFolder.set(abs, lv.slice(0, i + 1));
		}
	}

	/**
	 * AM-50. The import root itself, which is the ONE folder whose identity is not
	 * a claim about a layout at all.
	 *
	 * No row's chain describes the root: the value chain starts AT the root and
	 * records the folders below it, so `valuesByFolder` never keys the root by
	 * construction. Its identity is the set's own reserved local part
	 * (`hub/_root`), which reads no address and moves with no destination, so the
	 * refusal AM-50 adds must not fire on it. Getting this wrong would refuse the
	 * home note of every import.
	 */
	const isImportRoot = (f: string): boolean => rootIsTrackedAncestor && root !== undefined && f === root;

	/**
	 * AM-52 (2026-09-04). THE FOURTH STATE: a folder that holds a row THIS RUN KEPT
	 * where the layout would no longer put it.
	 *
	 * `folders` is walked from each note's FINAL path (the folder that exists);
	 * `valuesByFolder` is walked from its RENDERED chain (the folder the layout
	 * asked for). Skip mode is the one mode that makes those differ on purpose: a
	 * source release that recategorises a row leaves the note where it is (skip never
	 * moves) and renders it somewhere else, so the old folder is in `folders`, is in
	 * no value chain, disagrees with nothing, and hosts nothing.
	 *
	 * Failure mode prevented: AM-50's refusal firing on an ORDINARY refresh. The old
	 * folder's hub stopped being written, dropped out of `producedCuries`, and the
	 * orphan pass reported the index note of a folder that still holds notes as
	 * vanished (A-8's "zero new orphans", failed on a skip refresh) - while the
	 * deviation told the user their note had been moved and to move it back, which
	 * nobody did and which is not an action they can take. A refusal names the cause
	 * it observed, not the most likely story about it: there are at least two ways to
	 * reach "no chain describes this folder", and only one of them is the user's
	 * doing.
	 *
	 * Positive evidence only, exactly like flip-back: `renderedPath` is set AND
	 * differs in DIRECTORY from the final path. A note whose rendered and final
	 * directories agree is not evidence of anything.
	 *
	 * AM-54 (2026-09-04). THE WHOLE CHAIN, not the leaf. An exemption granted to a
	 * folder is granted to the chain that contains it.
	 *
	 * Failure mode prevented: `folders` is walked from each note's final path and
	 * collects every ANCESTOR of it, while this collected only the directory the note
	 * literally sits in. So on any layout deeper than one folder level, the holder was
	 * exempt and every folder above it fell straight back into AM-50's third state:
	 * described by no chain of this run (the chains all describe the NEW address),
	 * hosting nothing, disagreeing with nothing. Its hub was refused, dropped out of
	 * `producedCuries`, and the results screen reported an orphan on a refresh where
	 * nothing left the source and every note was exactly where it had been. A catalog
	 * rename on the shipped two-level recipe is enough; no exotic input, no
	 * hand-edited vault. The walk stops BELOW the import root, which is exempt on its
	 * own terms (`isImportRoot`) and must never be described as kept.
	 *
	 * AM-61 (2026-09-04). Walked over the HELD SET alone — the rows this run kept.
	 * "Kept in place" is a fact about a row the run declined to write, and asking a
	 * written row the same question mixes the two halves of the batch back together:
	 * a relocated or moved row would claim the kept exemption (and, through it, the
	 * recorded-identity route) for a folder this run is actively describing.
	 *
	 * AM-65 (2026-09-04). THE WRITE SET IS THE WHOLE TEST. The old co-condition -
	 * `renderedPath` present AND its directory differing from the final path's - was
	 * the inference this arc removes: a fact about who holds a folder, recovered
	 * from a path comparison. It also made the exemption conditional on the row
	 * having been RECATEGORISED, so an ordinary all-skip refresh (nothing moved
	 * anywhere) held no folder at all, every hub the kept rows imply went
	 * unaccounted, and the run reported notes sitting in the vault as gone.
	 *
	 * The comparison is not a fallback and must not return as one: a note whose
	 * rendered folder differs from its own and which IS in the write set is a
	 * relocation this run performs, not a hold.
	 */
	const keptFolders = new Set<string>();
	for (const e of entries) {
		if (isWritable(e.note)) continue;
		let dir = dirOf(e.path);
		while (dir !== '' && !isImportRoot(dir) && inScope(dir)) {
			if (folders.has(dir)) keptFolders.add(dir);
			dir = dirOf(dir);
		}
	}

	/**
	 * AM-55. What the vault holds at this folder, for the kept state only. Gated on
	 * `keptFolders` so a fact about an ordinary folder can never become a second
	 * address route for it.
	 */
	const keptObservationOf = (f: string): OwnedHubAtFolder | undefined =>
		(keptFolders.has(f) ? ownedHubsByFolder?.get(f) : undefined);

	/**
	 * AM-52. The identity such a folder's hub ALREADY CARRIES, read off the existing
	 * hub note's `hub_values` by the caller. Never derived from the folder's path:
	 * the kept state is not a licence to re-open the address route, it is a reason to
	 * keep the record the vault already has.
	 */
	const recordedValuesOf = (f: string): LayoutValue[] | null => {
		const observed = keptObservationOf(f);
		if (observed?.state !== 'one') return null;
		const values = observed.values;
		return values && values.length > 0 ? values : null;
	};

	/**
	 * AM-55. Index notes this run leaves exactly as they are and must still account
	 * for. Accumulated by `refusalFor` because that is the ONE place the precedence
	 * between hosted / described / kept / undescribed is decided, and a second copy
	 * of that ladder here is a second answer waiting to drift from it. `refusalFor`
	 * is called for every folder in Pass B below, is idempotent, and this is a set.
	 */
	const keptExistingCuries = new Set<string>();

	/**
	 * S4 (2026-09-04). WHICH NOTE HOSTS THIS FOLDER, keyed by the folder.
	 *
	 * `byBasename` is whole-batch and basename-keyed: any note ANYWHERE in the
	 * import whose basename equals the folder's last segment answered "this folder
	 * is hosted". As an identity rule that is step 4.5's own long-standing
	 * behaviour; as a REFUSAL EXEMPTION it is a bypass, because whether a folder's
	 * values disagree with it is a question about values that a basename cannot
	 * answer. An unrelated row sharing a last segment made a genuine disagreement
	 * disappear.
	 *
	 * Hosting is therefore decided by PLACEMENT: the note inside the folder
	 * (`f/<label>.md`, the folder-note form) or the note beside it
	 * (`dirOf(f)/<label>.md`, the sibling form this codebase calls the production
	 * shape). Both are notes the run actually put at that folder, so the hosting
	 * row's own chain reached it. A note somewhere else in the import that merely
	 * shares the name is not hosting anything.
	 */
	const hostByFolder = new Map<string, EnrichNote>();
	for (const f of folders) {
		const host = byBasename.get(basename(f));
		if (!host) continue;
		const hostDir = dirOf(finalPath(host));
		if (hostDir === f || hostDir === dirOf(f)) hostByFolder.set(f, host);
	}

	/**
	 * AM-56 (2026-09-04). The trailing sentence every refusal about a folder carries.
	 *
	 * A fact about the vault is never recovered from the batch, not to identify a note
	 * and not to UN-WRITE one. A previous run may have written this folder's Contents
	 * list into some other note's managed region; whether it did is a fact that note
	 * carries, and nothing in this batch can answer it. The retraction that tried
	 * (whole-batch basename, the rule placement replaced) could by construction only
	 * ever name a note that was NOT the host, and appended an empty managed region to
	 * it. So the stale list is DISCLOSED rather than rewritten.
	 *
	 * Extension point, named and not built: a `hosted_folders` key recorded on the
	 * host note would make hosting a fact the vault carries. When that lands, the
	 * retraction returns as a read of that record and this sentence goes away.
	 */
	const STALE_LIST_DISCLOSURE = "Any list that still names this folder's index note is left as it was.";

	/**
	 * Residual ruling 5 (2026-09-04). Is this recorded curie one THIS import could
	 * have minted - this ontology's prefix, and a local part after it?
	 *
	 * Deliberately a shape test and nothing more. It does not ask whether the local
	 * part is one the current derivation would produce, because that is exactly the
	 * question AM-61 removed: a hub written under an earlier derivation records a
	 * perfectly good identity that today's rule would spell differently, and
	 * re-deriving it renames every hub in an existing vault.
	 *
	 * Failure mode prevented: carrying a foreign or malformed name forward as this
	 * import's identity. The owned index, the orphan diff and every Contents entry
	 * would then be keyed on a curie this import never minted, and nothing in the
	 * run would say so.
	 */
	const isCurieOfThisOntology = (curie: string): boolean => isCurieOfOntology(curie, ontology);

	/**
	 * AM-44. Is this folder one the run declines to describe, and why?
	 *
	 * Consulted BEFORE `identityOf` and INSIDE the parent's children loop, which
	 * is the whole point: the old order computed a path-derived identity for the
	 * refused folder anyway and the parent then listed `[[label]]` for a hub note
	 * that was never written. That is a dangling managed link, or worse a silent
	 * resolution to whatever unrelated note happens to share the basename, sitting
	 * inside the one hub that survived. A hub the run declines to write is not
	 * identified, not listed in Contents, and not linked to.
	 *
	 * Two exemptions, both of them "there is nothing here to guess":
	 *   - a folder ANY row described by values (`valuesByFolder`) is aligned, and
	 *     a sibling row's deeper disagreement says nothing about it;
	 *   - a folder HOSTED by an existing note takes that note's own curie, so no
	 *     path is read and dropping its Contents list would be a loss with no
	 *     corresponding risk.
	 *
	 * AM-50 (2026-09-04) adds the THIRD state, and it is the one that was missing:
	 * a folder no row described AT ALL. Refusing only the folders a row described
	 * WRONGLY adopted the easy half of the rule - it declined to guess when it
	 * knew it disagreed, and guessed freely when it knew nothing.
	 */
	const refusalFor = (f: string): string | undefined => {
		// AM-50. The root is described by the set, not by a row. See `isImportRoot`.
		if (isImportRoot(f)) return undefined;
		// AM-54. The precedence, top to bottom: hosted by placement, then described by
		// a chain of this run, then kept in place, then undescribed. A DESCRIBED folder
		// is never treated as kept - a live chain outranks a recorded one, so a folder
		// this run can name is named from what it just rendered and never from what a
		// previous run wrote down.
		if (hostByFolder.has(f)) return undefined;
		if (valuesByFolder.has(f)) return undefined;
		const unaligned = unalignedFolders.get(f);
		if (unaligned) return unaligned;
		// AM-52/AM-54. THE FOURTH STATE, asked before AM-50's: this folder is on the
		// chain of a row this run kept in place. A folder holding a note the run
		// vouched for is not a folder the run knows nothing about.
		if (keptFolders.has(f)) {
			const observed = keptObservationOf(f);
			// AM-55. Two index notes in one folder is a question, not a pick. Choosing
			// the first would write one note's identity over the other's meaning, and
			// the run has no way to tell which one describes the folder.
			if (observed?.state === 'many') {
				// AM-59. BOTH curies are accounted for. The run read both notes this
				// pass and is about to print their paths, so letting the orphan pass
				// call them vanished is a consequence clause the same run contradicts.
				// Refusing to choose is not evidence that either note left the source.
				for (const curie of observed.curies) keptExistingCuries.add(curie);
				return `No index note was written for the folder "${f}": it holds more than one index note `
					+ `(${observed.paths.map((p) => `"${p}"`).join(', ')}), so Crosswalker cannot say which one `
					+ 'describes the folder. Keep one of them and rename or remove the others, then run the import '
					+ `again. ${STALE_LIST_DISCLOSURE}`;
			}
			// S18 (2026-09-04). ONE VOICE PER FOLDER. The caller read an index note in
			// this folder, found that its recorded chain describes a DIFFERENT folder
			// (S12), has already named that note in a warning, and has already declared
			// the run's picture incomplete so nothing is reported as vanished. A second
			// message from here would be this pass asserting "no index note" about a
			// folder the caller can see one in. Silence, and no hub: `identityOf` has no
			// values and no record to work from, so it returns null and Pass B writes
			// nothing.
			if (observed?.state === 'withheld') return undefined;
			// Residual ruling 5 (2026-09-04). A RECORDED IDENTITY THAT IS NOT THIS
			// IMPORT'S IS REPORTED, NEVER REPAIRED.
			//
			// The recorded curie is the fact the note carries and the engine neither
			// adopts nor re-derives it - a hand edit is the user's act on their own note.
			// But a curie belonging to some other prefix (or no prefix at all) cannot be
			// carried forward as this import's identity either: everything keyed on it -
			// the owned index, the orphan diff, the parent's Contents - would be keyed on
			// a name this import never minted. So it is named, once, and nothing is
			// written or re-minted for the folder. The curie is still accounted for,
			// because the note demonstrably exists and this run just read it.
			if (observed?.state === 'one' && !isCurieOfThisOntology(observed.curie)) {
				keptExistingCuries.add(observed.curie);
				return `The index note for the folder "${f}" was left as it was: its recorded identity is not a curie of `
					+ 'this import. The notes in it were kept in place by Skip existing. Re-run with Replace to '
					+ `re-establish it. ${STALE_LIST_DISCLOSURE}`;
			}
			// Row 1. The hub keeps the identity it already records, so it is written and
			// listed exactly as before.
			if (recordedValuesOf(f)) return undefined;
			// AM-55 row 2. THE NOTE IS THERE and this run has no identity to write onto
			// it, so it is left byte for byte and accounted for as produced. Saying it
			// "stays as it was" while the same run reported it as vanished was the
			// failure mode: the cause was the one observed, and the consequence clause -
			// the half the user acts on - was false.
			//
			// S18 (2026-09-04). THE CAUSE IS THE ONE OBSERVED. "The index note predates
			// recorded identity" was a story about the observation, not the observation:
			// what this pass actually saw is that the note carries no `hub_values` +
			// `hub_levels` pair it can use. A run that computed no values writes exactly
			// that state (AM-39), and so does a hand edit, and so does a length mismatch,
			// and none of those is an old note. Naming the wrong cause sends the user to
			// fix the wrong thing.
			//
			// AM-79 (2026-09-04). THIS SENTENCE HAS ONE OWNER AND IT IS S18. AM-68
			// deleted the text `its recorded identity could not be read`, but that
			// deletion reaches the FOLDER-LEVEL `unreadable` arm and its text alone. The
			// sentence here belongs to state `one`: a note the run READ, whose
			// frontmatter carries no usable recorded chain. That is a fact about the
			// note, not a failure to read the folder, and it stands unchanged. It is
			// pinned at `tests/d1-pass20-s17-s18-address-and-withheld.test.ts:147`, and
			// the tri-state assertions re-pointed under AM-67 point here.
			if (observed?.state === 'one') {
				keptExistingCuries.add(observed.curie);
				return `The index note for the folder "${f}" was left as it was: its recorded identity could not be read. `
					+ 'The notes in it were kept in place by Skip existing. Re-run with Replace to re-establish it. '
					+ STALE_LIST_DISCLOSURE;
			}
			// AM-55 row 3. No index note is in the folder at all, so there is nothing to
			// leave alone and nothing to account for.
			//
			// AM-59 (2026-09-04). The sentence names THE POPULATION IT READ. The
			// observation behind this branch is that no note in THIS IMPORT'S owned
			// index sits in that folder carrying `kind: 'hub'`; a note belonging to
			// another set, carrying no `import_set` block (every hub written before
			// import sets landed), carrying no curie, or having lost `kind` is invisible
			// to that walk. "No index note exists" is a claim about the whole vault made
			// from a set-filtered read, and it is false about a note sitting in the
			// folder while the message denies it.
			//
			// S18 (2026-09-04). The CAUSE is now observed too. "No earlier run recorded
			// this folder's identity" is a claim about history that this pass has no
			// evidence for: what it observed is that the set-filtered read found no index
			// note of this import in the folder. A run may have recorded one and had it
			// deleted, renamed, or written before import sets existed.
			//
			// AM-68 (2026-09-04). THE QUALIFIED FORM, when a note in this folder could
			// not be read this run. It says what was observed - no index note of this
			// import could be READ here, and something here was unreadable - and it does
			// not claim which note that was. Pass 21 said "the index note ... could not be
			// read" from an observation about ANY owned note, so a cache-cold concept note
			// made the run assert something about an index note it may never have seen.
			if (observed?.hasUnreadableNote) {
				return `No index note of this import could be read in the folder "${f}"; a note in it could not be read `
					+ 'this run. The notes in it were kept in place by Skip existing. Wait for Obsidian to finish '
					+ `indexing the vault, then run the import again. ${STALE_LIST_DISCLOSURE}`;
			}
			return `This import has no index note for the folder "${f}" and none was created: the notes in it were kept in `
				+ 'place by Skip existing and no index note of this import was found in it. Re-run with Replace to '
				+ `create it. ${STALE_LIST_DISCLOSURE}`;
		}
		// The caller collects no values at all, so "no row described this folder" is
		// true of every folder and says nothing. The documented path-derived
		// fallback covers this state and only this state.
		//
		// AM-71 (2026-09-04). ASKED BELOW THE KEPT/HELD BRANCH, not above it. Above
		// it, a run that collected no layout values was silent about every held
		// folder - including one whose index note is absent, which is AM-64's row 3
		// and the one state whose refusal that amendment's own justification depends
		// on ("the run refuses by name; it does not restore what the user removed").
		// The kept/held rows are decided by what the vault records, not by whether
		// this caller happened to collect values, so they speak either way; only
		// AM-50's "no row of this run describes the folder" needs the values to be
		// meaningful, and it is the only thing below this line.
		if (!valuesWereCollected) return undefined;
		// AM-50. This run DID collect values and none of them reach this folder.
		// Named as what it is, with the cause a user can actually act on. The
		// ordinary way to arrive here is a generated note moved by hand: it is
		// found by its curie at the new address, so its folder joins the import
		// without any row's layout ever placing anything there.
		return `No index note was created for the folder "${f}". No row of this run describes the folder; the note may `
			+ 'have been moved. The notes themselves were written normally, and Crosswalker will not name a folder from '
			+ `its path. Move the note back, or re-run the import so the folder is described by the layout. ${STALE_LIST_DISCLOSURE}`;
	};

	/**
	 * AM-38. ONE derivation for a hub's identity, given the ordered parts that
	 * describe the folder chain. Two derivations were two places to disagree, and
	 * they did: the value form slugged a part whole (`slug()` collapses `/` to
	 * `-`) while the path form split on `/` first, so a single separator inside a
	 * folder value produced two different identities for one hub. That silently
	 * re-identified every level hub in an existing vault - no duplicate note, no
	 * error, just a curie that changed under everything keyed on it.
	 *
	 * The two callers differ ONLY in what they hand in, so byte-compatibility is a
	 * property of the input rather than a coincidence to be re-checked: AM-37
	 * guarantees the k-th value is byte-identical to the k-th path segment, so
	 * `parts.map(slug).join('/')` is the same string either way. The root folder
	 * has no parts at all, so it gets a reserved local part rather than an empty
	 * one, which every import under the same ontology prefix would otherwise
	 * share by accident.
	 */
	const hubCurieFromParts = (parts: readonly string[]): string =>
		`${ontology}:hub/${parts.length === 0 ? ROOT_HUB_LOCAL_PART : parts.map(slug).join('/')}`;
	const valueHubCurieOf = (f: string): string | null => {
		const values = valuesByFolder.get(f);
		if (!values || values.length === 0) return null;
		return hubCurieFromParts(values.map((v) => v.value));
	};
	const pathHubCurieOf = (f: string): string => {
		const rel = relativeToRoot(f);
		return hubCurieFromParts(rel === '' ? [] : rel.split('/'));
	};
	/**
	 * AM-50 (2026-09-04). A LEVEL HUB'S IDENTITY COMES FROM VALUES OR FROM NOWHERE.
	 *
	 * The `?? pathHubCurieOf(f)` this used to end with was the address route,
	 * still open. It was justified as "the documented fallback for a caller that
	 * hands over no values", and that caller is real - but it was not the caller
	 * that reached it. A production run with complete, correct values reached it
	 * for any folder its values did not describe, and derived the hub's identity
	 * from the folder's path with no refusal, no deviation and no warning. An
	 * address is a choice the user can change; an identity that moves with it is
	 * not an identity.
	 *
	 * So the fallback now serves ONLY the two states it was written for: a run
	 * that collected no values at all, and the import root, whose reserved local
	 * part reads no address (see `isImportRoot`). When the run did collect values,
	 * any OTHER folder they do not describe has no identity here, and `refusalFor`
	 * above has already refused it by name, so this returns null on a path nothing
	 * reaches.
	 */
	/**
	 * AM-52. The RECORDED identity, for the kept-in-place folder only. Derived from
	 * the existing hub note's own `hub_values` through the one derivation
	 * (`hubCurieFromParts`), so it is byte-identical to the curie that note already
	 * carries and the hub is found rather than re-minted or reported as vanished.
	 */
	/**
	 * AM-61 (2026-09-04). READ FROM THE HUB, NOT RE-DERIVED FROM IT.
	 *
	 * The identity a kept folder keeps is the string the note on disk carries, not
	 * the string this run's derivation would mint from that note's recorded values.
	 * The two agree for every hub written under the current scheme, which is why
	 * re-deriving looked harmless; they part company on exactly the vault this rule
	 * exists for. A hub written before a derivation changed records values that
	 * describe its folder perfectly and a curie that no longer matches what those
	 * values now derive to, so re-derivation renamed the identity of every hub in an
	 * existing vault on a refresh that was otherwise leaving them alone. An identity
	 * a previous run wrote down is a fact; a derivation is an opinion about it.
	 *
	 * Row 1 of AM-55's table still requires a usable recorded chain: without one the
	 * note is row 2 and nothing is written for it at all.
	 */
	const recordedHubCurieOf = (f: string): string | null => {
		const observed = keptObservationOf(f);
		if (observed?.state !== 'one') return null;
		// Residual ruling 5 (2026-09-04). A recorded curie that is not this import's
		// is not an identity this run may carry. `refusalFor` has already named it;
		// returning null here is what stops the folder being written under it, and no
		// repair or re-derivation is attempted - see `isCurieOfThisOntology`.
		if (!isCurieOfThisOntology(observed.curie)) return null;
		return recordedValuesOf(f) ? observed.curie : null;
	};

	/**
	 * AM-62/AM-64. Is this folder HELD-ONLY - no row this run writes lies within it
	 * at any depth, and nothing places a note at it?
	 *
	 * Asked with the same precedence `refusalFor` and `identityOf` use, so the three
	 * cannot disagree about which folders these are.
	 *
	 * AM-64 (2026-09-04) replaced the older third clause ("identified entirely from
	 * the note already sitting in it") with `writtenFolders`. Two failure modes:
	 *
	 *   - the IMPORT ROOT could never satisfy the old clause, because its identity
	 *     is the set's own reserved local part rather than a recorded one. So on an
	 *     all-skip refresh it was the one hub still rewritten - restamped out of the
	 *     legacy address-derived curie the vault held, its provenance replaced, its
	 *     `produced_at` moved, on a run that wrote no note at all;
	 *   - the clause conflated "held" with "has a usable record". A held folder
	 *     WITHOUT one is refused by `refusalFor` and emits no hub, so the record
	 *     test was never the thing deciding, and stating it here invited the two to
	 *     drift apart.
	 *
	 * A described folder always contains the row that describes it, so it is in
	 * `writtenFolders` and is never held - the amendment's "a row the run writes
	 * describes it", read off the population rather than restated.
	 */
	const heldByRecord = (f: string): boolean =>
		!hostByFolder.has(f)
		&& !valuesByFolder.has(f)
		&& !writtenFolders.has(f);
	const hubCurieOf = (f: string): string | null =>
		valueHubCurieOf(f)
		?? recordedHubCurieOf(f)
		?? (valuesWereCollected && !isImportRoot(f) ? null : pathHubCurieOf(f));
	/**
	 * The address-derived forms this hub may already be written under, newest
	 * superseded first: the root-relative form (pre-AM-33) and the full-vault-path
	 * form (pre-F-4). Both are computed from the CURRENT render, so both can only
	 * match a hub that has not moved — stated here because the caller's step 2
	 * relies on exactly that limitation and answers a moved hub by reading notes
	 * instead (step 3).
	 */
	const legacyHubCuriesOf = (f: string): string[] => {
		// Deduplicated: with no import root the two forms are the same string, and a
		// list that names one alias twice would have the alias-adoption guard claim
		// the same identity twice and refuse the hub as a duplicate of itself.
		const out = new Set<string>();
		out.add(pathHubCurieOf(f));
		out.add(`${ontology}:hub/${slugPath(f)}`);
		return [...out];
	};

	// Pass A: every folder's link identity — hosted by an existing same-
	// basename note (wherever it currently lives), or synthetic.
	//
	// AM-50. NULL means "this run cannot name this folder", which is the answer
	// for a folder no row described. Every caller is already behind `refusalFor`,
	// so null is unreachable in practice; it is returned rather than guessed so
	// that a future edit which forgets the refusal cannot silently re-open the
	// address route instead of failing visibly.
	const identity = new Map<string, FolderIdentity>();
	const identityOf = (f: string): FolderIdentity | null => {
		const label = basename(f);
		const cached = identity.get(f);
		if (cached) return cached;
		// S7 ruling (2026-09-04). THE SAME HOST SET THE REFUSAL USES: hosting is a
		// question about PLACEMENT, and it must be answered the same way on the write
		// path as on the refusal path.
		//
		// Failure mode prevented: whole-batch `byBasename` gave a folder the curie of
		// any note ANYWHERE in the import whose basename equalled the folder's last
		// segment, and wrote that folder's children list into that note's path. That
		// is identity from the folder's last path segment, on the write path, for a
		// folder whose own values were available; the folder got no hub note of its
		// own; and two folders sharing a basename overwrote each other in
		// `hostedChildrenByPath`, last one by sorted folder order winning. S4 closed
		// that door for the refusal and left this one open because `refusalFor`
		// exempts a described folder on its first line and never reaches here.
		const host = hostByFolder.get(f);
		let id: FolderIdentity;
		if (host) {
			id = { curie: host.curie, label, hostedPath: finalPath(host) };
		} else {
			const curie = hubCurieOf(f);
			if (curie === null) return null;
			// AM-52. A kept-in-place folder carries its RECORDED chain forward, so the
			// hub note is rewritten with the `hub_values` it already had. Dropping them
			// would clear the one record of what the folder is about (`hub_levels` and
			// `hub_values` are always-managed keys, so an absent one is erased, not
			// preserved) and the next run would have nothing to keep.
			const values = valuesByFolder.get(f) ?? recordedValuesOf(f) ?? undefined;
			id = {
				curie,
				label,
				legacyCuries: legacyHubCuriesOf(f).filter((c) => c !== curie),
				...(values ? { levelValues: values } : {}),
			};
		}
		identity.set(f, id);
		return id;
	};

	// This batch's facet hub notes (step 4 already ran; `result.hubs` is
	// populated and sorted by path), as the ROOT hub's "Facets" sub-list —
	// they materialize in the SAME Pass 1.5 run as level hubs but wouldn't
	// otherwise be visible to each other (found 2026-07-11: the root home
	// note's Contents omitted facet hubs even though both land in the same
	// folder). Root-only: an ordinary (non-root) level hub lists its own
	// folder's direct children only, same as before. Deliberately NOT added to
	// `result.edgeCount`: step 4 already counted each hub's own MEMBER edges
	// when it built `result.hubs`; this is a display grouping on the root
	// note, not a new graph relationship being introduced.
	const rootFacetLinks = result.hubs.map((h) => `[[${basename(h.path)}]]`);

	// Pass B: direct children (sorted by curie), materialize.
	const sortedFolders = [...folders].sort(cmp);
	for (const f of sortedFolders) {
		// AM-37. The refusal. A folder whose values and segments disagree is a
		// folder this run cannot describe, and the alternative to saying so is
		// deriving its identity from its address again - which is how a moved or
		// re-rooted vault ended up with a second hub note for a folder that already
		// had one, the first orphaned with the user's prose on it. Refusing one hub
		// costs an index note; guessing costs the identity.
		//
		// AM-44. Asked BEFORE `identityOf`, so a folder the run will not write is
		// never given an identity in the first place. Identifying it and then
		// declining to write it is what left the parent hub linking to a note that
		// does not exist.
		const unaligned = refusalFor(f);
		if (unaligned) {
			// AM-56. The refusal is DISCLOSED and nothing is un-written. See
			// `STALE_LIST_DISCLOSURE` for why a retraction cannot be aimed from here.
			result.deviations.push(unaligned);
			continue;
		}
		const id = identityOf(f);
		// AM-50. Unreachable behind the refusal above; the belt is here so a folder
		// this run cannot name can never be written under a name taken from its path.
		if (!id) continue;
		const childRefs: { curie: string; label: string }[] = [];
		for (const e of filesOf.get(f) ?? []) childRefs.push({ curie: e.note.curie, label: basename(e.path) });
		for (const g of subfoldersOf.get(f) ?? []) {
			// AM-44. A refused subfolder is not linked to. Its hub note is not being
			// written, so a `[[label]]` here is a link to nothing (or to whatever
			// unrelated note shares the basename), emitted into a MANAGED section the
			// user cannot repair by hand because the next run rewrites it.
			if (refusalFor(g)) continue;
			const gid = identityOf(g);
			if (!gid) continue;
			childRefs.push({ curie: gid.curie, label: gid.label });
		}
		childRefs.sort((a, b) => cmp(a.curie, b.curie));
		const links = childRefs.map((c) => `[[${c.label}]]`);
		result.edgeCount += links.length;
		const isRoot = rootIsTrackedAncestor && f === root;
		const facetGroup = isRoot && rootFacetLinks.length > 0 ? [{ label: 'Facets', links: rootFacetLinks }] : [];

		if (id.hostedPath) {
			// A note already hosts this folder (e.g. a concept row whose id
			// equals the root folder's own name). `hostedChildrenByPath`'s value
			// is a plain wikilink array (shared with every non-root hosted
			// folder, and asserted as such by existing tests) — extending it to
			// carry a facets group too would ripple into every hosted-folder
			// consumer for a case that's vanishingly rare in real usage (the
			// per-import basePath colliding with an actual row's id). Known,
			// deliberately out of scope here; the synthetic branch below is
			// what real generation-engine imports produce for the root.
			//
			// AM-72 (2026-09-04). This list is derived over the WHOLE population, so it
			// is correct for a host note the run KEPT as well as one it wrote - and the
			// caller now maintains the managed region on a kept host from it. Failure
			// mode prevented: a `## Contents` region the user is told not to edit
			// permanently naming N-1 of N children, because the folder's index note
			// happened to be a row this run held.
			result.levelHubs.hostedChildrenByPath.set(id.hostedPath, links);
			// AM-76. Which folder this note hosts, said by the pass that decided it.
			result.levelHubs.hostedFolderByPath.set(id.hostedPath, f);
		} else {
			result.levelHubs.notes.push({
				path: joinMd(f, id.label),
				curie: id.curie,
				// AM-33. The values go ONTO the note. A hub that records what it is
				// about can be found again by reading it, which is the only lookup
				// that survives a moved destination, a changed layout above it, and a
				// derivation the product later improves. Without this the sole record
				// of a hub's subject is the folder it happens to sit in, and the
				// answer to "does this hub already exist" has to be recomputed from an
				// address on every run - the defect this closes.
				frontmatter: {
					curie: id.curie,
					kind: 'hub',
					children: links,
					...(id.levelValues
						? {
							hub_levels: id.levelValues.map((v) => v.level),
							hub_values: id.levelValues.map((v) => v.value),
						}
						: {}),
				},
				body: `# ${id.label}\n\n${buildManagedChildrenSection('Contents', links, facetGroup)}`,
				childrenLinks: links,
				...(facetGroup.length > 0 ? { facetLinks: rootFacetLinks } : {}),
				...(id.legacyCuries && id.legacyCuries.length > 0 ? { legacyCuries: id.legacyCuries } : {}),
				...(id.levelValues ? { levelValues: id.levelValues } : {}),
				// AM-62/AM-64. This folder is HELD-ONLY: no row this run writes lies
				// within it, at any depth. The run therefore has nothing new to say about
				// its index note beyond a children list that may have changed, so the
				// caller preserves the identity and provenance the note already carries,
				// writes it only when something actually differs, and never CREATES one
				// that is absent - a run that wrote nothing here does not restore a note
				// the user removed.
				...(heldByRecord(f) ? { heldFolder: true as const } : {}),
				// AM-71. The import root's home note is the set's own. See
				// `HubNote.importRoot`: held-only is still true of it on an all-skip run,
				// and it is still created rather than refused.
				...(isRoot ? { importRoot: true as const } : {}),
			});
		}
	}

	// Root/home hub fallback: only when `rootFolder` was given a name but isn't
	// itself a tracked ancestor folder (no note path is actually prefixed by
	// it) — the bare golden-vault harness case (module header's step 4.5 note).
	// In real usage `root` IS a tracked ancestor and was already handled above
	// by the uniform per-folder pass, so this never double-creates a root hub.
	if (root !== undefined && root !== '' && !folders.has(root)) {
		const label = basename(root);
		const childRefs: { curie: string; label: string }[] = [];
		// Top-level folders first, so their (possibly hosted) labels are known
		// before filtering top-level files — a folder's HOST note (e.g. sibling
		// `T1078.md` beside top-level `T1078/`) must be represented ONCE, via
		// the folder's own identity, not also as an unrelated top-level file.
		// AM-44: the same rule as Pass B's children loop - this is a parent's
		// children loop too, and a refused folder has no hub note to link to.
		// AM-50. Identified ONCE, and a folder with no identity drops out of both
		// lists together, so the label filter below can never be steered by a
		// folder the run declined to name.
		const topFolders = sortedFolders
			.filter((f) => !folders.has(dirOf(f)) && !refusalFor(f))
			.map((f) => identityOf(f))
			.filter((id): id is FolderIdentity => id !== null);
		const topFolderLabels = new Set(topFolders.map((id) => id.label));
		for (const id of topFolders) {
			childRefs.push({ curie: id.curie, label: id.label });
		}
		for (const e of entries) {
			if (dirOf(e.path) !== '') continue;
			const lbl = basename(e.path);
			if (topFolderLabels.has(lbl)) continue; // already represented via its folder's identity above
			childRefs.push({ curie: e.note.curie, label: lbl });
		}
		/**
		 * S9 (2026-09-04). WHICH NOTE HOSTS THE ROOT, decided by PLACEMENT - the same
		 * test `hostByFolder` makes for every other folder.
		 *
		 * Failure mode prevented: a write target chosen from the whole batch by
		 * basename. `byBasename` is basename-keyed and whole-batch, so any note
		 * ANYWHERE in the import whose basename equalled the root's last segment
		 * became the root's host, and this folder's entire Contents list was written
		 * into that unrelated note's managed region. That is identity from a path
		 * segment on the WRITE path - the rule S4 replaced at the refusal site and the
		 * S7 ruling replaced for `identityOf` - and it is the one place it survived.
		 * Two folders sharing a basename also overwrote each other's entry in
		 * `hostedChildrenByPath`.
		 *
		 * Two candidates is a question, not a pick, and it is answered the way AM-55
		 * answers two index notes in one folder: refused by name, nothing written. No
		 * candidate is not a refusal - it is the ordinary state this fallback exists
		 * for, and the synthetic hub below is its answer.
		 *
		 * This branch is the HARNESS path. It is gated on `!folders.has(root)`, and in
		 * a real import every note path is prefixed by the destination, so the root is
		 * always a tracked ancestor and Pass B above has already handled it. It is
		 * fixed anyway because the rule is an absolute, not a risk assessment.
		 */
		const rootHostCandidates = entries.filter(
			(e) => basename(e.note.path) === label && (dirOf(e.path) === root || dirOf(e.path) === dirOf(root)),
		);
		if (rootHostCandidates.length > 1) {
			const named = rootHostCandidates.map((e) => `"${e.path}"`).sort().join(', ');
			result.deviations.push(
				`No index note was written for the folder "${root}": more than one note in this import is placed at it `
				+ `and named after it (${named}), so Crosswalker cannot say which one describes the folder. Rename all `
				+ `but one of them, then run the import again. ${STALE_LIST_DISCLOSURE}`,
			);
		} else if (childRefs.length > 0) {
			childRefs.sort((a, b) => cmp(a.curie, b.curie));
			const links = childRefs.map((c) => `[[${c.label}]]`);
			result.edgeCount += links.length;
			const facetGroup = rootFacetLinks.length > 0 ? [{ label: 'Facets', links: rootFacetLinks }] : [];
			const host = rootHostCandidates[0]?.note;
			if (host) {
				// See the matching comment in Pass B: hosted-root facets are a
				// deliberately out-of-scope rare edge case.
				result.levelHubs.hostedChildrenByPath.set(finalPath(host), links);
				// AM-76. Same fact from the harness path: this host hosts the root.
				result.levelHubs.hostedFolderByPath.set(finalPath(host), root);
			} else {
				// Same rule as `hubCurieOf` above: this hub IS the import root, so its
				// relative path is empty and it takes the reserved local part. The
				// old form slugged `root` — i.e. the destination — straight into the
				// identity, which is the exact coupling being removed.
				const curie = `${ontology}:hub/${ROOT_HUB_LOCAL_PART}`;
				const legacyCurie = `${ontology}:hub/${slug(root)}`;
				result.levelHubs.notes.push({
					path: `${label}.md`,
					curie,
					frontmatter: { curie, kind: 'hub', children: links },
					body: `# ${label}\n\n${buildManagedChildrenSection('Contents', links, facetGroup)}`,
					childrenLinks: links,
					...(facetGroup.length > 0 ? { facetLinks: rootFacetLinks } : {}),
					...(legacyCurie !== curie ? { legacyCuries: [legacyCurie] } : {}),
					// AM-71. The same fact as Pass B's root: this hub IS the import root.
					importRoot: true as const,
				});
			}
		}
	}

	// AM-55. The index notes this run left exactly as they are, for the caller to
	// account for. Written LAST, after every `refusalFor` call this pass makes
	// (Pass B, the children loops, and the root fallback's filter), so a curie can
	// never be observed after the list the caller reads has been fixed. Sorted, like
	// every other derived list here.
	result.levelHubs.keptExistingCuries = [...keptExistingCuries].sort(cmp);

	result.levelHubs.notes.sort((a, b) => cmp(a.path, b.path));
}

/**
 * Residual ruling 5 (2026-09-04), exported by AM-73 (2026-09-04). Is this
 * recorded curie one the named ontology could have minted - its prefix, and a
 * local part after it?
 *
 * Deliberately a shape test and nothing more. It does not ask whether the local
 * part is one the current derivation would produce, because that is exactly the
 * question AM-61 removed: a hub written under an earlier derivation records a
 * perfectly good identity that today's rule would spell differently, and
 * re-deriving it renames every hub in an existing vault.
 *
 * ONE implementation, exported, because AM-73 asks the same question at the
 * engine's root-hub writer. Two copies of a shape test are two answers waiting
 * to disagree about which recorded identities this import may carry.
 *
 * Failure mode prevented: carrying a foreign or malformed name forward as an
 * import's identity. The owned index, the orphan diff and every Contents entry
 * would then be keyed on a curie the import never minted, and nothing in the run
 * would say so.
 */
export function isCurieOfOntology(curie: string, ontology: string): boolean {
	const i = curie.indexOf(':');
	return i > 0 && curie.slice(0, i) === ontology && curie.length > i + 1;
}

/**
 * Curie local part for the import root's own hub. Reserved because the root's
 * path relative to itself is empty, and an empty local part is not a name.
 * `slug()` lowercases and strips to `[a-z0-9-]`, so no real folder can produce
 * a leading underscore and collide with this.
 */
const ROOT_HUB_LOCAL_PART = '_root';

/** Slug every segment of a folder path independently, joined the same way (a readable multi-segment curie local part). */
function slugPath(path: string): string {
	return path.split('/').map(slug).join('/');
}

/** Directory a path lives in ('' for a root-level path). */
function dirOf(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? '' : path.slice(0, idx);
}

/** Join a directory + basename into a `.md` path ('' dir → a root-level path). */
function joinMd(dir: string, base: string): string {
	return `${dir ? `${dir}/` : ''}${base}.md`;
}

interface PathShape {
	/** True when `path` is already `.../<base>/<base>.md` (folder-note form). */
	isFolderNoteShaped: boolean;
	/** The directory that holds this note when it's a SIBLING (`dir/base.md`). */
	containerDir: string;
	/** The directory named after this note's own basename — its folder-note
	 *  home (`containerDir/base/`), and, coincidentally, where its own
	 *  variadic children (if any) already nest. */
	folderDir: string;
	base: string;
}

/** Classify a path as sibling- or folder-note-shaped, and derive both candidate directories. */
function pathShape(path: string): PathShape {
	const base = basename(path);
	const dir = dirOf(path);
	const dirBase = dir === '' ? '' : (dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir);
	if (dir !== '' && dirBase === base) {
		// Folder-note shaped: .../<base>/<base>.md — one level up is the sibling home.
		return { isFolderNoteShaped: true, containerDir: dirOf(dir), folderDir: dir, base };
	}
	return { isFolderNoteShaped: false, containerDir: dir, folderDir: dir ? `${dir}/${base}` : base, base };
}

/**
 * The folder-note candidate path for a SIBLING-shaped path (`dir/base.md` →
 * `dir/base/base.md`). Exported so generation-engine's re-import lookup can
 * check whether a concept already lives there (curie-verified) before writing
 * a fresh sibling — the risky seam design §4 calls out. `render()` always
 * computes the sibling form (Pass 1 knows nothing about parent_note), so the
 * input here is always sibling-shaped in practice; an already folder-note-
 * shaped input is returned unchanged (defensive, not expected).
 */
export function folderNoteCandidatePath(siblingPath: string): string {
	const shape = pathShape(siblingPath);
	if (shape.isFolderNoteShaped) return siblingPath;
	return joinMd(shape.folderDir, shape.base);
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** The wikilink targets of a note's `parent` frontmatter value (empty `[[]]` → none). */
function parentTargets(frontmatter: Record<string, unknown>): string[] {
	return extractWikilinkTargets(frontmatter.parent);
}

/** Extract every `[[target]]` inner target from a string or array value. */
export function extractWikilinkTargets(value: unknown): string[] {
	const out: string[] = [];
	const scan = (v: unknown): void => {
		if (typeof v === 'string') {
			const re = /\[\[([^\]]+)\]\]/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(v)) !== null) {
				const inner = m[1].split('|')[0].split('#')[0].trim();
				if (inner) out.push(inner);
			}
		} else if (Array.isArray(v)) {
			for (const item of v) scan(item);
		}
	};
	scan(value);
	return out;
}

/** Last path segment without the `.md` extension. */
function basename(path: string): string {
	return path.split('/').pop()!.replace(/\.md$/i, '');
}

/** Stable string compare (deterministic across locales). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Trim leading/trailing slashes off a folder path. */
function stripSlashes(p: string): string {
	return p.replace(/^\/+|\/+$/g, '');
}

/**
 * Slug a value for a curie local part (lowercase, non-alnum → `-`).
 *
 * AM-27 (2026-08-31), deferred with a reason. This is many-to-one exactly like
 * the sanitizers that amendment made injective: two facet values `Access
 * Control` and `access-control` produce one hub curie, so one hub note holds two
 * facets' membership. It is NOT covered by AM-27's rule, which is scoped to the
 * identity a source ROW derives, and it cannot be corrected here without the
 * same pinning: hub curies are already in vaults, so changing this function
 * silently re-identifies every hub note ever written. `enrich()` is pure and
 * receives no `ImportSetReference`, so pinning it means plumbing the set's
 * derivation through this module - a separate change with its own proof
 * obligations, not a line edit. The within-run duplicate guard does not reach it
 * either: hubs are not rows.
 */
function slug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Tagsafe a value (mirrors the render template `tagsafe` filter). */
function tagsafe(value: string): string {
	return value
		.replace(/[^A-Za-z0-9_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase();
}

/** Filesystem-safe a value for a hub note filename (mirrors the `fs-safe` filter). */
function fsSafe(value: string): string {
	return value
		.replace(/[<>:"/\\|?* -]/g, '_')
		.replace(/[\s.]+$/g, '')
		.trim();
}

// ---------------------------------------------------------------------------
// Hub-note body merge (re-import safety)
// ---------------------------------------------------------------------------

/**
 * Merge a freshly-regenerated hub note body with an existing one, preserving the
 * user's prose. A hub note body is a managed H1 line (`# Persistence`) followed
 * by any user prose. On re-import we regenerate the H1 (in case the value name
 * changed) but keep everything the user wrote below it.
 *
 * `existingBody` is the body of the note already in the vault (frontmatter
 * stripped); `freshBody` is the newly-built managed body (H1 + trailing newline).
 * Returns the body to write. Deterministic + idempotent.
 */
export function mergeHubBody(existingBody: string, freshBody: string): string {
	const normalized = existingBody.replace(/\r\n/g, '\n');
	// Find the first H1 line; everything after it is user prose.
	const lines = normalized.split('\n');
	const h1Index = lines.findIndex((l) => /^#\s+/.test(l));
	if (h1Index === -1) {
		// No managed H1 in the existing body — treat all of it as user prose and
		// append below the fresh H1.
		const prose = normalized.replace(/^\n+/, '');
		return prose ? `${freshBody.replace(/\n+$/, '')}\n\n${prose}` : freshBody;
	}
	const userProse = lines.slice(h1Index + 1).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
	const freshH1 = freshBody.replace(/\n+$/, '');
	return userProse ? `${freshH1}\n\n${userProse}\n` : `${freshH1}\n`;
}

// ---------------------------------------------------------------------------
// Level-hub managed body sections + the Waypoint marker (re-import safety)
// ---------------------------------------------------------------------------

/**
 * The `children` region: Pass 1.5's half of the managed-body contract
 * (src/generation/managed-body.ts). Different writer, different time, different
 * inputs from the `body` region — Pass 1.5 runs after the whole stream and has
 * no row scope, so it cannot re-render `body`; the row write does not yet know
 * the children, so it cannot render `children`. One region would force one of
 * them to reconstruct the other by parsing it back out, which is exactly the
 * guess the design removes.
 *
 * These markers shipped in v0.1.6 WITHOUT a version stamp. `v=` absent means
 * v=1 under the closed grammar, so every already-generated note in every real
 * vault is a valid v1 region with zero migration; emission adds `v=1` from now
 * on.
 */

/**
 * Build a level hub's managed "Contents" section: a heading + a bullet list of
 * `[[...]]` wikilinks, wrapped in HTML-comment markers (invisible in reading
 * view) so `mergeManagedChildrenSection` can find-and-replace exactly this
 * block on re-import without disturbing anything else in the note.
 *
 * `extraGroups` (2026-07-11, the root-hub facets fix): additional labeled
 * sub-lists appended after the main `links` list, INSIDE the same managed
 * block — one bold label line + its own bullet list per group. Currently used
 * for the ROOT hub only, to list this batch's facet hub notes (materialized
 * in the same Pass 1.5 run, step 4, before level hubs — step 4.5 — so they'd
 * otherwise never appear in the root's own Contents even though both land in
 * the same folder). A group with zero links is omitted entirely (no empty
 * "Facets:" label with nothing under it).
 */
export function buildManagedChildrenSection(
	heading: string,
	links: string[],
	extraGroups: { label: string; links: string[] }[] = [],
): string {
	const list = links.length > 0 ? links.map((l) => `- ${l}`).join('\n') : '*(nothing yet)*';
	let inner = `## ${heading}\n${list}\n`;
	for (const g of extraGroups) {
		if (g.links.length === 0) continue;
		inner += `\n**${g.label}:**\n${g.links.map((l) => `- ${l}`).join('\n')}\n`;
	}
	return `${wrapRegion('children', inner)}\n`;
}

/**
 * Merge a freshly-built managed children section into an existing body,
 * replacing ONLY the delimited block (identity by markers, not by heading
 * text — a user renaming "## Contents" doesn't break the next merge). Any
 * text outside the markers — including a user's own H1/title, prose before or
 * after the block, or (when Waypoint has expanded it) a `%% Begin Waypoint %%`
 * block — survives untouched. No existing block → the section is appended
 * after whatever's already there (first-import shape: `# Title\n\n<section>`
 * still applies via the caller; this function only handles the block itself).
 */
export function mergeManagedChildrenSection(
	existingBody: string,
	freshSection: string,
	/**
	 * AM-56 (2026-09-04). The fresh section lists NOTHING. An empty section is never
	 * APPENDED; it only rewrites a region the note already carries.
	 *
	 * Failure mode prevented: creating a managed region on a note that never had one.
	 * `buildManagedChildrenSection` renders an empty list as a visible
	 * `## Contents` / `*(nothing yet)*`, and an empty array is truthy, so a caller
	 * handing over "nothing to list" wrote that block into the note - inside the one
	 * part of a note the user is told the next run owns and must not edit by hand.
	 * Rewriting an existing region to empty is honest, because the run maintains that
	 * region and stands behind its emptiness. Manufacturing one is not.
	 */
	freshIsEmpty = false,
): string {
	const block = freshSection.replace(/\n+$/, '');
	const scan = scanRegions(existingBody);
	// AM-56. Nothing to list, and no region of ours to rewrite: leave the note's
	// bytes exactly as they are. `replaceRegion` appends a missing region too, so the
	// question is whether a CHILDREN region is there, not whether any region is.
	if (freshIsEmpty && !(scan.ok && findSpan(scan.spans, 'children'))) return existingBody;
	if (scan.ok && scan.spans.length > 0) {
		// Byte-preserving: everything outside the region keeps its exact bytes —
		// line endings, trailing whitespace, blank-line runs. Since 2026-08-27 this
		// function also runs over bodies that carry a `body` region and the user's
		// own prose, so normalising here would silently rewrite a user's file.
		return replaceRegion(existingBody, scan.spans, 'children', block);
	}
	// No regions at all (an unmarked legacy hub), or markers this build cannot
	// read. Append rather than guess. Leading blank lines carry no meaning here
	// (the blank-line separator `buildNoteContent` puts between the closing `---`
	// and the body), so a merge never drifts the leading whitespace across
	// successive re-imports.
	const normalized = existingBody.replace(/\r\n/g, '\n').replace(/^\n+/, '');
	const trimmed = normalized.replace(/\n+$/, '');
	return trimmed ? `${trimmed}\n\n${freshSection}` : freshSection;
}

/**
 * Append the `%% Waypoint %%` trigger comment to a hub/folder-note body when
 * it isn't already present — idempotent across re-imports, and safe once the
 * Waypoint plugin has itself expanded the trigger into a `%% Begin Waypoint %%
 * … %% End Waypoint %%` block (that expanded form also matches, so it is never
 * stripped or duplicated). Additive and opt-in (2026-07-11 ICSB audit §4
 * verdict): Crosswalker's own managed children section stays the primary,
 * always-on connectivity mechanism; this only lets Waypoint additionally track
 * notes a user later adds to the folder by hand.
 */
export function ensureWaypointMarker(body: string): string {
	if (/%%\s*(Begin\s+)?Waypoint\s*%%/i.test(body)) return body;
	const trimmed = body.replace(/\n+$/, '');
	return `${trimmed}\n\n%% Waypoint %%\n`;
}
