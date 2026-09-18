/** Programmatic entry point, for embedding the loop in something larger. */

export { runLoop, EXIT } from './loop.js';
export { runAgent, killRunningAgents } from './agent.js';
export {
  createGuardrail,
  fingerprint,
  head,
  snapshot,
  compareSnapshots,
  describeChanges,
  repoRoot,
} from './guardrail.js';
export {
  findRoundNumbers,
  latestRoundNumber,
  parseLatestVerdict,
  isClean,
  formatCounts,
  remainingBelowThreshold,
} from './verdict.js';
export {
  DEFAULT_CONFIG,
  defaultReviewPath,
  loadConfigFile,
  mergeConfig,
  normaliseSeverityList,
  resolveAgent,
} from './config.js';
export { loadTemplate, promptValues, render, localDate, localStamp, BUILTIN_TEMPLATES } from './prompts.js';
export { isWindows, whichCommand, launcherFor, mergeEnv, killTree } from './platform.js';
export { parseTicket, looksLikeTicket, ticketPaths, toSlug } from './ticket.js';
export { ensureTicket, ensurePlan, renderGithubTicket } from './intake.js';
