import { TFile } from 'obsidian';
import { applyMigrations } from '../src/tier2/migrations';
import {
	resolveHousekeepingRebaselineCandidates,
	runHousekeepingRebaselineCommand,
	selectedReportPaths,
} from '../src/views/rebaseline-housekeeping';

const { DatabaseSync } = require('node:sqlite');

interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}

function createDb(): any {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input: string | ExecOptions) {
			if (typeof input === 'string') { sqlite.exec(input); return; }
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') {
				return Object.keys(bind).length ? statement.all(bind) : statement.all();
			}
			if (Object.keys(bind).length) statement.run(bind); else statement.run();
		},
		close: () => sqlite.close(),
	};
}

function rows(db: any, sql: string): unknown[][] {
	return db.exec({ sql, rowMode: 'array', returnValue: 'resultRows' }) as unknown[][];
}

const CURRENT = {
	reviewCid: `sha256-${'d'.repeat(64)}`,
	wording: `sha256-${'a'.repeat(64)}`,
	scope: `sha256-${'b'.repeat(64)}`,
	housekeeping: `sha256-${'c'.repeat(64)}`,
};
const OLD = {
	reviewCid: `sha256-${'e'.repeat(64)}`,
	wording: CURRENT.wording,
	scope: CURRENT.scope,
	housekeeping: `sha256-${'f'.repeat(64)}`,
};

function seed(db: any, paths = ['Evidence/one.md', 'Evidence/two.md']): void {
	db.exec(`INSERT INTO ontologies (id, name, version, base_path, recipe_id, imported_at) VALUES ('x', 'X', '1', 'Concepts', 'test', '2026-08-28T00:00:00Z')`);
	db.exec(`
		INSERT INTO concepts (
			ontology_id, curie, vault_path, source_hash, title,
			review_cid, review_wording_cid, review_scope_cid, review_housekeeping_cid,
			imported_at, modified_at
		) VALUES (
			'x', 'x:A', 'Concepts/A.md', 'source-concept', 'A',
			'${CURRENT.reviewCid}', '${CURRENT.wording}', '${CURRENT.scope}', '${CURRENT.housekeeping}',
			'2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'
		);
	`);
	for (const [index, path] of paths.entries()) {
		db.exec(`
			INSERT INTO junction_notes (
				vault_path, curie, subject, subject_curie, predicate, object,
				coverage, reviewer, review_date, status,
				reviewed_against_curie, reviewed_against_cid,
				reviewed_wording_cid, reviewed_scope_cid, reviewed_housekeeping_cid,
				source_hash, modified_at
			) VALUES (
				'${path}', 'cwk:j${index}', '[[Concepts/A]]', 'x:A', 'has_evidence', '[[Evidence/P${index}]]',
				'full', 'Reviewer ${index}', '2026-08-01T00:00:00Z', 'approved',
				'x:A', '${OLD.reviewCid}', '${OLD.wording}', '${OLD.scope}', '${OLD.housekeeping}',
				'source-${index}', '2026-08-28T00:00:00Z'
			);
		`);
	}
}

/** The junction identity `seed()` writes into Tier 2 for the nth path. */
const junctionCurie = (index: number): string => `cwk:j${index}`;

/**
 * A vault double for the selected notes.
 *
 * AM-25 (2026-08-31): every note now carries its own `curie`, because the
 * command reads it and compares it to the identity the report row named before
 * it writes an audit fact. `opts.curies` overrides that per path (a mismatch, or
 * `null` for a note carrying no identity at all) and `opts.unreadable` makes a
 * note answer neither — nothing cached, and bytes that will not parse.
 */
