import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
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
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import { scoreRepos } from '../../workflow/classify/gate.js';
import { suggestSignals as suggestSignalsAI } from '../../workflow/classify/suggest.js';
import {
  analyzeTicket,
  type AnalyzeServiceInput,
} from '../../workflow/classify/analyze.js';
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

/** Per-launch choices the ticket form makes for a start it is triggering. */
export interface StartTicketOptions {
  /**
   * Refresh each scoped repository's baseline branch from the remote before its
   * worktree is cut (§ pull switch). The page's switch is ON by default; this
   * carries what the user actually left it on, not the default.
   */
  pullBase: boolean;
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
   * The ticket form's analyzer process (the `ticket-analysis` role of the
   * `processes:` block): the identity snapshot its `prefill` run opens with
   * AND the already-instrumented adapter the analysis runs through. Resolved
   * at analyze time, after the draft is bound, so the ticket's own
   * provider/model picks participate as overrides — the same seam every other
   * inside process resolves through (extension.ts's `processFor`). NULL is
   * configured ABSENCE (`enabled: false`): the analyzer refuses rather than
   * running on a guessed default. The plain `adapter` above stays the
   * panel-wide default for the signal-word suggestion.
   */
  resolveAnalysisProcess: (ticketId: number) => DriveProcessBundle | null;
  /** Notify the host to refresh sidebar/dashboard after a create/edit. */
  onChange: () => void;
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
  /** Injected manifest signal writer (real: writeServiceSignals). */
  writeSignals: (path: string, service: string, signals: string[]) => void;
  /**
   * Re-read the manifest from disk into the host's in-memory copy. Called after
   * a signal writeback so the panel's `manifest()` getter (and thus the next
   * `pushState`) reflects the just-saved signals — otherwise the gate would
   * still show the service as unclassified.
   */
  reloadManifest: () => void;
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
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    updateTicketFields(deps.store, ticketId, { sourceRef: created.ref });
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
  // The key is optional on the webview's manual-entry path (§ manual ticket
  // creation): a blank key means "derive one from the title now" (the webview
  // previews the same derivation while you type, so this is normally a no-op
  // agreement rather than a surprise). Resolved once, here, so create and edit
  // share the exact same key whether it's persisted via createTicketFlow or
  // updateTicketCore below — never generated twice, never lost between the two
  // branches.
  const key = input.key
    || generateTicketKey(deps.store, { projectId: deps.projectId }, input.title);
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
    agentProvider: input.agentProvider ?? '',
    type: input.ticketType ?? '',
  });
  deps.onChange();
  return ticketId;
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

    return {
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
        updateTicketFields(deps.store, ctx.ticketId!, {
          sourceRef: ref,
          sourceFetchedAt: new Date().toISOString(),
          brief: renderBrief(brief),
          description: brief.description,
          selectedRepos: repos,
        });

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
      // Signals classify a SOURCE TREE, so this works for a non-runnable
      // repository too — only `repoPath` is read.
      const repo = deps.manifest.repositories[service];
      if (!repo) {
        ctx.post({ type: 'error', message: `Unknown repository "${service}".` });
        return;
      }
      ctx.post({ type: 'busy', what: 'suggest', on: true });
      try {
        const signals = await suggestSignalsAI(deps.adapter, {
          service,
          repoPath: repo.repoPath,
        });
        ctx.post({ type: 'signals-suggested', service, signals });
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
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
      // the store maps to NULL (inherit the manifest default at launch).
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { model: id });
      }
    },

    setProvider(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit manifest.agentProvider at launch).
      // Unlike setModel, this re-pushes state: a provider change also
      // re-filters the model picker (§ model/provider compatibility), and the
      // next state push is what carries the re-filtered `models` list down.
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { agentProvider: id });
        ctx.pushState();
      }
    },

    setType(id: string): void {
      // Empty id = "Inherit (settings)": '' clears the column to NULL, so the
      // manifest's `conventions.defaultType` applies again.
      if (ctx.ticketId !== undefined) {
        updateTicketFields(deps.store, ctx.ticketId, { type: id });
      }
    },

    async analyze(livePrompt: string): Promise<void> {
      // Match the ticket-form picker: offer built-in (sourceless) approaches
      // always, sourced ones only when installed. Otherwise the analyzer could
      // never pick `direct`/`single-subagent`, or pick one that won't launch.
      const installedIds = new Set(deps.listInstalledIds());
      const approaches = (deps.manifest.approaches ?? []).filter(
        (a) => a.enabled !== false && (a.source === undefined || installedIds.has(a.id)),
      );
      if (approaches.length === 0) return;

      // The live prompt (from the webview) is the freshest intent; the persisted
      // brief (edit mode / post-fetch) is the fetched context. In pure create
      // mode there is no ticket yet, so the brief is empty and the live prompt is
      // the sole signal. Require at least one, else there's nothing to analyze.
      const bound = ctx.ticketId !== undefined ? getTicket(deps.store, ctx.ticketId) : undefined;
      const brief = bound?.brief ?? '';
      const prompt = livePrompt.trim() || bound?.description || '';
      if (!brief.trim() && !prompt.trim()) return;

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
      try {
        // The analysis is the ticket's first AI process — the scope stage's
        // `prefill` row. It needs a ticket to attach to, so a pure create-mode
        // panel binds a draft FIRST (the same persist-on-bind path fetch and
        // attachments already walk), then resolves the configured
        // ticket-analysis process and attributes the call's spend to its run
        // (`tracking.processRunId`). The draft is re-keyed and retitled at
        // submit.
        const ticketId = ensureTicket();
        const process = deps.resolveAnalysisProcess(ticketId);
        if (process === null) {
          // Configured absence (`processes.ticketAnalysis.enabled: false`),
          // exactly like every other disabled inside process: the analyzer
          // performs no model call and opens no run. The page gets a reason it
          // can act on, not a silent no-op.
          ctx.post({
            type: 'error',
            message:
              'Ticket analysis is disabled in Settings — enable it to prefill the prompt.',
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
        let analysis: Awaited<ReturnType<typeof analyzeTicket>>;
        try {
          analysis = await analyzeTicket(process.adapter, {
            brief,
            prompt,
            services,
            approaches,
            ticketId,
            processRunId: run.id,
            model: process.assignment.model ?? undefined,
          });
          finishProcessRun(deps.store, run.id, 'passed', new Date().toISOString());
        } catch (error) {
          // The call's spend is already recorded (a 429 arrives after the input
          // was billed); the run closes as a failed execution, never as a pass.
          finishProcessRun(deps.store, run.id, 'failed', new Date().toISOString(), 'execution-failed');
          throw error;
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
          updateTicketFields(deps.store, ctx.ticketId, {
            description: analysis.prompt,
            selectedRepos: analysis.repos,
            // Prefill the type only while the ticket has none: like the approach,
            // an explicit pick is the user's, and a re-run of the analyzer must
            // not quietly overwrite it. Absent one, the suggestion IS the value.
            ...(bound?.type ? {} : { type: analysis.type }),
          });
          // The analyzer MAY apply its approach pick, but only while the user has
          // not touched the picker AND no choice is persisted yet (design,
          // Selection and Enablement). After a touch — or once a choice exists —
          // later analysis is recommendation-only, so the badge carries the
          // suggestion and commit stays an explicit set-approach / save / submit.
          if (!ctx.pickerTouched && !bound?.approach) {
            setApproach(analysis.approachId);
          }
          ctx.pushState();
        }
        ctx.post({
          type: 'analysis',
          prompt: analysis.prompt,
          approachId: analysis.approachId,
          repos: analysis.repos,
          reason: analysis.reason,
          ticketType: bound?.type ?? analysis.type,
        });
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
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

    async submit(input): Promise<void> {
      const ticketId = persistDraft(ctx, deps, input);

      // The create-mode "Also create in ClickUp" checkbox: mint + bind the
      // provider task BEFORE the launch. The Karst ticket is already persisted
      // (persistDraft), so a provider failure reports inline and stays on the
      // page — the launch must not start a ticket whose board task failed.
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
  };
}
