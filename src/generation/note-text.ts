/**
 * note-text.ts: pure note-text splitting. No Obsidian imports, so node-side
 * code (e2e assertions, the managed-equivalence helper) can use it.
 */

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
