import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import { ensurePlan, ensureTicket } from '../src/intake.js';
import { isWindows } from '../src/platform.js';
import { parseTicket, ticketPaths } from '../src/ticket.js';

const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

const silentReporter = {
  phase: () => {},
  agentLine: () => {},
  detail: () => {},
  verdict: () => {},
  folded: () => {},
  warn: () => {},
  guardrail: () => {},
  dryRun: () => {},
};

/**
 * A launcher for a fake CLI that works on this platform: a .cmd shim on Windows, a shebang script
 * elsewhere. This is how a real `gh` appears on PATH, so it exercises the same code path.
 */
function makeExecutable(dir, name, scriptPath) {
  if (isWindows) {
    const shim = path.join(dir, `${name}.cmd`);
    writeFileSync(shim, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, name);
  writeFileSync(shim, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function workspace(overrides = {}, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar-intake-'));
  const logDir = path.join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const config = mergeConfig(DEFAULT_CONFIG, {
    fetcher: 'fake-writer',
    planner: 'fake-writer',
    timeoutMinutes: 1,
    heartbeatSeconds: 0,
    agents: {
      'fake-writer': {
        command: process.execPath,
        args: [fixture('fake-writer.js')],
        promptVia: 'stdin',
        env,
      },
    },
    ...overrides,
  });

  return {
    dir,
    logDir,
    config,
    options: (ticket, extra = {}) => {
      const paths = ticketPaths(ticket, path.join(dir, 'plans'));
      return {
        ticket,
        ticketPath: paths.ticket,
        planPath: paths.plan,
        config,
        paths: { artifact: paths.plan, context: [], review: paths.review, workdir: dir, logDir },
        reporter: silentReporter,
        stream: false,
        logDir,
        ...extra,
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('fetches a GitHub issue with gh', async () => {
  const ws = workspace();
  try {
    const gh = makeExecutable(ws.dir, 'fake-gh', fixture('fake-gh.js'));
    ws.config.tools.gh = gh;

    const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
    const options = ws.options(ticket);
    const how = await ensureTicket(options);

    assert.equal(how, 'gh');
    const markdown = readFileSync(options.ticketPath, 'utf8');
    assert.match(markdown, /# acme\/widgets#42 - Totals are wrong/);
    assert.match(markdown, /off by one/);
    assert.match(markdown, /### maintainer/);
  } finally {
    ws.cleanup();
  }
});

test('routes a GitHub issue to `gh issue view` with the URL', async () => {
  const ws = workspace();
  try {
    const argvFile = path.join(ws.dir, 'argv.json');
    const gh = makeExecutable(ws.dir, 'fake-gh', fixture('fake-gh.js'));
    ws.config.tools.gh = gh;
    process.env.FAKE_GH_ARGV = argvFile;

    const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
    await ensureTicket(ws.options(ticket));

    const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.deepEqual(argv.slice(0, 3), ['issue', 'view', 'https://github.com/acme/widgets/issues/42']);
    assert.equal(argv[3], '--json');
    assert.match(argv[4], /(^|,)comments(,|$)/, 'comments are requested');
    assert.match(argv[4], /(^|,)body(,|$)/, 'the description is requested');
  } finally {
    delete process.env.FAKE_GH_ARGV;
    ws.cleanup();
  }
});

test('routes a pull request to `gh pr view` and asks for the changed files', async () => {
  const ws = workspace();
  try {
    const argvFile = path.join(ws.dir, 'argv.json');
    const gh = makeExecutable(ws.dir, 'fake-gh', fixture('fake-gh.js'));
    ws.config.tools.gh = gh;
    process.env.FAKE_GH_ARGV = argvFile;

    const ticket = parseTicket('https://github.com/acme/widgets/pull/7');
    await ensureTicket(ws.options(ticket));

    const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.deepEqual(argv.slice(0, 2), ['pr', 'view']);
    assert.match(argv[4], /(^|,)files(,|$)/);
    assert.match(argv[4], /(^|,)headRefName(,|$)/);
  } finally {
    delete process.env.FAKE_GH_ARGV;
    ws.cleanup();
  }
});

test('warns rather than silently falling back when gh is missing', async () => {
  const warnings = [];
  const ws = workspace();
  try {
    ws.config.tools.gh = 'definitely-not-installed-gh';
    const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
    const options = ws.options(ticket);
    options.reporter = { ...silentReporter, warn: (text) => warnings.push(text) };

    assert.equal(await ensureTicket(options), 'fake-writer');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not on PATH.*falls back to the agent/s);
  } finally {
    ws.cleanup();
  }
});

test('a gh failure explains what to try next', async () => {
  const ws = workspace({}, {});
  try {
    const gh = makeExecutable(ws.dir, 'fake-gh', fixture('fake-gh.js'));
    ws.config.tools.gh = gh;
    ws.config.agents['fake-writer'].env = {};

    const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
    const options = ws.options(ticket);
    options.config.agents['fake-writer'].env = { FAKE_GH_FAIL: '1' };
    process.env.FAKE_GH_FAIL = '1';

    await assert.rejects(ensureTicket(options), /gh could not read .*--fetch-with agent/s);
  } finally {
    delete process.env.FAKE_GH_FAIL;
    ws.cleanup();
  }
});

test('falls back to the agent when gh is not installed', async () => {
  const ws = workspace();
  try {
    ws.config.tools.gh = 'definitely-not-installed-gh';
    const ticket = parseTicket('https://github.com/acme/widgets/issues/42');
    const options = ws.options(ticket);

    const how = await ensureTicket(options);
    assert.equal(how, 'fake-writer');
    assert.match(readFileSync(options.ticketPath, 'utf8'), /Ticket copy written by fake-writer/);
  } finally {
    ws.cleanup();
  }
});

test('Jira always goes through the agent', async () => {
  const ws = workspace();
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    const options = ws.options(ticket);

    const how = await ensureTicket(options);
    assert.equal(how, 'fake-writer');
    assert.match(options.ticketPath, /ABC-123\.md$/);
    assert.equal(existsSync(options.ticketPath), true);
  } finally {
    ws.cleanup();
  }
});

test('--fetch-with gh is refused for a Jira ticket', async () => {
  const ws = workspace();
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    await assert.rejects(
      ensureTicket(ws.options(ticket, { fetchWith: 'gh' })),
      /only works for GitHub tickets/,
    );
  } finally {
    ws.cleanup();
  }
});

test('an existing ticket copy is reused, and --refresh-ticket overrides that', async () => {
  const ws = workspace();
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    const options = ws.options(ticket);

    mkdirSync(path.dirname(options.ticketPath), { recursive: true });
    writeFileSync(options.ticketPath, 'hand-written copy\n');

    assert.equal(await ensureTicket(options), 'existing');
    assert.match(readFileSync(options.ticketPath, 'utf8'), /hand-written/);

    assert.equal(await ensureTicket({ ...options, refresh: true }), 'fake-writer');
    assert.match(readFileSync(options.ticketPath, 'utf8'), /fake-writer/);
  } finally {
    ws.cleanup();
  }
});

test('an agent that writes nothing is reported, with the transcript location', async () => {
  const ws = workspace({}, { FAKE_BEHAVIOUR: 'nothing' });
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    await assert.rejects(ensureTicket(ws.options(ticket)), /did not write .*logs/s);
  } finally {
    ws.cleanup();
  }
});

test('a failing agent is reported with its exit code', async () => {
  const ws = workspace({}, { FAKE_BEHAVIOUR: 'fail' });
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    await assert.rejects(ensureTicket(ws.options(ticket)), /exited 4 fetching/);
  } finally {
    ws.cleanup();
  }
});

test('drafts the plan, and the prompt carries the path it must write', async () => {
  const ws = workspace();
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    const options = ws.options(ticket);
    await ensureTicket(options);

    const how = await ensurePlan(options);
    assert.equal(how, 'fake-writer');
    assert.match(readFileSync(options.planPath, 'utf8'), /drafted by fake-writer/);
    assert.match(readFileSync(options.planPath, 'utf8'), /## Review findings/);

    const prompt = readFileSync(path.join(ws.logDir, 'intake-plan-prompt.txt'), 'utf8');
    assert.ok(prompt.includes(options.ticketPath), 'the planner is told where the ticket copy is');
  } finally {
    ws.cleanup();
  }
});

test('an existing plan is reused, and --replan overrides that', async () => {
  const ws = workspace();
  try {
    const ticket = parseTicket('https://acme.atlassian.net/browse/ABC-123');
    const options = ws.options(ticket);
    mkdirSync(path.dirname(options.planPath), { recursive: true });
    writeFileSync(options.planPath, '# my own plan\n');

    assert.equal(await ensurePlan(options), 'existing');
    assert.match(readFileSync(options.planPath, 'utf8'), /my own plan/);

    assert.equal(await ensurePlan({ ...options, replan: true }), 'fake-writer');
    assert.match(readFileSync(options.planPath, 'utf8'), /fake-writer/);
  } finally {
    ws.cleanup();
  }
});
