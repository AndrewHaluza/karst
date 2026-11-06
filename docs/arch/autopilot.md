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
Fix an allowlisted CI failure or a merge conflict on an open PR of a host ticket without a click. Each (PR, kind) has a retry budget. When the budget is spent, the ticket parks with `auto-fix stopped: <kind> <n>/<max>`. Sandbox behavior is not in scope (D482).

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
  H -->|sandboxed or unknown| Q[park: auto-fix not run: sandboxed ticket]
  H -->|yes| B{budget}
  B -->|spent| W[park: auto-fix stopped]
  B -->|ok| N[Send CI failure or Resolve conflicts + bulletin note]
```

### Rules
- Mode: manifest `autopilot: { enabled, ci: { policy, maxAttempts, checks }, conflicts: { policy, maxRounds } }` (default off; `maxRounds` defaults to 2). A per-ticket override `inherit|on|off` is stored in `autopilot_tickets`. A sub-task inherits the effective mode of its parent.
- Conflicts (T996): a conflicted open PR runs `resolveConflictRound`, the same path as the Resolve conflicts click. Karst delivers the resolved merge behind the gates (arch:AC-39). A rebase on base stays a manual click. A conflict round comes before a CI round. Policy `ask` and a conflict with an unknown base head (`baseSha` is null) start no round; that conflict does not block the CI path.
- Conflict budget: per (PR, `conflicts`). The signature is the base head SHA: a new base head resets the counter. A spent repo is skipped while another conflicted PR of the ticket has attempts. The ticket parks with `auto-fix stopped: conflicts <n>/<max>` only when every conflicted PR is spent. A failed round gives its attempt back.
- No second conflict round starts while the first round is armed or its auto-deliver runs (`conflictRoundActive`: the in-memory round and `isAutoDelivering`). The stored merge check stays `conflicted` until the next probe, so a cooldown alone is not enough. A sent conflict round clears the stored CI rollup and merge block of that PR, so a rollup of the old head starts no CI round. A round armed for more than 5 minutes with no agent and no delivery never delivered: the engine drops it, writes a note, and the next attempt spends the budget.
- CI uses Send CI failure to agent. A check that is not on the allowlist parks. A gh failure parks and does not move the ticket. An unknown or pending CI status is never a pass. A closed PR is never fixed.
- A ticket is a host ticket only when its recorded placement is `host`. A sandbox placement, a missing placement and an unlisted sandbox get no round.
- A ticket that ran an implementation graph gets no round: it parks with `auto-fix not run: graph ticket`. A live session that runs, or waits on a prompt or a question, also blocks a round. A closing window releases its `session_owner` rows.
- A rollup with pending checks is not read: its failing list is partial, so the ticket waits. The allowlist covers every failing PR, because the action sends them all. Each failing PR spends its own attempt. A spent budget on any of them parks the round and gives back the attempts taken first.
- If the stored failing list is cut short (`failed` is larger than the list), the ticket parks with `auto-fix not run: the list of failing ci checks is cut short`.
- A sandboxed ticket, or a ticket with an unknown placement, gets no round. When an allowlisted check fails on it, it parks with `auto-fix not run: sandboxed ticket`, writes a bulletin note and uses no attempt.
- When a ticket ships again, the stored CI rollup and merge block of its open PRs are cleared, because they belong to the old head. A window that restores its sessions at start publishes them to `session_owner` again. Sub-tasks armed in one sweep count once against the concurrency limit.
- Budget: `autopilot_budgets` keeps attempts, signature and extra attempts. A new signature (the failing check names) resets the counter. Approve one more adds one extra attempt and does not reset.
- A round never starts while a session runs, while the ship saga runs, for a paused ticket, for a closed PR, or when the sub-task concurrency limit (@arch:CONCURRENCY) is full. A round counts against the limit. A sub-task in the ship stage holds a slot while its agent runs or while a sent conflict round is unresolved (a conflicts attempt for the base head the merge check still names as conflicted, no park or pause); `HOLDS_SLOT_SQL` is the one rule for the autostart picker and the autopilot check.
- Session owner: `autopilot_tickets.session_owner` names the window that holds the session. The window writes it when it opens a session, and it clears it when the session closes. A window that does not hold the session starts a round only when the store names no owner and the agent is not active. When the agent is `running` or `waiting` and no window is named, the owner is not known: no round starts and a debug line says so. `agent_state` `idle` alone does not prove that no window holds a session, because a closed terminal also sets it.
- A park writes the ship block with kind `awaiting-merge` and the reason (amber Needs you). The dashboard banner shows it. A sent round, an approval, an override change or a tick with no problem left clears it. A refused CI hand-off does not count as sent: the attempt is given back and autopilot pauses with a visible reason, because the ticket already moved to Implement. A launch that is queued for memory or cancelled is not a failed launch. Commands: `karst.autopilot.setOverride`, `.approveOne`, `.stop`.
- Stop now ends the session only in the window that holds it. In another window it sets the stop flag and says that the stop did not reach the session.
- Two windows share one database: the controller holds a short lease (`claim_owner`, `claim_until`). A sent round has a cooldown, and the lease lasts through it. One sweep runs at a time.
- Every action and fallback writes a bulletin note. The note title is one line, the text has no control character, and both fit the note limits. The debug line starts with `[ship] autopilot`. There is no toast, also for the commands: action text goes to the debug log.
END_DOC_BLOCK: [@arch:AP-00]
