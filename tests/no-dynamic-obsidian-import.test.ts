/**
 * no-dynamic-obsidian-import.test.ts -- `obsidian` is only ever imported
 * statically.
 *
 * THE DEFECT THIS PINS. esbuild marks `obsidian` external and keeps a dynamic
 * `import('obsidian')` as a native `import()` in the CommonJS bundle. Obsidian
 * provides the module through its `require` shim only, so the browser loader
 * cannot resolve the bare specifier and the command throws "Failed to resolve
 * module specifier 'obsidian'". Found when the bundled-fixture and delete-test-
 * import developer commands did nothing in a browser Obsidian harness run.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx|svelte)$/.test(name) ? [path] : [];
	});
}

describe('obsidian module imports', () => {
	it('never imports obsidian dynamically', () => {
		const offenders = sourceFiles(join(__dirname, '..', 'src'))
			.filter((path) => /import\(\s*['"]obsidian['"]\s*\)/.test(readFileSync(path, 'utf8')));
		expect(offenders).toEqual([]);
	});
});
