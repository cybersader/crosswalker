/** Pure parity gate logic. No plugin runtime imports or source execution. */
import ts from 'typescript';
import { STAGES, type Capability } from './capabilities';

export const REGISTRY_PATH = 'tools/parity/capabilities.ts';
export const PAGE_PATH = 'docs/src/content/docs/reference/ui-cli-parity.mdx';
export const START = '{/* parity:generated:start */}';
export const END = '{/* parity:generated:end */}';
export interface Registration { id: string; file: string }
export interface Inventory { commands: Registration[]; verbs: Registration[] }

function source(text: string, file: string): ts.SourceFile {
	const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	// A malformed source must not silently shrink the inventory.
	const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
	if (diagnostics.length) throw new Error(`${file}: cannot inventory invalid TypeScript. Fix its syntax, then run bun run check:parity.`);
	return parsed;
}
function literal(node: ts.Node | undefined): string | undefined {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}

/** Inventory actual addCommand calls, ignoring comments, strings and unrelated ids. */
export function extractCommands(text: string, file: string): Registration[] {
	const result: Registration[] = [];
	walk(source(text, file), (node) => {
		if (!ts.isCallExpression(node)) return;
		const callee = node.expression;
		const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
			: ts.isElementAccessExpression(callee) ? literal(callee.argumentExpression) : undefined;
		if (name !== 'addCommand') return;
		const arg = node.arguments[0];
		const ids = arg && ts.isObjectLiteralExpression(arg)
			? arg.properties.filter((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'id')
			: [];
		const id = ids[0];
		const value = id && ts.isPropertyAssignment(id) ? literal(id.initializer) : undefined;
		if (!value || ids.length !== 1 || (arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))))) {
			throw new Error(`${file}: addCommand must have an inline object with a literal id and no spreads. Expose its id explicitly so check:parity can inventory it.`);
		}
		result.push({ id: value, file });
	});
	return result;
}

/** cli/main.ts delegates to cli/crosswalker.ts; inventory its actual command switch. */
export function extractVerbs(text: string, file: string): Registration[] {
	const result: Registration[] = [];
	let switches = 0;
	walk(source(text, file), (node) => {
		if (!ts.isSwitchStatement(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'command') return;
		switches++;
		for (const clause of node.caseBlock.clauses) {
			if (!ts.isCaseClause(clause)) continue;
			const id = literal(clause.expression);
			if (!id) throw new Error(`${file}: command cases must use literal verbs. Expose the verb so check:parity can inventory it.`);
			result.push({ id, file });
		}
	});
	if (switches !== 1 || !result.length) throw new Error(`${file}: expected one nonempty switch (command). Update tools/parity/check.ts and its extraction tests when CLI dispatch changes.`);
	return result;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Runtime checks also catch malformed registry data supplied without TypeScript. */
export function validateRegistry(entries: readonly Capability[], inventory: Inventory): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const prefix = `${REGISTRY_PATH}: ${entry.id || '(missing id)'}`;
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || seen.has(entry.id)) errors.push(`${prefix}: use a unique kebab-case capability id.`);
		seen.add(entry.id);
		if (!STAGES.includes(entry.stage) || !text(entry.action)) errors.push(`${prefix}: set a lifecycle stage and a plain-language action.`);
		const ui = entry.ui != null && (text(entry.ui.surface) || (Array.isArray(entry.ui.commands) && entry.ui.commands.length > 0 && entry.ui.commands.every(text)));
		const cli = entry.cli != null && text(entry.cli.verb);
		if (entry.ui != null && !ui) errors.push(`${prefix}: add ui.commands or a nonempty ui.surface, or set ui to null and track the gap.`);
		if (entry.ui?.commands !== undefined && (!Array.isArray(entry.ui.commands) || !entry.ui.commands.every(text))) errors.push(`${prefix}: ui.commands must be an array of nonempty command ids.`);
		if (entry.cli != null && !cli) errors.push(`${prefix}: add a nonempty cli.verb, or set cli to null and track the gap.`);
		if (entry.cli?.flags !== undefined && (!Array.isArray(entry.cli.flags) || !entry.cli.flags.every(text))) errors.push(`${prefix}: cli.flags must be an array of nonempty flags.`);
		if (!ui && !cli) errors.push(`${prefix}: add at least one real UI or CLI side; a capability cannot be absent from both.`);
		if (!ui || !cli) {
			const missing = !ui ? 'ui' : 'cli';
			if (!entry.gap || entry.gap.side !== missing || !text(entry.gap.reason) || !text(entry.gap.plan)) {
				errors.push(`${prefix}: add gap.side '${missing}', a nonempty reason and a roadmap plan (or explain why not planned).`);
			}
		} else if (entry.gap) errors.push(`${prefix}: both sides exist; remove the stale gap.`);
	}
	for (const [kind, registrations, registered] of [
		['command id', inventory.commands, entries.flatMap((e) => e.ui?.commands ?? [])],
		['cw verb', inventory.verbs, entries.flatMap((e) => e.cli ? [e.cli.verb] : [])],
	] as const) {
		const actual = new Set(registrations.map((r) => r.id));
		const documented = new Set(registered);
		const discovered = new Set<string>();
		for (const registration of registrations) {
			if (discovered.has(registration.id)) errors.push(`${registration.file}: duplicate ${kind} '${registration.id}'. Remove the duplicate registration.`);
			discovered.add(registration.id);
			if (!documented.has(registration.id)) errors.push(`${registration.file}: ${kind} '${registration.id}' is missing from ${REGISTRY_PATH}. Add a capability entry, then run bun run parity:write.`);
		}
		for (const id of documented) {
			if (!actual.has(id)) errors.push(`${REGISTRY_PATH}: stale ${kind} '${id}' is absent from ${kind === 'cw verb' ? 'cli/crosswalker.ts (entry: cli/main.ts)' : 'src/'}. Remove or correct its registry reference, then run bun run parity:write.`);
		}
	}
	return errors;
}

