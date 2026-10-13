/**
 * Edge alignment check: does a spec/plan still refine its parent artifact in the
 * chain intent → spec → plan? One headless call in an empty cwd; WARN-only —
 * the caller records a report and a mailbox message, it never blocks anything.
 */
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ChainEdge } from '../../approaches/checks.js';
import { OUTPUT_RULES_HEADING, OUTPUT_RULES_BASE } from '../../agent/promptText.js';
import { REVIEW_OUTPUT_SCHEMA } from '../../agent/outputContract.js';
import { parseFindingsResult, type Finding } from '../review/findings.js';
import { withEmptyCwd } from '../classify/sandbox.js';
import { renderChainBlock } from './chain.js';

const NAMES: Record<ChainEdge, [string, string]> = {
  'intent-spec': ['intent', 'spec'],
  'spec-plan': ['spec', 'plan'],
  'intent-plan': ['intent', 'plan'],
};

export function buildAlignmentPrompt(
  edge: ChainEdge,
  parentText: string,
  childText: string,
  paths?: { parent?: string[]; child?: string[] },
): string {
  const [parent, child] = NAMES[edge];
  return [
    `You check that a ${child} faithfully refines its ${parent}. Do not read or judge any code.`,
    `- Every requirement of the parent the child does not cover → "high".`,
    `- Child content that contradicts the parent → "high".`,
    `- Child scope the parent does not ask for (scope creep) → "medium".`,
    `- Ambiguity that will likely be implemented wrong → "medium"; wording issues → "low".`,
    `- Put the parent item (scenario / requirement) the finding is about at the start of "title".`,
    ...renderChainBlock([
      { label: `PARENT (${parent})`, text: parentText, paths: paths?.parent },
      { label: `CHILD (${child})`, text: childText, paths: paths?.child },
    ]),
    ``,
    OUTPUT_RULES_HEADING,
    ...OUTPUT_RULES_BASE,
    `- Fully aligned → output exactly [].`,
  ].join('\n');
}

export interface AlignmentDeps {
  adapter: AgentAdapter;
  model?: string;
  effort?: string;
  debug?: (message: string) => void;
  /**
   * K11: called with the caught failure when the run died because the provider
   * account is out of quota, so the caller (which owns the registry store) can
   * record a re-runnable op park. Absent → nothing is recorded.
   */
  onUsageLimit?: (error: unknown) => void;
}

export interface AlignmentResult {
  findings: Finding[];
  report: string;
  /** A failed run is NOT a clean edge: never record it as verified. */
  failed: boolean;
}

export function renderAlignmentReport(edge: ChainEdge, findings: readonly Finding[], failure?: string): string {
  const head = `# Artifact alignment: ${edge}\n`;
  if (failure) return `${head}\nThe check could not run: ${failure}\n`;
  if (findings.length === 0) return `${head}\nAligned — no issues found.\n`;
  return `${head}\n${findings.map((f) => `- **${f.severity}** ${f.title}\n  ${f.detail}`).join('\n')}\n`;
}

export async function runAlignment(
  deps: AlignmentDeps,
  input: {
    ticketId: number;
    edge: ChainEdge;
    parentText: string;
    childText: string;
    paths?: { parent?: string[]; child?: string[] };
  },
): Promise<AlignmentResult> {
  deps.debug?.(`[alignment] ticket ${input.ticketId}: checking ${input.edge}`);
  try {
    const result = await withEmptyCwd((cwd) =>
      deps.adapter.runHeadless({
        prompt: buildAlignmentPrompt(input.edge, input.parentText, input.childText, input.paths),
        cwd,
        trustCwd: false,
        model: deps.model,
        effort: deps.effort,
        ...(deps.adapter.surfaces?.structuredOutput?.supported === true
          ? { outputSchema: REVIEW_OUTPUT_SCHEMA }
          : {}),
        tracking: { callSite: 'artifact-alignment', ticketId: input.ticketId, processRunId: null },
      }),
    );
    const { findings } = parseFindingsResult(
      result.raw,
      { repo: '', worktreePath: '/nonexistent', max: 20 },
      (m) => deps.debug?.(`[alignment] ${m}`),
    );
    // No file location is meaningful here; the finding itself is always kept.
    const clean = findings.map((f) => ({ ...f, file: null, line: null }));
    deps.debug?.(`[alignment] ticket ${input.ticketId}: ${input.edge} → ${clean.length} finding(s)`);
    return { findings: clean, report: renderAlignmentReport(input.edge, clean), failed: false };
  } catch (err) {
    deps.debug?.(`[alignment] run failed: ${err instanceof Error ? err.message : String(err)}`);
    deps.onUsageLimit?.(err);
    return { findings: [], report: renderAlignmentReport(input.edge, [], 'the agent call failed'), failed: true };
  }
}
