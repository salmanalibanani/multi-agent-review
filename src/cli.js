#!/usr/bin/env node
/**
 * multi-agent-review - put a document through repeated adversarial review by two AI agents.
 */

import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import process from 'node:process';

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  defaultReviewPath,
  loadConfigFile,
  mergeConfig,
  normaliseSeverityList,
  resolveAgent,
  resolveOutputDir,
  toolDefaults,
} from './config.js';
import { killRunningAgents } from './agent.js';
import { compareSnapshots, createGuardrail, describeChanges, snapshot } from './guardrail.js';
import { canonicalPath } from './platform.js';
import { ensurePlan, ensureTicket } from './intake.js';
import { describeShorthand, parseTicket, ticketPaths } from './ticket.js';
import { localStamp } from './prompts.js';
import { EXIT, runLoop } from './loop.js';

const OPTIONS = {
  context: { type: 'string', short: 'c', multiple: true, default: [] },
  review: { type: 'string', short: 'r' },
  'max-rounds': { type: 'string', short: 'm' },
  'stop-on': { type: 'string', short: 's' },
  timeout: { type: 'string', short: 't' },
  repo: { type: 'string' },
  workdir: { type: 'string', short: 'w' },
  config: { type: 'string' },
  reviewer: { type: 'string' },
  reviser: { type: 'string' },
  allow: { type: 'string', multiple: true, default: [] },
  'log-dir': { type: 'string' },
  'plan-dir': { type: 'string' },
  plan: { type: 'string' },
  ticket: { type: 'string' },
  'fetch-with': { type: 'string' },
  'refresh-ticket': { type: 'boolean', default: false },
  replan: { type: 'boolean', default: false },
  'no-guardrail': { type: 'boolean', default: false },
  stream: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const HELP = `
multi-agent-review - one agent reviews a document, another verifies and revises it, until the
reviewer has nothing material left to say.

USAGE
  multi-agent-review <ticket-url | document> [options]
  mar <ticket-url | document> [options]

  Given a ticket, it fetches a local copy, has an agent draft the plan, then reviews it.
  Given a document, it goes straight to reviewing that document.

TICKETS (always a full URL)
  https://github.com/owner/repo/issues/123      GitHub issue, fetched with gh
  https://github.com/owner/repo/pull/123        GitHub pull request
  https://site.atlassian.net/browse/ABC-123     Jira, fetched by the agent

OPTIONS
  -c, --context <path>     Extra file the reviewer should read (repeatable)
  -r, --review <path>      Review file (default: beside the plan or document)
  -m, --max-rounds <n>     Round cap (default: 10)
  -s, --stop-on <list>     Severities that must reach zero (default: high,medium)
  -t, --timeout <minutes>  Per-agent-call timeout (default: 30)
      --repo <path>        The git repository to review against (default: current directory)
  -w, --workdir <path>     Alias for --repo
      --plan-dir <path>    Where ticket copy, plan and review live (default: beside the tool)
      --plan <path>        Plan file, overriding the derived one
      --ticket <path>      Local ticket copy, overriding the derived one
      --fetch-with <how>   auto (default), gh, or agent
      --refresh-ticket     Re-fetch even if the local copy exists
      --replan             Redraft the plan even if it exists
      --reviewer <name>    Agent for the review role (default: codex)
      --reviser <name>     Agent for the revise role (default: claude)
      --config <path>      Config file (default: multi-agent-review.json in the workdir)
      --allow <path>       Extra path the agents may change (repeatable)
      --log-dir <path>     Where transcripts go (default: beside the tool)
      --no-guardrail       Do not check the working tree between agent calls
      --stream             Echo every agent line instead of a heartbeat
      --dry-run            Resolve everything, print the first prompt, run no agent
  -h, --help               This text
  -v, --version            Version

EXIT CODES
  0  the reviewer had nothing left above the threshold
  1  usage error
  2  the round cap was reached with findings outstanding
  3  the guardrail stopped the run
  4  an agent failed or timed out
  5  an agent broke the output contract

EXAMPLES
  mar https://github.com/owner/repo/issues/42
  mar https://jira.example.com/browse/ABC-123 --repo ~/work/my-project
  mar https://github.com/owner/repo/issues/42 --max-rounds 4 --stream
  mar docs/plan.md -c docs/requirements.md
  mar spec.md --reviewer codex --reviser claude --dry-run
`;

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text) => (colour ? `[2m${text}[0m` : text);
const bold = (text) => (colour ? `[1m${text}[0m` : text);
const red = (text) => (colour ? `[31m${text}[0m` : text);
const yellow = (text) => (colour ? `[33m${text}[0m` : text);

