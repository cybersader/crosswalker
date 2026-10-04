import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';

const { DatabaseSync } = require('node:sqlite');

interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}

interface TestDb {
	exec(input: string | ExecOptions): unknown[][] | void;
	close(): void;
}

interface TestFile {
	path: string;
	stat: { mtime: number };
}

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');

	return {
		exec(input: string | ExecOptions): unknown[][] | void {
			if (typeof input === 'string') {
				sqlite.exec(input);
				return;
			}

			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};

			if (input.returnValue === 'resultRows') {
				return Object.keys(bind).length > 0 ? statement.all(bind) : statement.all();
			}

			if (Object.keys(bind).length > 0) statement.run(bind);
			else statement.run();
		},
		close(): void {
			sqlite.close();
		},
	};
}

function conceptFile(path: string): TestFile {
	return { path, stat: { mtime: Date.parse('2026-08-21T00:00:00.000Z') } };
}

function conceptFrontmatter(curie: string, title = curie): Record<string, unknown> {
	return {
		_crosswalker: { produced_at: '2026-08-21T00:00:00.000Z' },
		kind: 'concept',
		curie,
		title,
	};
}

function createApp(entries: Array<[TestFile, Record<string, unknown>]>): unknown {
	const frontmatterByPath = new Map(entries.map(([file, frontmatter]) => [file.path, frontmatter]));
	return {
		vault: { getMarkdownFiles: () => entries.map(([file]) => file) },
		metadataCache: {
			getFileCache: (file: TestFile) => ({ frontmatter: frontmatterByPath.get(file.path) }),
		},
	};
}

function queryRows(db: TestDb, sql: string, bind: Record<string, unknown> = {}): unknown[][] {
	return db.exec({
		sql,
		bind,
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
}

function seedClosureCache(db: TestDb): void {
	db.exec(`
		INSERT INTO closure_cache
			(subject_id, predicate_id, object_id, shortest_depth, computed_at)
		VALUES ('example:A', 'is_broader_than', 'example:B', 1, '2026-08-21T00:00:00.000Z');
		INSERT INTO closure_cache_state
			(subject_id, predicate_id, computed_max_depth, computed_at)
		VALUES ('example:A', 'is_broader_than', 3, '2026-08-21T00:00:00.000Z');
	`);
}

async function fullProjection(db: TestDb, entries: Array<[TestFile, Record<string, unknown>]>): Promise<void> {
	const result = await projectFromTier1(createApp(entries) as any, db, {
		yieldEvery: 100,
		projectionMode: 'full',
	});
	expect(result.success).toBe(true);
}

describe('Tier 2 full-projection pruning', () => {
	let db: TestDb;

	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	it('removes a derived row when its source note no longer exists', async () => {
		const file = conceptFile('Frameworks/example/A.md');
		await fullProjection(db, [[file, conceptFrontmatter('example:A')]]);
		expect(queryRows(db, `SELECT curie FROM concepts`)).toEqual([['example:A']]);

		await fullProjection(db, []);

		expect(queryRows(db, `SELECT curie FROM concepts`)).toEqual([]);
		expect(queryRows(db, `SELECT id FROM ontologies`)).toEqual([]);
	});

	it('does not prune during a path-filtered partial projection', async () => {
		const fileA = conceptFile('Frameworks/example/A.md');
		const fileB = conceptFile('Frameworks/example/B.md');
		const entries: Array<[TestFile, Record<string, unknown>]> = [
			[fileA, conceptFrontmatter('example:A')],
			[fileB, conceptFrontmatter('example:B')],
		];
		await fullProjection(db, entries);

		const result = await projectFromTier1(createApp(entries) as any, db, {
			yieldEvery: 100,
			projectionMode: 'partial',
			pathFilter: (path) => path.endsWith('/A.md'),
		});

		expect(result.success).toBe(true);
		expect(queryRows(db, `SELECT curie FROM concepts ORDER BY curie`)).toEqual([
			['example:A'],
			['example:B'],
		]);
	});

	it('does not prune when a full projection has a row error', async () => {
		const file = conceptFile('Frameworks/example/A.md');
		await fullProjection(db, [[file, conceptFrontmatter('example:A')]]);

		const malformed = conceptFile('Frameworks/example/malformed.md');
		const result = await projectFromTier1(
			createApp([[malformed, { _crosswalker: { produced_at: '2026-08-21T00:00:00.000Z' } }]]) as any,
			db,
			{ yieldEvery: 100, projectionMode: 'full' },
		);

		expect(result.success).toBe(false);
		expect(queryRows(db, `SELECT curie FROM concepts`)).toEqual([['example:A']]);
	});

	it('preserves identity when a concept moves to a new vault path', async () => {
		const original = conceptFile('Frameworks/example/Old/A.md');
		await fullProjection(db, [[original, conceptFrontmatter('example:A')]]);
		seedClosureCache(db);

		const moved = conceptFile('Frameworks/example/New/A.md');
		await fullProjection(db, [[moved, conceptFrontmatter('example:A', 'Moved A')]]);

		expect(queryRows(db, `SELECT curie, vault_path, title FROM concepts`)).toEqual([
			['example:A', 'Frameworks/example/New/A.md', 'Moved A'],
		]);
		// A move updates the row by stable identity; it is not a prune event.
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache`)).toEqual([[1]]);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache_state`)).toEqual([[1]]);
	});

	it('invalidates closure rows and coverage state when pruning', async () => {
		const file = conceptFile('Frameworks/example/A.md');
		await fullProjection(db, [[file, conceptFrontmatter('example:A')]]);
		seedClosureCache(db);

		await fullProjection(db, []);

		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache`)).toEqual([[0]]);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache_state`)).toEqual([[0]]);
	});
});

