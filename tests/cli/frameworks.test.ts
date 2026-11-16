import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { frameworksSummaryText } from '../../src/views/workspace-view-helpers';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function note(root: string, rel: string, frontmatter: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), `---\n${frontmatter}\n---\nBody\n`);
}
const STAMP = '_crosswalker:\n  producer:\n    kind: cw-test';

function vault(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-frameworks-'));
	roots.push(root);
	note(root, 'Frameworks/Alpha/A1.md', `curie: alpha:1\ntitle: One\n${STAMP}`);
	note(root, 'Frameworks/Alpha/A2.md', `curie: alpha:2\nparent_curie: alpha:1\nparent: "[[A1]]"\n${STAMP}`);
	note(root, 'Frameworks/Beta/B1.md', `curie: beta:1\n${STAMP}`);
	note(root, '_crosswalker/edge.md', 'kind: crosswalk-edge\nsubject_id: alpha:1\nobject_id: beta:1');
	return root;
}
function tree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) walk(abs); else out[path.relative(root, abs)] = fs.readFileSync(abs, 'utf8');
	});
	walk(root);
	return out;
}
async function run(args: string[]) {
	const out: string[] = [], err: string[] = [];
	const code = await runCli(['frameworks', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
	return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cw frameworks', () => {
	it('prints the same summary as the copy button and writes nothing', async () => {
		const root = vault(), before = tree(root);
		const json = await run(['--vault', root, '--json']);
		expect(json.code).toBe(0);
		const frameworks = JSON.parse(json.out);
		expect(frameworks.map((f: { id: string }) => f.id)).toEqual(['alpha', 'beta']);
		const alpha = frameworks.find((f: { id: string }) => f.id === 'alpha');
		expect(alpha).toMatchObject({ noteCount: 2, notesWithParent: 1, crosswalkCount: 1 });
		const text = await run(['--vault', root]);
		expect(text.code).toBe(0);
		expect(text.out).toBe(frameworksSummaryText(frameworks));
		expect(tree(root)).toEqual(before);
	});
	it('summarizes one framework by id prefix', async () => {
		const root = vault();
		const one = await run(['--vault', root, '--framework', 'beta']);
		expect(one.code).toBe(0);
		expect(one.out).toContain('Framework: beta');
		expect(one.out).not.toContain('alpha');
	});
	it.each([[['--framework', 'gamma'], 'Known prefixes: alpha, beta'], [['--apply'], 'Unknown option --apply'], [['--json', 'yes'], '--json takes no value']])('rejects %j with a next step', async (args, message) => {
		const root = vault(), before = tree(root);
		const r = await run(['--vault', root, ...args]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(message);
		expect(tree(root)).toEqual(before);
	});
});