const out = (text = '') => process.stdout.write(`${text}\n`);

function createReporter() {
  return {
    phase: (text) => out(`\n${bold(`== ${text}`)}`),
    agentLine: (text) => out(dim(text)),
    verdict: (round, summary) => out(`Round ${round} verdict: ${summary}`),
    folded: (round) => out(`Round ${round} folded into the document.`),
    detail: (text) => out(dim(`   ${text}`)),
    warn: (text) => out(yellow(text)),
    guardrail: (result, changes) => {
      out(red(`GUARDRAIL: ${result.reason}`));
      if (changes) out(changes);
    },
    dryRun: (agent, args, promptFile) => {
      out(dim(`DRY RUN  ${agent.command} ${args.join(' ')}`));
      out(dim(`         prompt on ${agent.promptVia}: ${promptFile}`));
    },
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`${red('error')}: ${message}\n`);
  process.exit(EXIT.USAGE);
}

async function version() {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return pkg.version;
}

/**
 * Ctrl+C must take the agent with it. On POSIX the agent runs in its own process group (so a hung one
 * can be killed as a tree), which means the signal sent to this process does not reach it.
 */
function handleInterrupts() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      out(`
${yellow(`Interrupted (${signal}) - stopping the agent.`)}`);
      killRunningAgents();
      process.exit(130);
    });
  }
}

