<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/arch/autopilot.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'arch:AP-00'):
  awk "/^## \[@arch:AP-00\]/,/END_DOC_BLOCK: \[@arch:AP-00\]/" docs/arch/autopilot.md
-->
# Autopilot (auto-fix at ship)

Autopilot runs the same host actions a user clicks at the ship stage. It does not add a new action. Related: `docs/arch/stages-and-gates.md`, `docs/arch/github-and-merge.md`, `docs/arch/manifest-and-settings.md`.

## [@arch:AP-00] Overview
covers: src/extension/ops/autopilotOps.ts, src/extension/ops/autopilotCommandOps.ts, src/extension/ops/autopilotWiring.ts, src/extension/autopilotBinding.ts, src/store/autopilot.ts, src/manifest/autopilot.ts

### Purpose
Fix an allowlisted CI failure or a merge conflict on an open PR of a ticket without a click. Each (PR, kind) has a retry budget. When the budget is spent, the ticket parks with `auto-fix stopped: <kind> <n>/<max>`. Sandbox rules are in `@arch:AP-04`.

### Connections
- in: @arch:CONCURRENCY, @arch:FIELDCHK, @arch:SCHEMA-CHECK (schema v100)
- out: `sendCiFailureAction` (ciActionsWiring), `resolveConflictRound` (conflictResolveOps)

### Flow
```mermaid
flowchart TD
  T[ship tick, controlling window] --> G{mode on, idle, no session}
  G -->|no| X[nothing]
  G -->|yes| C{conflicted PR}
  C -->|round or auto-deliver runs| X
  C -->|yes| H
  C -->|no| P{allowlisted CI failure}
  P -->|no| X
  P -->|yes| H{host ticket}
  H -->|unknown placement| Q[park: auto-fix not run: placement unknown]
  H -->|yes| B{budget}
  B -->|spent| W[park: auto-fix stopped]
  B -->|ok| N[Send CI failure or Resolve conflicts + bulletin note]
```

### Rules
- Mode: manifest `autopilot: { enabled, ci: { policy, maxAttempts, checks }, conflicts: { policy, maxRounds } }` (default off; `maxRounds` defaults to 2). A per-ticket override `inherit|on|off` is stored in `autopilot_tickets`. A sub-task inherits the effective mode of its parent.
- Conflict rounds (T996) are in `@arch:AP-01`.
- A sandboxed ticket gets the same rounds, with fail-closed rules: see `@arch:AP-04`. Only the window that controls the ticket starts a round (`@arch:AC-37`).
- CI uses Send CI failure to agent. A check that is not on the allowlist parks. A gh failure parks and does not move the ticket. An unknown or pending CI status is never a pass. A closed PR is never fixed.
- Transient CI re-run (T1019): one `gh run rerun --failed` per (ticket, repo, run, check) for a network failure, before the allowlist decision. Rules in `@arch:AP-03`.
- The placement comes from the recorded backend: `host` runs on the host, any other backend runs in its sandbox (`@arch:AC-43`). A missing placement gets no round.
- A ticket that ran an implementation graph gets no round: it parks with `auto-fix not run: graph ticket`. A live session that runs, or waits on a prompt or a question, also blocks a round. A closing window releases its `session_owner` rows.
- A rollup with pending checks is not read: its failing list is partial, so the ticket waits. The allowlist covers every failing PR, because the action sends them all. Each failing PR spends its own attempt. A spent budget on any of them parks the round and gives back the attempts taken first.
- If the stored failing list is cut short (`failed` is larger than the list), the ticket parks with `auto-fix not run: the list of failing ci checks is cut short`.
- A ticket with an unknown placement gets no round. It parks with `auto-fix not run: placement unknown`, writes a bulletin note and uses no attempt.
- When a ticket ships again, the stored CI rollup and merge block of its open PRs are cleared, because they belong to the old head. A window that restores its sessions at start publishes them to `session_owner` again. Sub-tasks armed in one sweep count once against the concurrency limit.
- Budget: `autopilot_budgets` keeps attempts, signature and extra attempts. A new signature (the failing check names) resets the counter. Approve one more adds one extra attempt and does not reset.
- A round never starts while a session runs, while the ship saga runs, for a paused ticket, for a closed PR, or when the sub-task concurrency limit (@arch:CONCURRENCY) is full. A round counts against the limit. A sub-task in the ship stage holds a slot while its agent runs or while a sent conflict round has not ended (`autopilot_tickets.conflict_round_at` is set and under 30 minutes old; delivery, a drop, a park, a pause, off mode or "Stop now" clears or frees it, and the PR is open). The slot never reads the stored merge check: a probe of the local merge commit reads clean while the delivery runs. A round that does not deliver parks the ticket (`auto-fix stopped: conflict round did not deliver`), so a stale CI rollup of the old head starts no CI round. The park holds on every tick until a person acts or every PR is proven clean. Only a round the engine sent (`conflict_round_at`) can stall; a manual Resolve conflicts round is never dropped. The budget is checked before the slot wait; `HOLDS_SLOT_SQL` is the one rule for the autostart picker and the autopilot check.
- A park writes the ship block with kind `awaiting-merge` and the reason (amber Needs you). The dashboard banner shows it. A sent round, an approval, an override change or a tick with no problem left clears it. A refused CI hand-off does not count as sent: the attempt is given back and autopilot pauses with a visible reason, because the ticket already moved to Implement. A launch that is queued for memory or cancelled is not a failed launch. A set to the mode that is already stored is no change: it writes no note, clears no park and drops no conflict round, and only Retry or Approve 1 more clears a park without a mode change. Commands: `karst.autopilot.setOverride`, `.approveOne`, `.stop`.
- Stop now ends the session only in the window that holds it. In another window it sets the stop flag and says that the stop did not reach the session.
- Every action and fallback writes a bulletin note. The note title is one line, the text has no control character, and both fit the note limits. The debug line starts with `[ship] autopilot`. There is no toast, also for the commands: action text goes to the debug log.
END_DOC_BLOCK: [@arch:AP-00]

