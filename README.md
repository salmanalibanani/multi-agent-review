# multi-agent-review

Put a document through repeated adversarial review by two AI agents: one reviews it against the real
codebase, the other verifies each finding and folds the ones that survive back into the document.
Repeat until the reviewer has nothing material left to say.

It is built for the document you write *before* the code — a design, an RFC, an implementation plan —
where an hour of review is cheaper than a week of rework.

Give it a ticket and it does the whole thing: fetches a local copy, has an agent draft the plan, then
reviews and revises it round after round.

```
$ mar https://github.com/acme/widgets/issues/42

multi-agent-review
  Ticket    : widgets-42 (github) https://github.com/acme/widgets/issues/42
  Local copy: /repo/plans/widgets-42.md
  Plan      : /repo/plans/widgets-42-PLAN.md
  Review    : /repo/plans/widgets-42-PLAN-review.md
  Reviewer  : codex (codex), fresh session per round
  Reviser   : claude (claude)
  Stop rule : zero high and medium, or 10 rounds
  Guardrail : on, 27DE15F5E382 (/repo)

== Intake - widgets-42
   fetching with gh issue view
   ticket copy written via gh
   asking claude to draft the plan
   finished in 06:12
   plan drafted by claude

== Round 1 - review (codex)
   [00:20] working - exec rg --files . succeeded in 12ms
   [10:20] finished in 10:20
Round 1 verdict: 2 high, 3 medium, 0 low

== Round 1 - verify and revise (claude)
   finished in 09:31
Round 1 folded into the document.

== Round 2 - review (codex)
...
```

## Why two agents

A single agent reviewing its own plan grades its own homework. Two different models, with different
training and different blind spots, disagree usefully — and the disagreement is the product.

The second agent is not a rubber stamp. Its instructions are to open every cited `file:line` before
recording a finding and to write down what it checked. A reviewer is a source of claims, not an
authority; recording one as verified without opening the file is the single failure that makes the
whole loop worthless.

## Install

```bash
git clone https://github.com/<you>/multi-agent-review.git
cd multi-agent-review
npm link          # puts `mar` and `multi-agent-review` on your PATH
```

Node 20.11 or later, on **Linux, macOS or Windows**. No dependencies. CI runs the suite on all three
against Node 20, 22 and 24.

