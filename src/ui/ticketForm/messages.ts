import type { TicketFormState } from './state.js';
import type { ContextBrief } from '../../integrations/ticketing.js';
import { isHttpUrl } from '../shared/url.js';
import { isKnownProvider } from '../../agent/registry.js';
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';
import type { ActionResultMessage } from '../../model/actionResult.js';

/**
 * Ticket-form webview ↔ host message protocol (§ ticket form). The webview is a
 * trust boundary: `parseTicketFormMessage` validates every discriminant AND its
 * companion fields before anything reaches a host action (which may touch the
 * filesystem or spawn the agent). Mirrors dashboard/messages.ts.
 */

export interface TicketDraftFields {
  key: string;
  title: string;
  description: string;
  repos: string[];
  approach: string | null;
  agent: string | null;
  model: string | null;
  /** Per-ticket agent-core override; null = inherit the manifest default. */
  agentProvider?: string | null;
  /**
   * Conventional-commit type for `{type}`. Named `ticketType`, not `type`,
   * because these fields are spread into messages whose own discriminant is
   * `type`. Null = inherit the manifest default.
   */
  ticketType: string | null;
}

/**
 * What `submit` carries beyond the persisted draft: the launch-only pull
 * switch. It is NOT a draft field — nothing about it is stored on the ticket —
 * because it decides only what THIS launch branches from. `save` launches
 * nothing, so it carries no switch.
 */
export interface SubmitFields extends TicketDraftFields {
  /**
   * Refresh each scoped repository's baseline branch from the remote before its
   * worktree is cut. Absent = ON: the default is to start from fresh code, and
   * only an explicit opt-out skips it (see `parseDraftFields`' caller).
   */
  pullBase?: boolean;
}

export type TicketFormMessage =
  | { type: 'fetch-source'; ref: string }
  | { type: 'suggest-signals'; service: string }
  | { type: 'save-signals'; service: string; signals: string[] }
  | { type: 'set-repos'; repos: string[] }
  | { type: 'set-approach'; id: string }
  | { type: 'set-agent'; id: string }
  // id may be '' — the "Inherit (settings)" choice, which clears the model.
  | { type: 'set-model'; id: string }
  // id may be '' — the "Inherit (settings)" choice, which clears the provider.
  | { type: 'set-provider'; id: string }
  // id may be '' — "Inherit (settings)", which clears the ticket's type.
  | { type: 'set-type'; id: string }
  | { type: 'analyze'; prompt: string }
  // Open the native file picker. Carries nothing — the host owns the dialog, so
  // a crafted message can neither choose a path nor pre-fill one.
  | { type: 'attach-pick' }
  // Bytes pasted from the clipboard, base64-encoded (postMessage is JSON, so a
  // Buffer cannot cross it). Capped at both ends; see the parse guard.
  | { type: 'attach-bytes'; name: string; base64: string }
  | { type: 'detach-attachment'; id: number }
  | { type: 'open-attachment'; id: number }
  | { type: 'open-ticket-link'; url: string }
  | ({ type: 'submit' } & TicketDraftFields & { pullBase: boolean })
  // Persists the ticket like `submit`, but never calls startTicket — no
  // worktrees, no agent launch. The "save without a run" path.
  | ({ type: 'save' } & TicketDraftFields)
  | { type: 'request-state' };

/**
 * The busy vocabulary is a CLOSED union (UI-R16), not `string`: the host used to
 * post `what:'suggest'` against a webview `setBusy` switch that had no `'suggest'`
 * case, so the Suggest button's pending state was silently swallowed and never
 * rendered. Every member here has a matching case in the webview's `setBusy`;
 * `webview.test.ts` pins the two together so they cannot drift apart again.
 */
export type TicketFormBusyKind = 'fetch' | 'suggest' | 'submit' | 'analyze' | 'save';

/** Host → webview messages: state pushes + async results. */
export type TicketFormHostMessage =
  | { type: 'state'; state: TicketFormState }
  | { type: 'brief'; brief: ContextBrief }
  | { type: 'signals-suggested'; service: string; signals: string[] }
  | {
      type: 'analysis';
      prompt: string;
      approachId: string;
      repos: string[];
      reason: string;
      ticketType: string;
    }
  | { type: 'error'; message: string }
  | { type: 'busy'; what: TicketFormBusyKind; on: boolean }
  | ActionResultMessage;

/**
 * The host-side side-effects a ticket form can trigger.
 *
 * Every method's return type is widened from `() => void` to
 * `() => void | Promise<void>` (§ `docs/ui/DESIGN-SYSTEM.md` §5.3, UI-R13) — a
 * TYPE WIDENING, so every existing implementation still satisfies it. The single
 * dispatch seam in `panel.ts` reports the terminal outcome as `action-result`
 * ONLY for a request that carried a `requestId`; the several actions here that
 * already self-report via `busy`/`error` posts (fetch, suggest, analyze, submit,
 * save) keep doing exactly that — their messages carry no `requestId`, so
 * `reportAction` acks and says nothing further.
 */
