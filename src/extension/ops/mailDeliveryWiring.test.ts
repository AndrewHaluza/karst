import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, setAgentState } from '../../store/tickets.js';
import { listInbox, markRead, postMessage } from '../../store/ticketMessages.js';
import { makeMailDeliveryWiring, type MailDeliveryWiringDeps } from './mailDeliveryWiring.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

let store: Store;
let projectId: number;
let recipient: number;

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  recipient = createTicket(store, { key: 'R', title: 'r', projectId }).id;
  // A hook/plugin reply only fires at a turn end, so the recipient must be
  // mid-turn for a push route to be eligible.
  setAgentState(store, recipient, 'running');
});

function send(): void {
  postMessage(store, {
    projectId,
    fromTicketId: null,
    toTicketId: recipient,
    kind: 'message',
    body: 'hello',
  });
}

function deps(over: Partial<MailDeliveryWiringDeps> = {}): MailDeliveryWiringDeps {
  return {
    store,
    projectId: () => projectId,
    isLive: () => true,
    isGraphTicket: () => false,
    integrating: () => false,
    wake: vi.fn(),
    now: () => 1_000,
    debug: vi.fn(),
    warn: vi.fn(),
    graphOwned: () => false,
    agyBusy: () => false,
    nudge: vi.fn(() => true),
    sessionCliEnv: () => undefined,
    sessionProvider: () => 'claude',
    literal: () => LITERAL,
    isCurrentHook: () => true,
    ...over,
  };
}

