/**
 * Bun preload for the command line. Maps the same module ids jest maps in
 * `jest.config.js` (`moduleNameMapper`), so the plugin's own `src/` modules run
 * unchanged under bun against a plain folder:
 *
 *   obsidian                     -> tests/__mocks__/obsidian.ts
 *   virtual:sqlite3-wasm-base64  -> tests/fixtures/sqlite-wasm-asset.ts
 *   virtual:sqlite3-mjs-text     -> tests/fixtures/sqlite-mjs-asset.ts
 *   virtual:tier2-worker-text    -> tests/fixtures/tier2-worker-text.ts
 *
 * Keep this table in step with `jest.config.js`. The command line never runs
 * the query database, so the sqlite entries only need to resolve.
 */
import { plugin } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const MAP: Record<string, string> = {
	obsidian: resolve(ROOT, 'tests/__mocks__/obsidian.ts'),
	'virtual:sqlite3-wasm-base64': resolve(ROOT, 'tests/fixtures/sqlite-wasm-asset.ts'),
	'virtual:sqlite3-mjs-text': resolve(ROOT, 'tests/fixtures/sqlite-mjs-asset.ts'),
	'virtual:tier2-worker-text': resolve(ROOT, 'tests/fixtures/tier2-worker-text.ts'),
};

/** Every name any `src/` module imports from `obsidian`, read from the source. */
function obsidianImportNames(): Set<string> {
	const names = new Set<string>();
	const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]obsidian['"]/g;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.ts')) {
				const text = readFileSync(full, 'utf8');
				for (const match of text.matchAll(pattern)) {
					for (const raw of match[1].split(',')) {
						const name = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim();
						if (name) names.add(name);
					}
				}
			}
		}
	};
	walk(resolve(ROOT, 'src'));
	return names;
}

/** A stand-in that throws the command-line refusal when called or constructed. */
function unsupported(name: string): unknown {
	const fail = (): never => {
		throw new Error(`not supported from the command line: obsidian.${name}`);
	};
	return new Proxy(function stub() {}, { apply: fail, construct: fail });
}

plugin({
	name: 'crosswalker-cli-module-map',
	setup(build) {
		// Virtual modules: bun resolves a bare id through `module()` before it
		// looks in node_modules, which is the effect of the jest mapper.
		for (const [id, file] of Object.entries(MAP)) {
			build.module(id, async () => {
				const exports: Record<string, unknown> = { ...(await import(file)) };
				if (id === 'obsidian') {
					// Jest loads `src/` as CommonJS, so a name the mock does not export is
					// just undefined there. Bun loads ES modules and refuses a missing
					// named import at link time. Supply every other name `src/` imports
					// as a stub that fails loudly when used, never a silent no-op.
					for (const name of obsidianImportNames()) {
						if (!(name in exports)) exports[name] = unsupported(name);
					}
				}
				return { exports, loader: 'object' };
			});
		}
	},
});
