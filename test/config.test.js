import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { promptValues } from '../src/prompts.js';
import {
  DEFAULT_CONFIG,
  defaultReviewPath,
  loadConfigFile,
  mergeConfig,
  normaliseSeverityList,
  resolveAgent,
  resolveOutputDir,
  toolDefaults,
} from '../src/config.js';

test('the review file sits beside the document', () => {
  assert.equal(defaultReviewPath(path.join('docs', 'plan.md')), path.join('docs', 'plan-review.md'));
  assert.equal(defaultReviewPath('rfc.markdown'), 'rfc-review.md');
});

test('merging keeps built-in agents and overlays named fields', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    maxRounds: 3,
    agents: { claude: { args: ['-p', '--permission-mode', 'bypassPermissions'] } },
  });

  assert.equal(merged.maxRounds, 3);
  assert.equal(merged.agents.claude.command, 'claude', 'untouched fields survive');
  assert.deepEqual(merged.agents.claude.args, ['-p', '--permission-mode', 'bypassPermissions']);
  assert.ok(merged.agents.codex, 'other agents are left alone');
});

test('a config file can add an agent of its own', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    reviewer: 'my-agent',
    agents: { 'my-agent': { command: 'my-cli', args: ['review'], promptVia: 'arg' } },
  });
  const agent = resolveAgent(merged, 'reviewer');
  assert.equal(agent.command, 'my-cli');
  assert.equal(agent.promptVia, 'arg');
});

test('an unknown agent names the ones that do exist', () => {
  assert.throws(
    () => resolveAgent({ ...DEFAULT_CONFIG, reviewer: 'nope' }, 'reviewer'),
    /no agent named "nope".*Known agents: codex/s,
  );
});

test('severity lists accept a string or an array, in any case', () => {
  assert.deepEqual(normaliseSeverityList('High, Medium'), ['high', 'medium']);
  assert.deepEqual(normaliseSeverityList(['HIGH', ' low ']), ['high', 'low']);
  assert.deepEqual(normaliseSeverityList('high,,'), ['high']);
});

test('config is looked for in the repository first, then the user home directory', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'mar-repo-'));
  const home = mkdtempSync(path.join(tmpdir(), 'mar-home-'));
  try {
    writeFileSync(path.join(home, 'multi-agent-review.json'), JSON.stringify({ maxRounds: 9 }));

    // Nothing in the repository: the personal fallback is used.
    let found = await loadConfigFile(undefined, [repo, home]);
    assert.equal(path.dirname(found.file), home);
    assert.equal(found.values.maxRounds, 9);

    // A repository config wins over it.
    writeFileSync(path.join(repo, 'multi-agent-review.json'), JSON.stringify({ maxRounds: 2 }));
    found = await loadConfigFile(undefined, [repo, home]);
    assert.equal(path.dirname(found.file), repo);
    assert.equal(found.values.maxRounds, 2);

    // Neither: defaults.
    const empty = mkdtempSync(path.join(tmpdir(), 'mar-none-'));
    assert.equal((await loadConfigFile(undefined, [empty])).file, null);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a config file is discovered in the working directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-config-'));
  try {
    writeFileSync(path.join(dir, 'multi-agent-review.json'), JSON.stringify({ maxRounds: 2 }));
    const { file, values } = await loadConfigFile(undefined, dir);
    assert.equal(path.basename(file), 'multi-agent-review.json');
    assert.equal(values.maxRounds, 2);

    const none = await loadConfigFile(undefined, path.join(dir, 'empty'));
    assert.equal(none.file, null);

    await assert.rejects(loadConfigFile(path.join(dir, 'missing.json'), dir), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output directories default to the tool folder, not the repo under review', () => {
  const toolRoot = path.join(path.sep, 'opt', 'multi-agent-review');
  const defaults = toolDefaults(toolRoot);

  assert.equal(defaults.planDir, path.join(toolRoot, 'plans'));
  assert.equal(defaults.logDir, path.join(toolRoot, '.multi-agent-review', 'logs'));

  // Nothing lands inside the repository being reviewed unless the user asks for it.
  const repo = path.join(path.sep, 'work', 'product');
  assert.equal(resolveOutputDir(null, defaults.planDir, repo), path.join(toolRoot, 'plans'));
  assert.equal(DEFAULT_CONFIG.planDir, null);
  assert.equal(DEFAULT_CONFIG.logDir, null);
});

test('an explicit directory is relative to where the user is standing', () => {
  const cwd = path.join(path.sep, 'work', 'product');
  // path.resolve is what production uses, so the expectation must agree - on Windows it also
  // supplies the drive letter.
  assert.equal(resolveOutputDir('docs/plans', '/ignored', cwd), path.resolve(cwd, 'docs', 'plans'));
  assert.equal(
    resolveOutputDir(path.join(path.sep, 'elsewhere'), '/ignored', cwd),
    path.resolve(path.sep, 'elsewhere'),
  );
});

test('the built-in agents are granted the directory the documents live in', () => {
  // The plans folder sits outside the repository by default, and both agents are sandboxed to the
  // repository. Without --add-dir the reviewer reviews the plan and then cannot save its review.
  for (const name of ['codex', 'claude']) {
    const args = DEFAULT_CONFIG.agents[name].args;
    const at = args.indexOf('--add-dir');
    assert.ok(at >= 0, `${name} should be granted the plans directory`);
    assert.equal(args[at + 1], '{{planDir}}', `${name} --add-dir should take the plans directory`);
  }
});

test('promptValues exposes the directories the documents live in', () => {
  const values = promptValues({
    artifact: path.join(path.sep, 'tool', 'plans', 'ABC-1-PLAN.md'),
    review: path.join(path.sep, 'tool', 'plans', 'ABC-1-PLAN-review.md'),
    context: [],
    round: 1,
    workdir: path.join(path.sep, 'work', 'product'),
    stopOn: ['high'],
    severities: ['High'],
  });
  assert.equal(values.planDir, path.join(path.sep, 'tool', 'plans'));
  assert.equal(values.reviewDir, path.join(path.sep, 'tool', 'plans'));
});
