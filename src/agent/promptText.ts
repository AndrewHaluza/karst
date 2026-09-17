/**
 * Single source of truth for the sentences Karst reuses across more than one
 * prompt surface — the agent guide, the generated workflow command, the
 * ticket-context note, the gate-lane scope blocks, and the UAT/review output
 * contract.
 *
 * Before this module, the marker contract was stated independently in three
 * places (`guide.ts` rule 3, `workflowCommand.ts` `renderDoneMarkerInstruction`,
 * `ticketContext.ts`'s not-an-agent-advanced-stage note) — three hand-maintained
 * wordings of one invariant, so a change to the rule silently drifted two others.
 * Each of these is a NAMED export here, and every consumer imports it rather
 * than re-typing the sentence. `promptText.test.ts` pins the marker rule to all
 * three surfaces BY IDENTITY so a re-worded copy cannot slip in beside the
 * canonical one.
 *
 * Karst-authored, trusted content — the same trust class as the guide. It may
 * be embedded in seeds and generated commands freely (it needs no sanitize
 * pass). Nothing here reads the store or the filesystem; it is pure text.
 */

/** The marker rule's refusal clause, shared by the guide, the done-marker
 *  instruction, and the ticket-context non-marker note. One sentence, one
 *  source — change it here and all three surfaces agree by construction. */
export const MARKER_REFUSED = 'done marker is refused';

/** The gate-only rule: a gate stage is decided by its exit codes, never by an
 *  agent self-report. Shared by the guide's marker section and the
 *  `renderGateOnlyInstruction` seed. */
export const GATE_DECIDED_BY_EXIT_CODES = 'decided by its gate exit codes';

/** The guide pointer clause every seed and workflow command uses to point a
 *  session at the manual: "to learn how Karst works and what the CLI can do,
 *  run <cmd>". One clause on purpose — the guide is pulled on demand. */
export const GUIDE_POINTER_INTRO = 'To understand how Karst works and what this CLI can do';

/** The orientation heading of the gate-lane scope block, shared verbatim by
 *  both lanes via `agentScope.ts`. */
export const SCOPE_ORIENTATION_HEADING =
  'Orientation (already established — do NOT re-derive it):';

/** The scope-rules heading of the gate-lane scope block. */
export const SCOPE_RULES_HEADING = 'Scope rules (strict):';

/** The output-contract heading shared by the UAT Tester and the Review lane. */
export const OUTPUT_RULES_HEADING = 'Output rules (strict):';

/** The output-contract lines shared verbatim by the UAT Tester and the Review
 *  lane. Each lane appends its own tail after these (the "no changes" line and
 *  the severity usage note differ between uat and review). */
export const OUTPUT_RULES_BASE: readonly string[] = [
  '- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.',
  '- Each element: {"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "detail": string, "file"?: string, "line"?: number}.',
  '- "file" must be a path RELATIVE to this worktree\'s root — never absolute, never outside it.',
  '- "title" is one short sentence; "detail" carries the explanation.',
];

/** UAT-only output rule: a criterion the Tester could NOT exercise is severity
 *  `info`, never `high`. `high` is reserved for a criterion the Tester
 *  exercised and observed to be unmet. This is a product invariant that must
 *  ship with the extension — it cannot live in repo-level agent profiles. */
export const OUTPUT_RULES_UAT: readonly string[] = [
  '- A criterion you could NOT exercise is severity `info`, never `high` — name what blocked you. `high` is reserved for a criterion you exercised and observed to be unmet. Never infer that a criterion is unmet because you could not run it.',
];

/** Review-only output rule: which severities actually FAIL the ticket. The
 *  threshold is `review.findings.blockingSeverity` from the manifest, so the
 *  rule is rendered from the live value rather than hardcoded — a repo that
 *  configures `critical` must not be told `high` fails. This is a product
 *  invariant that must ship with the extension: it cannot live in a
 *  repo-level agent profile, which does not ship and cannot see the config. */
export function reviewBlockingSeverityRule(blockingSeverity: string): string {
  return (
    `- A finding at severity \`${blockingSeverity}\` or above FAILS this ticket, so earn that severity: ` +
    `state the input or state, and the wrong output, crash, or corrupted row that follows. ` +
    `A finding you cannot walk to a failure is an opinion — drop it, or report it below \`${blockingSeverity}\`.`
  );
}

/**
 * The rule that keeps a session from starting a service by hand. Karst owns
 * port allocation, health gating, pid attribution and reaping for a ticket's
 * services; a hand-started dev server binds a port the allocator believes is
 * free, and the next spin dies of EADDRINUSE inside the child, where the only
 * symptom is a health check that never passes. Consumed by the agent guide's
 * rules section; a named export here so a seed can reuse the same words.
 */
export const SERVERS_VIA_CLI_RULE =
  'Never start, restart or stop a ticket service by hand (no `npm run dev`, no ' +
  '`docker compose up`). Use `servers spin`/`servers restart`/`servers stop`. ' +
  'Karst owns port allocation, health gating and process reaping for this ' +
  "ticket — a server it did not start holds a port it believes is free, and the " +
  'next spin fails inside the child where the only symptom is a health check ' +
  'that never passes. Run `servers list` (or `context`) to see what is already ' +
  'running before you reach for anything else.';