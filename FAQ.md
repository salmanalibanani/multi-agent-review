# FAQ

Answers to questions asked about this tool, kept here so they do not have to be researched twice.
Every answer cites the code it came from, so a future reader can check whether it is still true.

Format: one `##` question per entry, newest at the bottom, with the date it was answered and the
version of the tool at the time.

No real ticket keys, tracker hostnames or working-copy paths in here — this file is version-controlled
and the repo is public. Use `<KEY>`, `<ticket-url>` and `<path-to-the-repo-being-reviewed>`; anything
tracker-specific belongs in the untracked `plans/` directory.

---

## Can a run resume after the reviewer dies mid-round (e.g. Codex hits its usage limit)?

*Answered 2026-09-18, tool v0.2.0.*

**Yes — re-run the same command. Nothing needs re-doing by hand, and the resume costs only the
reviewer's tokens.** But "resume" means *restart the round that failed*, not *continue from where the
agent stopped inside it*. There is no mid-round checkpoint.

### What is actually persisted between runs

The tool keeps no state file. Resume is derived from three files on disk:

| File | Who writes it | What a re-run does with it |
|---|---|---|
| `plans/<KEY>.md` (ticket copy) | intake, `gh` or an agent | reused if present — `ensureTicket`, `src/intake.js:171-173` |
| `plans/<KEY>-PLAN.md` (the plan) | the planner/reviser agent | reused if present — `ensurePlan`, `src/intake.js:208-210` |
| `plans/<KEY>-PLAN-review.md` | the reviewer, one `## Round N` section per round | sets the starting round number — `src/loop.js:67`, `latestRoundNumber` in `src/verdict.js:28-31` |

So the loop starts at `latestRoundNumber(review) + 1`. An absent or empty review file means round 1.
`--refresh-ticket` and `--replan` are the overrides that force intake to run again; without them the
expensive intake work is never repeated.

The transcripts under `.multi-agent-review/logs/` are output only — nothing reads them back.

### What is lost

The reviewer's investigation inside the failed round. Its process is spawned per round with a fresh
session (`runAgent`, `src/agent.js`); when it exits non-zero the loop returns immediately with
`EXIT.AGENT` (4) and `stopReason` `"<reviewer> exited <code> in round <n>"` (`src/loop.js:121-127`).
Whatever it had read is gone with the process. On a re-run it reviews the same plan from scratch.

### The shape this answer came from

A Jira plan run whose reviewer hit its provider usage limit partway through round 1. The console
ended with:

```
Stopped because codex exited 1 in round 1.
```

`round-01-review.err.log` carried the real reason — `ERROR: You've hit your usage limit …` — while
`round-01-review.out.log` was 0 bytes and no `<KEY>-PLAN-review.md` had been written at all. With no
review file, the next run starts cleanly at **round 1**; the ticket copy and the plan were both still
on disk and were reused, so the planner was not paid for twice.

Resume with the same invocation, once the provider's quota is back:

```bash
node src/cli.js <ticket-url> --repo <path-to-the-repo-being-reviewed>
```

(`mar <ticket-url>` if it is installed globally. Add `--stream` to watch it; do **not** add `--replan`
or `--refresh-ticket` — those throw away the two files that make the resume cheap.)

### Two traps worth knowing before relying on this

1. **A half-written round heading poisons the numbering.** If the reviewer dies *after* writing
   `## Round 1` but *before* its `VERDICT:` line, that heading is still the highest round in the file,
   so the next run starts at round 2 and the stub section stays behind forever. Worse, the loop's
   contract check is `latestRoundNumber(reviewText) < round` (`src/loop.js:141-147`), so it would only
   notice at the *end* of the new round. If a run dies mid-round, open the review file and delete any
   trailing `## Round N` section that has no `VERDICT:` line before re-running.
2. **Resume is not a way to escape a wrong plan.** Falling severities across rounds mean convergence;
   High findings still appearing at round four or five mean the approach is wrong, and another round
   will not fix it.

### Related behaviour that is *not* resume

* **The guardrail baseline is taken fresh at the start of each run** (`snapshot(guardrail)` around each
  agent call, `src/loop.js:98`, `src/guardrail.js`). Working-tree changes that were already there when
  the run starts are the baseline, not a violation — only movement *during* an agent call aborts the
  run. So committing in the reviewed repo between runs is fine; committing mid-run is not.
* **Ctrl+C is safe.** `handleInterrupts` (`src/cli.js:175-184`) kills the agent and exits 130; the same
  resume rules apply. The README puts it as: "Nothing is lost by stopping a run with Ctrl+C and
  resuming tomorrow."
* **Hitting the round cap is not a failure.** The final round is still folded into the document before
  the loop exits with `EXIT.MAX_ROUNDS` (2), so re-running simply continues the numbering.
