/**
 * Ticket-label template engine. The label shown in the sidebar list, dashboard
 * tab, and spin picker is a user-configurable template string with `{var}`
 * tokens. The default reproduces the historical `"<key> — <title>"` convention
 * byte-for-byte, so surfaces that don't pass a template are unchanged.
 *
 * vscode-free and pure — unit-tested under vitest.
 */

/** The default template — matches the pre-config `ticketLabel` output exactly. */
export const DEFAULT_TICKET_LABEL_TEMPLATE = '{key} — {title}';

/** The variable tokens a template may substitute (surfaced in the settings hint). */
export const TICKET_LABEL_VARIABLES = [
  'key',
  'title',
  'id',
  'status',
  'stage',
  'repos',
] as const;

/** The minimal ticket shape the label engine reads (structural; `Ticket` fits). */
export interface TicketLabelFields {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  selectedRepos: string[];
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
  };
}

/**
 * Render a ticket's label from a template. Blank/absent template → the default.
 * Unknown `{tokens}` render empty (never leak a raw brace; forward-compatible).
 * A template whose result trims to empty (e.g. only `{status}` on a fresh ticket)
 * falls back to the default so a row is never blank.
 */
export function renderTicketLabel(ticket: TicketLabelFields, template?: string): string {
  const tpl = template && template.trim() !== '' ? template : DEFAULT_TICKET_LABEL_TEMPLATE;
  const vars = substitutions(ticket);
  const rendered = tpl.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : '',
  );
  if (rendered.trim() !== '') return rendered;
  // Only-empty result: fall back to the default (which is always non-empty since
  // `{key}` degrades to `#<id>`), guarding against a blank row.
  if (tpl === DEFAULT_TICKET_LABEL_TEMPLATE) return rendered;
  return renderTicketLabel(ticket, DEFAULT_TICKET_LABEL_TEMPLATE);
}
