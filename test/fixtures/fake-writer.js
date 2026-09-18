#!/usr/bin/env node
/**
 * A stand-in agent for the intake steps. It reads the prompt on stdin, finds the path it was told to
 * write, and writes it - which also checks that the templates really carry that path.
 *
 * Environment:
 *   FAKE_BEHAVIOUR  "normal" (default) | "nothing" (writes no file) | "fail"
 *   FAKE_STRAY_FILE writes here as well, to exercise the guardrail
 */

import { writeFileSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const behaviour = process.env.FAKE_BEHAVIOUR ?? 'normal';

  console.error(`fake-writer: prompt ${prompt.length} bytes`);
  if (behaviour === 'fail') process.exit(4);

  const target =
    prompt.match(/Save it to:\s*(.+)/)?.[1] ?? prompt.match(/Write the plan to:\s*(.+)/)?.[1];

  if (!target) {
    console.error('fake-writer: the prompt did not say where to write');
    process.exit(2);
  }

  if (behaviour !== 'nothing') {
    const isPlan = /Write the plan to:/.test(prompt);
    writeFileSync(
      target.trim(),
      isPlan
        ? '# Plan - v1 (drafted by fake-writer)\n\n## Problem\n\n## Review findings\n\nNo rounds yet.\n'
        : '# Ticket copy written by fake-writer\n\n## Description\n\nSomething is broken.\n',
    );
  }

  if (process.env.FAKE_STRAY_FILE) writeFileSync(process.env.FAKE_STRAY_FILE, 'oops\n');

  console.log(`wrote ${target.trim()}`);
  process.exit(0);
});
