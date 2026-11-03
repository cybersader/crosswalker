/** Pure decisions shared by the report, cleanup, and focused tests. */
export function isRecent({ lastActivity, now }) {
  // Unknown activity is protected, including repositories without reflogs.
  return !Number.isFinite(lastActivity) || !Number.isFinite(now) || now - lastActivity < 24 * 60 * 60;
}

export function classifyBranch({ name, merged, commitTime, now, lastActivity, currentBranch, kept = false, checkedOut = false }) {
  const recent = isRecent({ lastActivity, now });
  return {
    staleUnmerged: !merged && now - commitTime >= 30 * 24 * 60 * 60,
    recent,
    removable: merged && !recent && name !== 'main' && name !== currentBranch && !kept && !checkedOut,
  };
}

export function classifyWorktree({ branch, merged, dirty, locked, lastActivity, now, kept = false, current = false, primary = false, containsWorktree = false, currentBranch }) {
  const state = locked ? 'locked' : dirty ? 'dirty' : !branch || !merged ? 'unmerged'
    : isRecent({ lastActivity, now }) ? 'recent' : 'clean+merged';
  return {
    state,
    removable: state === 'clean+merged' && branch !== 'main' && branch !== currentBranch
      && !kept && !current && !primary && !containsWorktree,
  };
}
