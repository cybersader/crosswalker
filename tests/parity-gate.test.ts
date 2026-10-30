import { CAPABILITIES, type Capability } from '../tools/parity/capabilities';
import { START, END, checkPage, extractCommands, extractVerbs, renderTable, replaceGenerated, validateRegistry, type Inventory } from '../tools/parity/check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const both: Capability = { id: 'import-data', stage: 'import', action: 'Import data', ui: { commands: ['import-data'] }, cli: { verb: 'import' } };
const inventory: Inventory = { commands: [{ id: 'import-data', file: 'src/main.ts' }], verbs: [{ id: 'import', file: 'cli/crosswalker.ts' }] };
const page = `Before\n${START}\n\n${renderTable([both])}\n\n${END}\nAfter\n`;
const malformed = (patch: Record<string, unknown>): Capability => ({ ...both, ...patch }) as Capability;

describe('parity source inventory', () => {
	it('finds real command calls across whitespace, comments, nested objects, callbacks and quote styles', () => {
		const text = [
			'// this.addCommand({ id: "comment" });',
			'const example = "this.addCommand({ id: \'string\' })";',
			'plugin.addCommand /* comment */ ( { callback: () => ({ id: "nested" }), "id": "one" });',
			'this["addCommand"]( {\nname: "Two",\nid: `two`,\ncallback() { return { id: "inner" }; } });',
			'const unrelated = { id: "other" };',
		].join('\n');
		expect(extractCommands(text, 'src/example.ts').map((r) => r.id)).toEqual(['one', 'two']);
	});
	it.each(['this.addCommand(config);', 'this.addCommand({ id: computed });', 'this.addCommand({ ...base, id: "x" });', 'this.addCommand({ id: `dynamic-${name}` });', 'this.addCommand({ id: "first", id: "second" });', 'this.addCommand({ id: "first", [key]: "second" });'])('fails closed on unresolvable registration %s', (text) => {
		expect(() => extractCommands(text, 'src/example.ts')).toThrow('src/example.ts: addCommand');
	});
	it('fails closed on invalid source', () => {
		expect(() => extractCommands('this.addCommand({', 'src/broken.ts')).toThrow('invalid TypeScript');
	});
	it('finds CLI switch cases, not help strings, comments or an unrelated switch', () => {
		const text = 'const usage = "case fake"; switch (format) { case "csv": break; } switch (command) { /* case "fake": */ case "import": return 0; case `export`: return 0; default: return 1; }';
		expect(extractVerbs(text, 'cli/crosswalker.ts').map((r) => r.id)).toEqual(['import', 'export']);
	});
	it.each(['switch (other) { case "x": break; }', 'switch (command) { default: break; }', 'switch (command) { case dynamic: break; }', 'switch (command) { case "a": break; } switch (command) { case "b": break; }'])('fails closed when CLI dispatch changes: %s', (text) => {
		expect(() => extractVerbs(text, 'cli/crosswalker.ts')).toThrow('cli/crosswalker.ts');
	});
});

