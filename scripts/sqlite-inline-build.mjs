import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

export const SQLITE_WASM_VIRTUAL_ID = 'virtual:sqlite3-wasm-base64';
export const SQLITE_MJS_VIRTUAL_ID = 'virtual:sqlite3-mjs-text';

const WASM_NAMESPACE = 'crosswalker-sqlite-wasm-base64';
const MJS_NAMESPACE = 'crosswalker-sqlite-mjs-text';
const ASSET_KINDS = ['wasm-base64', 'mjs-text'];

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
	throw new Error(`[crosswalker sqlite verify] ${message}`);
}

/** Resolve the lockfile-installed package through its exported package.json. */
export function resolveSqlitePackageAssets() {
	const require = createRequire(import.meta.url);
	let packageJsonPath;
	try {
		packageJsonPath = require.resolve('@sqlite.org/sqlite-wasm/package.json');
	} catch (error) {
		throw new Error(
			'[crosswalker sqlite build] Could not resolve @sqlite.org/sqlite-wasm/package.json. '
			+ 'Restore dependencies with bun install --frozen-lockfile and rebuild. '
			+ `(${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const packageDirectory = dirname(packageJsonPath);
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
	return {
		packageJsonPath,
		packageDirectory,
		packageVersion: String(packageJson.version ?? '(unknown)'),
		wasmPath: resolve(packageDirectory, 'dist/sqlite3.wasm'),
		mjsPath: resolve(packageDirectory, 'dist/index.mjs'),
	};
}

function readRequiredAsset(path, label) {
	try {
		return readFileSync(path);
	} catch (error) {
		throw new Error(
			`[crosswalker sqlite build] Could not read installed ${label} at ${path}. `
			+ 'Restore dependencies with bun install --frozen-lockfile and rebuild. '
			+ `(${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

/** One narrowly scoped esbuild plugin for the two virtual SQLite asset modules. */
export function createInlineSqliteAssetsPlugin(assets = resolveSqlitePackageAssets()) {
	return {
		name: 'crosswalker-inline-sqlite-assets',
		setup(build) {
			build.onResolve({ filter: /^virtual:sqlite3-wasm-base64$/ }, () => ({
				path: assets.wasmPath,
				namespace: WASM_NAMESPACE,
			}));
			build.onResolve({ filter: /^virtual:sqlite3-mjs-text$/ }, () => ({
				path: assets.mjsPath,
				namespace: MJS_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: WASM_NAMESPACE }, (args) => {
				const payload = readRequiredAsset(args.path, 'sqlite3.wasm').toString('base64');
				return {
					contents: `export default ${JSON.stringify({ cwSqliteAsset: 'wasm-base64', payload })};`,
					loader: 'js',
					watchFiles: [args.path],
				};
			});
			build.onLoad({ filter: /.*/, namespace: MJS_NAMESPACE }, (args) => {
				const payload = readRequiredAsset(args.path, 'dist/index.mjs').toString('utf8');
				return {
					contents: `export default ${JSON.stringify({ cwSqliteAsset: 'mjs-text', payload })};`,
					loader: 'js',
					watchFiles: [args.path],
				};
			});
		},
	};
}

function propertyNameText(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return null;
}

function extractEmbeddedAssetLiterals(bundlePath, sourceText) {
	const source = ts.createSourceFile(bundlePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
	if (source.parseDiagnostics.length > 0) {
		const diagnostic = source.parseDiagnostics[0];
		fail(`main.js could not be parsed as JavaScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
	}
	const found = new Map(ASSET_KINDS.map((kind) => [kind, []]));
	const visit = (node) => {
		if (ts.isObjectLiteralExpression(node)) {
			const values = new Map();
			let shapeIsLiteral = true;
			for (const property of node.properties) {
				if (!ts.isPropertyAssignment(property)) {
					shapeIsLiteral = false;
					continue;
				}
				const key = propertyNameText(property.name);
				if (key !== null) values.set(key, property.initializer);
			}
			const discriminator = values.get('cwSqliteAsset');
			if (discriminator && ts.isStringLiteral(discriminator) && ASSET_KINDS.includes(discriminator.text)) {
				const payload = values.get('payload');
				if (!shapeIsLiteral || node.properties.length !== 2 || !payload || !ts.isStringLiteral(payload)) {
					fail(`embedded ${discriminator.text} object must contain exactly literal string cwSqliteAsset and payload properties`);
				}
				found.get(discriminator.text).push(payload.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	for (const kind of ASSET_KINDS) {
		const matches = found.get(kind);
		if (matches.length !== 1) fail(`expected exactly one ${kind} object literal in main.js; found ${matches.length}`);
	}
	return {
		wasmBase64: found.get('wasm-base64')[0],
		mjsText: found.get('mjs-text')[0],
	};
}

function decodeCanonicalBase64(payload) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
		fail('wasm-base64 payload is not canonical base64');
	}
	const bytes = Buffer.from(payload, 'base64');
	if (bytes.toString('base64') !== payload) fail('wasm-base64 payload changed during decoding');
	return bytes;
}

function assertExactBytes(label, actual, expected) {
	const actualHash = sha256(actual);
	const expectedHash = sha256(expected);
	if (actual.length !== expected.length || actualHash !== expectedHash || !actual.equals(expected)) {
		fail(
			`${label} payload does not match the installed package file: `
			+ `bundle=${actual.length} bytes/${actualHash}, source=${expected.length} bytes/${expectedHash}`,
		);
	}
	return { length: actual.length, sha256: actualHash };
}

function findMainOutput(metafile, bundlePath) {
	const outputs = Object.entries(metafile.outputs ?? {});
	if (outputs.length !== 1) {
		fail(`expected exactly one esbuild output (main.js); found ${outputs.length}: ${outputs.map(([key]) => key).join(', ') || '(none)'}`);
	}
	const [outputPath, output] = outputs[0];
	if (basename(outputPath) !== basename(bundlePath) || basename(outputPath) !== 'main.js') {
		fail(`esbuild output must be main.js matching ${bundlePath}; found ${outputPath}`);
	}
	return { outputPath, output };
}

function assertMetafileContract(metafile, bundlePath, assets) {
	const { outputPath, output } = findMainOutput(metafile, bundlePath);
	const inputEntries = Object.entries(output.inputs ?? {});
	const matchingInputs = (sourcePath) => inputEntries.filter(([key]) => key.includes(sourcePath));
	for (const [label, sourcePath] of [['sqlite3.wasm', assets.wasmPath], ['dist/index.mjs', assets.mjsPath]]) {
		const matches = matchingInputs(sourcePath);
		if (matches.length !== 1) fail(`${label} must appear exactly once in main.js metafile inputs; found ${matches.length}`);
		const bytesInOutput = Number(matches[0][1]?.bytesInOutput ?? 0);
		if (bytesInOutput <= 0) fail(`${label} contributes no bytes to main.js according to the esbuild metafile`);
	}
	const forbiddenImport = (output.imports ?? []).find((entry) => {
		const value = String(entry.path ?? '');
		return entry.external && (
			value.includes('virtual:sqlite3-')
			|| value.includes('@sqlite.org/sqlite-wasm')
			|| /(?:^|\/)sqlite3\.(?:wasm|mjs)$/.test(value)
			|| /(?:^|\/)dist\/index\.mjs$/.test(value)
		);
	});
	if (forbiddenImport) fail(`SQLite runtime asset remained external in main.js: ${forbiddenImport.path}`);
	if (/sqlite3\.(?:wasm|mjs)$/.test(outputPath) || /(?:^|\/)index\.mjs$/.test(outputPath)) {
		fail(`loose SQLite runtime asset was emitted: ${outputPath}`);
	}
}

/** Parse and verify the actual production main.js without executing application code. */
export function verifyInlineSqliteBundle({ bundlePath, metafile, assets = resolveSqlitePackageAssets(), print = console.log }) {
	const bundleBytes = readFileSync(bundlePath);
	const literals = extractEmbeddedAssetLiterals(bundlePath, bundleBytes.toString('utf8'));
	const sourceWasm = readRequiredAsset(assets.wasmPath, 'sqlite3.wasm');
	const sourceMjs = readRequiredAsset(assets.mjsPath, 'dist/index.mjs');
	const embeddedWasm = decodeCanonicalBase64(literals.wasmBase64);
	const embeddedMjs = Buffer.from(literals.mjsText, 'utf8');
	const wasm = assertExactBytes('sqlite3.wasm', embeddedWasm, sourceWasm);
	const mjs = assertExactBytes('dist/index.mjs', embeddedMjs, sourceMjs);
	assertMetafileContract(metafile, bundlePath, assets);
	const report = {
		packageVersion: assets.packageVersion,
		wasm,
		mjs,
		bundle: { length: bundleBytes.length, sha256: sha256(bundleBytes) },
	};
	print(`[crosswalker sqlite verify] package @sqlite.org/sqlite-wasm ${report.packageVersion}`);
	print(`[crosswalker sqlite verify] sqlite3.wasm ${wasm.length} bytes sha256=${wasm.sha256}`);
	print(`[crosswalker sqlite verify] dist/index.mjs ${mjs.length} bytes sha256=${mjs.sha256}`);
	print(`[crosswalker sqlite verify] main.js ${report.bundle.length} bytes sha256=${report.bundle.sha256}`);
	return report;
}