function appWithFrontmatter(
	db: any,
	paths: string[],
	opts: { curies?: Record<string, string | null>; unreadable?: string[] } = {},
) {
	const frontmatter = new Map<string, Record<string, any>>();
	const unreadable = new Set(opts.unreadable ?? []);
	for (const [index, path] of paths.entries()) {
		const curie = opts.curies && path in opts.curies ? opts.curies[path] : junctionCurie(index);
		frontmatter.set(path, {
			...(curie === null ? {} : { curie }),
			status: 'approved',
			reviewer: `Reviewer ${index}`,
			review_date: '2026-08-01T00:00:00Z',
			coverage: 'full',
			reviewed_against: {
				curie: 'x:A',
				review_cid: OLD.reviewCid,
				review_groups: {
					wording: OLD.wording,
					scope: OLD.scope,
					housekeeping: OLD.housekeeping,
				},
			},
		});
	}
	const processFrontMatter = jest.fn(async (file: TFile, mutate: (fm: Record<string, any>) => void) => {
		// Canonical Tier 1 must be written before the derived Tier 2 row changes.
		expect(rows(db, `SELECT reviewed_against_cid FROM junction_notes WHERE vault_path='${file.path}'`))
			.toEqual([[OLD.reviewCid]]);
		mutate(frontmatter.get(file.path)!);
	});
	return {
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => frontmatter.has(path) ? new TFile(path) : null,
				// Only reached for a note the cache cannot answer about, which is
				// exactly the damaged case below.
				cachedRead: async (file: { path: string }) => '---\n: : :\n---\nDamaged.\n',
			},
			metadataCache: {
				getFileCache: (file: { path: string }) => {
					if (unreadable.has(file.path)) return null;
					const fm = frontmatter.get(file.path);
					return fm === undefined ? null : { frontmatter: fm };
				},
			},
			fileManager: { processFrontMatter },
		},
		frontmatter,
		processFrontMatter,
	};
}

