/**
 * The dashboard's semantic artifact shelf (§ docs/design/artifacts/README.md).
 *
 * An artifact is a DURABLE output a ticket produced — "what durable output did
 * this ticket produce?", answered by the shelf — as opposed to Inside's
 * "what is happening now?". The shelf renders only while at least one artifact
 * exists; the count is top-level SEMANTIC artifacts (one per kind in V1), so
 * retries and re-ships add VERSIONS, never rows.
 *
 * Derivation, not storage: every artifact is a READ over evidence karst already
 * keeps (stages, gate_runs, review_findings, uat_findings, process_runs,
 * ship_runs, and — for the plan — the graph runtime's runs/revisions). The
 * origin's `core` is likewise READ from the immutable identity snapshot
 * `process_runs` captured at launch (provider/agent/model are written when the
 * process opens and never rewritten) — falling back to the ticket's
 * `session_provider`/`agent_provider` only for evidence that predates process
 * identity capture. Nothing here invents a fact: no evidence, no artifact.
 *
 * The detail "payload" rides the same snapshot (there is no async `artifact.get`
 * round trip): everything the detail renders — metrics, findings, gates, PRs,
 * commits, plan tasks, resources — is already in the state push, so the
 * webview's detail view is a local render and its only failure mode (a resource
 * file that has gone) is reported by the host opener, exactly like
 * `openStageLog`.
 */
import type { AgentProvider, Severity } from '../manifest/types.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { Stage } from '../store/stages.js';
import type { GateRun } from '../store/gateRuns.js';
import type { Finding } from '../store/reviewFindings.js';
import type { UatFinding } from '../store/uatFindings.js';
import type { ProcessRun } from '../store/processRuns.js';
import type { ShipEvidence } from '../store/shipRuns.js';
import type { PhaseMark } from '../store/phaseMarks.js';
import type { PrView } from '../store/dashboard.js';
import { getTicket } from '../store/tickets.js';
import { listGateRuns } from '../store/gateRuns.js';
import { listFindings } from '../store/reviewFindings.js';
import { listUatFindings } from '../store/uatFindings.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listShipEvidence, countShipRuns } from '../store/shipRuns.js';
import { listPhaseMarks } from '../store/phaseMarks.js';
import { listPrsByTicket } from '../store/dashboard.js';
import { listGraphPlanEvidence } from '../store/graph/planEvidence.js';
import { parseGraphDocument } from '../approaches/graph/parse.js';
import { isKnownProvider } from '../agent/provider.js';
import type { Store } from '../store/db.js';
import { formatSpanMs } from './inside/types.js';
import type { InsideEvidenceTarget, TypedInsideAction } from './inside/types.js';

/** The semantic artifact kinds V1 derives. One artifact per kind per ticket. */
export type ArtifactKind = 'plan' | 'uat-report' | 'review' | 'ship-summary';

/** The stage the artifact's work happened in — also the index's grouping key. */
export type ArtifactStage = 'impl' | 'uat' | 'review' | 'ship';

/** Domain state, distinct from availability: a load failure is NEVER this. */
export type ArtifactStatus = 'passed' | 'failed' | 'attention' | 'info';

/**
 * Whether the artifact still validates the current implementation. Only
 * verification/review artifacts can read `stale` (implementation changed after
 * the artifact was produced); a ship summary is current for its run by
 * construction. Never conflated with load failure.
 */
export type ArtifactFreshness = 'current' | 'stale';

/**
 * Who produced the artifact (the origin axis this ticket adds to the finalized
 * spec's semantic axis):
 *
 * - `native` — produced DIRECTLY by the agent core (a file the agent wrote).
 *   V1 derives no native artifacts (nothing records agent-written files yet);
 *   the kind is part of the closed taxonomy every surface renders.
 * - `karst` — produced by karst (gate artifacts, findings, ship evidence),
 *   attributed to the core whose session ran the producing process.
 */
export interface ArtifactOrigin {
  kind: 'native' | 'karst';
  /** claude | codex | antigravity | opencode; null = no attribution. */
  core: AgentProvider | null;
}

export interface ArtifactGate {
  name: string;
  /** NULL = the repo defines no such script (NOT a pass). */
  exitCode: number | null;
}

export interface ArtifactFinding {
  severity: Severity;
  title: string;
  detail: string | null;
  repo: string | null;
  file: string | null;
  line: number | null;
  /**
   * The opaque open-file capability for the finding's location, minted
   * host-side through the same `attach` seam the inside findings use. Absent →
   * the location renders as plain text (no file, no attach, or a fixture).
   */
  action?: TypedInsideAction;
}

export interface ArtifactPr {
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
}

export interface ArtifactCommit {
  repo: string;
  sha: string;
  message: string;
  /**
   * The opaque open-commit capability, minted host-side through the same
   * `attach` seam the inside evidence uses. Absent → the SHA renders as plain
   * text (a snapshot that attached none, or a fixture). Never invented here.
   */
  action?: TypedInsideAction;
}

