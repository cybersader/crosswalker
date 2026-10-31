import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFsApp } from '../../cli/fs-app';
import { runCli } from '../../cli/crosswalker';
import { loadConnectionsSnapshot, selectConnections } from '../../src/graph/connections-query';
import { fixture, assertion, concept, bytes, table, SOURCE, TARGET } from '../helpers/connections-fixture';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
async function run(root: string, args: string[] = []) {
	const out: string[] = [], err: string[] = [];
	const code = await runCli(['graph', 'connections', '--vault', root, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
	return { code, out: out.join('\n'), err: err.join('\n') };
}
const flags = ['--source-set', SOURCE, '--target-set', TARGET];
describe('cw graph connections read-only parity', () => {
	it('returns the shared canonical model and never creates settings or changes files', async () => {
		const root = fixture(); roots.push(root); assertion(root, 'one.md', 'edge:one', { mapping_provider: 'Recorded provider' });
		const before = bytes(root), result = await run(root, flags);
		expect(result.code).toBe(0); expect(result.err).toBe('');
		const expected = await selectConnections(await loadConnectionsSnapshot(createFsApp(root) as never), { sourceSet: SOURCE, targetSet: TARGET });
		expect(JSON.parse(result.out)).toEqual(JSON.parse(JSON.stringify(expected))); expect(bytes(root)).toEqual(before); expect(fs.existsSync(path.join(root, '.obsidian'))).toBe(false);
	});
	it.each([[], ['--source-set', SOURCE], [...flags, '--apply'], [...flags, '--mode', 'colors'], [...flags, '--limit', '101'], [...flags, '--limit', '0'], [...flags, '--limit', '2.5'], [...flags, '--offset', '-1'], [...flags, '--limit'], [...flags, '--focus-set', SOURCE], ['--source-set', 'unknown', '--target-set', TARGET]])('rejects invalid selection/flags without writes: %j', async (...args) => {
		const root = fixture(); roots.push(root); const before = bytes(root);
		const result = await run(root, args as string[]); expect(result.code).toBe(1); expect(result.err.length).toBeGreaterThan(0); expect(bytes(root)).toEqual(before);
	});
	it('focus requires a set when identity is present in both, then filters the chosen membership', async () => {
		const root = fixture(); roots.push(root); concept(root, 'Second A.md', 'same:A', TARGET); assertion(root, 'one.md', 'edge:one', { subject_note: '[[Renamed/Access]]' });
		expect((await run(root, [...flags, '--focus-curie', 'same:A'])).err).toContain('both selected sets');
		const r = await run(root, [...flags, '--focus-curie', 'same:A', '--focus-set', SOURCE, '--limit', '1', '--offset', '0']);
		expect(r.code).toBe(0); expect(JSON.parse(r.out).rows).toHaveLength(1);
	});
	it('keeps ambiguous short links unresolved and reports structured read failures without writes', async () => {
		const root = fixture(); roots.push(root); concept(root, 'Elsewhere/A.md', 'same:A', SOURCE); concept(root, 'Mappings/A.md', 'same:A', SOURCE);
		assertion(root, 'Mappings/edge.md', 'edge:one', { subject_note: '[[A]]' });
		const before = bytes(root), r = await run(root, flags);
		expect(r.code).toBe(0); expect(JSON.parse(r.out).rows[0].category).toBe('unresolved'); expect(bytes(root)).toEqual(before);
		table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to' }]);
		const corrupt = bytes(root), failure = await run(root, flags);
		expect(failure.code).toBe(1); expect(failure.out).toBe(''); expect(failure.err).toContain('errorDetails'); expect(failure.err).toContain('Finish or roll back'); expect(failure.err).toContain('Moved/mappings.mapping-table.tsv'); expect(bytes(root)).toEqual(corrupt);
	});
	it('does not create a missing vault directory', async () => {
		const root = fixture(); roots.push(root); const missing = path.join(root, 'absent');
		expect((await run(missing, flags)).code).toBe(1); expect(fs.existsSync(missing)).toBe(false);
	});
});
