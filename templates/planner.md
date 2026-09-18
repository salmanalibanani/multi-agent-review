Write the first draft of an implementation plan for this ticket.

Ticket copy: {{ticketFile}}
Ticket URL: {{url}}
Write the plan to: {{artifact}}

Read the ticket first, then investigate this codebase until you can write a plan grounded in what the
code actually does. Trace the behaviour end to end, find the callers and the existing tests, and check
the assumptions the ticket makes. The plan will be reviewed by a second agent that will open every file
and line you cite, so cite them accurately and do not assert what you have not verified.

## What the plan must contain

- **Header**: a title, `v1`, today's date ({{date}}), the ticket key and URL, and the baseline — the
  current commit (`git rev-parse --short HEAD`), whether it matches the upstream branch, and the branch
  name.
- **Problem**: what is wrong or missing, in terms of the code, with `file:line` references. For a
  defect, the root cause rather than the symptom.
- **Design**: the approach, and why this one. Name the alternatives you rejected and why.
- **Steps**: an ordered, concrete list — files, functions, what changes in each.
- **Tests**: what proves it, at which level, and which case would fail today. A test that cannot fail
  for the reported problem proves nothing.
- **Open decisions**: anything you could not settle from the ticket or the code, each with the options
  and a recommendation. Mark them `OPEN`.
- **Review findings**: leave the section present but empty, with a note that no rounds have run yet.
  Later rounds are recorded here as a table: `# | Severity | Point | Verified | Handling`.
- **Next steps**: what a person picking this up would do first, and a clear statement that nothing is
  implemented yet.

Severities used by the reviewer are {{severities}}.

## Limits

Write only {{artifact}}. Do not implement any of it: no product or test code, no build, no commits, no
changes to any other file, and nothing written back to the tracker. A watchdog inspects the working
tree when you exit and stops the run if anything else moved.

Where the ticket is ambiguous, say so in Open decisions rather than choosing silently. An honest plan
with three open questions is more useful than a confident one built on a guess.