describe('parity failure classes', () => {
	it('accepts covered outcomes and multiple outcomes using one verb', () => {
		expect(validateRegistry([both, { ...both, id: 'second-outcome', ui: { surface: 'Wizard' } }], inventory)).toEqual([]);
	});
	it('(a) names the unregistered command, its source and fix', () => {
		const errors = validateRegistry([both], { ...inventory, commands: [...inventory.commands, { id: 'new-command', file: 'src/extra.ts' }] });
		expect(errors.join('\n')).toMatch(/src\/extra.ts: command id 'new-command'.*Add a capability entry/);
	});
	it('(b) names the unregistered CLI verb, its source and fix', () => {
		expect(validateRegistry([both], { ...inventory, verbs: [...inventory.verbs, { id: 'new-verb', file: 'cli/crosswalker.ts' }] }).join('\n')).toMatch(/cw verb 'new-verb'.*Add a capability entry/);
	});
	it('(c) refuses stale command ids and verbs', () => {
		const errors = validateRegistry([both], { commands: [], verbs: [] }).join('\n');
		expect(errors).toContain("stale command id 'import-data'");
		expect(errors).toContain("stale cw verb 'import'");
		expect(errors).toContain('Remove or correct');
	});
	it('(d) requires a gap whenever either side is missing, not just when both are', () => {
		for (const patch of [{ cli: null }, { ui: null }, { ui: null, cli: null }]) {
			expect(validateRegistry([malformed(patch)], { commands: [], verbs: [] }).join('\n')).toContain('nonempty reason');
		}
	});
	it('(d) refuses capabilities absent from both sides even with a gap', () => {
		expect(validateRegistry([malformed({ ui: null, cli: null, gap: { side: 'ui', reason: 'Missing', plan: 'Later' } })], { commands: [], verbs: [] }).join('\n')).toContain('cannot be absent from both');
	});
	it.each([
		{ side: 'cli', reason: '', plan: 'Roadmap' },
		{ side: 'cli', reason: 'Missing', plan: '   ' },
		{ side: 'ui', reason: 'Wrong side', plan: 'Roadmap' },
	])('(d) refuses incomplete or wrong-side gap %p', (gap) => {
		expect(validateRegistry([malformed({ cli: null, gap })], { commands: inventory.commands, verbs: [] }).join('\n')).toContain("gap.side 'cli'");
	});
	it('accepts tracked CLI and UI gaps with concrete reasons and plans', () => {
		const entries: Capability[] = [
			{ ...both, cli: null, gap: { side: 'cli', reason: 'No verb', plan: 'Near-term roadmap' } },
			{ id: 'validate', stage: 'maintain', action: 'Validate', ui: null, cli: { verb: 'import' }, gap: { side: 'ui', reason: 'No UI', plan: 'Not planned: runtime-specific action.' } },
		];
		expect(validateRegistry(entries, inventory)).toEqual([]);
	});
	it('rejects stale gaps, empty surfaces, duplicate ids, invalid ids, stages and actions', () => {
		const entries = [both, malformed({ id: 'import-data', gap: { side: 'ui', reason: 'Old', plan: 'Old' } }), malformed({ id: 'Bad Id', stage: 'unknown', action: '', ui: {} })];
		const errors = validateRegistry(entries, inventory).join('\n');
		expect(errors).toContain('unique kebab-case');
		expect(errors).toContain('lifecycle stage');
		expect(errors).toContain('ui.commands');
		expect(errors).toContain('remove the stale gap');
	});
	it('rejects malformed command and flag arrays even when the surface is named', () => {
		expect(validateRegistry([malformed({ ui: { surface: 'Wizard', commands: [''] }, cli: { verb: 'import', flags: [''] } })], inventory).join('\n')).toContain('ui.commands must be an array');
		expect(validateRegistry([malformed({ cli: { verb: 'import', flags: [''] } })], inventory).join('\n')).toContain('cli.flags must be an array');
	});
	it('rejects duplicate registrations', () => {
		expect(validateRegistry([both], { commands: [...inventory.commands, ...inventory.commands], verbs: inventory.verbs }).join('\n')).toContain('duplicate command id');
	});
	it('(e) detects table drift and gives the regeneration command', () => {
		expect(checkPage(page, [both])).toEqual([]);
		expect(checkPage(page.replace('Import data (', 'Edited ('), [both]).join('\n')).toContain('bun run parity:write');
		expect(checkPage(page, [both, { ...both, id: 'new-outcome' }]).join('\n')).toContain('stale');
	});
});

describe('parity reference generation', () => {
	it('preserves authored prose and is idempotent', () => {
		const updated = replaceGenerated(`Intro\n${START}\nold\n${END}\nTail`, renderTable([both]));
		expect(updated.startsWith('Intro\n')).toBe(true);
		expect(updated.endsWith('\nTail')).toBe(true);
		expect(replaceGenerated(updated, renderTable([both]))).toBe(updated);
	});
	it.each(['no markers', `${END}\n${START}`, `${START}\n${START}\n${END}`, `${START}\n${END}\n${END}`])('rejects absent, reversed or repeated markers', (text) => {
		expect(() => replaceGenerated(text, 'table')).toThrow('exactly one ordered pair');
	});
	it('escapes Markdown columns, MDX expressions, HTML and newlines in registry text', () => {
		const table = renderTable([{ ...both, action: '<tag>{value}|`tick`\nnext' }]);
		expect(table).toContain('&lt;tag&gt;&#123;value&#125;&#124;&#96;tick&#96; next');
	});
	it('generates counts and deterministic lifecycle order from the registry', () => {
		const table = renderTable(CAPABILITIES);
		expect(table).toContain(`${CAPABILITIES.length} capabilities (source: tools/parity/capabilities.ts)`);
		expect(table).toContain('Gaps: CLI');
		expect(table.indexOf('| import |')).toBeLessThan(table.indexOf('| map |'));
		expect(table.indexOf('| share |')).toBeLessThan(table.indexOf('| maintain |'));
	});
	it('keeps the checked-in KB generated region synchronized', () => {
		expect(checkPage(readFileSync(join(__dirname, '..', 'docs/src/content/docs/reference/ui-cli-parity.mdx'), 'utf8'), CAPABILITIES)).toEqual([]);
	});
});
