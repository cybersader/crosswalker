/**
 * local-real-stack.spec.ts: LOCAL-ONLY end-to-end run of "Set up a framework
 * stack" against the owner's real publisher files in the gitignored
 * `Frameworks/` directory.
 *
 * RIGHTS: the source files are licensed (some CC BY-NC-ND). This spec reads
 * them from the local, gitignored directory only. It never writes their
 * content into tracked files. Console output and the metrics JSON carry counts
 * and id SHAPES only (letters -> A/a, digits -> N), never real ids or prose.
 * Screenshots land in the gitignored `test-screenshots/` directory.
 *
 * Opt-in: skips unless LOCAL_REAL_STACK=1, so a full `bun run e2e` does not
 * start a 20-minute import. Also skips when any core file is absent.
 *
 * Bypasses of the real UI, stated plainly:
 *   1. The seed vault's NIST-mini fixtures are deleted first, to emulate an
 *      empty vault (the stack flow is a first-run flow).
 *   2. Files are copied into the vault's `Sources/` folder with node fs rather
 *      than through an OS file picker. This is what a user does when they save
 *      publisher downloads into a vault folder, then use "Choose folder".
 *   3. Buttons are clicked through DOM `click()` inside the modal.
 *   4. Only non-CRI partial matches may use the modal's own "Use anyway" button.
 *   5. Set LOCAL_STACK_SKIP_RERUN=1 to measure only the first import, without
 *      the separate Run again leg. Publisher files are copied unchanged.
 *
 * Run: LOCAL_REAL_STACK=1 bun run e2e:xvfb -- --spec tests/e2e/local-real-stack.spec.ts
 */
import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FW = path.resolve(__dirname, '..', '..', 'Frameworks');
const OUT = path.resolve('test-screenshots');
const CORE = [
	'CRI-Profile-ver.-2.2.2026-04-27.xlsx',
	'sp800-53r5-control-catalog.xlsx',
	'enterprise-attack-v16.1.xlsx',
	'cprt_CSF_2_0_0_06-01-2026.json',
	'nist_800_53-rev5_attack-16.1-enterprise_json.json',
];
const OPTIONAL = [
	'wp-contentuploads202509CRI-Profile-v2.1-to-SP-800-53-Rev-5.1.1.Final_.2025.xlsx',
	'cri_profile-v2.1_attack-16.1-enterprise_json.json',
];
const metrics: Record<string, unknown> = {};
function flush(): void { writeFileSync(path.join(OUT, 'local-real-stack-metrics.json'), JSON.stringify(metrics, null, 2)); }
function log(key: string, value: unknown): void { metrics[key] = value; flush(); console.log(`[local-real-stack] ${key}: ${JSON.stringify(value)}`); }

/** Mask tokens that mix letters and digits (id-like) into their shape. */
const SANITIZE = String.raw`(text) => text.replace(/[A-Za-z0-9][\w.\-()]*/g, (token) =>
	(/[A-Za-z]/.test(token) && /\d/.test(token)) ? token.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, 'N') : token)`;