## [@arch:AP-01] Conflict rounds
covers: src/extension/ops/autopilotOps.ts, src/extension/ops/autoDeliverOps.ts, src/extension/ops/conflictResolveOps.ts, src/extension/ops/shipGatesOps.ts, src/store/autostart.ts, src/store/deliverRuns.ts, src/store/deliverFacts.ts

### Purpose
Fix a merge conflict on an open PR of a ticket without a click. The budget, park and note rules of `@arch:AP-00` apply.

### Connections
- in: @arch:AP-00, @arch:CONCURRENCY
- out: `resolveConflictRound` (conflictResolveOps), `isAutoDelivering`, `isConflictRoundStalled` (autoDeliverOps)

### Rules
- Conflicts (T996): a conflicted open PR runs `resolveConflictRound`, the same path as the Resolve conflicts click. Karst delivers the resolved merge behind the gates (arch:AC-39). A rebase on base stays a manual click. A conflict round comes before a CI round. Policy `ask` and a conflict with an unknown base head (`baseSha` is null) start no round; that conflict does not block the CI path.
- Conflict budget: per (PR, `conflicts`). The signature is the base head SHA: a new base head resets the counter. A spent repo is skipped while another conflicted PR of the ticket has attempts. The ticket parks with `auto-fix stopped: conflicts <n>/<max>` only when every conflicted PR is spent. A failed round gives its attempt back.
- No second conflict round starts while the first round is armed or its auto-deliver runs (`conflictRoundActive`: the in-memory round and `isAutoDelivering`). The stored merge check stays `conflicted` until the next probe, so a cooldown alone is not enough. A sent conflict round clears the stored CI rollup and merge block of that PR, so a rollup of the old head starts no CI round. A round armed for more than 5 minutes with no agent and no delivery never delivered: the engine drops it, writes a note, and the next attempt spends the budget.
- Auto-deliver record (T1018): `autoDeliverAfterConflict` opens a `deliver_runs` row BEFORE the first ship gate and appends one `deliver_gate_results` row per gate, each with the head SHA (`store/deliverRuns.ts`). These tables are separate from `gate_runs` on purpose: a ship-stage `gate_runs` row would feed the verdict readers. The ship gates cut the UI gates (`visual`, `layout`) by the same rule as UAT: when the merged diff against the base has no UI path, they do not run, and each is recorded as skipped (`exit_code` NULL, summary `no UI change`). An unreadable diff or an unknown base keeps every gate. A failure stays on record until a later pass of that gate on a newer head or a user dismiss. A manual Deliver to PR takes over (`takeOverAutoDeliver`): it aborts the gate run, disarms the round, marks the run `taken-over`, writes one bulletin note, and pushes once through the normal path. The auto-deliver does not push after a takeover. While a gate run is the one in progress, `merge: clean` is the LOCAL merge commit and is not on the PR yet.
END_DOC_BLOCK: [@arch:AP-01]

