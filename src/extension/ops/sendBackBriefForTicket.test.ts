import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { postMessage, listInbox } from '../../store/ticketMessages.js';
import { sendBackBriefForTicket, SEND_BACK_DONE_MARKER } from './sendBackBriefForTicket.js';

describe('sendBackBriefForTicket', () => {
  let store: Store;
  let id: number;
  let peer: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'PROJ-1', title: 't' }).id;
    peer = createTicket(store, { key: 'PROJ-2', title: 'p' }).id;
    setStageCurrent(store, id, 'impl');
  });
  afterEach(() => store.close());

  const post = (from: number | null, kind: 'event' | 'message', body: string): void => {
    postMessage(store, { projectId: null, fromTicketId: from, toTicketId: id, kind, body });
  };

  it('returns the latest unread host event plus the done marker', () => {
    post(null, 'event', 'old reason');
    post(null, 'event', 'CI failed');
    const brief = sendBackBriefForTicket(store, id);
    expect(brief?.text).toBe(`CI failed\n${SEND_BACK_DONE_MARKER}`);
    expect(brief?.messageIds).toHaveLength(2);
  });

  it('returns null with no unread event', () => {
    expect(sendBackBriefForTicket(store, id)).toBeNull();
  });

  it('ignores a peer-ticket message and a read event', () => {
    post(peer, 'message', 'hello from a peer');
    post(null, 'message', 'not an event');
    expect(sendBackBriefForTicket(store, id)).toBeNull();
  });

  it('returns null at the fix stage, which keeps its own brief', () => {
    post(null, 'event', 'CI failed');
    setStageCurrent(store, id, 'fix');
    expect(sendBackBriefForTicket(store, id)).toBeNull();
  });

  it('ignores an already read event', () => {
    post(null, 'event', 'done');
    const used = sendBackBriefForTicket(store, id)!;
    store.db.prepare("UPDATE ticket_messages SET read_at = 'x' WHERE id = ?").run(used.messageIds[0]);
    expect(sendBackBriefForTicket(store, id)).toBeNull();
    expect(listInbox(store, id, { unreadOnly: true })).toHaveLength(0);
  });
});
