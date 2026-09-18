/**
 * The loop.
 *
 * One round is: reviewer reviews -> guardrail -> read the verdict -> reviser verifies and revises ->
 * guardrail. It ends when the reviewer has nothing left above the stop threshold, when the round cap is
 * reached, or the moment anything looks wrong.
 *
 * On the cap, the final round is folded in like any other, so the document - not the raw review file -
 * is what a human reads when the rounds run out. What is missing then is only the reviewer's
 * confirmation of the result.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAgent } from './agent.js';
import { compareSnapshots, describeChanges, snapshot } from './guardrail.js';
import { loadTemplate, promptValues, render } from './prompts.js';
import {
  formatCounts,
  isClean,
  latestRoundNumber,
  parseLatestVerdict,
  remainingBelowThreshold,
} from './verdict.js';
import { resolveAgent } from './config.js';

export const EXIT = {
  CLEAN: 0,
  USAGE: 1,
  MAX_ROUNDS: 2,
  GUARDRAIL: 3,
  AGENT: 4,
  CONTRACT: 5,
};

const pad = (n) => String(n).padStart(2, '0');

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function substituteArgs(args, values) {
  return args.map((arg) => render(arg, values));
}

/**
 * @param {object} run resolved paths, config and a reporter
 * @returns {Promise<{exitCode: number, stopReason: string, history: object[]}>}
 */
