/**
 * Re-importing into an existing set (2026-10-28 regressions).
 *
 * Pins two behaviours of a refresh (`cw import --set <id>`):
 *   1. Frontmatter key order is preserved. User-owned keys stay where the
 *      user put them; managed keys update in place. Before the fix, the
 *      merge emitted user keys first, so every refresh moved them to the top
 *      and rewrote the note.
 *   2. A note that existed before the run is never reported as created.
 *      Rewritten notes count as updated, untouched notes as up to date.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, tempDir } from './helpers';

installByteFile();

const SOURCE = ['--source', path.join(REPO, 'tools/fixtures/synthetic/nist-mini.csv'), '--ontology', 'nist-mini', '--destination', 'Frameworks/NIST-mini'];

function listNotes(dir: string): string[] {
	const files: string[] = [];
	const walk = (d: string): void => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (f.endsWith('.md')) files.push(f);
		}
	};
	walk(dir);
	return files.sort();
}

/** Top-level frontmatter keys in file order. */
function topLevelKeys(text: string): string[] {
	const fm = text.split('\n---\n')[0];
	return fm.split('\n').slice(1).map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter((k): k is string => !!k);
}

describe('re-import into an existing set', () => {
	it('keeps user keys in place and reports rewritten notes as updated, never created', async () => {
		const vault = tempDir('reimport-user-fields');
		const first = captureIo();
		expect(await runCli(['import', '--vault', vault, ...SOURCE, '--deterministic'], first.io)).toBe(0);
		const firstOut = first.out.join('\n');
		const setId = /Set id: (iset-[a-z0-9]+)\./.exec(firstOut)![1];
		const created = Number(/(\d+) created/.exec(firstOut)![1]);
		expect(created).toBeGreaterThan(0);
		expect(firstOut).toContain('0 updated');

		const notes = listNotes(path.join(vault, 'Frameworks/NIST-mini'));
		expect(notes.length).toBe(created);
		const target = notes.find((f) => /\bname: Automated System Account Management$/m.test(fs.readFileSync(f, 'utf8')))!;
		expect(target).toBeDefined();

		// User edits: a key in the middle, two at the bottom, and a stale managed value.
		const original = fs.readFileSync(target, 'utf8');
		const edited = original
			.replace('\nfamily: AC\n', '\nfamily: AC\nreviewer: bob\n')
			.replace('\nname: Automated System Account Management\n', '\nname: Stale name\n')
			.replace(/\n---\n/, '\nowner: alice\nreview_note: checked\n---\n');
		fs.writeFileSync(target, edited);
		const keysBefore = topLevelKeys(edited);
		expect(keysBefore.indexOf('reviewer')).toBe(keysBefore.indexOf('family') + 1);
		expect(keysBefore.slice(-2)).toEqual(['owner', 'review_note']);

		const second = captureIo();
		expect(await runCli(['import', '--vault', vault, ...SOURCE, '--set', setId, '--deterministic'], second.io)).toBe(0);
		const secondOut = second.out.join('\n');
		expect(secondOut).toContain('0 created, 1 updated');
		expect(listNotes(path.join(vault, 'Frameworks/NIST-mini')).length).toBe(created);

		const after = fs.readFileSync(target, 'utf8');
		expect(after).toContain('\nname: Automated System Account Management\n');
		expect(after).not.toContain('Stale name');
		expect(topLevelKeys(after)).toEqual(keysBefore);
		expect(after).toContain('\nreviewer: bob\n');
		expect(after).toContain('\nowner: alice\nreview_note: checked\n---\n');

		// A further refresh with nothing changed writes nothing.
		const third = captureIo();
		expect(await runCli(['import', '--vault', vault, ...SOURCE, '--set', setId, '--deterministic'], third.io)).toBe(0);
		expect(third.out.join('\n')).toContain('0 created, 0 updated');
		expect(fs.readFileSync(target, 'utf8')).toBe(after);
	}, 60000);
});