/** One underlying raw representation, shown LAST in detail, opened on demand. */
export interface ArtifactResource {
  /** basename only — display; never joined into a path by the webview. */
  name: string;
  /** Absolute path, host-resolved; only the host ever opens it. */
  path: string;
}

/**
 * One task of the plan artifact — a node of the canonical graph with its
 * CURRENT progress. The status is derived from the node's LATEST run: what
 * was done (completed), what is in progress (running/launching/…), what is
 * still to do (ready/not-yet-claimed). A node with no run at all reads
 * `todo`, never "unknown".
 */
export type ArtifactPlanTaskStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled';

export interface ArtifactPlanTask {
  id: string;
  label: string;
  kind: string;
  status: ArtifactPlanTaskStatus;
  /** `visit n` when the node has run at least once; absent before claiming. */
  visits: string | null;
}

/**
 * A ticket's artifact, carrying BOTH the shelf/index summary fields and the
 * detail body: the webview renders detail locally from this snapshot and never
 * round-trips an `artifact.get`. Lists are capped so a long-lived ticket's
 * snapshot stays bounded — a cap is a display decision, never a verdict.
 */
export interface ArtifactSummary {
  /** Stable identity: the kind (V1 has exactly one artifact per kind). */
  id: ArtifactKind;
  stage: ArtifactStage;
  kind: ArtifactKind;
  title: string;
  /**
   * Repo disambiguator. V1 always null — repo-scoped splitting arrives when
   * tickets routinely produce per-repo outputs; a single ticket-level artifact
   * never mislabels (per spec §15, no label is better than a noisy one).
   */
  scope: string | null;
  /** One useful secondary line for the shelf card and the index row. */
  summary: string;
  status: ArtifactStatus;
  freshness: ArtifactFreshness;
  origin: ArtifactOrigin;
  /** Top-level count is unaffected: this is the version count, never a row. */
  versionCount: number;
  /** 'v1'… — display label derived from version order, never stored. */
  currentVersionLabel: string;
  createdAt: string | null;
  metrics: { label: string; value: string }[];
  gates: ArtifactGate[];
  findings: ArtifactFinding[];
  prs: ArtifactPr[];
  commits: ArtifactCommit[];
  /**
   * The plan's task list — ONLY the plan artifact carries tasks; every other
   * kind sets an empty array. Rendered as its own section in detail.
   */
  tasks: ArtifactPlanTask[];
  resources: ArtifactResource[];
  /** The stage verdict's reason when the artifact's stage failed; else null. */
  detail: string | null;
  /**
   * The gate-lane AI process whose console this report can open — 'tester' on
   * the UAT report, 'review' on the review report — or null when no such
   * process ran. HOST-DERIVED (UI-R31): the webview renders the console entry
   * from this field only and never guesses that a report has one. A RUNNING
   * process already counts: its output streams before the run finishes.
   */
  agentConsole: AgentConsoleProcessId | null;
}

/** The AI processes that own a console: the UAT Tester and the Review lane. */
export type AgentConsoleProcessId = 'tester' | 'review';

/** Everything the derivation reads — supplied so each snapshot reads ONCE. */
export interface ArtifactInput {
  ticket: TicketWithStages;
  gateRuns: GateRun[];
  findings: Finding[];
  uatFindings: UatFinding[];
  processRuns: ProcessRun[];
  ship: ShipEvidence;
  shipRunCount: number;
  prs: PrView[];
  /**
   * The graph plan evidence (the graph runtime IS the plan). Absent → no
   * plan artifact: a ticket the graph approach never drove has no plan to
   * show, and "no evidence, no artifact" holds here too.
   */
  plan?: ArtifactPlanInput | null;
  /**
   * The phases the ticket's approach DECLARES for impl (its `workflow`), in
   * order — what the session was asked to do. Resolved by the host from the
   * installed approach package; empty when the ticket has no approach.
   */
  declaredPhases: string[];
  /**
   * The phases the agent REPORTED by firing the `phase` marker, oldest first
   * (store/phaseMarks). Used by the session-phases plan when no graph run
   * drove the ticket; a phase mark is the one fact that can read a task as
   * done/in-progress.
   */
  phaseMarks: PhaseMark[];
  /**
   * Mint an opaque capability for an evidence row (the ship summary's commits
   * get an `open-commit`). Absent → rows carry no actions, exactly like the
   * inside reducers when their caller attaches none.
   */
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
}

/**
 * The graph evidence a plan artifact reads — the latest graph run, its
 * accepted revisions (each replan is a NEW plan version), and the node runs
 * that track each node's progress. Supplied so `buildArtifactsFrom` stays a
 * pure function of a single snapshot, like every other artifact input.
 */
