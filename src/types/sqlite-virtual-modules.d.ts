declare module 'virtual:sqlite3-wasm-base64' {
	const asset: {
		readonly cwSqliteAsset: 'wasm-base64';
		readonly payload: string;
	};
	export default asset;
}

declare module 'virtual:sqlite3-mjs-text' {
	const asset: {
		readonly cwSqliteAsset: 'mjs-text';
		readonly payload: string;
	};
	export default asset;
}
