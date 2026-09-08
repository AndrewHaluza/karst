/**
 * The `karst guide` CLI verb (Option A of 869edmcme) and its compose helpers.
 *
 * The guide is the ONE place that explains to an agent how Karst works, what
 * the flow is, and how to use the CLI — so an agent never has to read the
 * extension's `dist/` source to answer "what is the state of my ticket?".
 *
 * It is a TS constant on purpose, not a markdown asset: the CLI runs from
 * `dist/cli/main.js` under plain `node` and reads nothing but its argv, the DB
 * and the manifest — a runtime asset read would need a path resolution that
 * differs between src (vitest) and dist (production). A constant is the single
 * source of truth, and `guide.test.ts` pins it to the real CLI so a new verb
 * or a changed stage set fails `npm test` until the guide mentions it — the
 * ticket's "kept updated always" requirement, enforced rather than promised.
 *
 * Reused sentences (the marker refusal, the guide pointer) are imported from
 * `agent/promptText.ts` — the ONE source — so the guide can never drift from
 * the workflow command and the ticket-context note.
 */

import { MARKER_REFUSED, GUIDE_POINTER_INTRO } from '../agent/promptText.js';

/**
 * The agent-facing manual. Karst-authored, trusted content — it may be
 * embedded in seeds and generated commands freely (unlike approach artifacts,
 * it needs no sanitize pass). Every verb `runCli` accepts MUST be named here
 * or `guide.test.ts` fails.
 */
export const AGENT_GUIDE = `# Karst — agent guide

You are working on a Karst ticket. This guide explains how Karst works, what
the flow is, and how to check state and report progress — without reading the
extension's source code.

## The flow

A ticket moves through stages, in order:

\`scope → impl → uat → review → ship → done\`

- \`scope\` — the repos are chosen and worktrees are cut. Not your concern.
- \`impl\` — you implement the ticket's prompt in the listed worktrees.
- \`uat\` — Karst runs the configured acceptance gates (repo scripts). The
  verdict comes from their exit codes, never from anything you say.
- \`review\` — Karst runs the review gates and (optionally) an AI findings
  lane over the diff. Same rule: exit codes decide.
- \`ship\` — Karst opens the pull requests, then the ticket WAITS, blocked as
  \`awaiting-merge\`, until every PR is literally merged. A merge conflict is a
  waiting/needs-you state, not a failure you can retry — only a human rebase
  resolves it.
- \`done\` — every PR merged. **Done means merged.**

A failed \`uat\` or \`review\` moves the ticket to \`fix\`, where you repair the
work and the gates re-run.

## The CLI

Run the CLI with plain \`node\`, exactly as the commands below show. Stdout is
machine-read JSON or markdown; diagnostics go to stderr and never corrupt it.

- \`context <key> [--json|--md]\` — **read** the ticket's live state: prompt,
  brief, current stage and its verdict/blocking, gate runs, findings,
  worktrees, branches, running servers, pull requests, merge checks. Re-run it
  any time you need fresh state — it reflects the database, not a stale seed.
- \`stats [--project <slug>] [--since <iso>] [--json]\` — **read** the
  orchestration effectiveness report for a project: first-pass rate, rework
  loops, gate kill distribution, cycle time, agent-active time, token spend by
  call site, escaped defects, finding density, the agent-vs-human finding
  split, merge friction, ship failures, graph efficiency, interruption rate.
  Read-only; it names the metrics the schema cannot answer instead of guessing.
- \`stage <impl|fix> pass\` — the done marker: the ONLY transition an agent
  can fire. It advances the ticket from \`impl\` or \`fix\` to the next stage.
  A session ending does NOT advance the ticket — you must fire this marker
  yourself when the stage's work is done.
 - \`phase <name>\` — append-only evidence that you REPORTED entering a phase
   of your declared workflow (e.g. \`research\`, \`plan\`, \`implement\`). It
   records an event; it never moves the ticket.
 - \`graph submit\` — internal: submits the fixed planner artifact
   (\`graph.json\`) for the graph run named by the host-owned environment. It
   takes no arguments, reads no ticket key, and is invoked ON YOUR BEHALF by
   the graph runtime — never by you.
 - \`node complete|block|replan\` — internal: reports a graph NODE's outcome
   (complete, blocked, or replan with an optional bounded \`--reason\`). It
   accepts no id or destination in argv — every identity claim comes from the
   host-owned environment, and the capability is consumed one-shot on the
   first call. Invoked ON YOUR BEHALF by the graph runtime — never by you.
 - \`test <subcommand> …\` — the agent test driver: create tickets, inject
   verdicts, simulate hooks, open/merge PRs, and read full state (\`test
   get-state\`, \`test get-logs\`, \`test assert\`). This is a DEVELOPMENT tool
   that deliberately bypasses gate verdicts — a \`test advance --verdict passed\`
   can move a stage a real gate never ran, and \`test reset\` wipes a registry.
   It exists to drive and inspect workflows from scripts, never as a way for a
   working agent to report progress: the \`stage\` marker is the only verb that
   records an agent's own done marker.
 - \`test create-ticket --title <title> [--key <key>] [--type <type>]
   [--approach <approach>] [--description <desc>] [--project <slug>]\` —
   create a ticket, idempotent by key: re-running the same \`--key\` (or the
   key derived from the title) returns the existing ticket instead of
   duplicating it. Scope it to a project with \`--project <slug>\` — the
   project named by \`--manifest\` is the fallback — or the ticket exists in
   the DB but never appears on any board (every board query filters by
   \`project_id\`). A project-less create is only useful for throwaway
   fixtures, never for work you need to see or drive again.
 - \`guide\` — this document.

The marker is deliberately narrow: \`stage\` accepts only \`impl\`/\`fix\` and
only \`pass\`. A gate stage (\`uat\`/\`review\`/\`ship\`) is decided by exit
codes — never by an agent self-report. \`stage ship pass\` is REFUSED, and a
conflict must never be marked failed: \`ship\` has no failed edge, so the
ticket would park with no way out.

## Rules you may not break

1. A gate verdict is a process exit code. Nothing you say can pass a stage.
2. Re-read \`context\` before acting and after anything external changes —
   it is current state, not history.
3. Fire the done marker ONLY when the stage's work is actually complete —
   code, research, or a confirmation all count; a half-done stage does not.
   The ${MARKER_REFUSED} while the agent is waiting for user input: if the
   session is blocked on a question to the user, the stage is not done.
   On the dynamic graph approach, \`stage impl pass\` is also REFUSED for a
   ticket with no graph run at all — done means the graph work happened.
4. If a marker command is denied by the workspace sandbox, request approval
   to run that exact command outside the sandbox — never improvise a variant.
5. \`nothing-to-merge\` is a genuine pass: a ticket whose work produced no
   diff opens no PR and has delivered everything it had.
`;

