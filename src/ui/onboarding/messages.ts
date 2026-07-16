import type { OnboardingState } from './state.js';
import type { ContextBrief } from '../../integrations/ticketing.js';

/**
 * Onboarding webview ↔ host message protocol (§ onboarding). The webview is a
 * trust boundary: `parseOnboardingMessage` validates every discriminant AND its
 * companion fields before anything reaches a host action (which may touch the
 * filesystem or spawn the agent). Mirrors dashboard/messages.ts.
 */

export type OnboardingMessage =
  | { type: 'fetch-source'; ref: string }
  | { type: 'suggest-signals'; service: string }
  | { type: 'save-signals'; service: string; signals: string[] }
  | { type: 'set-repos'; repos: string[] }
  | { type: 'set-approach'; id: string }
  | { type: 'set-agent'; id: string }
  // id may be '' — the "Inherit (settings)" choice, which clears the model.
  | { type: 'set-model'; id: string }
  | { type: 'analyze'; prompt: string }
  | {
      type: 'submit';
      key: string;
      title: string;
      description: string;
      repos: string[];
      approach: string | null;
      agent: string | null;
      model: string | null;
    }
  | { type: 'request-state' };

/** Host → webview messages: state pushes + async results. */
export type OnboardingHostMessage =
  | { type: 'state'; state: OnboardingState }
  | { type: 'brief'; brief: ContextBrief }
  | { type: 'signals-suggested'; service: string; signals: string[] }
  | {
      type: 'analysis';
      prompt: string;
      approachId: string;
      repos: string[];
      reason: string;
    }
  | { type: 'error'; message: string }
  | { type: 'busy'; what: string; on: boolean };

/** The host-side side-effects an onboarding page can trigger. */
export interface OnboardingActions {
  fetchSource: (ref: string) => void;
  suggestSignals: (service: string) => void;
  saveSignals: (service: string, signals: string[]) => void;
  setRepos: (repos: string[]) => void;
  setApproach: (id: string) => void;
  setAgent: (id: string) => void;
  setModel: (id: string) => void;
  analyze: (prompt: string) => void;
  submit: (input: {
    key: string;
    title: string;
    description: string;
    repos: string[];
    approach: string | null;
    agent: string | null;
    model: string | null;
  }) => void;
  requestState: () => void;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Narrow an untrusted webview message to an `OnboardingMessage`, validating the
 * discriminant and every companion field. Returns null for anything malformed so
 * a crafted message can't drive a host action with bad input.
 */
export function parseOnboardingMessage(raw: unknown): OnboardingMessage | null {
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
    case 'analyze':
      // prompt may be empty (a fetched ticket with no typed prompt yet); the
      // host has the persisted brief to reason over in that case.
      return typeof m.prompt === 'string' ? { type: 'analyze', prompt: m.prompt } : null;
    case 'submit': {
      // description may be empty; key + title must be present. repos defaults to
      // [] and approach/agent to null when absent/malformed, so an older webview
      // (or a crafted message) degrades to "no scope" rather than being rejected.
      if (!(str('key') && str('title') && typeof m.description === 'string')) return null;
      const repos = isStringArray(m.repos) ? m.repos : [];
      const approach = typeof m.approach === 'string' && m.approach.length > 0 ? m.approach : null;
      const agent = typeof m.agent === 'string' && m.agent.length > 0 ? m.agent : null;
      const model = typeof m.model === 'string' && m.model.length > 0 ? m.model : null;
      return {
        type: 'submit',
        key: m.key as string,
        title: m.title as string,
        description: m.description as string,
        repos,
        approach,
        agent,
        model,
      };
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
export function routeOnboardingAction(raw: unknown, actions: OnboardingActions): void {
  const msg = parseOnboardingMessage(raw);
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
    case 'analyze':
      actions.analyze(msg.prompt);
      return;
    case 'submit':
      actions.submit({
        key: msg.key,
        title: msg.title,
        description: msg.description,
        repos: msg.repos,
        approach: msg.approach,
        agent: msg.agent,
        model: msg.model,
      });
      return;
    case 'request-state':
      actions.requestState();
      return;
  }
}
