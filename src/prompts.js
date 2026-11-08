/**
 * Prompt templates.
 *
 * Both prompts are plain Markdown files with `{{placeholder}}` substitution, so the whole instruction
 * set for either agent can be replaced without touching the code - which is the point, since what makes
 * a review useful is domain-specific.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const BUILTIN_TEMPLATES = {
  reviewer: path.join(builtinDir, 'reviewer.md'),
  reviser: path.join(builtinDir, 'reviser.md'),
  fetch: path.join(builtinDir, 'fetch.md'),
  planner: path.join(builtinDir, 'planner.md'),
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Local date, not UTC: a round dated yesterday because the author is in UTC+10 reads as a bug. */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local date and time, for the run summary. */
export function localStamp(date = new Date()) {
  return `${localDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Local date and time with the UTC offset (2026-11-09 09:30 +11:00), for a plan's "Last revised" row. */
export function localTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${localStamp(date)} ${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

const LAST_REVISED_ROW = /^\|[ \t]*Last revised[ \t]*\|[^\r\n]*/m;

/**
 * Set a plan's `| Last revised | ... |` header row to `stamp`, so the plan says exactly when its current
 * version was written. mar calls this after an agent has drafted or revised the plan - more exact than
 * the time the agent was given in its prompt. A plan without the row is returned unchanged: inserting
 * one would mean guessing where the header table is.
 */
export function stampLastRevised(text, stamp) {
  return text.replace(LAST_REVISED_ROW, `| Last revised | ${stamp} |`);
}

/** stampLastRevised on a file, in place. Returns false when the plan has no such row. */
export async function stampLastRevisedFile(file, stamp = localTimestamp()) {
  const text = await readFile(file, 'utf8');
  if (!LAST_REVISED_ROW.test(text)) return false;
  const updated = stampLastRevised(text, stamp);
  if (updated !== text) await writeFile(file, updated, 'utf8');
  return true;
}

/** Replace every {{key}}; an unknown key is left as-is so a typo is visible in the prompt. */
export function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export async function loadTemplate(role, override) {
  const file = override ?? BUILTIN_TEMPLATES[role];
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`could not read the ${role} template at ${file}: ${error.message}`);
  }
}

/** The values available to both templates and to agent argument substitution. */
export function promptValues({ artifact, context, review, round, workdir, stopOn, severities }) {
  // Where the documents live. Agents are usually sandboxed to the repository, so when these sit
  // outside it - which is the default - the agent has to be granted that directory explicitly.
  const planDir = path.dirname(artifact);
  const reviewDir = path.dirname(review);
  const contextList = context.length
    ? context.map((file) => `- ${file}`).join('\n')
    : '(none supplied)';

  return {
    artifact,
    review,
    planDir,
    reviewDir,
    workdir,
    round,
    date: localDate(),
    stamp: localTimestamp(),
    context: context.join(', '),
    contextList,
    contextCount: context.length,
    stopOn: stopOn.join(' and '),
    severities: severities.join(' / '),
    severityLine: severities.map((s) => `<n> ${s.toUpperCase()}`).join(', '),
  };
}
