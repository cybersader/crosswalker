/**
 * managed-regions-destructive.spec.ts — the DESTRUCTIVE half of the Ch 45 §4.2 gate.
 *
 * `replace-preservation.spec.ts` proves the happy path: prose below the region
 * survives a re-import. That is necessary and not sufficient. The failure mode
 * this slice exists to prevent is SILENT DATA LOSS in someone's compliance vault,
 * and every one of those losses happens on a path the happy-path test never walks:
 *
 *   S2  prose typed INSIDE the region — must be replaced. That is the contract, and
 *       it is asserted deliberately so nobody later "fixes" it into a merge guess.
 *   S3  a legacy note (no markers) a human EDITED — must be left byte-identical and
 *       reported as a conflict. A bug here destroys real work.
 *   S3b a legacy note nobody edited — must ADOPT, so the refusal in S3 is a
 *       measurement and not a blanket "legacy notes are never touched".
 *   S4  corrupt markers (missing end / duplicated start / moved end) — the file must
 *       not be rewritten at all, and the run must continue past it.
 *
 * All of it against REAL files in REAL Obsidian, through `runImportFromRecipe`,
 * the same entry point the recipe path ships.
 *
 * Run: `DISPLAY=:0 bun run e2e -- --spec tests/e2e/managed-regions-destructive.spec.ts`
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { resetTier2Sidecar } from './helpers/vault-readiness';

const OUT_DIR = path.resolve('test-screenshots');
const BASE = 'Frameworks/Managed-Regions-Destructive';

const START = '<!-- crosswalker:body:start v=1 -->';
const END = '<!-- crosswalker:body:end -->';

/**
 * One row per scenario, so a single import produces every note under test and the
 * "the run continues past a conflict" claim is proved by the surviving rows.
 */
const ROWS = [
	{ id: 'S2-inside', name: 'Prose inside the region', prose: 'Managed sentence.' },
	{ id: 'S3-edited-legacy', name: 'Edited legacy note', prose: 'Managed sentence.' },
	{ id: 'S3B-clean-legacy', name: 'Untouched legacy note', prose: 'Managed sentence.' },
	{ id: 'S3C-stale-legacy', name: 'Stale legacy note', prose: 'Managed sentence.' },
	{ id: 'S4A-unclosed', name: 'Missing end marker', prose: 'Managed sentence.' },
	{ id: 'S4B-duplicate', name: 'Duplicated start marker', prose: 'Managed sentence.' },
	{ id: 'S4C-inverted', name: 'Moved end marker', prose: 'Managed sentence.' },
	{ id: 'S5-control', name: 'Untouched control note', prose: 'Managed sentence.' },
];

function recipe(revision: string) {
	return {
		recipe: 'managed-regions-destructive',
		source: { ontology: 'mrd', levels: ['leaf'] },
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
			also_emit: {
				frontmatter: { managed: { title: '{name}' } },
				body: [{ template: `{prose} ${revision}`, position: 'append', format: 'text' }],
			},
		},
	};
}

interface Outcome {
	firstErrors: unknown[];
	secondErrors: unknown[];
	conflicts: Array<{ path: string; code: string; detail: string }>;
	before: Record<string, string>;
	after: Record<string, string>;
	notesWritten: number;
}

