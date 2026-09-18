import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { describeShorthand, looksLikeTicket, parseTicket, ticketPaths, toSlug } from '../src/ticket.js';
import { renderGithubTicket } from '../src/intake.js';

test('recognises a GitHub issue URL', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
  assert.equal(ticket.provider, 'github');
  assert.equal(ticket.kind, 'issue');
  assert.equal(ticket.owner, 'acme');
  assert.equal(ticket.repo, 'widgets');
  assert.equal(ticket.number, '42');
  assert.equal(ticket.key, 'widgets-42');
});

test('recognises a GitHub pull request', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/pull/7');
  assert.equal(ticket.kind, 'pull');
  assert.equal(ticket.key, 'widgets-7');
});

test('a ticket must be a full URL - shorthands are refused', () => {
  for (const shorthand of ['acme/widgets#42', 'ABC-123', 'PROJ-4821']) {
    assert.equal(parseTicket(shorthand), null, shorthand);
    assert.equal(looksLikeTicket(shorthand), false, shorthand);
  }
});

test('a refused shorthand suggests the URL that was meant', () => {
  assert.equal(
    describeShorthand('acme/widgets#42'),
    'https://github.com/acme/widgets/issues/42',
  );
  assert.equal(
    describeShorthand('ABC-123'),
    'https://your-site.atlassian.net/browse/ABC-123',
  );
  // A document path or a real URL is not a near miss.
  assert.equal(describeShorthand('docs/plan.md'), null);
  assert.equal(describeShorthand('https://github.com/acme/widgets/issues/42'), null);
  assert.equal(describeShorthand(undefined), null);
});

test('ignores a trailing anchor on a GitHub URL', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/issues/42#issuecomment-99');
  assert.equal(ticket.url, 'https://github.com/acme/widgets/issues/42');
  assert.equal(ticket.number, '42');
});

test('recognises a Jira browse URL', () => {
  const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
  assert.equal(ticket.provider, 'jira');
  assert.equal(ticket.key, 'ABC-123');
  assert.equal(ticket.site, 'acme.atlassian.net');
});

test('recognises a Jira board URL carrying the key', () => {
  const ticket = parseTicket(
    'https://acme.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=ABC-123',
  );
  assert.equal(ticket.provider, 'jira');
  assert.equal(ticket.key, 'ABC-123');
});



test('a document path is not a ticket', () => {
  for (const input of ['docs/plan.md', './plan.md', 'C:\\repo\\plan.md', '/repo/plan.md']) {
    assert.equal(parseTicket(input), null, input);
    assert.equal(looksLikeTicket(input), false, input);
  }
});

test('an unrecognised URL is refused rather than guessed at', () => {
  assert.equal(parseTicket('https://example.com/tickets/42'), null);
  assert.equal(parseTicket('https://github.com/acme/widgets'), null);
});

test('keys are safe to use as filenames', () => {
  assert.equal(toSlug('ABC-123'), 'ABC-123');
  assert.equal(toSlug('feature/some thing'), 'feature-some-thing');
  assert.equal(toSlug('  ..weird::name  '), '..weird-name');
});

test('derives the three paths from the plan directory', () => {
  const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
  const paths = ticketPaths(ticket, path.join('repo', 'plans'));
  assert.equal(paths.ticket, path.resolve('repo/plans/ABC-123.md'));
  assert.equal(paths.plan, path.resolve('repo/plans/ABC-123-PLAN.md'));
  assert.equal(paths.review, path.resolve('repo/plans/ABC-123-PLAN-review.md'));
});

test('an explicit plan path moves the review file with it', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/issues/9');
  const paths = ticketPaths(ticket, 'plans', { plan: path.join('docs', 'my-plan.md') });
  assert.equal(paths.plan, path.resolve('docs/my-plan.md'));
  assert.equal(paths.review, path.resolve('docs/my-plan-review.md'));
  assert.equal(paths.ticket, path.resolve('plans/widgets-9.md'));
});

test('renders a GitHub issue as readable Markdown', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
  const markdown = renderGithubTicket(
    {
      number: 42,
      title: 'Totals are wrong',
      state: 'OPEN',
      author: { login: 'someone' },
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'maintainer' }],
      createdAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/acme/widgets/issues/42',
      body: 'The total is off by one.',
      comments: [{ author: { login: 'other' }, createdAt: '2026-01-02', body: 'Reproduced.' }],
    },
    ticket,
  );

  assert.match(markdown, /^# acme\/widgets#42 - Totals are wrong/);
  assert.match(markdown, /\*\*State\*\*: OPEN/);
  assert.match(markdown, /\*\*Labels\*\*: bug/);
  assert.match(markdown, /## Description\n\nThe total is off by one\./);
  assert.match(markdown, /## Comments \(1\)/);
  assert.match(markdown, /### other - 2026-01-02\n\nReproduced\./);
});

test('an issue with no body or comments still renders', () => {
  const ticket = parseTicket('https://github.com/acme/widgets/issues/1');
  const markdown = renderGithubTicket({ number: 1, title: 'Empty', state: 'OPEN' }, ticket);
  assert.match(markdown, /_No description\._/);
  assert.equal(markdown.includes('## Comments'), false);
});
