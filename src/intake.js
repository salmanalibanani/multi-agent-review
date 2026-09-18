/**
 * Intake: turn a ticket URL into the two files the review loop needs.
 *
 *   1. A local copy of the ticket, so every later round reads the same text and the run is
 *      reproducible even if someone edits the ticket midway.
 *   2. A first draft of the plan, written by an agent that has read the ticket and the codebase.
 *
 * Neither step invents credentials. GitHub goes through `gh`, which is already authenticated on a
 * machine that uses it. Jira has no universal CLI, so the fetch is handed to the agent, which reaches
 * it through whatever connector or skill it already has configured. That is also the fallback for
 * GitHub when `gh` is missing.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAgent } from './agent.js';
import { resolveAgent } from './config.js';
import { runCapture, whichCommand } from './platform.js';
import { loadTemplate, localDate, render } from './prompts.js';

const GH_ISSUE_FIELDS = [
  'number',
  'title',
  'state',
  'author',
  'labels',
  'assignees',
  'milestone',
  'createdAt',
  'updatedAt',
  'url',
  'body',
  'comments',
];

const GH_PR_FIELDS = [...GH_ISSUE_FIELDS, 'baseRefName', 'headRefName', 'files'];

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Render `gh issue view --json` output as the Markdown the agents will read. */
export function renderGithubTicket(json, ticket) {
  const lines = [`# ${ticket.owner}/${ticket.repo}#${json.number} - ${json.title}`, ''];

  const facts = [
    ['URL', json.url],
    ['Type', ticket.kind === 'pull' ? 'Pull request' : 'Issue'],
    ['State', json.state],
    ['Author', json.author?.login],
    ['Assignees', (json.assignees ?? []).map((a) => a.login).join(', ')],
    ['Labels', (json.labels ?? []).map((l) => l.name).join(', ')],
    ['Milestone', json.milestone?.title],
    ['Branch', json.headRefName ? `${json.headRefName} -> ${json.baseRefName}` : null],
    ['Created', json.createdAt],
    ['Updated', json.updatedAt],
  ].filter(([, value]) => value);

  for (const [label, value] of facts) lines.push(`- **${label}**: ${value}`);

  lines.push('', '## Description', '', (json.body || '_No description._').trim(), '');

  const comments = json.comments ?? [];
  if (comments.length) {
    lines.push(`## Comments (${comments.length})`, '');
    for (const comment of comments) {
      const who = comment.author?.login ?? comment.user?.login ?? 'unknown';
      lines.push(`### ${who} - ${comment.createdAt ?? ''}`.trim(), '', (comment.body ?? '').trim(), '');
    }
  }

  if (json.files?.length) {
    lines.push(`## Files changed (${json.files.length})`, '');
    for (const file of json.files) {
      lines.push(`- \`${file.path}\` (+${file.additions} -${file.deletions})`);
    }
    lines.push('');
  }

  lines.push('---', `_Fetched by multi-agent-review on ${localDate()}._`, '');
  return lines.join('\n');
}

