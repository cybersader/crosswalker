/**
 * evidence-window-field-order.test.ts — the evidence link window keeps the
 * note's property order (2026-10-28).
 *
 * The window's text merge used to emit its own blocks first and append the
 * note's carried blocks after them, so every update moved a user's properties
 * to the bottom. It now walks the note's existing order, the same rule the
 * re-import merge in `frontmatter-merge.ts` follows. Values are unchanged from
 * before; only the order is pinned here.
 */

import { mergeFrontmatterText } from '../src/views/evidence-link-modal';

const MANAGED: ReadonlySet<string> = new Set(['curie', 'kind', 'coverage', 'status', 'scope']);

const keysOf = (text: string): string[] =>
	text.split('\n').filter((l) => /^[^\s#-][^:]*:/.test(l)).map((l) => l.slice(0, l.indexOf(':')));

describe('mergeFrontmatterText keeps the note\'s key order', () => {
	const fresh = [
		'curie: ev:a-b',
		'kind: evidence_link',
		'coverage: partial',
		'status: approved',
	].join('\n');

	it('keeps a user key at the top, middle and bottom in place', () => {
		const existing = [
			'reviewer: "Pat"',
			'curie: ev:a-b',
			'kind: evidence_link',
			'confidence: 0.8',
			'coverage: full',
			'status: proposed',
			'notes: keep me',
		].join('\n');
		const merged = mergeFrontmatterText(fresh, existing, MANAGED);
		expect(keysOf(merged)).toEqual(['reviewer', 'curie', 'kind', 'confidence', 'coverage', 'status', 'notes']);
		expect(merged).toContain('reviewer: "Pat"');
		expect(merged).toContain('confidence: 0.8');
		expect(merged).toContain('notes: keep me');
	});

	it('updates a managed value in place', () => {
		const existing = ['curie: ev:a-b', 'kind: evidence_link', 'coverage: full', 'mine: x', 'status: proposed'].join('\n');
		const merged = mergeFrontmatterText(fresh, existing, MANAGED);
		expect(merged.split('\n')).toEqual([
			'curie: ev:a-b', 'kind: evidence_link', 'coverage: partial', 'mine: x', 'status: approved',
		]);
	});

	it('appends a managed key the note did not have, in fresh order', () => {
		const existing = ['mine: x', 'curie: ev:a-b', 'kind: evidence_link'].join('\n');
		const merged = mergeFrontmatterText(fresh, existing, MANAGED);
		expect(keysOf(merged)).toEqual(['mine', 'curie', 'kind', 'coverage', 'status']);
	});

	it('drops a managed key the window no longer writes', () => {
		const existing = ['curie: ev:a-b', 'scope: "AC-2 only"', 'mine: x', 'kind: evidence_link'].join('\n');
		const merged = mergeFrontmatterText(fresh, existing, MANAGED);
		expect(keysOf(merged)).toEqual(['curie', 'mine', 'kind', 'coverage', 'status']);
		expect(merged).not.toContain('scope');
	});

	it('unions a list-union key in place, in the note\'s style', () => {
		const freshWithTags = `${fresh}\ntags:\n  - evidence/junction`;
		const existing = ['curie: ev:a-b', 'tags:', '  - mine', 'notes: n', 'kind: evidence_link'].join('\n');
		const merged = mergeFrontmatterText(freshWithTags, existing, MANAGED);
		expect(merged.split('\n')).toEqual([
			'curie: ev:a-b', 'tags:', '  - evidence/junction', '  - mine', 'notes: n', 'kind: evidence_link',
			'coverage: partial', 'status: approved',
		]);
	});

	it('keeps an unparseable list key\'s bytes in place', () => {
		const freshWithTags = `${fresh}\ntags: [evidence/junction]`;
		const existing = ['curie: ev:a-b', 'tags: [a,', '  b]', 'notes: n', 'kind: evidence_link'].join('\n');
		const merged = mergeFrontmatterText(freshWithTags, existing, MANAGED);
		expect(merged.split('\n')).toEqual([
			'curie: ev:a-b', 'tags: [a,', '  b]', 'notes: n', 'kind: evidence_link',
			'coverage: partial', 'status: approved',
		]);
	});

	it('keeps the note\'s own value for a key the window does not own', () => {
		const freshWithReviewer = `${fresh}\nreviewer: default`;
		const existing = ['reviewer: "Pat"', 'curie: ev:a-b'].join('\n');
		const merged = mergeFrontmatterText(freshWithReviewer, existing, MANAGED);
		expect(merged.split('\n')).toEqual([
			'reviewer: "Pat"', 'curie: ev:a-b', 'kind: evidence_link', 'coverage: partial', 'status: approved',
		]);
	});
});
