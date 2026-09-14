/**
 * replace-preservation.spec.ts — the Ch 45 §4.2 test gate, in real Obsidian.
 *
 * THE STAKE. Before the 2026-08-27 managed-body-regions slice, re-importing with
 * `Replace` rebuilt the whole note body. Anything a person wrote into a
 * generated control note — an implementation note, an evidence pointer, an audit
 * remark — was destroyed with no warning and no undo, which is why the shipped
 * rollout guidance told people to treat generated notes as read-only.
 *
 * The unit suite (tests/replace-preserves-body.test.ts) proves the merge against
 * a vault double on both entry points. This spec proves the same thing against
 * REAL FILES in REAL OBSIDIAN: prose typed into three generated notes, through
 * the vault adapter the plugin actually writes with, survives a re-import
 * byte-for-byte while the managed region updates.
 *
 * Run: `DISPLAY=:0 bun run e2e -- --spec tests/e2e/replace-preservation.spec.ts`
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';

const BASE = 'Frameworks/Replace-Preservation';

/** Three rows, so the assertion is not a single lucky note. */
const ROWS = [
	{ id: 'AC-2', name: 'Account management', prose: 'Manage system accounts.' },
	{ id: 'AC-3', name: 'Access enforcement', prose: 'Enforce approved authorizations.' },
	{ id: 'AC-6', name: 'Least privilege', prose: 'Employ the principle of least privilege.' },
];

function recipe(prose: string) {
	return {
		recipe: 'replace-preservation',
		source: { ontology: 'replace-preservation', levels: ['leaf'] },
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
			also_emit: {
				frontmatter: { managed: { title: '{name}' } },
				body: [{ template: `{prose} ${prose}`, position: 'append', format: 'text' }],
			},
		},
	};
}

/** The three edits a person would actually make, including awkward whitespace. */
const EDITS: Record<string, string> = {
	'AC-2': '\n## Our implementation  \nEvidence: ticket SEC-4192.\n',
	'AC-3': '\n> [!note] Audit remark\n> Reviewed 2026-08-27 by the control owner.\t\n',
	'AC-6': '\nSee also [[AC-2]] and the quarterly access review.\n',
};

describe('Replace preserves user-authored note bodies (Ch 45 §4.2)', function () {
	it('prose typed into three generated notes survives a re-import byte-for-byte', async () => {
		const result = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			// @ts-expect-error — internal API
			const plugin = app.plugins.plugins['crosswalker'];
			const { base, rows, recipeV1, recipeV2, edits } = args;

			const readNote = async (id: string): Promise<string> => {
				const file = app.vault.getAbstractFileByPath(`${base}/${id}.md`);
				if (!file) throw new Error(`missing note ${base}/${id}.md`);
				// @ts-expect-error — TFile at runtime
				return app.vault.read(file);
			};

			// Clean slate, so a rerun of this spec is not testing last run's leftovers.
			const existingFolder = app.vault.getAbstractFileByPath(base);
			if (existingFolder) {
				// @ts-expect-error — internal API
				await app.vault.adapter.rmdir(base, true).catch(() => undefined);
			}

			const parsed = { columns: ['id', 'name', 'prose'], rows, rowCount: rows.length };
			const options = {
				basePath: base,
				overwriteMode: 'replace',
				createFolders: true,
				sourceFileName: 'replace-preservation.csv',
			};

			// 1. First import.
			const first = await plugin.runImportFromRecipe(parsed, recipeV1, options);

			// AM-16. The re-import below writes over the identities the first import
			// minted, and since AM-9 the engine no longer adopts a set it happens to
			// find in the destination: a second call with no `importSet` is a NEW set,
			// which AM-12 then correctly refuses row by row as a cross-set collision.
			// Naming the set the first run stamped is the E2E stand-in for the ownership
			// click a person makes in the wizard. Read off a generated note rather than
			// out of the run result, because the note on disk is where ownership is
			// actually recorded. Parsed from the file's own bytes, not from the metadata
			// cache, which may not have indexed a just-written note yet.
			const ownedImportSet = async (): Promise<{ id: string }> => {
				const file = app.vault.getAbstractFileByPath(`${base}/${rows[0].id}.md`);
				if (!file) throw new Error(`first import wrote no note at ${base}/${rows[0].id}.md`);
				// @ts-expect-error - TFile at runtime
				const text = await app.vault.read(file);
				const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
				if (!match) throw new Error('first import stamped no frontmatter');
				const fm = obsidian.parseYaml(match[1]) as Record<string, any> | null;
				const id = fm?._crosswalker?.import_set?.id;
				if (typeof id !== 'string') throw new Error('first import stamped no import set id');
				return { id };
			};

			// 2. A person opens each note and types into it, below the region.
			const before: Record<string, string> = {};
			for (const row of rows) {
				const path = `${base}/${row.id}.md`;
				const file = app.vault.getAbstractFileByPath(path);
				// @ts-expect-error — TFile at runtime
				const text = await app.vault.read(file);
				// @ts-expect-error — TFile at runtime
				await app.vault.modify(file, text + edits[row.id]);
				before[row.id] = text + edits[row.id];
			}

			// 3. Re-import with a CHANGED source value, so the region must rebuild.
			const second = await plugin.runImportFromRecipe(
				parsed,
				recipeV2,
				{ ...options, importSet: await ownedImportSet() },
			);

			const after: Record<string, string> = {};
			for (const row of rows) after[row.id] = await readNote(row.id);

			return {
				firstErrors: first.errors,
				secondErrors: second.errors,
				secondConflicts: second.conflicts ?? [],
				before,
				after,
			};
		}, {
			base: BASE,
			rows: ROWS,
			recipeV1: recipe('(revision one)'),
			recipeV2: recipe('(revision two)'),
			edits: EDITS,
		});

		expect(result.firstErrors).toEqual([]);
		expect(result.secondErrors).toEqual([]);
		expect(result.secondConflicts).toEqual([]);

		for (const row of ROWS) {
			const before = result.before[row.id];
			const after = result.after[row.id];

			// The note carries the boundary at all.
			expect(after).toContain('<!-- crosswalker:body:start v=1 -->');
			expect(after).toContain('<!-- crosswalker:body:end -->');

			// The user's bytes survive EXACTLY, trailing whitespace included.
			expect(after.endsWith(EDITS[row.id])).toBe(true);

			// And the managed region actually updated.
			expect(before).toContain('(revision one)');
			expect(after).toContain('(revision two)');
			expect(after).not.toContain('(revision one)');
		}
	});
});
