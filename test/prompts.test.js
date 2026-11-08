import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { localTimestamp, stampLastRevised, stampLastRevisedFile } from '../src/prompts.js';

test('localTimestamp gives local date, time and UTC offset', () => {
  const stamp = localTimestamp(new Date(2026, 10, 9, 9, 30));
  assert.match(stamp, /^2026-11-09 09:30 [+-]\d{2}:\d{2}$/);
});

test('stampLastRevised replaces the whole row and keeps the line ending', () => {
  const text = '| | |\r\n|---|---|\r\n| Version | v2 |\r\n| Last revised | 2026-11-01 10:00 +11:00 (old) |\r\n| Ticket | X |\r\n';
  const out = stampLastRevised(text, '2026-11-09 09:30 +11:00');
  assert.equal(out, '| | |\r\n|---|---|\r\n| Version | v2 |\r\n| Last revised | 2026-11-09 09:30 +11:00 |\r\n| Ticket | X |\r\n');
});

test('stampLastRevised leaves a plan without the row unchanged', () => {
  const text = '| Version | v1 |\n| Date | 2026-11-09 |\n';
  assert.equal(stampLastRevised(text, '2026-11-09 09:30 +11:00'), text);
});

test('stampLastRevisedFile writes the stamp and reports a missing row', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-stamp-'));
  try {
    const withRow = path.join(dir, 'A-PLAN.md');
    const withoutRow = path.join(dir, 'B-PLAN.md');
    writeFileSync(withRow, '| Last revised | 2026-11-06 16:11 +11:00 |\n');
    writeFileSync(withoutRow, '| Date | 2026-11-06 |\n');

    assert.equal(await stampLastRevisedFile(withRow, '2026-11-09 09:30 +11:00'), true);
    assert.equal(readFileSync(withRow, 'utf8'), '| Last revised | 2026-11-09 09:30 +11:00 |\n');
    assert.equal(await stampLastRevisedFile(withoutRow, '2026-11-09 09:30 +11:00'), false);
    assert.equal(readFileSync(withoutRow, 'utf8'), '| Date | 2026-11-06 |\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
