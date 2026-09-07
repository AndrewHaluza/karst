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