describe('housekeeping re-baselining', () => {
	it('extracts only selected report-row links and deduplicates them', () => {
		expect(selectedReportPaths([
			'| Link | Subject baseline | Change kind | Primary exclusion |',
			'| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
			'| [[Evidence/two.md|Alias]] | `changed` | `housekeeping` | `expired` |',
			'| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
		].join('\n'))).toEqual(['Evidence/one.md', 'Evidence/two.md']);
	});

	it('clears exactly the selected housekeeping row without changing attestation facts', async () => {
		const db = createDb();
		applyMigrations(db);
		const paths = ['Evidence/one.md', 'Evidence/two.md'];
		seed(db, paths);
		const { app, frontmatter, processFrontMatter } = appWithFrontmatter(db, paths);
		const before = JSON.parse(JSON.stringify(frontmatter.get(paths[0])!)) as Record<string, any>;
		const confirm = jest.fn(async () => true);

		const changed = await runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2: async () => ({ db }),
			selection: '| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
			confirm,
		});

		expect(changed).toBe(1);
		expect(confirm).toHaveBeenCalledWith(1);
		expect(processFrontMatter).toHaveBeenCalledTimes(1);
		const after = frontmatter.get(paths[0])!;
		expect({
			status: after.status,
			reviewer: after.reviewer,
			review_date: after.review_date,
			coverage: after.coverage,
		}).toEqual({
			status: before.status,
			reviewer: before.reviewer,
			review_date: before.review_date,
			coverage: before.coverage,
		});
		expect(after.reviewed_against).toEqual({
			curie: 'x:A',
			review_cid: CURRENT.reviewCid,
			review_groups: {
				wording: CURRENT.wording,
				scope: CURRENT.scope,
				housekeeping: CURRENT.housekeeping,
			},
		});
		expect(frontmatter.get(paths[1])!.reviewed_against.review_cid).toBe(OLD.reviewCid);
		expect(rows(db, `
			SELECT vault_path, status, reviewer, review_date, subject_baseline, change_kind
			FROM junction_notes_with_freshness ORDER BY vault_path
		`)).toEqual([
			['Evidence/one.md', 'approved', 'Reviewer 0', '2026-08-01T00:00:00Z', 'match', null],
			['Evidence/two.md', 'approved', 'Reviewer 1', '2026-08-01T00:00:00Z', 'changed', 'housekeeping'],
		]);
		db.close();
	});

	it('resolves the whole selected batch before the first vault write', async () => {
		const db = createDb();
		applyMigrations(db);
		seed(db);
		// Only the first selected file exists in the vault. The second must be
		// discovered before processFrontMatter touches the first.
		const { app, processFrontMatter } = appWithFrontmatter(db, ['Evidence/one.md']);
		const changed = await runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2: async () => ({ db }),
			selection: [
				'| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
				'| [[Evidence/two.md]] | `changed` | `housekeeping` | `subject-changed` |',
			].join('\n'),
			confirm: async () => true,
		});
		expect(changed).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(rows(db, `SELECT COUNT(*) FROM junction_notes_with_freshness WHERE subject_baseline='changed'`))
			.toEqual([[2]]);
		db.close();
	});

	it('cancellation performs no Tier 1 or Tier 2 write', async () => {
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		const { app, processFrontMatter } = appWithFrontmatter(db, ['Evidence/one.md']);
		const changed = await runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2: async () => ({ db }),
			selection: '[[Evidence/one.md]]',
			confirm: async () => false,
		});
		expect(changed).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(rows(db, `SELECT subject_baseline, change_kind FROM junction_notes_with_freshness`))
			.toEqual([['changed', 'housekeeping']]);
		db.close();
	});

	it('rejects wording rows and incomplete current fingerprints before any write', () => {
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		db.exec(`UPDATE junction_notes SET reviewed_wording_cid='sha256-old-wording'`);
		expect(() => resolveHousekeepingRebaselineCandidates(db, ['Evidence/one.md']))
			.toThrow('not a housekeeping-only changed link');
		db.close();

		const incompleteDb = {
			exec: () => [[
				'Evidence/one.md', 'approved', 'changed', 'housekeeping',
				'x:A', CURRENT.reviewCid, CURRENT.wording, null, CURRENT.housekeeping,
			]],
		};
		expect(() => resolveHousekeepingRebaselineCandidates(incompleteDb, ['Evidence/one.md']))
			.toThrow('has no complete current fingerprint set');
	});

	// Regression, 2026-08-28. The command used to resolve candidates, open a
	// confirmation dialog, and then write through the SAME handle it opened
	// before the dialog. A dialog is user time and unbounded, so a reset of the
	// query index during it closed that database and deleted its file. Waiting
	// for the dialog is not an option -- that hangs the reset -- so the handle
	// must not be carried across the decision at all.
	it('does not carry the database handle across the confirmation dialog', async () => {
		const before = createDb();
		applyMigrations(before);
		const paths = ['Evidence/one.md'];
		seed(before, paths);

		// What a reset leaves behind: the old database is gone and the next
		// open hands back a fresh one.
		const after = createDb();
		applyMigrations(after);
		seed(after, paths);

		// The app helper asserts Tier 1 lands before Tier 2, and it must make
		// that check against the database the write actually goes to.
		const { app } = appWithFrontmatter(after, paths);

		let opens = 0;
		const openTier2 = async () => {
			opens += 1;
			return { db: opens === 1 ? before : after };
		};
		const confirm = jest.fn(async () => {
			before.close(); // the reset happens while the dialog is up
			return true;
		});

		const changed = await runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2,
			selection: '| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
			confirm,
		});

		expect(opens).toBe(2);
		expect(changed).toBe(1);
		// The write landed on the live database, not the closed one.
		expect(rows(after, `SELECT reviewed_against_cid FROM junction_notes WHERE vault_path='Evidence/one.md'`))
			.toEqual([[CURRENT.reviewCid]]);
		after.close();
	});

	// The notes are canonical and the index is derived, so "the index update
	// failed" and "your re-baseline failed" are different facts. Reporting the
	// second when only the first happened invites someone to re-run an audit
	// action that already took effect.
	it('reports a recorded baseline when only the derived index update fails', async () => {
		const db = createDb();
		applyMigrations(db);
		const paths = ['Evidence/one.md'];
		seed(db, paths);
		const { app, frontmatter, processFrontMatter } = appWithFrontmatter(db, paths);

		// Fail every write to the index, leaving the note edits intact.
		const live = {
			exec: (input: any) => {
				const sql = typeof input === 'string' ? input : input.sql;
				if (/SAVEPOINT|UPDATE junction_notes/i.test(sql)) throw new Error('database is closed');
				return db.exec(input);
			},
		};
		let opens = 0;
		const openTier2 = async () => {
			opens += 1;
			return { db: opens === 1 ? db : live };
		};

		const changed = await runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2,
			selection: '| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |',
			confirm: async () => true,
		});

		// Counted as done, because in the canonical record it is done.
		expect(changed).toBe(1);
		expect(processFrontMatter).toHaveBeenCalledTimes(1);
		expect(frontmatter.get('Evidence/one.md')!.reviewed_against.review_cid).toBe(CURRENT.reviewCid);
		db.close();
	});
});