## [@arch:AP-02] Autopilot UI
covers: src/model/inside/autofix.ts, src/model/inside/deliver.ts, src/ui/dashboard/app/AutofixParts.tsx, src/ui/dashboard/app/DeliverRow.tsx, src/ui/settings/app/sections/AutopilotSection.tsx

### Purpose
Show the auto-fix state and the controls. The UI adds no new engine rule.

### Connections
- in: @arch:AP-00, @arch:SAVE, @arch:BLOCKED, @arch:GH-04, @arch:GH-08
- out: messages `autopilot-override`, `autopilot-approve-one`, `autopilot-stop`, `autopilot-retry`

### Rules
- Settings: the Autopilot page owns the one manifest key `autopilot`. Save and Discard apply to this tab only. Push diverged is read-only text, and Merge to base has no control.
- Ship panel: Auto-fix is its own Inside process row, id `autofix`, after `pr` and before `merge`. This reverses the T1004 decision "no new step row". The prototype `docs/ui/prototypes/autopilot-inapp-v2.html` is no longer the reference for the ship panel; `docs/ui/prototypes/inside-cleanup.html` (C2, C3, C4) is. The row shows only when Autopilot is effective for the ticket AND a round is active, a park exists, or the history has at least one attempt. The `unknown` CI state also gets the row. Earlier attempts alone give a quiet `history` row (status `note`, "n earlier attempts") that lists them and states no result. The stage-menu item `Stop auto-fix now…` is offered only while the row exists and a round runs, so the menu needs `roundRunning` AND effective autopilot, and the stop confirm closes when that offer ends. `roundRunning` alone means a round is live, whatever the override: Merge all stays disabled while it runs. The row has an AI mark, and no agent identity, no Σ pill and no duration. The Merge row states only merge facts ("waits on 1 conflict and CI", count 0/2) and keeps its per-PR sub-rows. The body lists one row per finished attempt ("attempt n" and the time of its Autopilot note; "still fails" shows only on a spent park), then the steps the host can prove: CI round `fetch CI log` (pass) and `agent fix` (run); conflict round one `agent resolving` (run). There are no pending rows and no step times, because the engine writes no step signal. The running step holds `Last round` (`autopilot-stop-after`). `Stop auto-fix now…` is an item of the stage menu; it opens an inline alertdialog under the Auto-fix row, and its `Stop now` button posts `autopilot-stop` with mode `now`. A spent budget gives the waiting status with one fail row per attempt. The footer, the `Autopilot: …` lines and the "Autopilot never merges" line are removed.
- The banner for an auto-fix park uses the `awaiting-merge` block. It has no new blocker kind. A spent budget has one primary, `+1 attempt` or `+1 round`, with a secondary `Send back…` or `Resolve by hand…`; each button has an icon and its aria-label starts with the visible label. A gh failure or a sandbox pause has one primary, Retry, and never a run-on-host action. A sandbox pause also offers Open sync diff. The gh failure is the engine park `auto-fix stopped: ci could not run (...)`. Retry runs `karst.autopilot.retry`: it clears the pause, the stop reason and the park block, and posts no note. The Approve action names the repo of the kind in the park reason; it stays off when no PR resolves.
- The override control is one chip, "Auto-fix on · default ▾" (a ticket override shows a blue dot and no "· default"). Its menu offers Use project default (with "Settings › Autopilot: on|off"), On for this ticket and Off for this ticket, with a check on the current one. It works by mouse and keyboard, sends `autopilot-override` and settles through the pending marker.
- Unknown CI status reads "Auto-fix waits; not counted as pass". The host reads `unknownCi` from the stored PR rollups with the engine rule (missing, unknown or pending checks on an open PR). A CI round runs in Implement, because the action sends the ticket back, and the engine writes no marker for it. The host reads it from its effects: the ticket is out of ship, no park is on record, the latest Autopilot note is the `ci round n/m` note, not counting `Autopilot: stopped after this round` because that round still runs (a manual send-back leaves none), and a CI budget with attempts holds the signature of the checks that still fail. Its step is the agent step. A pending check reads as unknown CI, because the engine waits on both.
- The banner "Attempt history" lists the `Autopilot: <kind> round n/m` notes of the parked kind, oldest first. The park reason comes from the ship block or the ticket `pausedReason` only. `stoppedReason` outlives the park, so it is never a source. The running row names a repo only when one conflicts budget exists, because the engine stores the arm time and not the repo. The row marks a step as the first step, because the engine writes no step signal. A graph-ticket park (`auto-fix not run: graph ticket`) has no Retry, because a retry parks again. A sandbox park keeps ONE Retry, as the ticket requires. That Retry can park the ticket again until the person fixes the sandbox; the engine writes no other sandbox reason to tell the cases apart. The Auto-fix row carries every auto-fix message; the Merge row never does. The engine gh park reads "paused: could not read CI (gh: <error>)" on the row. The engine writes no `sandbox read-only`, `setup failed` or `clone dirty` reason, so only the sandbox ticket park and a reason that contains "sandbox" render as a sandbox pause. The sandbox sync diff shows when the reason contains the word "sandbox"; the engine writes `auto-fix not run: sandboxed ticket` and the `session did not start (<reason>)` pause.
END_DOC_BLOCK: [@arch:AP-02]

