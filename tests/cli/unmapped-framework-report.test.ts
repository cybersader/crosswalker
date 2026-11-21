import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { createFsApp } from '../../cli/fs-app';
import { loadUnmappedFrameworkReport } from '../../src/views/unmapped-framework-report';
import { assertion, bytes, concept, note, provenance, SOURCE, table, TARGET } from '../helpers/connections-fixture';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unmapped-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
async function run(...args: string[]) {
	const out: string[] = [], err: string[] = [];
	const code = await runCli(['frameworks', '--unmapped', '--vault', root, '--json', ...args], { out: s => out.push(s), err: s => err.push(s) });
	return { code, out: out.join('\n'), err: err.join('\n') };
}
it.each(['notes', 'table'])('counts both directions once and ignores folder links, evidence and same-framework edges (%s)', async form => {
	concept(root, 'Moved/One.md', 'a:1'); concept(root, 'Elsewhere/Two.md', 'a:2');
	concept(root, 'Moved/Three.md', 'b:3', TARGET);
	note(root, 'H.md', { kind: 'hub', curie: 'c:hub', children: ['[[One]]'], _crosswalker: provenance('iset-cccccc') });
	note(root, 'Two-parent.md', { parent: '[[Two]]' }); fs.writeFileSync(path.join(root, 'Diary.md'), 'Ordinary note');
	const edges = [
		{ subject_id: 'a:1', object_id: 'b:3', predicate_id: 'is_equivalent_to' },
		{ subject_id: 'a:1', object_id: 'a:2', predicate_id: 'is_equivalent_to' },
		{ subject_id: 'a:2', object_id: 'b:3', predicate_id: 'no_relationship' },
		{ subject_id: 'b:3', object_id: 'a:2', predicate_id: 'is_equivalent_to', predicate_modifier: 'NOT' as const },
		{ subject_id: 'a:2', object_id: 'other:absent', predicate_id: 'is_equivalent_to' },
	];
	if (form === 'table') table(root, edges); else edges.forEach((e,i) => assertion(root, `Mappings/${i}.md`, `m:${i}`, e));
	note(root, 'Evidence.md', { kind: 'junction-note', curie: 'j:1', subject: 'a:2', predicate: 'has_evidence', object: 'b:3' });
	const before = bytes(root), cli = await run(); expect(cli.err).toBe(''); expect(cli.code).toBe(0);
	const groups = JSON.parse(cli.out);
	expect(groups).toEqual(await loadUnmappedFrameworkReport(createFsApp(root) as never));
	expect(groups).toMatchObject([
		{ framework: 'c', mapped: 0, total: 1, unmapped: [{ id: 'c:hub', kind: 'hub' }] },
		{ framework: 'a', mapped: 1, total: 2, unmapped: [{ id: 'a:2', missingCounterpart: true }] },
		{ framework: 'b', mapped: 1, total: 1, unmapped: [] },
	]);
	expect(JSON.parse((await run('--framework', 'b')).out)).toEqual([groups[2]]);
	expect(bytes(root)).toEqual(before);
});
it('does not classify an unreadable assertion as no mapping', async () => {
	concept(root, 'One.md', 'a:1'); assertion(root, 'Broken.md', 'm:bad', { predicate_id: '' });
	const r = await run(); expect(r.code).toBe(1); expect(r.out).toBe(''); expect(r.err).toContain('Broken.md');
});
it('refuses ambiguous entries rather than attaching a crosswalk to both', async () => {
	concept(root, 'One.md', 'a:1', SOURCE); concept(root, 'Two.md', 'a:1', TARGET);
	const r = await run(); expect(r.code).toBe(1); expect(r.err).toContain('a:1');
});
it('an empty vault has no report groups', async () => { const r = await run(); expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual([]); });
