import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_CONFIG } from '../src/config.js';
import { createGuardrail } from '../src/guardrail.js';
import { EXIT, runLoop } from '../src/loop.js';

const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

const silentReporter = {
  phase: () => {},
  agentLine: () => {},
  verdict: () => {},
  folded: () => {},
  warn: () => {},
  guardrail: () => {},
  dryRun: () => {},
};

/** A throwaway git repo holding a document, so the guardrail has something real to watch. */
function scenario({ verdicts = [], behaviour = 'normal', reviserBehaviour = 'normal', maxRounds = 10, existingReview } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-loop-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  const artifact = path.join(dir, 'plan.md');
  const review = path.join(dir, 'plan-review.md');
  const strayFile = path.join(dir, 'stray.txt');
  writeFileSync(artifact, '# plan\n\nv1\n');
  writeFileSync(path.join(dir, 'source.txt'), 'untouched\n');
  if (existingReview) writeFileSync(review, existingReview);
  git('add', '-A');
  git('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'initial');

  const env = {
    FAKE_VERDICTS: JSON.stringify(verdicts),
    FAKE_BEHAVIOUR: behaviour,
    FAKE_STRAY_FILE: strayFile,
  };

  const config = {
    ...DEFAULT_CONFIG,
    reviewer: 'fake-reviewer',
    reviser: 'fake-reviser',
    maxRounds,
    heartbeatSeconds: 0,
    timeoutMinutes: 1,
    agents: {
      'fake-reviewer': {
        command: process.execPath,
        args: [fixture('fake-reviewer.js'), '{{review}}', '{{round}}'],
        promptVia: 'stdin',
        env,
      },
      'fake-reviser': {
        command: process.execPath,
        args: [fixture('fake-reviser.js'), '{{artifact}}', '{{round}}'],
        promptVia: 'stdin',
        env: { ...env, FAKE_BEHAVIOUR: reviserBehaviour },
      },
    },
  };

  const logDir = path.join(dir, 'logs');
  return {
    dir,
    artifact,
    review,
    strayFile,
    run: () =>
      runLoop({
        config,
        paths: { artifact, context: [], review, workdir: dir, logDir },
        guardrail: createGuardrail(dir, [artifact, review, logDir]),
        reporter: silentReporter,
        dryRun: false,
        stream: false,
      }),
    documentText: () => readFileSync(artifact, 'utf8'),
    reviewText: () => readFileSync(review, 'utf8'),
    logDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('stops on the first clean round without running the reviser', async () => {
  const s = scenario({ verdicts: ['CLEAN'] });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.CLEAN);
    assert.match(result.stopReason, /raised no findings in round 1/);
    assert.deepEqual(result.history, [{ round: 1, verdict: 'clean', folded: 'not needed' }]);
    assert.equal(s.documentText().includes('Revised after'), false, 'nothing to fold in');
  } finally {
    s.cleanup();
  }
});

test('runs a second round after findings, then stops', async () => {
  const s = scenario({ verdicts: ['2 HIGH, 1 MEDIUM, 0 LOW', '0 HIGH, 0 MEDIUM, 0 LOW'] });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.CLEAN);
    assert.equal(result.history.length, 2);
    assert.equal(result.history[0].folded, 'yes');
    assert.match(s.documentText(), /Revised after round 1\./);
    assert.equal(/Revised after round 2\./.test(s.documentText()), false);
  } finally {
    s.cleanup();
  }
});

test('lows alone do not keep the loop running, and are reported', async () => {
  const s = scenario({ verdicts: ['0 HIGH, 0 MEDIUM, 3 LOW'] });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.CLEAN);
    assert.match(result.stopReason, /3 low left to judge/);
  } finally {
    s.cleanup();
  }
});

test('the capped final round is still folded into the document', async () => {
  const s = scenario({ verdicts: ['1 HIGH, 0 MEDIUM, 0 LOW', '1 HIGH, 0 MEDIUM, 0 LOW'], maxRounds: 2 });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.MAX_ROUNDS);
    assert.match(result.stopReason, /cap was reached/);
    assert.match(result.stopReason, /folded into the document/);
    assert.match(s.documentText(), /Revised after round 1\./);
    assert.match(s.documentText(), /Revised after round 2\./);
    assert.equal(result.history.at(-1).folded, 'yes');
  } finally {
    s.cleanup();
  }
});

test('resumes from the rounds already in the review file', async () => {
  const s = scenario({
    verdicts: [],
    existingReview: '# review\n\n## Round 1\nVERDICT: 1 HIGH, 0 MEDIUM, 0 LOW\n\n## Round 2\nVERDICT: 1 HIGH, 0 MEDIUM, 0 LOW\n',
  });
  try {
    const result = await s.run();
    assert.equal(result.history[0].round, 3, 'next round continues the numbering');
    assert.match(s.reviewText(), /## Round 3/);
    assert.match(s.reviewText(), /## Round 1/, 'earlier rounds are preserved');
  } finally {
    s.cleanup();
  }
});

test('a reviewer that writes no round section is a contract violation', async () => {
  const s = scenario({ behaviour: 'no-round' });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.CONTRACT);
    assert.match(result.stopReason, /appended no "## Round 1" section/);
  } finally {
    s.cleanup();
  }
});

test('two rounds without a parseable verdict stop the run', async () => {
  const s = scenario({ behaviour: 'no-verdict' });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.CONTRACT);
    assert.match(result.stopReason, /no parseable VERDICT line twice running/);
    assert.equal(result.history.length, 2);
  } finally {
    s.cleanup();
  }
});

test('a reviewer that writes outside the allowed paths trips the guardrail', async () => {
  const s = scenario({ verdicts: ['1 HIGH, 0 MEDIUM, 0 LOW'], behaviour: 'stray-write' });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.GUARDRAIL);
    assert.match(result.stopReason, /guardrail/);
    assert.match(result.stopReason, /modified while the agent was running/);
    assert.equal(existsSync(s.strayFile), true, 'the stray file is left in place for inspection');
    assert.equal(s.documentText().includes('Revised after'), false, 'the run stops before revising');
  } finally {
    s.cleanup();
  }
});

test('a reviser that writes outside the allowed paths trips the guardrail', async () => {
  const s = scenario({ verdicts: ['1 HIGH, 0 MEDIUM, 0 LOW'], reviserBehaviour: 'stray-write' });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.GUARDRAIL);
    assert.match(result.stopReason, /fake-reviser/);
  } finally {
    s.cleanup();
  }
});

test('a failing agent stops the run with its exit code', async () => {
  const s = scenario({ behaviour: 'fail' });
  try {
    const result = await s.run();
    assert.equal(result.exitCode, EXIT.AGENT);
    assert.match(result.stopReason, /exited 7 in round 1/);
  } finally {
    s.cleanup();
  }
});

test('every round leaves a transcript behind', async () => {
  const s = scenario({ verdicts: ['1 HIGH, 0 MEDIUM, 0 LOW', 'CLEAN'] });
  try {
    await s.run();
    for (const name of [
      'round-01-review-prompt.txt',
      'round-01-review.err.log',
      'round-01-revise-prompt.txt',
      'round-02-review.out.log',
    ]) {
      assert.equal(existsSync(path.join(s.logDir, name)), true, `${name} should exist`);
    }
  } finally {
    s.cleanup();
  }
});
