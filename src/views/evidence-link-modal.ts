/**
 * evidence-link-modal.ts — the "link evidence to a control" command.
 *
 * The Obsidian half of `evidence-link.ts`. Asks for a control and an evidence
 * document by those names, never as "subject" and "object", so the direction
 * that decides whether coverage works cannot be entered backwards.
 */

import {
	App,
	Modal,
	Notice,
	Setting,
	TFile,
	normalizePath,
	type ButtonComponent,
	type DropdownComponent,
	type TextComponent,
} from 'obsidian';
// S7 (2026-09-04). ONE reader for "did the properties answer", the tri-state
// one. The two-state convenience is deliberately not imported here: every read
// in this file tells the user a cause, and null cannot tell a stranger's plain
// note from a damaged note of our own.
import { readNoteFrontmatterState } from '../export/vault-reader';
import {
	buildEvidenceLink,
	evidenceLinkCurie,
	type EvidenceCoverage,
	type EvidenceStatus,
} from './evidence-link';
import { CANONICAL_EVIDENCE_PREDICATE } from '../tier2/evidence-coverage';
import { readReviewGroupCids, type ReviewGroupCids } from '../generation/hash';
// AM-17. The same door the engine passes through, not a second copy of it.
import { addressRefusal, crossSetAddressMessage } from '../generation/generation-engine';
import { buildIdentityIndex, type IdentityIndex } from '../generation/identity-index';
import { countUnindexedMarkdownFiles } from '../generation/import-set';
// AM-39. The same merge machinery a re-import uses, not a second copy of it.
import { readExistingNote, ExistingNoteReadError, type ExistingNote, splitNoteText } from '../generation/existing-note';
import { scanRegions, findSpan, replaceRegion, wrapRegion } from '../generation/managed-body';

/** A control note the user can link evidence to. */
export interface ControlCandidate {
	path: string;
	title: string;
	curie: string | null;
	/**
	 * `_crosswalker.review_cid` — the control's review-normalized content
	 * fingerprint, recorded on an approved link so a later upstream edit to this
	 * control can invalidate the claim. Null when the control carries none.
	 */
	reviewCid: string | null;
	reviewGroups?: ReviewGroupCids | null;
}

/** Read `_crosswalker.review_cid` from a frontmatter object, or null. */
export function readReviewCid(fm: unknown): string | null {
	if (!fm || typeof fm !== 'object') return null;
	const provenance = (fm as Record<string, unknown>)._crosswalker;
	if (!provenance || typeof provenance !== 'object') return null;
	const value = (provenance as Record<string, unknown>).review_cid;
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Read a complete `_crosswalker.review_groups` block, or null. */
export function readReviewGroups(fm: unknown): ReviewGroupCids | null {
	if (!fm || typeof fm !== 'object') return null;
	const provenance = (fm as Record<string, unknown>)._crosswalker;
	if (!provenance || typeof provenance !== 'object') return null;
	return readReviewGroupCids((provenance as Record<string, unknown>).review_groups);
}

/** The result of one whole-vault pass for control notes. */
export interface ControlCandidateScan {
	/** Concept notes this command can link evidence to, by path order. */
	controls: ControlCandidate[];
	/**
	 * Notes whose properties could not be read at all, so nothing is known about
	 * them — including whether they are controls. Never silently dropped: the
	 * count is shown, and a note the command was INVOKED FROM being in here is a
	 * refusal rather than a reason to offer a different control.
	 */
	unreadable: string[];
}

/**
 * Concept notes in the vault, newest-imported first by path order.
 *
 * A note qualifies when it carries a `curie` and is not itself a junction or a
 * crosswalk edge. Linking evidence to an evidence link is not meaningful, and
 * offering it invites exactly the inverted-direction mistake this command
 * exists to prevent.
 *
 * AM-46 (2026-09-02). READ FAIL-CLOSED, exactly like the pair scan below. This
 * used to be `getFileCache(file)?.frontmatter` and nothing else, run in the
 * modal's constructor: a note Obsidian had not reached yet simply was not a
 * control, so a partly-indexed vault produced a SILENTLY SHORT list with nothing
 * to indicate anything was missing. Cache lag is not absence
 * (`project_cache_lag_is_not_absence`); a cache miss is read off disk, and the
 * only thing that keeps a file out of the answer is a fact about the file.
 *
 * Failure mode prevented: the command being run from a control note Obsidian
 * had not indexed, finding nothing for it, and quietly linking the evidence to
 * A DIFFERENT CONTROL — the first one in the list. That is an audit fact
 * attached to the wrong subject, written while the notice says the link was
 * created. AM-40's ruling put the gate where the read can see; this is the read
 * that was still blind, one frame above where the gate used to sit.
 */
export async function scanControlCandidates(app: App): Promise<ControlCandidateScan> {
	const out: ControlCandidate[] = [];
	const unreadable: string[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		let fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) {
			const read = await readNoteFrontmatterState(app, file);
			// `none` is a fact (this file has no properties, so it is not a control).
			// `unreadable` is the absence of a fact and is reported, never counted as
			// a "no".
			if (read.state === 'unreadable') { unreadable.push(file.path); continue; }
			if (read.state !== 'ok') continue;
			fm = read.frontmatter;
		}
		if (typeof fm.curie !== 'string' || fm.curie === '') continue;
		if (fm.kind === 'junction-note' || fm.kind === 'crosswalk-edge') continue;
		out.push({
			path: file.path,
			title: typeof fm.title === 'string' && fm.title ? fm.title : file.basename,
			curie: fm.curie,
			reviewCid: readReviewCid(fm),
			reviewGroups: readReviewGroups(fm),
		});
	}
	out.sort((a, b) => a.path.localeCompare(b.path));
	return { controls: out, unreadable };
}

/**
 * Markdown files Obsidian has not finished parsing yet.
 *
 * AM-24 (2026-08-31): the implementation moved next to the rules that must not
 * run without it (`src/generation/import-set.ts`) and is re-exported here for
 * the callers that already reach for it through this module. One measurement of
 * "is the vault readable yet", not one per window.
 */
export { countUnindexedMarkdownFiles };

const EVIDENCE_COVERAGES = ['full', 'partial', 'none'] as const;
const EVIDENCE_STATUSES = ['proposed', 'in_review', 'approved'] as const;

/** What the three review controls show before anything is known about a pair. */
const FORM_DEFAULT_COVERAGE: EvidenceCoverage = 'full';
const FORM_DEFAULT_STATUS: EvidenceStatus = 'proposed';

/** A frontmatter value that is one of a closed set of strings, or null. */
function readEnum<T extends string>(value: unknown, allowed: readonly string[]): T | null {
	return typeof value === 'string' && allowed.includes(value) ? (value as T) : null;
}