export interface TicketFormActions {
  fetchSource: (ref: string) => void | Promise<void>;
  suggestSignals: (service: string) => void | Promise<void>;
  saveSignals: (service: string, signals: string[]) => void | Promise<void>;
  setRepos: (repos: string[]) => void | Promise<void>;
  setApproach: (id: string) => void | Promise<void>;
  setAgent: (id: string) => void | Promise<void>;
  setModel: (id: string) => void | Promise<void>;
  setProvider: (id: string) => void | Promise<void>;
  setType: (id: string) => void | Promise<void>;
  analyze: (prompt: string) => void | Promise<void>;
  attachPick: () => Promise<void>;
  attachBytes: (name: string, base64: string) => Promise<void>;
  detachAttachment: (id: number) => Promise<void>;
  openAttachment: (id: number) => Promise<void>;
  openTicketLink: (url: string) => void | Promise<void>;
  submit: (input: SubmitFields) => void | Promise<void>;
  save: (input: TicketDraftFields) => void | Promise<void>;
  requestState: () => void | Promise<void>;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * A positive integer row id. `typeof x === 'number'` is not enough: `1.5`, `NaN`
 * and `-1` all pass it and none is a row this store can hold.
 */
function isRowId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Base64 expands 3 bytes to 4 characters, so a payload longer than this cannot
 * decode to something under the cap. Checking the ENCODED length means an
 * oversize paste is rejected before anything decodes it — the decode itself is
 * the allocation worth avoiding.
 */
const MAX_BASE64_CHARS = Math.ceil(MAX_PASTE_BYTES / 3) * 4;

/** Exact decoded size for a canonical-or-nearly-canonical base64 payload. */
function decodedBase64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Validate the shared draft-persist fields (submit and save both carry these). */
function parseDraftFields(m: Record<string, unknown>): TicketDraftFields | null {
  const str = (k: string): boolean => typeof m[k] === 'string' && (m[k] as string).length > 0;
  // description may be empty; so may key — a blank key on a manual ticket
  // means "generate one at persist time" (see actions.ts persistDraft). The
  // field must still be PRESENT (a string), just not necessarily non-empty;
  // title must be present and non-empty. repos defaults to [] and
  // approach/agent to null when absent/malformed, so an older webview (or a
  // crafted message) degrades to "no scope" rather than being rejected.
  if (!(typeof m.key === 'string' && str('title') && typeof m.description === 'string')) {
    return null;
  }
  const repos = isStringArray(m.repos) ? m.repos : [];
  const approach = typeof m.approach === 'string' && m.approach.length > 0 ? m.approach : null;
  const agent = typeof m.agent === 'string' && m.agent.length > 0 ? m.agent : null;
  const model = typeof m.model === 'string' && m.model.length > 0 ? m.model : null;
  // Blank/invalid both degrade to null (inherit), same as an absent field — a
  // crafted or stale value must never reach resolveAdapter's provider lookup.
  const agentProvider =
    typeof m.agentProvider === 'string' && isKnownProvider(m.agentProvider) ? m.agentProvider : null;
  const ticketType =
    typeof m.ticketType === 'string' && m.ticketType.length > 0 ? m.ticketType : null;
  return {
    key: m.key as string,
    title: m.title as string,
    description: m.description as string,
    repos,
    approach,
    agent,
    model,
    agentProvider,
    ticketType,
  };
}

/**
 * Narrow an untrusted webview message to an `TicketFormMessage`, validating the
 * discriminant and every companion field. Returns null for anything malformed so
 * a crafted message can't drive a host action with bad input.
 */
export function parseTicketFormMessage(raw: unknown): TicketFormMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const str = (k: string): boolean => typeof m[k] === 'string' && (m[k] as string).length > 0;

