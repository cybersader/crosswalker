import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '..');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-inline-sqlite-assets.mjs');
const PACKAGE_JSON = require.resolve('@sqlite.org/sqlite-wasm/package.json');
const PACKAGE_DIR = path.dirname(PACKAGE_JSON);
const WASM_PATH = path.join(PACKAGE_DIR, 'dist', 'sqlite3.wasm');
const MJS_PATH = path.join(PACKAGE_DIR, 'dist', 'index.mjs');
const WASM_BASE64 = readFileSync(WASM_PATH).toString('base64');
const MJS_TEXT = readFileSync(MJS_PATH, 'utf8');

interface RunOptions {
	wasmPayload?: string;
	mjsPayload?: string;
	includeWasm?: boolean;
	includeMjs?: boolean;
	duplicateWasm?: boolean;
	duplicateMjs?: boolean;
	externalImport?: boolean;
	includeWasmMetafile?: boolean;
	includeMjsMetafile?: boolean;
	extraOutput?: boolean;
}

function assetLiteral(kind: 'wasm-base64' | 'mjs-text', payload: string): string {
	return JSON.stringify({ cwSqliteAsset: kind, payload });
}

function runVerifier(options: RunOptions = {}): { status: number | null; output: string } {
	const dir = mkdtempSync(path.join(tmpdir(), 'crosswalker-sqlite-verify-'));
	try {
		const bundlePath = path.join(dir, 'main.js');
		const metafilePath = path.join(dir, 'metafile.json');
		const includeWasm = options.includeWasm !== false;
		const includeMjs = options.includeMjs !== false;
		const chunks: string[] = [];
		if (includeWasm) chunks.push(`var wasmAsset = ${assetLiteral('wasm-base64', options.wasmPayload ?? WASM_BASE64)};`);
		if (options.duplicateWasm) chunks.push(`var duplicateWasmAsset = ${assetLiteral('wasm-base64', options.wasmPayload ?? WASM_BASE64)};`);
		if (includeMjs) chunks.push(`var mjsAsset = ${assetLiteral('mjs-text', options.mjsPayload ?? MJS_TEXT)};`);
		if (options.duplicateMjs) chunks.push(`var duplicateMjsAsset = ${assetLiteral('mjs-text', options.mjsPayload ?? MJS_TEXT)};`);
		writeFileSync(bundlePath, chunks.join('\n'));

		const inputs: Record<string, { bytesInOutput: number }> = {};
		if (options.includeWasmMetafile !== false) inputs[`crosswalker-sqlite-wasm-base64:${WASM_PATH}`] = { bytesInOutput: WASM_BASE64.length };
		if (options.includeMjsMetafile !== false) inputs[`crosswalker-sqlite-mjs-text:${MJS_PATH}`] = { bytesInOutput: MJS_TEXT.length };
		const outputs: Record<string, unknown> = {
			[bundlePath]: {
				bytes: readFileSync(bundlePath).length,
				inputs,
				imports: options.externalImport
					? [{ path: 'virtual:sqlite3-wasm-base64', kind: 'require-call', external: true }]
					: [],
			},
		};
		if (options.extraOutput) outputs[path.join(dir, 'sqlite3.wasm')] = { bytes: 8, inputs: {}, imports: [] };
		writeFileSync(metafilePath, JSON.stringify({ inputs: {}, outputs }));

		const result = spawnSync(process.execPath, [VERIFY_SCRIPT, '--bundle', bundlePath, '--metafile', metafilePath], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function runBuildWithMissingWasm(): { status: number | null; output: string } {
	const dir = mkdtempSync(path.join(tmpdir(), 'crosswalker-sqlite-missing-'));
	try {
		const runner = path.join(dir, 'missing-asset-build.mjs');
		const helperUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'sqlite-inline-build.mjs')).href;
		const esbuildUrl = pathToFileURL(require.resolve('esbuild')).href;
		writeFileSync(runner, `
			import esbuild from ${JSON.stringify(esbuildUrl)};
			import { createInlineSqliteAssetsPlugin } from ${JSON.stringify(helperUrl)};
			await esbuild.build({
				stdin: { contents: "import asset from 'virtual:sqlite3-wasm-base64'; console.log(asset);", resolveDir: ${JSON.stringify(REPO_ROOT)} },
				bundle: true,
				write: false,
				plugins: [createInlineSqliteAssetsPlugin({
					packageVersion: 'test',
					packageJsonPath: ${JSON.stringify(PACKAGE_JSON)},
					packageDirectory: ${JSON.stringify(PACKAGE_DIR)},
					wasmPath: ${JSON.stringify(path.join(dir, 'missing-sqlite3.wasm'))},
					mjsPath: ${JSON.stringify(MJS_PATH)},
				})],
			});
		`);
		const result = spawnSync(process.execPath, [runner], { cwd: REPO_ROOT, encoding: 'utf8' });
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('inline sqlite production-build verifier', () => {
	it('accepts complete installed WASM and module bytes with contributing metafile inputs', () => {
		const result = runVerifier();
		expect(result.status).toBe(0);
		expect(result.output).toContain('@sqlite.org/sqlite-wasm');
		expect(result.output).toMatch(/sqlite3\.wasm \d+ bytes sha256=[a-f0-9]{64}/);
		expect(result.output).toMatch(/dist\/index\.mjs \d+ bytes sha256=[a-f0-9]{64}/);
	});

	it('rejects a corrupted or malformed WASM payload', () => {
		const corrupted = runVerifier({ wasmPayload: `B${WASM_BASE64.slice(1)}` });
		expect(corrupted.status).toBe(1);
		expect(corrupted.output).toMatch(/sqlite3\.wasm payload does not match/);

		const malformed = runVerifier({ wasmPayload: 'not-base64!' });
		expect(malformed.status).toBe(1);
		expect(malformed.output).toMatch(/not canonical base64/);
	});

	it('rejects either missing embedded asset', () => {
		const missingMjs = runVerifier({ includeMjs: false });
		expect(missingMjs.status).toBe(1);
		expect(missingMjs.output).toMatch(/exactly one mjs-text.*found 0/);

		const missingWasm = runVerifier({ includeWasm: false });
		expect(missingWasm.status).toBe(1);
		expect(missingWasm.output).toMatch(/exactly one wasm-base64.*found 0/);
	});

	it('rejects duplicate discriminated literals for either asset', () => {
		const duplicateWasm = runVerifier({ duplicateWasm: true });
		expect(duplicateWasm.status).toBe(1);
		expect(duplicateWasm.output).toMatch(/exactly one wasm-base64.*found 2/);

		const duplicateMjs = runVerifier({ duplicateMjs: true });
		expect(duplicateMjs.status).toBe(1);
		expect(duplicateMjs.output).toMatch(/exactly one mjs-text.*found 2/);
	});

	it('rejects module-text escaping corruption', () => {
		const escapedText = JSON.stringify(MJS_TEXT).slice(1, -1);
		const result = runVerifier({ mjsPayload: escapedText });
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/dist\/index\.mjs payload does not match/);
	});

	it('rejects a source asset missing from main.js metafile inputs', () => {
		const result = runVerifier({ includeMjsMetafile: false });
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/dist\/index\.mjs must appear exactly once.*found 0/);
	});

	it('rejects an external virtual or package asset dependency', () => {
		const result = runVerifier({ externalImport: true });
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/remained external/);
	});

	it('rejects any extra build output, including a loose SQLite asset', () => {
		const result = runVerifier({ extraOutput: true });
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/exactly one esbuild output.*found 2/);
	});

	it('fails the build when an installed input asset is unreadable or missing', () => {
		const result = runBuildWithMissingWasm();
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/Could not read installed sqlite3\.wasm/);
		expect(result.output).toMatch(/bun install --frozen-lockfile/);
	});
});
