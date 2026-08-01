import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { TicketingProvider, ContextBrief } from '../../integrations/ticketing.js';
import { renderBrief } from '../../integrations/briefMarkdown.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import {
  getTicket,
  updateTicketCore,
  updateTicketOnboarding,
  generateTicketKey,
} from '../../store/tickets.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { scoreRepos } from '../../workflow/classify/gate.js';
import { suggestSignals as suggestSignalsAI } from '../../workflow/classify/suggest.js';
import {
  analyzeTicket,
  type AnalyzeServiceInput,
} from '../../workflow/classify/analyze.js';
import type { OnboardingActions, TicketDraftFields } from './messages.js';
import type { OnboardingActionsCtx, OnboardingActionsFactory } from './panel.js';
import { ingestFile, ingestBytes, type IngestResult } from '../../attachments/ingest.js';
import { unlinkAttachment } from '../../attachments/reap.js';
import { attachmentPath } from '../../attachments/paths.js';
import {
  insertAttachment,
  getAttachment,
  deleteAttachment,
  findAttachmentByStoredName,
} from '../../store/attachments.js';

/**
 * Host-side onboarding logic (§ onboarding), independent of `vscode`. It ties
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
 * onboarding page can show it inline and stay open for a retry (e.g. no repos
 * selected) instead of the user staring at a page that did nothing.
 */
export type StartTicketResult = { ok: true } | { ok: false; message: string };

export interface OnboardingActionsDeps {
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
  /** Notify the host to refresh sidebar/dashboard after a create/edit. */
  onChange: () => void;
  /**
   * Kick off a just-finished ticket: create worktrees for its selected repos,
   * arm the scope stage, and open the agent session seeded with its chosen
   * approach. Injected because it needs git + a terminal (vscode). Resolves only
   * once the ticket is actually running, so `submit` knows when to hand the user
   * off to the dashboard.
   */
  startTicket: (ticketId: number) => StartTicketResult | Promise<StartTicketResult>;
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
  openFile: (path: string) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
 * Create-or-update the ticket from onboarding's draft fields, and persist the
 * repo/approach/agent/model selection — the part `submit` and `save` share.
 * Binds a create-mode panel to the new ticket. Does NOT touch startTicket;
 * callers decide whether a run follows.
 */
function persistDraft(
  ctx: OnboardingActionsCtx,
  deps: OnboardingActionsDeps,
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
      updateTicketOnboarding(deps.store, ctx.ticketId, { description: input.description });
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
  // Finishing onboarding (submit) or saving a draft (save) is the only chance
  // to record repo/approach/agent/model in pure create mode — the ticket
  // didn't exist before now, so setRepos/setApproach/setAgent never ran.
  updateTicketOnboarding(deps.store, ticketId, {
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

export function buildOnboardingActions(
  deps: OnboardingActionsDeps,
): OnboardingActionsFactory {
  return (ctx: OnboardingActionsCtx): OnboardingActions => {
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
    const record = (ticketId: number, result: IngestResult): boolean => {
      if (!result.ok) {
        ctx.post({ type: 'error', message: result.message });
        return false;
      }
      const existing = findAttachmentByStoredName(
        deps.store, ticketId, result.input.storedName,
      );
      if (!existing) insertAttachment(deps.store, result.input);
      return true;
    };

    return {
    attachPick: async (): Promise<void> => {
      const paths = await deps.pickAttachment();
      if (paths.length === 0) return; // cancelled — not an error, say nothing
      const ticketId = ensureTicket();
      let changed = false;
      for (const path of paths) {
        // Sequential, not Promise.all: each ingest hashes and copies, and a
        // multi-select of large videos should not run N copies at once.
        if (record(ticketId, await ingestFile(deps.storageDir, ticketId, path))) changed = true;
      }
      if (changed) ctx.pushState();
    },

    attachBytes: async (name: string, base64: string): Promise<void> => {
      const ticketId = ensureTicket();
      // Buffer.from silently DROPS invalid base64 characters rather than
      // throwing, so a corrupt payload would otherwise be written as a
      // truncated file that renders as a broken tile. Re-encoding and comparing
      // is the check: a payload that does not round-trip was not valid base64.
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) {
        ctx.post({ type: 'error', message: `${name} could not be decoded` });
        return;
      }
      if (record(ticketId, await ingestBytes(deps.storageDir, ticketId, name, bytes))) {
        ctx.pushState();
      }
    },

    detachAttachment: async (id: number): Promise<void> => {
      // Scoped to THIS panel's ticket. The id crosses an untrusted boundary, so
      // an id belonging to another ticket must not let this panel unlink that
      // ticket's file.
      const row = getAttachment(deps.store, id);
      if (!row || row.ticketId !== ctx.ticketId) return;
      deleteAttachment(deps.store, id);
      await unlinkAttachment(deps.storageDir, row.ticketId, row.storedName);
      ctx.pushState();
    },

    openAttachment: async (id: number): Promise<void> => {
      const row = getAttachment(deps.store, id);
      if (!row || row.ticketId !== ctx.ticketId) return;
      deps.openFile(attachmentPath(deps.storageDir, row.ticketId, row.storedName));
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
        updateTicketOnboarding(deps.store, ctx.ticketId!, {
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
        updateTicketOnboarding(deps.store, ctx.ticketId, { selectedRepos: repos });
      }
    },

    setApproach(id: string): void {
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { approach: id });
      }
    },

    setAgent(id: string): void {
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { agent: id });
      }
    },

    setModel(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit the manifest default at launch).
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { model: id });
      }
    },

    setProvider(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit manifest.agentProvider at launch).
      // Unlike setModel, this re-pushes state: a provider change also
      // re-filters the model picker (§ model/provider compatibility), and the
      // next state push is what carries the re-filtered `models` list down.
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { agentProvider: id });
        ctx.pushState();
      }
    },

    setType(id: string): void {
      // Empty id = "Inherit (settings)": '' clears the column to NULL, so the
      // manifest's `conventions.defaultType` applies again.
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { type: id });
      }
    },

    async analyze(livePrompt: string): Promise<void> {
      // Match the onboarding picker: offer built-in (sourceless) approaches
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
        const analysis = await analyzeTicket(deps.adapter, { brief, prompt, services, approaches });
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
          updateTicketOnboarding(deps.store, ctx.ticketId, {
            description: analysis.prompt,
            selectedRepos: analysis.repos,
            // Prefill the type only while the ticket has none: like the approach,
            // an explicit pick is the user's, and a re-run of the analyzer must
            // not quietly overwrite it. Absent one, the suggestion IS the value.
            ...(bound?.type ? {} : { type: analysis.type }),
          });
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

    async submit(input): Promise<void> {
      const ticketId = persistDraft(ctx, deps, input);

      // Finishing onboarding hands the ticket off to the workflow: scope its
      // selected repos (worktrees, no servers) and launch the agent session.
      // Awaited so the page stays put (busy) while the launch runs, and the
      // handoff only happens once the ticket is really running.
      ctx.post({ type: 'busy', what: 'submit', on: true });
      try {
        const result = await deps.startTicket(ticketId);
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
        persistDraft(ctx, deps, input);
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
    };
  };
}
