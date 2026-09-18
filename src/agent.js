/**
 * Running one agent.
 *
 * Agents are ordinary CLIs. They get their prompt on stdin (or as an argument), both their streams are
 * captured to log files, and their output is surfaced live.
 *
 * Live output is not a nicety. Coding agents write their running commentary to *stderr*, so a plain
 * redirect to a file leaves the console silent for the ten or twenty minutes a round takes, and the run
 * looks hung. The default is a heartbeat carrying the elapsed time and the agent's latest line;
 * `stream: true` echoes everything.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

import { killTree, launcherFor, mergeEnv, spawnOptions } from './platform.js';

const KILL_GRACE_MS = 5000;

/**
 * Agents currently running, so an interrupted run can take them down with it.
 *
 * On POSIX the agent is spawned detached - it needs its own process group for a tree kill - which also
 * means a Ctrl+C sent to this process's group no longer reaches it. Without this, interrupting the loop
 * would leave the agent running invisibly.
 */
const running = new Set();

/** Kill every agent this process started. Call it when the run is interrupted. */
export function killRunningAgents() {
  for (const child of running) killTree(child, KILL_GRACE_MS);
  running.clear();
}

/** Split a byte stream into complete lines, holding any partial tail for the next chunk. */
function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    },
    flush() {
      if (buffer.trim()) onLine(buffer);
      buffer = '';
    },
  };
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * @param {object} options
 * @param {string} options.command          executable
 * @param {string[]} options.args           already substituted
 * @param {string} options.prompt           the prompt text
 * @param {'stdin'|'arg'} options.promptVia  how the agent takes its prompt
 * @param {string} options.cwd
 * @param {string} options.stdoutPath       log file for stdout
 * @param {string} options.stderrPath       log file for stderr
 * @param {number} options.timeoutMs
 * @param {boolean} options.stream          echo every line
 * @param {number} options.heartbeatMs      0 disables the heartbeat
 * @param {Record<string, string>} [options.env] added to the inherited environment
 * @param {(text: string) => void} options.write  console sink
 * @returns {Promise<{code: number|null, timedOut: boolean, elapsedMs: number, lastLine: string}>}
 */
export async function runAgent({
  command,
  args,
  prompt,
  promptVia = 'stdin',
  cwd,
  stdoutPath,
  stderrPath,
  timeoutMs,
  stream = false,
  heartbeatMs = 20000,
  env,
  write = (text) => process.stdout.write(`${text}\n`),
}) {
  const startedAt = Date.now();
  let lastLine = '';
  let timedOut = false;

  const finalArgs = promptVia === 'arg' ? [...args, prompt] : args;
  const launcher = launcherFor(command, finalArgs);
  const child = spawn(launcher.file, launcher.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergeEnv(env),
    windowsVerbatimArguments: launcher.windowsVerbatimArguments,
    ...spawnOptions(),
  });
  running.add(child);

  const outLog = createWriteStream(stdoutPath);
  const errLog = createWriteStream(stderrPath);

  let lastLineAt = startedAt;
  const onLine = (line) => {
    lastLine = line.trim();
    lastLineAt = Date.now();
    if (stream) write(`   ${line.trimEnd()}`);
  };
  const outSplitter = lineSplitter(onLine);
  const errSplitter = lineSplitter(onLine);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outLog.write(chunk);
    outSplitter.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    errLog.write(chunk);
    errSplitter.push(chunk);
  });

  let heartbeat = null;
  if (!stream && heartbeatMs > 0) {
    // Only echo a line once. Some agents - `claude -p` among them - print a startup notice and then
    // say nothing at all until they finish, and repeating that one line every 20 seconds looks
    // exactly like a stuck process. When there is nothing new, report the silence instead: that is
    // the honest signal, and it still proves the loop is alive.
    let reported = '';
    heartbeat = setInterval(() => {
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (lastLine && lastLine !== reported) {
        const tail = lastLine.length > 110 ? `${lastLine.slice(0, 110)}...` : lastLine;
        write(`   [${elapsed}] ${tail}`);
        reported = lastLine;
      } else {
        write(`   [${elapsed}] working - no new output for ${formatElapsed(Date.now() - lastLineAt)}`);
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  const killer = setTimeout(() => {
    timedOut = true;
    killTree(child, KILL_GRACE_MS); // the agent's compilers and language servers must go too
  }, timeoutMs);

  if (promptVia === 'stdin') {
    child.stdin.on('error', () => {
      /* agent closed stdin early - its prompt is already delivered or it does not want one */
    });
    child.stdin.end(prompt);
  } else {
    child.stdin.end();
  }

  let code = null;
  try {
    [code] = await once(child, 'close');
  } catch (error) {
    running.delete(child);
    clearTimeout(killer);
    if (heartbeat) clearInterval(heartbeat);
    throw new Error(`could not run "${command}": ${error.message}`);
  }

  running.delete(child);
  clearTimeout(killer);
  if (heartbeat) clearInterval(heartbeat);
  outSplitter.flush();
  errSplitter.flush();

  await Promise.all([
    new Promise((resolve) => outLog.end(resolve)),
    new Promise((resolve) => errLog.end(resolve)),
  ]);

  const elapsedMs = Date.now() - startedAt;
  if (!timedOut) write(`   finished in ${formatElapsed(elapsedMs)}`);

  return { code, timedOut, elapsedMs, lastLine };
}
