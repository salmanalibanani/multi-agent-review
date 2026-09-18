/**
 * The parts of spawning a child process that differ between Windows, macOS and Linux.
 *
 * Two of these are easy to miss on the machine you develop on:
 *
 * - **Windows cannot exec a `.cmd` or `.bat` directly.** Agent CLIs installed through npm land as
 *   `claude.cmd`, `gemini.cmd` and so on, and `spawn('claude', ...)` fails with ENOENT. If the author's
 *   machine happens to have a native `claude.exe`, everything looks fine until someone else tries it.
 * - **Killing a hung agent must kill its children.** A coding agent spawns compilers, greps and language
 *   servers. `child.kill()` alone leaves those running: on POSIX the child is not a process group leader
 *   unless it was spawned detached, and Windows has no process groups to signal at all.
 */

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const isWindows = process.platform === 'win32';

/**
 * Canonical path, tolerating a target that does not exist yet (the review file usually does not on
 * the first round): resolve the deepest ancestor that does exist, then re-append the rest.
 *
 * This is not fussiness. On Windows a path can arrive in 8.3 form (`C:\Users\RUNNER~1\...`) while
 * git reports the long form, and on macOS `/var` is a symlink to `/private/var`. Comparing the two
 * spellings makes an allowed path look like it is outside the repository, and the guardrail then
 * aborts the run the first time an agent legitimately edits the document.
 */
export function canonicalPath(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // nothing on this path exists
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}



const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isExecutableFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a command the way a shell would: as a path if it looks like one, otherwise along PATH, trying
 * each PATHEXT extension on Windows.
 *
 * @returns {string|null} absolute path, or null when nothing matches
 */
export function whichCommand(command) {
  if (!command) return null;

  const extensions = isWindows
    ? (process.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
    : [''];

  const looksLikePath = command.includes('/') || command.includes('\\');
  const directories = looksLikePath
    ? [null]
    : (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    const base = directory === null ? path.resolve(command) : path.join(directory, command);

    // An explicit extension wins, on every platform.
    if (path.extname(base) && isExecutableFile(base)) return base;

    for (const extension of extensions) {
      if (!extension) continue;
      for (const spelling of [extension.toLowerCase(), extension.toUpperCase()]) {
        const candidate = base + spelling;
        if (isExecutableFile(candidate)) return candidate;
      }
    }

    if (!isWindows && isExecutableFile(base)) return base;
  }

  return null;
}

/** Quote one argument for cmd.exe. Inside double quotes cmd leaves &, |, < and > alone. */
function quoteForCmd(argument) {
  const escaped = String(argument).replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Turn (command, args) into something spawn can actually launch on this platform.
 *
 * @returns {{file: string, args: string[], windowsVerbatimArguments: boolean, resolved: string|null}}
 */
export function launcherFor(command, args = []) {
  const resolved = whichCommand(command);
  const file = resolved ?? command;

  if (isWindows && ['.cmd', '.bat'].includes(path.extname(file).toLowerCase())) {
    // cmd.exe: /d skips AutoRun scripts, /s keeps the outer quotes intact, /c runs and exits.
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
      resolved,
    };
  }

  return { file, args, windowsVerbatimArguments: false, resolved };
}

/**
 * Merge extra variables into the inherited environment.
 *
 * Windows environment variables are case-insensitive, so adding `PATH` to an environment that already
 * has `Path` produces two entries and the child sees whichever the runtime happens to pick.
 */
export function mergeEnv(extra) {
  if (!extra || Object.keys(extra).length === 0) return process.env;
  if (!isWindows) return { ...process.env, ...extra };

  const merged = { ...process.env };
  const byLowerCase = new Map(Object.keys(merged).map((key) => [key.toLowerCase(), key]));
  for (const [key, value] of Object.entries(extra)) {
    const existing = byLowerCase.get(key.toLowerCase());
    if (existing && existing !== key) delete merged[existing];
    merged[key] = value;
  }
  return merged;
}

/** Spawn options that make a process-group kill possible on POSIX. */
export function spawnOptions() {
  // detached gives the child its own process group on POSIX so the whole tree can be signalled.
  // On Windows it would mean a new console, which is not what we want, and taskkill /T covers us.
  return { detached: !isWindows, windowsHide: true };
}

/**
 * Run a short-lived command and capture its output. For one-shot tools such as `gh`; agents go through
 * runAgent instead, which streams, logs and enforces a per-round timeout.
 *
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runCapture(command, args, { cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve) => {
    const launcher = launcherFor(command, args);
    const child = spawn(launcher.file, launcher.args, {
      cwd,
      env: mergeEnv(env),
      windowsVerbatimArguments: launcher.windowsVerbatimArguments,
      ...spawnOptions(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const killer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(killer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.end();
  });
}

/**
 * Kill an agent and everything it started.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} graceMs how long to wait before escalating to a forced kill
 */
export function killTree(child, graceMs = 5000) {
  if (!child.pid || child.exitCode !== null) return;

  if (isWindows) {
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    taskkill.on('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    });
    return;
  }

  const signal = (target, name) => {
    try {
      process.kill(target, name);
      return true;
    } catch {
      return false;
    }
  };

  // Negative pid = the whole process group, which only exists because we spawned detached.
  if (!signal(-child.pid, 'SIGTERM')) child.kill('SIGTERM');

  setTimeout(() => {
    if (child.exitCode !== null) return;
    if (!signal(-child.pid, 'SIGKILL')) child.kill('SIGKILL');
  }, graceMs).unref?.();
}
