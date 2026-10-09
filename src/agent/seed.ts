// Before changing what a seed or context render contains, read
// docs/arch/prompt-metrics.md @arch:RESIDENT and @arch:GUIDEGATE.
/**
 * Compose the initial prompt seeded into a fresh interactive session. Since the
 * instructions layer landed (§ agent/instructions.ts), a ticket launch is split
 * into TWO layers that each reach the agent through a different route:
 *
 *   1. `instructions` — karst-authored text and STRUCTURED FACTS, written to
 *      `<sessionDir>/karst-instructions.md` and delivered through the core's own
 *      system/developer channel (native-file) or a one-line pointer in the
 *      kickoff (pointer cores). It carries the `## Services` rule + resolved
 *      `karst servers` commands, the repositories in scope (paths, branches,
 *      worktrees, ports), the open PR numbers/URLs, the guide pointer and the
 *      done-marker instruction — all via `$KARST_*` env refs, never literals.
 *
 *   2. `kickoff` — the first user message: the workflow `invocation` FIRST
 *      (e.g. `/karst:rpi PROJ-9`), then human/agent-authored text (the ticket
 *      prompt/brief, parent/sub-task summaries, mailbox pointer) and the
 *      chosen approach's method prompt (third-party package content).
 *
 * A SOLO-agent launch on a `fallback` core (codex/opencode single-subagent)
 * cannot use its own channel alongside the materialized persona, and a fresh
 * launch with no materialized entry command must stay self-contained, so in
 * both cases the instruction body is inlined into the kickoff instead
 * (`inlineInstructions: true`) and `instructions` is null — today's behaviour.
 *
 * The ticket-context SHAPING lives in `src/context/ticketContext.ts` so it can be
 * reused by the `karst context` CLI; this module only composes the sections.
 */

import { seedCharLength, seedHasGuide } from './promptTelemetry.js';
import { truncateToBudget, SEED_BUDGETS, approachTruncationPointer } from './seedBudget.js';
import {
  hasInstructionsPointer,
  hashInstructions,
  instructionsCharLength,
  type SessionInstructions,
} from './instructions.js';
import type { InstructionChannel } from './adapter.js';

/**
 * A composed ticket seed, split by delivery route. `instructions` is null when
 * there is nothing karst-authored to say (the launch then carries only the
 * kickoff); `kickoff` is the empty string when there is no first user message.
 */
export interface SessionSeed {
  /** Karst-authored rules + structured facts; written to disk and delivered through the core's channel. */
  instructions: string | null;
  /** The first user message: invocation, authored ticket text, approach method. */
  kickoff: string;
}

/** The first line of the instruction body — makes the written file self-describing. */
export const INSTRUCTIONS_HEADING = '# Karst session instructions';

/**
 * Join the instruction-layer sections under one heading, or null when none are
 * present. Exported so `entrySeed.ts` composes a resume/conflict instruction
 * body identically.
 */
export function composeInstructionsBody(
  sections: readonly (string | null | undefined)[],
): string | null {
  const body = sections.map((s) => s?.trim()).filter((s): s is string => Boolean(s));
  if (body.length === 0) return null;
  return `${INSTRUCTIONS_HEADING}\n\n${body.join('\n\n')}`;
}

/** Join kickoff sections, dropping empties. */
function composeKickoff(sections: readonly (string | null | undefined)[]): string {
  return sections
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
}

export interface BuildSessionSeedInput {
  /**
   * Authored ticket text (rendered with `renderTicketContext(..., { sections:
   * 'narrative' })`, or `'all'` for the no-invocation fallback) — rides the kickoff.
   */
  authoredContext?: string | null;
  /**
   * Structured ticket facts (rendered with `renderTicketContext(..., { sections:
   * 'facts' })`) — rides the instruction layer. Absent on an inline launch.
   */
  factsContext?: string | null;
  /** The chosen approach's method body (third-party package content) — kickoff. */
  approachPrompt?: string | null;
  /** The workflow/entry command line (e.g. `/karst:rpi PROJ-9`) — FIRST kickoff token. */
  invocation?: string | null;
  /** The done-marker instruction, or the gate-only sentence at a gate stage — instruction layer. */
  markerInstruction?: string | null;
  /** The guide pointer, when composed — instruction layer (fresh launches only). */
  guideInstruction?: string | null;
  /** The `## Services` block (`renderServersInstruction`) — instruction layer. */
  serversInstruction?: string | null;
  /** Used by the approach-method truncation pointer. */
  ticketKey?: string;
  /**
   * Inline the whole instruction layer into the kickoff instead of writing it to
   * disk: a solo-agent launch on a `fallback` core, or a fresh launch with no
   * materialized entry command (the self-contained fallback invariant).
   */
  inlineInstructions?: boolean;
  debug?: (msg: string) => void;
}