You also need the agent CLIs you intend to use. Out of the box it expects
[`codex`](https://developers.openai.com/codex/cli) as the reviewer and
[`claude`](https://docs.claude.com/en/docs/claude-code/overview) as the reviser, but any CLI that takes a
prompt and can read and write files will do — see [Agents](#agents).

## Quick start

**1. Check the agents are there.** The tool drives other people's CLIs; it does not talk to any model
itself.

```bash
codex --version     # the reviewer
claude --version    # the reviser and, for Jira, the fetcher
gh auth status      # only if you use GitHub tickets
```

**2. Tell it the ticket and the repository.** The reviewer reads real code to judge the plan, so it
needs to know which repository the work concerns. Either stand in it:

```bash
cd ~/work/my-project
mar https://github.com/my-org/my-project/issues/42
```

or name it from anywhere:

```bash
mar https://github.com/my-org/my-project/issues/42 --repo ~/work/my-project
```

Those are the only two inputs the tool needs. It fetches the issue, drafts a plan, then reviews and revises it until the
reviewer has nothing important left to say.

**3. Watch, or walk away.** A heartbeat prints every 20 seconds. Rounds take ten to twenty minutes each
on a large repository, so silence is normal — `--stream` shows every line if you want to see the
reasoning.

**4. Read the plan, not the review.** When it stops, `plans/<key>-PLAN.md` is the deliverable. It carries
the design, the steps, the tests, the open decisions, and a table showing how every finding from every
round was handled.

Nothing has been implemented. The plan is a proposal for you to approve, edit or throw away.

### Before your first serious run

Two defaults are worth a moment's thought.

**Permissions.** The reviser ships with `--permission-mode acceptEdits`, which lets it edit files but
refuses shell commands it has not been granted. Verification wants to run `git log`, `grep`, and a
tracker lookup or two, so most people end up granting more — see [Permissions](#permissions). Start
restrictive and loosen once you have watched a round.

**Where the files land.** By default, with the tool — `<multi-agent-review>/plans/` — and not in the
repository you are reviewing. One plans folder holds the work for every project you point it at, and
your product repos stay free of ticket text.

If your team would rather keep plans with the code, say so once in a config file:

```json
{ "planDir": "docs/plans", "maxRounds": 6 }
```

Save that as `multi-agent-review.json` in the repository. It is read automatically, and the tool's own
`.gitignore` keeps yours out of version control.

## Usage

```bash
mar <ticket-url | document> [options]
```

The single argument is either a ticket or a document.

### Ticket mode

```bash
mar https://github.com/acme/widgets/issues/42        # GitHub issue
mar https://github.com/acme/widgets/pull/42          # or a pull request
mar https://acme.atlassian.net/browse/ABC-123        # Jira
```

**A ticket is always a full URL.** Shorthands like `ABC-123` or `acme/widgets#42` are refused, with the
URL you meant:

```
error: a ticket must be given as a full URL, not "ABC-123"
       try: https://your-site.atlassian.net/browse/ABC-123
```

A bare key means nothing without a configured site, and a tool that behaves differently depending on
someone's config is hard to explain and easy to get wrong. The URL carries the tracker, the site and the
issue in one string that you can paste straight from your browser.

Three files appear, **beside the tool rather than in the repository being reviewed**:

```
<multi-agent-review>/plans/ABC-123.md                 the local ticket copy
<multi-agent-review>/plans/ABC-123-PLAN.md            the plan, drafted then revised each round
<multi-agent-review>/plans/ABC-123-PLAN-review.md     the reviewer's rounds, appended
```

That default is deliberate. Tracker content is not source code: a ticket copy and its review trail have
no business appearing as untracked files in a product repo, where they can be committed by accident and
carry issue text into a codebase that may be shared more widely than the tracker. Keeping them out has a
second effect worth as much — since the tool writes nothing inside the repository under review, **any**
change there during an agent call is a guardrail violation rather than an expected one.

Transcripts follow the same rule, landing in `<multi-agent-review>/.multi-agent-review/logs/`.

`--plan-dir` and `--log-dir` override both, and a relative path is resolved from where you are standing:
`--plan-dir docs/plans` puts them in the current project if that is what your team wants.

**Fetching.** GitHub goes through `gh`, which is already authenticated on a machine that uses it. Jira
has no universal CLI, so the fetch is handed to the agent, which reaches it through whatever connector
or skill it already has — an Atlassian MCP server, a configured skill, a company CLI. The tool holds no
credentials of its own and never invents ticket content: an agent that cannot reach the tracker is
expected to say so, and the run stops. `--fetch-with gh|agent` forces the choice.

The tool is not an MCP client. It delegates, which is why it needs no tracker integration of its own —
but it also means the agent must be allowed to call those tools. A headless session cannot answer a
permission prompt, so grant them explicitly:

```json
"agents": {
  "claude": {
    "args": ["-p", "--permission-mode", "acceptEdits",
             "--allowedTools", "mcp__<your-connector>__<read-tool>,mcp__<your-connector>__<search-tool>"]
  }
}
```

Substitute the tool names your own connector exposes. That shape is verified working: a headless
`claude -p` fetched a real Jira issue through an authenticated MCP connector — full description, all
comments, linked epic — in under four minutes, with no shell access and no `bypassPermissions`.

Your own config file is gitignored precisely so connector names, tracker URLs and directory layouts stay
on your machine.

**Drafting.** The plan is written by an agent (the reviser by default, or `planner` in config) that has
read the ticket copy and investigated the codebase. That draft is round 1's input, not its output — it
is *meant* to be wrong in places, and the review is what finds out where.

**Re-running is resumable.** An existing ticket copy and plan are reused, and the loop continues the
round numbering already in the review file. `--refresh-ticket` and `--replan` override that.

### Pointing it at a repository

The ticket says *what* to plan; the repository is *what it is planned against*. The reviewer traces the
behaviour, finds the callers, and checks the plan's claims against the code that is actually there — all
of it in the repository you name.

```bash
mar <ticket> --repo /path/to/project     # from anywhere
cd /path/to/project && mar <ticket>      # or just stand in it
```

`--repo` (also spelled `-w`/`--workdir`) is where the agents run, what the guardrail watches, and the
first place a config file is looked for. It is echoed back at the top of every run, so there is no doubt
which codebase a plan was judged against:

```
multi-agent-review
  Repo      : /home/you/work/my-project
  Ticket    : widgets-42 (github) https://github.com/my-org/my-project/issues/42
```

A path that is not a directory is refused. A directory that is not a git repository still works — the
agents can read it — but the guardrail cannot watch it and says so plainly:

```
  Guardrail : OFF - /tmp/scratch is not inside a git repository
```

Nothing is written into that repository: plans and transcripts live with the tool unless you redirect
them.

### Where config comes from

`multi-agent-review.json` is looked for in the repository first, then in your home directory. Project
settings go in the project; the things that are the same everywhere — which agent to drive, how it is
allowed to authenticate — belong in `~/multi-agent-review.json` and apply to every repository you point
the tool at. `--config <path>` overrides both.

### Document mode

```bash
mar docs/plan.md -c docs/requirements.md
```

No tracker involved: it reviews and revises the document you point at.

### Options

| Option | Default | |
|---|---|---|
| `-c, --context <path>` | ticket copy | Extra file the reviewer should read. Repeatable. |
| `-r, --review <path>` | beside the plan | Where rounds accumulate. |
| `--plan-dir <path>` | `<tool>/plans` | Where the ticket copy, plan and review live. Relative to your current directory. |
| `--log-dir <path>` | `<tool>/.multi-agent-review/logs` | Where transcripts go. |
| `--plan <path>` / `--ticket <path>` | derived from the key | Override either path. |
| `--fetch-with <how>` | `auto` | `gh` or `agent` to force the fetch route. |
| `--refresh-ticket` | off | Re-fetch even if the local copy exists. |
| `--replan` | off | Redraft the plan even if it exists. |
| `-m, --max-rounds <n>` | `10` | Round cap. |
| `-s, --stop-on <list>` | `high,medium` | Severities that must reach zero. |
| `-t, --timeout <minutes>` | `30` | Per agent call. |
| `-w, --workdir <path>` | cwd | Directory the agents run in. |
| `--reviewer <name>` / `--reviser <name>` | `codex` / `claude` | Which configured agent plays each role. |
| `--allow <path>` | none | Another path the agents may change. Repeatable. |
| `--no-guardrail` | off | Skip the working-tree check. |
| `--stream` | off | Echo every agent line instead of a heartbeat. |
| `--dry-run` | off | Resolve everything, print the first prompt, run no agent. |

Exit codes: `0` clean, `1` usage, `2` cap reached, `3` guardrail, `4` agent failed or timed out,
`5` an agent broke the output contract.

## How a run works

In ticket mode the run starts with **intake**: fetch the ticket, draft the plan. Both steps are watched
by the same guardrail as a round, and both are skipped if their file already exists.

## How a round works

1. **Review.** A *fresh* reviewer session — no memory of the last round, so each review is independent —
   reads the document, the context files and the repository, and appends a `## Round N` section to the
   review file ending in a machine-readable verdict.
2. **Guardrail.** The working tree is compared with the moment before the agent started.
3. **Verdict.** Parsed from the new round. Zero in every `--stop-on` severity ends the loop.
4. **Revise.** The reviser verifies each finding against the code, records the disposition in the
   document, applies the changes that survive, and bumps the document's version.
5. **Guardrail again.**

When the cap is reached the final round is still folded in, so the **document** is what you read when
the rounds run out — not a raw review file. What is missing then is only the reviewer's confirmation of
the result.

Re-running resumes: the loop continues the round numbering already in the review file.

## Reading the results

The run ends with a table, a stop reason and three paths:

```
  Round | Verdict                 | Folded in
  ------|-------------------------|----------
  1     | 2 high, 3 medium, 0 low | yes
  2     | 1 high, 1 medium, 1 low | yes
  3     | 0 high, 0 medium, 2 low | not needed
Stopped because codex raised nothing above the threshold in round 3 (2 low left to judge).
```

The exit code says what happened without reading anything: `0` clean, `2` cap reached, `3` guardrail,
`4` agent failure, `5` broken contract.

**What to look at, in order:**

1. **The plan's disposition table.** Every finding, its severity, whether it held, and what was
   checked. A row reading `no - the cited line does not do that` is as valuable as a fix; it is the
   reviser having caught the reviewer being wrong.
2. **The open decisions.** Anything the agents could not settle from the ticket or the code. These are
   for you, and they are the most common reason a plan is still not ready.
3. **The Low findings**, if the stop reason mentions any. They were deliberately not chased.
4. **The review file**, only if you want to see a finding in the reviewer's own words.

**Judging whether it converged.** Falling severities across rounds mean the plan is improving. A run
still turning up High findings at round four or five usually means the *approach* is wrong, not the
wording — stop and rethink rather than spending more rounds. Equally, a round-one `CLEAN` on a
substantial change is worth distrusting: check the reviewer actually investigated, in its transcript.

**Picking up later.** Re-running the same ticket reuses the ticket copy and plan and continues the round
numbering. Nothing is lost by stopping a run with Ctrl+C and resuming tomorrow.

## The verdict contract

The last line of each round must be machine readable:

```
VERDICT: 2 HIGH, 1 MEDIUM, 3 LOW
VERDICT: CLEAN
```

Prose is deliberately not parsed — "no major issues" is not a verdict. Severity names are not
hard-coded: `VERDICT: 1 BLOCKER, 4 NIT` works if `--stop-on blocker` is what you asked for. A severity
nobody reported counts as zero.

Two rounds in a row without a parseable verdict stop the run, on the grounds that the reviewer is not
honouring its instructions and more rounds will not help.

### Why stop at zero high and medium, rather than zero findings

A capable reviewer almost always finds *something* Low. Demanding zero findings tends not to converge;
it just burns the cap. The default stops when nothing important is left and reports the Lows for you to
judge. Use `--stop-on high,medium,low` if you disagree.

## The guardrail

The agents are given write access — the reviewer must save its review, the reviser must edit the
document. Nothing else should move.

Before and after **every** agent call the tool hashes `git status --porcelain` plus the full `git diff
HEAD`, with the document, review file and log directory excluded by pathspec. Any difference stops the
run and prints what changed. The diff matters as much as the status: an edit to an already-modified
file leaves the porcelain line unchanged and would otherwise pass unnoticed.

Two details learned the hard way:

- **The window is one agent call, not the whole run.** An earlier version took a single baseline at
  startup, which meant committing your own unrelated work during a two-hour run aborted the loop. Now
  only a change made *while an agent is running* counts.
- **A moved HEAD is named as such.** If the repository was committed, checked out or reset during the
  window, the message says so instead of reporting a generic mystery.

Outside a git repository there is nothing cheap to fingerprint, so the guardrail reports itself off
rather than pretending to be safe.

## Agents

An agent is any CLI that accepts a prompt and can read and write files. They are configuration, not
code:

```json
{
  "agents": {
    "my-agent": {
      "command": "some-cli",
      "args": ["review", "--repo", "{{workdir}}"],
      "promptVia": "stdin",
      "env": { "SOME_API_MODE": "review" }
    }
  }
}
```

`promptVia` is `stdin` (default) or `arg` (appended to `args`). Placeholders available in `args` and in
both prompt templates: `artifact`, `review`, `context`, `contextList`, `contextCount`, `round`, `date`,
`workdir`, `stopOn`, `severities`, `severityLine`.

Config is read from `multi-agent-review.json` in the working directory, or `--config <path>`. See
[`multi-agent-review.example.json`](multi-agent-review.example.json).

### Permissions

The reviser defaults to `claude -p --permission-mode acceptEdits`: it may edit files, but a shell
command it has not been granted is refused rather than queued for a prompt no one can answer in a
headless session. That is the cautious default, and it can make verification thin — the agent wanted to
run `git log` and could not.

`bypassPermissions` is the practical setting for an unattended run, and the guardrail is what actually
bounds the blast radius. Decide deliberately; the example config shows the override.

## Prompts

All four prompts are plain Markdown in [`templates/`](templates) - `fetch`, `planner`, `reviewer` and
`reviser` - each replaceable through the `templates` block in config. What makes a review useful is domain-specific, so expect to edit them.

The shipped reviser prompt carries one instruction worth keeping: where a finding is correct but would
materially expand the scope of the work, it must be recorded as an open decision rather than silently
absorbed. Without it, an enthusiastic reviewer will grow a focused plan into a rewrite, one reasonable
finding at a time.

## Logs

Everything lands in `<multi-agent-review>/.multi-agent-review/logs/` — prompt, stdout and stderr per
agent per round, plus a `summary.md` with the round-by-round verdicts and the stop reason. Like the
plans, they stay out of the repository under review; `--log-dir` moves them.

Both `plans/` and `.multi-agent-review/` are gitignored here, so nothing the tool produces can reach a
public repo by accident. If you redirect either into a project of your own with `--plan-dir` or
`--log-dir`, add the same rules there — or commit the plans deliberately, which plenty of teams prefer
for the review trail alone.

**Most coding agents write their progress to stderr**, so `*.err.log` is usually the interesting one.
That is also why the console shows a heartbeat: with both streams redirected to files, a ten-minute
round looks identical to a hung process.

## What it costs

Each round is a full codebase investigation plus a full verification pass. Ten to twenty minutes per
half is normal on a large repository, so a ten-round run is a few hours and a lot of tokens. Most
documents converge in two to four rounds. If round four is still turning up High findings, the document
probably needs a rethink rather than another round.

## Platform notes

The loop spawns other people's CLIs and sometimes has to kill them, which is where platforms differ
most. Three things are handled for you:

- **Windows cannot exec a `.cmd` or `.bat` directly.** Agent CLIs installed through npm land as
  `claude.cmd`, `gemini.cmd` and so on, and a naive `spawn('claude')` fails with `ENOENT`. Commands are
  resolved along `PATH` using `PATHEXT`, and a batch shim is run through `cmd.exe /d /s /c` with each
  argument quoted. If your machine happens to have a native `.exe`, this is invisible — until a
  colleague on a different install tries it.
- **A killed agent takes its children with it.** Coding agents spawn compilers, language servers and
  searches. On POSIX the agent is spawned detached so the whole process group can be signalled, then
  escalated from `SIGTERM` to `SIGKILL`; on Windows it is `taskkill /T /F`. A timeout that leaves a
  language server running is not a timeout.
- **Environment variables are case-insensitive on Windows.** Adding `PATH` to an environment that
  already has `Path` would otherwise hand the child two entries and let the runtime pick.

Beyond that: review files are read whether they use LF or CRLF endings, dates in prompts and summaries
are local rather than UTC, and paths are canonicalised before being compared with git's view of them —
Windows 8.3 short paths (`C:\Users\RUNNER~1\...`) and the macOS `/var` → `/private/var` symlink both make
an allowed path look like it is outside the repository otherwise.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `could not run "claude"` | The agent is not on `PATH`, or is an npm shim the resolver missed | Check `claude --version` in the same shell. Put an absolute path in `agents.<name>.command` if needed |
| Nothing on screen for minutes | Normal. Agents write progress to stderr and a round is long | Watch the heartbeat, or use `--stream`. The full transcript is in `*.err.log` |
| `<agent> did not write <path>` | The agent could not do the job — usually no tracker access, or a tool call it was not allowed to make | Read the transcript named in the message. For Jira, grant the connector tools (see [Permissions](#permissions)) |
| `gh is not on PATH, so this GitHub ticket falls back to the agent` | Exactly that. The run continues, more slowly and less exactly | Install the GitHub CLI, or pass `--fetch-with agent` to silence the choice |
| `appended no "## Round N" section` | The reviewer ignored the output contract | Run once with `--stream` to see what it did instead. Usually the review prompt needs tightening for your domain |
| `no parseable VERDICT line twice running` | Same cause, twice — the tool stops rather than burning the cap | As above. Check `templates/reviewer.md` survived any customisation |
| `guardrail: HEAD moved from X to Y` | Someone committed, checked out or reset during an agent call — often you, in another window | Re-run; it resumes. Avoid committing in that repo mid-run |
| `guardrail: files outside the allowed paths were modified` | An agent wrote where it should not have | Inspect the printed `git status`. If the change was legitimate, allow it with `--allow <path>` |
| `<agent> timed out after 30 minutes` | A big repository, or a stuck agent | `--timeout 45`. The agent and its children are killed, so nothing is left running |
| It never converges, all Low findings | The stop rule is already ignoring Low by default — so this means real High or Medium findings keep arriving | Read them. Persistent Highs mean the approach needs rethinking, not more rounds |
| The plan is thin and the review agrees with everything | The reviser may be rubber-stamping — check it cited `file:line` in the Verified column | Loosen its permissions so it can actually read the repo, and check the transcript |

## Limitations

- It cannot tell a misbehaving agent from a human editing the repo during an agent call.
- It trusts the reviewer to honour the verdict contract, and stops rather than guessing when it does not.
- It never implements, builds or commits anything. The document is the only thing that changes.

## Development

```bash
npm test          # 78 tests, no network, no agent CLIs required
```

The suite runs the whole loop against stand-in agents that behave like real ones in the ways that
matter — prompt on stdin, commentary on stderr, files written where an agent would write them — and
covers the stop rules, the cap, resume, contract violations, timeouts, and both guardrail directions.

The platform tests are real rather than mocked: a `.cmd` shim is written and executed on Windows, a
shebang script on POSIX, and the process-tree kill is proved by starting a grandchild process and
checking its pid is gone afterwards. Tests that cannot apply to the host platform are skipped, so a
green run on one OS is not evidence for another — that is what the CI matrix is for.

## Licence

MIT
