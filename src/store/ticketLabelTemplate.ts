/**
 * Ticket-label template engine. The label shown in the sidebar list, dashboard
 * tab, and spin picker is a user-configurable template string with `{var}`
 * tokens. The default reproduces the historical `"<key> — <title>"` convention
 * byte-for-byte, so surfaces that don't pass a template are unchanged.
 *
 * vscode-free and pure — unit-tested under vitest.
 */

import { parseTemplateTokens, parseTokenBody } from '../template/token.js';
import { applyTransforms, validateTemplateTransforms } from '../template/transforms.js';
import { followUpTextPrefix } from '../model/followUp.js';

/** The default template — matches the pre-config `ticketLabel` output exactly. */
export const DEFAULT_TICKET_LABEL_TEMPLATE = '{key} — {title}';

/**
 * Terminal-name default — the historical `"Karst: <key> — <title>"` convention,
 * plus the one-char follow-up marker. `{followUp}` renders `'↳ '` for a
 * follow-up ticket and `''` otherwise, so a non-follow-up is unchanged.
 */
export const DEFAULT_TERMINAL_NAME_TEMPLATE = 'Karst: {followUp}{key} — {title}';

/** The variable tokens a template may substitute (surfaced in the settings hint). */
export const TICKET_LABEL_VARIABLES = [
  'key',
  'title',
  'id',
  'status',
  'stage',
  'repos',
  'followUp',
] as const;

/** The minimal ticket shape the label engine reads (structural; `Ticket` fits). */
export interface TicketLabelFields {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  selectedRepos: string[];
  /** Non-null when the ticket is a follow-up (domain fact — never title parsing). */
  parentTicketId: number | null;
}

/** Resolve each `{var}` to its display value, mirroring the historical fallbacks. */
function substitutions(ticket: TicketLabelFields): Record<string, string> {
  return {
    key: ticket.key ?? `#${ticket.id}`,
    title: ticket.title ?? '(untitled)',
    id: String(ticket.id),
    status: ticket.agentState ?? '',
    stage: ticket.stageCurrent ?? '',
    repos: ticket.selectedRepos.join(', '),
    followUp: followUpTextPrefix(ticket),
  };
}

/**
 * What this surface treats as a placeholder: a `\w+` variable, optionally
 * followed by a transform chain. Deliberately narrower than the shared token
 * pattern — `{not a var}` has always rendered LITERALLY here, and widening the
 * match would silently blank it in templates that predate transforms.
 */
const LABEL_TOKEN = /\{(\w+(?:\|[^{}]*)?)\}/g;

/**
 * Whether every transform in `template` is one this build can apply. Used to
 * decide between rendering the template and falling back whole.
 */
function isRenderable(template: string): boolean {
  try {
    validateLabelTemplate('template', template);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the placeholder transforms in a label-style template.
 *
 * Only TRANSFORMS are checked. Unknown VARIABLES stay legal here on purpose —
 * this surface renders them empty so a template written against a newer Karst
 * degrades instead of erroring — but an unknown transform is a typo the user
 * must see, and manifest load is where they can still fix it.
 */
export function validateLabelTemplate(field: string, template: string): void {
  validateTemplateTransforms(field, parseTemplateTokens(template));
}

/**
 * Render a ticket's label from a template. Blank/absent template → the default.
 * Unknown `{tokens}` render empty (never leak a raw brace; forward-compatible).
 * A template whose result trims to empty (e.g. only `{status}` on a fresh ticket)
 * falls back to the default so a row is never blank. A template whose transforms
 * do not validate falls back WHOLE — a half-transformed label would be worse
 * than the historical one, and manifest load already reported the mistake.
 */
export function renderTicketLabel(ticket: TicketLabelFields, template?: string): string {
  const requested = template && template.trim() !== '' ? template : DEFAULT_TICKET_LABEL_TEMPLATE;
  const tpl = isRenderable(requested) ? requested : DEFAULT_TICKET_LABEL_TEMPLATE;
  const vars = substitutions(ticket);
  const rendered = tpl.replace(LABEL_TOKEN, (_match, body: string) => {
    const { variable, transforms } = parseTokenBody(body);
    const value = Object.prototype.hasOwnProperty.call(vars, variable) ? vars[variable]! : '';
    return applyTransforms(value, transforms);
  });
  if (rendered.trim() !== '') return rendered;
  // Only-empty result: fall back to the default (which is always non-empty since
  // `{key}` degrades to `#<id>`), guarding against a blank row.
  if (tpl === DEFAULT_TICKET_LABEL_TEMPLATE) return rendered;
  return renderTicketLabel(ticket, DEFAULT_TICKET_LABEL_TEMPLATE);
}
