A reviewer has just reviewed this document. Fold that review into it.

Document to revise: {{artifact}}
Review file: {{review}}
Supporting context:
{{contextList}}

Work on the latest `## Round {{round}}` section of the review only. Earlier rounds are already recorded.

## Verify before you write

Check every finding against the code and the repository BEFORE you record it. Open the cited
`file:line`, search for the symbol, run the commands behind any claim about history or baseline. Decide
per finding whether it holds, partly holds, or does not hold, and say exactly what you checked. A
finding that does not hold changes nothing in the document and is recorded as `no - <why>`.

A reviewer is not an authority. Its findings are claims to be tested, and recording one as verified when
you have not opened the file is the one failure that makes this whole loop worthless.

## Then revise

- Record the round in the document's review-disposition section as a table:
  `# | Severity | Point | Verified | Handling`.
- For each finding that holds, make the corresponding change in the body of the document. A table row
  alone does not handle a finding.
- Where a finding is correct but would materially expand the scope of the work, do not silently absorb
  it. Record it as an open decision, with the options and who should decide.
- Update the document's version and revision note to say it was revised after round {{round}} on
  {{date}}, and refresh any "next steps" or resume section.
- Leave any instruction block addressed to the reviewer intact and verbatim, including its verdict-line
  requirement.

## Limits

Change nothing except {{artifact}}. Write no other file, do not modify the review file, do not implement
anything the document proposes, do not run a build, and do not change git state. A watchdog inspects the
working tree after you exit and aborts the run if anything else moved.

If a finding demands a code change, describe it in the document - do not make it.
