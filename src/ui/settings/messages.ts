import type { Manifest } from '../../manifest/types.js';
import type { SettingsState } from './state.js';
import type { TicketList } from '../../integrations/ticketing.js';

/** Webview → host messages. The webview is untrusted; parse before use. */
export type SettingsWebviewMessage =
  | { type: 'save'; manifest: Manifest }
  | { type: 'validate'; manifest: Manifest }
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
  | { type: 'fetch-ticket-lists'; teamId: string };

/** Host → webview messages. */
export type SettingsHostMessage =
  | { type: 'state'; state: SettingsState }
  | { type: 'validation'; ok: boolean; error: string | null }
  | { type: 'error'; message: string }
  | { type: 'saved' }
  | { type: 'approach-command-body'; approachId: string; command: string; body: string }
  | { type: 'ticket-statuses'; statuses: string[] }
  | { type: 'ticket-statuses-error'; message: string }
  | { type: 'ticket-lists'; lists: TicketList[] }
  | { type: 'ticket-lists-error'; message: string };

/** The host-side effects a settings panel can trigger. */
export interface SettingsActions {
  save(manifest: Manifest): void;
  validate(manifest: Manifest): void;
  installApproach(id: string): void;
  uninstallApproach(id: string): void;
  /** Prompt (host-side) for and store the ClickUp token. Token never crosses the webview. */
  setToken(): void;
  /** Clear the stored ClickUp token. */
  clearToken(): void;
  /** Flip an approach's `enabled` flag in the manifest and persist. */
  setApproachEnabled(id: string, enabled: boolean): void;
  /** Flip an agent's `enabled` flag (manifest `agents[name]`) and persist. */
  setAgentEnabled(name: string, enabled: boolean): void;
  /** Write an agent file's full body (create or overwrite). */
  saveAgentFile(name: string, body: string): void;
  /** Create a new agent file from a starter template. */
  createAgent(name: string): void;
  /** Remove an agent file. */
  deleteAgent(name: string): void;
  requestState(): void;
  /** Read a command's markdown body (native command file or generated orchestrator). */
  getApproachCommandBody(approachId: string, command: string): void;
  /**
   * Load the provider's status names for the settings draft's list. Takes the
   * ids from the DRAFT (not the saved manifest) so Refresh works before Save.
   */
  fetchTicketStatuses(listId: string, teamId?: string): void;
  /** Load the workspace's lists for the settings List picker, from the draft's
   *  teamId (so Refresh works before Save). */
  fetchTicketLists(teamId: string): void;
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
    case 'save':
      return isRecord(raw.manifest) ? { type: 'save', manifest: raw.manifest as unknown as Manifest } : null;
    case 'validate':
      return isRecord(raw.manifest) ? { type: 'validate', manifest: raw.manifest as unknown as Manifest } : null;
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
    default:
      return null;
  }
}

/** Route an untrusted webview message to the matching action; ignore junk. */
export function routeSettingsAction(raw: unknown, actions: SettingsActions): void {
  const msg = parseSettingsMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'save':
      actions.save(msg.manifest);
      return;
    case 'validate':
      actions.validate(msg.manifest);
      return;
    case 'install-approach':
      actions.installApproach(msg.id);
      return;
    case 'uninstall-approach':
      actions.uninstallApproach(msg.id);
      return;
    case 'set-token':
      actions.setToken();
      return;
    case 'clear-token':
      actions.clearToken();
      return;
    case 'set-approach-enabled':
      actions.setApproachEnabled(msg.id, msg.enabled);
      return;
    case 'set-agent-enabled':
      actions.setAgentEnabled(msg.name, msg.enabled);
      return;
    case 'save-agent-file':
      actions.saveAgentFile(msg.name, msg.body);
      return;
    case 'create-agent':
      actions.createAgent(msg.name);
      return;
    case 'delete-agent':
      actions.deleteAgent(msg.name);
      return;
    case 'request-state':
      actions.requestState();
      return;
    case 'get-approach-command-body':
      actions.getApproachCommandBody(msg.approachId, msg.command);
      return;
    case 'fetch-ticket-statuses':
      actions.fetchTicketStatuses(msg.listId, msg.teamId);
      return;
    case 'fetch-ticket-lists':
      actions.fetchTicketLists(msg.teamId);
      return;
  }
}
