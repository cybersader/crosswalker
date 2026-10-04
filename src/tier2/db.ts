/**
 * The one seam every Tier 2 reader and writer goes through (W1, 2026-10-03).
 *
 * Two implementations share this contract:
 *
 *   - `WorkerDb` (worker-db.ts): sqlite and the persistent OPFS pool live in a
 *     dedicated Worker, because only a Worker can create the synchronous file
 *     handles the persistent pool needs. This is the default at runtime.
 *   - `LocalDb` (this file): a main-thread sqlite handle wrapped to the same
 *     async shape. Used as the in-memory runtime fallback and by unit tests.
 *
 * The statement shape is the sqlite-wasm OO1 `exec` input the codebase already
 * used everywhere (a SQL string, or `{ sql, bind, rowMode, returnValue }`), so
 * converting a call site is one `await`. `execBatch` runs its statements in one
 * SAVEPOINT through `runBatch`, the same function the Worker runs, so a unit
 * test against `LocalDb` exercises the exact batch semantics the Worker has.
 *
 * Pure module: no Obsidian import, no DOM. The Worker bundle imports it.
 */

/** Result rows in `rowMode: 'array'` form. */
export type Rows = unknown[][];

/** Named (`$name`) or positional bind values, exactly as sqlite-wasm takes them. */
export type Bind = Record<string, unknown> | unknown[];

/** One statement: a SQL string (may hold several statements) or an OO1 exec spec. */
export interface ExecSpec {
	sql: string;
	bind?: Bind;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}

export type ExecInput = string | ExecSpec;

/** What a reader may say about where its rows live. */
export interface Tier2DbInfo {
	/** sqlite VFS name the database opened on (for example `opfs-sahpool`). */
	vfs: string;
	/** True only when the rows survive a restart. */
	persistent: boolean;
	/** sqlite's own name for the open file; empty for an in-memory database. */
	filename: string;
}

export interface Tier2Db {
	exec(input: ExecSpec & { returnValue: 'resultRows' }): Promise<Rows>;
	exec(input: ExecInput): Promise<Rows | void>;
	/**
	 * Run every statement inside one SAVEPOINT. Either all of them take effect or
	 * none do. A failure rejects with a `Tier2DbError` whose `statementIndex`
	 * names the statement that failed.
	 */
	execBatch(statements: ExecInput[]): Promise<void>;
	close(): Promise<void>;
	info(): Tier2DbInfo;
}

/**
 * A sqlite failure, carried across the Worker boundary intact. `message` is
 * sqlite's own message, unchanged, so code that reported `err.message` before
 * this seam existed reports the same text now.
 */
export class Tier2DbError extends Error {
	/** Index into the `execBatch` statement list, when the failure was in a batch. */
	readonly statementIndex: number | null;
	/** The failing statement's SQL, truncated, for diagnostics. */
	readonly sql: string | null;
	constructor(message: string, options: { statementIndex?: number | null; sql?: string | null; name?: string } = {}) {
		super(message);
		this.name = options.name && options.name !== 'Error' ? options.name : 'Tier2DbError';
		this.statementIndex = options.statementIndex ?? null;
		this.sql = options.sql ?? null;
	}
}

/** The raw OO1-shaped handle `LocalDb` and the Worker both drive. */
export interface RawExecDb {
	exec(input: ExecInput): unknown;
	close?(): unknown;
	dbVfsName?(): string | undefined;
	dbFilename?(): string | undefined;
}

const BATCH_SAVEPOINT = 'cw_tier2_batch';
const SQL_EXCERPT_LENGTH = 200;

function sqlOf(input: ExecInput): string {
	return typeof input === 'string' ? input : input.sql;
}

function excerpt(sql: string): string {
	const flat = sql.replace(/\s+/g, ' ').trim();
	return flat.length > SQL_EXCERPT_LENGTH ? `${flat.slice(0, SQL_EXCERPT_LENGTH)}...` : flat;
}

/**
 * Run one statement on a raw handle and normalize the return value: rows only
 * when the caller asked for them, otherwise `undefined`. (OO1 `exec` returns the
 * DB object itself for a plain string, which must never cross a postMessage.)
 */
