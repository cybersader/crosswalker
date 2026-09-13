describe('embedded sqlite asset seam', () => {
	let originalAtob: typeof atob;
	let originalBuffer: unknown;

	beforeEach(() => {
		jest.resetModules();
		originalAtob = globalThis.atob;
		originalBuffer = (globalThis as unknown as Record<string, unknown>).Buffer;
	});

	afterEach(() => {
		globalThis.atob = originalAtob;
		(globalThis as unknown as Record<string, unknown>).Buffer = originalBuffer;
	});

	it('does not decode WASM during module evaluation', () => {
		const decode = jest.fn(originalAtob);
		globalThis.atob = decode;

		require('../src/tier2/sqlite-assets');

		expect(decode).not.toHaveBeenCalled();
	});

	it('decodes the complete WASM payload lazily with browser APIs', () => {
		const decode = jest.fn(originalAtob);
		globalThis.atob = decode;
		(globalThis as unknown as Record<string, unknown>).Buffer = undefined;
		const { getSqlite3WasmBytes } = require('../src/tier2/sqlite-assets') as typeof import('../src/tier2/sqlite-assets');

		const first = getSqlite3WasmBytes();
		const second = getSqlite3WasmBytes();

		expect(Array.from(first)).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
		expect(Array.from(second)).toEqual(Array.from(first));
		expect(second).not.toBe(first);
		expect(decode).toHaveBeenCalledTimes(2);
	});

	it('returns the distinct embedded module text without decoding WASM', () => {
		const decode = jest.fn(originalAtob);
		globalThis.atob = decode;
		const { getSqlite3MjsText } = require('../src/tier2/sqlite-assets') as typeof import('../src/tier2/sqlite-assets');

		expect(getSqlite3MjsText()).toBe('export default async function sqlite3InitModule(){ return {}; }\n');
		expect(decode).not.toHaveBeenCalled();
	});
});