export interface ArtifactPlanInput {
  graphRun: {
    id: number;
    status: string;
    approachId: string;
    createdAt: string;
  } | null;
  revisions: {
    revisionNumber: number;
    canonicalGraph: string;
    status: string;
    createdAt: string;
  }[];
  nodeRuns: {
    id: number;
    nodeId: string;
    nodeKind: string;
    revisionId: number;
    visitNumber: number;
    status: string;
    endedAt: string | null;
  }[];
  plannerRuns: {
    kind: 'bootstrap' | 'replan';
    status: string;
    provider: string | null;
  }[];
  plannerArtifacts: {
    snapshotPath: string;
    mediaType: string;
    byteSize: number;
  }[];
}

/** The plan evidence read ONCE from the store, for `buildTicketArtifacts`. */
export function readPlanInput(store: Store, ticketId: number): ArtifactPlanInput {
  const evidence = listGraphPlanEvidence(store.db, ticketId);
  return {
    graphRun: evidence.graphRun
      ? {
          id: evidence.graphRun.id,
          status: evidence.graphRun.status,
          approachId: evidence.graphRun.approach_id,
          createdAt: evidence.graphRun.created_at,
        }
      : null,
    revisions: evidence.revisions.map((r) => ({
      revisionNumber: r.revision_number,
      canonicalGraph: r.canonical_graph,
      status: r.status,
      createdAt: r.created_at,
    })),
    nodeRuns: evidence.nodeRuns.map((n) => ({
      id: n.id,
      nodeId: n.node_id,
      nodeKind: n.node_kind,
      revisionId: n.revision_id,
      visitNumber: n.visit_number,
      status: n.status,
      endedAt: n.ended_at,
    })),
    plannerRuns: evidence.plannerRuns.map((p) => ({
      kind: p.kind,
      status: p.status,
      provider: p.provider,
    })),
    plannerArtifacts: evidence.plannerArtifacts.map((a) => ({
      snapshotPath: a.snapshot_path,
      mediaType: a.media_type,
      byteSize: a.byte_size,
    })),
  };
}

/** The gate_runs row that is NOT a gate: the review stage's Changes-panel mark. */
const NON_GATE_RUNS = new Set(['changes']);

/** Detail list caps: a display decision, never a verdict (see ArtifactSummary). */
const MAX_DETAIL_FINDINGS = 50;
const MAX_DETAIL_COMMITS = 20;
const MAX_DETAIL_TASKS = 40;

const KINDS: Record<ArtifactKind, { stage: ArtifactStage; title: string }> = {
  plan: { stage: 'impl', title: 'Plan' },
  'uat-report': { stage: 'uat', title: 'UAT report' },
  review: { stage: 'review', title: 'Review' },
  'ship-summary': { stage: 'ship', title: 'PR summary' },
};

/**
 * Semantic preview priority (spec §5): the three previews represent the most
 * useful current outputs, stably ordered. Active tickets lead with the plan
 * (the implementation plan outranks verification per the finalized spec's
 * priority list); completed tickets lead with the landing (Ship/PR outranks
 * Plan there).
 */
const PRIORITY_ACTIVE: Record<ArtifactKind, number> = {
  plan: 0,
  'uat-report': 1,
  review: 2,
  'ship-summary': 3,
};
const PRIORITY_DONE: Record<ArtifactKind, number> = {
  'ship-summary': 0,
  'uat-report': 1,
  review: 2,
  plan: 3,
};

/** The preview rank of one artifact for a ticket at `stageCurrent`. */
export function artifactPriority(kind: ArtifactKind, stageCurrent: string | null): number {
  return (stageCurrent === 'done' ? PRIORITY_DONE : PRIORITY_ACTIVE)[kind];
}

/**
 * The shelf's previews: at most 3, in the host's semantic priority order. The
 * host sorts the artifacts array (below), so the webview renders the first 3 —
 * this function pins that contract and stays the single decision point.
 */
export function pickArtifactPreviews(artifacts: readonly ArtifactSummary[]): ArtifactSummary[] {
  return artifacts.slice(0, 3);
}

/**
 * Every artifact a ticket has produced, ordered by semantic priority (previews
 * are `slice(0, 3)` of this — see `pickArtifactPreviews`), oldest first within
 * a priority. The order is stable unless a more important output appears, which
 * is the spec's whole requirement; `stageCurrent` drives the active-vs-done
 * flip.
 *
 * `declaredPhases` (the approach's declared impl workflow) is host-resolved
 * from the installed approach package, so this store-only read defaults it to
 * empty — the session-phases plan then derives from the reported marks alone.
 */
export function buildTicketArtifacts(
  store: Store,
  ticketId: number,
  declaredPhases: string[] = [],
): ArtifactSummary[] {
  return buildArtifactsFrom({
    ticket: getTicket(store, ticketId),
    gateRuns: listGateRuns(store, ticketId),
    findings: listFindings(store, ticketId),
    uatFindings: listUatFindings(store, ticketId),
    processRuns: listProcessRuns(store, ticketId),
    ship: listShipEvidence(store, ticketId),
    shipRunCount: countShipRuns(store, ticketId),
    prs: listPrsByTicket(store, ticketId),
    plan: readPlanInput(store, ticketId),
    declaredPhases,
    phaseMarks: listPhaseMarks(store, ticketId),
  });
}