async function fetchWithGh({ ticket, ticketPath, ghCommand, paths, reporter }) {
  const subcommand = ticket.kind === 'pull' ? 'pr' : 'issue';
  const fields = ticket.kind === 'pull' ? GH_PR_FIELDS : GH_ISSUE_FIELDS;

  reporter.detail(`fetching with ${ghCommand} ${subcommand} view`);
  const result = await runCapture(
    ghCommand,
    [subcommand, 'view', ticket.url, '--json', fields.join(',')],
    { cwd: paths.workdir },
  );

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n')[0];
    throw new Error(
      `gh could not read ${ticket.url}: ${detail || `exit ${result.code}`}. ` +
        'Check `gh auth status`, or pass --fetch-with agent to let the agent fetch it.',
    );
  }

  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh returned something that is not JSON for ${ticket.url}`);
  }

  await writeFile(ticketPath, renderGithubTicket(json, ticket), 'utf8');
  return 'gh';
}

async function fetchWithAgent({ ticket, ticketPath, config, paths, reporter, stream, logDir }) {
  const agent = resolveAgent(config, config.fetcher ? 'fetcher' : 'reviser');
  const template = await loadTemplate('fetch', config.templates.fetch);
  const prompt = render(template, {
    url: ticket.url,
    key: ticket.key,
    provider: ticket.provider,
    ticket: ticketPath,
    workdir: paths.workdir,
    date: localDate(),
  });

  const promptFile = path.join(logDir, 'intake-fetch-prompt.txt');
  await writeFile(promptFile, prompt, 'utf8');

  reporter.detail(`asking ${agent.name} to fetch it (${ticket.provider})`);
  const run = await runAgent({
    command: agent.command,
    args: agent.args.map((arg) =>
      render(arg, { workdir: paths.workdir, planDir: path.dirname(ticketPath), round: 0 }),
    ),
    prompt,
    promptVia: agent.promptVia,
    env: agent.env,
    cwd: paths.workdir,
    stdoutPath: path.join(logDir, 'intake-fetch.out.log'),
    stderrPath: path.join(logDir, 'intake-fetch.err.log'),
    timeoutMs: config.timeoutMinutes * 60 * 1000,
    stream,
    heartbeatMs: config.heartbeatSeconds * 1000,
    write: reporter.agentLine,
  });

  if (run.timedOut) throw new Error(`${agent.name} timed out fetching ${ticket.url}`);
  if (run.code !== 0) throw new Error(`${agent.name} exited ${run.code} fetching ${ticket.url}`);
  if (!(await exists(ticketPath))) {
    throw new Error(
      `${agent.name} did not write ${ticketPath}. Its transcript is in ${logDir}. ` +
        'If it has no access to this tracker, fetch the ticket by hand and pass the file instead.',
    );
  }
  return agent.name;
}

/**
 * Make sure the local ticket copy exists.
 * @returns {Promise<'existing'|'gh'|string>} how it got there
 */
export async function ensureTicket(options) {
  const { ticket, ticketPath, refresh, config, reporter } = options;

  if (!refresh && (await exists(ticketPath))) {
    reporter.detail(`using the ticket copy already at ${ticketPath}`);
    return 'existing';
  }

  await mkdir(path.dirname(ticketPath), { recursive: true });

  const ghCommand = config.tools?.gh ?? 'gh';
  const preference = options.fetchWith ?? 'auto';
  const canUseGh =
    ticket.provider === 'github' && preference !== 'agent' && Boolean(whichCommand(ghCommand));

  if (preference === 'gh' && ticket.provider !== 'github') {
    throw new Error('--fetch-with gh only works for GitHub tickets');
  }

  if (canUseGh) return fetchWithGh({ ...options, ghCommand });
  if (preference === 'gh') {
    throw new Error(`${ghCommand} is not on PATH - install the GitHub CLI or use --fetch-with agent`);
  }
  if (ticket.provider === 'github' && preference !== 'agent') {
    // Say so rather than quietly taking the slower, less predictable route.
    reporter.warn(
      `${ghCommand} is not on PATH, so this GitHub ticket falls back to the agent. ` +
        'Installing the GitHub CLI makes the fetch faster and exact.',
    );
  }
  return fetchWithAgent(options);
}

/**
 * Make sure a first draft of the plan exists.
 * @returns {Promise<'existing'|string>} how it got there
 */
export async function ensurePlan(options) {
  const { ticket, ticketPath, planPath, replan, config, paths, reporter, stream, logDir } = options;

  if (!replan && (await exists(planPath))) {
    reporter.detail(`using the plan already at ${planPath}`);
    return 'existing';
  }

  const agent = resolveAgent(config, config.planner ? 'planner' : 'reviser');
  const template = await loadTemplate('planner', config.templates.planner);
  const prompt = render(template, {
    artifact: planPath,
    ticketFile: ticketPath,
    url: ticket.url,
    key: ticket.key,
    workdir: paths.workdir,
    date: localDate(),
    severities: config.severities.join(' / '),
  });

  const promptFile = path.join(logDir, 'intake-plan-prompt.txt');
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(promptFile, prompt, 'utf8');

  reporter.detail(`asking ${agent.name} to draft the plan`);
  const run = await runAgent({
    command: agent.command,
    args: agent.args.map((arg) =>
      render(arg, { workdir: paths.workdir, planDir: path.dirname(planPath), round: 0 }),
    ),
    prompt,
    promptVia: agent.promptVia,
    env: agent.env,
    cwd: paths.workdir,
    stdoutPath: path.join(logDir, 'intake-plan.out.log'),
    stderrPath: path.join(logDir, 'intake-plan.err.log'),
    timeoutMs: config.timeoutMinutes * 60 * 1000,
    stream,
    heartbeatMs: config.heartbeatSeconds * 1000,
    write: reporter.agentLine,
  });

  if (run.timedOut) throw new Error(`${agent.name} timed out drafting the plan`);
  if (run.code !== 0) throw new Error(`${agent.name} exited ${run.code} drafting the plan`);
  if (!(await exists(planPath))) {
    throw new Error(`${agent.name} did not write ${planPath}. Its transcript is in ${logDir}.`);
  }
  return agent.name;
}
