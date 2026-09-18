import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findRoundNumbers,
  formatCounts,
  isClean,
  latestRoundNumber,
  parseLatestVerdict,
  remainingBelowThreshold,
} from '../src/verdict.js';

test('parses a CLEAN verdict', () => {
  const result = parseLatestVerdict('## Round 1 (2026-01-01)\nNothing actionable.\nVERDICT: CLEAN');
  assert.equal(result.ok, true);
  assert.equal(result.round, 1);
  assert.equal(result.clean, true);
});

test('parses counts', () => {
  const result = parseLatestVerdict('## Round 2\nstuff\nVERDICT: 2 HIGH, 1 MEDIUM, 3 LOW');
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { high: 2, medium: 1, low: 3 });
  assert.equal(result.clean, false);
});

test('tolerates bold, backticks and list decoration', () => {
  for (const line of [
    '**VERDICT: 0 HIGH, 0 MEDIUM, 4 LOW**',
    '`VERDICT: 0 HIGH, 0 MEDIUM, 4 LOW`',
    '- VERDICT: 0 HIGH, 0 MEDIUM, 4 LOW',
    '> VERDICT: 0 HIGH, 0 MEDIUM, 4 LOW',
  ]) {
    const result = parseLatestVerdict(`## Round 3\n${line}`);
    assert.equal(result.ok, true, line);
    assert.deepEqual(result.counts, { high: 0, medium: 0, low: 4 }, line);
  }
});

test('reads the latest round, not the first', () => {
  const text = [
    '## Round 1',
    'VERDICT: 3 HIGH, 0 MEDIUM, 0 LOW',
    '',
    '## Round 2',
    'VERDICT: 0 HIGH, 0 MEDIUM, 1 LOW',
  ].join('\n');
  const result = parseLatestVerdict(text);
  assert.equal(result.round, 2);
  assert.deepEqual(result.counts, { high: 0, medium: 0, low: 1 });
});

test('reads a review written with Windows line endings', () => {
  const text = '## Round 2 (2026-01-01)\r\n\r\n1. **High** - something.\r\n\r\nVERDICT: 1 HIGH, 0 MEDIUM, 2 LOW\r\n';
  const result = parseLatestVerdict(text);
  assert.equal(result.ok, true);
  assert.equal(result.round, 2);
  assert.deepEqual(result.counts, { high: 1, medium: 0, low: 2 });
  assert.equal(result.raw.includes('\r'), false, 'no stray carriage return in the recorded verdict');
});

test('is case-insensitive about severities', () => {
  const result = parseLatestVerdict('## Round 4\nVerdict: 0 high, 2 medium, 0 low');
  assert.deepEqual(result.counts, { high: 0, medium: 2, low: 0 });
});

test('accepts severity names it has never seen', () => {
  const result = parseLatestVerdict('## Round 1\nVERDICT: 1 BLOCKER, 4 NIT');
  assert.deepEqual(result.counts, { blocker: 1, nit: 4 });
  assert.equal(isClean(result.counts, ['blocker']), false);
  assert.equal(isClean(result.counts, ['high']), true, 'a severity nobody reported counts as zero');
});

test('rejects output that breaks the contract', () => {
  const cases = [
    ['## Round 1\nProse with no verdict.', /no VERDICT line/],
    ['VERDICT: CLEAN', /no "## Round N" heading/],
    ['## Round 1\nVERDICT: looks fine to me', /neither CLEAN nor a set of counts/],
    ['', /empty/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseLatestVerdict(text);
    assert.equal(result.ok, false, text);
    assert.match(result.reason, pattern);
  }
});

test('stop rule: lows do not hold the loop open by default', () => {
  assert.equal(isClean({ high: 0, medium: 0, low: 2 }, ['high', 'medium']), true);
  assert.equal(isClean({ high: 0, medium: 0, low: 2 }, ['high', 'medium', 'low']), false);
  assert.equal(isClean({ high: 0, medium: 1, low: 0 }, ['high', 'medium']), false);
  assert.equal(isClean({ high: 1 }, ['high', 'medium']), false);
});

test('round numbers are found in document order', () => {
  const text = '## Round 1\n### Round 2\n## Round 10\n';
  assert.deepEqual(findRoundNumbers(text), [1, 2, 10]);
  assert.equal(latestRoundNumber(text), 10);
  assert.equal(latestRoundNumber(''), 0);
});

test('formatting helpers', () => {
  assert.equal(formatCounts({ high: 2, low: 1 }, false), '2 high, 1 low');
  assert.equal(formatCounts({}, true), 'clean');
  assert.deepEqual(remainingBelowThreshold({ high: 0, low: 3 }, ['high', 'medium']), { low: 3 });
  assert.deepEqual(remainingBelowThreshold({ high: 1, low: 0 }, ['high']), {});
});