/** Derive a ticket's artifacts from evidence the caller already read once. */
export function buildArtifactsFrom(input: ArtifactInput): ArtifactSummary[] {
  const { ticket } = input;
  const out: ArtifactSummary[] = [];
  const plan = planReport(input);
  if (plan) out.push(plan);
  const uat = uatReport(input);
  if (uat) out.push(uat);
  const review = reviewReport(input);
  if (review) out.push(review);
  const ship = shipSummary(input);
  if (ship) out.push(ship);
  out.sort(
    (a, b) =>
      artifactPriority(a.kind, ticket.stageCurrent) - artifactPriority(b.kind, ticket.stageCurrent)
      || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
  );
  return out;
}

/** The gate rows that count as entries for the verdict: real gates, not marks. */
function gateEntries(gateRuns: readonly GateRun[], stage: ArtifactStage): GateRun[] {
  return gateRuns.filter(
    (r) => r.stageKey === stage && !r.skipped && !NON_GATE_RUNS.has(r.gateName),
  );
}

/**
 * The entries of the LATEST run invocation only. Gate evidence is append-only,
 * so an earlier run's rows survive forever — but the artifact presents the
 * CURRENT version, and mixing runs would fold a failed attempt into a passed
 * one (and vice versa) until the verdict read as noise. Runs count separately
 * as VERSIONS (see versionAttempts).
 *
 * Keys on `runAt` (the batch stamp, unique per invocation) — NOT on `attempt`,
 * which only advances on failure so every passing re-validation shares one
 * attempt value with the failing run that preceded it (Issue #5).
 */
function latestAttemptEntries(entries: readonly GateRun[]): readonly GateRun[] {
  if (entries.length === 0) return entries;
  const latest = entries.reduce<string | null>(
    (max, g) => (max === null || g.runAt > max ? g.runAt : max),
    null,
  );
  return latest === null ? [] : entries.filter((g) => g.runAt === latest);
}

/** Mirror of the inside view's aggregate: asked nothing is never green. */
function aggregatePassed(entries: readonly GateRun[]): boolean {
  return entries.length > 0 && entries.every((g) => g.exitCode === 0);
}

function gateMetrics(entries: readonly GateRun[]): { label: string; value: string }[] {
  const passed = entries.filter((g) => g.exitCode === 0).length;
  const failed = entries.filter((g) => g.exitCode !== 0 && g.exitCode !== null).length;
  return [
    { label: 'passed', value: String(passed) },
    { label: 'failed', value: String(failed) },
  ];
}

function gateSummary(entries: readonly GateRun[]): string {
  const passed = entries.filter((g) => g.exitCode === 0).length;
  const failed = entries.filter((g) => g.exitCode !== 0 && g.exitCode !== null).length;
  const noScript = entries.filter((g) => g.exitCode === null).length;
  return `${passed} passed · ${failed} failed${noScript ? ` · ${noScript} no script` : ''}`;
}

/**
 * A stage's span as a person reads it (the same `formatSpanMs` the inside rows
 * use, so the artifact's "duration" metric and the ledger's row durations can
 * never disagree about how long the same stage took). Null for an unparseable
 * or negative span — an absent fact must read as absent.
 */