async function click(label: string): Promise<boolean> {
	return browser.executeObsidian((_obs, target) => {
		const found = Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button'))
			.find((candidate) => candidate.textContent?.trim() === target);
		if (found && !found.disabled) found.click();
		return !!found && !found.disabled;
	}, label);
}
async function mustClick(label: string): Promise<void> {
	if (!(await click(label))) {
		const text = await modalText();
		throw new Error(`Button "${label}" missing or disabled. Modal: ${text.slice(0, 1500)}`);
	}
}
async function modalText(): Promise<string> {
	return browser.executeObsidian((_obs, sanitize) => {
		// eslint-disable-next-line no-new-func
		const fn = new Function(`return ${sanitize}`)() as (t: string) => string;
		return fn(document.querySelector('.crosswalker-stack-modal')?.textContent ?? '');
	}, SANITIZE);
}
async function shot(name: string): Promise<void> {
	await browser.executeObsidian(() => { document.querySelectorAll('.notice-container .notice').forEach((n) => n.remove()); });
	await browser.saveScreenshot(path.join(OUT, `local-real-stack-${name}.png`));
}
async function copyInto(files: string[]): Promise<void> {
	const vault = await obsidianPage.getVaultPath();
	mkdirSync(path.join(vault, 'Sources'), { recursive: true });
	for (const name of files) copyFileSync(path.join(FW, name), path.join(vault, 'Sources', name));
	await browser.waitUntil(async () => browser.executeObsidian(({ app }, names) =>
		names.every((name) => !!app.vault.getAbstractFileByPath(`Sources/${name}`)), files),
	{ timeout: 60_000, timeoutMsg: 'Copied sources never appeared in the vault' });
}
async function cleanSeed(): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		for (const folder of ['Frameworks/NIST-mini', 'Frameworks/E2E-seed-secondary']) {
			const found = app.vault.getAbstractFileByPath(folder);
			if (found) await app.vault.delete(found, true);
		}
	});
}
async function fillFolderAndRecognize(label: string): Promise<void> {
	await browser.executeObsidian(() => {
		const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
		if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
	});
	await mustClick('Choose folder');
	const started = Date.now();
	// Recognition parses multi-MB workbooks; wait until rows settle (no change for 10 s).
	let last = ''; let stableSince = Date.now();
	await browser.waitUntil(async () => {
		const now = await browser.executeObsidian(() => Array.from(document.querySelectorAll('.crosswalker-stack-modal .crosswalker-stack-result'))
			.map((row) => row.textContent ?? '').join('|'));
		if (now !== last) { last = now; stableSince = Date.now(); }
		return now.length > 0 && Date.now() - stableSince > 10_000;
	}, { timeout: 300_000, interval: 2000, timeoutMsg: `${label}: recognition never settled` });
	log(`${label}-recognize-seconds`, Math.round((Date.now() - started) / 1000));
	log(`${label}-recognize-rows`, await browser.executeObsidian((_obs, sanitize) => {
		const fn = new Function(`return ${sanitize}`)() as (t: string) => string;
		return Array.from(document.querySelectorAll('.crosswalker-stack-modal .crosswalker-stack-result')).map((row) => ({
			slot: row.getAttribute('data-slot'), mapping: row.getAttribute('data-mapping'), text: fn(row.textContent ?? ''),
		}));
	}, SANITIZE));
}
/** Accept every "Might match" slot through the UI's own "Use anyway" button (a user choice, logged). */
async function useAnyway(label: string): Promise<void> {
	const accepted: string[] = [];
	for (let i = 0; i < 6; i++) {
		const slot = await browser.executeObsidian(() => {
			const row = Array.from(document.querySelectorAll('.crosswalker-stack-modal .crosswalker-stack-result[data-slot]'))
				.find((item) => (item.textContent ?? '').includes('Might match') && Array.from(item.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Use anyway'));
			if (!row) return null;
			Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Use anyway')!.click();
			return row.getAttribute('data-slot');
		});
		if (!slot) break;
		accepted.push(slot); await browser.pause(500);
	}
	log(`${label}-use-anyway`, accepted);
	if (accepted.length) log(`${label}-rows-after-use-anyway`, await browser.executeObsidian((_obs, sanitize) => {
		const fn = new Function(`return ${sanitize}`)() as (t: string) => string;
		return Array.from(document.querySelectorAll('.crosswalker-stack-modal .crosswalker-stack-result')).map((row) => fn(row.textContent ?? '').slice(0, 200));
	}, SANITIZE));
}
async function assertCriRecognized(label: string): Promise<void> {
	const state = await browser.executeObsidian(() => {
		const row = document.querySelector<HTMLElement>('.crosswalker-stack-modal [data-slot="cri-profile"]');
		return { text: row?.textContent ?? '', useAnyway: Array.from(row?.querySelectorAll('button') ?? [])
			.some((button) => button.textContent?.trim() === 'Use anyway') };
	});
	log(`${label}-cri-recognition`, state);
	expect(state.text).toContain('Recognized');
	expect(state.useAnyway).toBe(false);
}
async function waitForComplete(label: string, timeout = 1_500_000): Promise<void> {
	const started = Date.now();
	let lastReport = 0;
	await browser.waitUntil(async () => {
		const state = await browser.executeObsidian(({ app }) => ({
			h2: document.querySelector('.crosswalker-stack-modal h2')?.textContent ?? '',
			busyRetry: Array.from(document.querySelectorAll('.crosswalker-stack-modal button')).some((b) => b.textContent?.trim() === 'Retry remaining')
				&& /could not be imported|were not started|still indexing|needs its/i.test(document.querySelector('.crosswalker-stack-modal')?.textContent ?? '')
				&& !/Waiting for the vault/i.test(document.querySelector('.crosswalker-stack-modal')?.textContent ?? ''),
			notes: app.vault.getMarkdownFiles().length,
		}));
		if (Date.now() - lastReport > 30_000) { lastReport = Date.now(); console.log(`[local-real-stack] ${label} progress: ${JSON.stringify(state)} after ${Math.round((Date.now() - started) / 1000)} s`); }
		return state.h2 === 'Framework stack imported' || state.busyRetry;
	}, { timeout, interval: 5000, timeoutMsg: `${label}: import did not finish` });
	log(`${label}-import-seconds`, Math.round((Date.now() - started) / 1000));
	log(`${label}-complete-text`, await modalText());
}
async function tapProblems(): Promise<void> {
	await browser.executeObsidian(() => {
		// @ts-expect-error internal plugin registry
		const debug = window.app.plugins.plugins.crosswalker?.debug;
		const w = window as unknown as { __cwProblems?: unknown[]; __cwTapped?: boolean };
		w.__cwProblems = [];
		if (!debug || w.__cwTapped) return;
		w.__cwTapped = true;
		for (const level of ['warn', 'error'] as const) {
			const original = debug[level].bind(debug);
			debug[level] = (category: string, op: string, msg: string, data?: Record<string, unknown>) => {
				w.__cwProblems!.push({ level, category, op, msg, ...(data ?? {}) });
				return original(category, op, msg, data);
			};
		}
	});
}
/** Group warn/error debug entries by (category, op, message shape) so causes are countable without values. */
async function logProblems(label: string): Promise<void> {
	log(`${label}-problems`, await browser.executeObsidian((_obs, sanitize) => {
		const fn = new Function(`return ${sanitize}`)() as (t: string) => string;
		// @ts-expect-error internal plugin registry
		const ring = ((window as unknown as { __cwProblems?: Record<string, unknown>[] }).__cwProblems ?? []);
		const groups: Record<string, { n: number; sample: string }> = {};
		for (const e of ring) {
			if (e.level !== 'warn' && e.level !== 'error') continue;
			const key = `${e.level} ${e.category}/${e.op}: ${fn(String(e.msg)).replace(/[aAN.\-()]{6,}/g, '<id>').slice(0, 160)}`;
			groups[key] ??= { n: 0, sample: fn(JSON.stringify(e)).slice(0, 500) };
			groups[key].n++;
		}
		return { ringSize: ring.length, groups };
	}, SANITIZE));
}
async function assertNoPlaceholderLinks(label: string): Promise<void> {
	const count = await browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles().reduce((n, file) => {
		const cache = app.metadataCache.getFileCache(file);
		const targets = [...Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}),
			...Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {})];
		return n + targets.filter((target) => /^(?:none\.?|n\/?a|-)$/i.test(target.split('/').pop() ?? '')).length
			+ (Array.isArray(cache?.frontmatter?.related_curies)
				? cache.frontmatter.related_curies.filter((value: unknown) => /:none\.?$/i.test(String(value))).length : 0);
	}, 0));
	log(`${label}-placeholder-links`, count);
	expect(count).toBe(0);
}
async function measure(label: string): Promise<void> {
	await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
		const files = app.vault.getMarkdownFiles();
		return files.every((file) => app.metadataCache.getFileCache(file) !== null);
	}), { timeout: 300_000, interval: 3000, timeoutMsg: 'metadata cache never covered every note' });
	await browser.pause(5000);
	const result = await browser.executeObsidian(({ app }) => {
		const shape = (s: string) => s.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, 'N');
		const files = app.vault.getMarkdownFiles();
		const rootOf = (p: string) => p.startsWith('Frameworks/') ? p.split('/').slice(0, 2).join('/')
			: p.startsWith('_crosswalker/mappings/') ? p.split('/').slice(0, 3).join('/') : p.split('/')[0];
		const perRoot: Record<string, { notes: number; depth: Record<number, number>; kinds: Record<string, number> }> = {};
		for (const file of files) {
			const root = rootOf(file.path);
			perRoot[root] ??= { notes: 0, depth: {}, kinds: {} };
			perRoot[root].notes++;
			const depth = file.path.split('/').length - root.split('/').length;
			perRoot[root].depth[depth] = (perRoot[root].depth[depth] ?? 0) + 1;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			const kind = String(fm?._crosswalker?.kind ?? fm?.kind ?? fm?.level ?? fm?._crosswalker?.level ?? '?');
			perRoot[root].kinds[kind.length > 30 ? 'long' : shape(kind)] = (perRoot[root].kinds[kind.length > 30 ? 'long' : shape(kind)] ?? 0) + 1;
		}
		// Basename shapes per framework root (to compare against unresolved endpoint shapes).
		const nameShapes: Record<string, Record<string, number>> = {};
		for (const file of files.filter((f) => f.path.startsWith('Frameworks/'))) {
			const root = rootOf(file.path);
			nameShapes[root] ??= {};
			const s = shape(file.basename);
			nameShapes[root][s] = (nameShapes[root][s] ?? 0) + 1;
		}
		const top = (m: Record<string, number>, n = 8) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));
		const mappings: Record<string, unknown> = {};
		for (const [root, info] of Object.entries(perRoot)) {
			if (!root.startsWith('_crosswalker/mappings/')) continue;
			const edges = files.filter((f) => rootOf(f.path) === root);
			const buckets = { both: 0, one: 0, neither: 0 };
			const pairs: Record<string, number> = {};
			const unresolved: Record<string, number> = {};
			const unresolvedFolderQualified: Record<string, number> = {};
			for (const edge of edges) {
				const resolved = Object.keys(app.metadataCache.resolvedLinks[edge.path] ?? {});
				const endpoints = resolved.filter((t) => t.startsWith('Frameworks/'));
				if (endpoints.length >= 2) buckets.both++; else if (endpoints.length === 1) buckets.one++; else buckets.neither++;
				const pair = endpoints.map(rootOf).join(' -> ') || '(none)';
				pairs[pair] = (pairs[pair] ?? 0) + 1;
				for (const target of Object.keys(app.metadataCache.unresolvedLinks[edge.path] ?? {})) {
					const leaf = target.split('/').pop() ?? target;
					unresolved[shape(leaf)] = (unresolved[shape(leaf)] ?? 0) + 1;
					const folder = target.includes('/') ? target.split('/').slice(0, 2).join('/') : '(bare)';
					unresolvedFolderQualified[folder] = (unresolvedFolderQualified[folder] ?? 0) + 1;
				}
			}
			mappings[root] = { edges: info.notes, ...buckets, resolvedRootPairs: top(pairs), unresolvedShapes: top(unresolved), unresolvedPrefix: top(unresolvedFolderQualified) };
		}
		// Framework-note outgoing links (crosswalk columns rendered in-note).
		const frameworkLinks: Record<string, unknown> = {};
		for (const root of Object.keys(perRoot).filter((r) => r.startsWith('Frameworks/'))) {
			const targets: Record<string, number> = {}; const unresolved: Record<string, number> = {}; let unresolvedTotal = 0;
			for (const file of files.filter((f) => rootOf(f.path) === root)) {
				for (const [target, n] of Object.entries(app.metadataCache.resolvedLinks[file.path] ?? {})) {
					const r = target.startsWith('_crosswalker/') ? '_crosswalker' : rootOf(target);
					if (r !== root) targets[r] = (targets[r] ?? 0) + (n as number);
				}
				for (const target of Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {})) {
					unresolvedTotal++; const s = shape(target.split('/').pop() ?? target); unresolved[s] = (unresolved[s] ?? 0) + 1;
				}
			}
			frameworkLinks[root] = { crossRootResolvedLinks: targets, unresolvedTotal, unresolvedShapes: top(unresolved, 6) };
		}
		// Spot-check: 5 evenly spaced edges per mapping set; does each resolved endpoint land on a leaf-ish note with a curie?
		const spot: Record<string, unknown[]> = {};
		for (const root of Object.keys(mappings)) {
			const edges = files.filter((f) => rootOf(f.path) === root);
			spot[root] = [0, 0.25, 0.5, 0.75, 0.99].map((f) => edges[Math.floor(f * (edges.length - 1))]).filter(Boolean).map((edge) => {
				const fm = app.metadataCache.getFileCache(edge)?.frontmatter ?? {};
				return {
					predicate: fm.predicate_id ?? fm.predicate ?? null,
					fmShape: Object.fromEntries(Object.entries(fm).filter(([k]) => /subject|object|note|link|source|target/i.test(k))
						.map(([k, v]) => [k, shape(JSON.stringify(v)).slice(0, 120)])),
					unresolvedTargets: Object.keys(app.metadataCache.unresolvedLinks[edge.path] ?? {}).map((t) => shape(t).slice(0, 120)),
					endpoints: Object.keys(app.metadataCache.resolvedLinks[edge.path] ?? {}).map((t) => {
						const target = app.vault.getAbstractFileByPath(t);
						const tfm = target && 'extension' in target ? app.metadataCache.getFileCache(target as never)?.frontmatter : null;
						const curie = String(tfm?.curie ?? '');
						return { root: rootOf(t), depth: t.split('/').length - 2, curiePrefix: curie.split(':')[0] || null, curieShape: shape(curie.split(':')[1] ?? ''), nameShape: shape(t.split('/').pop()!.replace(/\.md$/, '')) };
					}),
				};
			});
		}
		const topNameShapes = Object.fromEntries(Object.entries(nameShapes).map(([r, m]) => [r, top(m, 8)]));
		return { totalNotes: files.length, perRoot, mappings, frameworkLinks, spot, topNameShapes };
	});
	log(`${label}-measure`, result);
}

