import { describe, expect, it, vi } from 'vitest';
import { makeHookReply, type BlockedAt, type BlockedAtFix, type MailReplyDeps } from './mailReply.js';


function deps(over: Partial<MailReplyDeps> = {}): MailReplyDeps {
  return {
    unread: () => 2,
    unreadWatermark: () => 2,
    isCurrent: () => true,
    sessionChannel: () => 'cli-env',
    blockedAt: new Map(),
    debug: vi.fn(),
    ...over,
  };
}

function blockedMap(): Map<number, BlockedAt> {
  return new Map();
}

describe('makeHookReply', () => {
  it('blocks a current-generation Stop with unread mail, using the recipient channel', () => {
    const reply = makeHookReply(
      deps({ sessionChannel: () => 'mcp' }),
    )({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    expect(reply).toEqual({
      decision: 'block',
      reason: 'karst: 2 new message(s) - call the karst MCP tool "inbox"',
    });
  });

  it('answers opencode session.idle too', () => {
    expect(
      makeHookReply(deps())({ ticketId: 42, event: 'session.idle', launchId: 'L1' }),
    ).not.toBeNull();
  });

  it('never answers an event that is not a turn end', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
      expect(makeHookReply(deps())({ ticketId: 42, event, launchId: 'L1' })).toBeNull();
    }
  });

  it('never answers a stale launch generation', () => {
    const d = deps({ isCurrent: (id, launch) => id === 42 && launch === 'CURRENT' });
    const reply = makeHookReply(d);
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'STALE' })).toBeNull();
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'CURRENT' })).not.toBeNull();
  });

  it('never answers a core whose route does not consume the reply', () => {
    expect(
      makeHookReply(deps({ shouldReply: () => false }))({
        ticketId: 42,
        event: 'Stop',
        launchId: 'L1',
      }),
    ).toBeNull();
  });

  it('never answers when the recipient has nothing unread', () => {
    expect(
      makeHookReply(deps({ unread: () => 0 }))({ ticketId: 42, event: 'Stop', launchId: 'L1' }),
    ).toBeNull();
  });

  it('never answers a continuation Stop (stop_hook_active) and keeps the block budget', () => {
    const blockedAt = blockedMap();
    const reply = makeHookReply(deps({ blockedAt }));
    // The continuation turn is not a fresh turn end: no reply...
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1', stopHookActive: true })).toBeNull();
    // ...and it did NOT spend the batch's one-block budget.
    expect(blockedAt.size).toBe(0);
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    expect(blockedAt.size).toBe(1);
  });

  it('blocks at most once per unread batch', () => {
    let watermark = 10;
    const reply = makeHookReply(deps({ unread: () => 2, unreadWatermark: () => watermark }));
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // Same batch: no second block (a core without a stop_hook_active guard
    // cannot loop forever on the same mail).
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
    watermark = 11;
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
  });

  it('blocks a same-sized new batch after a read, even with no intervening 0 sighting', () => {
    // The read's count-drop is never observed at a turn end (the agent is idle
    // between the read and the new mail), so the guard MUST key on the
    // watermark: count 2 → read → count 2 again is a NEW batch.
    let watermark = 10;
    const reply = makeHookReply(deps({ unread: () => 2, unreadWatermark: () => watermark }));
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    // Read both, then a same-sized batch arrives with a higher watermark — the
    // hook fires only for the new batch, so the count never reads 0.
    watermark = 12;
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
  });

  it('blocks again when the recipient launches a new generation', () => {
    const blockedAt = blockedMap();
    const reply = makeHookReply(deps({ blockedAt }));
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L2' })).not.toBeNull();
    // Keyed by ticket: a retired launch never leaves a second entry behind.
    expect(blockedAt.size).toBe(1);
  });

  it('drops the record when a stale generation arrives', () => {
    const blockedAt = blockedMap();
    const reply = makeHookReply(deps({ blockedAt }));
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    expect(blockedAt.size).toBe(1);
    const stale = makeHookReply(deps({ isCurrent: () => false, blockedAt }));
    expect(stale({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
    expect(blockedAt.size).toBe(0);
  });

  it('falls back to the "$KARST_*" CLI line when the session has no MCP', () => {
    const reply = makeHookReply(deps())({ ticketId: 7, event: 'Stop', launchId: 'L1' });
    expect(reply?.reason).toBe(
      'karst: 2 new message(s) - run node "$KARST_CLI" inbox --db "$KARST_DB" --ticket "$KARST_TICKET_ID"',
    );
  });
});

describe('makeHookReply — fix delivery', () => {
  const FIX_LINE =
    'karst: fix brief #9 ready - run node "$KARST_CLI" fix-brief --ack --db "$KARST_DB" --ticket "$KARST_TICKET_ID"';
  function fixDeps(over: Partial<MailReplyDeps> = {}): MailReplyDeps & { claimed: number[] } {
    const claimed: number[] = [];
    return {
      ...deps({ unread: () => 0, unreadWatermark: () => 0 }),
      fixEligible: () => 9,
      claimFixPointed: (_t, id) => {
        claimed.push(id);
        return true;
      },
      blockedAtFix: new Map<number, BlockedAtFix>(),
      claimed,
      ...over,
    };
  }

  it('blocks with the fix pointer and claims pointed_at', () => {
    const d = fixDeps();
    expect(makeHookReply(d)({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toEqual({
      decision: 'block',
      reason: FIX_LINE,
    });
    expect(d.claimed).toEqual([9]);
    expect(d.blockedAtFix!.get(42)).toEqual({ launchId: 'L1', deliveryId: 9 });
  });

  it('blocks once per delivery: the same key does not block again', () => {
    const reply = makeHookReply(fixDeps());
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('a different delivery id blocks again', () => {
    let id = 9;
    const reply = makeHookReply(fixDeps({ fixEligible: () => id }));
    reply({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    id = 10;
    expect(reply({ ticketId: 42, event: 'Stop', launchId: 'L1' })).not.toBeNull();
  });

  it('declines when another window already claimed pointed_at', () => {
    const d = fixDeps({ claimFixPointed: () => false });
    expect(makeHookReply(d)({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
  });

  it('declines on stop_hook_active and for a stale generation', () => {
    const d = fixDeps();
    expect(makeHookReply(d)({ ticketId: 42, event: 'Stop', launchId: 'L1', stopHookActive: true })).toBeNull();
    expect(d.claimed).toEqual([]);
    const stale = fixDeps({ isCurrent: () => false });
    stale.blockedAtFix!.set(42, { launchId: 'L1', deliveryId: 9 });
    stale.blockedAt.set(42, { launchId: 'L1', watermark: 1 });
    expect(makeHookReply(stale)({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
    // A retired generation clears BOTH budgets.
    expect(stale.blockedAtFix!.size).toBe(0);
    expect(stale.blockedAt.size).toBe(0);
  });

  it('respects shouldReply (typed-route cores never take the hook pointer)', () => {
    const d = fixDeps({ shouldReply: () => false });
    expect(makeHookReply(d)({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
    expect(d.claimed).toEqual([]);
  });

  it('answers session.idle too', () => {
    expect(makeHookReply(fixDeps())({ ticketId: 42, event: 'session.idle', launchId: 'L1' })).not.toBeNull();
  });

  it('fix goes first; mail follows on the next fresh turn end', () => {
    const d = fixDeps({ unread: () => 2, unreadWatermark: () => 5 });
    const reply = makeHookReply(d);
    const first = reply({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    expect(first).toMatchObject({ reason: expect.stringContaining('fix brief #9') });
    const second = reply({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    expect(second).toMatchObject({ reason: expect.stringContaining('2 new message(s)') });
  });

  it('a fix that is no longer eligible forgets its budget so a later delivery can block', () => {
    let eligible: number | null = 9;
    const d = fixDeps({ fixEligible: () => eligible });
    const reply = makeHookReply(d);
    reply({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    eligible = null;
    reply({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    expect(d.blockedAtFix!.size).toBe(0);
  });

  it('is inert when no fix deps are wired', () => {
    expect(makeHookReply(deps({ unread: () => 0 }))({ ticketId: 42, event: 'Stop', launchId: 'L1' })).toBeNull();
  });
});