describe('Managed body regions — the destructive scenarios', function () {
	this.timeout(180_000);

	let out: Outcome;

	before(() => {
		mkdirSync(OUT_DIR, { recursive: true });
	});

	it('imports, damages six notes in six different ways, and re-imports', async () => {
		out = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			// @ts-expect-error — internal API
			const plugin = app.plugins.plugins['crosswalker'];
			const { base, rows, recipeV1, recipeV2, start, end } = args;

			const pathOf = (id: string) => `${base}/${id}.md`;
			const read = async (id: string): Promise<string> => {
				const file = app.vault.getAbstractFileByPath(pathOf(id));
				if (!file) throw new Error(`missing note ${pathOf(id)}`);
				// @ts-expect-error — TFile at runtime
				return app.vault.read(file);
			};
			const write = async (id: string, text: string): Promise<void> => {
				const file = app.vault.getAbstractFileByPath(pathOf(id));
				// @ts-expect-error — TFile at runtime
				await app.vault.modify(file, text);
			};

			// Clean slate: a rerun must not be testing the previous run's leftovers.
			if (app.vault.getAbstractFileByPath(base)) {
				// @ts-expect-error — internal adapter API
				await app.vault.adapter.rmdir(base, true).catch(() => undefined);
			}

			const parsed = { columns: ['id', 'name', 'prose'], rows, rowCount: rows.length };
			const options = {
				basePath: base,
				overwriteMode: 'replace',
				createFolders: true,
				sourceFileName: 'managed-regions-destructive.csv',
			};

			const first = await plugin.runImportFromRecipe(parsed, recipeV1, options);

			// AM-16. The re-import below writes over the identities this first import
			// minted, and since AM-9 the engine no longer adopts a set it happens to
			// find in the destination: a second call with no `importSet` is a NEW set,
			// which AM-12 then correctly refuses row by row as a cross-set collision.
			// Naming the set the first run stamped is the E2E stand-in for the ownership
			// click a person makes in the wizard. Read off S5-control, the one note this
			// spec never damages, and parsed from the file's own bytes rather than the
			// metadata cache, which may not have indexed a just-written note yet.
			const ownedImportSet = async (): Promise<{ id: string }> => {
				const text = await read('S5-control');
				const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
				if (!match) throw new Error('first import stamped no frontmatter');
				const fm = obsidian.parseYaml(match[1]) as Record<string, any> | null;
				const id = fm?._crosswalker?.import_set?.id;
				if (typeof id !== 'string') throw new Error('first import stamped no import set id');
				return { id };
			};
			const importSet = await ownedImportSet();

			// --- Damage each note in exactly one way -------------------------------

			// S2 — a person types INSIDE the managed region, just under the start marker.
			{
				const text = await read('S2-inside');
				await write('S2-inside', text.replace(start, `${start}\nTYPED INSIDE THE REGION.`));
			}

			// S3 — a legacy note: markers stripped, then a human edits the body.
			{
				const text = await read('S3-edited-legacy');
				const stripped = text.split('\n').filter((l: string) => l !== start && l !== end).join('\n');
				await write('S3-edited-legacy', `${stripped}\n\nHAND WRITTEN AUDIT REMARK.  \n`);
			}

			// S3b — a legacy note nobody edited, whose content is what THIS run renders.
			// Markers stripped; the managed sentence advanced to the revision the
			// re-import will produce, because `strict` adoption is equality against the
			// CURRENT render. This is the pre-marker note of a vault whose source has
			// not moved since it was generated.
			{
				const text = await read('S3B-clean-legacy');
				const stripped = text.split('\n').filter((l: string) => l !== start && l !== end).join('\n');
				await write('S3B-clean-legacy', stripped.replace('(revision one)', '(revision two)'));
			}

			// S3c — a legacy note nobody edited, but generated from an OLDER source.
			// Markers stripped, content left at revision one. Nothing human is at risk
			// here, and the merge still refuses, because it cannot tell "the source
			// moved" from "a person rewrote this" without a marker to measure against.
			{
				const text = await read('S3C-stale-legacy');
				const stripped = text.split('\n').filter((l: string) => l !== start && l !== end).join('\n');
				await write('S3C-stale-legacy', stripped);
			}

			// S4a — the end marker is deleted. Region never closes.
			{
				const text = await read('S4A-unclosed');
				await write('S4A-unclosed', text.split('\n').filter((l: string) => l !== end).join('\n')
					+ '\nMY NOTES BELOW THE VANISHED BOUNDARY.\n');
			}

			// S4b — the start marker is duplicated.
			{
				const text = await read('S4B-duplicate');
				await write('S4B-duplicate', text.replace(end, `${start}\nSECOND REGION?\n${end}`));
			}

			// S4c — the end marker is moved ABOVE the start marker.
			{
				const text = await read('S4C-inverted');
				const withoutEnd = text.split('\n').filter((l: string) => l !== end).join('\n');
				await write('S4C-inverted', withoutEnd.replace(start, `${end}\n${start}`));
			}

			// Snapshot every note exactly as it stands before the re-import.
			const before: Record<string, string> = {};
			for (const row of rows) before[row.id] = await read(row.id);

			// --- Re-import with a CHANGED managed value ----------------------------
			const second = await plugin.runImportFromRecipe(parsed, recipeV2, { ...options, importSet });

			const after: Record<string, string> = {};
			for (const row of rows) after[row.id] = await read(row.id);

			return {
				firstErrors: first.errors ?? [],
				secondErrors: second.errors ?? [],
				conflicts: second.conflicts ?? [],
				before,
				after,
				notesWritten: second.notesCreated ?? 0,
			};
		}, {
			base: BASE,
			rows: ROWS,
			recipeV1: recipe('(revision one)'),
			recipeV2: recipe('(revision two)'),
			start: START,
			end: END,
		});

		expect(out.firstErrors).toEqual([]);
		// A conflict is not an error: the run must complete cleanly.
		expect(out.secondErrors).toEqual([]);
	});

	it('S5 control — an untouched note updates, proving the run reached every row', () => {
		expect(out.before['S5-control']).toContain('(revision one)');
		expect(out.after['S5-control']).toContain('(revision two)');
		expect(out.after['S5-control']).toContain(START);
		// No conflict for the control note.
		expect(out.conflicts.map((c) => c.path)).not.toContain(`${BASE}/S5-control.md`);
	});

	it('S2 — prose typed INSIDE the region is replaced (this is the contract)', () => {
		const after = out.after['S2-inside'];
		expect(out.before['S2-inside']).toContain('TYPED INSIDE THE REGION.');
		// Deliberate: the region is managed. Text put inside it is regenerated away.
		// If this assertion ever starts failing, someone has taught the merge to
		// guess at region contents, which is the guess this design removes.
		expect(after).not.toContain('TYPED INSIDE THE REGION.');
		expect(after).toContain('(revision two)');
		expect(out.conflicts.map((c) => c.path)).not.toContain(`${BASE}/S2-inside.md`);
	});

	it('S3 — an EDITED legacy note is left byte-identical and reported as a conflict', () => {
		// The whole point. This file holds work a person did by hand.
		expect(out.after['S3-edited-legacy']).toBe(out.before['S3-edited-legacy']);
		expect(out.after['S3-edited-legacy']).toContain('HAND WRITTEN AUDIT REMARK.');
		// Still the OLD managed value: nothing was written, not even the frontmatter.
		expect(out.after['S3-edited-legacy']).toContain('(revision one)');
		expect(out.after['S3-edited-legacy']).not.toContain('(revision two)');

		const conflict = out.conflicts.find((c) => c.path === `${BASE}/S3-edited-legacy.md`);
		expect(conflict).toBeDefined();
		expect(conflict!.code).toBe('legacy-body-differs');
	});

	it('S3b — an UNTOUCHED legacy note adopts, so S3 is a measurement not a blanket refusal', () => {
		const after = out.after['S3B-clean-legacy'];
		expect(out.before['S3B-clean-legacy']).not.toContain(START);
		expect(after).toContain(START);
		expect(after).toContain(END);
		expect(after).toContain('(revision two)');
		expect(out.conflicts.map((c) => c.path)).not.toContain(`${BASE}/S3B-clean-legacy.md`);
	});

	it('S3c — a legacy note from an OLDER render refuses too, and says so', () => {
		// The cost of the safe direction, pinned so it is a known property rather
		// than a surprise: adoption is equality against what this run renders, so an
		// unmarked note whose SOURCE has since changed conflicts even though no human
		// touched it. Untouched on disk, reported, and fixable by deleting the note
		// or accepting the region once. The alternative — adopting anything that
		// merely looks generated — is the guess that loses prose.
		expect(out.after['S3C-stale-legacy']).toBe(out.before['S3C-stale-legacy']);
		const conflict = out.conflicts.find((c) => c.path === `${BASE}/S3C-stale-legacy.md`);
		expect(conflict).toBeDefined();
		expect(conflict!.code).toBe('legacy-body-differs');
	});

	const CORRUPT: Array<{ id: string; code: string; label: string }> = [
		{ id: 'S4A-unclosed', code: 'unclosed-region', label: 'a deleted end marker' },
		{ id: 'S4B-duplicate', code: 'duplicate-region', label: 'a duplicated start marker' },
		{ id: 'S4C-inverted', code: 'inverted-region', label: 'an end marker moved above its start' },
	];

	CORRUPT.forEach(({ id, code, label }) => {
		it(`S4 — ${label} leaves the file untouched and reports ${code}`, () => {
			expect(out.after[id]).toBe(out.before[id]);
			expect(out.after[id]).not.toContain('(revision two)');

			const conflict = out.conflicts.find((c) => c.path === `${BASE}/${id}.md`);
			expect(conflict).toBeDefined();
			expect(conflict!.code).toBe(code);
			// The diagnostic has to be readable by the person holding the vault.
			expect(conflict!.detail.length).toBeGreaterThan(0);
		});
	});

	it('reports exactly the five refused notes and no others', () => {
		expect(out.conflicts.map((c) => c.path).sort()).toEqual([
			`${BASE}/S3-edited-legacy.md`,
			`${BASE}/S3C-stale-legacy.md`,
			`${BASE}/S4A-unclosed.md`,
			`${BASE}/S4B-duplicate.md`,
			`${BASE}/S4C-inverted.md`,
		].sort());
	});

	it('photographs one note where user prose and regenerated content coexist', async () => {
		// Give the control note a realistic human addition below the boundary, so the
		// picture shows the thing the slice exists for rather than a bare region.
		const target = `${BASE}/S5-control.md`;
		await browser.executeObsidian(async ({ app }, args) => {
			const file = app.vault.getAbstractFileByPath(args.target);
			// @ts-expect-error — TFile at runtime
			const text = await app.vault.read(file);
			// @ts-expect-error — TFile at runtime
			await app.vault.modify(file, text
				+ '\n## Our implementation\n\nOwned by the platform team. Evidence lives in ticket SEC-4192,\n'
				+ 'reviewed at the 2026-08-27 access review.\n\n'
				+ '> [!note] Audit remark\n> Compensating control in place until Q4.\n');

			// No revealLeaf() and no `file-explorer:reveal-active-file`. Both wedge the
			// renderer after a generated import, and a wedged renderer silently returns
			// the PREVIOUS frame instead of failing.
			// @ts-expect-error — internal leaf API
			const leaf = app.workspace.getLeaf(true);
			// @ts-expect-error — TFile at runtime
			await leaf.openFile(file, { state: { mode: 'source', source: true } });
		}, { target });

		// Clear the derived index so a stale-projection notice does not sit over the
		// frame. The pictures are of Tier 1 Markdown, which is canonical.
		await resetTier2Sidecar().catch(() => undefined);
		await browser.pause(1200);

		// Scroll to the boundary. Without this the frame is all frontmatter and the
		// one thing the picture exists to show — managed content above the end
		// marker, hand-written prose below it — is off-screen.
		await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error — internal leaf/view API
			const ed = app.workspace.activeLeaf?.view?.editor;
			if (!ed) return;
			const lines: string[] = ed.getValue().split('\n');
			const idx = lines.findIndex((l) => l === args.end);
			if (idx === -1) return;
			ed.setCursor({ line: idx, ch: 0 });
			ed.scrollIntoView({ from: { line: Math.max(0, idx - 8), ch: 0 }, to: { line: idx + 12, ch: 0 } }, true);
		}, { end: END });

		await browser.pause(1200);
		await browser.saveScreenshot(path.join(OUT_DIR, 'managed-region-source-view.png'));

		// And the reading view, where the markers are invisible and the note simply
		// reads as one document — the experience the user actually gets.
		await browser.executeObsidian(async ({ app }, args) => {
			const file = app.vault.getAbstractFileByPath(args.target);
			// @ts-expect-error — internal leaf API
			const leaf = app.workspace.getLeaf(true);
			// @ts-expect-error — TFile at runtime
			await leaf.openFile(file, { state: { mode: 'preview' } });
		}, { target });

		await browser.pause(1500);
		await browser.saveScreenshot(path.join(OUT_DIR, 'managed-region-reading-view.png'));

		// The picture is evidence only if the bytes back it up.
		const finalText = await browser.executeObsidian(async ({ app }, args) => {
			const file = app.vault.getAbstractFileByPath(args.target);
			// @ts-expect-error — TFile at runtime
			return app.vault.read(file);
		}, { target });

		expect(finalText).toContain('(revision two)');
		expect(finalText).toContain('Owned by the platform team.');
		expect(finalText.indexOf(END)).toBeLessThan(finalText.indexOf('Owned by the platform team.'));
	});
});