describe('Tier 2 pruning fails closed on unreadable frontmatter', () => {
	/**
	 * Regression for a proven deletion bug. `readFrontmatter` returns null both for an
	 * ordinary note with no frontmatter (safe to skip) and for a note whose frontmatter
	 * block exists but did not parse. The second case was counted as a harmless skip,
	 * left no seen-mark, and its rows were pruned while the note still existed.
	 * `frontmatterPosition` is the discriminator: Obsidian records it whenever a note
	 * HAS a frontmatter block, parsed or not.
	 */
	it('refuses to prune a note whose frontmatter block is present but unparsed', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db);

			const file = conceptFile('Frameworks/example/A.md');
			await fullProjection(db, [[file, conceptFrontmatter('example:A')]]);
			expect(queryRows(db, `SELECT curie FROM concepts`)).toEqual([['example:A']]);

			// Same file still present, but its frontmatter no longer parses.
			const app = {
				vault: { getMarkdownFiles: () => [file] },
				metadataCache: {
					getFileCache: () => ({ frontmatterPosition: { start: { line: 0 }, end: { line: 2 } } }),
				},
			};
			const result = await projectFromTier1(app as any, db, { projectionMode: 'full' });

			// Unknown must fail closed: an error is raised and NOTHING is pruned.
			expect(result.counts.errors).toBeGreaterThan(0);
			expect(queryRows(db, `SELECT curie FROM concepts`)).toEqual([['example:A']]);
		} finally {
			db.close();
		}
	});

	it('still skips an ordinary note that genuinely has no frontmatter block', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db);
			const file = conceptFile('Notes/Plain.md');
			// No frontmatterPosition: the note positively has no frontmatter block, so
			// it is not ours and skipping it must not block pruning.
			const app = {
				vault: { getMarkdownFiles: () => [file] },
				metadataCache: { getFileCache: () => ({}) },
			};

			const result = await projectFromTier1(app as any, db, { projectionMode: 'full' });

			expect(result.counts.errors).toBe(0);
			expect(result.counts.skipped).toBe(1);
		} finally {
			db.close();
		}
	});
});
