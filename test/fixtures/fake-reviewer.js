#!/usr/bin/env node
/**
 * A stand-in reviewer for the tests.
 *
 * It behaves like a real coding agent in the ways that matter to the loop: it takes its prompt on
 * stdin, writes its commentary to stderr (not stdout), and appends a round section to the review file.
 *
 * Environment:
 *   FAKE_VERDICTS   JSON array, one verdict body per round, e.g. ["2 HIGH, 1 MEDIUM, 0 LOW","CLEAN"]
 *   FAKE_BEHAVIOUR  "normal" (default) | "no-round" | "no-verdict" | "stray-write" | "hang" | "fail"
 *   FAKE_STRAY_FILE path to write when behaviour is "stray-write"
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const [reviewPath, roundArg] = process.argv.slice(2);
const round = Number(roundArg);
const behaviour = process.env.FAKE_BEHAVIOUR ?? 'normal';
const verdicts = JSON.parse(process.env.FAKE_VERDICTS ?? '[]');
const verdict = verdicts[round - 1] ?? 'CLEAN';

// Consume the prompt the way a real agent would, then act.
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  console.error(`fake-reviewer: round ${round}, prompt ${prompt.length} bytes`);
  console.error('fake-reviewer: exec rg --files . succeeded in 12ms');

  if (behaviour === 'hang') {
    setInterval(() => console.error('fake-reviewer: still thinking'), 200);
    return;
  }
  if (behaviour === 'fail') {
    console.error('fake-reviewer: exploded');
    process.exit(7);
  }
  if (behaviour === 'stray-write') {
    writeFileSync(process.env.FAKE_STRAY_FILE, 'an agent wrote where it should not have\n');
  }

  if (behaviour !== 'no-round') {
    const body =
      behaviour === 'no-verdict'
        ? `\n## Round ${round} (2026-01-01)\n\n1. **Medium** - something.\n\nNo machine-readable line here.\n`
        : `\n## Round ${round} (2026-01-01)\n\n1. **Medium** - something, at src/thing.js:12.\n\nVERDICT: ${verdict}\n`;
    appendFileSync(reviewPath, body);
  }

  console.log(`review round ${round} complete`);
  process.exit(0);
});
