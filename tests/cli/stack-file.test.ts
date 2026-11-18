import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { loadStackFile, validateStackFile, type StackFile } from '../../tools/lib/stack-file';
import { REPO, captureIo, tempDir } from './helpers';

const SOURCE = 'tools/fixtures/synthetic/nist-mini.csv';
const miniStack: StackFile = {
	stack: 'v0', id: 'test-stack', label: 'Test stack', description: 'Synthetic controls and a saved query.',
	public: true, requires: [SOURCE],
	steps: [
		{ kind: 'import', id: 'controls', label: 'Controls', source: SOURCE, role: 'framework', destination: 'Frameworks/NIST-mini' },
		{ kind: 'note', id: 'intro', path: 'Start.md', frontmatter: { title: 'Testing', kind: 'evidence-document' }, body: 'Synthetic example.' },
		{ kind: 'query', id: 'query', path: 'Queries/Hierarchy.base', template: 'skos-hierarchy-narrower', params: { framework_set: '{set:controls}' } },
	],
};

describe('stack file validation', () => {
	it('accepts the public demo declaration and its earlier set references', () => {
		const stack = loadStackFile(path.join(REPO, 'stacks/public-grc-demo.stack.json'));
		expect(stack).toMatchObject({ stack: 'v0', public: true, guard: { emptyOrMarker: 'Start here.md' } });
		expect(stack.steps.at(-1)).toMatchObject({ kind: 'graph', path: '.obsidian/graph.json' });
	});

	it('rejects an unknown step kind', () => {
		expect(() => validateStackFile({ ...miniStack, steps: [{ kind: 'shell', id: 'bad' }] }))
			.toThrow(/Unknown step kind at \/steps\/0\/kind\. Choose one of: import, derived-mappings/);
	});

	it('rejects unknown fields in a known kind', () => {
		expect(() => validateStackFile({ ...miniStack, steps: [{ ...miniStack.steps[0], misspelled: true }] }))
			.toThrow(/Unexpected field "misspelled".*Remove it or check the spelling/);
	});

	it('rejects duplicate step ids', () => {
		expect(() => validateStackFile({ ...miniStack, steps: [...miniStack.steps, miniStack.steps[0]] }))
			.toThrow('Duplicate step id "controls". Give every step a different id and update any references.');
	});

	it('rejects a forward set reference', () => {
		expect(() => validateStackFile({ ...miniStack, steps: [...miniStack.steps].reverse() }))
			.toThrow(/references "controls" but it is not an earlier import or derived mapping step\. Correct the id/);
	});

	it('rejects an unknown mapping reader and names the available readers', () => {
		const step = { kind: 'derived-mappings', id: 'mapping', reader: 'custom', label: 'Mapping', destination: 'Links',
			provider: 'Example', from: 'a', to: 'b', release: 'v1', inputs: { table: SOURCE } };
		expect(() => validateStackFile({ ...miniStack, steps: [step] }))
			.toThrow(/Unknown mapping reader.*Choose one of: ctid-json, d3fend-controls, d3fend-attack-mitigations, olir-workbook/);
	});

	it('rejects restricted source paths in public stacks, including inputs omitted from requires', () => {
		const steps = [{ ...miniStack.steps[0], source: 'Frameworks/_licensed/controls.csv' }];
		expect(() => validateStackFile({ ...miniStack, steps }))
			.toThrow(/Refusing Frameworks\/_licensed\/controls.csv:.*Choose a public source or use a private stack/);
		expect(() => validateStackFile({ ...miniStack, steps, public: false })).not.toThrow();
	});

	it('rejects output traversal and restricted folders before a build', () => {
		const note = miniStack.steps[1];
		expect(() => validateStackFile({ ...miniStack, steps: [{ ...note, path: '../outside.md' }] }))
			.toThrow(/Invalid stack path.*Use a relative path/);
		expect(() => validateStackFile({ ...miniStack, steps: [{ ...note, path: '_licensed/inside.md' }] }))
			.toThrow(/folder named "_licensed".*Remove its source/);
	});
});

