import type { ServerView, WorktreeView } from '../../store/dashboard.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { StepperCell } from '../../model/stepper.js';
import type { ShipSlot } from '../../model/shipSlot.js';
import type { AgentDefaults } from '../../agent/agentPresets.js';
import type { StageRail } from '../../model/stageRail.js';
import type { MergeCheckPanelRow } from '../../model/mergeCheckPanel.js';
import type { PrPanelRow } from '../../model/prPanelView.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { AgentSessionView } from '../../agent/sessionSwitch.js';
import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';
import type { ArtifactSummary } from '../../model/artifacts.js';
import type { TicketEnvOverrides } from '../../store/ticketEnvOverrides.js';
import type { SendBackState } from '../../workflow/sendBack.js';
import type { RetryGateState } from '../../workflow/retryGate.js';
import type { PrFeedbackFixState } from '../../workflow/prFeedbackFix.js';
import type { PathContext } from '../worktreePath.js';
import type { Glyph } from '../../model/glyph.js';
import type { SubtaskProgress } from '../../model/subtask.js';

export type { PathContext } from '../worktreePath.js';
export type { StepperCell } from '../../model/stepper.js';
export type { StageRail } from '../../model/stageRail.js';
export type { PrPanelRow } from '../../model/prPanelView.js';
export type { MergeCheckPanelRow } from '../../model/mergeCheckPanel.js';

export interface DashboardAgentContext {
  defaultModel?: string | null;
  /** Manifest default effort/variant, for the switch popover's inherit row. */
  defaultEffort?: string | null;
  modelCatalog?: ModelCatalog;
  /**
   * Resolve the effective agent defaults for a ticket's preset, so the displayed
   * session identity matches what a launch would use. Injected — the state
   * builder never reads the manifest. Absent → the legacy `defaultModel` /
   * `defaultEffort` above, which is exactly the pre-preset behavior.
   */
  defaultsFor?: (ticketPreset: string | null, ticketProvider: AgentProvider | null) => AgentDefaults;
}

/**
 * A worktree row for the scope card, plus what its base-branch control needs
 * (§ per-repo base branch — live change): the manifest's resolved default (so
 * the row can mark an override, same "changed" affordance the ticket-form
 * picker uses) and the candidate branches for its combobox — the SAME shape
 * Task 8's `RepoBaseRow.candidates` carries, so the two surfaces read as one
 * idea. Candidates are loaded lazily host-side and empty until warmed; the
 * input stays free text either way.
 */
export interface DashboardWorktreeView extends WorktreeView {
  /** The manifest's resolved default branch for this repo (never the override). */
  baseDefault: string;
  /** Local heads + `origin/*`, loaded lazily. Never a closed vocabulary. */
  baseCandidates: string[];
  /** The manifest repository name for this repo's path (host-resolved). */
  serviceName: string | undefined;
}

/** One direct sub-task, as the parent dashboard's "Sub-tasks" section renders it. */
export interface DashboardSubtaskRow {
  /** Ticket id — the row's identity and what an "open" would target. */
  id: number;
  /** The sub-task key (`<parentKey>-s<n>`), always present for a created row. */
  key: string;
  title: string | null;
  /** The stored current stage key, or null before the sub-task is scoped. */
  stage: string | null;
  /** Status glyph for the row's dot — the same `model/glyph` the sidebar paints with. */
  glyph: Glyph;
  /** `stg-<stage>` colour class (model/stagePalette); falls back to `stg-unknown`. */
  stageClass: string;
  /** True when this sub-task holds the parent before it leaves impl/fix. */
  blocking: boolean;
  /** True once the sub-task reaches the terminal `done` stage. */
  done: boolean;
}

