import type { Manifest } from '../../manifest/types.js';
import type { SettingsState } from './state.js';
import type { SettingsProcessAssignmentView } from './processAssignmentViews.js';
import type { TicketList } from '../../integrations/ticketing.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import { isSettingsSection, type SettingsSection } from './sections.js';
import type { ActionResultMessage } from '../../model/actionResult.js';

/** Webview → host messages. The webview is untrusted; parse before use. */
export type SettingsWebviewMessage =
  /**
   * `section` scopes the write to one tab: the host overlays that tab's fields
   * onto the manifest on disk and leaves every other section alone. Absent means
   * "write the whole draft" — kept for callers that legitimately own all of it.
   */
  | { type: 'save'; manifest: Manifest; section?: SettingsSection }
  | { type: 'validate'; manifest: Manifest }
  /**
   * Recompute the inside-process-assignment row views (handoff §7) from the
   * DRAFT and reply with `process-assignment-views`. The draft is
   * webview-local, so the four validation states must be computed host-side
   * on demand — exactly the existing `validate`/`validation` round trip.
   */
  | { type: 'validate-process-assignments'; manifest: Manifest }
  | { type: 'install-approach'; id: string }
  | { type: 'uninstall-approach'; id: string }
  | { type: 'set-token' }
  | { type: 'clear-token' }
  | { type: 'set-approach-enabled'; id: string; enabled: boolean }
  | { type: 'set-agent-enabled'; name: string; enabled: boolean }
  | { type: 'save-agent-file'; name: string; body: string }
  | { type: 'create-agent'; name: string }
  | { type: 'delete-agent'; name: string }
  | { type: 'request-state' }
  | { type: 'get-approach-command-body'; approachId: string; command: string }
  | { type: 'fetch-ticket-statuses'; listId: string; teamId?: string }
  | { type: 'fetch-ticket-lists'; teamId: string }
  | { type: 'browse-repo-path'; name: string }
  | { type: 'open-manifest' }
  /**
   * Reveal the effective prompt for a graph prompt identity (`karst-graph-planner`
   * / `karst-graph-node`). The identity is a closed set — the host resolves it
   * against the stable override registry and refuses anything else.
   */
  | { type: 'open-graph-prompt'; identity: string };

/** Host → webview messages. */
export type SettingsHostMessage =
  | { type: 'state'; state: SettingsState }
  | { type: 'models'; models: ModelCatalog; modelCompatibility: ModelCatalog }
  /** Fresh host-computed views for the inside-process assignment rows. */
  | { type: 'process-assignment-views'; rows: SettingsProcessAssignmentView[] }
  | { type: 'validation'; ok: boolean; error: string | null }
  | { type: 'error'; message: string }
  /** `section` echoes back which tab was committed, so the page can say so. */
  | { type: 'saved'; section?: SettingsSection }
  | { type: 'approach-command-body'; approachId: string; command: string; body: string }
  | { type: 'ticket-statuses'; statuses: string[] }
  | { type: 'ticket-statuses-error'; message: string }
  | { type: 'ticket-lists'; lists: TicketList[] }
  | { type: 'ticket-lists-error'; message: string }
  /**
   * Whether a ticketing token is stored, on its own message. Deliberately NOT a
   * `state` push: state carries the manifest and replaces the webview's draft,
   * so reporting the token that way discarded whatever the user had entered but
   * not yet saved — which, during first-time setup, is the provider itself.
   */
  | { type: 'token-state'; configured: boolean }
  | { type: 'repo-path-picked'; name: string; path: string }
  | ActionResultMessage;

/**
 * The host-side effects a settings panel can trigger.
 *
 * Every method's return type is widened from `() => void` to
 * `() => void | Promise<void>` (§ `docs/ui/DESIGN-SYSTEM.md` §5.3, UI-R13) — a
 * TYPE WIDENING, so every existing implementation still satisfies it. The
 * single dispatch seam in `panel.ts` awaits whatever comes back and reports the
 * real terminal outcome as `action-result`; a method that keeps returning
 * `void` keeps its exact current semantics (an immediate ack).
 */
