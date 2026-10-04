/** Jest stand-in for the inlined Worker program. Unit tests drive the real handler in-process instead. */
export default {
	cwTier2Worker: 'worker-text' as const,
	payload: '/* cw-tier2-worker-v1 test stub */',
};
