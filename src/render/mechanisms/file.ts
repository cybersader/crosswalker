/**
 * file mechanism — leaf-bearing markdown file
 *
 * Per Ch 22: the leaf-bearing primitive. Sets the concept's primary file.
 * Template should produce a `.md`-suffixed path (or we add the suffix).
 */

import type { Address, SourceScope, RenderReport, LayoutValue } from '../types';
import { renderTemplate, RenderError } from '../template';
import { normalizedPathPieces } from '../vault-path';

interface FileLayoutEntry {
	level: string;
	mechanism: 'file';
	template: string;
}

export function applyFile(
	address: Address,
	entry: FileLayoutEntry,
	scope: SourceScope,
	report?: RenderReport,
	values?: LayoutValue[],
): void {
	let segment = renderTemplate(entry.template, scope, report);
	if (!segment) {
		throw new RenderError(
			`file mechanism produced empty path for level "${entry.level}". Template: "${entry.template}".`,
		);
	}

	// Ensure .md suffix
	if (!segment.endsWith('.md')) {
		segment = `${segment}.md`;
	}

	// AM-37. A file template is allowed to carry directories
	// (`Crosswalks/CSF-to-800-53/{id}.md`, which six shipped recipes do), and
	// those directories are directories like any other: the folder they name
	// gets a hub note, and that hub needs to know what it is about. Recording
	// nothing for them left the values count short of the segments count, and
	// the hub pass answered a disagreement by going back to parsing the path -
	// a silent revert to the rule the values exist to replace. Every piece
	// except the last is a directory; the last is the file itself and is
	// deliberately not a layout value.
	//
	// AM-45: normalized first, then the filename dropped, so the pieces recorded
	// are the ones the vault path will actually have. Splitting the raw template
	// output instead recorded a piece that `normalizePath` was about to change or
	// remove, and a value that differs from its segment by NFC alone keeps the
	// counts equal - invisible to an arity check, and enough to move every hub
	// identity beneath it.
	if (values) {
		const pieces = normalizedPathPieces(segment);
		for (let i = 0; i < pieces.length - 1; i++) values.push({ level: entry.level, value: pieces[i] });
	}

	address.primary.path = address.primary.path
		? `${address.primary.path}/${segment}`
		: segment;
}
