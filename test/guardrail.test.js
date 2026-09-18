import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  compareSnapshots,
  createGuardrail,
  fingerprint,
  head,
  snapshot,
} from '../src/guardrail.js';

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-guardrail-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'source.txt'), 'original\n');
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
  git('add', '-A');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'initial');
  return { dir, git };
}

test('a stable tree keeps its fingerprint', () => {
  const { dir } = makeRepo();
  try {
    const guardrail = createGuardrail(dir, []);
    assert.equal(guardrail.available, true);
    assert.equal(fingerprint(guardrail), fingerprint(guardrail));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit to a tracked file moves the fingerprint', () => {
  const { dir } = makeRepo();
  try {
    const guardrail = createGuardrail(dir, []);
    const before = snapshot(guardrail);
    writeFileSync(path.join(dir, 'source.txt'), 'tampered\n');
    const result = compareSnapshots(before, snapshot(guardrail));
    assert.equal(result.changed, true);
    assert.equal(result.headMoved, false);
    assert.match(result.reason, /modified while the agent was running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new untracked file moves the fingerprint', () => {
  const { dir } = makeRepo();
  try {
    const guardrail = createGuardrail(dir, []);
    const before = snapshot(guardrail);
    writeFileSync(path.join(dir, 'stray.txt'), 'hello\n');
    assert.equal(compareSnapshots(before, snapshot(guardrail)).changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an allowed path is invisible to the guardrail', () => {
  const { dir } = makeRepo();
  try {
    const plan = path.join(dir, 'docs', 'plan.md');
    const review = path.join(dir, 'docs', 'plan-review.md');
    const guardrail = createGuardrail(dir, [plan, review]);
    const before = snapshot(guardrail);

    writeFileSync(plan, '# plan\n\nrevised after round 1\n'); // the reviser's job
    writeFileSync(review, '## Round 1\nVERDICT: CLEAN\n'); // the reviewer's job

    assert.equal(compareSnapshots(before, snapshot(guardrail)).changed, false);

    writeFileSync(path.join(dir, 'source.txt'), 'but this is not\n');
    assert.equal(compareSnapshots(before, snapshot(guardrail)).changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit to an already-modified file is caught (status alone would miss it)', () => {
  const { dir } = makeRepo();
  try {
    const guardrail = createGuardrail(dir, []);
    writeFileSync(path.join(dir, 'source.txt'), 'first change\n');
    const before = snapshot(guardrail);
    writeFileSync(path.join(dir, 'source.txt'), 'second change\n');

    const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8' });
    assert.match(status, /^ M source\.txt$/m, 'porcelain looks identical across both edits');
    assert.equal(compareSnapshots(before, snapshot(guardrail)).changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a commit during the window is reported as HEAD movement, not a mystery', () => {
  const { dir, git } = makeRepo();
  try {
    const guardrail = createGuardrail(dir, []);
    writeFileSync(path.join(dir, 'source.txt'), 'work in progress\n');
    const before = snapshot(guardrail);

    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'human work');

    const result = compareSnapshots(before, snapshot(guardrail));
    assert.equal(result.changed, true);
    assert.equal(result.headMoved, true);
    assert.match(result.reason, /HEAD moved from \w+ to \w+/);
    assert.notEqual(head(guardrail), before.head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a repository the guardrail says so rather than pretending', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-nogit-'));
  try {
    const guardrail = createGuardrail(dir, []);
    // A temp dir can sit inside an unrelated repo on some machines; only assert the honest branch.
    if (!guardrail.available) {
      assert.match(guardrail.reason, /not inside a git repository/);
      assert.equal(fingerprint(guardrail), 'unavailable');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