// ---------------------------------------------------------------------------
// AM-25 (2026-08-31): an audit fact is never written by address.
//
// THE DEFECT (E-D). This is the ONLY write in the plugin that asserts an audit
// fact — `reviewed_against` is the baseline a compliance claim rests on, and the
// thing that decides later whether an approval has been outlived by an upstream
// edit. It was asserting it BY ADDRESS: the selection is parsed out of a
// generated report note (which renders links, and a link is a path), joined to
// Tier 2 on `WHERE j.vault_path = $path`, and then stamped onto whatever file
// now sits at that path. The junction's own curie was in Tier 2 the whole time
// and was never selected and never compared.
//
// A stale report plus a stale projection — one note deleted, another created at
// the same path — recorded an attestation baseline onto a note nothing had ever
// identified. The command also used `processFrontMatter`, which is why AM-17's
// sweep pattern (`vault.modify` / `vault.create`) could not see it at all.
//
// THE RULE. The identity travels from the index row to the write, and the file's
// own recorded curie decides. One mismatch refuses the WHOLE selection, through
// the same refuse-all path every other check in this command already uses,
// because a half-applied batch of audit facts is worse than none.
// ---------------------------------------------------------------------------

describe('AM-25: the note is identified before the audit fact is written', () => {
	/**
	 * Run something with `Notice` swapped on the LIVE module object and return
	 * everything it said. A namespace import would be a copy under
	 * esModuleInterop, and a spy on the copy leaves src/ calling the original.
	 */
	async function captureNotices(run: () => Promise<void>): Promise<string> {
		const said: string[] = [];
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const obsidianModule = require('obsidian') as { Notice: new (m: string, t?: number) => unknown };
		const RealNotice = obsidianModule.Notice;
		obsidianModule.Notice = class { constructor(message: string) { said.push(message); } } as never;
		try {
			await run();
		} finally {
			obsidianModule.Notice = RealNotice;
		}
		return said.join('\n');
	}

	function runFor(
		db: any,
		app: unknown,
		selection: string,
	): Promise<number> {
		return runHousekeepingRebaselineCommand({
			app: app as any,
			openTier2: async () => ({ db }),
			selection,
			confirm: async () => true,
		});
	}

	const ROW = '| [[Evidence/one.md]] | `changed` | `housekeeping` | `subject-changed` |';
	const BOTH = [
		ROW,
		'| [[Evidence/two.md]] | `changed` | `housekeeping` | `subject-changed` |',
	].join('\n');

	it('carries the junction\'s own identity from the index row to the write', () => {
		// It was available all along. Selecting it is the whole fix.
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		expect(resolveHousekeepingRebaselineCandidates(db, ['Evidence/one.md'])[0].junctionCurie)
			.toBe(junctionCurie(0));
		db.close();
	});

	it('refuses the whole selection when the note there is a different link', async () => {
		// The scenario: the report is stale, or the projection is. Either way the
		// note at that path is not the one the row described, and stamping it would
		// record an attestation against a subject nobody reviewed.
		const db = createDb();
		applyMigrations(db);
		const paths = ['Evidence/one.md'];
		seed(db, paths);
		const { app, frontmatter, processFrontMatter } = appWithFrontmatter(db, paths, {
			curies: { 'Evidence/one.md': 'cwk:some-other-link' },
		});

		const changed = await runFor(db, app, ROW);

		expect(changed).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(frontmatter.get('Evidence/one.md')!.reviewed_against.review_cid).toBe(OLD.reviewCid);
		expect(rows(db, `SELECT reviewed_against_cid FROM junction_notes WHERE vault_path='Evidence/one.md'`))
			.toEqual([[OLD.reviewCid]]);
		db.close();
	});

	it('names both identities so the user can tell what happened', async () => {
		// "Could not record baselines" alone leaves a person with an audit action
		// that did nothing and no way to find out why.
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		const { app } = appWithFrontmatter(db, ['Evidence/one.md'], {
			curies: { 'Evidence/one.md': 'cwk:some-other-link' },
		});

		const said = await captureNotices(async () => { await runFor(db, app, ROW); });

		expect(said).toContain(junctionCurie(0));
		expect(said).toContain('cwk:some-other-link');
		expect(said).toContain('Regenerate the coverage report');
		db.close();
	});

	it('a mismatch on the LAST row still leaves the first row unwritten', async () => {
		// Refuse-all, checked before the first write rather than as it goes. A
		// half-applied batch of attestation baselines is the worst outcome here:
		// some claims re-baselined, some not, and nothing saying which.
		const db = createDb();
		applyMigrations(db);
		const paths = ['Evidence/one.md', 'Evidence/two.md'];
		seed(db, paths);
		const { app, frontmatter, processFrontMatter } = appWithFrontmatter(db, paths, {
			curies: { 'Evidence/two.md': 'cwk:not-that-one' },
		});

		const changed = await runFor(db, app, BOTH);

		expect(changed).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(frontmatter.get('Evidence/one.md')!.reviewed_against.review_cid).toBe(OLD.reviewCid);
		expect(rows(db, `SELECT COUNT(*) FROM junction_notes WHERE reviewed_against_cid='${CURRENT.reviewCid}'`))
			.toEqual([[0]]);
		db.close();
	});

	it('refuses a note carrying no identity at all, and says THAT rather than "wrong link"', async () => {
		// A note with no curie and a note with the wrong curie are different
		// situations for the person reading the notice: the first says nothing can
		// be confirmed about this note, the second says the report is out of date.
		// Asserted on the wording, because a refusal that lands for the neighbouring
		// reason still refuses and would hide the missing branch.
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		const { app, processFrontMatter } = appWithFrontmatter(db, ['Evidence/one.md'], {
			curies: { 'Evidence/one.md': null },
		});

		let changed: number;
		const said = await captureNotices(async () => { changed = await runFor(db, app, ROW); });

		expect(changed!).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(said).toContain('carries no identity');
		expect(said).not.toContain('is not the link the report named');
		db.close();
	});

	it('refuses when the index row itself has no identity', async () => {
		// A row that is not the shape this command believes it is. Writing an audit
		// fact with nothing to check it against is the state AM-25 forbids, whether
		// the missing half is the note's or the index's.
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		db.exec(`UPDATE junction_notes SET curie=''`);
		expect(() => resolveHousekeepingRebaselineCandidates(db, ['Evidence/one.md']))
			.toThrow('no recorded identity in the coverage index');
		db.close();
	});

	it('tells the user to fix a damaged note, and never that it is not the link', async () => {
		// AM-19's rule at this site: nothing was established about the note, so
		// nothing may be claimed about it. Never "this is not the link", never an
		// invitation to move or delete it.
		const db = createDb();
		applyMigrations(db);
		seed(db, ['Evidence/one.md']);
		const { app, processFrontMatter } = appWithFrontmatter(db, ['Evidence/one.md'], {
			unreadable: ['Evidence/one.md'],
		});

		let changed: number;
		const said = await captureNotices(async () => { changed = await runFor(db, app, ROW); });

		expect(changed!).toBe(0);
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(said).toContain('could not read the properties');
		expect(said).toContain("Fix that note's properties block");
		expect(said).not.toContain('is not the link');
		expect(said).not.toMatch(/move or (rename|delete)/i);
		db.close();
	});

	it('the matching case still writes the fingerprint fields and NOTHING else', async () => {
		// The control, stated as a key-level property rather than a field list: a
		// guard that refused everything would pass every test above, and a write
		// that touched one more key would be an unreviewed change to an audit
		// record.
		const db = createDb();
		applyMigrations(db);
		const paths = ['Evidence/one.md'];
		seed(db, paths);
		const { app, frontmatter } = appWithFrontmatter(db, paths);
		const before = JSON.parse(JSON.stringify(frontmatter.get(paths[0])!)) as Record<string, any>;

		expect(await runFor(db, app, ROW)).toBe(1);

		const after = frontmatter.get(paths[0])!;
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		for (const key of Object.keys(before)) {
			if (key === 'reviewed_against') continue;
			expect(after[key]).toEqual(before[key]);
		}
		expect(after.reviewed_against).toEqual({
			curie: 'x:A',
			review_cid: CURRENT.reviewCid,
			review_groups: {
				wording: CURRENT.wording,
				scope: CURRENT.scope,
				housekeeping: CURRENT.housekeeping,
			},
		});
		db.close();
	});
});
