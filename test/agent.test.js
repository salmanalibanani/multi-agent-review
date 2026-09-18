import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runAgent } from '../src/agent.js';

const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-agent-'));
  return {
    dir,
    out: path.join(dir, 'out.log'),
    err: path.join(dir, 'err.log'),
    review: path.join(dir, 'review.md'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('captures stdout and stderr separately and reports the exit code', async () => {
  const ws = workspace();
  writeFileSync(ws.review, '');
  try {
    const result = await runAgent({
      command: process.execPath,
      args: [fixture('fake-reviewer.js'), ws.review, '1'],
      prompt: 'review this please',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      heartbeatMs: 0,
      write: () => {},
    });

    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.match(readFileSync(ws.out, 'utf8'), /review round 1 complete/);
    assert.match(readFileSync(ws.err, 'utf8'), /fake-reviewer: round 1/);
    assert.match(readFileSync(ws.review, 'utf8'), /VERDICT: CLEAN/);
  } finally {
    ws.cleanup();
  }
});

test('the prompt reaches the agent on stdin', async () => {
  const ws = workspace();
  writeFileSync(ws.review, '');
  try {
    await runAgent({
      command: process.execPath,
      args: [fixture('fake-reviewer.js'), ws.review, '1'],
      prompt: 'x'.repeat(1234),
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      heartbeatMs: 0,
      write: () => {},
    });
    assert.match(readFileSync(ws.err, 'utf8'), /prompt 1234 bytes/);
  } finally {
    ws.cleanup();
  }
});

test('progress from stderr reaches the console - the silent-run defect', async () => {
  const ws = workspace();
  writeFileSync(ws.review, '');
  const lines = [];
  try {
    const result = await runAgent({
      command: process.execPath,
      args: [fixture('fake-reviewer.js'), ws.review, '1'],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 20000,
      stream: true,
      write: (text) => lines.push(text),
    });

    assert.ok(
      lines.some((line) => line.includes('exec rg --files')),
      'a line written only to stderr should still be surfaced',
    );
    assert.match(result.lastLine, /\S/);
  } finally {
    ws.cleanup();
  }
});

test('the heartbeat reports silence rather than repeating a stale line', async () => {
  const ws = workspace();
  const lines = [];
  try {
    // Behaves like `claude -p`: one notice on stderr at startup, then nothing until it finishes.
    await runAgent({
      command: process.execPath,
      args: ['-e', "console.error('startup notice'); setTimeout(() => {}, 1400)"],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 1500,
      heartbeatMs: 300,
      write: (text) => lines.push(text),
    });

    const notices = lines.filter((line) => line.includes('startup notice'));
    const quiet = lines.filter((line) => line.includes('no new output for'));

    assert.equal(notices.length, 1, 'the line is echoed once, not on every beat');
    assert.ok(quiet.length >= 2, `expected repeated silence reports, got ${lines.join(' | ')}`);
  } finally {
    ws.cleanup();
  }
});

test('a hung agent is killed at the timeout', async () => {
  const ws = workspace();
  writeFileSync(ws.review, '');
  try {
    const result = await runAgent({
      command: process.execPath,
      args: [fixture('fake-reviewer.js'), ws.review, '1'],
      prompt: 'go',
      cwd: ws.dir,
      stdoutPath: ws.out,
      stderrPath: ws.err,
      timeoutMs: 1200,
      heartbeatMs: 0,
      write: () => {},
      env: { FAKE_BEHAVIOUR: 'hang' },
    });
    assert.equal(result.timedOut, true);
    assert.ok(result.elapsedMs < 20000, 'should not wait for the full test timeout');
  } finally {
    ws.cleanup();
  }
});

test('a missing executable fails with a useful message', async () => {
  const ws = workspace();
  try {
    await assert.rejects(
      runAgent({
        command: path.join(ws.dir, 'no-such-agent-binary'),
        args: [],
        prompt: 'go',
        cwd: ws.dir,
        stdoutPath: ws.out,
        stderrPath: ws.err,
        timeoutMs: 5000,
        heartbeatMs: 0,
        write: () => {},
      }),
      /could not run/,
    );
  } finally {
    ws.cleanup();
  }
});