export function runOne(db: RawExecDb, input: ExecInput): Rows | undefined {
	if (typeof input === 'string') {
		db.exec(input);
		return undefined;
	}
	const result = db.exec(input);
	return input.returnValue === 'resultRows' ? (result as Rows) : undefined;
}

/**
 * The batch contract, shared verbatim by `LocalDb` and the Worker: one
 * SAVEPOINT, every statement in order, RELEASE on success, ROLLBACK TO plus
 * RELEASE on the first failure, and the failure rethrown with its index.
 * Savepoints nest, so a batch inside an outer transaction stays correct.
 */
export function runBatch(db: RawExecDb, statements: ExecInput[]): void {
	if (statements.length === 0) return;
	db.exec(`SAVEPOINT ${BATCH_SAVEPOINT}`);
	let index = 0;
	try {
		for (; index < statements.length; index += 1) runOne(db, statements[index]);
	} catch (error) {
		try {
			db.exec(`ROLLBACK TO ${BATCH_SAVEPOINT}`);
			db.exec(`RELEASE ${BATCH_SAVEPOINT}`);
		} catch {
			// The original failure is the one worth reporting.
		}
		throw toTier2DbError(error, { statementIndex: index, sql: excerpt(sqlOf(statements[index])) });
	}
	db.exec(`RELEASE ${BATCH_SAVEPOINT}`);
}

/** Wrap any thrown value as a `Tier2DbError` without changing its message. */
export function toTier2DbError(error: unknown, extra: { statementIndex?: number | null; sql?: string | null } = {}): Tier2DbError {
	if (error instanceof Tier2DbError && extra.statementIndex === undefined) return error;
	const message = error instanceof Error ? error.message : String(error);
	const name = error instanceof Error ? error.name : undefined;
	return new Tier2DbError(message, { ...extra, name });
}

/**
 * Main-thread implementation. Wraps a synchronous OO1-shaped handle in the
 * async contract. Each call settles on a later microtask, like a Worker reply,
 * so code that forgets an `await` fails here too instead of passing by luck.
 */
export class LocalDb implements Tier2Db {
	private closed = false;

	constructor(
		private readonly raw: RawExecDb,
		private readonly infoValue: Tier2DbInfo = describeRaw(raw),
	) {}

	exec(input: ExecSpec & { returnValue: 'resultRows' }): Promise<Rows>;
	exec(input: ExecInput): Promise<Rows | void>;
	async exec(input: ExecInput): Promise<Rows | void> {
		return runOne(this.raw, input);
	}

	async execBatch(statements: ExecInput[]): Promise<void> {
		runBatch(this.raw, statements);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.raw.close?.();
	}

	info(): Tier2DbInfo {
		return { ...this.infoValue };
	}
}

function describeRaw(raw: RawExecDb): Tier2DbInfo {
	let vfs = '';
	let filename = '';
	try { vfs = raw.dbVfsName?.() ?? ''; } catch { vfs = ''; }
	try { filename = raw.dbFilename?.() ?? ''; } catch { filename = ''; }
	return { vfs: vfs || 'memory', persistent: false, filename };
}

/** True when `value` already speaks the async contract. */
export function isTier2Db(value: unknown): value is Tier2Db {
	return Boolean(value)
		&& typeof (value as Tier2Db).exec === 'function'
		&& typeof (value as Tier2Db).execBatch === 'function'
		&& typeof (value as Tier2Db).info === 'function';
}

/**
 * Accept either contract at a public entry point. A raw OO1-shaped handle (the
 * Jest `node:sqlite` shims, or a caller holding a main-thread DB) is wrapped in
 * `LocalDb`; a `Tier2Db` passes through untouched.
 */
export function asTier2Db(db: Tier2Db | RawExecDb): Tier2Db {
	return isTier2Db(db) ? db : new LocalDb(db as RawExecDb);
}

/** Anything a Tier 2 entry point accepts. */
export type Tier2DbLike = Tier2Db | RawExecDb;
