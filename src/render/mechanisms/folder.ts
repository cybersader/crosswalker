/**
 * folder mechanism — append a directory segment to address.primary.path
 *
 * Per Ch 22 §1.1: native filesystem path nesting; mono-hierarchical;
 * not polyhierarchical. Right when each concept has exactly one canonical home.
 */

import type { Address, SourceScope, RenderReport, VariadicConfig, LayoutValue } from '../types';
import { renderTemplate, RenderError } from '../template';
import { normalizedPathPieces } from '../vault-path';

interface FolderLayoutEntry {
	level: string;
	mechanism: 'folder';
	template: string;
}

interface VariadicFolderLayoutEntry extends FolderLayoutEntry {
	variadic: VariadicConfig;
}

/** Defaults for the optional VariadicConfig knobs (kept here so the schema + engine agree). */
const VARIADIC_DEFAULTS = {
	segment: 'prefix' as const,
	drop_last: true,
	max_depth: 6,
	on_overflow: 'truncate' as const,
};

/**
 * Append one folder segment to the primary path. Shared by the fixed-depth and
 * variadic folder paths so nesting behavior stays identical (variadic differs
 * only in *how many* segments it produces, never in how each one lands).
 *
 * AM-33: the segment is ALSO recorded as a `LayoutValue` when the caller asked
 * for one, in the same order and at the same moment it lands. Recording here
 * rather than at the call sites is what makes the two folder paths (fixed and
 * variadic) incapable of disagreeing about what a level produced.
 *
 * AM-37: one value per DIRECTORY SEGMENT, not one per layout entry. A rendered
 * folder segment can carry its own separator two ways this project's own
 * recipes use: a literal in the template (`Frameworks/{catalog.name}`) and a
 * source cell that contains one (`IT/OT`, `2024/Q1`). Either lands as two
 * directories, so recording one value for it made the values count disagree
 * with the segments count, and the consumer (hub identity) silently reverted to
 * deriving identity from the path - the exact defect the values exist to
 * remove.
 *
 * AM-45: the pieces are recorded IN THE FORM THE PATH TAKES. The engine hands
 * the assembled path to Obsidian's `normalizePath` before it reaches the vault,
 * and that folds separators, strips edges, folds non-breaking spaces and
 * normalizes to NFC. A piece recorded before those mutations is a different
 * string from the segment it describes, and the difference NFC makes leaves the
 * segment COUNT intact - so an arity check cannot see it and the value form
 * silently derives a different hub identity than the shipped path form did.
 * Normalizing here, and dropping the pieces that collapse to nothing exactly as
 * the path drops them, is what makes the k-th value byte-identical to the k-th
 * segment rather than merely the same length.
 */
function appendFolderSegment(address: Address, segment: string, level: string, values?: LayoutValue[]): void {
	address.primary.path = address.primary.path
		? `${address.primary.path}/${segment}`
		: segment;
	if (!values) return;
	for (const piece of normalizedPathPieces(segment)) values.push({ level, value: piece });
}

export function applyFolder(
	address: Address,
	entry: FolderLayoutEntry,
	scope: SourceScope,
	report?: RenderReport,
	values?: LayoutValue[],
): void {
	const segment = renderTemplate(entry.template, scope, report);
	if (!segment) {
		report?.notes.push({
			code: 'folder-level-skipped',
			level: entry.level,
			template: entry.template,
			detail: `Level "${entry.level}" rendered empty for this row — the folder level was skipped, so the note lands one level up from its siblings.`,
		});
		return;
	}

	appendFolderSegment(address, segment, entry.level, values);
}

/**
 * Variable-depth folder expansion. Renders the entry's template to a scalar,
 * then splits it into a variable number of folder levels per VariadicConfig.
 * Per the 2026-07-05 variadic-split design (§2). Pure + deterministic —
 * segments derive only from the row's own value.
 */
export function applyVariadicFolder(
	address: Address,
	entry: VariadicFolderLayoutEntry,
	scope: SourceScope,
	report?: RenderReport,
	values?: LayoutValue[],
): void {
	const cfg = entry.variadic;
	const segmentMode = cfg.segment ?? VARIADIC_DEFAULTS.segment;
	const dropLast = cfg.drop_last ?? VARIADIC_DEFAULTS.drop_last;
	const maxDepth = cfg.max_depth ?? VARIADIC_DEFAULTS.max_depth;
	const onOverflow = cfg.on_overflow ?? VARIADIC_DEFAULTS.on_overflow;

	// 1. Render template → scalar (existing engine, unchanged).
	const scalar = renderTemplate(entry.template, scope, report);

	// 2. Split on the delimiter; drop empty pieces (each empty → the existing
	//    folder-level-skipped deviation note, so a value like "A..B" is visible).
	const rawParts = scalar.split(cfg.delimiter);
	const parts: string[] = [];
	for (const p of rawParts) {
		if (p === '') {
			report?.notes.push({
				code: 'folder-level-skipped',
				level: entry.level,
				template: entry.template,
				detail: `Level "${entry.level}" split "${scalar}" on "${cfg.delimiter}" and hit an empty piece — that folder level was skipped, so the note lands one level up from its siblings.`,
			});
			continue;
		}
		parts.push(p);
	}

	// 3. Drop the leaf piece (the file entry names it with the full id anyway).
	if (dropLast && parts.length > 0) {
		parts.pop();
	}

	// Zero segments is normal (a top-level id like `T1055`) — not a deviation.
	if (parts.length === 0) {
		return;
	}

	// 4. Build segments: prefix = cumulative prefixes joined by the delimiter
	//    (`X.Y.Z` → `X`, `X.Y`); part = raw pieces (`X`, `Y`).
	let segments: string[];
	if (segmentMode === 'part') {
		segments = parts;
	} else {
		segments = parts.map((_, i) => parts.slice(0, i + 1).join(cfg.delimiter));
	}

	// 5. Cap at max_depth — overflow truncates (full id survives in the filename)
	//    or hard-errors, per on_overflow.
	if (segments.length > maxDepth) {
		if (onOverflow === 'error') {
			throw new RenderError(
				`Level "${entry.level}" split "${scalar}" into ${segments.length} folder levels, past the max_depth of ${maxDepth}.`,
			);
		}
		report?.notes.push({
			code: 'variadic-overflow-truncated',
			level: entry.level,
			template: entry.template,
			detail: `Level "${entry.level}" split "${scalar}" into ${segments.length} folder levels — capped at the max_depth of ${maxDepth}. The extra levels were dropped; the full id is still in the filename.`,
		});
		segments = segments.slice(0, maxDepth);
	}

	// 6. Append each segment as a folder level (same path as fixed folders).
	for (const segment of segments) {
		appendFolderSegment(address, segment, entry.level, values);
	}
}
