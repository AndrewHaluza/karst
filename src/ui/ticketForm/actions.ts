import { dirname } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { TicketingProvider, ContextBrief } from '../../integrations/ticketing.js';
import { renderBrief } from '../../integrations/briefMarkdown.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { DriveProcessBundle } from '../../agent/processAssignment.js';
import {
  getTicket,
  updateTicketCore,
  updateTicketFields,
  generateTicketKey,
} from '../../store/tickets.js';
import {
  getTicketSourceRef,
  ingestBriefRelations,
  listPendingWritebacks,
  listOpenBlockers,
  markWriteback,
  resolveDanglingRefs,
  unresolveStaleRelations,
  type TicketRelation,
  list as listRelationViews,
} from '../../store/ticketRelations.js';
import { queueAutostart } from '../../store/autostart.js';
import {
  recordUsageLimitOpPark,
  claimUsageLimitPark,
  listParks,
  type UsageLimitParkRow,
} from '../../store/usageLimitParks.js';
import { postMessage } from '../../store/ticketMessages.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { resolvePlannedBaseRef, subtaskParentBranch, assertSharedRepoBaseOverrides } from '../../workflow/baseRef.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import { scoreRepos } from '../../workflow/classify/gate.js';
import { suggestSignals as suggestSignalsAI } from '../../workflow/classify/suggest.js';
import type { AnalyzeServiceInput } from '../../workflow/classify/analyze.js';
import { runAnalysis, type RunAnalysisResult } from '../../workflow/classify/runAnalysis.js';
import { codePointersEnabled } from '../../manifest/validate/analysis.js';
import type { TicketFormActions, TicketDraftFields } from './messages.js';
import type { TicketFormActionsCtx, TicketFormActionsFactory } from './panel.js';
import {
  ingestFile,
  ingestBytes,
  attachmentExists,
  validateAttachment,
  type IngestResult,
} from '../../attachments/ingest.js';
import {
  discardStagedAttachment,
  restoreStagedAttachment,
  stageAttachmentRemoval,
  unlinkAttachment,
  type StagedAttachmentRemoval,
} from '../../attachments/reap.js';
import { attachmentPath } from '../../attachments/paths.js';
import { spillField } from '../../attachments/spill.js';
import {
  abortAttachmentWrite,
  attachmentWriteState,
  beginAttachmentWrite,
  finalizeAttachmentDetach,
  finalizeAttachmentWrite,
  getAttachment,
  prepareAttachmentDetach,
  releaseAttachmentDetach,
  releaseAttachmentOperation,
} from '../../store/attachments.js';

/**
 * Host-side ticket-form logic (§ ticket form), independent of `vscode`. It ties
 * the ticketing provider, agent adapter, signal writeback, and ticket store into
 * the actions the webview drives. Kept out of the panel manager so it is unit-
 * testable with fakes; the activation layer supplies the real deps.
 *
 * Persistence rule: in EDIT mode (ticket exists) fetch/approach/repos write
 * straight through; in CREATE mode the webview holds the draft until `submit`,
 * which creates the ticket. Signal writeback targets the manifest, not a ticket,
 * so it works in both modes.
 */

/**
 * Outcome of the finish handoff. A failure is a REASON, not a throw, so the
 * ticket form can show it inline and stay open for a retry (e.g. no repos
 * selected) instead of the user staring at a page that did nothing.
 */
export type StartTicketResult = { ok: true } | { ok: false; message: string };

/** D159: a one-shot agent/model override for a parked-op re-run (never persisted). */
export type AnalysisOverride = { provider: AgentProvider; model: string | null };

/** Per-launch choices the ticket form makes for a start it is triggering. */
export interface StartTicketOptions {
  /**
   * Refresh each scoped repository's baseline branch from the remote before its
   * worktree is cut (§ pull switch). The page's switch is ON by default; this
   * carries what the user actually left it on, not the default.
   */
  pullBase: boolean;
  /**
   * Suppress the host's own error popup on failure. Set by the sub-task
   * autostart op, which owns the single user-facing warning (naming the key).
   */
  quiet?: boolean;
}

export interface TicketFormActionsDeps {
  store: Store;
  manifest: Manifest;
  manifestPath: string;
  /**
   * The window's project (§ projects / multi-window). Stamped on every ticket
   * created here, so it lands on the board of the window that created it and
   * nowhere else. Undefined only when no project could be bound (no folder).
   */
  projectId?: number;
  provider: TicketingProvider;
  adapter: AgentAdapter;
  /**
   * The ticket form's two-pass analysis process (the `ticket-analysis` role of
   * the `processes:` block): the identity snapshot its `prefill` run opens with
   * AND the already-instrumented adapter the two headless calls run through.
   * Resolved at analyze time, after the draft is bound, so the ticket's own
   * provider/model picks participate as overrides — the same seam every other
   * inside process resolves through (extension.ts's `processFor`). The profile
   * body drives the description-improve pass; the classify pass is always the
   * built-in analyzer. NULL is configured ABSENCE (`enabled: false`): the
   * analyzer refuses rather than running on a guessed default. The plain
   * `adapter` above stays the panel-wide default for the signal-word suggestion.
   */
  resolveAnalysisProcess: (
    ticketId: number,
    /**
     * D159: a ONE-SHOT agent/model override for a usage-limit op re-run. Absent
     * → the configured ticket-analysis identity; a pick threads the chosen
     * core/model through and NOTHING is persisted to the ticket or Settings.
     */
    override?: { provider: AgentProvider; model: string | null },
  ) => DriveProcessBundle | null;
  /**
   * D159: show the two-step core → model picker for a parked op re-run, tagging
   * the parked pair. Absent → the "Pick agent/model…" action is unavailable
   * (only "Retry same" and "Dismiss" are offered).
   */
  pickUsageLimitAgentModel?: (
    parkedProvider: string,
    parkedModel: string | null,
  ) => Promise<{ provider: AgentProvider; model: string | null } | undefined>;
  /** Notify the host to refresh sidebar/dashboard after a create/edit. */
  onChange: () => void;
  confirmBlockedStart?: (message: string) => Promise<boolean>;
  /**
   * Kick off a just-finished ticket: create worktrees for its selected repos,
   * arm the scope stage, and open the agent session seeded with its chosen
   * approach. Injected because it needs git + a terminal (vscode). Resolves only
   * once the ticket is actually running, so `submit` knows when to hand the user
   * off to the dashboard.
   */
  startTicket: (
    ticketId: number,
    opts: StartTicketOptions,
  ) => StartTicketResult | Promise<StartTicketResult>;
  /**
   * Reveal the ticket's dashboard — the surface that owns a ticket once it is
   * running. Injected (real: the `karst.openDashboard` command).
   */
  openDashboard: (ticketId: number) => void;
  openDependency?: (ticketId: number) => void;
  /**
   * Run the sub-task autostart sweep now (plan §A). A sub-task submitted at
   * `scope` is QUEUED rather than started so it obeys the concurrency caps;
   * this asks the owner window's sweep to pick it up without waiting a tick.
   */
  requestSubtaskAutostart?: () => void;
  /** Injected manifest signal writer (real: writeServiceSignals). */
  writeSignals: (path: string, service: string, signals: string[]) => void;
  /**
   * Re-read the manifest from disk into the host's in-memory copy. Called after
   * a signal writeback so the panel's `manifest()` getter (and thus the next
   * `pushState`) reflects the just-saved signals — otherwise the gate would
   * still show the service as unclassified.
   */
  reloadManifest: () => void;
  /** Non-fatal warnings (e.g. spill failures) surfaced to the output channel. */
  warn?: (msg: string) => void;
  /**
   * List installed approach ids (real: bound to `listInstalled(approachesDir)`).
   * Gates SOURCED approaches (git/npm) to those installed on disk; built-in
   * (sourceless) approaches are always available. Install lives in settings.
   */
  listInstalledIds: () => string[];
  /** Open a URL in the external browser (vscode.env.openExternal). */
  openUrl?: (url: string) => void | Promise<void>;
  /**
   * Global-storage root that attachment bytes are written under. Injected rather
   * than derived so this module stays free of `vscode` and testable against a
   * tmpdir.
   */
  storageDir: string;
  /**
   * Show the native file picker and resolve the chosen absolute paths (empty on
   * cancel). Injected because it needs `vscode.window.showOpenDialog`. The HOST
   * owns the dialog: the webview only asks for one, so a crafted message can
   * neither choose a path nor pre-fill one.
   */
  pickAttachment: () => Promise<string[]>;
  /** Reveal a file in the editor (real: `vscode.env.openExternal` / `vscode.open`). */
  openFile: (path: string) => void | Promise<void>;
  /**
   * List the base-branch candidates for a repository (real: bound to
   * `listBaseBranchCandidates(defaultGitRunner, repoPath)`). Never throws
   * (the underlying lister already swallows git failures to `[]`) — a picker
   * that can't list branches still has to render.
   */
  listBaseBranches?: (repoPath: string) => Promise<string[]>;
  /**
   * Per-panel cache of already-fetched base-branch candidates, keyed by
   * `repoPath`. Owned by the host (one per open panel) and shared with the
   * state builder via `TicketFormManager`'s `branchCandidates` getter — this
   * module only WARMS it (see `setRepos`), never reads it back for state.
   */
  branchCandidatesCache?: Map<string, string[]>;
}

