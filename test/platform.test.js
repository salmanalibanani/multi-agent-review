import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { canonicalPath, isWindows, launcherFor, mergeEnv, whichCommand } from '../src/platform.js';
import { killRunningAgents, runAgent } from '../src/agent.js';

const onWindows = { skip: isWindows ? false : 'Windows only' };
const onPosix = { skip: isWindows ? 'POSIX only' : false };

function workspace(prefix = 'mar-platform-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    out: path.join(dir, 'out.log'),
    err: path.join(dir, 'err.log'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('canonicalises a path that does not exist yet', () => {
  const ws = workspace();
  try {
    const notYet = path.join(ws.dir, 'plans', 'ABC-123-PLAN.md');
    const canonical = canonicalPath(notYet);
    assert.equal(path.isAbsolute(canonical), true);
    assert.match(canonical, /ABC-123-PLAN\.md$/);
    assert.equal(path.basename(path.dirname(canonical)), 'plans');
  } finally {
    ws.cleanup();
  }
});

test('canonicalises an 8.3 short path to its long form', onWindows, () => {
  // %TEMP% is usually the short form on Windows; agents reject those as suspicious, and git does not
  // recognise the spelling either.
  const short = process.env.TEMP ?? '';
  const canonical = canonicalPath(short);
  assert.equal(canonical.includes('~'), false, `expected a long path, got ${canonical}`);
});

test('finds a command on PATH', () => {
  const found = whichCommand('node');
  assert.ok(found, 'node should be on PATH');
  assert.equal(path.isAbsolute(found), true);
  if (isWindows) assert.match(found.toLowerCase(), /\.(exe|cmd|bat|com)$/);
});

test('finds a command given as a path', () => {
  assert.equal(whichCommand(process.execPath), process.execPath);
});

test('returns null for something that is not there', () => {
  assert.equal(whichCommand('definitely-not-a-real-command-xyz'), null);
  assert.equal(whichCommand(''), null);
});

test('a plain executable is launched directly', () => {
  const launcher = launcherFor(process.execPath, ['-e', 'null']);
  assert.equal(launcher.file, process.execPath);
  assert.deepEqual(launcher.args, ['-e', 'null']);
  assert.equal(launcher.windowsVerbatimArguments, false);
});

test('a .cmd shim is routed through cmd.exe', onWindows, () => {
  const ws = workspace();
  try {
    const shim = path.join(ws.dir, 'agent.cmd');
    writeFileSync(shim, '@echo off\r\necho hello\r\n');
    const launcher = launcherFor(shim, ['--flag', 'a value']);

    assert.match(launcher.file.toLowerCase(), /cmd\.exe$/);
    assert.equal(launcher.windowsVerbatimArguments, true);
    assert.deepEqual(launcher.args.slice(0, 3), ['/d', '/s', '/c']);
    // cmd /s /c wants the whole command line wrapped in one more pair of quotes.
    assert.match(launcher.args.at(-1), /^"".*agent\.cmd" "--flag" "a value""$/);
  } finally {
    ws.cleanup();
  }
});

test('a .cmd agent actually runs - npm-installed CLIs are .cmd on Windows', onWindows, async () => {
  const ws = workspace();
  try {
    const shim = path.join(ws.dir, 'fake-agent.cmd');
    writeFileSync(shim, '@echo off\r\necho commentary 1>&2\r\necho done\r\n');

    const result = await runAgent({
      command: shim,
      args: [],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      heartbeatMs: 0,
      write: () => {},
    });

    assert.equal(result.code, 0);
    assert.match(readFileSync(ws.out, 'utf8'), /done/);
    assert.match(readFileSync(ws.err, 'utf8'), /commentary/);
  } finally {
    ws.cleanup();
  }
});

test('an extensionless executable script runs', onPosix, async () => {
  const ws = workspace();
  try {
    const script = path.join(ws.dir, 'fake-agent');
    writeFileSync(script, '#!/bin/sh\necho commentary >&2\necho done\n');
    chmodSync(script, 0o755);

    const result = await runAgent({
      command: script,
      args: [],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      heartbeatMs: 0,
      write: () => {},
    });

    assert.equal(result.code, 0);
    assert.match(readFileSync(ws.out, 'utf8'), /done/);
    assert.match(readFileSync(ws.err, 'utf8'), /commentary/);
  } finally {
    ws.cleanup();
  }
});

test('a timed-out agent takes its child processes with it', async () => {
  const ws = workspace();
  const marker = path.join(ws.dir, 'grandchild.pid');
  try {
    const result = await runAgent({
      command: process.execPath,
      args: [path.join(import.meta.dirname, 'fixtures', 'spawns-grandchild.js'), marker],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 1500,
      heartbeatMs: 0,
      write: () => {},
    });

    assert.equal(result.timedOut, true);

    const grandchildPid = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    // The kill is asynchronous (taskkill on Windows, an escalating signal on POSIX).
    for (let attempt = 0; attempt < 40 && isAlive(grandchildPid); attempt += 1) await sleep(250);

    assert.equal(
      isAlive(grandchildPid),
      false,
      'the grandchild should not outlive the agent that started it',
    );
  } finally {
    ws.cleanup();
  }
});

test('an interrupted run stops the agent it started', async () => {
  const ws = workspace();
  const marker = path.join(ws.dir, 'grandchild.pid');
  try {
    const pending = runAgent({
      command: process.execPath,
      args: [path.join(import.meta.dirname, 'fixtures', 'spawns-grandchild.js'), marker],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 60000, // long enough that only the interrupt can end this
      heartbeatMs: 0,
      write: () => {},
    });

    for (let attempt = 0; attempt < 40 && !existsSync(marker); attempt += 1) await sleep(100);
    killRunningAgents();

    const result = await pending;
    assert.equal(result.timedOut, false, 'it was interrupted, not timed out');
    assert.ok(result.elapsedMs < 30000, 'it should not have run to the timeout');
  } finally {
    ws.cleanup();
  }
});

test('extra environment variables reach the agent', async () => {
  const ws = workspace();
  try {
    await runAgent({
      command: process.execPath,
      args: ['-e', 'console.log(process.env.MAR_TEST_VALUE)'],
      prompt: '',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      heartbeatMs: 0,
      env: { MAR_TEST_VALUE: 'passed-through' },
      write: () => {},
    });
    assert.match(readFileSync(ws.out, 'utf8'), /passed-through/);
  } finally {
    ws.cleanup();
  }
});

test('merging env keeps one spelling of a variable on Windows', onWindows, () => {
  const merged = mergeEnv({ PATH: 'C:\\only-this' });
  const pathKeys = Object.keys(merged).filter((key) => key.toLowerCase() === 'path');
  assert.deepEqual(pathKeys, ['PATH']);
  assert.equal(merged.PATH, 'C:\\only-this');
});

test('merging env leaves the inherited environment alone when there is nothing to add', () => {
  assert.equal(mergeEnv(undefined), process.env);
  assert.equal(mergeEnv({}), process.env);
});
