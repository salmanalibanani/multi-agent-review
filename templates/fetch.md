Fetch this ticket and save a local Markdown copy of it. That copy is the only thing this task produces.

Ticket: {{url}}
Key: {{key}}
Tracker: {{provider}}
Save it to: {{ticket}}

Use whatever access you already have for this tracker — an MCP connector, a configured skill, an
authenticated CLI. Do not ask for credentials and do not invent content: if you cannot reach the ticket,
stop and say so plainly rather than writing a placeholder file.

Write the file as Markdown, containing:

- A heading with the key and the summary.
- The fields that matter for planning: type, status, priority, assignee, reporter, fix version or
  milestone, labels, components, created and updated dates, and the ticket URL.
- The full description, unabridged.
- Every comment, oldest first, each with its author and date. Paginate if the API returns only the
  first page — a truncated comment history hides the decisions.
- Linked or related tickets with their current status.
- Any acceptance criteria, exactly as written.

Keep the ticket's own wording rather than summarising it. Someone reading only this file should know
everything the tracker knows.

End the file with a line recording that it was fetched today, {{date}}.

Write no other file. Change nothing in the repository, run no build, and do not start any work the
ticket describes.