/** The slice of the form deps the relation write-back needs (also used by sub-task sync). */
export type WritebackDeps = Pick<TicketFormActionsDeps, 'store' | 'provider'>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a provider error means the dependency edge already exists. */
function isAlreadyExistsError(message: string): boolean {
  return /already\s+(exists|added|been)/i.test(message);
}

/**
 * Attempt ONE pending write-back: record that the OWNER ticket is blocked by
 * the TARGET ticket on the provider. Idempotent — if the owner's own brief
 * already carries the edge it is marked done without a POST, and a provider
 * that answers "already exists" is done too. Any other failure is recorded as
 * `failed` with the reason; the row is retried on the next bind.
 */
async function writeBackRelation(
  deps: WritebackDeps,
  relation: TicketRelation,
): Promise<void> {
  if (!deps.provider.addDependency) return;
  const ownerRef = getTicketSourceRef(deps.store, relation.ticketId);
  const targetRef =
    relation.targetTicketId === null
      ? null
      : getTicketSourceRef(deps.store, relation.targetTicketId);
  if (ownerRef === null || targetRef === null) return;

  // Idempotency: a brief we already hold that names the edge means there is
  // nothing to write. A brief we cannot read must not block the POST.
  if (deps.provider.fetchTicket) {
    try {
      const brief = await deps.provider.fetchTicket(ownerRef);
      if ((brief.relations ?? []).some((r) => r.kind === 'blocked-by' && r.ref === targetRef)) {
        markWriteback(deps.store, relation.id, 'done');
        return;
      }
    } catch {
      // fall through to the write
    }
  }

  try {
    await deps.provider.addDependency(ownerRef, targetRef);
    markWriteback(deps.store, relation.id, 'done');
  } catch (e) {
    const message = errorMessage(e);
    if (isAlreadyExistsError(message)) {
      markWriteback(deps.store, relation.id, 'done');
    } else {
      markWriteback(deps.store, relation.id, 'failed', message);
    }
  }
}

/**
 * The action-level hook that runs when a ticket's provider `source_ref` is
 * bound (a create-bind or a fetch-bind). It re-resolves refs that pointed at
 * this ticket before it was imported, then attempts every pending agent/user
 * blocked-by write-back involving it. Deliberately NOT in the store layer and
 * NOT on `updateTicketFields`: the store stays pure, and a ref CLEAR must not
 * fire network work. A ticket with no ref is a no-op.
 */
export async function onSourceRefBound(
  deps: WritebackDeps,
  ticketId: number,
): Promise<void> {
  if (getTicketSourceRef(deps.store, ticketId) === null) return;
  resolveDanglingRefs(deps.store, ticketId);
  for (const relation of listPendingWritebacks(deps.store, ticketId)) {
    await writeBackRelation(deps, relation);
  }
}

/**
 * Mint the provider task for a persisted ticket and bind it as `sourceRef` —
 * the shared heart of the create-mode checkbox AND the edit-mode button.
 *
 * The Karst ticket is the unit that must never be lost: callers persist it
 * FIRST, then invoke this, so a provider failure leaves the ticket intact and
 * the control retryable. No double-creation: a ticket that already carries a
 * `sourceRef` is a no-op (the webview hides the control on a bound ticket;
 * this is the host-side guard for a stale or crafted page).
 */
async function bindProviderTask(
  ctx: TicketFormActionsCtx,
  deps: TicketFormActionsDeps,
  ticketId: number,
): Promise<boolean> {
  if (!deps.provider.createTicket) {
    ctx.post({
      type: 'provider-ticket-error',
      message: 'This provider cannot create tickets.',
    });
    return false;
  }
  const ticket = getTicket(deps.store, ticketId);
  if ((ticket.sourceRef ?? '').trim()) return true; // already bound — never re-create
  ctx.post({ type: 'busy', what: 'provider-ticket', on: true });
  try {
    const created = await deps.provider.createTicket({
      title: ticket.title ?? '',
      description: ticket.description ?? undefined,
    });
    updateTicketFields(deps.store, ticketId, {
      sourceRef: created.ref,
      // The created task's internal id, when `created.ref` is a custom id, so a
      // dependency ref (reported by internal id) resolves to this ticket.
      sourceRefInternal: created.internalRef ?? '',
    });
    // The new ref can resolve relations that pointed at this ticket before it
    // was imported, and can complete pending write-backs. Only for a non-empty
    // ref (onSourceRefBound is a no-op otherwise, but skip the round trip).
    if (created.ref.trim() !== '') await onSourceRefBound(deps, ticketId);
    deps.onChange(); // sidebar/dashboard refresh so the bound link appears
    ctx.post({ type: 'provider-ticket-created', ref: created.ref, url: created.url ?? null });
    return true;
  } catch (e) {
    ctx.post({ type: 'provider-ticket-error', message: errorMessage(e) });
    return false;
  } finally {
    ctx.post({ type: 'busy', what: 'provider-ticket', on: false });
  }
}

/** Repositories whose signal words hit the brief (score > 0), classifier order. */
function scoredRepos(manifest: Manifest, brief: ContextBrief): string[] {
  return scoreRepos(manifest, {
    title: brief.title,
    description: brief.description,
    tags: brief.tags,
  })
    .filter((r) => r.score > 0)
    .map((r) => r.repo);
}

/**
 * Create-or-update the ticket from the ticket form's draft fields, and persist the
 * repo/approach/agent/model selection — the part `submit` and `save` share.
 * Binds a create-mode panel to the new ticket. Does NOT touch startTicket;
 * callers decide whether a run follows.
 */
