/**
 * The conventional-commit type vocabulary a ticket may carry.
 *
 * Curated, not free text: the value is interpolated into branch names, commit
 * messages and pull-request titles — public metadata nobody rewrites afterwards —
 * so it is validated at every write boundary (store writer, manifest default,
 * analyzer output) rather than trusted from whoever supplied it.
 */
export const TICKET_TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'perf',
  'ci',
  'build',
  'style',
  'revert',
] as const;

export type TicketType = (typeof TICKET_TYPES)[number];

/** Type a ticket renders as when it has none and the manifest sets no default. */
export const DEFAULT_TICKET_TYPE: TicketType = 'feat';

/** Whether `value` is one of the curated types (exact, lowercase). */
export function isTicketType(value: unknown): value is TicketType {
  return typeof value === 'string' && (TICKET_TYPES as readonly string[]).includes(value);
}
