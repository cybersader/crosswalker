/**
 * Main-thread side of the Tier 2 Worker (W1, W2, W6; 2026-10-03).
 *
 * `Tier2WorkerHost` owns one dedicated Worker built from text inlined in
 * main.js, and one request queue: requests carry incrementing ids and exactly
 * one is in flight at a time, so statements reach sqlite in the order callers
 * issued them. `WorkerDb` is the `Tier2Db` a caller holds; it is a thin view of
 * a host with an open database.
 *
 * Lifecycle (W6). Closing a `WorkerDb` closes the database and awaits the
 * acknowledgement; the Worker itself stays up for the plugin's lifetime and is
 * terminated by `shutdown()` at plugin unload. Deleting the index file is a
 * request to that same Worker after the close is acknowledged, which keeps the
 * await-close-then-delete order and avoids handing the pool's file handles to a
 * second Worker while the first is still letting go of them.
 */

import type { ExecInput, ExecSpec, Rows, Tier2Db, Tier2DbInfo } from './db';
import { Tier2DbError } from './db';
import {
	TIER2_WORKER_PROTOCOL,
	type Tier2WorkerInitResult,
	type Tier2WorkerRequest,
	type Tier2WorkerResponse,
	type Tier2WorkerUnlinkResult,
} from './worker-source';

/** The slice of the Worker API the host needs. A fake implements it in tests. */
export interface Tier2WorkerEndpoint {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	terminate(): void;
}

export type Tier2WorkerFactory = () => Tier2WorkerEndpoint;

/** Bound on how long a Worker may take to load sqlite before we fall back. */
const INIT_TIMEOUT_MS = 20000;
/** W6: unload waits this long for the close acknowledgement, then terminates. */
export const UNLOAD_GRACE_MS = 500;

let factoryOverride: Tier2WorkerFactory | null = null;

/**
 * Replace how Workers are created. Unit tests install an in-process transport
 * that runs the real Worker handler; `null` restores the default.
 */
export function setTier2WorkerFactory(factory: Tier2WorkerFactory | null): void {
	factoryOverride = factory;
}

