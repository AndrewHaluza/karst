import type { Store } from '../../store/db.js';
import { unreadNoteIndex } from '../../store/bulletinNotes.js';
import { unreadCount } from '../../store/ticketMessages.js';
import type { VisitMailboxFacts } from './visitMailbox.js';

/** The graph TICKET's pending mail and notes, read from the unread rows. */
export function visitMailboxFacts(store: Store, ticketId: number): Omit<VisitMailboxFacts, 'completing'> {
  const notes = unreadNoteIndex(store, ticketId);
  return { unreadMail: unreadCount(store, ticketId), unreadNotes: notes.count, noteTitles: notes.titles };
}
