# sbx manual checklist — sandbox stage contract (T-A, D191)

sbx cannot run in CI, so the live half of the stage-contract acceptance is this checklist. Record the evidence in the ticket (command output, the `events.ndjson` lines, the stage before and after). The automated half is `src/agent/sbx/sbxCorePins.test.ts` (argv, rendered instruction, env, evidence dir, claude + codex) and `src/extension/ops/sandboxStageContract.integration.test.ts` (the whole marker flow with a local exec shim).

Run it once for **claude** and once for **codex**, on a disposable single-repo ticket with `agentBackends: { <core>: sbx }`.

| # | Step | Expected | Evidence |
|---|------|----------|----------|
| 1 | Launch the ticket. | Terminal runs `sbx run --clone --name karst-<hash8>-<id>-<core> <core> <project>/.karst/sbx-clones/<name> <bridge dir> -- …`. The clone dir is **not** under `karst.yml` (F9). `sbx ls` lists the sandbox. | argv from the Karst output channel, `sbx ls` |
| 2 | Look at the first seed / instructions the agent receives. | A marker command `node <bridge dir>/<core>/emit-marker.cjs <bridge dir>/events.ndjson impl`; no `$KARST_CLI`, `--db`, `stage … pass`, MCP, or "approval outside the sandbox". | the instructions file / terminal scrollback |
| 3 | In the sandbox: `env \| grep KARST`. | Only `KARST_TICKET`, `KARST_TICKET_ID`, `KARST_LAUNCH_ID`, `KARST_PROVIDER` (and `KARST_BRIDGE_DIR`). No `KARST_CLI`, `KARST_DB`, `KARST_MANIFEST`, `KARST_INSTRUCTIONS`. | the `env` output |
| 4 | Let the agent do one tool call, then read `<bridge dir>/events.ndjson` on the host. | Hook lines `{"v":1,"kind":"hook","ticket":<n>,"payload":{"hook_event_name":…}}`. claude: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`. codex: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`. Record the kinds actually seen. | the lines |
| 5 | Ask the agent to write a file, **commit**, then run the marker command. | Exit 0, "done marker accepted; the stage advanced". Host: the worktree fast-forwarded to the sandbox commit, ticket stage moved impl → uat (per `STAGE_GRAPH`), a `results/<seq>.json` with `ok:true`. | exit code, `git log`, ticket stage |
| 6 | Repeat with an **uncommitted** change. | Exit 1, "Commit your changes first"; **no** new line in `events.ndjson`. | exit code, file unchanged |
| 7 | Put the ticket at `fix` (fail a gate) and let the agent fix it directly (no review round). | Fix brief file appears at `<bridge dir>/inbox/fix-<id>.md`; a typed pointer names it and `emit-ack.cjs`; running the ack marks the delivery read; the fix marker (`… fix`) advances fix → uat. | the inbox file, the pointer line, stage |
| 8 | Reload the VS Code window mid-session, then run the marker again from a new change. | The reattached poller picks it up (no replay of the earlier marker); the stage advances. | extension log (`[bridge] … already handled`), stage |
| 9 | Command Palette → `Karst: Sync sandbox` with no ticket selected. | A quick pick of sandboxed tickets (not a silent no-op). | screenshot / note |
| 10 | Plant `.git/hooks/post-merge`, `core.fsmonitor` and an `ext::` remote in the sandbox clone, then sync. | Sync still fast-forwards; none of them ran on the host. | marker file absent |

Not yet covered live (follow-ups): docker runner end to end with the real opencode image (the same bridge/sync/stage pieces are exercised by the automated tests; run the docker half of the table with `agentBackends: { opencode2: docker }` when the image is built).
