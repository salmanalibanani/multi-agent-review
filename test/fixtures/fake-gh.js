#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI. Prints the JSON that `gh issue view --json ...` would.
 *
 * Environment:
 *   FAKE_GH_JSON  the JSON payload to print (defaults to a small issue)
 *   FAKE_GH_FAIL  set to exit non-zero with a gh-shaped error on stderr
 *   FAKE_GH_JUNK  set to print something that is not JSON
 *   FAKE_GH_ARGV  a file to record the argv it was called with
 */

import { writeFileSync } from 'node:fs';

if (process.env.FAKE_GH_ARGV) {
  writeFileSync(process.env.FAKE_GH_ARGV, JSON.stringify(process.argv.slice(2)));
}

const payload =
  process.env.FAKE_GH_JSON ??
  JSON.stringify({
    number: 42,
    title: 'Totals are wrong',
    state: 'OPEN',
    author: { login: 'reporter' },
    labels: [{ name: 'bug' }],
    assignees: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    url: 'https://github.com/acme/widgets/issues/42',
    body: 'The total is off by one when the list is empty.',
    comments: [{ author: { login: 'maintainer' }, createdAt: '2026-01-02', body: 'Reproduced.' }],
  });

if (process.env.FAKE_GH_FAIL) {
  console.error('gh: could not resolve to an Issue with the number of 42.');
  process.exit(1);
}

console.log(process.env.FAKE_GH_JUNK ? 'not json at all' : payload);
