/**
 * Parsing the reviewer's machine-readable verdict.
 *
 * The reviewer appends one `## Round N` section per review to the review file, ending in a single
 * line the loop can read:
 *
 *     VERDICT: 2 HIGH, 1 MEDIUM, 3 LOW
 *     VERDICT: CLEAN
 *
 * Severity names are not hard-coded: every `<number> <word>` pair on the line becomes a count, so a
 * reviewer that reports `4 BLOCKER, 2 NIT` works as long as `stopOn` names the severities that must
 * reach zero. Prose is deliberately not parsed - "no major issues" is not a verdict.
 */

const ROUND_HEADING = /^[ \t]*#{2,4}[ \t]*Round[ \t]+(\d+)\b/gim;
const VERDICT_LINE = /^[ \t>*_`~-]*VERDICT[ \t]*:[ \t]*(?<body>.+?)[ \t*_`~]*$/im;
const COUNT_PAIR = /(\d+)\s*([A-Za-z][A-Za-z-]*)/g;

/** Every round number present in the review text, in document order. */
export function findRoundNumbers(text) {
  if (!text) return [];
  const numbers = [];
  for (const match of text.matchAll(ROUND_HEADING)) numbers.push(Number(match[1]));
  return numbers;
}

/** The highest round number present, or 0 for an empty/absent review. */
export function latestRoundNumber(text) {
  const numbers = findRoundNumbers(text);
  return numbers.length ? Math.max(...numbers) : 0;
}

/**
 * Parse the verdict from the last round section.
 * @returns {{ok: true, round: number, counts: Record<string, number>, clean: boolean, raw: string}
 *         | {ok: false, round?: number, reason: string}}
 */
export function parseLatestVerdict(text) {
  if (!text || !text.trim()) {
    return { ok: false, reason: 'the review file is empty' };
  }

  const headings = [...text.matchAll(ROUND_HEADING)];
  if (headings.length === 0) {
    return { ok: false, reason: 'no "## Round N" heading found' };
  }

  const last = headings[headings.length - 1];
  const round = Number(last[1]);
  const section = text.slice(last.index);

  const line = section.match(VERDICT_LINE);
  if (!line) {
    return { ok: false, round, reason: `round ${round} has no VERDICT line` };
  }

  const raw = line.groups.body.trim();
  if (/\bclean\b/i.test(raw)) {
    return { ok: true, round, counts: {}, clean: true, raw };
  }

  const counts = {};
  for (const [, count, severity] of raw.matchAll(COUNT_PAIR)) {
    counts[severity.toLowerCase()] = Number(count);
  }

  if (Object.keys(counts).length === 0) {
    return {
      ok: false,
      round,
      reason: `round ${round} verdict is neither CLEAN nor a set of counts: "${raw}"`,
    };
  }

  const clean = Object.values(counts).every((n) => n === 0);
  return { ok: true, round, counts, clean, raw };
}

/**
 * Has the reviewer run out of things that matter?
 * @param {Record<string, number>} counts
 * @param {string[]} stopOn severities that must be zero, e.g. ['high', 'medium']
 */
export function isClean(counts, stopOn) {
  return stopOn.every((severity) => (counts[severity.toLowerCase()] ?? 0) === 0);
}

/** "2 high, 1 medium, 3 low" for the console and the summary table. */
export function formatCounts(counts, clean) {
  const entries = Object.entries(counts);
  if (!entries.length) return clean ? 'clean' : 'no counts';
  return entries.map(([severity, n]) => `${n} ${severity}`).join(', ');
}

/** Severities that are non-zero but not in stopOn - reported, not acted on. */
export function remainingBelowThreshold(counts, stopOn) {
  const below = {};
  for (const [severity, n] of Object.entries(counts)) {
    if (n > 0 && !stopOn.includes(severity)) below[severity] = n;
  }
  return below;
}
