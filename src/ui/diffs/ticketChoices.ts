export interface DiffsTicketChoice {
  ticketId: number;
  label: string;
  description: string;
  /** True for the ticket currently shown in the tree. */
  current: boolean;
}

/**
 * The project scope a ticket query MUST carry. The store is shared by every
 * IDE window, so an unscoped `listTickets` would list another project's tickets
 * (`docs/arch/store-and-schema.md`, "Projects scope the board across IDE
 * windows"). A window with no bound project has no safe scope to read, so this
 * returns `null` — the caller refuses rather than querying unscoped.
 */
export function diffsTicketScope(projectId: number | undefined): { projectId: number } | null {
  return projectId === undefined ? null : { projectId };
}

/**
 * The selector's options: the project's ACTIVE tickets, most recent first.
 *
 * "Active" is exactly `listTickets` (which already excludes archived tickets)
 * minus anything at `done`. The currently shown ticket is marked so the host
 * can float it to the top and pre-highlight it.
 */
export function diffsTicketChoices(
  tickets: readonly { id: number; key: string | null; title: string | null; stageCurrent: string | null }[],
  currentTicketId: number | null,
): DiffsTicketChoice[] {
  const choices: DiffsTicketChoice[] = [];
  let current: DiffsTicketChoice | undefined;
  for (const t of tickets) {
    if (t.stageCurrent === 'done') continue;
    const choice: DiffsTicketChoice = {
      ticketId: t.id,
      label: t.key ?? `#${t.id}`,
      description: t.title ?? '',
      current: t.id === currentTicketId,
    };
    if (choice.current && current === undefined) {
      current = choice;
    } else {
      choices.push(choice);
    }
  }
  return current === undefined ? choices : [current, ...choices];
}
