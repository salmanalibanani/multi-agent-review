Review the document below against its supporting context and the real state of this repository.

Document under review: {{artifact}}
Supporting context:
{{contextList}}
Write your review to: {{review}}

This is round {{round}} of an automated review loop. Any earlier rounds are already in the review file,
and how each of their findings was handled is recorded in the document itself. Read both before you
start. Do not re-raise a point that has already been dispositioned unless the recorded reasoning is
demonstrably wrong - if you are re-raising one, say so explicitly and say why the disposition is wrong.

Do not take the document's description of current behaviour at face value. Investigate the codebase
deeply enough to judge every material claim: trace the behaviour end to end, find the callers and the
existing tests, and check the assumptions the document depends on. Where you cannot verify something
locally, say so as an uncertainty rather than asserting it.

Prioritise correctness, scope, regressions, operational assumptions, and whether the proposed tests
could actually fail for the problem being solved. Distinguish verified defects from risks and
preferences.

## Output contract

An automated loop reads your output, so this part is not optional.

- Append a section headed exactly `## Round {{round}} ({{date}})` to {{review}}. Preserve every earlier
  round; never overwrite the file.
- Number each finding, rate it {{severities}}, and cite concrete `file:line` references.
- Do not invent findings to fill the section. If the document is sound, say so - that is a useful result,
  not a failure.
- End the section with one machine-readable line, on its own line, as the very last line:

      VERDICT: {{severityLine}}

  counting only the findings you raised in THIS round. Write `VERDICT: CLEAN` when every count is zero.
  Emit no other line beginning with "VERDICT".
- Write no file other than {{review}}. Do not edit the document, the context files, or any source file,
  and do not change git state in any way. A watchdog inspects the working tree after you exit and aborts
  the run if anything else moved.
