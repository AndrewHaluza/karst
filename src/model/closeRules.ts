import { isFinishedStage } from './types.js';

/**
 * Whether the dashboard offers Close / Reopen (`@arch:STAGEMACH`). Mirrors the
 * writer (`workflow/closeTicket.ts`): an unfinished ticket can be closed, only a
 * closed one can be reopened, and an archived ticket is out of both. The webview
 * never re-derives either; it reads the host's flags.
 */
export function canCloseTicket(t: {
  stageCurrent: string | null;
  archivedAt: string | null;
}): boolean {
  return t.archivedAt === null && !isFinishedStage(t.stageCurrent);
}

export function canReopenTicket(t: {
  stageCurrent: string | null;
  archivedAt: string | null;
}): boolean {
  return t.archivedAt === null && t.stageCurrent === 'closed';
}