function durationSpan(stage: Stage | undefined): string | null {
  if (!stage?.startedAt || !stage.endedAt) return null;
  const ms = new Date(stage.endedAt).getTime() - new Date(stage.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatSpanMs(ms) : null;
}

/**
 * Staleness: implementation (or a fix session re-implementing) ran again after
 * this verification finished, so the report no longer validates the current
 * code. A RUNNING impl counts — the code is changing right now.
 */
function freshnessFor(
  stages: readonly Stage[],
  stageKey: 'uat' | 'review',
  artifactAt: string | null,
): ArtifactFreshness {
  if (!artifactAt) return 'current';
  const changedAfter = stages.some(
    (s) =>
      (s.stageKey === 'impl' || s.stageKey === 'fix') &&
      s.startedAt !== null &&
      s.startedAt > artifactAt,
  );
  return changedAfter ? 'stale' : 'current';
}

/** The core whose session produced a stage's evidence, best recorded fact. */
function originFor(
  stage: ArtifactStage,
  processRuns: readonly ProcessRun[],
  ticket: TicketWithStages,
): ArtifactOrigin {
  const snapshot = [...processRuns]
    .reverse()
    .find((p) => p.stageKey === stage && p.status !== 'stale' && isKnownProvider(p.provider));
  // `snapshot?.provider` is `string | null` — narrowed to `AgentProvider | null` by
  // the find guard above, but TS doesn't widen it through `??`. A final
  // `isKnownProvider` call ensures the return type stays the closed union.
  const raw = snapshot?.provider ?? ticket.sessionProvider ?? ticket.agentProvider ?? null;
  const core = isKnownProvider(raw) ? raw : null;
  return { kind: 'karst', core };
}

/**
 * The gate-lane AI process whose console a stage's report can open, or null
 * when that process never ran. A run that is still OPEN counts: its output
 * streams into the console while it runs, which is the whole point of the live
 * preview — waiting for the run to finish would hide it exactly when it is
 * worth watching. `stale` rows are ignored, the same way `originFor` does.
 */
function agentConsoleFor(
  stage: 'uat' | 'review',
  processRuns: readonly ProcessRun[],
): AgentConsoleProcessId | null {
  const processId: AgentConsoleProcessId = stage === 'uat' ? 'tester' : 'review';
  const ran = processRuns.some(
    (p) => p.stageKey === stage && p.processId === processId && p.status !== 'stale',
  );
  return ran ? processId : null;
}

function resourceFrom(path: string | null, out: ArtifactResource[]): void {
  if (!path) return;
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  if (out.some((r) => r.path === path)) return;
  out.push({ name, path });
}

/**
 * Distinct run invocations across a gate stage's evidence = one version each.
 *
 * Keys on `stageRunId` (the `stage_runs` row, one per invocation) — NOT on
 * `attempt`, which only bumps on failure and collapses every passing
 * re-validation into the failing run's number (Issue #5). Gate runs and
 * process runs of the SAME invocation share a `stageRunId`, so deduplicating
 * on it counts one version per invocation regardless of how many run types
 * produced evidence (gate batch + tester/findings process run = still 1).
 *
 * Pre-v25 rows (NULL `stageRunId`) fall back to `runAt` / `startedAt` — a
 * legacy row carries no run id, so its batch stamp is the only identity
 * available, and a NULL stamp still counts as one via the fallback set.
 */
function versionAttempts(
  entries: readonly GateRun[],
  processRuns: readonly ProcessRun[],
  stage: ArtifactStage,
): number {
  const runIds = new Set<number | string>();
  for (const e of entries) {
    runIds.add(e.stageRunId ?? e.runAt);
  }
  for (const p of processRuns) {
    if (p.stageKey === stage) runIds.add(p.stageRunId ?? p.startedAt);
  }
  return runIds.size;
}

function uatReport(input: ArtifactInput): ArtifactSummary | null {
  const { ticket, gateRuns, uatFindings, processRuns } = input;
  const stage = ticket.stages.find((s) => s.stageKey === 'uat');
  const allEntries = gateEntries(gateRuns, 'uat');
  const entries = latestAttemptEntries(allEntries);
  if (allEntries.length === 0 && uatFindings.length === 0) return null;

  const findings: ArtifactFinding[] = uatFindings
    .slice(0, MAX_DETAIL_FINDINGS)
    .map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: null,
      repo: f.repo ?? null,
      file: f.filePath ?? null,
      line: f.line ?? null,
      // The observation's file is a real location — the same open-file
      // capability the inside findings carry, minted only when one exists.
      ...(input.attach && f.filePath
        ? {
            action: input.attach({
              kind: 'open-file',
              evidence: { source: 'uat-finding', id: f.id },
            }),
          }
        : {}),
    }));
  const createdAt = stage?.endedAt ?? stage?.startedAt ?? null;
  const attemptCount = versionAttempts(allEntries, processRuns, 'uat');
  const failedStage = stage?.status === 'failed';
  const summary =
    entries.length > 0
      ? gateSummary(entries)
      : `${findings.length} observation${findings.length === 1 ? '' : 's'}`;
  const duration = durationSpan(stage);
  const metrics = [
    ...gateMetrics(entries),
    ...(duration ? [{ label: 'duration', value: duration }] : []),
  ];
  const resources: ArtifactResource[] = [];
  resourceFrom(stage?.artifactPath ?? null, resources);
  for (const p of processRuns) {
    if (p.stageKey === 'uat') resourceFrom(p.artifactPath, resources);
  }

  return {
    id: 'uat-report',
    stage: 'uat',
    kind: 'uat-report',
    title: KINDS['uat-report'].title,
    scope: null,
    summary,
    status: failedStage ? 'failed' : aggregatePassed(entries) ? 'passed' : 'info',
    freshness: freshnessFor(ticket.stages, 'uat', createdAt),
    origin: originFor('uat', processRuns, ticket),
    versionCount: attemptCount || 1,
    currentVersionLabel: `v${attemptCount || 1}`,
    createdAt,
    metrics,
    gates: entries.map((g) => ({ name: g.gateName, exitCode: g.exitCode })),
    findings,
    prs: [],
    commits: [],
    resources,
    tasks: [],
    detail: failedStage ? (stage?.verdict ?? null) : null,
    agentConsole: agentConsoleFor('uat', processRuns),
  };
}

