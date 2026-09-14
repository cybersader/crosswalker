/**
 * existing-note.ts — THE ONE existing-note reader and body merger.
 *
 * There must be exactly one place in the codebase that decides what happens to
 * an existing note. A previous attempt at this behaviour fixed one generation
 * entry point and not the other, so a "removed" behaviour came back from the
 * second call site. `mergeExistingNote` is that one place; `generateNotes`
 * (wizard/workbench path), `generateFromRecipe` (native recipe path), and
 * `applyEnrichment`'s facet-hub branch all call it.
 *
 * Two live bugs are fixed here, not merely designed around:
 *
 * 1. `readExistingFrontmatter` returned `{}` on a metadata-cache MISS, which
 *    then failed the callers' `Object.keys(existingFm).length > 0` guard, so
 *    the merge was skipped and every user_preserve key on that note was
 *    overwritten. Cache lag is not absence — the same class as the three bugs
 *    recorded in `project_cache_lag_is_not_absence.md`. This reader reads the
 *    file and parses the YAML itself, and FAILS rather than degrading.
 * 2. Both write sites wrapped the frontmatter merge in
 *    `catch { debug.warn(...); /* use new frontmatter as-is *\/ }`. That catch
 *    IS a silent user-frontmatter-loss path: it discarded preserved keys and
 *    continued. It is now a conflict.
 *
 * DO NOT reuse `export/vault-reader.readNoteFrontmatter` here. Its `return null`
 * on failure is correct for export (one bad note must not abort an export) and
 * exactly wrong for generation (one unreadable note must not be overwritten).
 */

import { App, TFile, parseYaml } from 'obsidian';
import { mergeFrontmatter } from './frontmatter-merge';
import {
	adoptLegacyBody,
	findSpan,
	replaceRegion,
	scanRegions,
	wrapRegion,
	type CorruptionCode,
} from './managed-body';

/** Reasons a note is refused, beyond the marker corruption codes. */
export type ExistingNoteConflictCode =
	| CorruptionCode
	| 'legacy-body-differs'
	| 'frontmatter-unreadable'
	| 'frontmatter-merge-failed';

export class ExistingNoteReadError extends Error {
	readonly code: ExistingNoteConflictCode;
	readonly detail: string;
	constructor(code: ExistingNoteConflictCode, detail: string) {
		super(detail);
		this.name = 'ExistingNoteReadError';
		this.code = code;
		this.detail = detail;
	}
}

export interface ExistingNote {
	frontmatter: Record<string, unknown>;
	/** Body text with the frontmatter block removed. Raw bytes, unnormalised. */
	body: string;
	/**
	 * The properties block's YAML as it is written on disk, between the fences,
	 * unparsed and unnormalised ('' when the note has no block).
	 *
	 * Carried so a writer that must keep a user's key BYTE-FOR-BYTE can copy the
	 * lines rather than re-serialise a parsed value. Round-tripping through a
	 * parser and back is how a quoted string loses its quotes, a date becomes a
	 * timestamp, and a comment disappears: all invisible to the merge, all visible
	 * to the person whose note it is.
	 */
	frontmatterText: string;
}

// Exactly the inverse of `buildNoteContent`: the fence, its YAML, the closing
// fence, and the ONE blank line buildNoteContent puts between them and the body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n(?:\r?\n)?|$)/;

/**
 * Split note text into its properties block and its body. THE one place that
 * knows where a note's frontmatter ends, so a second reader cannot disagree with
 * this one about it.
 */
export function splitNoteText(text: string): { frontmatterText: string; body: string } {
	const match = FRONTMATTER_RE.exec(text);
	return match
		? { frontmatterText: match[1], body: text.slice(match[0].length) }
		: { frontmatterText: '', body: text };
}

/**
 * Read an existing note's frontmatter and body, failing closed.
 *
 * Frontmatter comes from the metadata cache when it has one, and otherwise from
 * a raw read plus `parseYaml`. A read failure or unparseable YAML throws — it
 * never degrades to `{}`, because `{}` is indistinguishable from "this note has
 * no properties" and that ambiguity is how user_preserve keys were lost.
 *
 * The body is ALWAYS the raw file bytes minus the frontmatter block. Not
 * normalised: not line endings, not trailing whitespace, not blank-line runs.
 */