/** `[[Path|Label]]` -> `Path`, or null when the value is not a wikilink. */
function wikilinkTarget(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /\[\[([^\]|#^]+)/.exec(value);
	return match ? match[1].trim() : null;
}

/**
 * AM-39. The frontmatter keys THIS WINDOW writes, and therefore owns.
 *
 * Everything else a junction note carries belongs to whoever put it there: the
 * reviewer's `reviewer`, `review_date`, `confidence`, `expires_at` and `notes`,
 * a recipe's extra columns, another plugin's keys. The window has no control for
 * any of them and no opinion about them, so an update carries them across
 * untouched rather than dropping them because it did not happen to re-emit them.
 *
 * AM-41 (2026-09-02). `reviewed_against` LEFT this set. It is not a field the
 * window has an opinion about; it is the RECORD OF AN ACT — what the approver
 * read when they approved. Owning it meant re-emitting it against the control's
 * CURRENT fingerprint on every update, so a reviewer who opened the window to
 * adjust a scope on an already-drifted approval silently re-baselined the
 * attestation and the drift report flipped the row back to current. That is a
 * fabricated audit fact, which is the one outcome the whole re-attestation
 * mechanism exists to prevent. It is written only by the act that produces it
 * (see `statusSetInThisWindow`), and carried byte-for-byte otherwise.
 *
 * AM-42 (2026-09-02). `_crosswalker` LEFT this set too. The window's own
 * provenance block carries no `import_set`, so overwriting the note's block
 * stripped the junction's OWNERSHIP: the recipe that created the link could no
 * longer find it in its owned index, the address branch refused the row, and the
 * remedy the product offered the user was to delete the reviewed note. A
 * junction a recipe created still belongs to that recipe after any number of
 * window edits. On a CREATE the window still emits its own block — a
 * window-minted junction belongs to no import set, and that is a fact about it.
 *
 * `tags` is deliberately not here either, but for a third reason: it is
 * LIST-UNIONED with the note's own value (see `unionListBlock`), exactly as
 * `mergeFrontmatter` does on re-import, so a hand-added tag survives AND a
 * removed `evidence/junction` tag comes back.
 */
const WINDOW_MANAGED_KEYS: ReadonlySet<string> = new Set([
	'curie', 'kind', 'title', 'subject', 'subject_curie', 'predicate', 'object',
	'coverage', 'status', 'scope',
]);

/**
 * Keys whose fresh value is UNIONED with the note's existing value rather than
 * replacing it or being dropped. Mirrors `frontmatter-merge.ts`'s
 * `LIST_UNION_KEYS`, which is the rule a re-import applies to the same note.
 */
const LIST_UNION_KEYS: ReadonlySet<string> = new Set(['tags']);

/** One top-level frontmatter key and the raw lines that belong to it. */
interface FrontmatterBlock { key: string; lines: string[] }

/**
 * Split a properties block into its top-level keys, keeping every line as it is
 * written.
 *
 * Deliberately textual. A user's key is carried across an update by copying its
 * BYTES, so a quoted string keeps its quotes, a date keeps its shape, a comment
 * keeps its place, and a value this product does not understand is not
 * re-serialised into something it would rather have. A key's block runs until
 * the next line that starts a top-level key; indented lines and block-sequence
 * dashes belong to the key above them.
 */
function frontmatterBlocks(text: string): FrontmatterBlock[] {
	const out: FrontmatterBlock[] = [];
	let current: FrontmatterBlock | null = null;
	for (const line of text.split('\n')) {
		const startsTopLevel = line !== ''
			&& !/^[\s-]/.test(line)
			&& !line.trimStart().startsWith('#')
			&& line.includes(':');
		if (startsTopLevel) {
			current = { key: line.slice(0, line.indexOf(':')).trim().replace(/^["']|["']$/g, ''), lines: [line] };
			out.push(current);
		} else if (current) {
			current.lines.push(line);
		} else {
			// Anything before the first key (a leading comment, a blank line) is
			// nobody's value and is kept under a key no writer can own.
			current = { key: '', lines: [line] };
			out.push(current);
		}
	}
	return out;
}

/** One item of a YAML list, with any surrounding quotes removed for comparison. */
function unquote(value: string): string {
	const trimmed = value.trim();
	return /^(".*"|'.*')$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** The items of a `key: [a, b]` or `key:\n  - a\n  - b` block, or null. */
function readListBlock(lines: string[]): { items: string[]; inline: boolean } | null {
	if (lines.length === 0) return null;
	const head = lines[0];
	const colon = head.indexOf(':');
	if (colon < 0) return null;
	const inlineValue = head.slice(colon + 1).trim();
	if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
		// A flow list continued over several lines is not a shape this product
		// writes and not one this parser will guess at.
		if (lines.length > 1 && lines.slice(1).some((l) => l.trim() !== '')) return null;
		const inner = inlineValue.slice(1, -1).trim();
		return { items: inner === '' ? [] : inner.split(',').map((i) => i.trim()).filter((i) => i !== ''), inline: true };
	}
	if (inlineValue !== '') return null;
	const items: string[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim() === '') continue;
		const match = /^\s*-\s*(.*)$/.exec(line);
		if (!match) return null;
		items.push(match[1].trim());
	}
	return { items, inline: false };
}

/**
 * AM-42. The union of a list key's fresh and existing values, in the note's own
 * style, or null when either side is a shape this parser will not guess at.
 *
 * Fresh items first then the note's extras, de-duplicated — the same order and
 * the same rule `frontmatter-merge.ts` applies on re-import, so the window and a
 * refresh cannot disagree about what a junction's tags are.
 *
 * Failure mode prevented: the comment on `WINDOW_MANAGED_KEYS` promising a
 * union while the code carried the note's block and dropped the fresh one, so a
 * junction whose `evidence/junction` tag someone deleted by hand never got it
 * back through this window (a re-import would have restored it) and the note
 * stayed invisible to every tag-driven view.
 */
function unionListBlock(freshLines: string[], existingLines: string[]): string[] | null {
	const fresh = readListBlock(freshLines);
	const existing = readListBlock(existingLines);
	if (!fresh || !existing) return null;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of [...fresh.items, ...existing.items]) {
		const key = unquote(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	// The note's own style is kept: rewriting a user's block list into a flow list
	// is a diff they did not ask for on a key they own half of.
	const head = existingLines[0];
	const keyText = head.slice(0, head.indexOf(':') + 1);
	if (existing.inline) return [`${keyText} [${out.join(', ')}]`];
	return [keyText, ...out.map((item) => `  - ${item}`)];
}

/**
 * The merged properties block: this window's keys as it just wrote them, plus
 * every key the note already carried that the window does not own, verbatim.
 */
function mergeFrontmatterText(freshText: string, existingText: string, managed: ReadonlySet<string>): string {
	const carried = frontmatterBlocks(existingText).filter((block) => !managed.has(block.key));
	const carriedByKey = new Map(carried.map((block) => [block.key, block]));
	const unioned = new Set<string>();
	const out: string[] = [];
	for (const block of frontmatterBlocks(freshText)) {
		const existing = carriedByKey.get(block.key);
		if (existing && LIST_UNION_KEYS.has(block.key)) {
			const union = unionListBlock(block.lines, existing.lines);
			// Unparseable on either side: the note's bytes are kept untouched. A tag
			// list nobody can read is not a tag list to rewrite.
			if (union) { out.push(...union); unioned.add(block.key); }
			continue;
		}
		// The note's own value wins for a key the window does not own, so a second
		// click never re-asserts a default over a person's answer.
		if (existing) continue;
		out.push(...block.lines);
	}
	for (const block of carried) { if (!unioned.has(block.key)) out.push(...block.lines); }
	return out.join('\n');
}

/**
 * AM-39. What an existing evidence link becomes when this window updates it.
 *
 * The frontmatter merges (managed keys only). The body is the note's, not the
 * window's, unless the window can show that it owns it: a managed `body` region
 * is rebuilt inside its markers with everything around it untouched, and a body
 * byte-identical to what the window itself last wrote for this note is
 * refreshed. Anything else is a person's writing and is left exactly as it is,
 * even at the cost of a stale sentence in it. Losing a paragraph someone wrote
 * is not recoverable; a stale sentence is.
 */
function mergeIntoExistingLink(
	current: ExistingNote,
	freshMarkdown: string,
	previousBody: string | null,
	managed: ReadonlySet<string>,
): { ok: true; markdown: string } | { ok: false; detail: string } {
	const scan = scanRegions(current.body);
	if (!scan.ok) return { ok: false, detail: scan.detail };
	const fresh = splitNoteText(freshMarkdown);
	let body: string;
	if (findSpan(scan.spans, 'body')) {
		body = replaceRegion(current.body, scan.spans, 'body', wrapRegion('body', fresh.body));
	} else if (previousBody !== null && current.body === previousBody) {
		body = fresh.body;
	} else {
		body = current.body;
	}
	const frontmatter = mergeFrontmatterText(fresh.frontmatterText, current.frontmatterText, managed);
	return {
		ok: true,
		markdown: body.trim() ? `---\n${frontmatter}\n---\n\n${body}` : `---\n${frontmatter}\n---\n`,
	};
}

/** The `reviewed_against` block a junction note already records, or null. */
function readRecordedReviewedAgainst(fm: Record<string, unknown> | undefined): {
	reviewCid: string | null;
	reviewGroups: ReviewGroupCids | null;
} | null {
	if (!fm) return null;
	const against = fm.reviewed_against;
	if (!against || typeof against !== 'object' || Array.isArray(against)) return null;
	const source = against as Record<string, unknown>;
	const cid = typeof source.review_cid === 'string' && source.review_cid.trim() !== '' ? source.review_cid.trim() : null;
	return { reviewCid: cid, reviewGroups: readReviewGroupCids(source.review_groups) };
}

export interface EvidenceLinkModalDeps {
	app: App;
	folder: string;
	/**
	 * AM-46. The path of the note the command was INVOKED FROM, when it was
	 * invoked from one — not a resolved candidate.
	 *
	 * The caller used to resolve it against a cache-only read of its own, so a
	 * control Obsidian had not indexed yielded `undefined` and the window fell
	 * through to the first control in the list. The window resolves it against
	 * the one fail-closed scan instead, and a path it cannot read is a refusal
	 * rather than a reason to offer a different control.
	 */
	initialControlPath?: string;
}

/**
 * AM-43. What the window knows about the (control, evidence) pair now displayed.
 *
 * Resolved ONCE per pair, before the review controls are answerable, so the form
 * can show the pair's recorded state and then write exactly what it shows.
 */
interface PairResolution {
	controlPath: string;
	evidencePath: string;
	/** Vault-wide, for the mint-collision check and the address refusal. */
	index: IdentityIndex;
	/** The note that IS this link, or null when nothing records the pair. */
	existing: { file: TFile; curie: string | null } | null;
	/** That note as read from disk, fail-closed. Null when there is no note. */
	current: ExistingNote | null;
}

/**
 * AM-48. What a lookup FOUND, before anything decides whether it still counts.
 *
 * `PairResolution` minus the pair itself: the pair is what the caller asked
 * about, and only the caller knows whether that question is still the one on
 * screen.
 */
type PairLookup = Pick<PairResolution, 'index' | 'existing' | 'current'>;

/**
 * AM-48. A named reason this pair cannot be resolved, carried out of the lookup
 * rather than written into the form from inside it.
 *
 * Failure mode prevented: a stale lookup posting its refusal over a pair it is
 * not about. The lookup states the reason; `resolvePair` decides whether the
 * reason is still about the pair the person is looking at.
 */
class PairLookupRefusal extends Error {}

/**
 * S6 (2026-09-04). The vault's own file list, indexed, for the one question the
 * metadata cache may not be able to answer yet: which file a recorded wikilink
 * names.
 */
interface LinkFallbackIndex {
	byPath: Set<string>;
	byBasename: Map<string, string[]>;
}

/**
 * S6. One snapshot of the vault's files. Pure; reads no cache.
 *
 * S5 ruling (2026-09-04). EVERY file, not `getMarkdownFiles()`.
 *
 * Failure mode prevented: an evidence document is the user's own file and is
 * routinely not a markdown note - a PDF policy, a screenshot, an exported
 * spreadsheet - and `create()` accepts one (the existence check is a warning, not a
 * gate). Indexed from the markdown list only, a junction whose object is such a file
 * answered `false` here whenever the resolver had gone silent, so the pair scan
 * concluded nothing recorded the pair and minted a SECOND junction: exactly the
 * defect S6 was ruled to close, closed for markdown and left open for everything
 * else. `getMarkdownFiles()` is a subset of `getFiles()`, and only the `.md`
 * extension is stripped below, so no markdown behaviour changes.
 */
function buildLinkFallbackIndex(app: App): LinkFallbackIndex {
	const byPath = new Set<string>();
	const byBasename = new Map<string, string[]>();
	for (const file of app.vault.getFiles()) {
		byPath.add(file.path);
		// From the path, not from `TFile.basename`, so this answers the same way on
		// any host that can list files.
		//
		// S8, ruled 2026-09-04, ACCEPTED AS IS. Only `.md` is stripped, so a file with
		// an extension keys under its full name (`Access.pdf`) and shares no bucket
		// with `Access.md`. A file with NO extension is the one exception: a vault file
		// literally named `Access` joins `Access.md` here, `linkFallbackResolves`
		// refuses the now-ambiguous bare basename, and the scan concludes nothing
		// records the pair and mints a second junction, which the existing message
		// discloses. Fail-closed and left as is: guessing at Obsidian's proximity
		// tie-break would put the scan back to concluding from something it does not
		// know, which is the defect this index exists to remove.
		const base = (file.path.split('/').pop() ?? file.path).replace(/\.md$/i, '');
		const bucket = byBasename.get(base);
		if (bucket) bucket.push(file.path);
		else byBasename.set(base, [file.path]);
	}
	return { byPath, byBasename };
}

/**
 * S6. Does `linkPath` name the file at `targetPath`, decided from the vault's
 * file list rather than from the metadata cache?
 *
 * The two forms this can answer without an index of its own: a path (with or
 * without the extension), and a BARE basename with no separator in it. A bare
 * basename is only accepted when exactly ONE file in the vault carries it,
 * because Obsidian's tie-break for a duplicated basename is a proximity rule
 * this cannot reproduce, and guessing at it would put the scan back to
 * concluding from something it does not know. A path-shaped link that names no
 * file is a dangling link, which IS a fact: it names nothing, so it does not
 * name the target.
 */
function linkFallbackResolves(index: LinkFallbackIndex, linkPath: string, targetPath: string): boolean {
	if (index.byPath.has(linkPath)) return linkPath === targetPath;
	if (index.byPath.has(`${linkPath}.md`)) return `${linkPath}.md` === targetPath;
	if (linkPath.includes('/')) return false;
	const named = index.byBasename.get(linkPath) ?? [];
	return named.length === 1 && named[0] === targetPath;
}

export class EvidenceLinkModal extends Modal {
	private controls: ControlCandidate[] = [];
	private unreadableControls = new Set<string>();
	private control: ControlCandidate | null = null;
	private evidencePath = '';
	private coverage: EvidenceCoverage = FORM_DEFAULT_COVERAGE;
	private status: EvidenceStatus = FORM_DEFAULT_STATUS;
	/** Renamed from `scope`: Modal already owns that property. */
	private evidenceScope = '';
	/**
	 * AM-41. Did the person set `status` IN THIS WINDOW, IN THIS SESSION?
	 *
	 * This is a record of an ACT, not a reading of the form's state: the dropdown
	 * sets it when it fires, and nothing else can. It is the only thing that
	 * authorises writing `reviewed_against`, because a review baseline is what the
	 * approver read at the moment they approved, and no amount of inspecting a
	 * form afterwards can recover whether anybody approved anything.
	 *
	 * Cleared on every pair resolution: an act performed on one pair says nothing
	 * about the next one.
	 */
	private statusSetInThisWindow = false;

	/** AM-43. The one lookup for the pair now displayed, and its lifecycle. */
	private resolution: PairResolution | null = null;
	private resolving = false;
	/**
	 * AM-48 (2026-09-04). Which lookup owns the form's contents.
	 *
	 * Incremented at the START of every lookup. A lookup whose token is no longer
	 * the latest discards its whole result: it writes no control, no flag, no
	 * resolution, and re-enables nothing.
	 *
	 * Failure mode prevented: a reviewer's approval silently reverted, and the
	 * revert reported as a successful update. `resolving` was one boolean shared
	 * by every lookup, so whichever finished FIRST re-enabled the controls while
	 * another was still running; the reviewer set Status to Approved; the second
	 * lookup then ran its prefill unconditionally, resetting `status` to the
	 * note's own value and clearing `statusSetInThisWindow` (the act flag that is
	 * the sole authority for writing an attestation); and the write reported
	 * "Updated the existing link." The rule AM-43 states needs an owner for the
	 * thing it is a rule about: what the form shows is what it writes, and only
	 * one lookup at a time may decide what the form shows.
	 */
	private resolveToken = 0;
	/**
	 * AM-48. The pair the latest lookup is running FOR, recorded when it starts.
	 *
	 * Recorded at start rather than only on settle, because during a lookup
	 * `resolution` is null, so an early return that tested `resolution` alone let
	 * re-entering the SAME pair start a second lookup. The evidence field's blur
	 * handler makes that ordinary use: type, click away, click back, click away.
	 */
	private inFlightPair: { controlPath: string; evidencePath: string } | null = null;
	/** A named refusal from the last resolution (unreadable note, two junctions). */
	private pairRefusal: string | null = null;

	private coverageDrop: DropdownComponent | null = null;
	private statusDrop: DropdownComponent | null = null;
	private scopeText: TextComponent | null = null;
	private submitButton: ButtonComponent | null = null;
	private pairStatusEl: HTMLElement | null = null;
	/**
	 * AM-51 (2026-09-04). The two controls `applyPairState` deliberately leaves live,
	 * held so the WRITE can disable them too.
	 *
	 * They are live during a lookup because they are what CHANGES the pair. They must
	 * not be live during a write, because changing the pair cannot change what a write
	 * already in flight is doing, and leaving them enabled told the reviewer it could.
	 */
	private controlDrop: DropdownComponent | null = null;
	private evidenceText: TextComponent | null = null;
	/**
	 * AM-51. A write is in flight.
	 *
	 * Failure mode prevented: `create()` yields, and the button that started it stays
	 * on screen. A second click ran a second write concurrently; both read the same
	 * `existing === null`, both took the create branch, and the loser's `vault.create`
	 * threw "already exists", which surfaced as a raw error dump. Held as a field
	 * rather than inferred from the disabled button, because the button is a display
	 * of this fact and not the fact itself.
	 */
	private writing = false;
	/**
	 * AM-51. This window has closed, so nothing may start a lookup into components it
	 * has already detached.
	 */
	private closed = false;

	constructor(private readonly deps: EvidenceLinkModalDeps) {
		super(deps.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Link evidence to a control').setHeading();
		contentEl.createEl('p', { text: 'Reading the controls in this vault.' });
		void this.loadControls();
	}

	/**
	 * AM-46. The control list, read fail-closed, before anything is drawn.
	 *
	 * This was a cache-only read in the constructor. Reading it here costs one
	 * asynchronous pass and buys the two things the constructor could not have:
	 * a note the cache missed is read rather than dropped, and the number of
	 * notes nothing could be read from is a fact the window can state instead of
	 * a silence the user has to notice.
	 */
	private async loadControls(): Promise<void> {
		const scan = await scanControlCandidates(this.app);
		this.controls = scan.controls;
		this.unreadableControls = new Set(scan.unreadable);
		this.renderForm();
	}

	private renderForm(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Link evidence to a control').setHeading();

		// AM-46. The note the command was invoked from could not be READ. Not
		// "is not a control" (that is an answer, and the window simply offers the
		// list); nothing at all is known about it, and substituting a different
		// control would attach the reviewer's evidence to the wrong subject while
		// reporting success.
		const invokedFrom = this.deps.initialControlPath;
		if (invokedFrom && this.unreadableControls.has(invokedFrom)) {
			contentEl.createEl('p', {
				text: `Crosswalker cannot read the control note you opened this from (${invokedFrom}), so it cannot tell `
					+ 'which control you meant. Fix that note\'s properties, or open a control that reads cleanly, then '
					+ 'run this command again.',
			});
			return;
		}

		if (this.controls.length === 0) {
			const unindexed = countUnindexedMarkdownFiles(this.deps.app);
			contentEl.createEl('p', {
				text: unindexed > 0
					? `Obsidian is still indexing this vault (${unindexed} notes left to read). Wait for indexing to finish, then run this command again.`
					: 'No imported controls were found in this vault. Import a framework first, then link evidence to it.',
			});
			return;
		}

		contentEl.createEl('p', {
			text: 'Records that a document provides evidence for a control. The link is a note, so you can review and update it later.',
		});

		// AM-46. The short list is stated, not left to be noticed.
		if (this.unreadableControls.size > 0) {
			contentEl.createEl('p', {
				text: `${this.unreadableControls.size} notes could not be read, so this list may be short. `
					+ 'If the control you want is missing, fix that note\'s properties and run this command again.',
			});
		}

		new Setting(contentEl)
			.setName('Control')
			.setDesc('The control that needs evidence.')
			.addDropdown((drop) => {
				for (const candidate of this.controls) {
					drop.addOption(candidate.path, `${candidate.title} (${candidate.curie})`);
				}
				// A note the command was invoked from that READS cleanly but is not a
				// control is a fact, not a failure: the window shows the list and the
				// person picks. Only an unreadable one refuses (above).
				const preselected = invokedFrom
					? this.controls.find((c) => c.path === invokedFrom)
					: undefined;
				const selected = (preselected ?? this.controls[0]).path;
				drop.setValue(selected);
				this.control = this.controls.find((c) => c.path === selected) ?? this.controls[0];
				drop.onChange((value) => {
					this.control = this.controls.find((c) => c.path === value) ?? null;
					this.pairChanged();
				});
				// AM-51. Held so `create()` can lock it for the duration of a write.
				this.controlDrop = drop;
			});

		new Setting(contentEl)
			.setName('Evidence')
			.setDesc('Path to the document, screenshot note, or runbook that evidences the control.')
			.addText((text) => {
				text.setPlaceholder('Evidence/MFA policy.md');
				text.onChange((value) => { this.evidencePath = value; });
				// AM-43: the lookup runs when the pair is FIXED, never per keystroke.
				// Leaving the field is what fixes it.
				text.inputEl.addEventListener('blur', () => { this.pairChanged(); });
				// AM-51. Held so `create()` can lock it for the duration of a write.
				this.evidenceText = text;
			});

		this.pairStatusEl = contentEl.createEl('p', { text: '' });

		new Setting(contentEl)
			.setName('Coverage')
			.setDesc('How much of the control this evidence covers.')
			.addDropdown((drop) => {
				drop.addOption('full', 'Full');
				drop.addOption('partial', 'Partial');
				drop.addOption('none', 'None, this evidence does not cover it');
				drop.setValue(this.coverage);
				drop.onChange((value) => { this.coverage = value as EvidenceCoverage; });
				this.coverageDrop = drop;
			});

		new Setting(contentEl)
			.setName('Status')
			.setDesc('Only approved links count toward coverage.')
			.addDropdown((drop) => {
				drop.addOption('proposed', 'Proposed');
				drop.addOption('in_review', 'In review');
				drop.addOption('approved', 'Approved');
				drop.setValue(this.status);
				drop.onChange((value) => {
					this.status = value as EvidenceStatus;
					// AM-41. The act, recorded where it happens.
					this.statusSetInThisWindow = true;
				});
				this.statusDrop = drop;
			});

		new Setting(contentEl)
			.setName('Scope')
			.setDesc('Optional. Which part of the control this covers.')
			.addText((text) => {
				text.setValue(this.evidenceScope);
				text.onChange((value) => { this.evidenceScope = value; });
				this.scopeText = text;
			});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText('Create link')
				.setCta()
				.onClick(() => { void this.create(); });
			this.submitButton = button;
		});

		this.applyPairState();
	}

	/**
	 * AM-43. The pair changed, so what the form shows is no longer known to be
	 * true of it. Drop the resolution and look the new pair up once.
	 */
	private pairChanged(): void {
		// S5. Emptiness is a question about what the PERSON typed, so it is asked of
		// the raw input. `normalizePath('')` is `'/'` on the host, which is truthy
		// and resolves to the vault root, so normalizing first turned an empty
		// evidence field into a real-looking path and would have minted a junction
		// whose object is a link to nothing.
		const raw = this.evidencePath.trim();
		const evidencePath = raw === '' ? '' : normalizePath(raw);
		if (this.resolution
			&& this.resolution.controlPath === this.control?.path
			&& this.resolution.evidencePath === evidencePath) {
			return;
		}
		this.resolution = null;
		this.pairRefusal = null;
		this.applyPairState();
		if (!this.control || !evidencePath) return;
		// AM-48. A lookup for THIS pair is already running, so it will answer this
		// pair. Starting a second one is what produced two writers for one form.
		if (this.inFlightPair
			&& this.inFlightPair.controlPath === this.control.path
			&& this.inFlightPair.evidencePath === evidencePath) {
			return;
		}
		void this.resolvePair(this.control, evidencePath);
	}

	/**
	 * AM-43. THE ONE LOOKUP. Runs when the pair is fixed, sets the controls from
	 * what the pair's note records, and hands `create()` a resolution it does not
	 * re-derive.
	 *
	 * Failure mode prevented: prefill at WRITE time. The window used to display
	 * `Full` / `Proposed` / no scope whatever the note said, and reconcile at
	 * submit by asking whether each control "had been answered". Two things
	 * followed, and both were reported as success. A reviewer reading the form was
	 * told a link was proposed when the note said approved. And REVOKING AN
	 * APPROVAL WAS IMPOSSIBLE: an Obsidian dropdown fires no change event when the
	 * value chosen is the value already shown, so selecting `Proposed` on a
	 * dropdown displaying `Proposed` was indistinguishable from not choosing, and
	 * the note kept its approval. The safety-critical direction was the one that
	 * silently did nothing.
	 *
	 * While this runs the three review controls are DISABLED. They are questions
	 * about a pair whose recorded state is not yet known, and an answer given
	 * during the lookup would be overwritten by the prefill that lands after it.
	 *
	 * AM-48 (2026-09-04). This method now owns the LIFECYCLE only. The lookup
	 * itself (`lookUpPair`) touches nothing: it returns what it found, and the
	 * result is applied here in one place, guarded by the generation token. A
	 * lookup that is no longer the latest returns from that guard having changed
	 * no control, no flag, no enabled state and no resolution, so a person's
	 * answer can never be overwritten by a lookup that started before it.
	 */
	private async resolvePair(control: ControlCandidate, evidencePath: string): Promise<void> {
		const token = ++this.resolveToken;
		this.inFlightPair = { controlPath: control.path, evidencePath };
		this.resolving = true;
		this.applyPairState();
		let outcome: { refusal: string } | { found: PairLookup };
		try {
			outcome = { found: await this.lookUpPair(control, evidencePath) };
		} catch (err) {
			outcome = err instanceof PairLookupRefusal
				? { refusal: err.message }
				: { refusal: `Crosswalker could not check for an existing link (${err instanceof Error ? err.message : String(err)}).` };
		}

		// AM-48. THE GENERATION CHECK. Everything below writes to the form; nothing
		// above it does. A stale lookup stops here.
		if (token !== this.resolveToken) return;
		this.inFlightPair = null;
		this.resolving = false;

		if ('refusal' in outcome) {
			this.pairRefusal = outcome.refusal;
		} else {
			const { index, existing, current } = outcome.found;
			// The prefill. What the pair records is what the form shows; a pair that
			// records nothing shows the form's own defaults, so one pair's answers can
			// never be written onto another.
			const fm = current?.frontmatter ?? {};
			this.coverage = readEnum<EvidenceCoverage>(fm.coverage, EVIDENCE_COVERAGES) ?? FORM_DEFAULT_COVERAGE;
			this.status = readEnum<EvidenceStatus>(fm.status, EVIDENCE_STATUSES) ?? FORM_DEFAULT_STATUS;
			this.evidenceScope = typeof fm.scope === 'string' ? fm.scope : '';
			this.statusSetInThisWindow = false;
			this.coverageDrop?.setValue(this.coverage);
			this.statusDrop?.setValue(this.status);
			this.scopeText?.setValue(this.evidenceScope);

			this.resolution = { controlPath: control.path, evidencePath, index, existing, current };
		}
		this.applyPairState();
	}

	/**
	 * AM-48. The lookup, with no side effects at all.
	 *
	 * Separated from `resolvePair` so that "discard a stale result" is one early
	 * return rather than a token test in front of every assignment. A refusal is
	 * thrown as `PairLookupRefusal` for the same reason: an early `return` that
	 * set `this.pairRefusal` in place would have been a write from a lookup that
	 * may no longer own the form.
	 */
	private async lookUpPair(control: ControlCandidate, evidencePath: string): Promise<PairLookup> {
		// Vault-wide, because the questions are "who already holds this identity"
		// and "whose is the note at this address", and a scoped index by
		// construction cannot answer about the notes it excluded.
		const index = await buildIdentityIndex(this.app);
		const scan = await this.junctionsNamingThisPair(control, evidencePath);
		if (!scan.ok) {
			throw new PairLookupRefusal(
				`The properties of ${scan.unreadablePath} could not be read, so Crosswalker cannot tell `
				+ 'whether it is already the link for this control and this evidence. Fix that note\'s properties, '
				+ 'then try again.',
			);
		}
		const named = scan.junctions;
		if (named.length > 1) {
			throw new PairLookupRefusal(
				`${named.length} notes already record this control and this evidence `
				+ `(${named.map((entry) => entry.file.path).join(', ')}). Delete or fix all but one of them, `
				+ 'then try again.',
			);
		}
		const existing = named[0] ?? null;

		// The note this window is about to change, read ONCE and read fail-closed,
		// through the same reader generation uses. Everything that needs to know
		// what the link already says asks this, so the window cannot form two
		// opinions about the note it is updating.
		let current: ExistingNote | null = null;
		if (existing) {
			try {
				current = await readExistingNote(this.app, existing.file);
			} catch (readErr) {
				const detail = readErr instanceof ExistingNoteReadError ? readErr.detail : String(readErr);
				throw new PairLookupRefusal(`${existing.file.path} could not be read (${detail}). Fix that note, then try again.`);
			}
		}
		return { index, existing, current };
	}

	/** The status line and what the person may answer, given what is known. */
	private applyPairState(): void {
		// AM-48. The gate is the RESOLUTION, never a "some lookup finished" flag.
		// Only the current lookup can set one (a stale result is discarded before
		// it reaches here), so the controls stay disabled until the lookup that
		// owns the form settles, however many older ones land first.
		const ready = this.resolution !== null;
		this.coverageDrop?.setDisabled(!ready);
		this.statusDrop?.setDisabled(!ready);
		this.scopeText?.setDisabled(!ready);
		this.submitButton?.setDisabled(!ready);
		if (!this.pairStatusEl) return;
		let text: string;
		if (this.pairRefusal) text = `Cannot link this pair yet. ${this.pairRefusal}`;
		else if (this.resolving) text = 'Checking for an existing link.';
		else if (!this.resolution) text = 'Enter the evidence path. Crosswalker checks whether this pair already has a link.';
		else if (this.resolution.existing) {
			text = `This control and this evidence already have a link at ${this.resolution.existing.file.path}. `
				+ 'The values below are what it records. Change them to update it.';
		} else text = 'No link exists for this control and this evidence yet.';
		this.pairStatusEl.setText(text);
	}

	/**
	 * AM-51 (2026-09-04). THE WRITE, over a snapshot of the form.
	 *
	 * Every field this method will write is captured into a local beside the pair
	 * check, above the first `await`, and only those locals are read below.
	 *
	 * Failure mode prevented: an owner is a property of the FIELD, not of the
	 * function that happens to be reading it. AM-48 gave the LOOKUP an owner and left
	 * the write with two readers. `create()` awaits the control's bytes at
	 * `readNoteFrontmatterState` - reached only when the control was cache-cold, so
	 * that call is disk I/O by construction - and the control dropdown was live
	 * throughout. A reviewer who switched the control during that read wrote a
	 * junction whose subject was the NEW control, whose `reviewed_against.review_cid`
	 * was the OLD control's fingerprint, for a pair `junctionsNamingThisPair` never
	 * scanned: a second junction for a pair that may already have one (the outcome
	 * AM-42 and the whole pair scan exist to prevent, and one AM-42 cannot repair
	 * because a note minted here carries no import set), an attestation recorded
	 * against a note the reviewer had already left (AM-41 from the other direction),
	 * and a notice reading "Evidence link created."
	 */
	private async create(): Promise<void> {
		// AM-51. THE RE-ENTRY GUARD, before anything else: a second click while a
		// write is in flight is a no-op.
		if (this.writing) return;
		const control = this.control;
		if (!control) {
			new Notice('Choose a control first.');
			return;
		}
		// S5 (2026-09-04). The guard tests the RAW input, before normalization.
		// `normalizePath('')` returns `'/'` on the host, which is truthy and which
		// `getAbstractFileByPath` resolves to the vault root, so an empty evidence
		// field passed this guard, passed the "no note found" warning below, and
		// minted a junction whose object was a link to nothing.
		const rawEvidence = this.evidencePath.trim();
		if (!rawEvidence) {
			new Notice('Enter the path to the evidence document.');
			return;
		}
		const evidencePath = normalizePath(rawEvidence);

		// AM-51. THE REST OF THE SNAPSHOT, beside the pair check and above the first
		// `await`. What the form DISPLAYS at the instant the person clicked, including
		// the act flag that is the sole authority for writing an attestation. Nothing
		// below this line reads `this.coverage`, `this.status`, `this.evidenceScope`,
		// `this.statusSetInThisWindow`, `this.resolution` or `this.control` again.
		const resolution = this.resolution;
		// AM-43. Exactly what the controls display. No comparison to a default, no
		// "did they answer" question: the control's state IS the person's answer, and
		// an untouched control displays the note's own value, so writing it back is
		// idempotent.
		const coverage = this.coverage;
		const status = this.status;
		const scope = this.evidenceScope.trim();
		// AM-41. An attestation is an act, recorded where it happened.
		const attesting = this.statusSetInThisWindow;

		// AM-43. What the form shows is what it writes, so it must have been shown.
		// A submit with no resolution for the pair now named looks the pair up and
		// returns: the person sees the pair's recorded state and clicks again. The
		// alternative is reconciling at write time, which is the defect.
		if (!resolution || resolution.controlPath !== control.path || resolution.evidencePath !== evidencePath) {
			this.pairChanged();
			new Notice('Checking for an existing link for this control and this evidence. Review the values, then click the button again.');
			return;
		}

		// Warn but do not block: evidence may legitimately be added before the
		// document lands in the vault, and refusing would push the user back to
		// hand-writing the note, which is what this command exists to replace.
		if (!this.app.vault.getAbstractFileByPath(evidencePath)) {
			new Notice(`No note found at ${evidencePath}. Creating the link anyway.`);
		}

		// AM-51. THE LOCK. The control dropdown and the evidence field are the two
		// controls `applyPairState` leaves live, because they are what changes the
		// pair; that is exactly why the write must disable them. Submit joins them so
		// the re-entry guard above has a visible counterpart.
		//
		// The three `setDisabled` calls are INSIDE the try (ruled 2026-09-04): they
		// are host calls, and a throw from one of them above the try would leave
		// `writing` true with no `finally` to clear it, which is a window that
		// silently refuses every further click.
		this.writing = true;
		try {
			this.controlDrop?.setDisabled(true);
			this.evidenceText?.setDisabled(true);
			this.submitButton?.setDisabled(true);
			const { index, existing, current } = resolution;

			// AM-41. `reviewed_against` is written only
			// when the person set `status` in THIS window: to `approved`, against the
			// control's fingerprint as it is now; to anything else, not at all, which
			// REMOVES the note's baseline because a revoked approval has no baseline.
			// If they did not set `status`, the note's own record is carried
			// byte-for-byte whatever the control's fingerprint has become, so a
			// drifted approval keeps reporting as drifted through any number of scope
			// edits.
			const recordedAgainst = readRecordedReviewedAgainst(current?.frontmatter);
			let controlReviewCid = attesting ? control.reviewCid : (recordedAgainst?.reviewCid ?? null);
			let controlReviewGroups = attesting
				? (control.reviewGroups ?? null)
				: (recordedAgainst?.reviewGroups ?? null);
			if (attesting && status === 'approved' && controlReviewCid === null) {
				const controlFile = this.app.vault.getAbstractFileByPath(control.path);
				if (controlFile instanceof TFile) {
					// S7 (2026-09-04). Routed through the `!fm` reading, which is the
					// one this repo settled on: a cache ENTRY that exists but carries no
					// properties is a silence exactly like a missing entry, and the
					// retired `!getFileCache` discriminator skipped the disk read for
					// it. `readNoteFrontmatterState` accepts a cache entry only when it
					// actually carries properties and reads the file otherwise, so this
					// costs nothing when the cache has already answered.
					//
					// Failure mode prevented: stamping "no baseline" onto a control that
					// has a perfectly good fingerprint, because the cache had not
					// answered yet. That is the mistake behind three bugs in one week
					// (`project_cache_lag_is_not_absence`), and the tri-state is what
					// separates the two readings: `none` is the FACT that this control
					// carries no properties, `unreadable` is the ABSENCE of any fact.
					const read = await readNoteFrontmatterState(this.app, controlFile);
					if (read.state === 'unreadable') {
						// Named, and actionable. Not "wait a moment": the bytes have
						// already been read from disk, so waiting changes nothing, and
						// telling the user a false cause is the failure AM-19 removes.
						new Notice(
							// AM-51. The SNAPSHOT's path, so a refusal cannot name a
							// control the person has already left the dropdown for.
							`Crosswalker could not read the properties of ${control.path}, so it cannot record what `
							+ 'you approved against. Fix that note\'s properties, then approve the link again.',
							12000,
						);
						return;
					}
					if (read.state === 'ok') {
						controlReviewCid = readReviewCid(read.frontmatter);
						controlReviewGroups = readReviewGroups(read.frontmatter);
					}
					// `none` needs no branch: a control with no properties has no
					// fingerprint, which is a fact, and the notice below states it.
				}
				if (controlReviewCid === null) {
					new Notice(
						'This control has no content fingerprint, so Crosswalker cannot tell you later if it changes. '
						+ 'The link was still created and still counts.',
					);
				}
			}

			// The identity: the one the existing note already carries, READ OFF IT, or
			// a fresh mint when nothing records this pair yet. A recorded curie is
			// never recomputed - that recomputation IS the defect above. A junction
			// that records the pair but carries no curie at all is given one now, so
			// projection can finally see it.
			const recorded = existing?.curie ?? null;
			const curie = recorded ?? evidenceLinkCurie(control.curie, control.path, evidencePath);

			// Nobody but this link may hold this link's identity. Two notes with one
			// curie is a permanent `Ambiguous identity` collision that fails every
			// later import in the vault, so it is named here - where the user can act
			// on it - rather than met weeks later on an unrelated import.
			//
			// AM-36 (2026-09-01). THE PAIR WINS: this check applies to a MINT only.
			// When the pair scan named exactly one junction, that note IS this link,
			// positively identified by a fact it records; updating it under the
			// identity it already carries adds no claimant, so a pre-existing contest
			// over that identity is neither caused nor worsened here. And a contest
			// over a LEGACY identifier is expected rather than exceptional - the
			// pre-AM-22 basename form was never unique, so two releases of one
			// framework share it by construction.
			//
			// Failure mode prevented: refusing a reviewer's link over an ambiguity
			// they did not create, and instructing them to delete a perfectly
			// legitimate link belonging to the other release. A mint is the real
			// error case: that identity is being introduced now, and introducing it
			// onto an existing claim is a collision this window would itself create.
			//
			// The era reading of AM-36's text (refuse whenever the CURRENT mint form
			// is contested, update or not) was ruled out on 2026-09-02: the code is
			// the spec, a committed declaration pins this reading with both arguments
			// written out, and the update restamps nothing and adds no claimant.
			if (!recorded) {
				const claimants = index.collisions.find((collision) => collision.curie === curie)?.paths
					?? (index.get(curie) ? [index.get(curie)!.path] : []);
				const contested = claimants.filter((path) => path !== existing?.file.path);
				if (contested.length > 0) {
					new Notice(
						`Could not create the link: ${contested.length} note${contested.length === 1 ? ' already claims' : 's already claim'} the `
						+ `identity ${curie} (${contested.join(', ')}). `
						+ `Delete or fix ${contested.length === 1 ? 'it' : 'all but one of them'}, then try again.`,
						12000,
					);
					return;
				}
			}

			const note = buildEvidenceLink({
				controlPath: control.path,
				controlCurie: control.curie,
				controlReviewCid,
				controlReviewGroups,
				evidencePath,
				coverage,
				status,
				scope: scope || undefined,
				folder: this.deps.folder,
				curie,
			});

			let writtenPath: string;
			if (existing) {
				// `current` is set for every `existing` above, or the resolution refused.
				// Stated as a refusal rather than an assertion so a future edit that
				// separates them cannot fall through to the create branch and write a
				// second note for a pair that already has one.
				if (!current) {
					new Notice(`Could not update the link at ${existing.file.path}: it could not be read.`, 12000);
					return;
				}
				// Updated WHERE IT SITS, under the identity it already carries. Its
				// address is not corrected to the one a mint would choose today: the
				// note is the record, and moving it would only re-couple the identity
				// to a path again.
				//
				// AM-39. MERGED, not replaced. This was `vault.modify(file,
				// note.markdown)`: the whole note overwritten by a rebuild from three
				// form controls. `reviewer`, `review_date`, `confidence`, `expires_at`
				// and `notes` are exactly the keys the bulk recipe declares
				// `user_preserve` "so the review workflow is not clobbered on
				// re-import" - the re-import honoured it and this window silently
				// deleted them, an approval and its date and its expiry, while
				// reporting that the link had been "updated". A window that can
				// destroy an attestation is not a lighter-weight door than an import;
				// it is the same door with no lock.
				//
				// AM-41. `reviewed_against` is owned by this write ONLY when the person
				// set the status here. Owned means the fresh block wins, and when the
				// status they set is not `approved` the fresh note carries no block at
				// all, so the baseline is removed. Not owned means the note's own bytes
				// are carried, and a re-attestation nobody performed cannot happen.
				const managed = attesting
					? new Set([...WINDOW_MANAGED_KEYS, 'reviewed_against'])
					: WINDOW_MANAGED_KEYS;
				const merged = mergeIntoExistingLink(
					current,
					note.markdown,
					// AM-51. The snapshot's control, so the "is this our own unedited
					// output" comparison is made against the control this write is for.
					this.previousRenderBody(control, current, evidencePath),
					managed,
				);
				if (!merged.ok) {
					new Notice(
						`Could not update the link at ${existing.file.path}: ${merged.detail} `
						+ 'Fix that note, then try again.',
						12000,
					);
					return;
				}
				await this.app.vault.modify(existing.file, merged.markdown);
				writtenPath = existing.file.path;
				new Notice(
					existing.file.path === note.path
						? 'Updated the existing link for this control and evidence.'
						: `Updated the existing link for this control and evidence, at ${existing.file.path}.`,
				);
			} else {
				// Nothing records this pair. Now, and only now, is the address the
				// question: whatever sits there is not this link, so it is refused by
				// name rather than overwritten.
				const occupant = this.app.vault.getAbstractFileByPath(note.path);
				if (occupant instanceof TFile) {
					const refusal = addressRefusal(index, occupant.path, null);
					new Notice(
						refusal
							? `Could not create the link. ${crossSetAddressMessage(refusal)}`
							: `Could not create the link: a different note already sits at ${occupant.path}. `
								+ 'Move or rename that note, or change the evidence link folder in settings.',
						12000,
					);
					return;
				}
				// AM-57 (2026-09-04). `note.path` is composed by `evidenceLinkPath`,
				// which normalizes the configured folder, so the occupant lookup above
				// and this folder derivation both act on a path the vault's own file
				// map can hold. Before that, a settings value with a trailing separator
				// produced `Evidence/Junctions//X.md`: the lookup answered null on a key
				// nothing holds, the address refusal could not fire, and `createFolder`
				// was handed a folder nobody had normalized.
				//
				// S11 (2026-09-04). The separator is LOCATED before it is sliced at.
				// The vault root is now a folder a person can choose, so `note.path`
				// can legitimately be `X.md` with no separator at all; `slice(0, -1)`
				// on that yields `X.m`, which is truthy, so the next line would have
				// created a FOLDER named after a truncated file name beside the note.
				const sep = note.path.lastIndexOf('/');
				const folder = sep === -1 ? '' : note.path.slice(0, sep);
				if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
					await this.app.vault.createFolder(folder);
				}
				await this.app.vault.create(note.path, note.markdown);
				writtenPath = note.path;
				new Notice('Evidence link created.');
			}
			const file = this.app.vault.getAbstractFileByPath(writtenPath);
			if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
			// AM-51. Recorded here as well as in `onClose`, so the `finally` below can
			// never start a lookup into components this window has detached, whatever
			// the host does with `onClose`.
			this.closed = true;
			this.close();
		} catch (err) {
			new Notice(`Could not create the link: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			// AM-51. The lock is released whichever way the write ended, including the
			// early returns above, so a refusal never leaves the window unusable.
			this.writing = false;
			this.controlDrop?.setDisabled(false);
			this.evidenceText?.setDisabled(false);
			if (!this.closed) {
				// AM-51. The pair is RE-RESOLVED, not restored from memory. The note
				// this write created or changed now exists, so the resolution captured
				// above is out of date about the vault the instant the write lands, and
				// a second submit reading it would take the create branch for a pair
				// that now has a note. Re-running the one lookup is also what puts the
				// review controls back, through `applyPairState`, showing what was
				// written.
				this.resolution = null;
				this.pairChanged();
			}
		}
	}

	/**
	 * AM-39. The body this window would have written for the link AS THE NOTE NOW
	 * RECORDS IT, or null when the note does not record enough to say.
	 *
	 * This is how the window recognises its own unedited output without keeping a
	 * marker in it: rebuild from the note's recorded facts and compare. Equal
	 * means nobody has touched the text since it was generated, so refreshing it
	 * loses nothing. Different means somebody wrote something, and the window is
	 * not the author of that.
	 *
	 * Built from what the NOTE says (its recorded subject, object, coverage,
	 * status, scope, curie and baseline), never from the form's current values -
	 * comparing against the new values would only ever tell us whether the user
	 * changed anything.
	 *
	 * Ruled ACCEPTED AS IMPLEMENTED on 2026-09-02 against AM-39's literal "the
	 * same merge machinery": `mergeExistingNote` would call `adoptLegacyBody` in
	 * strict mode for a body with no region markers and refuse every ordinary
	 * update. The clause meant managed-keys plus region semantics, which is what
	 * this does.
	 */
	private previousRenderBody(control: ControlCandidate, current: ExistingNote, fallbackEvidencePath: string): string | null {
		const fm = current.frontmatter;
		const coverage = readEnum<EvidenceCoverage>(fm.coverage, EVIDENCE_COVERAGES);
		const status = readEnum<EvidenceStatus>(fm.status, EVIDENCE_STATUSES);
		const curie = typeof fm.curie === 'string' && fm.curie.trim() !== '' ? fm.curie.trim() : null;
		if (!coverage || !status || !curie) return null;
		const against = fm.reviewed_against && typeof fm.reviewed_against === 'object' && !Array.isArray(fm.reviewed_against)
			? fm.reviewed_against as Record<string, unknown>
			: null;
		const built = buildEvidenceLink({
			controlPath: wikilinkTarget(fm.subject) ?? control.path,
			controlCurie: typeof fm.subject_curie === 'string' ? fm.subject_curie : null,
			controlReviewCid: against && typeof against.review_cid === 'string' ? against.review_cid : null,
			controlReviewGroups: against ? readReviewGroupCids(against.review_groups) : null,
			evidencePath: wikilinkTarget(fm.object) ?? fallbackEvidencePath,
			coverage,
			status,
			scope: typeof fm.scope === 'string' && fm.scope !== '' ? fm.scope : undefined,
			folder: this.deps.folder,
			curie,
		});
		return splitNoteText(built.markdown).body;
	}

	/**
	 * AM-30 (2026-08-31). Which notes, if any, RECORD this control and this
	 * evidence — the one lookup, for every era of link this product has written.
	 *
	 * The lookup used to be a chain of identifiers: the curie this window would
	 * mint today, then the pre-AM-22 basename form, then two known addresses. Every
	 * one of those is a value RECOMPUTED from the current inputs, and two of the
	 * inputs are vault paths, so moving either file changed the answer and the
	 * junction that plainly existed was found by nothing. A path may seed a mint;
	 * it may never be needed again after it.
	 *
	 * So the question is put to the notes: a junction note SAYS which subject and
	 * which object it is about, and that statement is a recorded fact that survives
	 * every rename. Both halves are matched by identity where an identity exists:
	 * the control by its `subject_curie`, the evidence (a user's own document,
	 * which has no curie) by resolving the recorded wikilink the way Obsidian does,
	 * so a moved file still resolves to the same note.
	 *
	 * It reads every era for free: the filter is `kind: junction-note`, which every
	 * version of `buildEvidenceLink` has written, including the oldest links that
	 * carry no `_crosswalker` block at all and are therefore invisible to the
	 * identity index.
	 *
	 * Failure mode prevented: a second junction note for a pair that already has
	 * one - double-counted by every coverage tally, with the first silently
	 * abandoned - and its opposite, adopting the WRONG pre-existing link because
	 * the identifier that found it was not unique.
	 *
	 * AM-35 (2026-09-01). A note that cannot be READ stops the scan instead of
	 * dropping out of it. `NoteFrontmatterRead` is a tri-state built for exactly
	 * this: `none` is a FACT (this file has no properties, so it is not a
	 * junction), while `unreadable` is the ABSENCE of a fact - the bytes would not
	 * read, or the properties block will not parse, so nothing at all is known,
	 * including whether it is the very junction being looked for.
	 *
	 * Failure mode prevented: a junction whose YAML a hand edit damaged silently
	 * leaving the answer, the window concluding that nothing records this pair,
	 * and a SECOND junction being minted for a pair that already has one - the
	 * exact outcome this whole lookup exists to prevent, produced by the rule it
	 * cites. Everything else in this window fails closed; this line used to fail
	 * open into a mint. Absence is never read as fact (eighth appearance).
	 *
	 * SCOPE, stated rather than discovered (adversarial SUSPECTED 8): the refusal
	 * covers the whole vault, because the question does. A file's kind cannot be
	 * known without reading it, so a note anywhere whose properties will not parse
	 * blocks every evidence link until it is fixed. That is AM-35's frozen answer
	 * and the copy names the file and the action; whether the product should
	 * eventually offer a narrower escape (skip this note, and say which links may
	 * therefore be duplicated) is a UX decision left to the architect.
	 */
	private async junctionsNamingThisPair(
		control: ControlCandidate,
		evidencePath: string,
	): Promise<
		| { ok: true; junctions: { file: TFile; curie: string | null }[] }
		| { ok: false; unreadablePath: string }
	> {
		const out: { file: TFile; curie: string | null }[] = [];
		// S6. ONE snapshot of the vault's file list per scan, built lazily and only
		// if the metadata cache's link resolver actually goes silent. Local to the
		// scan rather than held on the window, so a lookup this window has already
		// abandoned cannot change what a later one sees (AM-48).
		let fallback: LinkFallbackIndex | null = null;
		const resolvesTo = (linkPath: string, targetPath: string): boolean => {
			fallback ??= buildLinkFallbackIndex(this.app);
			return linkFallbackResolves(fallback, linkPath, targetPath);
		};
		for (const file of this.app.vault.getMarkdownFiles()) {
			let fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				// A file the cache has not reached is read rather than assumed empty.
				// Absence of a cache entry has never meant absence of properties.
				const read = await readNoteFrontmatterState(this.app, file);
				// AM-35. `none` keeps scanning - a file with no properties is not a
				// junction, and that is a fact. `unreadable` refuses: the one note that
				// cannot be read may be the one that answers.
				if (read.state === 'unreadable') return { ok: false, unreadablePath: file.path };
				if (read.state !== 'ok') continue;
				fm = read.frontmatter;
			}
			if (fm.kind !== 'junction-note') continue;
			if (!this.frontmatterNamesThisPair(fm, control, evidencePath, resolvesTo)) continue;
			const curie = typeof fm.curie === 'string' && fm.curie.trim() !== '' ? fm.curie.trim() : null;
			out.push({ file, curie });
		}
		return { ok: true, junctions: out };
	}

	/**
	 * The pair a junction note says it is about, read off the note.
	 *
	 * `subject_curie` is preferred because it is the control's own identity;
	 * the `subject` wikilink is the fallback for a link written when the control
	 * carried no curie, where a path was all there was to record.
	 *
	 * The predicate is checked because this window writes exactly one, and
	 * updating a note that asserts some other relationship would silently rewrite
	 * what it asserts. A note that states no predicate at all predates the field
	 * and can only be one of ours.
	 *
	 * KNOWN AND DEFERRED, 2026-09-01 (adversarial SUSPECTED 9): the object side is
	 * always matched by resolving a wikilink, because an evidence document is a
	 * user's own file and has no identity to match on, and `linkNames` ends at
	 * basename resolution. Two documents (or two framework releases) sharing a
	 * basename can therefore steer a hand-written or bulk-imported junction to the
	 * wrong single match. Not closed here for two reasons: nothing this builder
	 * writes is reachable that way (it records full paths), and AM-39 removed the
	 * damage - an update now merges managed keys and leaves the body and the
	 * reviewer's own fields alone, so a wrong match no longer destroys an
	 * attestation. Closing it properly means an identity for evidence documents,
	 * which is a design question, not a line edit.
	 */
	private frontmatterNamesThisPair(
		fm: Record<string, unknown>,
		control: ControlCandidate,
		evidencePath: string,
		resolvesTo: (linkPath: string, targetPath: string) => boolean,
	): boolean {
		const predicate = typeof fm.predicate === 'string' ? fm.predicate.trim() : '';
		if (predicate !== '' && predicate !== CANONICAL_EVIDENCE_PREDICATE) return false;
		const subjectCurie = typeof fm.subject_curie === 'string' ? fm.subject_curie.trim() : '';
		const subject = typeof fm.subject === 'string' ? fm.subject : '';
		const object = typeof fm.object === 'string' ? fm.object : '';
		const subjectMatches = control.curie && subjectCurie
			? subjectCurie === control.curie
			: this.linkNames(subject, control.path, resolvesTo);
		return subjectMatches && this.linkNames(object, evidencePath, resolvesTo);
	}

	/**
	 * Does this recorded wikilink name the note now at `targetPath`?
	 *
	 * Exact text first (Obsidian rewrites links on rename, so a moved file is
	 * usually already recorded at its new path), then Obsidian's own link
	 * resolution, which follows a move even when the link text was not rewritten.
	 * Resolution is what makes this survive the case AM-30 exists for; the exact
	 * comparison is what makes it work on hosts that expose no resolver.
	 *
	 * S6 (2026-09-04). `getFirstLinkpathDest` was the LAST cache-only read on the
	 * `command -> window -> write` path, and its null answer was read as the fact
	 * "this junction does not name the pair". It is not a fact: it is either that,
	 * or the resolver has not been built yet. A junction dropped from the scan for
	 * the second reason leaves the scan reporting that nothing records the pair,
	 * and the window then MINTS A SECOND JUNCTION for a pair that already has one
	 * - the exact error the scan exists to prevent, and the one AM-42 then cannot
	 * repair because the new note carries no import set.
	 *
	 * So a null answer falls back to the vault's own file list, the same
	 * authoritative source the fail-closed readers around it fall back to when the
	 * cache is silent. The list is in memory and is never lagged: it answers
	 * "which file does this link text name" as a fact, so the scan concludes only
	 * from facts. Aliases still resolve through the resolver when it can answer;
	 * what is removed is CONCLUDING from its silence.
	 */
	private linkNames(
		value: string,
		targetPath: string,
		resolvesTo: (linkPath: string, targetPath: string) => boolean,
	): boolean {
		const match = /\[\[([^\]|#^]+)/.exec(value);
		if (!match) return false;
		const linkPath = match[1].trim();
		if (linkPath === targetPath || `${linkPath}.md` === targetPath) return true;
		const resolve = this.app.metadataCache.getFirstLinkpathDest?.bind(this.app.metadataCache);
		const dest = resolve ? resolve(linkPath, '') : null;
		if (dest !== null && dest !== undefined) return dest.path === targetPath;
		return resolvesTo(linkPath, targetPath);
	}

	onClose(): void {
		// AM-51. Nothing may start a lookup into components that are about to be
		// detached: a write settling after the window closed would otherwise re-resolve
		// the pair against a form nobody is looking at.
		this.closed = true;
		this.contentEl.empty();
	}
}