function reviewReport(input: ArtifactInput): ArtifactSummary | null {
  const { ticket, gateRuns, findings, processRuns } = input;
  const stage = ticket.stages.find((s) => s.stageKey === 'review');
  const allEntries = gateEntries(gateRuns, 'review');
  const entries = latestAttemptEntries(allEntries);
  if (allEntries.length === 0 && findings.length === 0) return null;

  const blocking = findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length;
  const createdAt = stage?.endedAt ?? stage?.startedAt ?? null;
  const attemptCount = versionAttempts(allEntries, processRuns, 'review');
  const failedStage = stage?.status === 'failed';
  const bySeverity = new Map<string, number>();
  for (const f of findings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  const metrics =
    findings.length > 0
      ? [...bySeverity.entries()].map(([label, value]) => ({ label, value: String(value) }))
      : gateMetrics(entries);
  const resources: ArtifactResource[] = [];
  resourceFrom(stage?.artifactPath ?? null, resources);
  for (const p of processRuns) {
    if (p.stageKey === 'review') resourceFrom(p.artifactPath, resources);
  }

  return {
    id: 'review',
    stage: 'review',
    kind: 'review',
    title: KINDS.review.title,
    scope: null,
    summary:
      findings.length > 0
        ? `${findings.length} finding${findings.length === 1 ? '' : 's'}`
          + ` · ${blocking} need${blocking === 1 ? 's' : ''} attention`
        : gateSummary(entries),    status: failedStage ? 'failed' : findings.length > 0 ? 'attention' : aggregatePassed(entries) ? 'passed' : 'info',
    freshness: freshnessFor(ticket.stages, 'review', createdAt),
    origin: originFor('review', processRuns, ticket),
    versionCount: attemptCount || 1,
    currentVersionLabel: `v${attemptCount || 1}`,
    createdAt,
    metrics,
    gates: entries.map((g) => ({ name: g.gateName, exitCode: g.exitCode })),
    findings: findings.slice(0, MAX_DETAIL_FINDINGS).map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail || null,
      repo: f.repo || null,
      file: f.file ?? null,
      line: f.line ?? null,
      // The finding's file is a real location — the same open-file capability
      // the inside findings carry, minted only when one exists.
      ...(input.attach && f.file
        ? {
            action: input.attach({
              kind: 'open-file',
              evidence: { source: 'review-finding', id: f.id },
            }),
          }
        : {}),
    })),
    prs: [],
    commits: [],
    resources,
    tasks: [],
    detail: failedStage ? (stage?.verdict ?? null) : null,
    agentConsole: agentConsoleFor('review', processRuns),
  };
}

function shipSummary(input: ArtifactInput): ArtifactSummary | null {
  const { ticket, ship, shipRunCount, prs } = input;
  const run = ship.run;
  if (!run) return null;

  const repoCount = Object.keys(ship.repos).length;
  const prCount = prs.length;
  const commits = Object.values(ship.repos).flatMap((r) => r.commits);
  const created = commits.filter((c) => c.origin === 'created-by-ship');
  const running = run.status === 'running';
  return {
    id: 'ship-summary',
    stage: 'ship',
    kind: 'ship-summary',
    title: KINDS['ship-summary'].title,
    scope: null,
    summary: running
      ? `Shipping across ${repoCount} repo${repoCount === 1 ? '' : 's'}…`
      : `${prCount} PR${prCount === 1 ? '' : 's'} opened · ${created.length} commit${created.length === 1 ? '' : 's'}`,
    status:
      run.status === 'passed' ? 'passed' : run.status === 'running' ? 'info' : 'failed',
    freshness: 'current',
    origin: originFor('ship', input.processRuns, ticket),
    versionCount: shipRunCount || 1,
    currentVersionLabel: `v${shipRunCount || 1}`,
    createdAt: run.startedAt,
    metrics: [
      { label: 'repos', value: String(repoCount) },
      { label: 'PRs', value: String(prCount) },
      { label: 'commits', value: String(created.length) },
    ],
    gates: [],
    findings: [],
    prs: prs.map((p) => ({
      repo: p.repo,
      number: p.number,
      url: p.url,
      status: p.status,
    })),
    commits: commits
      .slice(0, MAX_DETAIL_COMMITS)
      .map((c) => ({
        repo: c.repo,
        sha: c.sha,
        message: c.message,
        // The SHA's open-commit capability — the SAME host seam the inside
        // evidence uses, so a click re-loads the recorded ship commit by id
        // and reveals it. An artifact snapshot built without an attach
        // callback (a fixture, the CLI) renders the SHA as plain text.
        ...(input.attach
          ? { action: input.attach({ kind: 'open-commit', shipCommitId: c.id }) }
          : {}),
      })),
    resources: [],
    tasks: [],
    detail: run.status === 'passed' ? null : 'Ship did not complete — retry ship to continue.',
    agentConsole: null,
  };
}

/**
 * The graph runtime's node-run statuses that read as "this task is running".
 * Everything else is derived below; a status absent from every map (an
 * unknown/future rest state) reads `todo`, never "unknown".
 */
const PLAN_TASK_DOING_STATUSES: readonly string[] = [
  'launching',
  'running',
  'completing',
  'integrating',
];
const PLAN_TASK_BLOCKED_STATUSES: readonly string[] = [
  'blocked',
  'failed-to-launch',
  'launch-unknown',
  'termination-unknown',
  'output-artifact-missing',
  'artifact-unsafe',
];
const PLAN_TASK_CANCELLED_STATUSES: readonly string[] = ['stale', 'cancelled'];

