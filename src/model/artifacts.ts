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
 * ship_runs). The origin's `core` is likewise READ from the immutable identity
 * snapshot `process_runs` captured at launch (provider/agent/model are written
 * when the process opens and never rewritten) — falling back to the ticket's
 * `session_provider`/`agent_provider` only for evidence that predates process
 * identity capture. Nothing here invents a fact: no evidence, no artifact.
 *
 * The detail "payload" rides the same snapshot (there is no async `artifact.get`
 * round trip): everything the detail renders — metrics, findings, gates, PRs,
 * commits, resources — is already in the state push, so the webview's detail
 * view is a local render and its only failure mode (a resource file that has
 * gone) is reported by the host opener, exactly like `openStageLog`.
 */
import type { AgentProvider, Severity } from '../manifest/types.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { Stage } from '../store/stages.js';
import type { GateRun } from '../store/gateRuns.js';
import type { Finding } from '../store/reviewFindings.js';
import type { UatFinding } from '../store/uatFindings.js';
import type { ProcessRun } from '../store/processRuns.js';
import type { ShipEvidence } from '../store/shipRuns.js';
import type { PrView } from '../store/dashboard.js';
import { getTicket } from '../store/tickets.js';
import { listGateRuns } from '../store/gateRuns.js';
import { listFindings } from '../store/reviewFindings.js';
import { listUatFindings } from '../store/uatFindings.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listShipEvidence, countShipRuns } from '../store/shipRuns.js';
import { listPrsByTicket } from '../store/dashboard.js';
import { isKnownProvider } from '../agent/provider.js';
import type { Store } from '../store/db.js';

/** The semantic artifact kinds V1 derives. One artifact per kind per ticket. */
export type ArtifactKind = 'uat-report' | 'review' | 'ship-summary';

/** The stage the artifact's work happened in — also the index's grouping key. */
export type ArtifactStage = 'uat' | 'review' | 'ship';

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
}

/** One underlying raw representation, shown LAST in detail, opened on demand. */
export interface ArtifactResource {
  /** basename only — display; never joined into a path by the webview. */
  name: string;
  /** Absolute path, host-resolved; only the host ever opens it. */
  path: string;
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
  resources: ArtifactResource[];
  /** The stage verdict's reason when the artifact's stage failed; else null. */
  detail: string | null;
}

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
}

/** The gate_runs row that is NOT a gate: the review stage's Changes-panel mark. */
const NON_GATE_RUNS = new Set(['changes']);

/** Detail list caps: a display decision, never a verdict (see ArtifactSummary). */
const MAX_DETAIL_FINDINGS = 50;
const MAX_DETAIL_COMMITS = 20;

const KINDS: Record<ArtifactKind, { stage: ArtifactStage; title: string }> = {
  'uat-report': { stage: 'uat', title: 'UAT report' },
  review: { stage: 'review', title: 'Review' },
  'ship-summary': { stage: 'ship', title: 'PR summary' },
};

/**
 * Semantic preview priority (spec §5): the three previews represent the most
 * useful current outputs, stably ordered. Active tickets lead with verification;
 * completed tickets lead with the landing (Ship/PR outranks Plan there).
 */
const PRIORITY_ACTIVE: Record<ArtifactKind, number> = {
  'uat-report': 0,
  review: 1,
  'ship-summary': 2,
};
const PRIORITY_DONE: Record<ArtifactKind, number> = {
  'ship-summary': 0,
  'uat-report': 1,
  review: 2,
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
 */
export function buildTicketArtifacts(store: Store, ticketId: number): ArtifactSummary[] {
  return buildArtifactsFrom({
    ticket: getTicket(store, ticketId),
    gateRuns: listGateRuns(store, ticketId),
    findings: listFindings(store, ticketId),
    uatFindings: listUatFindings(store, ticketId),
    processRuns: listProcessRuns(store, ticketId),
    ship: listShipEvidence(store, ticketId),
    shipRunCount: countShipRuns(store, ticketId),
    prs: listPrsByTicket(store, ticketId),
  });
}

/** Derive a ticket's artifacts from evidence the caller already read once. */
export function buildArtifactsFrom(input: ArtifactInput): ArtifactSummary[] {
  const { ticket } = input;
  const out: ArtifactSummary[] = [];
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
 * The entries of the LATEST attempt only. Gate evidence is append-only, so an
 * earlier attempt's rows survive forever — but the artifact presents the
 * CURRENT version, and mixing attempts would fold a failed attempt into a
 * passed one (and vice versa) until the verdict read as noise. Attempts still
 * count separately as VERSIONS (see versionAttempts).
 */
function latestAttemptEntries(entries: readonly GateRun[]): readonly GateRun[] {
  if (entries.length === 0) return entries;
  const latest = Math.max(...entries.map((g) => g.attempt));
  return entries.filter((g) => g.attempt === latest);
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

function durationSec(stage: Stage | undefined): string | null {
  if (!stage?.startedAt || !stage.endedAt) return null;
  const ms = new Date(stage.endedAt).getTime() - new Date(stage.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? String(Math.round(ms / 1000)) : null;
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

function resourceFrom(path: string | null, out: ArtifactResource[]): void {
  if (!path) return;
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  if (out.some((r) => r.path === path)) return;
  out.push({ name, path });
}

/** Distinct attempts across a gate stage's evidence = one version each. */
function versionAttempts(
  entries: readonly GateRun[],
  processRuns: readonly ProcessRun[],
  stage: ArtifactStage,
): number[] {
  const attempts = new Set<number>();
  for (const e of entries) attempts.add(e.attempt);
  for (const p of processRuns) {
    if (p.stageKey === stage) attempts.add(p.attempt);
  }
  return [...attempts].sort((a, b) => a - b);
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
    }));
  const createdAt = stage?.endedAt ?? stage?.startedAt ?? null;
  const attempts = versionAttempts(allEntries, processRuns, 'uat');
  const failedStage = stage?.status === 'failed';
  const summary =
    entries.length > 0
      ? gateSummary(entries)
      : `${findings.length} observation${findings.length === 1 ? '' : 's'}`;
  const duration = durationSec(stage);
  const metrics = [
    ...gateMetrics(entries),
    ...(duration ? [{ label: 'duration', value: `${duration}s` }] : []),
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
    versionCount: attempts.length || 1,
    currentVersionLabel: `v${attempts.length || 1}`,
    createdAt,
    metrics,
    gates: entries.map((g) => ({ name: g.gateName, exitCode: g.exitCode })),
    findings,
    prs: [],
    commits: [],
    resources,
    detail: failedStage ? (stage?.verdict ?? null) : null,
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
  const attempts = versionAttempts(allEntries, processRuns, 'review');
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
    versionCount: attempts.length || 1,
    currentVersionLabel: `v${attempts.length || 1}`,
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
    })),
    prs: [],
    commits: [],
    resources,
    detail: failedStage ? (stage?.verdict ?? null) : null,
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
      .map((c) => ({ repo: c.repo, sha: c.sha, message: c.message })),
    resources: [],
    detail: run.status === 'passed' ? null : 'Ship did not complete — retry ship to continue.',
  };
}