export async function readExistingNote(app: App, file: TFile): Promise<ExistingNote> {
	let text: string;
	try {
		text = await app.vault.read(file);
	} catch (err) {
		throw new ExistingNoteReadError(
			'frontmatter-unreadable',
			`the file could not be read (${err instanceof Error ? err.message : String(err)}).`,
		);
	}

	const match = FRONTMATTER_RE.exec(text);
	const body = match ? text.slice(match[0].length) : text;
	const frontmatterText = match ? match[1] : '';

	const cached = app.metadataCache?.getFileCache?.(file)?.frontmatter;
	if (cached && typeof cached === 'object' && Object.keys(cached).some((k) => k !== 'position')) {
		const frontmatter: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(cached)) {
			if (k !== 'position') frontmatter[k] = v;
		}
		return { frontmatter, body, frontmatterText };
	}

	// Cache miss (or an empty cache entry). Parse the file ourselves.
	if (!match) return { frontmatter: {}, body, frontmatterText };
	let parsed: unknown;
	try {
		parsed = parseYaml(match[1]);
	} catch (err) {
		throw new ExistingNoteReadError(
			'frontmatter-unreadable',
			`its properties block is not valid YAML (${err instanceof Error ? err.message : String(err)}).`,
		);
	}
	if (parsed === null || parsed === undefined) return { frontmatter: {}, body, frontmatterText };
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ExistingNoteReadError('frontmatter-unreadable', 'its properties block is not a YAML mapping.');
	}
	return { frontmatter: parsed as Record<string, unknown>, body, frontmatterText };
}

export interface MergeExistingNoteArgs {
	app: App;
	file: TFile;
	/** The frontmatter this run rendered, before merging. */
	freshFrontmatter: Record<string, any>;
	/** Keys generation owns; everything else on the existing note survives. */
	managedKeys: Set<string>;
	/** The managed body this run rendered, WITHOUT region markers. */
	freshManagedBody: string;
	/**
	 * `note` — ordinary generated notes. Legacy adoption requires exact equality.
	 * `facet-hub` — adoption replays `mergeHubBody`, which is already lossless,
	 *               so a facet hub never conflicts on its body.
	 */
	kind: 'note' | 'facet-hub';
}

export type MergeOutcome =
	| { ok: true; frontmatter: Record<string, any>; body: string; adopted: boolean }
	| { ok: false; code: ExistingNoteConflictCode; detail: string };

/**
 * Decide what an existing note becomes under `Replace`.
 *
 * The written note is:
 *
 *   --- <merged frontmatter> ---
 *   <every byte before the first region, verbatim>
 *   <region body, rebuilt>
 *   <every byte between regions, verbatim>
 *   <region children, rebuilt by Pass 1.5>
 *   <every byte after the last region, verbatim>
 *
 * A conflict blocks the FRONTMATTER write too, deliberately, even though the
 * frontmatter merge is itself safe: one `vault.modify` writes both halves, and
 * writing fresh `_crosswalker` provenance onto a note whose body is from an
 * older render manufactures exactly the "looks current, is stale" state that
 * breaks recipe-hash drift detection.
 *
 * A conflict is PER-NOTE. It never aborts the run: a mid-stream abort leaves a
 * half-written tree. `overwriteMode: 'error'` remains the run-level abort.
 */
export async function mergeExistingNote(args: MergeExistingNoteArgs): Promise<MergeOutcome> {
	const { app, file, freshFrontmatter, managedKeys, freshManagedBody, kind } = args;

	let existing: ExistingNote;
	try {
		existing = await readExistingNote(app, file);
	} catch (err) {
		if (err instanceof ExistingNoteReadError) return { ok: false, code: err.code, detail: err.detail };
		return {
			ok: false,
			code: 'frontmatter-unreadable',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const scan = scanRegions(existing.body);
	if (!scan.ok) return { ok: false, code: scan.code, detail: scan.detail };

	let frontmatter: Record<string, any> = freshFrontmatter;
	if (Object.keys(existing.frontmatter).length > 0) {
		try {
			frontmatter = mergeFrontmatter(existing.frontmatter, freshFrontmatter, managedKeys);
		} catch (err) {
			// Was a `debug.warn` + "use new frontmatter as-is", i.e. a silent
			// user-frontmatter-loss path. Refusing the note is the only honest answer.
			return {
				ok: false,
				code: 'frontmatter-merge-failed',
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	if (findSpan(scan.spans, 'body')) {
		const body = replaceRegion(existing.body, scan.spans, 'body', wrapRegion('body', freshManagedBody));
		return { ok: true, frontmatter, body, adopted: false };
	}

	const adopted = adoptLegacyBody(existing.body, freshManagedBody, kind === 'facet-hub' ? 'replay-hub' : 'strict');
	if (!adopted.ok) return { ok: false, code: adopted.code, detail: adopted.detail };
	return { ok: true, frontmatter, body: adopted.body, adopted: true };
}