const haveCore = CORE.every((name) => existsSync(path.join(FW, name)));

describe('LOCAL real framework stack (gitignored publisher files)', function () {
	this.timeout(2_400_000);
	before(function () {
		if (process.env.LOCAL_REAL_STACK !== '1') { console.log('[local-real-stack] set LOCAL_REAL_STACK=1 to run; skipping'); this.skip(); }
		if (!haveCore) { console.log('[local-real-stack] core files absent; skipping'); this.skip(); }
		mkdirSync(OUT, { recursive: true });
	});

	it('default stack: import, measure, then Run again skips everything', async () => {
		await cleanSeed();
		await copyInto(CORE);
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		log('default-picker-state', await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLInputElement>('.crosswalker-stack-modal input[type="checkbox"]'))
			.map((box) => ({ ontology: box.dataset.ontology ?? null, mapping: box.dataset.mapping ?? null, checked: box.checked, disabled: box.disabled }))));
		await shot('01-picker');
		await mustClick('Next: download checklist');
		await shot('02-checklist');
		log('default-checklist-text', await modalText());
		await mustClick('Next: add the files');
		await fillFolderAndRecognize('default');
		await shot('03-recognize');
		await assertCriRecognized('default');
		await useAnyway('default');
		await shot('03b-recognize-accepted');
		await mustClick('Next: review');
		await shot('04-review');
		log('default-review-text', await modalText());
		await tapProblems();
		await mustClick('Import stack');
		try {
			await waitForComplete('default');
		} finally {
			await shot('05-complete');
			log('default-debug-ring', await browser.executeObsidian((_obs, sanitize) => {
				const fn = new Function(`return ${sanitize}`)() as (t: string) => string;
				// @ts-expect-error internal plugin registry
				const ring = window.app.plugins.plugins.crosswalker?.debug?.getRingBuffer?.() ?? [];
				return ring.slice(-15).map((entry: unknown) => fn(JSON.stringify(entry)).slice(0, 400));
			}, SANITIZE));
			await logProblems('default');
		}
		await measure('default');
		await assertNoPlaceholderLinks('default');
		const criCsf = await browser.executeObsidian(({ app }) => {
			const edges = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/'));
			return { total: edges.length, both: edges.filter((f) => {
				const fm = app.metadataCache.getFileCache(f)?.frontmatter;
				return Boolean(fm?.subject_note && fm?.object_note);
			}).length };
		});
		log('default-cri-csf-links', criCsf);
		expect(criCsf).toEqual({ total: 433, both: 433 });
		const before = await browser.executeObsidian(({ app }) => {
			const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('Frameworks/') || f.path.startsWith('_crosswalker/'));
			return { count: files.length, mtimeMax: Math.max(...files.map((f) => f.stat.mtime)), sizeSum: files.reduce((s, f) => s + f.stat.size, 0) };
		});
		log('default-before-rerun', before);
		if (process.env.LOCAL_STACK_SKIP_RERUN === '1') {
			await mustClick('Done');
			return;
		}
		if (!(await click('Done'))) {
			log('default-blocked', 'Done absent after import; closing modal and continuing to Run again');
			await browser.executeObsidian(() => {
				document.querySelector<HTMLElement>('.crosswalker-stack-modal')?.closest('.modal')?.querySelector<HTMLElement>('.modal-close-button')?.click();
			});
			await browser.pause(1000);
		}
		// A stale first modal left in the DOM makes every later query read the wrong modal.
		if (await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal').length) > 0) {
			await browser.keys('Escape');
			await browser.pause(1000);
		}
		const stale = await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal').length);
		log('default-modal-left-open', stale);
		if (stale > 0) throw new Error('First stack modal would not close; Run again measurement would read the stale modal');
		try {
			await browser.executeObsidian(({ app }) => {
				// @ts-expect-error internal command registry
				app.commands.executeCommandById('graph:open');
			});
			await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 20_000 });
			await browser.pause(15_000);
			await shot('06-graph');
		} catch (error) { log('graph-error', String(error).slice(0, 200)); }

		// Run again from the installed-stacks panel.
		await browser.executeObsidian(async ({ app }) => {
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
			const leaf = app.workspace.getLeaf(true);
			await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
			await app.workspace.revealLeaf(leaf);
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.crosswalker-installed-stacks button')).some((b) => b.textContent === 'Run again')),
		{ timeout: 30_000, timeoutMsg: 'Run again button never appeared' });
		await shot('07-installed');
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-installed-stacks button')).find((b) => b.textContent === 'Run again')?.click();
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await fillFolderAndRecognize('rerun');
		await shot('07b-rerun-recognize');
		await assertCriRecognized('rerun');
		await mustClick('Next: review');
		const choices = await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLSelectElement>('.crosswalker-stack-modal select')).map((sel) => ({
			row: sel.closest('[data-slot],[data-mapping]')?.getAttribute('data-slot') ?? sel.closest('[data-mapping]')?.getAttribute('data-mapping') ?? '?',
			selected: sel.selectedOptions[0]?.textContent?.trim() ?? null,
		})));
		log('rerun-review-choices', choices);
		expect(choices.length).toBeGreaterThanOrEqual(6);
		expect(choices.every((choice) => choice.selected?.toLowerCase().includes('skip'))).toBe(true);
		log('rerun-review-text', await modalText());
		expect(await modalText()).not.toContain('(new 2)');
		await shot('08-rerun-review');
		await tapProblems();
		await mustClick('Import stack');
		try { await waitForComplete('rerun', 120_000); } finally { await shot('09-rerun-complete'); await logProblems('rerun'); }
		const after = await browser.executeObsidian(({ app }) => {
			const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('Frameworks/') || f.path.startsWith('_crosswalker/'));
			return { count: files.length, mtimeMax: Math.max(...files.map((f) => f.stat.mtime)), sizeSum: files.reduce((s, f) => s + f.stat.size, 0) };
		});
		log('rerun-after', { ...after, writesDetected: after.mtimeMax !== before.mtimeMax || after.count !== before.count || after.sizeSum !== before.sizeSum });
		expect(after).toEqual(before);
		log('rerun-written-by-folder', await browser.executeObsidian(({ app }, since) => {
			const byFolder: Record<string, number> = {};
			for (const f of app.vault.getFiles()) {
				if (f.stat.mtime <= since) continue;
				const key = f.path.split('/').slice(0, 3).join('/').replace(/[0-9a-f]{8,}/gi, '<id>');
				byFolder[key] = (byFolder[key] ?? 0) + 1;
			}
			return byFolder;
		}, before.mtimeMax));
		await click('Done');
		// Local opt-in profiles an explicitly selected refresh of an existing,
		// populated mapping set. The ordinary Run again assertion stays all-skip.
		if (process.env.LOCAL_STACK_PROFILE_REFRESH === '1') {
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-installed-stacks button'))
					.find((button) => button.textContent === 'Run again')?.click();
			});
			await $('.crosswalker-stack-modal').waitForDisplayed();
			await fillFolderAndRecognize('refresh-profile');
			await mustClick('Next: review');
			const offered = await browser.executeObsidian(() => {
				const selector = document.querySelector<HTMLSelectElement>('.crosswalker-stack-modal [data-mapping="csf-80053"] select');
				if (!selector || !Array.from(selector.options).some((option) => option.value === 'refresh')) return false;
				selector.value = 'refresh'; selector.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			});
			log('refresh-profile-offered', offered);
			if (!offered) throw new Error('Explicit mapping refresh was unavailable');
			await mustClick('Import stack');
			await waitForComplete('refresh-profile', 300_000);
			await shot('09b-refresh-profile-complete');
			await click('Done');
		}
	});

	it('optional CRI mappings ticked: recognition and import', async () => {
		const present = OPTIONAL.filter((name) => existsSync(path.join(FW, name)));
		await browser.reloadObsidian({ vault: 'tests/e2e/seed-vault' });
		await cleanSeed();
		await copyInto([...CORE, ...present]);
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			for (const id of ['cri-80053', 'cri-attack']) {
				const box = document.querySelector<HTMLInputElement>(`.crosswalker-stack-modal input[data-mapping="${id}"]`);
				if (box && !box.checked) box.click();
			}
		});
		await shot('10-optional-picker');
		await mustClick('Next: download checklist');
		log('optional-checklist-text', await modalText());
		await shot('11-optional-checklist');
		await mustClick('Next: add the files');
		await fillFolderAndRecognize('optional');
		await shot('12-optional-recognize');
		await assertCriRecognized('optional');
		await useAnyway('optional');
		await mustClick('Next: review');
		log('optional-review-text', await modalText());
		await shot('13-optional-review');
		await tapProblems();
		await mustClick('Import stack');
		try { await waitForComplete('optional'); } finally { await shot('14-optional-complete'); await logProblems('optional'); }
		await measure('optional');
		await assertNoPlaceholderLinks('optional');
		const direct = await browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles()
			.filter((file) => file.path.startsWith('_crosswalker/mappings/cri-profile-to-nist-800-53/')).length);
		log('optional-cri-80053-notes', direct);
		expect(direct).toBeGreaterThan(900);
		expect(direct).toBeLessThan(1100);
	});
});