async function main() {
  handleInterrupts();
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    fail(error.message);
  }
  const { values: flags, positionals } = parsed;

  if (flags.help) return out(HELP.trim()), 0;
  if (flags.version) return out(await version()), 0;
  if (positionals.length === 0) {
    out(HELP.trim());
    return EXIT.USAGE;
  }
  if (positionals.length > 1) fail(`expected one ticket or document, got ${positionals.length}`);

  // Canonicalise before anything else: an 8.3 short path on Windows (C:\Users\RUNNER~1\...) or a
  // symlinked temp dir on macOS reaches the agent as a path it may refuse as suspicious, and reaches
  // git as a spelling it does not recognise.
  const workdir = canonicalPath(flags.repo ?? flags.workdir ?? process.cwd());
  const context = flags.context.map((file) => canonicalPath(file));

  // The repository is the tool's second input, even when it is implied by the current directory: it is
  // what the reviewer reads to judge the plan, and what the guardrail watches.
  if (!(await isDirectory(workdir))) {
    fail(`--repo is not a directory: ${workdir}`);
  }

  const { file: configFile, values: fileConfig } = await loadConfigFile(flags.config, [
    workdir,
    homedir(),
  ]);
  const config = mergeConfig(DEFAULT_CONFIG, fileConfig);

  // The single positional is either a ticket URL to work from or a document to review directly.
  const ticket = parseTicket(positionals[0]);
  if (!ticket) {
    // A bare key or owner/repo#n is plainly meant as a ticket, so say so rather than letting it fall
    // through to document mode and fail with a confusing "document not found".
    const shouldHaveBeen = describeShorthand(positionals[0]);
    if (shouldHaveBeen) {
      fail(
        `a ticket must be given as a full URL, not "${positionals[0]}"\n` +
          `       try: ${shouldHaveBeen}`,
      );
    }
    if (/^https?:\/\//i.test(positionals[0])) {
      fail(
        `not a ticket URL I recognise: ${positionals[0]}\n` +
          '       Supported: a GitHub issue or pull request URL, or a Jira issue URL.',
      );
    }
  }

  if (flags.reviewer) config.reviewer = flags.reviewer;
  if (flags.reviser) config.reviser = flags.reviser;
  if (flags['max-rounds']) config.maxRounds = Number(flags['max-rounds']);
  if (flags['stop-on']) config.stopOn = normaliseSeverityList(flags['stop-on']);
  if (flags.timeout) config.timeoutMinutes = Number(flags.timeout);
  if (flags['log-dir']) config.logDir = flags['log-dir'];
  config.stopOn = normaliseSeverityList(config.stopOn);

  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1) {
    fail(`--max-rounds must be a positive whole number, got "${flags['max-rounds']}"`);
  }
  if (!(config.timeoutMinutes > 0)) {
    fail(`--timeout must be a positive number of minutes, got "${flags.timeout}"`);
  }
  if (config.stopOn.length === 0) fail('--stop-on needs at least one severity');

  // Plans, ticket copies, reviews and transcripts live with the tool by default, NOT in the repository
  // being reviewed - tracker content is not source code, and keeping it out makes every write inside
  // that repository a guardrail violation.
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const defaults = toolDefaults(toolRoot);
  const planDir = canonicalPath(
    resolveOutputDir(flags['plan-dir'] ?? config.planDir, defaults.planDir),
  );

  // Ticket mode derives all three paths; document mode uses the path given.
  const derived = ticket
    ? ticketPaths(ticket, planDir, {
        plan: flags.plan,
        ticketFile: flags.ticket,
        review: flags.review,
      })
    : null;

  const artifact = canonicalPath(derived ? derived.plan : positionals[0]);
  const ticketPath = derived ? canonicalPath(derived.ticket) : null;

  if (!ticket && !(await exists(artifact))) fail(`document not found: ${artifact}`);
  for (const file of context) {
    if (!(await exists(file))) fail(`context file not found: ${file}`);
  }

  const review = canonicalPath(derived ? derived.review : (flags.review ?? defaultReviewPath(artifact)));
  const logDir = canonicalPath(resolveOutputDir(flags['log-dir'] ?? config.logDir, defaults.logDir));

  let reviewerAgent;
  let reviserAgent;
  try {
    reviewerAgent = resolveAgent(config, 'reviewer');
    reviserAgent = resolveAgent(config, 'reviser');
  } catch (error) {
    fail(error.message);
  }

  // The agents are expected to write the review and the document (and, in ticket mode, the local
  // ticket copy); everything else is the guardrail's business. Logs live under the workdir too.
  const allowed = [
    review,
    artifact,
    logDir,
    ...(ticketPath ? [ticketPath] : []),
    ...flags.allow.map((p) => path.resolve(p)),
  ];
  const guardrail = flags['no-guardrail']
    ? { available: false, reason: 'disabled with --no-guardrail' }
    : createGuardrail(workdir, allowed);

  out('');
  out(bold('multi-agent-review'));
  out(`  Repo      : ${workdir}`);
  if (ticket) out(`  Ticket    : ${ticket.key} (${ticket.provider}) ${ticket.url}`);
  if (ticketPath) out(`  Local copy: ${ticketPath}`);
  out(`  ${ticket ? 'Plan      ' : 'Document  '}: ${artifact}`);
  if (context.length) out(`  Context   : ${context.join('\n              ')}`);
  out(`  Review    : ${review}`);
  out(`  Logs      : ${logDir}`);
  if (configFile) out(`  Config    : ${configFile}`);
  out(`  Reviewer  : ${reviewerAgent.name} (${reviewerAgent.command}), fresh session per round`);
  out(`  Reviser   : ${reviserAgent.name} (${reviserAgent.command})`);
  out(`  Stop rule : zero ${config.stopOn.join(' and ')}, or ${config.maxRounds} rounds`);
  out(`  Timeout   : ${config.timeoutMinutes} min per agent call`);
  out(
    `  Progress  : ${flags.stream ? 'full agent output' : `heartbeat every ${config.heartbeatSeconds}s - a round takes many minutes, so silence is normal`}`,
  );
  if (guardrail.available) {
    out(`  Guardrail : on, ${snapshot(guardrail).fingerprint} (${guardrail.root})`);
  } else {
    out(yellow(`  Guardrail : OFF - ${guardrail.reason}`));
  }

  const reporter = createReporter();

  // Intake: fetch the ticket, then draft the plan. Both are skipped when the files already exist, so
  // re-running after an interruption picks up where it left off rather than starting over.
  if (ticket) {
    await mkdir(logDir, { recursive: true });
    const intakeOptions = {
      ticket,
      ticketPath,
      planPath: artifact,
      config,
      paths: { artifact, context, review, workdir, logDir },
      reporter,
      stream: flags.stream,
      logDir,
      fetchWith: flags['fetch-with'],
      refresh: flags['refresh-ticket'],
      replan: flags.replan,
    };

    const beforeIntake = snapshot(guardrail);
    reporter.phase(`Intake - ${ticket.key}`);
    if (flags['dry-run']) {
      reporter.detail('dry run: intake would fetch the ticket and draft the plan here');
    } else {
      try {
        const how = await ensureTicket(intakeOptions);
        reporter.detail(how === 'existing' ? 'ticket copy ready' : `ticket copy written via ${how}`);

        const planned = await ensurePlan(intakeOptions);
        reporter.detail(planned === 'existing' ? 'plan ready' : `plan drafted by ${planned}`);
      } catch (error) {
        process.stderr.write(`${red('error')}: ${error.message}\n`);
        return EXIT.AGENT;
      }

      // Intake gets the same treatment as a round: it may write the ticket copy and the plan, and
      // nothing else.
      const moved = compareSnapshots(beforeIntake, snapshot(guardrail));
      if (moved.changed) {
        reporter.guardrail(moved, describeChanges(guardrail));
        return EXIT.GUARDRAIL;
      }
    }
  }

  const loopContext = ticketPath && !context.includes(ticketPath) ? [ticketPath, ...context] : context;

  const result = await runLoop({
    config,
    paths: { artifact, context: loopContext, review, workdir, logDir },
    guardrail,
    reporter,
    dryRun: flags['dry-run'],
    stream: flags.stream,
  });

  out(`\n${bold('== Result')}`);
  if (result.history.length) {
    const width = Math.max(7, ...result.history.map((row) => row.verdict.length));
    out(`  Round | ${'Verdict'.padEnd(width)} | Folded in`);
    out(`  ------|-${'-'.repeat(width)}-|----------`);
    for (const row of result.history) {
      out(`  ${String(row.round).padEnd(5)} | ${row.verdict.padEnd(width)} | ${row.folded}`);
    }
  }
  out(`Stopped because ${result.stopReason}.`);
  out('');
  out(`Document: ${artifact}`);
  out(`Review:   ${review}`);
  out(`Logs:     ${logDir}`);
  out(dim('          (an agent\'s commentary is usually in *.err.log - most write progress to stderr)'));
  out('');
  out('Nothing was implemented, built or committed - the document is the only thing that changed.');

  await mkdir(logDir, { recursive: true });
  const summary = [
    `# multi-agent-review - ${localStamp()}`,
    '',
    `Document: ${artifact}`,
    `Review: ${review}`,
    `Stop rule: zero ${config.stopOn.join(' and ')}, cap ${config.maxRounds} rounds.`,
    `Stopped because ${result.stopReason}.`,
    '',
    '| Round | Verdict | Folded in |',
    '|---|---|---|',
    ...result.history.map((row) => `| ${row.round} | ${row.verdict} | ${row.folded} |`),
    '',
  ].join('\n');
  await writeFile(path.join(logDir, 'summary.md'), summary, 'utf8');

  return result.exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`${red('error')}: ${error.message}\n`);
    if (process.env.MAR_DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exit(EXIT.AGENT);
  });