export async function runLoop(run) {
  const { config, paths, guardrail, reporter, dryRun } = run;

  const reviewer = resolveAgent(config, 'reviewer');
  const reviser = resolveAgent(config, 'reviser');
  const reviewerTemplate = await loadTemplate('reviewer', config.templates.reviewer);
  const reviserTemplate = await loadTemplate('reviser', config.templates.reviser);

  await mkdir(paths.logDir, { recursive: true });

  const history = [];
  const startRound = latestRoundNumber(await readIfPresent(paths.review));
  const timeoutMs = config.timeoutMinutes * 60 * 1000;
  const heartbeatMs = config.heartbeatSeconds * 1000;

  let exitCode = EXIT.MAX_ROUNDS;
  let stopReason = `the ${config.maxRounds}-round cap was reached with findings still outstanding`;
  let unparsedRun = 0;

  for (let index = 1; index <= config.maxRounds; index += 1) {
    const round = startRound + index;
    const values = promptValues({
      artifact: paths.artifact,
      context: paths.context,
      review: paths.review,
      round,
      workdir: paths.workdir,
      stopOn: config.stopOn,
      severities: config.severities,
    });

    // ---- review -------------------------------------------------------------------------------
    reporter.phase(`Round ${round} - review (${reviewer.name})`);
    const reviewPrompt = render(reviewerTemplate, values);
    const reviewPromptFile = path.join(paths.logDir, `round-${pad(round)}-review-prompt.txt`);
    await writeFile(reviewPromptFile, reviewPrompt, 'utf8');

    if (dryRun) {
      reporter.dryRun(reviewer, substituteArgs(reviewer.args, values), reviewPromptFile);
      return { exitCode: EXIT.CLEAN, stopReason: 'dry run', history };
    }

    const before = snapshot(guardrail);
    const reviewRun = await runAgent({
      command: reviewer.command,
      args: substituteArgs(reviewer.args, values),
      prompt: reviewPrompt,
      promptVia: reviewer.promptVia,
      env: reviewer.env,
      cwd: paths.workdir,
      stdoutPath: path.join(paths.logDir, `round-${pad(round)}-review.out.log`),
      stderrPath: path.join(paths.logDir, `round-${pad(round)}-review.err.log`),
      timeoutMs,
      stream: run.stream,
      heartbeatMs,
      write: reporter.agentLine,
    });

    if (reviewRun.timedOut) {
      return {
        exitCode: EXIT.AGENT,
        stopReason: `${reviewer.name} timed out after ${config.timeoutMinutes} minutes in round ${round}`,
        history,
      };
    }
    if (reviewRun.code !== 0) {
      return {
        exitCode: EXIT.AGENT,
        stopReason: `${reviewer.name} exited ${reviewRun.code} in round ${round}`,
        history,
      };
    }

    const afterReview = compareSnapshots(before, snapshot(guardrail));
    if (afterReview.changed) {
      reporter.guardrail(afterReview, describeChanges(guardrail));
      return {
        exitCode: EXIT.GUARDRAIL,
        stopReason: `guardrail: ${afterReview.reason} (round ${round}, ${reviewer.name})`,
        history,
      };
    }

    // ---- verdict ------------------------------------------------------------------------------
    const reviewText = await readIfPresent(paths.review);
    if (latestRoundNumber(reviewText) < round) {
      return {
        exitCode: EXIT.CONTRACT,
        stopReason: `${reviewer.name} appended no "## Round ${round}" section to ${paths.review}`,
        history,
      };
    }

    const verdict = parseLatestVerdict(reviewText);
    if (!verdict.ok) {
      unparsedRun += 1;
      reporter.warn(`could not read a verdict: ${verdict.reason}`);
      history.push({ round, verdict: 'unparsed', folded: 'no' });
      if (unparsedRun >= 2) {
        return {
          exitCode: EXIT.CONTRACT,
          stopReason: `${reviewer.name} produced no parseable VERDICT line twice running`,
          history,
        };
      }
    } else {
      unparsedRun = 0;
      const summary = formatCounts(verdict.counts, verdict.clean);
      reporter.verdict(round, summary);
      history.push({ round, verdict: summary, folded: 'pending' });

      if (isClean(verdict.counts, config.stopOn)) {
        history[history.length - 1].folded = 'not needed';
        const below = remainingBelowThreshold(verdict.counts, config.stopOn);
        const trailing = Object.entries(below)
          .map(([severity, n]) => `${n} ${severity}`)
          .join(', ');
        return {
          exitCode: EXIT.CLEAN,
          stopReason: trailing
            ? `${reviewer.name} raised nothing above the threshold in round ${round} (${trailing} left to judge)`
            : `${reviewer.name} raised no findings in round ${round}`,
          history,
        };
      }
    }

    // ---- revise -------------------------------------------------------------------------------
    reporter.phase(`Round ${round} - verify and revise (${reviser.name})`);
    const revisePrompt = render(reviserTemplate, values);
    const revisePromptFile = path.join(paths.logDir, `round-${pad(round)}-revise-prompt.txt`);
    await writeFile(revisePromptFile, revisePrompt, 'utf8');

    const beforeRevise = snapshot(guardrail);
    const reviseRun = await runAgent({
      command: reviser.command,
      args: substituteArgs(reviser.args, values),
      prompt: revisePrompt,
      promptVia: reviser.promptVia,
      env: reviser.env,
      cwd: paths.workdir,
      stdoutPath: path.join(paths.logDir, `round-${pad(round)}-revise.out.log`),
      stderrPath: path.join(paths.logDir, `round-${pad(round)}-revise.err.log`),
      timeoutMs,
      stream: run.stream,
      heartbeatMs,
      write: reporter.agentLine,
    });

    if (reviseRun.timedOut) {
      return {
        exitCode: EXIT.AGENT,
        stopReason: `${reviser.name} timed out after ${config.timeoutMinutes} minutes revising round ${round}`,
        history,
      };
    }
    if (reviseRun.code !== 0) {
      return {
        exitCode: EXIT.AGENT,
        stopReason: `${reviser.name} exited ${reviseRun.code} revising round ${round}`,
        history,
      };
    }

    const afterRevise = compareSnapshots(beforeRevise, snapshot(guardrail));
    if (afterRevise.changed) {
      reporter.guardrail(afterRevise, describeChanges(guardrail));
      return {
        exitCode: EXIT.GUARDRAIL,
        stopReason: `guardrail: ${afterRevise.reason} (round ${round}, ${reviser.name})`,
        history,
      };
    }

    history[history.length - 1].folded = 'yes';
    reporter.folded(round);

    if (index === config.maxRounds) {
      exitCode = EXIT.MAX_ROUNDS;
      stopReason =
        `the ${config.maxRounds}-round cap was reached - round ${round}'s findings are verified ` +
        `and folded into the document, but ${reviewer.name} has not reviewed the result`;
    }
  }

  return { exitCode, stopReason, history };
}