/** Map one node-run status to the plan task's closed status vocabulary. */
function planTaskStatus(status: string): ArtifactPlanTaskStatus {
  if (status === 'completed') return 'done';
  if (PLAN_TASK_DOING_STATUSES.includes(status)) return 'doing';
  if (PLAN_TASK_BLOCKED_STATUSES.includes(status)) return 'blocked';
  if (PLAN_TASK_CANCELLED_STATUSES.includes(status)) return 'cancelled';
  return 'todo'; // ready / waiting-resource / not yet claimed
}

/** The plan artifact's status from the graph run's status + task outcomes. */
function planArtifactStatus(
  graphRunStatus: string,
  blocked: number,
  done: number,
  total: number,
): ArtifactStatus {
  // A blocked task is the actionable fault: a plan with a blocked node reads
  // needs-attention even while the run itself still looks active.
  if (blocked > 0) return 'attention';
  switch (graphRunStatus) {
    case 'completed-awaiting-impl-marker':
    case 'closed':
      return total > 0 && done === total ? 'passed' : 'attention';
    case 'blocked':
    case 'stale':
      return 'attention';
    case 'cancelled':
      return 'info';
    default:
      return 'info'; // planning / awaiting-confirmation / running / draining
  }
}

/**
 * The plan's origin: the graph planner produced the plan, so the producing
 * core is the planner run's recorded provider (falling back to the ticket's
 * session/config provider for evidence that predates identity capture) — the
 * same fallback chain `originFor` uses for gate evidence.
 */
function planOrigin(plan: ArtifactPlanInput, ticket: TicketWithStages): ArtifactOrigin {
  const plannerProvider = [...plan.plannerRuns]
    .reverse()
    .find((p) => p.provider && isKnownProvider(p.provider))?.provider;
  const raw = plannerProvider ?? ticket.sessionProvider ?? ticket.agentProvider ?? null;
  return { kind: 'karst', core: isKnownProvider(raw) ? raw : null };
}

/**
 * The Plan artifact's dispatcher: the graph runtime owns the plan when it
 * drove the ticket (graphPlanReport); a regular session's plan is derived from
 * the workflow it declares and the phases it reported (sessionPlanReport).
 */
function planReport(input: ArtifactInput): ArtifactSummary | null {
  return input.plan?.graphRun ? graphPlanReport(input) : sessionPlanReport(input);
}

/**
 * The graph Plan artifact: the graph runtime IS the ticket's plan. It reads
 * the latest accepted revision's canonical graph (the plan document) for the
 * node labels, and each node's LATEST run for its current progress — so the
 * shelf answers "what to do / what was done / what is in progress" from the
 * same rows the graph Inside projection renders. No graph run → the session
 * plan reports instead. A replanned revision is a NEW version of the same
 * plan, never a second artifact.
 */
function graphPlanReport(input: ArtifactInput): ArtifactSummary | null {
  const plan = input.plan;
  const graphRun = plan?.graphRun;
  if (!graphRun) return null;

  // The LATEST revision is the current plan document (a replan's revision N+1
  // supersedes N). The revision list is ordered by revision_number.
  const revision = plan.revisions[plan.revisions.length - 1];
  let nodes: { id: string; kind: string; label: string }[] = [];
  if (revision) {
    const parsed = parseGraphDocument(revision.canonicalGraph);
    if (parsed.ok) {
      nodes = parsed.document.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label }));
    }
  }

  // The latest run PER NODE: runs are append-only, so the highest id wins.
  const latestRun = new Map<string, ArtifactPlanInput['nodeRuns'][number]>();
  for (const run of plan.nodeRuns) {
    const current = latestRun.get(run.nodeId);
    if (!current || run.id > current.id) latestRun.set(run.nodeId, run);
  }

  const tasks: ArtifactPlanTask[] = nodes.map((node) => {
    const run = latestRun.get(node.id);
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      status: run ? planTaskStatus(run.status) : 'todo',
      visits: run ? `visit ${run.visitNumber}` : null,
    };
  });
  // A node that RAN but is not in the latest document (a superseded
  // revision's leftover) still reads as a task with its recorded status —
  // evidence is never dropped because the plan moved on.
  for (const [nodeId, run] of latestRun) {
    if (!nodes.some((n) => n.id === nodeId)) {
      tasks.push({
        id: nodeId,
        label: nodeId,
        kind: run.nodeKind,
        status: planTaskStatus(run.status),
        visits: `visit ${run.visitNumber}`,
      });
    }
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const doing = tasks.filter((t) => t.status === 'doing').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;

  const summary =
    tasks.length === 0
      ? graphRun.status === 'planning'
        ? 'Planning the implementation…'
        : 'No tasks yet'
      : `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${done} done`
        + (doing ? ` · ${doing} in progress` : '');

  const resources: ArtifactResource[] = [];
  for (const artifact of plan.plannerArtifacts) {
    resourceFrom(artifact.snapshotPath, resources);
  }

  return {
    id: 'plan',
    stage: 'impl',
    kind: 'plan',
    title: KINDS.plan.title,
    scope: null,
    summary,
    status: planArtifactStatus(graphRun.status, blocked, done, tasks.length),
    freshness: 'current',
    origin: planOrigin(plan, input.ticket),
    versionCount: Math.max(plan.revisions.length, 1),
    currentVersionLabel: `v${Math.max(plan.revisions.length, 1)}`,
    createdAt: graphRun.createdAt,
    metrics: [
      { label: 'to-do', value: String(todo) },
      { label: 'in progress', value: String(doing) },
      { label: 'done', value: String(done) },
      ...(blocked ? [{ label: 'blocked', value: String(blocked) }] : []),
    ],
    gates: [],
    findings: [],
    prs: [],
    commits: [],
    tasks: tasks.slice(0, MAX_DETAIL_TASKS),
    resources,
    detail: null,
    agentConsole: null,
  };
}

