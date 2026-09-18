/**
 * Recognising a ticket from whatever the user typed.
 *
 * A ticket is always a full URL. Accepted:
 *   https://github.com/owner/repo/issues/123
 *   https://github.com/owner/repo/pull/123
 *   https://your-site.atlassian.net/browse/ABC-123
 *   https://your-site.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=ABC-123
 *
 * Shorthands such as `ABC-123` or `owner/repo#123` are deliberately not accepted. A bare key means
 * nothing without a configured site, and a tool that behaves differently depending on someone's config
 * is a tool that is hard to explain. describeShorthand() turns these near misses into a useful error
 * rather than a confusing "document not found".
 *
 * Anything else is treated as a path to a document, which is the tool's other mode.
 */

import path from 'node:path';

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i;
const GITHUB_SHORTHAND = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const BARE_JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const JIRA_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
const JIRA_BROWSE = /^https?:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9_]+-\d+)/i;

/** Safe for a filename on every platform, and still recognisable. */
export function toSlug(text) {
  return String(text)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * @returns {{provider: 'github'|'jira', key: string, url: string, kind?: string,
 *            owner?: string, repo?: string, number?: string, site?: string} | null}
 */
export function parseTicket(input) {
  if (!input) return null;
  const text = String(input).trim();

  const githubUrl = text.match(GITHUB_URL);
  if (githubUrl) {
    const [, owner, repo, kind, number] = githubUrl;
    return {
      provider: 'github',
      kind: kind.toLowerCase() === 'pull' ? 'pull' : 'issue',
      owner,
      repo: repo.replace(/\.git$/, ''),
      number,
      key: toSlug(`${repo.replace(/\.git$/, '')}-${number}`),
      url: text.split('#')[0],
    };
  }

  const browse = text.match(JIRA_BROWSE);
  if (browse) {
    const [, site, key] = browse;
    return { provider: 'jira', key: key.toUpperCase(), site, url: text };
  }

  if (/^https?:\/\//i.test(text)) {
    // Some other Atlassian URL shape - a board or backlog link carrying the key in a query parameter.
    const key = text.match(JIRA_KEY);
    if (key && /atlassian\.net|\/jira\//i.test(text)) {
      return {
        provider: 'jira',
        key: key[1].toUpperCase(),
        site: new URL(text).host,
        url: text,
      };
    }
    return null; // an http URL we do not understand is better refused than guessed at
  }

  return null;
}

/** Does this look like a ticket rather than a file to review? */
export function looksLikeTicket(input) {
  return parseTicket(input) !== null;
}

/**
 * For an input that is plainly a ticket reference but not a URL, the URL the user should have typed.
 * @returns {string|null} an example, or null when the input is not a near miss
 */
export function describeShorthand(input) {
  const text = String(input ?? '').trim();

  if (BARE_JIRA_KEY.test(text)) {
    return `https://your-site.atlassian.net/browse/${text}`;
  }

  const shorthand = text.match(GITHUB_SHORTHAND);
  if (shorthand) {
    const [, owner, repo, number] = shorthand;
    return `https://github.com/${owner}/${repo}/issues/${number}`;
  }

  return null;
}

/**
 * Where the three files for a ticket live.
 * @returns {{ticket: string, plan: string, review: string}}
 */
export function ticketPaths(ticket, planDir, { plan, ticketFile, review } = {}) {
  const base = path.resolve(planDir);
  const planPath = plan ? path.resolve(plan) : path.join(base, `${ticket.key}-PLAN.md`);
  const stem = path.basename(planPath, path.extname(planPath));

  return {
    ticket: ticketFile ? path.resolve(ticketFile) : path.join(base, `${ticket.key}.md`),
    plan: planPath,
    review: review ? path.resolve(review) : path.join(path.dirname(planPath), `${stem}-review.md`),
  };
}
