import wasmAsset from 'virtual:sqlite3-wasm-base64';
import mjsAsset from 'virtual:sqlite3-mjs-text';

/** Decode the embedded WASM only for the initialization attempt that needs it. */
export function getSqlite3WasmBytes(): Uint8Array {
	const binary = atob(wasmAsset.payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** Return the installed sqlite-wasm module text embedded by the build. */
export function getSqlite3MjsText(): string {
	return mjsAsset.payload;
}
