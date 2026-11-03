#!/usr/bin/env node
/**
 * Report by default; --apply removes only merged local branches and their clean,
 * unlocked worktrees. Never forces removal or deletes remote branches.
 *
 *   node scripts/branch-hygiene.mjs
 *   node scripts/branch-hygiene.mjs --apply --keep topic --keep path/to/worktree
 *
 * Per-user .branch-hygiene-keep in the primary checkout supplements --keep (one
 * branch or path per line, whole-line # comments only). Paths use that checkout.
 * Activity within 24 hours, or unknown activity, is retained as recent.
 * A kept worktree also protects its branch. Detached/unreadable worktrees stay.
 * Apply rechecks eligibility immediately before each operation; do not run it
 * concurrently with other branch/worktree maintenance.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyBranch, classifyWorktree } from './lib/branch-hygiene.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    // Do not refresh indexes during report-only status probes.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function within(path, parent) {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function parseArgs(args) {
  const options = { apply: false, keep: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--keep' && args[i + 1] && !args[i + 1].startsWith('--')) options.keep.push(args[++i]);
    else throw new Error('Use no options for a report, or --apply and repeatable --keep <path-or-branch>.');
  }
  return options;
}

function readKeeps(root, cliKeeps) {
  let content = '';
  try { content = readFileSync(join(root, '.branch-hygiene-keep'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read .branch-hygiene-keep. Fix its permissions before running hygiene.'); }
  const fileKeeps = content.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  const entries = [...cliKeeps, ...fileKeeps];
  return {
    branch: name => entries.includes(name) || entries.includes(`refs/heads/${name}`),
    path: path => entries.some(entry => {
      const keptPath = canonical(resolve(root, entry));
      // Also protect a worktree containing a kept path or inside a kept folder.
      return within(path, keptPath) || within(keptPath, path);
    }),
  };
}

function worktrees(root) {
  // -z avoids C-style quoting of paths containing spaces, tabs or newlines.
  return git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0');
    const value = key => fields.find(field => field.startsWith(`${key} `))?.slice(key.length + 1);
    return {
      path: canonical(value('worktree')),
      sha: value('HEAD'),
      branch: value('branch')?.replace(/^refs\/heads\//, ''),
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')),
      bare: fields.includes('bare'),
    };
  });
}

function gitDir(worktree) {
  return resolve(worktree.path, git(worktree.path, ['rev-parse', '--git-dir']).trim());
}

function branchActivity(root, branch) {
  if (!branch) return undefined;
  try {
    // %ct is the commit date, not the reflog entry date. A newly created branch
    // at an old commit must still be protected.
    const selector = git(root, ['reflog', 'show', '-n1', '--date=unix', '--format=%gD', `refs/heads/${branch}`]).trim();
    const match = selector.match(/@\{(\d+)\}$/);
    return match ? Number(match[1]) : undefined;
  } catch { return undefined; }
}

function worktreeActivity(root, worktree) {
  try {
    const dir = gitDir(worktree);
    const branchTime = branchActivity(root, worktree.branch);
    if (!Number.isFinite(branchTime)) return undefined;
    return Math.max(branchTime, ...['index', 'HEAD'].map(name => statSync(join(dir, name)).mtimeMs / 1000));
  } catch { return undefined; }
}

function dirty(worktree) {
  if (worktree.bare) return true;
  try {
    // Missing/stale registrations must not accidentally probe a parent checkout.
    if (canonical(git(worktree.path, ['rev-parse', '--show-toplevel']).trim()) !== worktree.path) return true;
    const dir = gitDir(worktree);
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
      try { statSync(join(dir, name)); return true; }
      catch (error) { if (error.code !== 'ENOENT') return true; }
    }
    // Hidden index flags can conceal tracked modifications from status.
    if (git(worktree.path, ['ls-files', '-v', '-z']).split('\0').some(entry => /^[a-zS] /.test(entry))) return true;
    // Ignored scratch files are still local work (for example .workspace/).
    // Treat them as dirty rather than silently discarding them with a worktree.
    return git(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']).length > 0;
  } catch { return true; } // Unknown is not clean.
}

function merged(root, sha) {
  try { git(root, ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']); return true; }
  catch (error) {
    if (error.status === 1) return false;
    throw new Error('Cannot check merge ancestry against origin/main. Repair the repository before applying hygiene.');
  }
}

function inspectWorktree(root, item, all, keeps, currentBranch) {
  const kept = keeps.branch(item.branch) || keeps.path(item.path);
  return {
    ...item, kept,
    ...classifyWorktree({
      ...item, kept, currentBranch, dirty: item.locked ? false : dirty(item),
      now: Date.now() / 1000, lastActivity: worktreeActivity(root, item),
      merged: Boolean(item.branch) && merged(root, item.sha),
      current: item.path === root, primary: item.path === all[0]?.path,
      containsWorktree: all.some(other => other.path !== item.path && within(other.path, item.path)),
    }),
  };
}

function inventory(root, options, currentBranch) {
  const all = worktrees(root);
  const keeps = readKeeps(all[0].path, options.keep);
  const trees = all.map(item => inspectWorktree(root, item, all, keeps, currentBranch));
  const mergedRefs = new Set(git(root, ['for-each-ref', '--merged=refs/remotes/origin/main', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']).trim().split('\n'));
  const now = Date.now() / 1000;
  const refs = git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(symref)', 'refs/heads', 'refs/remotes/origin'])
    .trim().split('\n').filter(Boolean).map(line => {
      const [ref, sha, timestamp, symref] = line.split('\0');
      return { ref, sha, commitTime: Number(timestamp), symref, merged: mergedRefs.has(ref) };
    }).filter(item => !item.symref);
  const branches = refs.filter(item => item.ref.startsWith('refs/heads/')).map(item => {
    const name = item.ref.slice('refs/heads/'.length);
    const kept = keeps.branch(name) || trees.some(tree => tree.branch === name && tree.kept);
    return {
      ...item, name, kept, checkedOut: trees.some(tree => tree.branch === name),
      ...classifyBranch({ ...item, name, now, lastActivity: branchActivity(root, name), currentBranch, kept, checkedOut: trees.some(tree => tree.branch === name) }),
    };
  });
  return { trees, branches, remotes: refs.filter(item => item.ref.startsWith('refs/remotes/') && item.merged && item.ref !== 'refs/remotes/origin/main') };
}

function section(title, items) {
  console.log(`\n${title}: ${items.length}`);
  for (const item of items) console.log(`  ${item}`);
}

function report(snapshot, options, currentBranch) {
  console.log(`Branch hygiene (${options.apply ? 'apply' : 'report only'}). Base: origin/main. Current branch: ${currentBranch || '(detached)'}.`);
  section('Local branches merged into origin/main', snapshot.branches.filter(item => item.merged).map(item =>
    `${item.name}${item.recent ? ' [recent]' : ''}${item.checkedOut || item.kept || item.name === 'main' || item.name === currentBranch ? ' [protected]' : ''}`));
  section('Unmerged local branches with no commit in 30+ days (report only)', snapshot.branches.filter(item => item.staleUnmerged).map(item => item.name));
  section('Worktrees', snapshot.trees.map(item => `${item.state}: ${item.path} (${item.branch || 'detached/bare'})${item.removable ? ' [eligible]' : ' [retained]'}`));
  section('Remote branches merged into origin/main (report only)', snapshot.remotes.map(item => item.ref.slice('refs/remotes/'.length)));
  if (!options.apply) console.log('\nNo branches or worktrees deleted. Review this report before opting into --apply.');
}

function apply(root, snapshot, options, currentBranch) {
  const date = new Date().toISOString();
  const primaryRoot = worktrees(root)[0].path;
  const manifest = join(primaryRoot, '.workspace', `branch-hygiene-${date.slice(0, 10)}.txt`);
  let started = false;
  const record = (sha, branch) => {
    if (!started) {
      mkdirSync(join(primaryRoot, '.workspace'), { recursive: true });
      appendFileSync(manifest, `\n# Branch hygiene ${date}\n# Restore each entry with: git branch <branch> <sha>\n# Only the tip SHA is recorded; branch reflogs are dropped on delete.\n# Entries: <sha> <branch> (recorded before attempting removal)\n`);
      started = true;
    }
    appendFileSync(manifest, `${sha} ${branch}\n`);
  };
  let removedTrees = 0;
  let removedBranches = 0;
  let failures = 0;
  // Worktrees first. Re-read locks, keep entries, status, ancestry and nesting.
  for (const candidate of snapshot.trees.filter(item => item.removable)) {
    const all = worktrees(root);
    const item = all.find(tree => tree.path === candidate.path);
    if (!item || item.sha !== candidate.sha || item.branch !== candidate.branch) continue;
    const checked = inspectWorktree(root, item, all, readKeeps(primaryRoot, options.keep), currentBranch);
    if (!checked.removable) continue;
    let ownedLock = false;
    try {
      git(root, ['worktree', 'lock', '--reason', 'branch hygiene recheck', '--', item.path]);
      ownedLock = true;
      // Only clear our lock. Recheck ignored files and hidden/in-progress work
      // while registry maintenance is blocked, then unlock for safe removal.
      let eligible;
      try {
        const latest = worktrees(root);
        const registered = latest.find(tree => tree.path === item.path);
        eligible = registered && registered.sha === item.sha && registered.branch === item.branch
          && inspectWorktree(root, { ...registered, locked: false }, latest, readKeeps(primaryRoot, options.keep), currentBranch).removable;
      } finally {
        git(root, ['worktree', 'unlock', '--', item.path]);
        ownedLock = false;
      }
      if (!eligible) continue;
      record(item.sha, item.branch);
      git(root, ['worktree', 'remove', '--', item.path]);
      console.log(`Removed worktree: ${item.path}`);
      removedTrees++;
    } catch {
      console.error(`Kept worktree ${item.path}: Git refused safe removal. Inspect it manually; no force was used.`);
      failures++;
    } finally {
      if (ownedLock) {
        try { git(root, ['worktree', 'unlock', '--', item.path]); }
        catch { console.error(`Could not release hygiene lock on ${item.path}. Inspect and unlock it manually.`); failures++; }
      }
    }
  }
  for (const candidate of snapshot.branches.filter(item => item.merged)) {
    const all = worktrees(root);
    const keeps = readKeeps(primaryRoot, options.keep);
    const kept = keeps.branch(candidate.name) || all.some(tree => tree.branch === candidate.name && keeps.path(tree.path));
    const decision = classifyBranch({ ...candidate, now: Date.now() / 1000, lastActivity: branchActivity(root, candidate.name), currentBranch, kept, checkedOut: all.some(tree => tree.branch === candidate.name) });
    if (!decision.removable) continue;
    let sha;
    try { sha = git(root, ['rev-parse', '--verify', candidate.ref]).trim(); } catch { continue; }
    if (sha !== candidate.sha || !merged(root, sha)) continue;
    record(sha, candidate.name);
    try {
      git(root, ['update-ref', '-d', '--', candidate.ref, sha]);
      console.log(`Deleted local branch: ${candidate.name}`);
      removedBranches++;
    } catch {
      console.error(`Kept branch ${candidate.name}: Git refused safe deletion. Check for a changed ref or repository lock, then run the report again; no force was used.`);
      failures++;
    }
  }
  console.log(`\nRemoved worktrees: ${removedTrees}. Deleted local branches: ${removedBranches}. Refused operations: ${failures}.`);
  if (started) console.log(`Restore manifest: ${relative(root, manifest)}`);
  if (failures) process.exitCode = 1;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let root;
  try { root = canonical(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()); }
  catch { throw new Error('Run branch hygiene from a Git working tree. No branches or worktrees were deleted.'); }
  try { git(root, ['fetch', '--prune', 'origin']); }
  catch { throw new Error('Could not fetch origin. Check the remote URL, network and access, then run the report again. No local branches or worktrees were deleted.'); }
  try { git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']); }
  catch { throw new Error('origin/main is missing. Fetch a remote with a main branch before running hygiene. No local branches or worktrees were deleted.'); }
  const currentBranch = git(root, ['branch', '--show-current']).trim();
  const snapshot = inventory(root, options, currentBranch);
  report(snapshot, options, currentBranch);
  if (options.apply) apply(root, snapshot, options, currentBranch);
}

try { main(); }
catch (error) {
  console.error(`Branch hygiene stopped: ${error.message}`);
  process.exitCode = 1;
}
