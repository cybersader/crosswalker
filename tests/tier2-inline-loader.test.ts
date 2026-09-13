import * as path from 'node:path';
import {
	clearFakeSqlite3,
	fakeSqlite3InitCalls,
	fakeSqlite3InitOptions,
	installFakeSqlite3,
	requestFakeSqlite3Asset,
} from './helpers/fake-sqlite-wasm';

const FAKE_MODULE_PATH = path.join(__dirname, 'helpers', 'fake-sqlite-wasm.ts');

type SidecarModule = typeof import('../src/tier2/sidecar');

interface TestPlugin {
	manifest: { id: string };
	app: {
		vault: {
			configDir: string;
			adapter: {
				readBinary: jest.Mock;
				read: jest.Mock;
				getResourcePath: jest.Mock;
			};
		};
	};
}

function createPlugin(options: { failOnAssetRead?: boolean } = {}): TestPlugin {
	const fail = () => {
		throw new Error('legacy adapter asset read was used');
	};
	return {
		manifest: { id: 'crosswalker' },
		app: {
			vault: {
				configDir: '.obsidian',
				adapter: {
					readBinary: jest.fn(options.failOnAssetRead ? fail : () => Promise.resolve(new ArrayBuffer(8))),
					read: jest.fn(options.failOnAssetRead ? fail : () => Promise.resolve('// legacy sqlite3.mjs stand-in')),
					getResourcePath: jest.fn((value: string) => `app://local/${value}`),
				},
			},
		},
	};
}

describe('inline sqlite runtime loader', () => {
	let sidecar: SidecarModule;
	let originalCreate: unknown;
	let originalRevoke: unknown;
	let createObjectUrl: jest.Mock;
	let revokeObjectUrl: jest.Mock;
	let warnSpy: jest.SpyInstance;

	beforeEach(() => {
		jest.resetModules();
		sidecar = require('../src/tier2/sidecar');
		const urlCtor = URL as unknown as Record<string, unknown>;
		originalCreate = urlCtor.createObjectURL;
		originalRevoke = urlCtor.revokeObjectURL;
		createObjectUrl = jest.fn(() => FAKE_MODULE_PATH);
		revokeObjectUrl = jest.fn();
		urlCtor.createObjectURL = createObjectUrl;
		urlCtor.revokeObjectURL = revokeObjectUrl;
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		const urlCtor = URL as unknown as Record<string, unknown>;
		urlCtor.createObjectURL = originalCreate;
		urlCtor.revokeObjectURL = originalRevoke;
		warnSpy.mockRestore();
		clearFakeSqlite3();
	});

	it('initializes without reading sqlite assets from the vault adapter', async () => {
		installFakeSqlite3();
		const plugin = createPlugin({ failOnAssetRead: true });

		const handle = await sidecar.openSidecar(plugin as any, plugin.app as any);
		await handle.close();

		expect(plugin.app.vault.adapter.readBinary).not.toHaveBeenCalled();
		expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
		expect(plugin.app.vault.adapter.getResourcePath).not.toHaveBeenCalled();
	});

	it("returns sqlite3.wasm unchanged from locateFile without warning", async () => {
		installFakeSqlite3();
		const plugin = createPlugin();
		const handle = await sidecar.openSidecar(plugin as any, plugin.app as any);
		const locateFile = fakeSqlite3InitOptions()?.locateFile;

		expect(locateFile).toBeDefined();
		expect(locateFile?.('sqlite3.wasm')).toBe('sqlite3.wasm');
		expect(warnSpy).not.toHaveBeenCalled();
		await handle.close();
	});

	it('throws an actionable named error for any unexpected runtime asset request', async () => {
		installFakeSqlite3();
		const plugin = createPlugin();
		const handle = await sidecar.openSidecar(plugin as any, plugin.app as any);
		const locateFile = fakeSqlite3InitOptions()?.locateFile;

		expect(() => locateFile?.('sqlite3-opfs-async-proxy.js')).toThrow(
			expect.objectContaining({
				name: 'UnexpectedSqliteAssetRequestError',
				message: expect.stringMatching(/unexpected.*sqlite3-opfs-async-proxy\.js.*reload.*troubleshooting/i),
			}),
		);
		await handle.close();
	});

	it('revokes the module Blob and retries cleanly after an unexpected asset aborts initialization', async () => {
		installFakeSqlite3({ locateFileRequest: 'sqlite3-opfs-async-proxy.js' });
		const plugin = createPlugin();

		await expect(sidecar.openSidecar(plugin as any, plugin.app as any)).rejects.toMatchObject({
			name: 'UnexpectedSqliteAssetRequestError',
		});
		expect(createObjectUrl).toHaveBeenCalledTimes(1);
		expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
		expect(fakeSqlite3InitCalls()).toBe(1);

		requestFakeSqlite3Asset();
		const handle = await sidecar.openSidecar(plugin as any, plugin.app as any);
		expect(fakeSqlite3InitCalls()).toBe(2);
		expect(createObjectUrl).toHaveBeenCalledTimes(2);
		expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
		await handle.close();
	});
});
