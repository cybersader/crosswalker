#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyInlineSqliteBundle } from './sqlite-inline-build.mjs';

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) {
		throw new Error(`Missing required ${name} argument`);
	}
	return process.argv[index + 1];
}

try {
	const bundlePath = resolve(argument('--bundle'));
	const metafilePath = resolve(argument('--metafile'));
	const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
	verifyInlineSqliteBundle({ bundlePath, metafile });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