/** Fully serializable dashboard state pushed to the webview via postMessage. */
export interface DashboardState {
  ticketId: number;
  key: string | null;
  title: string | null;
  /**
   * The parent ticket's key + title, when this ticket is a follow-up; null
   * otherwise. Relationship metadata for the roomy dashboard's secondary line
   * — never part of the title (model/followUp.ts).
   */
  parent: { key: string; title: string | null } | null;
  /**
   * The parent ticket's key + title, when this ticket is a SUB-TASK; null
   * otherwise. Orthogonal to `parent` above: `parent` is the follow-up relation
   * ("continues after"), this is the composition relation ("is part of"),
   * carried on `tickets.subtask_parent_id` (design NDL-70 §3). Relationship
   * metadata, never part of the title; the dashboard words it as
   * `Sub-task of <key>` beside the follow-up line.
   */
  subtaskParent: { key: string; title: string | null } | null;
  /**
   * The ticket's direct, non-archived sub-tasks, oldest first — the "Sub-tasks"
   * section. Empty renders NO section (absence, never an empty card), unless
   * the ticket can still gain one (`canAddSubtask`), in which case the section
   * still offers the action.
   */
  subtasks: DashboardSubtaskRow[];
  /**
   * `n/m done` over `subtasks`, by their stored `stage_current` (design §8).
   * `0/0` when there are none — rendered as absence, not "0".
   */
  subtaskProgress: SubtaskProgress;
  /**
   * Whether "Add sub-task" is offered — host-derived from the same rule the
   * writer enforces (`model/subtask.ts` `canAddSubtask`): absent only while the
   * ticket ships or is done. The webview never re-derives it.
   */
  canAddSubtask: boolean;
  /**
   * Whether "Detach from parent" is offered — host-derived from the same rule
   * the detach writer enforces (`model/subtask.ts` `canDetachSubtask`): only a
   * non-blocking, not-done sub-task with no open sub-tasks of its own and no
   * live agent. The webview never re-derives it.
   */
  canDetachSubtask: boolean;
  stageCurrent: string | null;
  agentState: string | null;
  paused: boolean;
  pausedAt: string | null;
  /** Resolved running-session identity and whether an in-place switch is safe. */
  agentSession: AgentSessionView;
  stepper: StepperCell[];
  /**
   * The stepper cell the ticket currently sits on — the one the "Now" line
   * and the blocked banner (§ blocked state visible) both
   * describe. `currentStage.blocked` is set only while a gate stage (uat,
   * review) sits parked (`parkGateStage`/`clearStageBlock`,
   * `store/stageBlocks.ts`) — the webview reads it directly to show the
   * banner and pass its `stageKey` back on the Resume click. Null when the
   * ticket sits at no stage at all.
   */
  currentStage: StepperCell | null;
  /**
   * The header's ship workflow-action slot (model/shipSlot.ts) — the Now line's
   * ship branch, lifted to the header. The states are mutually exclusive.
   */
  ship: ShipSlot;
  /**
   * The agent-switch choices the header popover renders: every implemented core
   * (canonical label) and each core's model choices, keyed by provider id. The
   * webview cannot import TS, so the catalog arrives here, host-resolved.
   * `modelsByCore` is the FULL model catalog (models + their advertised
   * efforts) the shared agent identity picker renders from; `models` keeps the
   * flattened legacy shape. `recentByCore` is the models most recently used per
   * provider (newest first, ≤5) for the picker's "Last used" group. `effort`
   * is the resolved current effort/variant, and the `*InheritLabel`s name the
   * switch popover's inherit rows.
   */
  agentSwitch: {
    cores: { id: AgentProvider; label: string }[];
    models: Record<string, { model: string | null; label: string }[]>;
    modelsByCore: ModelCatalog;
    recentByCore: Record<string, string[]>;
    effort: string | null;
    modelInheritLabel: string;
    effortInheritLabel: string;
    /**
     * The manifest's default agent core — the core `modelInheritLabel` and
     * `effortInheritLabel` describe. The picker offers those inherit rows only
     * while the picked core IS this one (a Claude default is not inheritable
     * under opencode). Null when the host declares no default core.
     */
    inheritCore: AgentProvider | null;
  };
  servers: ServerView[];
  /** False when nothing in scope declares a service — nothing can ever start. */
  hasRunnableRepos: boolean;
  /**
   * The ticket's env overrides and the services they may be set for.
   *
   * `services` is the ticket's own runnable repositories, in scope order — the
   * editor offers exactly the services this ticket can start, so a scope can
   * never be typed for a repository the ticket does not have. `values` is what
   * is saved today, keyed by that name or by `*` (every service). These are
   * merged into a service's spawn env at the next spin; nothing here ever
   * touches a repository's own `.env` on disk.
   */
  envOverrides: { services: string[]; values: TicketEnvOverrides };
  worktrees: DashboardWorktreeView[];
  /**
   * The pull requests, already worded: from-to branches, opened/merged stamps,
   * comments, and whether merging is offered (`model/prPanelView.ts`). Rendered
   * host-side like every other piece of dashboard copy — the webview is
   * standalone HTML and cannot import the formatter, so a webview-side format
   * would be untested and would drift from the ship strip's.
   */
  prs: PrPanelRow[];
  /**
   * Current mergeability per repo — the same verdicts the ship strip renders,
   * lifted to the top level because the PR panel is where a conflict is acted on
   * and a standalone webview cannot read the store. Fully worded here
   * (`model/mergeCheckPanel.ts`) so the panel cannot phrase a verdict of its own.
   * A repo with no row was never checked; absence renders as nothing, never as
   * clean.
   */
  mergeChecks: MergeCheckPanelRow[];
  /** Configured ticketing provider ('clickup' | 'manual'); null when unknown. */
  provider: string | null;
  /** The board ref the ticket was fetched from, or null. */
  sourceRef: string | null;
  /** External board URL for the ticket, or null (manual/unfetched → no link). */
  ticketUrl: string | null;
  /** Provider-native priority label (e.g. 'urgent'); null when not exposed. */
  priority: string | null;
  /**
   * The user's authored instruction (the `description` column) — the prompt a
   * manual ticket was created from. Previewed in the ticket-data drawer when
   * the ticket has no fetched brief (a manual ticket bound via "Create in
   * ClickUp" gets a provider ref but never a brief).
   */
  description: string | null;
  /** Synthesized context brief, shown in the header's ticket-data preview drawer; or null. */
  brief: string | null;
  /**
   * The stage graph as it is drawn: one segmented track the ticket travels
   * through, each segment carrying its own status, whether the ticket is there,
   * whether it is blocked on the user, and — on the gate that was retried — the
   * fix loop's meter. `stepper` above stays the flat canonical projection.
   */
  rail: StageRail;
  /**
   * The six-stage inside presentation (the inside redesign): one process-led
   * view per INSIDE stage, built by the pure reducers. `fix` is not a stage
   * here — it is projected onto the stage it returns to (`presentedStage`) —
   * so this map has EXACTLY six keys and never a peer `fix` entry.
   */
  insideViews: Record<InsideStageKey, InsideStageView>;
  /**
   * The inside stage presented as CURRENT. When the runtime ticket sits at
   * `fix`, this is the stage the fix is causally attached to (the source stage
   * of the active recovery round) — the six-stage model has no Fix stage to
   * present.
   */
  presentedStage: InsideStageKey;
  /**
   * The approach driving impl, the workflow phases it DECLARES, and the phases
   * the agent actually REPORTED by running a marker command.
   *
   * Declared is not observed — impl exposes no deterministic sub-signal (the
   * no-inference guarantee), so `phases` describes what the agent was asked to
   * do. `reported` is the one thing that may fill a phase pip: a phase mark is a
   * fact with a timestamp, the same class of evidence as the impl done marker,
   * and its absence stays evidence of nothing. Read through the SAME derivation
   * the Inside strip lists (`reportedPhases`) — two answers to "which phase is
   * the agent in" is the same class of bug as two answers to needs-you.
   */
  approach: { id: string; phases: string[]; reported: string[] } | null;
  /**
   * The ticket's semantic artifacts (model/artifacts.ts), in semantic-priority
   * order — the shelf's previews are `slice(0, 3)` of this array. Empty while
   * the ticket has no durable output; the webview renders NO section then
   * (spec §4.1: absence, never an empty state). The detail body rides each
   * summary, so the webview renders detail locally and never round-trips an
   * `artifact.get`.
   */
  artifacts: ArtifactSummary[];
  /**
   * The "Send back to Implement" recovery action's availability for the
   * CURRENT stage, host-derived (`workflow/sendBack.ts`) in the same snapshot
   * as the merge gate so the header and the action never disagree. The webview
   * renders the current stage header's ⋯ menu ONLY when this is available,
   * keyed to the stage whose header hosts it — scope/impl/fix/done, an
   * in-flight run, or a landed ship offer no menu at all.
   */
  sendBack: SendBackState;
  /**
   * The "Retry gate" recovery action's availability for the CURRENT stage,
   * host-derived (`workflow/retryGate.ts`) in the same snapshot as sendBack.
   * The webview renders the retry option in the stage menu when available.
   */
  rerunGate: RetryGateState;
  /**
   * The "Address pull request feedback" recovery action's availability for the
   * ship stage, host-derived (`workflow/prFeedbackFix.ts`) in the same snapshot
   * as sendBack. The webview renders the menu option when available, so the
   * host's verdict and the control never disagree.
   */
  prFeedbackFix: PrFeedbackFixState;
  /**
   * How many review items are open on this ticket's pull requests — live,
   * unresolved, not withdrawn. Carried on the snapshot (the same read the menu
   * gate uses) so the panel and the host cannot disagree about how "open" is
   * defined; the `awaiting-merge` blocker line itself stays `mergeGate.ts`'s.
   */
  openPrFeedback: number;
}