function persistDraft(
  ctx: TicketFormActionsCtx,
  deps: TicketFormActionsDeps,
  input: TicketDraftFields,
): number {
  // Validate BEFORE any write. `setBaseRef` runs this same assert on every
  // interactive change, but a rejection there leaves the stale text sitting in
  // the webview's input — `collectBaseRefs()` re-sends it on Submit/Save
  // regardless. Without this check here, an override `setBaseRef` already
  // refused would land in the store anyway, and spin (which dedups by
  // repoPath) would cut the shared worktree from whichever manifest entry it
  // iterates first — exactly the invariant the assert exists to protect.
  // Runs first, before `key`/`updateTicketCore`/etc., so a rejection leaves
  // an existing (edit-mode) ticket completely untouched rather than partially
  // overwritten, and creates nothing in create mode.
  assertSharedRepoBaseOverrides(deps.manifest, input.baseRefs ?? {});
  // The key is optional on the webview's manual-entry path (§ manual ticket
  // creation): a blank key means "derive one from the title now" (the webview
  // previews the same derivation while you type, so this is normally a no-op
  // agreement rather than a surprise). Resolved once, here, so create and edit
  // share the exact same key whether it's persisted via createTicketFlow or
  // updateTicketCore below — never generated twice, never lost between the two
  // branches.
  // A blank key, or a key the webview auto-derived from the title (not user
  // owned), is resolved here so the store's collision logic (`-2`, `-3`…)
  // actually runs. A user-typed/pasted key is kept verbatim.
  const key = input.keyAutoDerived || !input.key
    ? generateTicketKey(deps.store, { projectId: deps.projectId }, input.title)
    : input.key;
  let ticketId: number;
  if (ctx.ticketId !== undefined) {
    updateTicketCore(deps.store, ctx.ticketId, { key, title: input.title });
    if (input.description) {
      updateTicketFields(deps.store, ctx.ticketId, { description: input.description });
    }
    ticketId = ctx.ticketId;
  } else {
    const t = createTicketFlow(deps.store, {
      key,
      title: input.title,
      description: input.description || undefined,
      projectId: deps.projectId,
    });
    ctx.bindTicket(t.id);
    ticketId = t.id;
  }
  // Finishing the ticket form (submit) or saving a draft (save) is the only chance
  // to record repo/approach/agent/model in pure create mode — the ticket
  // didn't exist before now, so setRepos/setApproach/setAgent never ran.
  updateTicketFields(deps.store, ticketId, {
    selectedRepos: input.repos,
    ...(input.approach !== null ? { approach: input.approach } : {}),
    ...(input.agent !== null ? { agent: input.agent } : {}),
    // null = "Inherit"; persist '' so the store clears any prior pick to NULL.
    model: input.model ?? '',
    effort: input.effort ?? '',
    agentProvider: input.agentProvider ?? '',
    agentPreset: input.agentPreset ?? '',
    type: input.ticketType ?? '',
    baseRefs: input.baseRefs ?? {},
    // Absent = untouched: a plain save/submit never rewrites analysis output.
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.codePointers !== undefined ? { codePointers: input.codePointers } : {}),
  });
  // The user's explicit Save/Submit is the ONLY commit of a prefilled page; a
  // fetch/attach that bound an earlier draft must not have accepted it (see
  // `commitPrefill`). Fires the prefill's `onCreated` exactly once.
  ctx.commitPrefill();
  deps.onChange();
  return ticketId;
}

/** The start refusal for a ticket with no selected repositories (shared with the host's start path). */
export const NO_REPOS_MESSAGE = 'Select at least one repository to start this ticket.';

/**
 * Submit of a sub-task still at `scope`: queue it for the autostart sweep
 * instead of starting it here, so dashboard-created sub-tasks obey the same
 * caps as CLI ones. The autostart op starts with `pullBase: false` (the child
 * cuts from its parent's branch, not a fresh remote base), so the page's pull
 * switch is deliberately not carried. Runs the direct path's repo guard first.
 *
 * Returns `'not-subtask'` for the direct start path (ordinary tickets, and
 * sub-tasks already past scope — submit as the edit surface), or the error to
 * show on the form, or `'queued'`. A sub-task already queued or starting is
 * left as is (never re-queued, never touched while starting).
 */
function queueSubtaskInsteadOfStart(
  deps: TicketFormActionsDeps,
  ticketId: number,
): 'not-subtask' | 'queued' | { error: string } {
  const t = getTicket(deps.store, ticketId);
  if (t.subtaskParentId === null || t.stageCurrent !== 'scope') return 'not-subtask';
  if (t.selectedRepos.length === 0) return { error: NO_REPOS_MESSAGE };
  try {
    queueAutostart(deps.store, ticketId);
    deps.requestSubtaskAutostart?.();
  } catch (e) {
    return { error: `Could not queue the sub-task to start: ${errorMessage(e)}` };
  }
  return 'queued';
}