describe('makeMailDeliveryWiring', () => {
  it('arms a claude recipient through the hook route and replies with a block', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps());
    // Armed, not delivered: nothing is typed mid-turn.
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toEqual({
      decision: 'block',
      reason: expect.stringContaining('karst: 1 new message(s)'),
    });
  });

  it('routes a codex recipient through the hook route (spike passed)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ sessionProvider: () => 'codex', nudge }));
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
  });

  it('blocks a same-sized batch after a read through the real wiring', () => {
    send();
    send();
    const mailbox = makeMailDeliveryWiring(deps());
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // The agent reads both, then a same-sized new batch arrives.
    markRead(
      store,
      listInbox(store, recipient, { unreadOnly: true }).map((m) => m.id),
    );
    send();
    send();
    mailbox.sweep.sweep();
    // The new batch (higher watermark, same count) must block again.
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
  });

  it('a CONFIRMED hook-block reply marks the batch delivered so the sweep never types a duplicate', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ nudge }));
    // Mid-turn: armed, nothing typed.
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    // The turn ends and the endpoint replies with the block...
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // ...and the endpoint confirms the bridge actually received it.
    mailbox.onReplyDelivered(recipient);
    // A block continuation fires no UserPromptSubmit, so the agent stays
    // non-running and the mail stays unread until it runs inbox.
    setAgentState(store, recipient, 'idle');
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('onReplyDelivered is a no-op when the ticket has no blocked batch', () => {
    const mailbox = makeMailDeliveryWiring(deps());
    // A late/duplicate confirmation must never throw or invent a delivery.
    expect(() => mailbox.onReplyDelivered(recipient)).not.toThrow();
    setAgentState(store, recipient, 'idle');
    send();
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
  });

  it('a reply BUILT but never confirmed keeps the typed fallback (the lost-reply case)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ nudge }));
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    // The reply was built (blockedAt set), but the bridge timed out and never
    // received it — so no confirmation ever arrives.
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    setAgentState(store, recipient, 'idle');
    // The sweep must type the pointer rather than strand the batch.
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalled();
  });

  it('a NEW batch after a confirmed reply is still delivered (the record is per-batch)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ nudge }));
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    mailbox.onReplyDelivered(recipient);
    // The recipient is idle and a NEW message (higher watermark) arrives.
    setAgentState(store, recipient, 'idle');
    send();
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalled();
  });

  it('a declined reply does not mark the batch delivered (the sweep still types it)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ sessionProvider: () => 'opencode2', nudge }));
    // A typed route has no reply channel, so the endpoint declines.
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
    // The sweep must still type the pointer: nothing was delivered.
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalled();
  });

  it('a reply declined on a stale generation does not mark the batch delivered', () => {
    send();
    let current = true;
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ isCurrentHook: () => current, nudge }));
    // A sweep caches the count, so the top-up watermark is available...
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    // ...but the generation goes stale, so the reply is declined.
    current = false;
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
    // Nothing was delivered, so the sweep must still type the pointer.
    setAgentState(store, recipient, 'idle');
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalled();
  });

  it('refreshUnread makes a CLI send visible without waiting for a sweep', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps());
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // A `message send` (a separate CLI process) lands with no sweep in between.
    send();
    // The endpoint's per-turn top-up is what makes it visible on this Stop.
    mailbox.refreshUnread(recipient);
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toEqual({
      decision: 'block',
      reason: expect.stringContaining('karst: 2 new message(s)'),
    });
  });

  it('a send before any sweep still replies on the first turn end (top-up sets eligibility)', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps());
    // No sweep has run, so the recipient is not yet in the eligibility set...
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
    // ...and the endpoint's per-turn top-up both caches the count AND makes it
    // eligible, so the FIRST turn end gets the pointer.
    mailbox.refreshUnread(recipient);
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toEqual({
      decision: 'block',
      reason: expect.stringContaining('karst: 1 new message(s)'),
    });
  });

  it('refreshUnread does not make a typed-route recipient eligible', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps({ sessionProvider: () => 'opencode2' }));
    mailbox.refreshUnread(recipient);
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('refreshUnread drops eligibility when the route stops accepting a reply', () => {
    send();
    let provider = 'claude';
    const mailbox = makeMailDeliveryWiring(deps({ sessionProvider: () => provider }));
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // A NEW batch (higher watermark) arrives; the core has switched to a typed
    // route, so the top-up must remove eligibility rather than leave it stale.
    send();
    provider = 'opencode2';
    mailbox.refreshUnread(recipient);
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('types an armed recipient once it goes idle (the hook never arrived)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ nudge }));
    // Mid-turn: armed, nothing typed.
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
    // The turn ends with no hook: the next sweep types the pointer instead of
    // stranding the batch (the watermark was never advanced on the arm).
    setAgentState(store, recipient, 'idle');
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalledWith(recipient, expect.stringContaining('karst: 1 new message(s)'));
  });

  it('types an opencode2 recipient instead of arming a hook', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(
      deps({ sessionProvider: () => 'opencode2', nudge }),
    );
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalledWith(recipient, expect.stringContaining('karst: 1 new message(s)'));
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('uses the recipient session env for the reply pointer', () => {
    send();
    const mailbox = makeMailDeliveryWiring(
      deps({ sessionCliEnv: () => ({ cli: true, manifest: true, ticket: true }) }),
    );
    mailbox.sweep.sweep();
    const reply = mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' });
    expect(reply?.reason).toContain('"$KARST_CLI"');
  });

  it('does not reply when the launch generation is stale', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps({ isCurrentHook: () => false }));
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('does not reply for a graph-owned session (the sweep defers it too)', () => {
    send();
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ graphOwned: () => true, nudge }));
    // The sweep refuses to deliver a graph-owned recipient...
    expect(mailbox.sweep.sweep().delivered).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
    // ...and the endpoint must not answer its hook either.
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('drops reply eligibility when the recipient goes idle between sweeps', () => {
    send();
    const mailbox = makeMailDeliveryWiring(deps());
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // The next sweep rebuilds eligibility from scratch: an idle recipient must
    // fall OUT of the set, so a later hook (a new count defeats the one-block
    // guard) is not answered.
    setAgentState(store, recipient, 'idle');
    send();
    mailbox.sweep.sweep();
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('types an IDLE hook-route recipient and does not reply', () => {
    send();
    setAgentState(store, recipient, 'idle');
    const nudge = vi.fn(() => true);
    const mailbox = makeMailDeliveryWiring(deps({ nudge }));
    expect(mailbox.sweep.sweep().delivered).toEqual([recipient]);
    expect(nudge).toHaveBeenCalledWith(recipient, expect.stringContaining('karst: 1 new message(s)'));
    expect(mailbox.hookReply({ ticketId: recipient, event: 'Stop', launchId: 'L1' })).toBeNull();
  });
});
