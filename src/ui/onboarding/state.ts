import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import type { Manifest, ApproachDef, TicketProvider } from '../../manifest/types.js';
import { unclassifiedServices, scoreRepos } from '../../workflow/classify/gate.js';
import type { PoolAgent } from '../../agents/pool.js';
import { KNOWN_MODELS, type ModelOption } from '../../agent/models.js';

/**
 * Serializable state for the onboarding page (§ onboarding). One surface serves
 * both create (no ticket yet) and edit (existing ticket) modes; the webview
 * renders from this and posts patches back. Everything is a plain value so it
 * crosses the postMessage boundary and survives a webview reload.
 */

/** One repo row: a service, its signals, its classifier score, and selection. */
export interface RepoRow {
  service: string;
  signals: string[];
  score: number;
  selected: boolean;
}

/**
 * An approach definition plus whether a matching package is already installed
 * on disk (§ Task E1). The install picker (Phase E) uses `installed` to decide
 * whether to offer "open" vs. "install".
 */
export type ApproachRow = ApproachDef & { installed: boolean };

export interface OnboardingState {
  mode: 'create' | 'edit';
  ticketId?: number;
  key: string;
  title: string;
  description: string;
  /** Board ref the ticket was (or will be) fetched from. */
  sourceRef: string;
  /** Synthesized context brief, or null before a fetch. */
  brief: string | null;
  /**
   * Configured ticketing provider. Drives the "Fetches from …" indicator and
   * whether a fetch is even possible (`manual` has no board to fetch from).
   */
  provider: TicketProvider;
  /** Services still lacking signal words — the classify gate targets these. */
  unclassified: string[];
  repos: RepoRow[];
  approaches: ApproachRow[];
  selectedApproach: string | null;
  /** Selectable single-subagent pool (§ single-subagent picker). */
  agents: PoolAgent[];
  /** Persisted (edit mode) or not-yet-chosen (create mode) agent name. */
  selectedAgent: string | null;
  /** The curated launch models offered in the picker. */
  models: ModelOption[];
  /** Per-ticket model id; null = inherit the manifest default. */
  selectedModel: string | null;
  /** Manifest default model, for the "Inherit (settings: …)" label; null = none. */
  defaultModel: string | null;
  /**
   * True when an interactive session terminal is already open for this ticket.
   * The model (and effort) picker locks while a session runs — the launch flag
   * is baked at spawn and can't switch mid-session. Always false in create mode.
   */
  sessionOpen: boolean;
}

/**
 * Baseline default: the manifest-recommended approach (`recommended:true`),
 * falling back to the first configured, or null when none are configured. This
 * is the global default the radio starts on. The per-ticket AI suggestion
 * (`suggestApproach`, Phase D2) surfaces as a badge and can move the radio on an
 * explicit user click, but it does NOT override this global default silently.
 */
function defaultApproach(approaches: ApproachDef[]): string | null {
  if (approaches.length === 0) return null;
  const recommended = approaches.find((a) => a.recommended);
  return (recommended ?? approaches[0]!).id;
}

/**
 * Which approaches onboarding offers to pick:
 * - A **built-in** approach (no `source`, e.g. `direct`, `single-subagent`)
 *   needs no install — always offered, marked `installed: true`.
 * - A **sourced** approach (git/npm) is offered only when its package is
 *   installed (id in `listInstalledIds()`); install lives in Settings.
 * A **disabled** approach (`enabled === false`) is never offered — the user
 * hid it from the create/edit flow without deleting it (Settings toggle).
 * Dropping sourced-but-uninstalled and disabled entries keeps the picker to
 * things that will actually launch, while never hiding the always-available
 * enabled built-ins.
 */
function toApproachRows(approaches: ApproachDef[], listInstalledIds: () => string[]): ApproachRow[] {
  const installedIds = new Set(listInstalledIds());
  return approaches
    .filter((a) => a.enabled !== false)
    .filter((a) => a.source === undefined || installedIds.has(a.id))
    .map((a) => ({ ...a, installed: true }));
}

/**
 * Build onboarding state. With no `ticketId` → a blank create-mode draft. With a
 * `ticketId` → edit mode seeded from the ticket's persisted onboarding fields.
 * Throws if the ticket id is unknown (validated at the boundary).
 *
 * `listInstalledIds` is injected (not called via fs/vscode here) so this stays
 * pure/host-agnostic — the real host binds it to `listInstalled(approachesDir)`.
 * `listAgents` is likewise injected (real host binds it to `buildAgentPool`).
 */
export function buildOnboardingState(
  store: Store,
  manifest: Manifest,
  listInstalledIds: () => string[],
  listAgents: () => PoolAgent[],
  ticketId?: number,
  isSessionOpen: (ticketId: number) => boolean = () => false,
): OnboardingState {
  const approaches = toApproachRows(manifest.approaches ?? [], listInstalledIds);
  const agents = listAgents();
  const unclassified = unclassifiedServices(manifest);
  const provider: TicketProvider = manifest.ticketing?.provider ?? 'manual';

  const serviceEntries = Object.entries(manifest.services);
  /**
   * One row per service. `scores` maps service→classifier score (empty in
   * create mode, before any ticket text exists). Selection precedence: an
   * explicit `selectedSet` wins; with no explicit pick yet, auto-select a
   * service that scored a hit OR the lone service (single-service stack has no
   * choice to make, so it is always pre-checked).
   */
  const soleService = serviceEntries.length === 1;
  const makeRepos = (selectedSet: Set<string>, scores: Map<string, number>): RepoRow[] => {
    const hasExplicit = selectedSet.size > 0;
    return serviceEntries.map(([service, svc]) => {
      const score = scores.get(service) ?? 0;
      return {
        service,
        signals: svc.signals ?? [],
        score,
        selected: hasExplicit ? selectedSet.has(service) : score > 0 || soleService,
      };
    });
  };

  if (ticketId === undefined) {
    return {
      mode: 'create',
      key: '',
      title: '',
      description: '',
      sourceRef: '',
      brief: null,
      provider,
      unclassified,
      repos: makeRepos(new Set(), new Map()),
      approaches,
      selectedApproach: defaultApproach(approaches),
      agents,
      selectedAgent: null,
      models: [...KNOWN_MODELS],
      selectedModel: null,
      defaultModel: manifest.defaultModel ?? null,
      sessionOpen: false, // create mode has no ticket → nothing to lock
    };
  }

  const ticket = getTicket(store, ticketId); // throws on unknown id
  const selectedSet = new Set(ticket.selectedRepos);
  // Score against the ticket's persisted text so scored repos survive a webview
  // reload (the fetch action's in-memory scoring isn't re-run here).
  const scores = new Map(
    scoreRepos(manifest, {
      title: ticket.title ?? '',
      description: ticket.description ?? '',
      tags: [],
    }).map((r) => [r.service, r.score]),
  );
  return {
    mode: 'edit',
    ticketId,
    key: ticket.key ?? '',
    title: ticket.title ?? '',
    description: ticket.description ?? '',
    sourceRef: ticket.sourceRef ?? '',
    brief: ticket.brief,
    provider,
    unclassified,
    repos: makeRepos(selectedSet, scores),
    approaches,
    selectedApproach: ticket.approach ?? defaultApproach(approaches),
    agents,
    selectedAgent: ticket.agent ?? null,
    models: [...KNOWN_MODELS],
    selectedModel: ticket.model ?? null,
    defaultModel: manifest.defaultModel ?? null,
    sessionOpen: isSessionOpen(ticketId),
  };
}
