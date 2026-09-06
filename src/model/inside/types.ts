import type { StageKey } from '../types.js';
import { displayStatus, type StepperCell } from '../stepper.js';
import type { AttemptKey, GateAttemptView } from './rounds.js';

/**
 * How an operation row reads.
 *
 * `note` is not a status. It is karst stating a fact it cannot honestly dress as
 * a pass or a fail — a gate the repo cannot answer, a phase karst does not
 * observe, a rule about what will happen next. Keeping it in the union is what
 * stops the panel inventing a verdict to fill a row.
 *
 * `skip` is narrower and is NOT a second `note`: the gate exists, the repository
 * can answer it, and a human decided it should not be asked for this ticket. A
 * `note` says karst had no question; a `skip` says the question was withdrawn,
 * and a reader who cannot tell the two apart cannot tell a broken repo from a
 * deliberate choice.
 */
export type OpStatus = 'pass' | 'fail' | 'run' | 'wait' | 'pending' | 'note' | 'skip';

/** One line inside a stage: what karst did, or plainly why it cannot say. */
export interface StageOp {
  status: OpStatus;
  /** Short left-hand name — `lint`, `worktree`, `agent`. */
  name: string;
  /** The machine detail — `npm run lint — exit 1`. */
  detail: string;
  /** Preformatted duration, or '' when there is none to state. */
  duration: string;
}

/** The state dot beside the "Inside <stage>" header. */
export type InsideDot = 'done' | 'run' | 'wait' | 'fail' | 'idle' | 'pend';

/** Display titles for the strip header. */
export const STAGE_TITLES: Readonly<Record<StageKey, string>> = {
  scope: 'Scope',
  impl: 'Implementation',
  uat: 'UAT',
  review: 'Review',
  fix: 'Fix',
  ship: 'Ship',
  done: 'Done',
};

/**
 * What each stage does, taken from the runners in `src/workflow/stages/`. This
 * is what a not-yet-run stage shows, so selecting a pending stage still answers
 * "what will happen here?" rather than showing an empty panel.
 */
export const STAGE_BLURBS: Readonly<Record<StageKey, string>> = {
  scope:
    'Validates the hot repo set against the manifest, then creates one worktree per hot repo off the baseline branch. Nothing is created until you confirm.',
  impl: 'The interactive agent session. Advances only on the explicit done marker — a session ending is not a verdict.',
  uat: "Runs the repo's own test script in the ticket's worktree. The exit code is the verdict; nothing self-reported counts.",
  review:
    'Runs lint, typecheck and test. Every gate the repo can answer must exit 0. The diff opens for you either way.',
  fix: 'Resumes the captured session so the agent keeps its context, then re-enters the uat gate.',
  ship:
    'Commits, pushes, and opens one PR per hot repo with an agent-written description, then waits until every one of them is merged. karst never merges on its own — you click Merge on each PR, or a teammate lands it and the PR sweep notices. A branch that stops merging cleanly is reported here, and the ticket is not done until they all land.',
  done: 'Terminal. Nothing runs here — arriving is completing.',
};

/**
 * A span as a person reads it. Sub-minute keeps a decimal because gate times
 * live there; above a minute the decimal is noise.
 */
export function formatDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return formatSpanMs(ms);
}

/**
 * A measured millisecond span in the same readable form `formatDuration`
 * rounds to. The done receipt's Timing strip sums stage spans and states the
 * total — the same shape each span reads, so the displayed sum IS the
 * displayed total (869egdr2u-fu1).
 */
export function formatSpanMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The same span `formatDuration` rounds, stated exactly. Rendered ONLY as a
 * control's `title`: the row keeps the readable form, and a reader who needs
 * the millisecond truth can hover for it. Empty for an absent or unparseable
 * pair, exactly like `formatDuration` — an absent fact must read as absent.
 */
export function formatExactDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `${(ms / 1000).toFixed(3)}s`;
}