/**
 * The session-phases plan: the plan for a ticket the graph approach never
 * drove. A regular impl session still has a plan — the workflow its approach
 * DECLARES (what to do) and the phases the agent REPORTED by firing the
 * `phase` marker (what was done / what is in progress). Each declared phase is
 * a task; a reported phase the approach never declared is appended rather than
 * dropped, because the off-script signal is evidence (store/phaseMarks, same
 * rule as a node that left a superseded revision). A phase reads `done` once
 * marked, `doing` while it is the LATEST mark of a still-running impl, and
 * `todo` before it is ever claimed.
 *
 * No graph run, no workflow, no marks — and no impl evidence at all (the stage
 * never started, no impl process ran, nothing reported) → no plan: there is no
 * plan to show, and "no evidence, no artifact" holds here too.
 */
function sessionPlanReport(input: ArtifactInput): ArtifactSummary | null {
  const { ticket, declaredPhases, phaseMarks } = input;
  const implCell = ticket.stages.find((s) => s.stageKey === 'impl');
  const hasImplEvidence =
    implCell?.startedAt != null ||
    input.processRuns.some((p) => p.stageKey === 'impl') ||
    phaseMarks.length > 0;
  if (!hasImplEvidence) return null;

  // The reported phases THIS impl may claim: same stage, same attempt, each
  // at its FIRST mark — the `reportedPhases` semantics, in report order.
  const attempt = implCell?.attempt ?? 0;
  const first = new Map<string, string>();
  for (const mark of phaseMarks) {
    if (mark.stageKey === 'impl' && mark.attempt === attempt && !first.has(mark.phaseName)) {
      first.set(mark.phaseName, mark.markedAt);
    }
  }
  const reported = [...first.keys()];
  if (declaredPhases.length === 0 && reported.length === 0) return null;

  const names = [...declaredPhases];
  for (const name of reported) {
    if (!names.includes(name)) names.push(name);
  }
  const reportedSet = new Set(reported);
  const latestReported = reported[reported.length - 1] ?? null;
  const running = implCell?.status === 'running';

  // The done marker is the completion authority for everything AFTER the last
  // phase the agent reported: a stage the marker closed did that work, whether
  // or not a phase mark named it. The same reading the session timeline's
  // derived implement row uses — without it the stage read done and green while
  // the plan still showed its trailing phases grey, as if they never ran. A
  // declared phase the agent SKIPPED (one before the latest report) is not
  // covered: nothing claims it happened, so it stays to-do.
  const passed = implCell?.status === 'passed';
  const latestIndex = latestReported === null ? -1 : names.indexOf(latestReported);

  const tasks: ArtifactPlanTask[] = names.map((name, index) => {
    let status: ArtifactPlanTaskStatus = 'todo';
    if (reportedSet.has(name)) status = 'done';
    else if (passed && index > latestIndex) status = 'done';
    if (running && name === latestReported) status = 'doing';
    return { id: name, label: name, kind: 'phase', status, visits: null };
  });

  const done = tasks.filter((t) => t.status === 'done').length;
  const doing = tasks.filter((t) => t.status === 'doing').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;

  const summary =
    `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${done} done`
    + (doing ? ` · ${doing} in progress` : '');

  return {
    id: 'plan',
    stage: 'impl',
    kind: 'plan',
    title: KINDS.plan.title,
    scope: null,
    summary,
    status: running ? 'info' : implCell?.status === 'passed' ? 'passed' : 'info',
    freshness: 'current',
    origin: originFor('impl', input.processRuns, ticket),
    versionCount: 1,
    currentVersionLabel: 'v1',
    createdAt: implCell?.startedAt ?? null,
    metrics: [
      { label: 'to-do', value: String(todo) },
      { label: 'in progress', value: String(doing) },
      { label: 'done', value: String(done) },
    ],
    gates: [],
    findings: [],
    prs: [],
    commits: [],
    tasks: tasks.slice(0, MAX_DETAIL_TASKS),
    resources: [],
    detail: null,
    agentConsole: null,
  };
}