  switch (m.type) {
    case 'fetch-source':
      return str('ref') ? { type: 'fetch-source', ref: m.ref as string } : null;
    case 'suggest-signals':
      return str('service') ? { type: 'suggest-signals', service: m.service as string } : null;
    case 'save-signals':
      return str('service') && isStringArray(m.signals)
        ? { type: 'save-signals', service: m.service as string, signals: m.signals }
        : null;
    case 'set-repos':
      return isStringArray(m.repos) ? { type: 'set-repos', repos: m.repos } : null;
    case 'set-approach':
      return str('id') ? { type: 'set-approach', id: m.id as string } : null;
    case 'set-agent':
      return str('id') ? { type: 'set-agent', id: m.id as string } : null;
    case 'set-model':
      // id may be '' ("Inherit"); require the field to be a string, not non-empty.
      return typeof m.id === 'string' ? { type: 'set-model', id: m.id } : null;
    case 'set-provider':
      // '' means "Inherit"; otherwise the id must be a known implemented provider —
      // this is a trust boundary, an unrecognized value must never reach resolveAdapter.
      return typeof m.id === 'string' && (m.id === '' || isKnownProvider(m.id))
        ? { type: 'set-provider', id: m.id }
        : null;
    case 'set-type':
      // id may be '' ("Inherit"); require a string, not a non-empty one. The
      // vocabulary itself is enforced by the store writer, the single authority.
      return typeof m.id === 'string' ? { type: 'set-type', id: m.id } : null;
    case 'analyze':
      // prompt may be empty (a fetched ticket with no typed prompt yet); the
      // host has the persisted brief to reason over in that case.
      return typeof m.prompt === 'string' ? { type: 'analyze', prompt: m.prompt } : null;
    case 'attach-pick':
      return { type: 'attach-pick' };
    case 'attach-bytes': {
      // The name drives the whitelist check and the stored extension; the
      // payload is capped here as well as in the webview, because a webview
      // having checked something is not a reason for the host to skip it.
      if (typeof m.name !== 'string' || m.name.length === 0) return null;
      if (typeof m.base64 !== 'string' || m.base64.length === 0) return null;
      if (m.base64.length > MAX_BASE64_CHARS) return null;
      // Encoded length alone is not exact at the boundary: because the cap is
      // 1 mod 3, cap and cap+1 have the same base64 length and differ only in
      // padding. Keep the cheap character ceiling above, then inspect padding.
      if (decodedBase64ByteLength(m.base64) > MAX_PASTE_BYTES) return null;
      return { type: 'attach-bytes', name: m.name, base64: m.base64 };
    }
    case 'detach-attachment':
      return isRowId(m.id) ? { type: 'detach-attachment', id: m.id } : null;
    case 'open-attachment':
      return isRowId(m.id) ? { type: 'open-attachment', id: m.id } : null;
    case 'open-ticket-link':
      // http(s) only — this drives vscode.env.openExternal, so a non-empty-string
      // check is not enough (a crafted file://, vscode:// or command: URI would
      // pass it). Same guard as the dashboard's; shared so they can't diverge.
      return isHttpUrl(m.url) ? { type: 'open-ticket-link', url: m.url } : null;
    case 'submit': {
      const fields = parseDraftFields(m);
      // Default ON: only an explicit `false` opts out. An absent or non-boolean
      // value is not a choice, and reading one as "skip the pull" would let a
      // stale page (or a crafted message) silently branch off old code.
      return fields ? { type: 'submit', ...fields, pullBase: m.pullBase !== false } : null;
    }
    case 'save': {
      const fields = parseDraftFields(m);
      return fields ? { type: 'save', ...fields } : null;
    }
    case 'request-state':
      return { type: 'request-state' };
    default:
      return null;
  }
}

/**
 * Route an untrusted webview message to the matching action. Validated at this
 * boundary; unknown/malformed shapes are ignored so a stray message can't crash
 * the host.
 */
export function routeTicketFormAction(
  raw: unknown,
  actions: TicketFormActions,
): void | Promise<void> {
  const msg = parseTicketFormMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'fetch-source':
      actions.fetchSource(msg.ref);
      return;
    case 'suggest-signals':
      actions.suggestSignals(msg.service);
      return;
    case 'save-signals':
      actions.saveSignals(msg.service, msg.signals);
      return;
    case 'set-repos':
      actions.setRepos(msg.repos);
      return;
    case 'set-approach':
      actions.setApproach(msg.id);
      return;
    case 'set-agent':
      actions.setAgent(msg.id);
      return;
    case 'set-model':
      actions.setModel(msg.id);
      return;
    case 'set-provider':
      actions.setProvider(msg.id);
      return;
    case 'set-type':
      actions.setType(msg.id);
      return;
    case 'analyze':
      actions.analyze(msg.prompt);
      return;
    case 'attach-pick':
      return actions.attachPick();
    case 'attach-bytes':
      return actions.attachBytes(msg.name, msg.base64);
    case 'detach-attachment':
      return actions.detachAttachment(msg.id);
    case 'open-attachment':
      return actions.openAttachment(msg.id);
    case 'open-ticket-link':
      actions.openTicketLink(msg.url);
      return;
    case 'submit':
      // Fire-and-forget: `submit` reports its own outcome to the page (busy /
      // error / close), so the pump does not wait on the launch.
      void actions.submit({
        key: msg.key,
        title: msg.title,
        description: msg.description,
        repos: msg.repos,
        approach: msg.approach,
        agent: msg.agent,
        model: msg.model,
        agentProvider: msg.agentProvider,
        ticketType: msg.ticketType,
        pullBase: msg.pullBase,
      });
      return;
    case 'save':
      // Fire-and-forget, same as submit: `save` reports its own outcome via
      // busy/error posts.
      void actions.save({
        key: msg.key,
        title: msg.title,
        description: msg.description,
        repos: msg.repos,
        approach: msg.approach,
        agent: msg.agent,
        model: msg.model,
        agentProvider: msg.agentProvider,
        ticketType: msg.ticketType,
      });
      return;
    case 'request-state':
      actions.requestState();
      return;
  }
}