export interface SettingsActions {
  /** Persist the draft; `section` narrows the write to that tab's fields. */
  save(manifest: Manifest, section?: SettingsSection): void | Promise<void>;
  validate(manifest: Manifest): void | Promise<void>;
  /** Post host-computed process-assignment row views for the draft (handoff §7). */
  validateProcessAssignments(manifest: Manifest): void | Promise<void>;
  installApproach(id: string): void | Promise<void>;
  uninstallApproach(id: string): void | Promise<void>;
  /** Prompt (host-side) for and store the ClickUp token. Token never crosses the webview. */
  setToken(): void | Promise<void>;
  /** Clear the stored ClickUp token. */
  clearToken(): void | Promise<void>;
  /** Flip an approach's `enabled` flag in the manifest and persist. */
  setApproachEnabled(id: string, enabled: boolean): void | Promise<void>;
  /** Flip an agent's `enabled` flag (manifest `agents[name]`) and persist. */
  setAgentEnabled(name: string, enabled: boolean): void | Promise<void>;
  /** Write an agent file's full body (create or overwrite). */
  saveAgentFile(name: string, body: string): void | Promise<void>;
  /** Create a new agent file from a starter template. */
  createAgent(name: string): void | Promise<void>;
  /** Remove an agent file. */
  deleteAgent(name: string): void | Promise<void>;
  requestState(): void | Promise<void>;
  /** Read a command's markdown body (native command file or generated orchestrator). */
  getApproachCommandBody(approachId: string, command: string): void | Promise<void>;
  /**
   * Load the provider's status names for the settings draft's list. Takes the
   * ids from the DRAFT (not the saved manifest) so Refresh works before Save.
   */
  fetchTicketStatuses(listId: string, teamId?: string): void | Promise<void>;
  /** Load the workspace's lists for the settings List picker, from the draft's
   *  teamId (so Refresh works before Save). */
  fetchTicketLists(teamId: string): void | Promise<void>;
  /** Open a native folder picker for a repository's repoPath. */
  browseRepoPath(name: string): void | Promise<void>;
  /** Open this window's karst.yml in an editor (`karst.openManifest`). */
  openManifest(): void | Promise<void>;
  /** Reveal the effective prompt file for a graph prompt identity. */
  openGraphPrompt(identity: string): void | Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow an untrusted webview message. Guards only the ENVELOPE — that `manifest`
 * is an object for save/validate. Full manifest validation is `validateManifest`
 * downstream, so a well-formed envelope with a bad manifest still reaches the
 * host (which reports the validation error), while junk shapes are dropped here.
 */
export function parseSettingsMessage(raw: unknown): SettingsWebviewMessage | null {
  if (!isRecord(raw)) return null;
  const str = (k: string): boolean => typeof raw[k] === 'string' && (raw[k] as string).length > 0;

  switch (raw.type) {
    case 'save': {
      if (!isRecord(raw.manifest)) return null;
      // An unrecognized section is DROPPED, never downgraded to a whole-manifest
      // save — widening the write is the failure mode this scoping exists to stop.
      if (raw.section !== undefined && !isSettingsSection(raw.section)) return null;
      return {
        type: 'save',
        manifest: raw.manifest as unknown as Manifest,
        ...(raw.section !== undefined ? { section: raw.section as SettingsSection } : {}),
      };
    }
    case 'validate':
      return isRecord(raw.manifest) ? { type: 'validate', manifest: raw.manifest as unknown as Manifest } : null;
    case 'validate-process-assignments':
      return isRecord(raw.manifest)
        ? { type: 'validate-process-assignments', manifest: raw.manifest as unknown as Manifest }
        : null;
    case 'install-approach':
      return str('id') ? { type: 'install-approach', id: raw.id as string } : null;
    case 'uninstall-approach':
      return str('id') ? { type: 'uninstall-approach', id: raw.id as string } : null;
    case 'set-token':
      return { type: 'set-token' };
    case 'clear-token':
      return { type: 'clear-token' };
    case 'set-approach-enabled':
      return str('id') && typeof raw.enabled === 'boolean'
        ? { type: 'set-approach-enabled', id: raw.id as string, enabled: raw.enabled }
        : null;
    case 'set-agent-enabled':
      return str('name') && typeof raw.enabled === 'boolean'
        ? { type: 'set-agent-enabled', name: raw.name as string, enabled: raw.enabled }
        : null;
    case 'save-agent-file':
      return str('name') && typeof raw.body === 'string'
        ? { type: 'save-agent-file', name: raw.name as string, body: raw.body }
        : null;
    case 'create-agent':
      return str('name') ? { type: 'create-agent', name: raw.name as string } : null;
    case 'delete-agent':
      return str('name') ? { type: 'delete-agent', name: raw.name as string } : null;
    case 'request-state':
      return { type: 'request-state' };
    case 'get-approach-command-body':
      return str('approachId') && str('command')
        ? { type: 'get-approach-command-body', approachId: raw.approachId as string, command: raw.command as string }
        : null;
    case 'fetch-ticket-statuses': {
      if (!str('listId')) return null;
      if (raw.teamId !== undefined && typeof raw.teamId !== 'string') return null;
      return {
        type: 'fetch-ticket-statuses',
        listId: raw.listId as string,
        ...(raw.teamId ? { teamId: raw.teamId as string } : {}),
      };
    }
    case 'fetch-ticket-lists':
      return str('teamId') ? { type: 'fetch-ticket-lists', teamId: raw.teamId as string } : null;
    case 'browse-repo-path':
      return str('name') ? { type: 'browse-repo-path', name: raw.name as string } : null;
    case 'open-manifest':
      return { type: 'open-manifest' };
    case 'open-graph-prompt':
      return str('identity') ? { type: 'open-graph-prompt', identity: raw.identity as string } : null;
    default:
      return null;
  }
}

/**
 * Route an untrusted webview message to the matching action; ignore junk.
 *
 * Returns whatever the matched action returns (`void` or a `Promise<void>`) so
 * the single dispatch seam in `panel.ts` can await it and report one terminal
 * `action-result`. An unparsed message returns `undefined` WITHOUT calling any
 * action — `panel.ts` uses `parseSettingsMessage` itself to tell "dispatched,
 * settled synchronously" apart from "never dispatched" before it decides
 * whether to report anything at all.
 */
export function routeSettingsAction(raw: unknown, actions: SettingsActions): void | Promise<void> {
  const msg = parseSettingsMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'save':
      return actions.save(msg.manifest, msg.section);
    case 'validate':
      return actions.validate(msg.manifest);
    case 'validate-process-assignments':
      return actions.validateProcessAssignments(msg.manifest);
    case 'install-approach':
      return actions.installApproach(msg.id);
    case 'uninstall-approach':
      return actions.uninstallApproach(msg.id);
    case 'set-token':
      return actions.setToken();
    case 'clear-token':
      return actions.clearToken();
    case 'set-approach-enabled':
      return actions.setApproachEnabled(msg.id, msg.enabled);
    case 'set-agent-enabled':
      return actions.setAgentEnabled(msg.name, msg.enabled);
    case 'save-agent-file':
      return actions.saveAgentFile(msg.name, msg.body);
    case 'create-agent':
      return actions.createAgent(msg.name);
    case 'delete-agent':
      return actions.deleteAgent(msg.name);
    case 'request-state':
      return actions.requestState();
    case 'get-approach-command-body':
      return actions.getApproachCommandBody(msg.approachId, msg.command);
    case 'fetch-ticket-statuses':
      return actions.fetchTicketStatuses(msg.listId, msg.teamId);
    case 'fetch-ticket-lists':
      return actions.fetchTicketLists(msg.teamId);
    case 'browse-repo-path':
      return actions.browseRepoPath(msg.name);
    case 'open-manifest':
      return actions.openManifest();
    case 'open-graph-prompt':
      return actions.openGraphPrompt(msg.identity);
  }
}
