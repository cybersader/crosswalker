/**
 * Shared helpers for the command line tests: temporary vault folders, a tree
 * reader for byte comparisons, and a captured Io for runCli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

/** jsdom's File has no arrayBuffer(); give the source readers a byte-backed one. */
class ByteFile {
	readonly name: string;
	readonly size: number;
	private readonly bytes: Uint8Array;

	constructor(parts: Array<string | ArrayBuffer | Uint8Array>, name: string) {
		this.name = name;
		const part = parts[0] ?? '';
		this.bytes = typeof part === 'string'
			? new TextEncoder().encode(part)
			: part instanceof Uint8Array
				? Uint8Array.from(part)
				: new Uint8Array(part.slice(0));
		this.size = this.bytes.byteLength;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(this.bytes);
	}
}

export function installByteFile(): void {
	Object.assign(globalThis, { TextDecoder, TextEncoder, File: ByteFile });
}

export const REPO = path.resolve(__dirname, '..', '..');

export function tempDir(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `cw-${label}-`));
}

/** Every file under `root` (hidden entries skipped), keyed by vault-relative path. */
export function readTree(root: string): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full));
		}
	};
	walk(root);
	return out;
}

export function captureIo(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}
