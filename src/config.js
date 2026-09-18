/**
 * Configuration: built-in defaults, overlaid by a config file, overlaid by command-line flags.
 *
 * The agents are defined as data rather than code so the loop is not tied to any particular vendor.
 * An agent is any CLI that accepts a prompt and can read and write files in the working directory.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  reviewer: 'codex',
  reviser: 'claude',
  maxRounds: 10,
  /** Severities that must reach zero before the loop stops. Anything else is reported, not chased. */
  stopOn: ['high', 'medium'],
  /** Offered to the reviewer in its prompt; the parser accepts whatever the reviewer actually uses. */
  severities: ['High', 'Medium', 'Low'],
  timeoutMinutes: 30,
  heartbeatSeconds: 20,
  /**
   * Where transcripts and the ticket copy, plan and review live.
   *
   * null means "beside the tool, not inside the repository being reviewed" - see toolDefaults().
   * Tracker content is not source code: a ticket copy and its review trail have no business appearing
   * as untracked files in someone's product repo, and keeping them out means ANY write inside that
   * repo is a guardrail violation rather than an expected one.
   *
   * A value here is resolved against the current directory, so an explicit setting still goes where
   * you point it.
   */
  logDir: null,
  planDir: null,
  /** Agents for the two intake steps. Unset means "use the reviser", which is the usual choice. */
  fetcher: null,
  planner: null,
  /** One-shot tools, resolved on PATH. */
  tools: { gh: 'gh' },
  agents: {
    codex: {
      // --add-dir grants the plans folder. Without it codex runs with
      // `sandbox: workspace-write [workdir, /tmp]`, reviews the plan perfectly well, and then cannot
      // save the review because it lives outside the repository.
      command: 'codex',
      args: [
        'exec',
        '-C',
        '{{workdir}}',
        '--add-dir',
        '{{planDir}}',
        '-s',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '-',
      ],
      promptVia: 'stdin',
    },
    claude: {
      // acceptEdits is the cautious default: the agent may edit files but a shell command it has not
      // been granted is refused rather than queued for a prompt nobody can answer. Verification work
      // often wants more than that - see "Permissions" in the README before loosening it.
      command: 'claude',
      args: ['-p', '--add-dir', '{{planDir}}', '--permission-mode', 'acceptEdits'],
      promptVia: 'stdin',
    },
    gemini: {
      command: 'gemini',
      args: ['--yolo', '--prompt-interactive'],
      promptVia: 'arg',
    },
  },
  templates: {},
};

const CONFIG_FILENAMES = ['multi-agent-review.json', '.multi-agent-review.json'];

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`could not read config ${file}: ${error.message}`);
  }
}

/**
 * Explicit path, else the first conventional filename found in the directories given, in order.
 *
 * The usual order is the repository being reviewed, then the user's home directory: project settings
 * where they belong, and a personal fallback for the things that are the same everywhere - which agent
 * to use, how it is allowed to authenticate.
 */
export async function loadConfigFile(explicitPath, searchDirs) {
  if (explicitPath) {
    const loaded = await readJson(path.resolve(explicitPath));
    if (!loaded) throw new Error(`config file not found: ${explicitPath}`);
    return { file: path.resolve(explicitPath), values: loaded };
  }

  const dirs = Array.isArray(searchDirs) ? searchDirs : [searchDirs];
  for (const dir of dirs.filter(Boolean)) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      const loaded = await readJson(candidate);
      if (loaded) return { file: candidate, values: loaded };
    }
  }
  return { file: null, values: {} };
}

/** Shallow merge, except `agents`, where a named agent is merged field by field. */
export function mergeConfig(base, override) {
  const merged = { ...base, ...override };
  merged.agents = { ...base.agents };
  for (const [name, definition] of Object.entries(override.agents ?? {})) {
    merged.agents[name] = { ...(base.agents[name] ?? {}), ...definition };
  }
  merged.templates = { ...base.templates, ...(override.templates ?? {}) };
  merged.tools = { ...base.tools, ...(override.tools ?? {}) };
  return merged;
}

/** Output directories default to the tool's own folder, away from the repository under review. */
export function toolDefaults(toolRoot) {
  return {
    planDir: path.join(toolRoot, 'plans'),
    logDir: path.join(toolRoot, '.multi-agent-review', 'logs'),
  };
}

/** An explicit directory is relative to where the user is standing; otherwise use the tool default. */
export function resolveOutputDir(value, fallback, cwd = process.cwd()) {
  return value ? path.resolve(cwd, value) : fallback;
}

/** The review file sits beside the artifact: `plan.md` -> `plan-review.md`. */
export function defaultReviewPath(artifact) {
  const directory = path.dirname(artifact);
  const stem = path.basename(artifact, path.extname(artifact));
  return path.join(directory, `${stem}-review.md`);
}

export function resolveAgent(config, role) {
  const name = config[role];
  const definition = config.agents[name];
  if (!definition) {
    const known = Object.keys(config.agents).join(', ');
    throw new Error(`no agent named "${name}" for the ${role} role. Known agents: ${known}`);
  }
  if (!definition.command) throw new Error(`agent "${name}" has no command`);
  return { name, ...definition };
}

/** Normalise severities to lower case and drop blanks. */
export function normaliseSeverityList(value) {
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}