/**
 * Compose the session seed from pre-rendered parts. Never returns undefined:
 * a genuinely empty launch is `{ instructions: null, kickoff: '' }`, and the
 * caller then opens the session bare.
 */
export function buildSessionSeed(input: BuildSessionSeedInput): SessionSeed {
  let method = input.approachPrompt?.trim();
  const authored = input.authoredContext?.trim();
  const facts = input.factsContext?.trim();
  const inv = input.invocation?.trim();
  const marker = input.markerInstruction?.trim();
  const guide = input.guideInstruction?.trim();
  const servers = input.serversInstruction?.trim();

  if (method) {
    // `karst context <key>` cannot recover the approach body — it renders
    // TicketContext, which has no field for it — so this truncation states a
    // different, honest pointer instead of the ticket-key one every other
    // section uses (`approachTruncationPointer`, never `truncationPointer`).
    const { text, truncated } = truncateToBudget(
      method,
      SEED_BUDGETS.approachMethod,
      input.ticketKey ?? '',
      approachTruncationPointer(),
    );
    if (truncated) input.debug?.(`[seed] truncated approach method to ${SEED_BUDGETS.approachMethod} chars`);
    method = text;
  }
  const approachSection = method ? `# Approach\n\n${method}` : undefined;

  if (input.inlineInstructions) {
    // Everything rides the first user message, in the pre-split order:
    // invocation, authored text, servers rule, approach, guide, marker.
    return {
      instructions: null,
      kickoff: composeKickoff([inv, authored, servers, approachSection, guide, marker]),
    };
  }

  return {
    instructions: composeInstructionsBody([facts, servers, guide, marker]),
    kickoff: composeKickoff([inv, authored, approachSection]),
  };
}

/** The seed seam's own effectiveness telemetry: composed length + guide-pointer presence. */
export interface SeedTelemetry {
  /** Total resident context delivered to the agent: kickoff + instruction body. */
  seedChars: number;
  guidePointer: boolean;
  /** Instruction-layer size in characters, when an instruction layer rode the launch. */
  instructionsChars?: number;
  /** Stable digest of the instruction body (the layer's prompt-metrics identity). */
  instructionsHash?: string;
  /** Whether the kickoff carried a pointer to `$KARST_INSTRUCTIONS` (pointer cores). */
  instructionsPointer?: boolean;
}

/**
 * Measure a composed seed at the seam that produced it. The kickoff is the
 * first user message; the instruction layer, when one rode the launch, is the
 * body written to disk (delivered natively or behind a pointer). It reads back
 * the prompt-effectiveness facts the launch records onto its `process_runs` row
 * (docs/arch/prompt-metrics.md): how many characters of resident context the
 * agent opened with (both layers), whether the guide pointer was among them
 * from either layer, and — when an instruction layer rode the launch — its
 * size, digest, and whether a pointer (not the body) reached the kickoff.
 *
 * `instructionsChannel` is the channel the ADAPTER actually reported for this
 * launch (`InteractiveCommand.instructionsChannel`). A `pointer` core splices
 * the pointer into the kickoff inside `buildInteractiveCommand`, AFTER the raw
 * seed this function receives, so the channel — not a text scan — is what makes
 * the pointer fact true for every pointer core. The text scan stays as the
 * fallback for callers that measure a seed that already carries the pointer.
 *
 * The guide pointer now lives in the instruction body on a fresh launch and is
 * deliberately ABSENT from a resume's regenerated body (a resume is not a new
 * guide invite), so scanning both layers preserves the fresh-vs-resume
 * denominator asymmetry the metric depends on (`prompt-metrics.md`).
 */
export function measureSeed(
  seed: string | undefined,
  guideMarker?: string,
  instructions?: SessionInstructions,
  instructionsChannel?: InstructionChannel,
): SeedTelemetry {
  const body = instructions?.body;
  const instructionsPointer =
    instructionsChannel === 'pointer' || hasInstructionsPointer(seed);
  return {
    seedChars: seedCharLength(seed) + instructionsCharLength(body),
    guidePointer: seedHasGuide(seed, guideMarker) || seedHasGuide(body, guideMarker),
    ...(instructions
      ? {
          instructionsChars: instructionsCharLength(instructions.body),
          instructionsHash: hashInstructions(instructions.body),
        }
      : {}),
    ...(instructionsPointer ? { instructionsPointer: true } : {}),
  };
}
