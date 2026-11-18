#!/usr/bin/env bun
/** Build the public demo: bun run demo:build -- --out <dir> [--sources-dir <checkout>]. */
import { fileURLToPath } from 'node:url';
import { buildStack } from '../tools/lib/stack-build.ts';

const usage = 'Usage: bun run demo:build -- --out <folder>';

function main(argv) {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	let vault;
	let sourcesDir = null;
	for (let i = 0; i < args.length; i++) {
		const option = args[i];
		if (option === '--out') vault = args[++i];
		else if (option.startsWith('--out=')) vault = option.slice('--out='.length);
		else if (option === '--sources-dir') sourcesDir = args[++i];
		else if (option.startsWith('--sources-dir=')) sourcesDir = option.slice('--sources-dir='.length);
		else throw new Error(`Unknown option "${option}". ${usage}`);
	}
	if (!vault) throw new Error('Missing --out. Pass the folder to build the demo vault in, for example: bun run demo:build -- --out /tmp/crosswalker-demo');
	if (sourcesDir !== null && !sourcesDir) throw new Error('Missing --sources-dir value. Pass the checkout containing Frameworks/.');
	const file = fileURLToPath(new URL('../stacks/public-grc-demo.stack.json', import.meta.url));
	return buildStack({ file, vault, sourcesDir: sourcesDir ?? undefined, demo: true }, {
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
	});
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