## [@arch:AP-03] Transient CI re-run
covers: src/extension/ops/autopilotRerun.ts, src/workflow/transientCi.ts, src/integrations/ciRerun.ts, src/store/autopilot.ts

When every check of the open PRs has finished and a check failed, the engine reads the tail of the log of each failed job (`gh api .../actions/jobs/<id>/logs`, bounded, read as text, never evaluated). A failure is transient only when a step-level line (`##[error]`, an npm, prebuild-install or gyp line) matches the closed list `TRANSIENT_CI_PATTERNS` (`workflow/transientCi.ts`); test output never matches. A transient check gets ONE `gh run rerun <run> --failed` per (ticket, repo, run, check), before the allowlist decision. A run id names one head, so a new push gets a new re-run. The marker is the row in `autopilot_reruns` (v106), written before gh runs, so a reload or a second window never re-runs again. The re-run uses no attempt. It forgets the stored rollup of that PR, so the ticket waits until the next probe reads the newest run per check (D281). A fresh marker also holds the ticket for `RERUN_SETTLE_MS`, in case gh still shows the old attempt. One bulletin note names the check, the 9-character sha and the pattern. If the check fails again, today's rules apply: an allowlisted check gets a CI round, any other check parks, and the park reason ends with `(re-run once after a network error and it failed again)`. A gh failure while it reads a log or starts the re-run parks with `auto-fix stopped: ci could not run (...)`. A sandboxed ticket, a graph ticket and a status check without a job url keep today's rules.

END_DOC_BLOCK: [@arch:AP-03]

## [@arch:AP-04] Sandboxed tickets
covers: src/extension/ops/autopilotOps.ts, src/extension/autopilotBinding.ts, src/extension/ops/sandboxLaunchFailureOps.ts, src/extension/ops/sandboxLaunchOps.ts

### Rules
- A sandboxed ticket gets the same CI rounds and conflict rounds. A conflict round uses Resolve conflicts only, never Rebase on base. Autopilot never runs a round on the host when the sandbox cannot run it (`@arch:AC-31`): the launch is `failClosed`, and `failClosed` is checked before `hasSandbox`.
- A sandbox environment blocker is not an agent failure. It is a read-only sandbox, a dependency setup failure (`@arch:AC-47`), or a dirty or diverged clone at the pre-round sync (`@arch:AC-46`). The check runs before the hand-off, so the ticket parks in ship and does not move to Implement. The park reason is `auto-fix paused: sandbox <reason>`. It uses no attempt, it is not retried, and it is stored as a paused state apart from a spent budget.
- A session that dies after launch reports through `onSandboxLaunchFailed`. The failure counts only within 2 minutes of the sent round; a later launch failure leaves the round alone. The round is not counted as sent: the attempt returns, a conflict round is dropped, and the ticket pauses with `auto-fix paused: <kind> session died after launch`. A launch queued for host memory (`@arch:AC-49`) is not a failure and does not pause.
- Session owner: `autopilot_tickets.session_owner` names the window that holds the session. The window writes it when it opens a session, and it clears it when the session closes. A window that does not hold the session starts a round only when the store names no owner and the agent is not active. When the agent is `running` or `waiting` and no window is named, the owner is not known: no round starts and a debug line says so. `agent_state` `idle` alone does not prove that no window holds a session, because a closed terminal also sets it.
- Two windows share one database: the controller holds a short lease (`claim_owner`, `claim_until`). A sent round has a cooldown, and the lease lasts through it. One sweep runs at a time.
END_DOC_BLOCK: [@arch:AP-04]
