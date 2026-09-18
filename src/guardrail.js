/**
 * The guardrail.
 *
 * Agents in this loop are given write access so the reviewer can save its review and the reviser can
 * edit the artifact. Nothing else should move. After every agent call the loop takes a fingerprint of
 * the git working tree - `git status --porcelain` plus the full diff against HEAD - with the files the
 * agents are *supposed* to touch excluded by pathspec. Any difference aborts the run.
 *
 * `git diff HEAD` matters as much as the status: an edit to an already-modified file leaves the
 * porcelain line unchanged and would otherwise pass unnoticed.
 *
 * Outside a git repository there is nothing cheap to fingerprint, so the guardrail reports itself as
 * unavailable and the loop warns rather than pretending to be safe.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalPath as canonical } from './platform.js';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Absolute path of the repository root containing dir, or null. */
export function repoRoot(dir) {
  try {
    return canonical(git(['rev-parse', '--show-toplevel'], dir).trim());
  } catch {
    return null;
  }
}

/** Repo-root-relative POSIX path, or null when the target sits outside the repo. */
function toRepoRelative(root, target) {
  const relative = path.relative(root, canonical(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * @param {string} dir       any directory inside the repository
 * @param {string[]} allowed paths the agents may legitimately change
 * @returns {{available: boolean, root?: string, excluded?: string[], reason?: string}}
 */
export function createGuardrail(dir, allowed = []) {
  const root = repoRoot(dir);
  if (!root) {
    return { available: false, reason: `${dir} is not inside a git repository` };
  }

  const excluded = [];
  for (const target of allowed) {
    const relative = toRepoRelative(root, target);
    // A path outside the repo is invisible to git anyway, so it needs no exclusion.
    if (relative) excluded.push(relative);
  }

  return { available: true, root, excluded };
}

/**
 * Hash of everything git can see, minus the excluded paths.
 * @returns {string} 12-character fingerprint
 */
export function fingerprint(guardrail) {
  if (!guardrail.available) return 'unavailable';

  const pathspec = ['--', '.', ...guardrail.excluded.map((p) => `:(exclude)${p}`)];
  const status = git(['status', '--porcelain=v1', ...pathspec], guardrail.root);
  const diff = git(['diff', 'HEAD', ...pathspec], guardrail.root);

  return createHash('sha256')
    .update(`${status}\n--8<--\n${diff}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

/** Current HEAD, so a commit made during a run can be named rather than guessed at. */
export function head(guardrail) {
  if (!guardrail.available) return null;
  try {
    return git(['rev-parse', '--short=10', 'HEAD'], guardrail.root).trim();
  } catch {
    return null; // a repository with no commits yet
  }
}

/**
 * A point-in-time reading, taken immediately before and after each agent call.
 *
 * The window matters. An earlier version of this tool took one baseline for the whole run and
 * compared every round against it, which meant the author committing his own unrelated work during a
 * two-hour run aborted the loop. Comparing across a single agent call instead leaves the human free to
 * work between rounds, and narrows "something moved" to "something moved while the agent was running".
 */
export function snapshot(guardrail) {
  return { fingerprint: fingerprint(guardrail), head: head(guardrail) };
}

/**
 * Compare two snapshots.
 * @returns {{changed: boolean, headMoved: boolean, reason?: string}}
 */
export function compareSnapshots(before, after) {
  if (before.fingerprint === after.fingerprint && before.head === after.head) {
    return { changed: false, headMoved: false };
  }

  const headMoved = before.head !== after.head;
  const reason = headMoved
    ? `HEAD moved from ${before.head} to ${after.head} - the repository was committed, checked out or reset while the agent was running`
    : 'files outside the allowed paths were modified while the agent was running';

  return { changed: true, headMoved, reason };
}

/** Human-readable list of what moved, for the abort message. */
export function describeChanges(guardrail) {
  if (!guardrail.available) return '';
  const pathspec = ['--', '.', ...guardrail.excluded.map((p) => `:(exclude)${p}`)];
  return git(['status', '--short', ...pathspec], guardrail.root).trimEnd();
}