/** True when a Worker can be constructed in this environment at all. */
export function tier2WorkerSupported(): boolean {
	return factoryOverride !== null || (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function');
}

/** Build the default module Worker from the inlined program text (W2). */
function defaultFactory(workerText: string): Tier2WorkerEndpoint {
	const url = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
	try {
		const worker = new Worker(url, { type: 'module', name: 'crosswalker-search-index' });
		// The Worker fetches its script asynchronously; revoking the URL right
		// away can race that fetch, so it is released once the Worker answers or
		// after a generous delay, whichever comes first.
		setTimeout(() => URL.revokeObjectURL(url), INIT_TIMEOUT_MS);
		return worker as unknown as Tier2WorkerEndpoint;
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/** Strip the id so a request literal type-checks before the host assigns one. */
type Outgoing<T> = T extends { id: number } ? Omit<T, 'id'> : never;

export class Tier2WorkerHost {
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private tail: Promise<unknown> = Promise.resolve();
	private deadReason: Error | null = null;
	private initResult: Tier2WorkerInitResult | null = null;

	private constructor(private readonly endpoint: Tier2WorkerEndpoint) {
		endpoint.onmessage = (event) => this.onResponse(event.data as Tier2WorkerResponse);
		endpoint.onerror = (event) => {
			const detail = event instanceof Error
				? event.message
				: String((event as { message?: unknown } | null)?.message ?? 'unknown error');
			this.fail(new Tier2DbError(`The search index worker stopped: ${detail}`));
		};
	}

	/**
	 * Start a Worker and load sqlite into it. Resolves once the Worker reports
	 * whether persistent storage is available; rejects when no Worker could be
	 * created or it never answered.
	 */
	static async start(options: {
		workerText: string;
		mjsText: string;
		wasmBytes: Uint8Array;
		poolDirectory: string;
	}): Promise<Tier2WorkerHost> {
		const endpoint = factoryOverride ? factoryOverride() : defaultFactory(options.workerText);
		const host = new Tier2WorkerHost(endpoint);
		let timer: ReturnType<typeof setTimeout> | null = null;
		try {
			const init = host.request<Tier2WorkerInitResult>(
				{
					type: 'init',
					protocol: TIER2_WORKER_PROTOCOL,
					mjsText: options.mjsText,
					wasmBytes: options.wasmBytes,
					poolDirectory: options.poolDirectory,
				},
				// The wasm bytes are transferred, not copied (W2).
				[options.wasmBytes.buffer as ArrayBuffer],
			);
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Tier2DbError('The search index worker did not start in time')),
					INIT_TIMEOUT_MS,
				);
			});
			host.initResult = await Promise.race([init, timeout]);
			return host;
		} catch (error) {
			host.terminate();
			throw error;
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	get poolAvailable(): boolean {
		return this.initResult?.poolAvailable === true;
	}

	get poolError(): Error | null {
		const raw = this.initResult?.poolError;
		if (!raw) return null;
		const error = new Error(raw.message);
		error.name = raw.name;
		return error;
	}

	get sqliteVersion(): string {
		return this.initResult?.sqliteVersion ?? '(unknown)';
	}

	get dead(): boolean {
		return this.deadReason !== null;
	}

	/** Open the index file on the persistent pool. */
	async open(sidecarPath: string): Promise<WorkerDb> {
		const info = await this.request<Tier2DbInfo>({ type: 'open', sidecarPath });
		return new WorkerDb(this, info);
	}

	/** Delete pool entries for `key` and its journal siblings (W6). */
	unlink(key: string): Promise<Tier2WorkerUnlinkResult> {
		return this.request<Tier2WorkerUnlinkResult>({ type: 'unlink', key });
	}

	/**
	 * Queue one request. Exactly one request is in flight at a time; the next is
	 * posted only after the previous one settled.
	 */
	request<T>(message: Outgoing<Tier2WorkerRequest>, transfer?: Transferable[]): Promise<T> {
		const send = (): Promise<T> => new Promise<T>((resolve, reject) => {
			if (this.deadReason) {
				reject(this.deadReason);
				return;
			}
			this.nextId += 1;
			const id = this.nextId;
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			try {
				this.endpoint.postMessage({ ...message, id }, transfer ?? []);
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
		const result = this.tail.then(send, send);
		this.tail = result.catch(() => undefined);
		return result;
	}

	/**
	 * W6 unload: ask for a close, then terminate after the acknowledgement or
	 * after `graceMs`, whichever comes first. Never throws.
	 */
	async shutdown(graceMs: number = UNLOAD_GRACE_MS): Promise<void> {
		if (this.deadReason) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); });
		try {
			await Promise.race([this.request({ type: 'close' }).catch(() => undefined), grace]);
		} finally {
			if (timer !== null) clearTimeout(timer);
			this.terminate();
		}
	}

	/** Terminate now. Pending requests reject. */
	terminate(): void {
		this.fail(new Tier2DbError('The search index worker was stopped'));
		try { this.endpoint.terminate(); } catch { /* already gone */ }
	}

	private fail(reason: Error): void {
		if (!this.deadReason) this.deadReason = reason;
		for (const [, pending] of this.pending) pending.reject(this.deadReason);
		this.pending.clear();
	}

	private onResponse(response: Tier2WorkerResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(new Tier2DbError(response.error.message, {
				name: response.error.name,
				statementIndex: response.error.statementIndex,
				sql: response.error.sql,
			}));
		}
	}
}

/** A `Tier2Db` whose database lives in a host Worker. */
export class WorkerDb implements Tier2Db {
	private closed = false;

	constructor(
		readonly host: Tier2WorkerHost,
		private readonly infoValue: Tier2DbInfo,
	) {}

	/**
	 * Convenience for one-off use: start a Worker and open `sidecarPath` on its
	 * persistent pool. Rejects when the pool is unavailable, after stopping the
	 * Worker. The sidecar keeps one long-lived host instead.
	 */
	static async create(options: {
		workerText: string;
		mjsText: string;
		wasmBytes: Uint8Array;
		poolDirectory: string;
		sidecarPath: string;
	}): Promise<WorkerDb> {
		const host = await Tier2WorkerHost.start(options);
		if (!host.poolAvailable) {
			const error = host.poolError ?? new Error('Persistent storage is unavailable');
			host.terminate();
			throw error;
		}
		try {
			return await host.open(options.sidecarPath);
		} catch (error) {
			host.terminate();
			throw error;
		}
	}

	exec(input: ExecSpec & { returnValue: 'resultRows' }): Promise<Rows>;
	exec(input: ExecInput): Promise<Rows | void>;
	exec(input: ExecInput): Promise<Rows | void> {
		if (this.closed) return Promise.reject(new Tier2DbError('The search index is closed'));
		return this.host.request<Rows | undefined>({ type: 'exec', input }).then((rows) => rows ?? undefined);
	}

	execBatch(statements: ExecInput[]): Promise<void> {
		if (this.closed) return Promise.reject(new Tier2DbError('The search index is closed'));
		if (statements.length === 0) return Promise.resolve();
		return this.host.request<void>({ type: 'execBatch', statements });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.host.request({ type: 'close' });
	}

	info(): Tier2DbInfo {
		return { ...this.infoValue };
	}
}
