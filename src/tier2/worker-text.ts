import workerAsset from 'virtual:tier2-worker-text';

/** The Tier 2 Worker program, bundled from worker-source.ts and inlined by the build (W2). */
export function getTier2WorkerText(): string {
	return workerAsset.payload;
}
