---
description: Run the Write a plan first workflow for a Karst ticket.
agent: build
---

# Write a plan first

This command receives a ticket key as its argument, available in `$ARGUMENTS`. First, load the ticket's full context by running `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" context --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" $ARGUMENTS` and read the result — re-run it any time you need to refresh live worktree, branch, service, or PR state. To understand how Karst works and what this CLI can do, run `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" guide`.

Phase marker commands write Karst state outside the worktree. If the workspace sandbox denies one, request approval to run that exact marker command outside the workspace sandbox.

Then work through the following phases in order:

1. **plan** — First run `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" phase plan --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket $ARGUMENTS` to report entering it. — Handle this step manually (no native slash command for this phase).
2. **implement** — First run `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" phase implement --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket $ARGUMENTS` to report entering it. — Handle this step manually (no native slash command for this phase).

When you have finished this stage's work — whether that is code, research, or a confirmation — run `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket $ARGUMENTS` to record the done marker and advance the ticket to its next stage. A session ending does not advance the ticket on its own — you must fire this marker explicitly. Do NOT fire it while you are waiting for the user to answer a question: a stage whose agent is waiting on the user is not complete, and the marker will be refused. If access to the Karst registry is denied, request approval to run this exact marker command outside the workspace sandbox.