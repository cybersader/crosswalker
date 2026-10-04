/**
 * in-process-worker.ts — a fake Worker transport that runs the REAL Tier 2
 * Worker handler (`src/tier2/worker-source.ts`) inside the Jest process.
 *
 * Messages cross a macrotask boundary in both directions and are structured-
 * cloned with `v8.serialize`, so anything that could not cross a real
 * postMessage (a DB object, a function) fails here too. The handler loads
 * sqlite through the same Blob-URL `import()` it uses in a Worker; under
 * ts-jest that becomes `require(<url>)`, so tests point `URL.createObjectURL`
 * at `fake-sqlite-wasm.ts` exactly as the main-thread sidecar tests always have.
 */

import { serialize, deserialize } from 'node:v8';
import { createTier2WorkerHandler, type Tier2WorkerRequest, type Tier2WorkerResponse } from '../../src/tier2/worker-source';
import type { Tier2WorkerEndpoint, Tier2WorkerFactory } from '../../src/tier2/worker-db';

function clone<T>(value: T): T {
	return deserialize(serialize(value)) as T;
}

export interface InProcessWorker extends Tier2WorkerEndpoint {
	/** Every request the main side posted, in order (cloned). */
	readonly sent: Tier2WorkerRequest[];
	readonly terminated: boolean;
	/** Simulate the Worker crashing: fires `onerror` and stops delivering. */
	crash(message: string): void;
	/** Hold replies until `release()`; lets a test pile up concurrent requests. */
	hold(): void;
	release(): void;
}

export interface InProcessWorkerFactory extends Tier2WorkerFactory {
	/** Every Worker this factory created, oldest first. */
	readonly created: InProcessWorker[];
}

export function createInProcessWorkerFactory(): InProcessWorkerFactory {
	const created: InProcessWorker[] = [];
	const factory = (() => {
		let terminated = false;
		let held = false;
		const heldReplies: Tier2WorkerResponse[] = [];
		const sent: Tier2WorkerRequest[] = [];

		const deliver = (reply: Tier2WorkerResponse): void => {
			setTimeout(() => {
				if (!terminated) endpoint.onmessage?.({ data: reply });
			}, 0);
		};
		const handler = createTier2WorkerHandler((message) => {
			const reply = clone(message);
			if (held) heldReplies.push(reply);
			else deliver(reply);
		});

		const endpoint: InProcessWorker = {
			onmessage: null,
			onerror: null,
			sent,
			get terminated() { return terminated; },
			postMessage(message: unknown): void {
				if (terminated) return;
				const request = clone(message) as Tier2WorkerRequest;
				sent.push(request);
				setTimeout(() => {
					if (!terminated) void handler(request);
				}, 0);
			},
			terminate(): void {
				terminated = true;
			},
			crash(message: string): void {
				const onerror = endpoint.onerror;
				terminated = true;
				onerror?.({ message });
			},
			hold(): void {
				held = true;
			},
			release(): void {
				held = false;
				for (const reply of heldReplies.splice(0)) deliver(reply);
			},
		};
		created.push(endpoint);
		return endpoint;
	}) as InProcessWorkerFactory;
	Object.defineProperty(factory, 'created', { get: () => created });
	return factory;
}
