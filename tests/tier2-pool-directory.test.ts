/**
 * tier2-pool-directory.test.ts — where the persisted index lives.
 *
 * The pool directory must not move when a vault or workspace is renamed: a moved
 * directory leaves the persisted index behind and the next open starts empty.
 * The browser host (OpenClast) reports a constant vault name today and plans to
 * report the workspace display name, which changes on rename; its appId is stable
 * per member and workspace. Desktop Obsidian's appId is the vault's stable id.
 * So the key is appId alone, with the vault name only as the no-appId fallback.
 */

import { poolDirectoryFor } from '../src/tier2/sidecar';
import type { App } from 'obsidian';

function fakeApp(appId: unknown, name: string): App {
	return { appId, vault: { getName: () => name } } as unknown as App;
}

describe('poolDirectoryFor', () => {
	it('does not move when the vault name changes', () => {
		expect(poolDirectoryFor(fakeApp('ocw-0123456789abcdef01234567', 'OpenClast')))
			.toBe(poolDirectoryFor(fakeApp('ocw-0123456789abcdef01234567', 'Crosswalker testing')));
	});

	it('separates two workspaces that report the same vault name', () => {
		expect(poolDirectoryFor(fakeApp('ocw-aaaaaaaaaaaaaaaaaaaaaaaa', 'OpenClast')))
			.not.toBe(poolDirectoryFor(fakeApp('ocw-bbbbbbbbbbbbbbbbbbbbbbbb', 'OpenClast')));
	});

	it('falls back to the vault name when the host has no appId', () => {
		expect(poolDirectoryFor(fakeApp(undefined, 'A'))).not.toBe(poolDirectoryFor(fakeApp(undefined, 'B')));
		expect(poolDirectoryFor(fakeApp('', 'A'))).toBe(poolDirectoryFor(fakeApp(undefined, 'A')));
	});

	it('stays under the plugin root, never the VFS default', () => {
		expect(poolDirectoryFor(fakeApp('x', 'y'))).toMatch(/^crosswalker\/vault-[0-9a-f]{8}$/);
	});
});
