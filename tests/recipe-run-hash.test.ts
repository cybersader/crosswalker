import * as fs from 'node:fs';
import * as path from 'node:path';
import { dump } from 'js-yaml';
import { createFsApp } from '../cli/fs-app';
import { tempDir } from './cli/helpers';
import { buildIdentityIndex } from '../src/generation/identity-index';
import { recipeHashForRun } from '../src/generation/recipe-run-hash';

const OLD = `sha256-${'a'.repeat(64)}`;
const FRESH = `sha256-${'b'.repeat(64)}`;
const DIGEST = `sha256-${'c'.repeat(64)}`;
const SET = 'iset-a0f1e2';

type Stamp = { hash?: string; digest?: string; recipe?: string; owner?: string; curie?: string };
async function select(stamps: Stamp[], digest: string | undefined = DIGEST): Promise<string> {
	const vault = tempDir('run-recipe-hash');
	for (const [i, stamp] of stamps.entries()) {
		const fm = { curie: stamp.curie ?? `synthetic:${i}`, _crosswalker: {
			import_set: { id: stamp.owner ?? SET },
			recipe: { id: stamp.recipe ?? 'synthetic', hash: stamp.hash, recipe_document_digest: stamp.digest },
		} };
		fs.writeFileSync(path.join(vault, `${i}.md`), `---\n${dump(fm)}---\nSynthetic\n`);
	}
	const app = createFsApp(vault) as any;
	const owned = await buildIdentityIndex(app, { importSetId: SET });
	return recipeHashForRun(app, owned, 'synthetic', digest, FRESH);
}

describe('one recipe hash per run', () => {
	it('preserves one verified owned-set hash and ignores another set', async () => {
		expect(await select([{ hash: OLD, digest: DIGEST }, { hash: FRESH, digest: DIGEST, owner: 'iset-b0f1e2' }])).toBe(OLD);
	});
	it.each([
		['empty set', []],
		['mixed hashes', [{ hash: OLD, digest: DIGEST }, { hash: FRESH, digest: DIGEST }]],
		['missing digest', [{ hash: OLD }]],
		['changed digest', [{ hash: OLD, digest: FRESH }]],
		['different recipe', [{ hash: OLD, digest: DIGEST, recipe: 'different' }]],
		['missing hash', [{ digest: DIGEST }]],
		['invalid hash', [{ hash: 'old', digest: DIGEST }]],
		['ambiguous identity', [{ hash: OLD, digest: DIGEST, curie: 'synthetic:one' }, { hash: OLD, digest: DIGEST, curie: 'synthetic:one' }]],
	] as Array<[string, Stamp[]]>)('does not infer equivalence from %s', async (_label, stamps) => {
		expect(await select(stamps)).toBe(FRESH);
	});
	it('requires a valid fresh document digest', async () => {
		expect(await select([{ hash: OLD, digest: DIGEST }], 'invalid')).toBe(FRESH);
	});
});
