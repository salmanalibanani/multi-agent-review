#!/usr/bin/env node
/**
 * A stand-in reviser for the tests: appends a revision note to the document, as the real one would
 * after folding a round in.
 *
 * Environment:
 *   FAKE_BEHAVIOUR  "normal" (default) | "stray-write" | "fail"
 *   FAKE_STRAY_FILE path to write when behaviour is "stray-write"
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const [artifactPath, roundArg] = process.argv.slice(2);
const round = Number(roundArg);
const behaviour = process.env.FAKE_BEHAVIOUR ?? 'normal';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  console.error(`fake-reviser: verifying round ${round}`);

  if (behaviour === 'fail') process.exit(3);
  if (behaviour === 'stray-write') {
    writeFileSync(process.env.FAKE_STRAY_FILE, 'the reviser wrote where it should not have\n');
  }

  appendFileSync(artifactPath, `\nRevised after round ${round}.\n`);
  console.log(`round ${round} folded in`);
  process.exit(0);
});
