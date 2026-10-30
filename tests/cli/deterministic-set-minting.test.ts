import { installDeterminism } from '../../cli/crosswalker';
import { mintImportSetId } from '../../src/generation/import-set';

describe('import set minting across deterministic CLI processes', () => {
	it('mints 150 sets from restarted streams without changing the existing sequence', () => {
		const existing = new Set<string>();
		const minted: string[] = [];
		for (let i = 0; i < 150; i++) {
			const restore = installDeterminism();
			try {
				const id = mintImportSetId(existing);
				existing.add(id);
				minted.push(id);
			} finally { restore(); }
		}
		expect(existing.size).toBe(150);
		// Existing public demo output, before the capacity fix.
		expect(minted.slice(0, 5)).toEqual(['iset-a0f1e2', 'iset-0f6ht0', 'iset-xskeb8', 'iset-7z4lxm', 'iset-if5214']);
	});

	it('keeps ordinary random-byte minting and collision handling unchanged', () => {
		let draw = 0;
		const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
			array.fill(draw++);
			return array;
		}) as typeof globalThis.crypto.getRandomValues);
		try {
			expect(mintImportSetId(new Set(['iset-aaaaaa']))).toBe('iset-bbbbbb');
			expect(spy).toHaveBeenCalledTimes(2);
		} finally { spy.mockRestore(); }
	});

	it('fails within its counted bound if the random source never makes progress', () => {
		const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
			array.fill(0);
			return array;
		}) as typeof globalThis.crypto.getRandomValues);
		try {
			expect(() => mintImportSetId(new Set(['iset-aaaaaa']))).toThrow('after 101 attempts. Check secure random generation and try again.');
			expect(spy).toHaveBeenCalledTimes(101);
		} finally { spy.mockRestore(); }
	});
});