describe('cw stack build', () => {
	let temp: string;
	let file: string;
	let vault: string;

	beforeEach(() => {
		temp = tempDir('stack-file');
		file = path.join(temp, 'test.stack.json');
		vault = path.join(temp, 'vault');
	});
	afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

	const args = () => ['stack', 'build', '--file', file, '--vault', vault];

	it('checks required sources before touching a new or previous output vault', async () => {
		const missing = 'Frameworks/no-such-test-source.csv';
		fs.writeFileSync(file, JSON.stringify({ ...miniStack, requires: [missing], guard: { emptyOrMarker: 'Start.md' } }));
		const first = captureIo();
		expect(await runCli(args(), first.io)).toBe(1);
		expect(first.err.join('\n')).toMatch(/Missing fixture Frameworks\/no-such-test-source.csv\. Use --sources-dir/);
		expect(first.out).toEqual([]);
		expect(fs.existsSync(vault)).toBe(false);
		fs.mkdirSync(vault);
		const marker = path.join(vault, 'Start.md');
		fs.writeFileSync(marker, 'Keep me.');
		expect(await runCli(args(), captureIo().io)).toBe(1);
		expect(fs.readFileSync(marker, 'utf8')).toBe('Keep me.');
	});

	it('rejects a public source that points to a restricted file through a symlink', async () => {
		const sources = path.join(temp, 'sources');
		fs.mkdirSync(path.join(sources, 'Frameworks/_licensed'), { recursive: true });
		fs.writeFileSync(path.join(sources, 'Frameworks/_licensed/example.csv'), 'id,title\n1,Synthetic\n');
		fs.symlinkSync('_licensed/example.csv', path.join(sources, 'Frameworks/example.csv'));
		fs.writeFileSync(file, JSON.stringify({ ...miniStack, requires: ['Frameworks/example.csv'] }));
		const { io, err } = captureIo();
		expect(await runCli([...args(), '--sources-dir', sources], io)).toBe(1);
		expect(err.join('\n')).toMatch(/_licensed\/example.csv:.*Choose a public source/);
		expect(fs.existsSync(vault)).toBe(false);
	});

	it('does not replace an unrelated nonempty vault or an input directory', async () => {
		fs.writeFileSync(file, JSON.stringify(miniStack));
		fs.mkdirSync(vault);
		const note = path.join(vault, 'My notes.md');
		fs.writeFileSync(note, 'Keep me.');
		const existing = captureIo();
		expect(await runCli(args(), existing.io)).toBe(1);
		expect(existing.err.join('\n')).toMatch(/is not empty\. A stack build never changes or clears an existing folder\. Pick an empty or new folder/);
		const parent = captureIo();
		expect(await runCli(['stack', 'build', '--file', file, '--vault', temp], parent.io)).toBe(1);
		expect(parent.err.join('\n')).toMatch(/must not contain the inputs\. Choose a separate empty folder/);
		expect(fs.readFileSync(note, 'utf8')).toBe('Keep me.');
	});

	it('never clears a folder that holds the stack marker note', async () => {
		const guarded = { ...miniStack, guard: { emptyOrMarker: 'Start here.md' }, steps: [...miniStack.steps, { kind: 'note', id: 'marker', path: 'Start here.md', frontmatter: { title: 'Start here' }, body: 'Marker.' }] };
		fs.writeFileSync(file, JSON.stringify(guarded));
		fs.mkdirSync(vault);
		fs.writeFileSync(path.join(vault, 'Start here.md'), 'My own start page.');
		fs.writeFileSync(path.join(vault, 'Diary.md'), 'Keep me.');
		const run = captureIo();
		expect(await runCli(args(), run.io)).toBe(1);
		expect(run.err.join('\n')).toMatch(/never changes or clears an existing folder/);
		expect(fs.readFileSync(path.join(vault, 'Diary.md'), 'utf8')).toBe('Keep me.');
	});

	it('builds a synthetic import, note and query and validates the result through the CLI', () => {
		fs.writeFileSync(file, JSON.stringify(miniStack));
		// Running from outside the repo proves paths inside the stack are repo-relative.
		const entry = ['--preload', path.join(REPO, 'cli/preload.ts'), path.join(REPO, 'cli/main.ts')];
		const build = spawnSync('bun', [...entry, ...args()], { cwd: temp, encoding: 'utf8' });
		expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
		expect(build.stdout).toContain('Set ids: controls=iset-a0f1e2');
		expect(build.stdout).toContain('all valid');
		expect(fs.readFileSync(path.join(vault, 'Start.md'), 'utf8')).toBe('---\ntitle: Testing\nkind: evidence-document\n---\n\nSynthetic example.\n');
		expect(fs.readFileSync(path.join(vault, 'Queries/Hierarchy.base'), 'utf8')).toContain('iset-a0f1e2');
		const validate = spawnSync('bun', [...entry, 'validate', '--vault', vault], { cwd: temp, encoding: 'utf8' });
		expect(validate.status).toBe(0);
		expect(validate.stdout).toMatch(/Checked [1-9]\d* Crosswalker notes .*all valid/);
	});
});