export function buildTicketFormActions(
  deps: TicketFormActionsDeps,
): TicketFormActionsFactory {
  return (ctx: TicketFormActionsCtx): TicketFormActions => {
    /**
     * Ensure this panel is bound to a persisted ticket, minting a draft if it is
     * not. There is no attachment without a `ticket_id` — the directory is named
     * by one. Reuses the exact persist-on-bind path `fetchSource` already walks,
     * rather than inventing a staging area that would need its own move-on-submit
     * lifecycle to get wrong.
     */
    const ensureTicket = (): number => {
      if (ctx.ticketId !== undefined) return ctx.ticketId;
      const draft = createTicketFlow(deps.store, {
        key: '',
        title: 'Untitled ticket',
        projectId: deps.projectId,
      });
      ctx.bindTicket(draft.id);
      deps.onChange(); // sidebar shows the new draft
      return draft.id;
    };

    /**
     * File the ingest result. A dedupe hit returns the EXISTING row rather than
     * inserting a second one: identical bytes are one file, and a duplicate row
     * would put two tiles over it — the second detach then unlinking the file the
     * first still points at.
     */
    const record = async (
      ticketId: number,
      result: IngestResult,
      republish: (expectedStoredName: string) => Promise<IngestResult>,
    ): Promise<boolean> => {
      if (!result.ok) {
        ctx.post({ type: 'error', message: result.message });
        return false;
      }
      const deadline = Date.now() + 30_000;
      for (;;) {
        let attempt = beginAttachmentWrite(deps.store, result.input);
        while (attempt?.kind === 'busy' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          attempt = beginAttachmentWrite(deps.store, result.input);
        }
        if (attempt?.kind === 'busy') {
          throw new Error('Timed out waiting for another window to finish attaching this file.');
        }
        if (!attempt) {
          // The conditional insert proves the parent is gone, so no row can
          // still reference these just-published bytes.
          await unlinkAttachment(deps.storageDir, ticketId, result.input.storedName);
          ctx.post({
            type: 'error',
            message: 'This ticket was deleted before the attachment could be saved.',
          });
          return false;
        }
        const claim = attempt;
        let rolledBack = false;
        const rollback = async (): Promise<void> => {
          if (rolledBack) return;
          // Keep the attach token while removing bytes for a row this operation
          // inserted. A waiting writer cannot claim/check the path until the DB
          // row is then deleted, so it cannot miss this cleanup race.
          if (claim.inserted) {
            await unlinkAttachment(deps.storageDir, ticketId, result.input.storedName);
          }
          abortAttachmentWrite(deps.store, claim);
          rolledBack = true;
        };

        try {
          // If this attach arrived during a detach, wait for that operation to
          // acknowledge cancellation (or finish deletion) before checking the
          // destination. The separate detach token is the handshake that closes
          // the check-then-rename race across two extension-host processes.
          let state = attachmentWriteState(deps.store, claim.row.id, claim.token);
          while (state === 'waiting-for-detach' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            state = attachmentWriteState(deps.store, claim.row.id, claim.token);
          }
          if (state === 'waiting-for-detach') {
            throw new Error('Timed out waiting for another window to finish detaching the attachment.');
          }
          if (state === 'superseded') continue;
          if (state === 'missing') {
            await unlinkAttachment(deps.storageDir, ticketId, result.input.storedName);
            ctx.post({
              type: 'error',
              message: 'This ticket was deleted before the attachment could be saved.',
            });
            return false;
          }

          // A detach can move the destination aside after ingest publishes but
          // before SQLite records this attach. Holding the attach token blocks a
          // newer detach while this post-claim check repairs that narrow window.
          if (!await attachmentExists(
            deps.storageDir,
            ticketId,
            result.input.storedName,
          )) {
            const retry = await republish(result.input.storedName);
            if (!retry.ok || retry.input.storedName !== result.input.storedName) {
              await rollback();
              ctx.post({
                type: 'error',
                message: retry.ok
                  ? `${result.input.originalName} changed before it could be saved`
                  : retry.message,
              });
              return false;
            }
          }

          const finalized = finalizeAttachmentWrite(deps.store, claim.row.id, claim.token);
          if (finalized === 'superseded') continue;
          if (finalized === 'missing') {
            await unlinkAttachment(deps.storageDir, ticketId, result.input.storedName);
            ctx.post({
              type: 'error',
              message: 'This ticket was deleted before the attachment could be saved.',
            });
            return false;
          }
          return true;
        } catch (error) {
          await rollback();
          throw error;
        } finally {
          releaseAttachmentOperation(deps.store, claim.row.id, claim.token);
        }
      }
    };

    // One persistence path for the approach, shared by the user's picker pick
    // and the analyzer's gated auto-apply (design, Selection and Enablement).
    const setApproach = (id: string): void => {
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { approach: id });
      }
    };

    // D159: the ONE-SHOT agent/model override a usage-limit op re-run applies to
    // the next analyze, consumed at the top of `analyze` (never persisted).
    let analysisOverride: AnalysisOverride | undefined;
    /**
     * The prompt the last analysis actually ran on. A create-mode panel holds
     * the typed prompt in the webview until submit, and the draft `ensureTicket`
     * binds carries no brief or description — so re-running the parked analysis
     * with an empty prompt would silently no-op AFTER the park was claimed. Keep
     * the input so the re-run repeats the analysis that parked.
     */
    let lastAnalysisPrompt = '';
    /** The open op park for this ticket's panel, if any. */
    const findUsageLimitPark = (parkId: number) => {
      if (ctx.ticketId === undefined) return undefined;
      return listParks(deps.store, ctx.ticketId).find(
        (p) => p.id === parkId && p.resolvedAt === null,
      );
    };

    /**
     * The park this form may action: an OP park whose lane names an op it can
     * re-run. A stage-block park belongs to the dashboard, which re-runs the
     * PARKED STAGE with a stage assignment — claiming it here would consume it,
     * clear the stage block, and run the analysis instead of the parked lane.
     */
    const findRerunnableOpPark = (parkId: number) => {
      const park = findUsageLimitPark(parkId);
      if (park === undefined || park.kind !== 'op') return undefined;
      if (park.lane === 'analysis') return park;
      if (park.lane === 'suggest' && park.target !== null) return park;
      return undefined;
    };

    /**
     * D159: re-run exactly the op a park names — never a different one. The
     * call site stamped its op in `lane`; `findRerunnableOpPark` has already
     * rejected every lane this form does not own.
     */
    const rerunParkedOp = async (park: UsageLimitParkRow): Promise<void> => {
      if (park.lane === 'suggest' && park.target !== null) {
        await actions.suggestSignals(park.target);
        return;
      }
      // Reuse the prompt the parked analysis ran on: a create-mode draft has no
      // persisted brief/description, so `''` would return before the AI call.
      await actions.analyze(lastAnalysisPrompt);
    };

    const actions: TicketFormActions = {
    attachPick: async (): Promise<void> => {
      try {
        const paths = await deps.pickAttachment();
        if (paths.length === 0) return; // cancelled — not an error, say nothing
        const ticketId = ensureTicket();
        let changed = false;
        for (const path of paths) {
          // Sequential, not Promise.all: each ingest hashes and copies, and a
          // multi-select of large videos should not run N copies at once.
          if (await record(
            ticketId,
            await ingestFile(deps.storageDir, ticketId, path),
            (expected) => ingestFile(deps.storageDir, ticketId, path, expected),
          )) {
            changed = true;
          }
        }
        if (changed) ctx.pushState();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    attachBytes: async (name: string, base64: string): Promise<void> => {
      try {
        // Buffer.from silently DROPS invalid base64 characters rather than
        // throwing, so a corrupt payload would otherwise be written as a
        // truncated file that renders as a broken tile. Re-encoding and comparing
        // is the check: a payload that does not round-trip was not valid base64.
        // Validate BEFORE ensureTicket: rejected bytes are not a real attach and
        // must not persist or bind an otherwise-empty create panel.
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.toString('base64') !== base64) {
          ctx.post({ type: 'error', message: `${name} could not be decoded` });
          return;
        }
        const validation = validateAttachment(name, bytes.byteLength);
        if (!validation.ok) {
          ctx.post({ type: 'error', message: validation.message });
          return;
        }
        const ticketId = ensureTicket();
        if (await record(
          ticketId,
          await ingestBytes(deps.storageDir, ticketId, name, bytes),
          () => ingestBytes(deps.storageDir, ticketId, name, bytes),
        )) {
          ctx.pushState();
        }
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    detachAttachment: async (id: number): Promise<void> => {
      try {
        // Scoped to THIS panel's ticket. The id crosses an untrusted boundary, so
        // an id belonging to another ticket must not let this panel unlink that
        // ticket's file.
        if (ctx.ticketId === undefined) return;
        const decision = prepareAttachmentDetach(deps.store, id, ctx.ticketId);
        if (!decision) return;
        const { row } = decision;
        if (!decision.needsUnlink) {
          ctx.pushState();
          return;
        }
        // Keep a DB-visible detach claim across the async filesystem operation.
        // Moving aside first makes a failed unlink reversible; final row delete
        // is conditional on this detach still owning the token, so a concurrent
        // same-content attach cancels it rather than losing its publication.
        let staged: StagedAttachmentRemoval | null = null;
        try {
          staged = await stageAttachmentRemoval(
            deps.storageDir,
            row.ticketId,
            row.storedName,
            decision.token,
          );
        } catch (error) {
          releaseAttachmentDetach(deps.store, row.id, decision.token);
          throw error;
        }
        try {
          await discardStagedAttachment(staged);
        } catch (error) {
          // Keep waiters/new detaches behind the handshake until rollback has
          // restored the destination (without replacing a newer publication).
          // If restoration itself fails, retain the token rather than exposing
          // a live row whose destination is still absent.
          await restoreStagedAttachment(staged);
          releaseAttachmentDetach(deps.store, row.id, decision.token);
          throw error;
        }
        // From here the published bytes are gone. If SQLite finalization throws,
        // deliberately retain detach_token: the row is durable retry metadata,
        // and prepareAttachmentDetach resumes that token on the next click.
        finalizeAttachmentDetach(deps.store, row.id, decision.token);
        ctx.pushState();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    openAttachment: async (id: number): Promise<void> => {
      try {
        const row = getAttachment(deps.store, id);
        if (!row || row.ticketId !== ctx.ticketId) return;
        await deps.openFile(attachmentPath(deps.storageDir, row.ticketId, row.storedName));
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    async fetchSource(ref: string): Promise<void> {
      if (!deps.provider.fetchTicket) {
        ctx.post({ type: 'error', message: 'This provider cannot fetch tickets.' });
        return;
      }
      ctx.post({ type: 'busy', what: 'fetch', on: true });
      try {
        const brief = await deps.provider.fetchTicket(ref);
        const repos = scoredRepos(deps.manifest, brief);

        // Create mode: persist a draft so classification/approach/prefill can
        // run (they read from the store). Seed key from the ref and title from
        // the brief so the NOT NULL insert never fails on a title-less brief.
        // Only bind AFTER a successful create so a failure leaves no half-state.
        if (ctx.ticketId === undefined) {
          const draft = createTicketFlow(deps.store, {
            key: ref,
            title: brief.title || ref,
            description: brief.description || undefined,
            projectId: deps.projectId,
          });
          ctx.bindTicket(draft.id);
          deps.onChange(); // sidebar shows the new draft
        }

        // Now bound (either pre-existing or the just-created draft).
        // Spill oversized provider content to the attachment shelf at ingest
        // so every downstream read site sees bounded text.  `spillField`
        // writes the pointer directly; only pass fields it did NOT handle.
        const renderedBrief = renderBrief(brief);
        const briefSpilled = await spillField(
          deps.store, ctx.ticketId!, 'brief', renderedBrief, deps.storageDir,
        );
        if (briefSpilled.kind === 'failed') {
          deps.warn?.(`spill failed for brief on ticket ${ctx.ticketId}: ${briefSpilled.reason}`);
        }
        const descSpilled = brief.description
          ? await spillField(
              deps.store, ctx.ticketId!, 'description', brief.description, deps.storageDir,
            )
          : { kind: 'not-needed' as const };
        if (descSpilled.kind === 'failed') {
          deps.warn?.(`spill failed for description on ticket ${ctx.ticketId}: ${descSpilled.reason}`);
        }
        // Bind the provider's CANONICAL ref when the brief carries one, not the
        // raw input: a legacy or alias ref converges to the form relation refs
        // use, so a dangling edge can resolve on this fetch.
        const boundRef = brief.sourceRef ?? ref;
        // A ticket rebound to a DIFFERENT task no longer represents its old ref:
        // edges that resolved to it through the old ref must degrade to a
        // dangling (still blocking) ref, or the gate would read a target the
        // ticket no longer is.
        const previousRef = getTicketSourceRef(deps.store, ctx.ticketId!);
        updateTicketFields(deps.store, ctx.ticketId!, {
          sourceRef: boundRef,
          // The internal-id alias a dependency ref resolves through when
          // `boundRef` is a custom id; '' clears a stale alias on rebind.
          sourceRefInternal: brief.internalRef ?? '',
          sourceFetchedAt: new Date().toISOString(),
          ...(briefSpilled.kind === 'spilled' ? {} : { brief: renderedBrief }),
          ...(descSpilled.kind === 'spilled' ? {} : { description: brief.description }),
          selectedRepos: repos,
          // The provider-native priority label, populated from the brief. Absent
          // in the brief → '' clears it back to NULL: the fetch is the source of
          // truth, and a re-fetch of a ticket whose provider no longer reports a
          // priority must not keep a stale one.
          priority: brief.priority ?? '',
        });
        if (previousRef !== null && previousRef !== boundRef) {
          unresolveStaleRelations(deps.store, ctx.ticketId!, previousRef);
        }

        // Persist the brief's inter-ticket links, then run the source-ref-bound
        // hook: it resolves refs that now point at this ticket and completes any
        // pending write-back this bind makes eligible.
        ingestBriefRelations(deps.store, ctx.ticketId!, brief);
        if (boundRef.trim() !== '') await onSourceRefBound(deps, ctx.ticketId!);

        // Re-push edit-mode state (prefilled fields + scored repos), THEN post
        // the brief so the webview's auto suggest-approach runs against the
        // bound ticket.
        ctx.pushState();
        ctx.post({ type: 'brief', brief });
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      } finally {
        ctx.post({ type: 'busy', what: 'fetch', on: false });
      }
    },

    async searchTickets(query: string, status: string | null): Promise<void> {
      if (!deps.provider.searchTickets) {
        ctx.post({ type: 'ticket-search-error', message: 'This provider cannot search tickets.' });
        return;
      }
      try {
        const results = await deps.provider.searchTickets(
          query,
          status ? { status } : undefined,
        );
        ctx.post({ type: 'ticket-search-results', query, status, results });
      } catch (e) {
        ctx.post({ type: 'ticket-search-error', message: errorMessage(e) });
      }
    },

    async searchStatuses(): Promise<void> {
      if (!deps.provider.listStatuses) {
        ctx.post({ type: 'ticket-search-error', message: 'This provider cannot list statuses.' });
        return;
      }
      try {
        const statuses = await deps.provider.listStatuses();
        ctx.post({ type: 'ticket-search-statuses', statuses });
      } catch (e) {
        ctx.post({ type: 'ticket-search-error', message: errorMessage(e) });
      }
    },

    async suggestSignals(service: string): Promise<void> {
      // D159: consume the one-shot override (a parked-op pick/retry) FIRST, so
      // it is applied to THIS call only and cannot leak into a later user action
      // through any early return below. The signal suggestion has no process of
      // its own, so the override comes from the ticket-analysis process's
      // adapter.
      const override = analysisOverride;
      analysisOverride = undefined;
      // Signals classify a SOURCE TREE, so this works for a non-runnable
      // repository too — only `repoPath` is read.
      const repo = deps.manifest.repositories[service];
      if (!repo) {
        ctx.post({ type: 'error', message: `Unknown repository "${service}".` });
        return;
      }
      ctx.post({ type: 'busy', what: 'suggest', on: true });
      let adapter = deps.adapter;
      let model: string | undefined;
      let effort: string | undefined;
      if (override && ctx.ticketId !== undefined) {
        const process = deps.resolveAnalysisProcess(ctx.ticketId, override);
        if (process === null) {
          ctx.post({ type: 'busy', what: 'suggest', on: false });
          ctx.post({
            type: 'error',
            message: 'Ticket analysis is disabled in Settings — cannot re-run with a picked agent/model.',
          });
          return;
        }
        adapter = process.adapter;
        // The picked model is a PER-CALL choice (`resolveAdapter` binds only
        // the core); passing it here is what makes the pick real.
        model = process.assignment.model;
        effort = process.assignment.effort;
      }
      try {
        const signals = await suggestSignalsAI(adapter, {
          service,
          repoPath: repo.repoPath,
          ticketId: ctx.ticketId ?? null,
          model,
          effort,
        });
        ctx.post({ type: 'signals-suggested', service, signals });
      } catch (e) {
        // K11: park the quota failure when this form is bound to a ticket.
        // D159: the row id rides the error so the page can offer Pick/Retry/
        // Dismiss for the parked suggest op, and `lane` names the op so the
        // re-run repeats *this* op rather than the analysis.
        let parkId: number | null = null;
        if (ctx.ticketId !== undefined) {
          parkId = recordUsageLimitOpPark(deps.store, e, {
            ticketId: ctx.ticketId,
            stage: 'scope',
            lane: 'suggest',
            target: service,
          });
        }
        ctx.post({
          type: 'error',
          message: errorMessage(e),
          ...(parkId !== null ? { usageLimitParkId: parkId } : {}),
        });
      } finally {
        ctx.post({ type: 'busy', what: 'suggest', on: false });
      }
    },

    saveSignals(service: string, signals: string[]): void {
      try {
        deps.writeSignals(deps.manifestPath, service, signals);
        // Re-read the manifest so the in-memory copy the panel getter reads is
        // fresh; then pushState reflects the saved signals (gate clears, repo
        // row shows them). Reload BEFORE pushState.
        deps.reloadManifest();
        deps.onChange(); // sidebar/dashboard refresh
        ctx.pushState();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    setRepos(repos: string[]): void {
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { selectedRepos: repos });
      }
      // Lazily warm the branch-candidate cache: a row's candidates load only
      // once it is actually selected, so opening the form never fans out a
      // for-each-ref per manifest repository (§ per-repo base branch).
      if (deps.listBaseBranches && deps.branchCandidatesCache) {
        const cache = deps.branchCandidatesCache;
        const listBaseBranches = deps.listBaseBranches;
        for (const name of repos) {
          const repository = deps.manifest.repositories[name];
          if (!repository || cache.has(repository.repoPath)) continue;
          // Claim the slot immediately so a rapid re-toggle before the fetch
          // resolves does not start a second lookup for the same path.
          cache.set(repository.repoPath, []);
          void listBaseBranches(repository.repoPath).then((candidates) => {
            cache.set(repository.repoPath, candidates);
            ctx.pushState();
          });
        }
      }
    },

    setBaseRef(repo: string, baseRef: string): void {
      if (ctx.ticketId === undefined) return;
      const ticket = getTicket(deps.store, ctx.ticketId);
      // Build a NEW record — never mutate the ticket's persisted overrides.
      const current = { ...(ticket.baseRefs ?? {}) };
      const trimmed = baseRef.trim();
      // The effective default is resolved WITHOUT this repo's own override, so
      // an override equal to that effective default (manifest default for regular
      // tickets, parent branch for sub-tasks) reads as "no override" rather than
      // comparing against itself.
      const withoutThisRepo = { ...current };
      delete withoutThisRepo[repo];
      const parentBranch = subtaskParentBranch(deps.store, ticket, deps.manifest, repo);
      const effectiveDefault = resolvePlannedBaseRef(
        { ...ticket, baseRefs: withoutThisRepo },
        deps.manifest,
        repo,
        parentBranch,
      );
      const next =
        trimmed === '' || trimmed === effectiveDefault
          ? withoutThisRepo
          : { ...withoutThisRepo, [repo]: trimmed };
      try {
        assertSharedRepoBaseOverrides(deps.manifest, next);
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
        return;
      }
      updateTicketFields(deps.store, ctx.ticketId, { baseRefs: next });
    },

    setApproach(id: string): void {
      setApproach(id);
    },

    setAgent(id: string): void {
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { agent: id });
      }
    },

    setModel(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit the manifest default at launch). An
      // explicit pick also clears the ticket preset: the explicit field wins by
      // precedence, so leaving the preset would make the pick look ignored.
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { model: id, agentPreset: '' });
      }
    },

    setEffort(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit the manifest default effort at launch).
      // An explicit pick also clears the ticket preset (see setModel).
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { effort: id, agentPreset: '' });
      }
    },

    setProvider(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit manifest.agentProvider at launch).
      // Unlike setModel, this re-pushes state: a provider change also
      // re-filters the model picker (§ model/provider compatibility), and the
      // next state push is what carries the re-filtered `models` list down. An
      // explicit pick also clears the ticket preset (see setModel).
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { agentProvider: id, agentPreset: '' });
        ctx.pushState();
      }
    },

    setPreset(id: string): void {
      // An empty id is "Inherit (settings)" — persisted as '' which the store
      // maps to NULL. A real preset GOVERNs, so explicit core/model/effort are
      // cleared; otherwise they would win by precedence and the pick would look
      // ignored. The next state push re-renders the picker onto the preset.
      if (ctx.ticketId === undefined) return;
      updateTicketFields(
        deps.store,
        ctx.ticketId,
        id === ''
          ? { agentPreset: '' }
          : { agentPreset: id, agentProvider: '', model: '', effort: '' },
      );
      ctx.pushState();
    },

    setBackend(id: 'host' | ''): void {
      // The store writer throws on anything but 'host' / '' — a ticket can never
      // opt INTO a backend (arch:AC-32).
      if (ctx.ticketId === undefined) return;
      updateTicketFields(deps.store, ctx.ticketId, { agentBackend: id });
      ctx.pushState();
    },

    setType(id: string): void {
      // Empty id = "Inherit (settings)": '' clears the column to NULL, so the
      // manifest's `conventions.defaultType` applies again.
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { type: id });
      }
    },

    async analyze(livePrompt: string): Promise<void> {
      // D159: consume the one-shot override (a parked-op pick/retry), so it
      // applies to THIS run only and never leaks into a later user analyze.
      const override = analysisOverride;
      analysisOverride = undefined;
      // Match the ticket-form picker: offer built-in (sourceless) approaches
      // always, sourced ones only when installed. Otherwise the analyzer could
      // never pick `direct`/`single-subagent`, or pick one that won't launch.
      const installedIds = new Set(deps.listInstalledIds());
      const approaches = (deps.manifest.approaches ?? []).filter(
        (a) => a.enabled !== false && (a.source === undefined || installedIds.has(a.id)),
      );
      if (approaches.length === 0) return;

      // The live prompt (from the webview) is the freshest intent; the persisted
      // brief (edit mode / post-fetch) is the fetched context. A pure create page
      // has no ticket yet, so fall back to the prefill's summary — the review
      // form's Context brief — which is what analyze must reason over before the
      // panel binds. Require at least one signal, else there's nothing to analyze.
      const bound = ctx.ticketId !== undefined ? getTicket(deps.store, ctx.ticketId) : undefined;
      const brief = bound?.brief ?? ctx.prefillSummary ?? '';
      const prompt = livePrompt.trim() || bound?.description || '';
      if (!brief.trim() && !prompt.trim()) return;
      // Only an analysis that HAS input is re-runnable later; an empty call
      // never parked anything, so it must not overwrite the remembered prompt.
      lastAnalysisPrompt = prompt;

      // Score services against the ticket text so the analyzer gets keyword hints
      // (and a deterministic repo fallback when the AI call yields none).
      const scores = new Map(
        scoreRepos(deps.manifest, {
          title: bound?.title ?? '',
          description: [prompt, brief].filter(Boolean).join('\n'),
          tags: [],
        }).map((r) => [r.repo, r.score]),
      );
      const services: AnalyzeServiceInput[] = Object.entries(deps.manifest.repositories).map(
        ([name, def]) => ({ name, signals: def.signals ?? [], score: scores.get(name) ?? 0 }),
      );

      ctx.post({ type: 'busy', what: 'analyze', on: true });
      // D159: the op park id this analysis records, if a pass dies on quota
      // (declared before the try so the catch can offer the park actions).
      let parkId: number | null = null;
      try {
        // The analysis is the ticket's first AI process — the scope stage's
        // `prefill` row. It needs a ticket to attach to, so a pure create-mode
        // panel binds a draft FIRST (the same persist-on-bind path fetch and
        // attachments already walk), then resolves the configured
        // ticket-analysis process and attributes the call's spend to its run
        // (`tracking.processRunId`). The draft is re-keyed and retitled at
        // submit.
        const ticketId = ensureTicket();
        const process = deps.resolveAnalysisProcess(ticketId, override);
        if (process === null) {
          // Configured absence (`processes.ticketAnalysis.enabled: false`),
          // exactly like every other disabled inside process: the analyzer
          // performs no model call and opens no run. The page gets a reason it
          // can act on, not a silent no-op.
          ctx.post({
            type: 'error',
            message:
              'Ticket analysis is disabled in Settings — enable it to improve the prompt.',
          });
          return;
        }
        const startedAt = new Date().toISOString();
        const run = openProcessRun(deps.store, {
          ticketId,
          stageKey: 'scope',
          processId: 'prefill',
          attempt: 0,
          // The identity SNAPSHOT of the core/model that actually ran, resolved
          // at analyze time — later Settings edits never rewrite the row.
          agentName: process.assignment.agentName ?? null,
          provider: process.assignment.provider,
          model: process.assignment.model ?? null,
          startedAt,
        });
        // cwd is the PROJECT ROOT, not the picked repo: the profile body greps
        // `.karst/karst.yml`, `CLAUDE.md` and `docs/glossary.md`, which live
        // beside `.karst/`. The manifest is always `<projectRoot>/.karst/karst.yml`.
        const cwd = dirname(dirname(deps.manifestPath));
        // Resolved lazily: it needs the classified repos. Falls back to the sole
        // configured repo when classify picked none.
        const resolveRepoPath = (repos: string[]): string | undefined => {
          const repoEntries = Object.keys(deps.manifest.repositories ?? {});
          const improveRepo = repos[0] ?? (repoEntries.length === 1 ? repoEntries[0] : undefined);
          return improveRepo ? deps.manifest.repositories[improveRepo]?.repoPath : undefined;
        };
        let result: RunAnalysisResult;
        try {
          result = await runAnalysis(process.adapter, {
            analyze: {
              brief,
              prompt,
              services,
              approaches,
              ticketId,
              processRunId: run.id,
              model: process.assignment.model ?? undefined,
              effort: process.assignment.effort ?? undefined,
            },
            title: bound?.title ?? '',
            ticketType: bound?.type ?? undefined,
            improve: { instructions: process.assignment.instructions ?? '', cwd, resolveRepoPath },
            codePointers: { enabled: codePointersEnabled(deps.manifest) },
            warn: deps.warn,
            // K11: any pass that dies on quota records one re-runnable op park
            // (kind `op`, stage `scope`); the passes still degrade as before.
            // D159: the row id rides the error below so the page can offer
            // Pick agent/model… / Retry same / Dismiss for it.
            onUsageLimit: (error) => {
              parkId = recordUsageLimitOpPark(deps.store, error, {
                ticketId,
                stage: 'scope',
                lane: 'analysis',
                provider: process.assignment.provider,
                model: process.assignment.model ?? null,
              });
            },
          });
        } catch (error) {
          // The call's spend is already recorded (a 429 arrives after the input
          // was billed); the run closes as a failed execution, never as a pass.
          finishProcessRun(deps.store, run.id, 'failed', new Date().toISOString(), 'execution-failed');
          throw error;
        }
        finishProcessRun(deps.store, run.id, 'passed', new Date().toISOString());
        const { classification } = result;
        const descriptionOut = result.description;
        // Intent and pointers persist on the ensured ticket even in pure create
        // mode (where `ctx.ticketId` is still unset and the description stays in
        // the webview): the page marks them as received, so it will NOT resend
        // them on save. Only a produced value is written, so a failed or empty
        // re-run never clears an existing one.
        if (result.intent !== null || result.codePointers !== null) {
          updateTicketFields(deps.store, ticketId, {
            ...(result.intent !== null ? { intent: result.intent } : {}),
            ...(result.codePointers !== null ? { codePointers: result.codePointers } : {}),
          });
        }
        // Persist only when a ticket is bound (post-fetch / edit). Pure create
        // mode holds the draft in the webview until submit, so just return the
        // analysis and let the page apply it.
        if (ctx.ticketId !== undefined) {
          // Prefill the prompt and repos, but NOT the approach: the analyzer's
          // approach is a suggestion the page badges, never an auto-persisted
          // pick. The user's explicit selection is the sole authority for what is
          // stored, launched, and shown on the dashboard — persisting the AI pick
          // here silently overwrote a chosen approach (ticket 869e889uh). It rides
          // the `analysis` post below for the page to surface; committing it needs
          // an explicit set-approach / save / submit.
          const descSpilled = await spillField(
            deps.store, ctx.ticketId, 'description', descriptionOut, deps.storageDir,
          );
          if (descSpilled.kind === 'failed') {
            deps.warn?.(`spill failed for description on ticket ${ctx.ticketId}: ${descSpilled.reason}`);
          }
          updateTicketFields(deps.store, ctx.ticketId, {
            ...(descSpilled.kind === 'spilled' ? {} : { description: descriptionOut }),
            selectedRepos: classification.repos,
            // Prefill the type only while the ticket has none: like the approach,
            // an explicit pick is the user's, and a re-run of the analyzer must
            // not quietly overwrite it. Absent one, the suggestion IS the value.
            ...(bound?.type ? {} : { type: classification.type }),
          });
          // The analyzer MAY apply its approach pick, but only while the user has
          // not touched the picker AND no choice is persisted yet (design,
          // Selection and Enablement). After a touch — or once a choice exists —
          // later analysis is recommendation-only, so the badge carries the
          // suggestion and commit stays an explicit set-approach / save / submit.
          if (!ctx.pickerTouched && !bound?.approach) {
            setApproach(classification.approachId);
          }
          ctx.pushState();
        }
        ctx.post({
          type: 'analysis',
          prompt: descriptionOut,
          approachId: classification.approachId,
          repos: classification.repos,
          reason: classification.reason,
          ticketType: bound?.type ?? classification.type,
          intent: result.intent,
          codePointers: result.codePointers,
          warnings: result.degraded,
        });
        // D159: a pass that degraded on quota leaves an op park; offer the
        // actions so the row has a user path (the analysis itself still landed).
        if (parkId !== null) {
          ctx.post({
            type: 'error',
            message: 'Usage limit reached — pick another agent/model to re-run this step.',
            usageLimitParkId: parkId,
          });
        }
      } catch (e) {
        ctx.post({
          type: 'error',
          message: errorMessage(e),
          ...(parkId !== null ? { usageLimitParkId: parkId } : {}),
        });
      } finally {
        ctx.post({ type: 'busy', what: 'analyze', on: false });
      }
    },

    openTicketLink(url: string): void {
      if (deps.openUrl) {
        deps.openUrl(url);
      }
    },

    // The edit-mode "Create in ClickUp" button: bind this ticket to a freshly
    // minted provider task. The ticket already exists (edit mode), so a
    // failure leaves it untouched and the control retryable.
    async createProviderTicket(): Promise<void> {
      const ticketId = ctx.ticketId;
      if (ticketId === undefined) return; // create mode has nothing to bind yet
      await bindProviderTask(ctx, deps, ticketId);
      // Re-seed on BOTH outcomes: success shows the bound link (sourceRef now
      // set), failure keeps the page in edit mode with the inline error.
      ctx.pushState();
    },

    async retryRelationWriteback(relationId: number): Promise<void> {
      const ticketId = ctx.ticketId;
      if (ticketId === undefined) return;
      const relation = listPendingWritebacks(deps.store, ticketId).find((r) => r.id === relationId);
      if (!relation || relation.writebackState !== 'failed') return;
      markWriteback(deps.store, relationId, 'pending');
      await onSourceRefBound(deps, ticketId);
      deps.onChange();
      ctx.pushState();
    },
    openDependency(ticketId: number): void {
      if (listRelationViews(deps.store, ctx.ticketId ?? -1).some((r) => r.targetTicketId === ticketId)) {
        deps.openDependency?.(ticketId);
      }
    },

    async submit(input): Promise<void> {
      let ticketId: number;
      try {
        ticketId = persistDraft(ctx, deps, input);
      } catch (e) {
        // A rejected base-ref override (or any other validation persistDraft
        // enforces) must not create or half-write a ticket — nothing has been
        // written yet, so reporting and returning here is a clean no-op.
        ctx.post({ type: 'error', message: errorMessage(e) });
        return;
      }

      // The create-mode "Also create in ClickUp" checkbox: mint + bind the
      // provider task BEFORE the launch. The Karst ticket is already persisted
      // (persistDraft), so a provider failure reports inline and stays on the
      // page — the launch must not start a ticket whose board task failed.
      // Spill oversized descriptions to the attachment shelf at ingest so every
      // downstream read site (seed, tester, CLI context) sees bounded text.
      if (input.description) {
        const spillResult = await spillField(deps.store, ticketId, 'description', input.description, deps.storageDir);
        if (spillResult.kind === 'failed') {
          deps.warn?.(`spill failed for description on ticket ${ticketId}: ${spillResult.reason}`);
        }
      }
      if (input.createInProvider) {
        const bound = await bindProviderTask(ctx, deps, ticketId);
        if (!bound) {
          // bindProviderTask already posted the inline reason; just re-seed the
          // page (the ticket exists now) so the control is retryable.
          ctx.pushState();
          return;
        }
      }

      // Finishing the ticket form hands the ticket off to the workflow: scope its
      // selected repos (worktrees, no servers) and launch the agent session.
      // Awaited so the page stays put (busy) while the launch runs, and the
      // handoff only happens once the ticket is really running.
      const queued = queueSubtaskInsteadOfStart(deps, ticketId);
      if (queued !== 'not-subtask') {
        deps.onChange();
        if (queued !== 'queued') {
          ctx.post({ type: 'error', message: queued.error });
          ctx.pushState(); // the ticket exists now — re-seed the page for a retry
          return;
        }
        deps.openDashboard(ticketId);
        ctx.close();
        return;
      }
      let blockedOverride: string[] | null = null;
      const blockers = listOpenBlockers(deps.store, ticketId);
      if (blockers.length) {
        const labels = blockers.map((b) => b.label);
        if (!deps.confirmBlockedStart) {
          ctx.post({ type: 'error', message: 'Internal: confirmBlockedStart dialog not injected. This is a bug — please report it.' });
          ctx.pushState();
          return;
        }
        if (!(await deps.confirmBlockedStart(`Blocked by ${labels.join(', ')}. Start anyway?`))) {
          ctx.pushState();
          return;
        }
        blockedOverride = labels;
      }

      ctx.post({ type: 'busy', what: 'submit', on: true });
      try {
        // Only an explicit `false` opts out of the pull — an older page that
        // sends no switch still gets the default (fresh base), same rule the
        // message parser applies at the trust boundary.
        const result = await deps.startTicket(ticketId, { pullBase: input.pullBase !== false });
        if (!result.ok) {
          ctx.post({ type: 'error', message: result.message });
          ctx.pushState(); // the ticket exists now — re-seed the page for a retry
          return;
        }
        if (blockedOverride) postMessage(deps.store, {
          projectId: getTicket(deps.store, ticketId).projectId,
          fromTicketId: null,
          toTicketId: ticketId,
          kind: 'event',
          body: `Manual start override: started while blocked by ${blockedOverride.join(', ')}.`,
        });
        // Running tickets belong to the dashboard: open it, then close this
        // page so the create/edit tab is replaced rather than left stale.
        deps.openDashboard(ticketId);
        ctx.close();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      } finally {
        // Un-busies the button on every failure path. On success the panel is
        // already disposed, which drops the post.
        ctx.post({ type: 'busy', what: 'submit', on: false });
      }
    },

    // Save without a run: persist like submit, but never call startTicket —
    // no worktrees, no agent launch. Leaves the panel open (now in edit mode,
    // bound to the persisted ticket) so the user can keep editing or start it
    // later from the same page.
    async save(input): Promise<void> {
      ctx.post({ type: 'busy', what: 'save', on: true });
      try {
        const ticketId = persistDraft(ctx, deps, input);
        // Spill oversized descriptions to the attachment shelf at ingest.
        if (input.description) {
          const spillResult = await spillField(deps.store, ticketId, 'description', input.description, deps.storageDir);
          if (spillResult.kind === 'failed') {
            deps.warn?.(`spill failed for description on ticket ${ticketId}: ${spillResult.reason}`);
          }
        }
        // Same checkbox contract as submit: persisting the ticket with the
        // checkbox on also mints + binds the provider task. A failure reports
        // inline and the saved ticket stays — save never loses the draft.
        if (input.createInProvider) {
          await bindProviderTask(ctx, deps, ticketId);
        }
        ctx.pushState();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      } finally {
        ctx.post({ type: 'busy', what: 'save', on: false });
      }
    },

    // D159: resolve an op usage-limit park from its error notification. Each
    // claims the row FIRST (one conditional UPDATE, so a concurrent window or
    // the driver loses and touches nothing), then re-runs ONLY the parked op
    // with a ONE-SHOT agent/model — never persisted. The op is named by the
    // row's `lane`, which the recording call site set.
    async usageLimitParkPick(parkId: number): Promise<void> {
      const park = findRerunnableOpPark(parkId);
      if (!park) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      if (!deps.pickUsageLimitAgentModel) {
        ctx.post({ type: 'error', message: 'No agent/model picker is available for this step.' });
        return;
      }
      const picked = await deps.pickUsageLimitAgentModel(park.provider, park.model);
      if (!picked) {
        // Cancelled: nothing was claimed, so the page must re-arm the buttons
        // it disabled on click (or a cancel would leave them inert forever).
        ctx.post({ type: 'usage-limit-park-cancelled' });
        return;
      }
      if (!claimUsageLimitPark(deps.store, parkId, 'pick').claimed) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      ctx.post({ type: 'usage-limit-park-resolved' });
      analysisOverride = { provider: picked.provider, model: picked.model };
      await rerunParkedOp(park);
    },

    async usageLimitParkRetry(parkId: number): Promise<void> {
      const park = findRerunnableOpPark(parkId);
      if (!park) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      if (!claimUsageLimitPark(deps.store, parkId, 'retry').claimed) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      ctx.post({ type: 'usage-limit-park-resolved' });
      analysisOverride = { provider: park.provider as AgentProvider, model: park.model };
      await rerunParkedOp(park);
    },

    usageLimitParkDismiss(parkId: number): void {
      const park = findRerunnableOpPark(parkId);
      if (!park) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      // An op park has no stage block to fail: resolving the row IS the dismiss.
      if (!claimUsageLimitPark(deps.store, parkId, 'dismiss').claimed) {
        ctx.post({ type: 'error', message: 'This usage limit was already handled.' });
        return;
      }
      ctx.post({ type: 'usage-limit-park-resolved' });
    },

    requestState(): void {
      ctx.pushState();
    },

    // Cancel: discard the form and close the panel. Closing is the host's job
    // (the webview cannot dispose itself); ctx.close disposes the panel, which
    // drops every later post via the disposed guard — the same path submit's
    // handoff uses.
    closeForm(): void {
      ctx.close();
    },
    };
    return actions;
  };
}