/** Time of day, in the reader's own locale. Empty for an unparseable stamp. */
export function formatTime(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/**
 * Time of day WITHOUT seconds — the timeline's phase-time cell, which the
 * design draws as `10:06` rather than the full `10:06:14`. Empty for an
 * unparseable stamp, exactly like `formatTime`.
 */
export function formatShortTime(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The strip's header line for a stage.
 *
 * `now` is injected rather than read from the clock so this stays pure and
 * testable; a running stage's elapsed time is therefore as fresh as the last
 * state push, which is every driver progress tick.
 */
export function formatClock(cell: StepperCell, now: string): string {
  const attempt = cell.attempt && cell.attempt > 0 ? ` · attempt ${cell.attempt}` : '';

  if (!cell.startedAt) {
    return cell.status === 'pending' ? 'has not run yet' : '';
  }
  if (cell.status === 'running') {
    const elapsed = formatDuration(cell.startedAt, now);
    return `started ${formatTime(cell.startedAt)}${elapsed ? ` · ${elapsed} elapsed` : ''}${attempt}`;
  }
  // The done stage is terminal — "nothing runs here, arriving is completing"
  // (STAGE_BLURBS.done) — so it is stamped at the instant of arrival and its
  // span reads 0.0s, noise beside the timestamp. The header names only the
  // completion time; the stage durations live in the receipt's Timing strip.
  if (cell.stageKey === 'done') {
    return `${formatTime(cell.startedAt)}${attempt}`;
  }
  const took = formatDuration(cell.startedAt, cell.endedAt);
  return `${formatTime(cell.startedAt)}${took ? ` · ${took}` : ''}${attempt}`;
}

/**
 * Map a stage's status onto the header dot. Read through `displayStatus`: a
 * parked stage keeps its stored `running` while blocked, and the header must
 * not spin a `run` arc beside its own block banner — it reads `wait` (the
 * amber two-bars glyph), the same reading the process rows give it.
 */
export function dotFor(cell: StepperCell): InsideDot {
  switch (displayStatus(cell)) {
    case 'passed':
      return 'done';
    case 'running':
      return 'run';
    case 'blocked':
      return 'wait';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'idle';
    default:
      return 'pend';
  }
}

/**
 * The six-stage inside contract (the inside redesign).
 *
 * The runtime stage machine keeps its own key vocabulary — seven keys
 * including `fix` (`StageKey`). The presentation model is a SEPARATE six-stage
 * contract: `fix` is not a stage a person visits, it is recovery attached to
 * the stage it returns to, so it is projected away here by
 * `insideStageForRuntimeStage` and surfaces only as a `recovery` process. The
 * runtime model (`StageKey`, the graph) is never modified to match.
 */

/** The six stages the inside view presents. Deliberately not `StageKey`. */
export type InsideStageKey = 'scope' | 'impl' | 'uat' | 'review' | 'ship' | 'done';

/** A process id within the inside contract — `gates`, `commit`, `delivery-receipt`. */
export type InsideProcessId = string;

/** How one process row reads to the eye. The same vocabulary as `OpStatus`. */
export type InsideStatus = 'pending' | 'run' | 'wait' | 'pass' | 'fail' | 'note' | 'skip';

/**
 * A finding's level, as a CLOSED styling key. Review and UAT observations are
 * two different tables recording the same four-level vocabulary, and both
 * render through one severity ramp — a reader must not have to learn which
 * stage they are looking at to know how bad "high" is.
 *
 * Anything a store hands over that is not one of these is dropped rather than
 * coerced: an unrecognised level is absence of a level, never `low`.
 */
export type InsideSeverity = 'critical' | 'high' | 'medium' | 'low';

/** The closed vocabulary, in one place — mirrors the union above. */
export const INSIDE_SEVERITIES: readonly InsideSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

/** Narrow a recorded severity to the closed styling vocabulary, or nothing. */
export function insideSeverity(value: string | null | undefined): InsideSeverity | undefined {
  return INSIDE_SEVERITIES.find((s) => s === value);
}

/** The AI identity of one execution, as displayed. */
export interface AgentExecutionView {
  agentName?: string;
  provider: string;
  providerLabel: string;
  model: string | null;
  modelLabel: string;
}

/** What a process row's control can ask the host to do. */
export type InsideActionKind =
  | 'open-pr'
  | 'open-commit'
  | 'open-file'
  | 'open-stage-log'
  | 'resume-stage'
  | 'open-full-evidence'
  | 'open-bounded-evidence'
  | 'open-session'
  | 'graph-open-session'
  | 'graph-confirm'
  | 'graph-stop'
  | 'graph-resume'
  | 'graph-restart'
  | 'graph-replan'
  | 'graph-mark-impl'
  | 'graph-discard-node'
  | 'graph-edit-override';

/**
 * A navigation/continuation control on a process row.
 *
 * `actionId` is an opaque snapshot-scoped capability: never a path, URL, repo,
 * SHA, or PR number — the host resolves it through a ticket-scoped allowlist
 * and the webview posts only the id back. `kind` is a presentation hint only;
 * the host does not trust it on dispatch. `label` is the host-computed control
 * copy when it names a count ("Show 4 more" — handoff §10); absent → the
 * webview's static kind map supplies the label.
 */
export interface TypedInsideAction {
  actionId: string;
  kind: InsideActionKind;
  label?: string;
}

/**
 * The ticket-less target shape a REDUCER hands to the host's attach closure.
 * The reducers are pure and ticket-agnostic; the closure (built around the
 * host's `InsideActionRegistry`, `ui/dashboard/insideActions.ts`) owns the
 * ticket id, mints the opaque action id, and returns the `{actionId, kind}`
 * the row carries.
 */
export type InsideEvidenceTarget =
  | {
      kind: 'open-file';
      evidence: { source: 'review-finding' | 'uat-finding'; id: number };
    }
  | { kind: 'open-pr'; prId: number }
  | { kind: 'open-commit'; shipCommitId: number }
  | { kind: 'open-full-evidence'; processRunId: number; label?: string }
  | {
      kind: 'open-bounded-evidence';
      title: string;
      rows: readonly EvidenceRow[];
      label?: string;
    }
  // The impl stage's Session row: reveal the interactive session's OWN
  // terminal, exactly like `graph-open-session` reveals a live planner/node
  // session's — never a console (karst captures no log for this session,
  // `agentLogReader` serves only the gate-lane AI processes). Carries NO
  // path, terminal id, or session name: the ticket-scoped host resolves
  // which terminal to reveal (or adopt, if this window forgot it across a
  // reload) from the ticket id alone, per the opaque-capability rule above.
  | { kind: 'open-session' }
  // Graph controls (Slice 3 Task 11): Open focuses a LIVE planner/node
  // session's terminal (never spawns one); Stop signals the named coordinator
  // run to drain. These ids are recorded rows — persisted objects, never
  // client-supplied session names.
  | { kind: 'graph-open-session'; session: { kind: 'planner' | 'node'; runId: number } }
  | { kind: 'graph-stop'; graphRunId: number }
  // Slice 4 Task 4: Discard an unknown process — the ONE explicit exit for a
  // `launch-unknown`/`termination-unknown` node run. DANGER: the process may
  // still be running; the row's visible copy names that risk (UI-R19), and the
  // host transaction is conditional, so a second window's discard is a no-op.
  | { kind: 'graph-discard-node'; nodeRunId: number }
  // Slice 6 Task 4: edit an editable agent node's per-node overrides
  // (profile/provider/model/effort/prompt) BEFORE claiming. Minted only on
  // node runs whose status is in the editable set; the projection's attach
  // rule and the store's claim gate share that closed set, so a control a
  // claimed node never carries can never be minted in the first place.
  | { kind: 'graph-edit-override'; nodeRunId: number };

/**
 * The inside process's token claim, as ONE of three states (decision 8).
 * A view never formats a number — the host ships the preformatted strings.
 *
 * - `measured` — a recorded total exists for a provider that reports usage.
 * - `estimated` — only estimates exist (or a mix); carries the `estimated`
 *   marker so the count is never read as a measurement.
 * - `unavailable` — the provider reports no per-session usage (Claude,
 *   Antigravity). NOT zero and NOT "0 tokens": it renders as absent with a
 *   title explaining the core reports no per-session usage.
 */
/**
 * The Σ pill's claim. `total` is FRESH spend — input, output, reasoning and
 * cache WRITES — and `cacheRead` rides beside it as its own figure, never
 * inside it. A cache read is context the provider re-sent and re-charged at a
 * fraction of the fresh rate, and on a long opencode session it is ~95% of the
 * raw tally: headlining the sum reported 3.9M for a conversation whose own
 * terminal showed 154.5K, which reads as a runaway agent rather than as
 * ordinary prompt caching. Absent `cacheRead` = nothing was served from cache.
 */
export type TokenUsageView =
  | { state: 'measured'; total: string; exact?: string; cacheRead?: string; cacheReadExact?: string }
  | { state: 'estimated'; total: string; exact?: string; cacheRead?: string; cacheReadExact?: string }
  | { state: 'unavailable'; title: string };

/** One line inside a process's evidence block. */
export interface EvidenceRow {
  label: string;
  detail?: string;
  status?: InsideStatus;
  duration?: string;
  action?: TypedInsideAction;
  /**
   * Timeline-only structural role: WHAT this row is. `phase` = a reported
   * phase mark, `identity` = an execution identity segment (the run start, a
   * provider switch, a resume), `event` = a generic timeline event. The
   * webview draws the timeline node (check / hollow node / branch) from it
   * and NEVER infers it from `label` prose — `role` is the closed shape,
   * `label` is prose. `connector` stays the sole RELATIONSHIP marker below;
   * `role` says what the row is, `connector` says it continues the SAME
   * execution. Optional because non-timeline evidence rows carry no role;
   * absent → the timeline renders the row as a generic `event`.
   */
  role?: 'phase' | 'identity' | 'event';
  /**
   * Timeline-only identity key for `role: 'identity'` rows: the provider
   * whose core mark the injected identity renderer (`agentIconHtml`) draws
   * beside the row's own identity prose. Absent → no icon. The webview never
   * parses the provider out of `detail` — a key that was not shipped does
   * not exist.
   */
  provider?: string;
  /**
   * Timeline-only per-row token claim (`role: 'identity'` rows): the same
   * `TokenUsageView` the process rows carry, rendered as the bordered mono
   * pill. Absent → no pill; `unavailable` renders as absence-with-title,
   * NEVER "0 tokens" (decision 8).
   */
  tokens?: TokenUsageView;
  /**
   * Timeline-only relationship marker: this row continues the SAME execution
   * through a provider switch or a session resume. Structural and closed —
   * the webview draws it as the connector glyph, it never parses `label` to
   * guess that a row is a switch.
   */
  connector?: 'switch' | 'resume';
  /**
   * The repository this row's evidence was recorded against — `gate_runs.repo`,
   * verbatim. Absent for a row that names no repository (a pre-v21 gate row,
   * the `changes` evidence row, a non-gate body): the renderer drops the column
   * rather than drawing an empty one, because a blank cell reads as a repo with
   * no name instead of a row that names none.
   */
  repo?: string;
  /**
   * The PR's current state — `prs.status` — for rows the renderer draws a
   * state chip on (the merge rows). Closed vocabulary at the host, rendered
   * as the chip's class verbatim; absent → no chip.
   */
  prState?: string;
  /**
   * A finding row's severity as a STYLING key — the closed vocabulary the
   * renderer colours the level marker from. `label` already carries the same
   * word as prose; this is the structural copy, because a renderer that
   * coloured by parsing `label` would tint whatever text an agent wrote.
   * Absent → the marker keeps the neutral default.
   */
  severity?: InsideSeverity;
  /**
   * The file location a finding names — `src/foo.ts:302`, host-formatted.
   * Rendered as the row's own link when the row also carries an `open-file`
   * action, and as plain text otherwise. Kept OUT of `detail` on purpose: the
   * location is a resource identifier and therefore the link (UI-R09c), not a
   * fragment of the title's prose.
   */
  location?: string;
  /**
   * The exact form of `duration`, host-formatted. Rendered only as the
   * duration's `title`. Absent → the readable duration carries no tooltip.
   */
  durationExact?: string;
  /**
   * When this row's recorded step STARTED, as a clock time in the reader's
   * locale — `formatTime` of the same recorded timestamp `duration` is
   * measured from. Set by the ship evidence rows, whose steps each record
   * their own start. A row whose start was never recorded (a forecast gate, a
   * merge row read from CURRENT PR state rather than a recorded step) carries
   * none; absence is stated by omission, never by a placeholder.
   */
  time?: string;
}

/**
 * One commit karst recorded for a repository, as displayed. `sha` is the
 * host-shortened object id and `message` is the commit subject — untrusted
 * text the webview escapes and never parses. `action` opens the commit
 * through the opaque `open-commit` capability; absent when the caller
 * attached none.
 */
export interface CommitEntryView {
  sha: string;
  message: string;
  action?: TypedInsideAction;
}

/**
 * How a commit row's provenance pill reads. CLOSED, and it is the class the
 * webview styles from — never derived from `origin` prose.
 *
 * `ship` = the ship created these commits; `existing` = every recorded commit
 * was already there when the saga started; `none` = karst recorded no commit
 * for this repository, which is absence, NOT an empty delivery.
 */
export type CommitOriginKind = 'ship' | 'existing' | 'none';

/** One repository's commit block in the commits evidence body. */
export interface CommitRepoView {
  /** The repository, as displayed. */
  repo: string;
  /** The host-formatted count line — "2 created · 1 before". */
  summary: string;
  /** The provenance word shown in the pill. */
  origin: string;
  originKind: CommitOriginKind;
  /** When the commit step for this repo started, as a clock time. Absent → none. */
  time?: string;
  /** The recorded commits the pill speaks for. Empty → no list is drawn. */
  commits: readonly CommitEntryView[];
}

/** How one step of a PR's recorded path reads. CLOSED — the styling key. */
export type PrStepState = 'done' | 'current' | 'fail' | 'note';

/** One recorded step in a repository's pull-request path. */
export interface PrStepView {
  label: string;
  state: PrStepState;
}

/**
 * One repository's row in the PR evidence body: the PR object karst recorded
 * (its number and its CURRENT state), the recorded step path, and one
 * sentence naming why the row reads as it does.
 *
 * Every field is absence-safe: a repository whose PR number was never
 * recorded carries `number: ''` and an `emptyLabel`, never a fabricated
 * number; a PR whose status karst has not probed carries `prState: ''`, which
 * renders as no pill rather than a guessed `open`.
 */
export interface PrBranchView {
  repo: string;
  /** The host-formatted number — `#412` — or '' when none was recorded. */
  number: string;
  /** The recorded `prs.status`, or '' when unknown. The pill's class. */
  prState: string;
  /** The absence copy shown in the PR object's place. Absent → none needed. */
  emptyLabel?: string;
  steps: readonly PrStepView[];
  /** The host-worded explanation of this row. */
  note: string;
  /** Whether this row is the one currently acting (running or failed). */
  current: boolean;
  /**
   * When this repository's pull-request step started, as a clock time. Absent
   * for a repository whose step karst never recorded a start for — stated by
   * omission, never by an empty cell.
   */
  time?: string;
  /**
   * Opens the PR on the host through the opaque `open-pr` capability. Absent
   * when the caller attached none — the number then renders as plain text.
   */
  action?: TypedInsideAction;
}

/** One `amount + label` pair in the receipt's AI-usage breakdown. */
export interface ReceiptBreakdownItem {
  amount: string;
  label: string;
}

/** One block of the three-block delivery receipt grid. */
export interface ReceiptBlockView {
  label: string;
  value: string;
  /** Host-formatted supporting lines. Empty → no detail block. */
  details: readonly string[];
  /** AI-usage only; absent elsewhere. */
  breakdown?: readonly ReceiptBreakdownItem[];
}

/** The receipt's hero line. `time` is '' when no completion stamp was recorded. */
export interface DoneHeroView {
  title: string;
  summary: string;
  time: string;
}

/**
 * What happened inside one process, keyed by how it must render. A closed
 * union: a process's evidence kind is chosen from this list at reduce time
 * (unknown process ids get the generic `rows` member), so the webview's
 * renderer switch never meets an unhandled kind.
 *
 * The prototype-shaped members (`commits`, `prs`, `receipt`) carry their rich
 * bodies as OPTIONAL fields beside the `rows` every member has had since the
 * first port. That is deliberate: a snapshot produced by an older build — or
 * by a caller that fed only rows — still renders through today's generic row
 * path, so adding the bodies can never blank an existing surface. `overflow`
 * is the bounded remainder for the rich bodies, carrying the same host-owned
 * "+N more" continuation the row path puts in its last row.
 */
export type ProcessEvidenceView =
  | {
      kind: 'rows';
      rows: readonly EvidenceRow[];
      /**
       * The graph process's status-grouped node composition (Slice 6 T4): the
       * node runs as structured rows, rendered as a status-grouped list. The
       * projection ships it ORDERED by status group (the closed
       * `GraphNodeListRow.group` vocabulary), so the webview inserts a section
       * header on a group change and concatenates nothing. Absent for every
       * other process and for a snapshot that predates the surface — the flat
       * `rows` then render exactly as always.
       */
      nodes?: readonly GraphNodeListRow[];
    }
  | {
      kind: 'gates';
      rows: readonly EvidenceRow[];
      passed: number;
      failed: number;
      skipped: number;
    }
  | { kind: 'findings'; rows: readonly EvidenceRow[]; blocking: number }
  | { kind: 'timeline'; rows: readonly EvidenceRow[] }
  | {
      kind: 'commits';
      rows: readonly EvidenceRow[];
      total?: number;
      repos?: readonly CommitRepoView[];
      overflow?: EvidenceRow;
    }
  | {
      kind: 'prs';
      rows: readonly EvidenceRow[];
      open: number;
      merged: number;
      branches?: readonly PrBranchView[];
      overflow?: EvidenceRow;
    }
  | { kind: 'recovery'; rows: readonly EvidenceRow[] }
  | {
      kind: 'receipt';
      rows: readonly EvidenceRow[];
      hero?: DoneHeroView;
      blocks?: readonly ReceiptBlockView[];
      /**
       * The receipt's Timing strip (869egdr2u-fu1): the total span of the
       * ticket's work stages and every stage's own span, both computed
       * host-side from the same stamps — the displayed sum is the displayed
       * total by construction. `items` is the pre-joined host string
       * (`Scope 2m 10s · Implementation 22m 15s · …`); the webview renders
       * it verbatim (UI-R31).
       */
      timing?: { label: string; total: string; items: string };
    };

/** The closed kind vocabulary, in one place — mirrors the union above. */
export const EVIDENCE_KINDS: readonly ProcessEvidenceView['kind'][] = [
  'rows',
  'gates',
  'findings',
  'timeline',
  'commits',
  'prs',
  'recovery',
  'receipt',
] as const;

/**
 * One node run in the graph process's status-grouped node composition (Slice
 * 6 T4). Structured so the webview renders the group header on a `group`
 * change and each node's identity, visit, override marker and control WITHOUT
 * parsing the flat rows' prose. Every string field is already sanitized and
 * bounded at the projection; the webview's one `esc` is the second pass.
 *
 * `group` is the CLOSED section vocabulary (`active`/`ready`/
 * `resource-waiting`/`completed`/`blocked`/`stale`/`cancelled`/`other`) — the
 * webview maps it to static section copy, never to prose. `status` is the raw
 * node-run status, the row's own verdict text.
 */
export interface GraphNodeListRow {
  nodeRunId: number;
  nodeId: string;
  nodeKind: string;
  /** The raw node-run status (`running`, `blocked`, …). */
  status: string;
  /** The closed section key the webview groups by. */
  group: string;
  /** The mapped status dot — the row's glyph, one of `InsideStatus`. */
  displayStatus: InsideStatus;
  /** Pre-joined per-node identity — provider · model · effort · profile. */
  identity: string;
  /** Host-formatted visit — `visit 1/40`. */
  visit: string;
  /**
   * The node's existing overrides as one finished marker (`override
   * profile,model`) — absent when none exist. A marker is READ-only; the edit
   * control is the separate `action`.
   */
  override?: string;
  /**
   * Host-formatted age — `running 12m`, `ran 3m`, `never started`. Absent when
   * the run carries no usable instant. It answers the one question a stuck
   * node raises that no other field on the row can: whether this row is new or
   * stale. Formatted host-side against the projection's injected clock, so
   * every row of one pass reads against the SAME now.
   */
  age?: string;
  outcome?: string;
  reason?: string;
  /** The node row's single control (open/discard/edit-override), if any. */
  action?: TypedInsideAction;
}

/** One process inside one inside stage. A snapshot, no functions. */
export interface InsideProcessView {
  id: string;
  kind: string;
  label: string;
  status: InsideStatus;
  /**
   * Visible status copy — "Completed", "Running" — so the status colour/glyph
   * is never the only carrier. Derived host-side from the SAME status reading
   * the row carries; the webview renders it verbatim and never re-derives it
   * from the glyph. Absent → the webview falls back to its closed status→word
   * map ("running", "passed"…), a static control-copy word for the same
   * status key — never a fabricated BUSINESS fact. The absence semantics stay
   * "no host-authored copy", which is what a process that has not adopted the
   * contract yet reads as.
   */
  statusLabel?: string;
  /**
   * Host-formatted, non-interactive facts shown below the expanded process —
   * the recorded session id, switch count, token split, and the rule copy.
   * Every item is a finished string; the webview renders and concatenates
   * nothing. Absent → no footer strip at all.
   */
  footer?: readonly string[];
  detail?: string;
  /**
   * The kind-specific aggregate copy for the process row — "4 passed · 1
   * failed", "2 blocking", "3 commits". Computed host-side by the reducer
   * from the SAME counts the evidence carries; the webview renders it
   * verbatim and concatenates nothing (UI-R31). Absent → no aggregate.
   */
  aggregate?: string;
  /**
   * The raw stored status key `aggregate` was worded from — e.g. the graph
   * run's `completed-awaiting-impl-marker` — rendered ONLY as the aggregate
   * chip's `title` tooltip, never as visible copy. Absent → the chip carries
   * no tooltip. This is the verdict fact `aggregate` already states in
   * English; keeping the raw key alongside it (title-only) is what lets a
   * reader who needs the literal stored value find it without the webview
   * ever parsing or prettifying a status string itself.
   */
  aggregateTitle?: string;
  /** A bare count, for a process whose identity IS a number (scope's hot set). */
  count?: string;
  duration?: string;
  /**
   * When this process STARTED, as a clock time in the reader's locale —
   * `formatTime` of the same recorded timestamp `duration` is measured from.
   * A process whose start karst never recorded (Services, which runs nothing)
   * carries none; absence is stated by omission, never by a placeholder.
   */
  time?: string;
  /** The exact form of `duration`. Rendered only as the duration's `title`. */
  durationExact?: string;
  /** The execution karst actually ran, when it ran one. */
  execution?: AgentExecutionView;
  /** What the settings said WOULD run, for a process that has not run. */
  configuredExecution?: AgentExecutionView;
  /**
   * The §11 absence copy for a process that RAN without a recorded identity
   * ("No historical execution identity recorded") — shown in the identity
   * chip's place, never an invented identity. Absent → the chip renders
   * whatever identity exists or nothing.
   */
  identityNote?: string;
  tokens?: TokenUsageView;
  evidence?: ProcessEvidenceView;
  action?: TypedInsideAction;
  /**
   * Whether this process offers the terminal console view (a gate-lane AI
   * process — the UAT Tester or the Review findings lane — that has a recorded
   * run, and therefore a persisted output tail). Host-derived: the webview
   * renders the console button ONLY from this flag and never guesses
   * availability (UI-R31). Absent → no console entry.
   */
  console?: boolean;
}

/**
 * The stage's CURRENT operation as the header states it.
 *
 * Declared here rather than imported from `./progress.js` because `progress.ts`
 * already imports this module — the reverse import would close a cycle. It is
 * structurally identical to `LiveOperationView` on purpose: the header renders
 * the ephemeral progress event and this snapshot-derived fallback through one
 * code path, so a reopened panel is never blank while a stage is working.
 *
 * Every field is derived from a process row already on screen. This states
 * nothing the ledger below it does not.
 */
export interface InsideLiveView {
  status: 'run' | 'wait' | 'fail';
  label?: string;
  detail?: string;
  duration?: string;
}

/**
 * The full presentation model for ONE inside stage: the flat operation rows of
 * the retired legacy strip become ordered processes, each carrying its own
 * evidence and controls.
 */
export interface InsideStageView {
  stageKey: InsideStageKey;
  /** Display title — `Implementation`, `UAT`. */
  title: string;
  dot: InsideDot;
  /** `12:23:06 · 51.7s · attempt 1`, or `has not run yet`. */
  clock: string;
  /**
   * The current operation, derived from this stage's own processes. Absent when
   * no process is running or waiting — a settled stage has no live line.
   */
  live?: InsideLiveView;
  /** Ordered processes. EMPTY means nothing ran — the view shows `blurb` instead. */
  processes: InsideProcessView[];
  /** The static "what happens here" copy. Always present. */
  blurb: string;
  /**
   * Whether this stage offers the terminal console view: a gate stage whose
   * stage row recorded an artifact log. Host-derived — the webview renders
   * the Console button ONLY from this flag and never guesses availability.
   */
  console?: boolean;
  /**
   * The round switcher's tabs for a gate stage (Option B, T1's
   * `listGateAttempts`) — oldest to newest, bounded to `ATTEMPT_TABS_LIMIT`.
   * Absent, or fewer than 2 entries, for a non-gate stage or a gate stage that
   * never looped: the control costs nothing on a ticket with a single
   * attempt. `state.ts` (T4) populates this; this module only declares the
   * shape.
   */
  attempts?: readonly GateAttemptView[];
  /**
   * The attempt currently backing this stage's processes — the key
   * `QualityProcessesInput.selectedAttempt` was resolved to, so the webview
   * can mark the matching tab `aria-selected`. Absent when the stage carries
   * no `attempts` (nothing to select among).
   */
  selectedAttempt?: AttemptKey;
  /**
   * Host-authored banner copy shown above the ledger when the selection is
   * NOT the latest attempt — e.g. "viewing round 2 — not the current result".
   * The webview renders it verbatim (UI-R31) and never derives it from
   * `selectedAttempt` itself. Absent → no banner.
   */
  attemptNote?: string;
}

/**
 * The PR facts the ship strip reads — a structural subset of `PrView`, so the
 * strip states only what it renders and a caller with a partial row (a test, an
 * older snapshot) still type-checks. The v16 metadata is optional for exactly
 * that reason: absent is a state the strip must handle anyway.
 */
export interface ShipPrView {
  /** The prs rowid — the host-owned id the `open-pr` action reloads by. */
  id?: number;
  /** The repository path — identity. */
  repo: string;
  /** The repository as displayed (path-display preference). Falls back to `repo`. */
  repoDisplay?: string;
  number: number | null;
  /** `open` | `merged` | `closed` | … as `prs.status` holds it, when known. */
  status?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  mergedAt?: string | null;
}
