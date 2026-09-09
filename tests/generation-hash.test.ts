/**
 * generation-hash.test.ts — sha256Hex against official FIPS 180-4 test
 * vectors, canonicalStringify determinism, and the concept_cid / recipe.hash
 * field-set semantics documented in src/generation/hash.ts.
 */

import { createHash } from 'node:crypto';
import {
	sha256Hex,
	sha256BytesHex,
	computeSourceByteDigest,
	canonicalStringify,
	computeConceptCid,
	identityScopeForNoteKind,
	computeRecipeHash,
	toSha256Cid,
} from '../src/generation/hash';

const nodeSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('sha256Hex', () => {
	// Official NIST/FIPS 180-4 test vectors.
	it('hashes the empty string', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('hashes "abc"', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('hashes the two-block message vector', () => {
		expect(
			sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
		).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
	});

	it('hashes a 1,000,000-char "a" message (extended vector)', () => {
		expect(sha256Hex('a'.repeat(1_000_000))).toBe(
			'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
		);
	});

	it('is stable across UTF-8 multi-byte input', () => {
		// Just asserts determinism + no crash on non-ASCII, not a fixed vector.
		const a = sha256Hex('NIST 800-53 r5 — Ünïcödé ✓');
		const b = sha256Hex('NIST 800-53 r5 — Ünïcödé ✓');
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
	});

	it('produces 64 lowercase hex chars', () => {
		expect(sha256Hex('anything')).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe('sha256BytesHex', () => {
	it('matches an independent Node oracle for empty and official FIPS byte vectors', () => {
		const vectors = [
			new Uint8Array(),
			Uint8Array.from(Buffer.from('abc', 'ascii')),
			Uint8Array.from(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'ascii')),
		];
		for (const bytes of vectors) expect(sha256BytesHex(bytes)).toBe(nodeSha256(bytes));
	});

	it('hashes binary bytes including NUL and non-UTF8 values without text conversion', () => {
		const bytes = Uint8Array.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x00, 0x7f]);
		expect(sha256BytesHex(bytes)).toBe(nodeSha256(bytes));
		expect(sha256BytesHex(bytes)).not.toBe(sha256Hex(String.fromCharCode(...bytes)));
	});

	it('keeps UTF-8 parity with the existing string helper', () => {
		const text = 'NIST 800-53 r5 — Ünïcödé ✓';
		const bytes = Uint8Array.from(Buffer.from(text, 'utf8'));
		expect(sha256BytesHex(bytes)).toBe(nodeSha256(bytes));
		expect(sha256BytesHex(bytes)).toBe(sha256Hex(text));
	});

	it.each([55, 56, 63, 64, 65])('matches the oracle at the %i-byte padding boundary', (length) => {
		const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
		expect(sha256BytesHex(bytes)).toBe(nodeSha256(bytes));
	});

	it('respects a nonzero-offset view instead of hashing the backing allocation', () => {
		const backing = Uint8Array.from([9, 8, 7, 1, 2, 3, 4, 6, 5]);
		const view = new Uint8Array(backing.buffer, 3, 4);
		expect([...view]).toEqual([1, 2, 3, 4]);
		expect(sha256BytesHex(view)).toBe(nodeSha256(view));
		expect(sha256BytesHex(view)).not.toBe(nodeSha256(backing));
	});

	it('does not mutate its input and wraps source digests in the existing CID format', () => {
		const bytes = Uint8Array.from([0, 1, 2, 254, 255]);
		const before = Uint8Array.from(bytes);
		const hex = nodeSha256(bytes);
		expect(computeSourceByteDigest(bytes)).toBe(`sha256-${hex}`);
		expect(bytes).toEqual(before);
	});
});

describe('canonicalStringify', () => {
	it('is independent of object key insertion order', () => {
		const a = { b: 1, a: 2, c: 3 };
		const b = { c: 3, a: 2, b: 1 };
		expect(canonicalStringify(a)).toBe(canonicalStringify(b));
	});

	it('sorts nested object keys recursively', () => {
		const a = { outer: { z: 1, y: 2 } };
		const b = { outer: { y: 2, z: 1 } };
		expect(canonicalStringify(a)).toBe(canonicalStringify(b));
	});

	it('preserves array order (order is semantic)', () => {
		expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
	});

	it('treats an absent key and an explicit undefined value the same', () => {
		const withKey = { a: 1, b: undefined };
		const withoutKey = { a: 1 };
		expect(canonicalStringify(withKey)).toBe(canonicalStringify(withoutKey));
	});

	it('is deterministic across repeated calls', () => {
		const v = { z: [1, { q: 1, a: 2 }], a: 'x' };
		expect(canonicalStringify(v)).toBe(canonicalStringify(v));
	});
});

describe('toSha256Cid', () => {
	it('wraps a hex digest in the sha256-{hex} format', () => {
		expect(toSha256Cid('abc123')).toBe('sha256-abc123');
	});
});

describe('computeConceptCid', () => {
	it('matches the sha256_cid pattern from spec/tier1.schema.json', () => {
		const cid = computeConceptCid({ curie: 'nist:AC-2', scope: { title: 'Account management' } });
		expect(cid).toMatch(/^sha256-[a-f0-9]{64}$/);
	});

	it('is stable under placement-only change: identical (curie, scope) → identical cid regardless of caller context', () => {
		const record = { curie: 'nist:AC-2', scope: { title: 'Account management', family: 'AC' } };
		const cidA = computeConceptCid({ curie: record.curie, scope: { ...record.scope } });
		const cidB = computeConceptCid({ curie: record.curie, scope: { ...record.scope } });
		expect(cidA).toBe(cidB);
	});

	it('is independent of scope key order (row column order should not matter)', () => {
		const cidA = computeConceptCid({ curie: 'nist:AC-2', scope: { title: 'X', family: 'AC' } });
		const cidB = computeConceptCid({ curie: 'nist:AC-2', scope: { family: 'AC', title: 'X' } });
		expect(cidA).toBe(cidB);
	});

	it('changes when the row content changes', () => {
		const cidA = computeConceptCid({ curie: 'nist:AC-2', scope: { title: 'Account management' } });
		const cidB = computeConceptCid({ curie: 'nist:AC-2', scope: { title: 'Account management (updated)' } });
		expect(cidA).not.toBe(cidB);
	});

	it('changes when the curie changes, even if scope is identical', () => {
		const scope = { title: 'Account management' };
		const cidA = computeConceptCid({ curie: 'nist:AC-2', scope });
		const cidB = computeConceptCid({ curie: 'nist:AC-3', scope });
		expect(cidA).not.toBe(cidB);
	});

	it('keeps concept CIDs stable when mapping-only defaults are added to the render scope', () => {
		const sourceScope = { title: 'Account management', family: 'AC' };
		const normalizedRenderScope = {
			...sourceScope,
			mapping_set_id: '',
			predicate_modifier: '',
		};

		const before = computeConceptCid({ curie: 'nist:AC-2', scope: sourceScope });
		const after = computeConceptCid({
			curie: 'nist:AC-2',
			scope: identityScopeForNoteKind(undefined, sourceScope, normalizedRenderScope),
		});

		expect(after).toBe(before);
	});

	it('is identical for stamped and unstamped notes because import_set is provenance, not identity', () => {
		const scope = { title: 'Account management', family: 'AC' };
		const unstamped = { curie: 'nist:AC-2', _crosswalker: {} };
		const stamped = {
			curie: 'nist:AC-2',
			_crosswalker: { import_set: { id: 'iset-abc123', scheme: 'endpoint-v1' } },
		};
		const cid = (note: { curie: string }) => computeConceptCid({ curie: note.curie, scope });
		expect(cid(stamped)).toBe(cid(unstamped));
	});

	it('does not change when only render()-time placement changes (recipe/layout is not part of the input at all)', () => {
		// concept_cid is computed from (curie, scope) alone — render()'s Address
		// (path/frontmatter/tags) never enters the hash, so two different
		// "renders" of the same identity necessarily produce the same cid.
		// This test documents that invariant at the type level: there is no
		// address/path parameter to computeConceptCid to vary.
		const scope = { title: 'Account management', family: 'AC' };
		const cid1 = computeConceptCid({ curie: 'nist:AC-2', scope });
		const cid2 = computeConceptCid({ curie: 'nist:AC-2', scope });
		expect(cid1).toBe(cid2);
	});
});

describe('computeRecipeHash', () => {
	const baseTarget = {
		layout: [{ level: 'family', mechanism: 'folder', template: '{family}' }],
		also_emit: { tags: ['framework/nist'] },
		enrichment: { children_lists: true },
	};

	it('matches the sha256-{hex} format', () => {
		expect(computeRecipeHash(baseTarget)).toMatch(/^sha256-[a-f0-9]{64}$/);
	});

	it('is stable across repeated calls with the same target (double-run determinism)', () => {
		const a = computeRecipeHash(JSON.parse(JSON.stringify(baseTarget)));
		const b = computeRecipeHash(JSON.parse(JSON.stringify(baseTarget)));
		expect(a).toBe(b);
	});

	it('is stable across row changes — recipe.hash depends only on target shape, not source data', () => {
		// computeRecipeHash's signature has no row/scope parameter at all — this
		// test documents that a caller re-hashing the same recipe target for
		// every row in a corpus (or once per run) always gets the same value.
		const a = computeRecipeHash(baseTarget);
		const b = computeRecipeHash(baseTarget);
		expect(a).toBe(b);
	});

	it('changes when layout changes', () => {
		const changed = { ...baseTarget, layout: [{ level: 'family', mechanism: 'folder', template: '{family}-x' }] };
		expect(computeRecipeHash(baseTarget)).not.toBe(computeRecipeHash(changed));
	});

	it('changes when also_emit changes', () => {
		const changed = { ...baseTarget, also_emit: { tags: ['framework/nist', 'extra'] } };
		expect(computeRecipeHash(baseTarget)).not.toBe(computeRecipeHash(changed));
	});

	it('changes when canonical body output changes through also_emit.body', () => {
		const withBody = {
			...baseTarget,
			also_emit: {
				...baseTarget.also_emit,
				body: [{ template: '{description}', position: 'append', format: 'text' }],
			},
		};
		const editedBody = {
			...withBody,
			also_emit: {
				...withBody.also_emit,
				body: [{ template: '{discussion}', position: 'section', heading: 'Discussion', format: 'quote' }],
			},
		};
		expect(computeRecipeHash(baseTarget)).not.toBe(computeRecipeHash(withBody));
		expect(computeRecipeHash(withBody)).not.toBe(computeRecipeHash(editedBody));
	});

	it('changes when enrichment changes', () => {
		const changed = { ...baseTarget, enrichment: { children_lists: false } };
		expect(computeRecipeHash(baseTarget)).not.toBe(computeRecipeHash(changed));
	});

	it('is independent of also_emit/layout key insertion order', () => {
		const a = computeRecipeHash({
			layout: baseTarget.layout,
			also_emit: { tags: ['framework/nist'] },
			enrichment: { children_lists: true },
		});
		const b = computeRecipeHash({
			enrichment: { children_lists: true },
			also_emit: { tags: ['framework/nist'] },
			layout: baseTarget.layout,
		});
		expect(a).toBe(b);
	});

	it('treats a missing also_emit/enrichment the same as an explicit undefined', () => {
		const a = computeRecipeHash({ layout: baseTarget.layout });
		const b = computeRecipeHash({ layout: baseTarget.layout, also_emit: undefined, enrichment: undefined });
		expect(a).toBe(b);
	});
});
