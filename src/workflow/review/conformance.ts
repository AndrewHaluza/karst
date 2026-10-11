/**
 * Review conformance: the artifacts block (intent / spec / plan) the findings
 * lane puts into its prompt, and the severity rules that go with it. Never
 * replaced by custom reviewer instructions (same tier as the scope block).
 */
import type { ChainEdge } from '../../approaches/checks.js';
import {
  chainFingerprint,
  intentFingerprint,
  nodeText,
  renderChainBlock,
  resolveChain,
  type ArtifactChain,
  type ChainEntry,
} from '../artifacts/chain.js';

export interface ReviewArtifacts {
  intent: string | null;
  spec: string | null;
  plan: string | null;
  /** repo/relPath of each rendered node file, for the truncation marker. */
  paths?: { spec?: string[]; plan?: string[] };
  /** The ticket's repo targets — each target's prompt names the others. */
  targets?: readonly string[];
}

export interface AlignmentSnapshot {
  specFp: string;
  intentFp: string;
  mediumPlus: number;
}

export function selectReviewArtifacts(chain: ArtifactChain, intentSpecVerified: boolean): ReviewArtifacts {
  const plan = chain.plan ? nodeText(chain.plan) : null;
  const specText = chain.spec ? nodeText(chain.spec) : null;
  const spec = specText && (!plan || !intentSpecVerified) ? specText : null;
  const out: ReviewArtifacts = { intent: chain.intent, spec, plan };
  const paths: { spec?: string[]; plan?: string[] } = {};
  if (chain.spec) paths.spec = chain.spec.files.map((f) => `${f.repo}/${f.relPath}`);
  if (chain.plan) paths.plan = chain.plan.files.map((f) => `${f.repo}/${f.relPath}`);
  return Object.keys(paths).length > 0 ? { ...out, paths } : out;
}

export function isIntentSpecVerified(d: {
  checks: ReadonlySet<ChainEdge>;
  lastReport: AlignmentSnapshot | null;
  specFp: string | null;
  intentFp: string | null;
}): boolean {
  if (d.checks.has('intent-spec')) return true;
  return (
    d.lastReport !== null &&
    d.specFp !== null &&
    d.intentFp !== null &&
    d.lastReport.specFp === d.specFp &&
    d.lastReport.intentFp === d.intentFp &&
    d.lastReport.mediumPlus === 0
  );
}

export function buildConformanceBlock(a: ReviewArtifacts, repo?: string): string[] {
  if (!a.intent && !a.spec && !a.plan) return [];
  const otherTargets = (a.targets ?? []).filter((t) => t !== repo).sort();
  const rules = [
    ``,
    `Also judge whether the change fulfils the ticket's artifacts below:`,
    ...(a.intent
      ? [
          `- An intent scenario that is not implemented (or implemented contrary to its "then") → ALWAYS "high", whatever else you think of it.`,
        ]
      : []),
    ...(a.spec ? [`- A spec requirement that is not implemented → ALWAYS "high".`] : []),
    ...(a.plan
      ? [
          `- A deviation from the plan, or work outside the plan, is a finding graded by its real impact (a harmless rename is "low"; a skipped migration step is "high").`,
        ]
      : [`- No plan is available: do not report work as "outside the plan".`]),
    ...(otherTargets.length > 0
      ? [
          `- Other repository targets for this ticket: ${otherTargets.join(', ')}. A requirement absent here may be delivered by another target; report it if THIS target does not deliver it, and the orchestrator reconciles across targets.`,
        ]
      : []),
    `- Missing behavior may live outside the diff. Exception to the scope rule "widen beyond the diff only into a file the diff actually touches or directly calls": to confirm an artifact requirement is absent you may also read unchanged code the diff does not touch. This exception is ONLY for confirming absence — never report a finding about untouched code itself.`,
    `- If the diff range is empty, the scope block's single "no changes to review" observation rule wins: do not emit per-requirement findings.`,
    `- For a conformance finding, set "requirement" to the scenario / requirement it is about (e.g. "Scenario 2" or the spec item's id) and omit "file" when the gap is not in one file.`,
  ];
  return [
    ...rules,
    ...renderChainBlock([
      ...(a.intent ? [{ label: 'Intent (what the user must get)', text: a.intent }] : []),
      ...(a.spec ? [{ label: 'Spec', text: a.spec, paths: a.paths?.spec }] : []),
      ...(a.plan
        ? [{ label: 'Plan (how it was meant to be built)', text: a.plan, paths: a.paths?.plan }]
        : []),
    ]),
  ];
}

export function buildReviewArtifacts(deps: {
  intent: string | null;
  entries: readonly ChainEntry[];
  checks: ReadonlySet<ChainEdge>;
  lastIntentSpecReport: AlignmentSnapshot | null;
  targets?: readonly string[];
}): ReviewArtifacts {
  const chain = resolveChain(deps);
  const specFp = chain.spec ? chainFingerprint(chain.spec) : null;
  const intentFp = chain.intent ? intentFingerprint(chain.intent) : null;
  const out = selectReviewArtifacts(
    chain,
    isIntentSpecVerified({ checks: deps.checks, lastReport: deps.lastIntentSpecReport, specFp, intentFp }),
  );
  return deps.targets ? { ...out, targets: deps.targets } : out;
}