/**
 * Compose the `node <cli> guide` command an agent runs to read the manual.
 * Pure (no fs) so it is testable. The CLI entry is double-quoted so paths
 * with spaces survive, matching the sibling compose helpers.
 */
export function composeGuideCommand(cliEntry: string): string {
  return `node "${cliEntry}" guide`;
}

/**
 * The one-line seed/orchestrator instruction pointing a session at the guide:
 * "to learn how Karst works and what the CLI can do, run <cmd>". Kept as ONE
 * sentence on purpose — the guide is long and the seed is read on every
 * launch, so the pointer must be cheap and the content pulled on demand.
 */
export function renderGuideInstruction(guideCommand: string): string {
  return (
    `${GUIDE_POINTER_INTRO}, run ` +
    `\`${guideCommand}\` and read its output.`
  );
}

/**
 * Parse `['guide']` at the system boundary. No flags, no ticket, no DB — the
 * guide is static karst-authored content. Trailing argv is rejected, not
 * ignored, matching the sibling verbs.
 */
export function parseGuideArgs(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd !== 'guide') {
    throw new Error(`expected 'guide' command, got '${cmd ?? ''}'`);
  }
  if (rest.length > 0) {
    throw new Error(`unknown flag '${rest.join(' ')}' (guide takes no arguments)`);
  }
}

/**
 * Run the `guide` verb: validate argv and return the manual. Throws on
 * malformed argv; the content itself never fails. PURE by contract — it reads
 * only argv and returns text, never the DB or a store. Guide-PULL attribution
 * (prompt-metrics.md) is recorded separately at the `cli/main.ts` dispatch
 * boundary, best-effort, AFTER this returns; it is not this function's concern
 * and never blocks or corrupts what the agent reads.
 */
export function runGuideCommand(argv: string[]): string {
  parseGuideArgs(argv);
  return AGENT_GUIDE;
}