/** MDX-safe Markdown cells. Never allow source copy to introduce markup or columns. */
function cell(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/\|/g, '&#124;')
		.replace(/`/g, '&#96;').replace(/[\r\n]+/g, ' ');
}
export function renderTable(entries: readonly Capability[]): string {
	const summary = STAGES.map((stage) => `${stage}: ${entries.filter((e) => e.stage === stage).length}`).join('; ');
	const gaps = (side: 'ui' | 'cli') => entries.filter((e) => e.gap?.side === side).length;
	const lines = [
		`${entries.length} capabilities (source: tools/parity/capabilities.ts).`,
		`Stages: ${summary}. Gaps: CLI ${gaps('cli')}; UI ${gaps('ui')} (source: tools/parity/capabilities.ts).`,
		'', '| Stage | Action | UI | cw | Gap and plan |', '| --- | --- | --- | --- | --- |',
	];
	for (const stage of STAGES) {
		for (const entry of entries.filter((e) => e.stage === stage)) {
			const ui = entry.ui ? [entry.ui.surface, ...(entry.ui.commands ?? []).map((id) => `Command: ${id}`)].filter(Boolean).join('; ') : 'Missing';
			const cli = entry.cli ? `cw ${entry.cli.verb}${entry.cli.flags?.length ? ` ${entry.cli.flags.join(' ')}` : ''}` : 'Missing';
			const gap = entry.gap ? `${entry.gap.side.toUpperCase()}: ${entry.gap.reason} Plan: ${entry.gap.plan}` : 'Covered';
			lines.push(`| ${[stage, `${entry.action} (${entry.id})`, ui, cli, gap].map(cell).join(' | ')} |`);
		}
	}
	return lines.join('\n');
}
export function replaceGenerated(page: string, generated: string): string {
	const start = page.indexOf(START);
	const end = page.indexOf(END);
	if (start < 0 || end < start || page.indexOf(START, start + START.length) >= 0 || page.indexOf(END, end + END.length) >= 0) {
		throw new Error(`${PAGE_PATH}: keep exactly one ordered pair of ${START} and ${END} markers, then run bun run parity:write.`);
	}
	return page.slice(0, start + START.length) + `\n\n${generated}\n\n` + page.slice(end);
}
export function checkPage(page: string, entries: readonly Capability[]): string[] {
	try {
		return page === replaceGenerated(page, renderTable(entries)) ? [] : [`${PAGE_PATH}: generated parity table is stale. Run bun run parity:write and commit the updated page.`];
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
