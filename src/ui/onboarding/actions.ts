import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { TicketingProvider, ContextBrief } from '../../integrations/ticketing.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import {
  getTicket,
  updateTicketCore,
  updateTicketOnboarding,
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
}

/** Render a fetched brief into the plain-text `brief` column. */
function renderBrief(brief: ContextBrief): string {
  const lines = [`# ${brief.title}`, '', brief.description];
  if (brief.tags.length) lines.push('', `Tags: ${brief.tags.join(', ')}`);
  if (brief.comments.length) {
    lines.push('', '## Comments');
    for (const c of brief.comments) lines.push(`- ${c.author}: ${c.text}`);
  }
  if (brief.attachments.length) {
    lines.push('', '## Attachments');
    for (const a of brief.attachments) lines.push(`- ${a.name} (${a.url})`);
  }
  return lines.join('\n');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Services whose signal words hit the brief (score > 0), classifier order. */
function scoredRepos(manifest: Manifest, brief: ContextBrief): string[] {
  return scoreRepos(manifest, {
    title: brief.title,
    description: brief.description,
    tags: brief.tags,
  })
    .filter((r) => r.score > 0)
    .map((r) => r.service);
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
  let ticketId: number;
  if (ctx.ticketId !== undefined) {
    updateTicketCore(deps.store, ctx.ticketId, { key: input.key, title: input.title });
    if (input.description) {
      updateTicketOnboarding(deps.store, ctx.ticketId, { description: input.description });
    }
    ticketId = ctx.ticketId;
  } else {
    const t = createTicketFlow(deps.store, {
      key: input.key,
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
  });
  deps.onChange();
  return ticketId;
}

export function buildOnboardingActions(
  deps: OnboardingActionsDeps,
): OnboardingActionsFactory {
  return (ctx: OnboardingActionsCtx): OnboardingActions => ({
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
      const svc = deps.manifest.services[service];
      if (!svc) {
        ctx.post({ type: 'error', message: `Unknown service "${service}".` });
        return;
      }
      ctx.post({ type: 'busy', what: 'suggest', on: true });
      try {
        const signals = await suggestSignalsAI(deps.adapter, {
          service,
          repoPath: svc.repoPath,
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
        }).map((r) => [r.service, r.score]),
      );
      const services: AnalyzeServiceInput[] = Object.entries(deps.manifest.services).map(
        ([name, svc]) => ({ name, signals: svc.signals ?? [], score: scores.get(name) ?? 0 }),
      );

      ctx.post({ type: 'busy', what: 'analyze', on: true });
      try {
        const analysis = await analyzeTicket(deps.adapter, { brief, prompt, services, approaches });
        // Persist only when a ticket is bound (post-fetch / edit). Pure create
        // mode holds the draft in the webview until submit, so just return the
        // analysis and let the page apply it.
        if (ctx.ticketId !== undefined) {
          updateTicketOnboarding(deps.store, ctx.ticketId, {
            description: analysis.prompt,
            selectedRepos: analysis.repos,
            approach: analysis.approachId,
          });
          ctx.pushState();
        }
        ctx.post({
          type: 'analysis',
          prompt: analysis.prompt,
          approachId: analysis.approachId,
          repos: analysis.repos,
          reason: analysis.reason,
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
  });
}
