/**
 * `cw replay` runs an import set again with the exact recipe revision that set
 * ran, read from the copy the set keeps. The recipe is found by identity (the
 * set id and recipe digest stamped in each note), never by folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const SOURCE = path.join(REPO, 'tools/fixtures/synthetic/nist-mini.csv');
const DESTINATION = 'Frameworks/NIST-mini';
const SET = 'iset-a0f1e2';
const SUMMARY = /: (\d+) created, (\d+) updated, (\d+) up to date, (\d+) skipped\./;

async function importFresh(label: string): Promise<string> {
	const vault = tempDir(label);
	const io = captureIo();
	expect(await runCli(['import', '--vault', vault, '--source', SOURCE, '--ontology', 'nist-mini',
		'--destination', DESTINATION, '--deterministic'], io.io)).toBe(0);
	expect(io.out.join('\n')).toContain(`Set id: ${SET}.`);
	return vault;
}

async function replay(vault: string, extra: string[]): Promise<{ code: number; out: string; err: string }> {
	const io = captureIo();
	const code = await runCli(['replay', '--vault', vault, '--set', SET, ...extra, '--deterministic'], io.io);
	return { code, out: io.out.join('\n'), err: io.err.join('\n') };
}

function counts(out: string): number[] {
	const match = SUMMARY.exec(out);
	expect(match).not.toBeNull();
	return match!.slice(1).map(Number);
}

function keptCopies(vault: string): string[] {
	return [...readTree(vault).keys()].filter((p) => /^_crosswalker\/import-sets\/[^/]+\/recipe-/.test(p));
}

describe('cw replay', () => {
	// Prevents: a replay of the unchanged source rewriting notes (a sorted kept copy reordering properties, or notes moving to the recipe's default folder).
	it('runs the same source again with nothing to change', async () => {
		const vault = await importFresh('replay-same');
		const before = readTree(vault);
		const result = await replay(vault, ['--source', SOURCE]);
		expect(result.err).toBe('');
		expect(result.code).toBe(0);
		expect(result.out).toMatch(/^Running recipe custom-nist-mini \(revision sha256-[0-9a-f]{8}\) again into set iset-a0f1e2\./);
		expect(counts(result.out)).toEqual([0, 0, 8, 0]);
		const after = readTree(vault);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [file, bytes] of before) expect(after.get(file)?.equals(bytes)).toBe(true);
	}, 60000);

	// Prevents: an edited source value never reaching the note on replay.
	it('updates the note whose source value changed', async () => {
		const vault = await importFresh('replay-edit');
		const edited = path.join(tempDir('replay-edit-src'), 'nist-mini.csv');
		const text = fs.readFileSync(SOURCE, 'utf8');
		expect(text).toContain('Access Enforcement');
		fs.writeFileSync(edited, text.replace('Access Enforcement', 'Access Enforcement Revised'));
		const result = await replay(vault, ['--source', edited]);
		expect(result.err).toBe('');
		expect(result.code).toBe(0);
		expect(counts(result.out)[1]).toBeGreaterThan(0);
		expect(fs.readFileSync(path.join(vault, DESTINATION, 'AC', 'AC-3.md'), 'utf8')).toContain('name: Access Enforcement Revised');
	}, 60000);

	// Prevents: a replay without a source failing with no hint that Crosswalker keeps no copy of it.
	it('refuses without --source and says why', async () => {
		const vault = await importFresh('replay-no-source');
		const result = await replay(vault, []);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain('keeps no copy of the source file');
		expect(result.err).toContain('--source');
	}, 60000);

	// Prevents: an unknown set id silently importing into a new set.
	it('refuses a set no note belongs to', async () => {
		const vault = await importFresh('replay-unknown');
		const io = captureIo();
		const code = await runCli(['replay', '--vault', vault, '--set', 'iset-zzzzzz', '--source', SOURCE], io.io);
		expect(code).not.toBe(0);
		expect(io.err.join('\n')).toContain('No notes in this vault belong to set iset-zzzzzz');
		expect(io.out).toEqual([]);
	}, 60000);

	// Prevents: a replay guessing a recipe when the set's kept copy is gone.
	it('refuses when the kept recipe copy is missing and points at cw import', async () => {
		const vault = await importFresh('replay-no-copy');
		const copies = keptCopies(vault);
		expect(copies).toHaveLength(1);
		fs.rmSync(path.join(vault, copies[0]));
		const before = readTree(vault);
		const result = await replay(vault, ['--source', SOURCE]);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain(`Set ${SET} has no kept copy of the recipe revision`);
		expect(result.err).toContain(`cw -- import --vault <dir> --source <file> --set ${SET} --recipe <id|path>`);
		expect(readTree(vault).size).toBe(before.size);
	}, 60000);

	// Prevents: a set holding two recipe revisions replaying an arbitrary one.
	it('lists every revision when there are two, then runs the one --digest names', async () => {
		const vault = await importFresh('replay-two');
		const [copy] = keptCopies(vault);
		const first = /recipe-(sha256-[0-9a-f]{64})\.json$/.exec(copy)![1];
		// A second revision of the same recipe, run over two of the rows.
		const recipe = JSON.parse(fs.readFileSync(path.join(vault, copy), 'utf8'));
		recipe.target.also_emit.frontmatter.managed.family_label = '{family}';
		const work = tempDir('replay-two-src');
		const recipePath = path.join(work, 'revised.json');
		fs.writeFileSync(recipePath, JSON.stringify(recipe));
		const twoRows = path.join(work, 'nist-mini.csv');
		fs.writeFileSync(twoRows, fs.readFileSync(SOURCE, 'utf8').split('\n').slice(0, 3).join('\n') + '\n');
		const second = captureIo();
		expect(await runCli(['import', '--vault', vault, '--source', twoRows, '--set', SET,
			'--recipe', recipePath, '--deterministic'], second.io)).toBe(0);
		const copies = keptCopies(vault);
		expect(copies).toHaveLength(2);
		const revised = copies.map((p) => /recipe-(sha256-[0-9a-f]{64})\.json$/.exec(p)![1]).find((d) => d !== first)!;

		const refused = await replay(vault, ['--source', SOURCE]);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain('more than one recipe revision');
		expect(refused.err).toContain(first);
		expect(refused.err).toContain(revised);
		expect(refused.err).toContain('--digest');

		const ran = await replay(vault, ['--source', SOURCE, '--digest', revised]);
		expect(ran.err).toBe('');
		expect(ran.code).toBe(0);
		expect(ran.out).toContain(`(revision ${revised.slice(0, 15)})`);
		expect(fs.readFileSync(path.join(vault, DESTINATION, 'AU', 'AU-3.md'), 'utf8')).toContain('family_label: AU');
	}, 90000);

	// Prevents: the help text still telling users replay is not available.
	it('is described in the usage text', async () => {
		const io = captureIo();
		await runCli(['--help'], io.io);
		const usage = [...io.out, ...io.err].join('\n');
		expect(usage).toMatch(/replay +--vault <dir> --set <set id> --source <file>/);
		expect(usage.toLowerCase()).not.toContain('not available');
	});
});
