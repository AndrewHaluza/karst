# /karst:rpi — Research → Plan → Implement

This command receives a ticket key as its argument, available in `$ARGUMENTS`. First, load the ticket's full context by running `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" context --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" $ARGUMENTS` and read the result — re-run it any time you need to refresh live worktree, branch, service, or PR state.

Then work through the following phases in order:

1. **describe** — Handle this step manually (no native slash command for this phase).
2. **research** — Run the `/rpi:research` slash command.
3. **plan** — Run the `/rpi:plan` slash command.
4. **implement** — Run the `/rpi:implement` slash command.

When you have finished this stage's work — whether that is code, research, or a confirmation — run `node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --ticket $ARGUMENTS` to record the done marker and advance the ticket to its next stage. A session ending does not advance the ticket on its own — you must fire this marker explicitly.