import { describe, expect, it, vi } from 'vitest';
import { makeHookReply, type BlockedAt, type MailReplyDeps } from './mailReply.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

function deps(over: Partial<MailReplyDeps> = {}): MailReplyDeps {
  return {
    unread: () => 2,
    unreadWatermark: () => 2,
    isCurrent: () => true,
    sessionCliEnv: () => undefined,
    literal: () => LITERAL,
    blockedAt: new Map(),
    debug: vi.fn(),
    ...over,
  };
}

function blockedMap(): Map<number, BlockedAt> {
  return new Map();
}

describe('makeHookReply', () => {
  it('blocks a current-generation Stop with unread mail, using the recipient env', () => {
    const reply = makeHookReply(
      deps({ sessionCliEnv: () => ({ cli: true, manifest: true, ticket: true }) }),
    )({ ticketId: 42, event: 'Stop', launchId: 'L1' });
    expect(reply).toEqual({
      decision: 'block',
      reason:
        'karst: 2 new message(s) - run node "$KARST_CLI" inbox --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket "$KARST_TICKET"',
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

  it('uses literal paths when the session exported no env', () => {
    const reply = makeHookReply(deps())({ ticketId: 7, event: 'Stop', launchId: 'L1' });
    expect(reply?.reason).toContain('"/ext/dist/cli.js"');
    expect(reply?.reason).toContain('--ticket 7');
  });

  it('declines when a literal path carries a shell metacharacter', () => {
    expect(
      makeHookReply(deps({ literal: () => ({ ...LITERAL, db: '/g/$(rm)/k.db' }) }))({
        ticketId: 42,
        event: 'Stop',
        launchId: 'L1',
      }),
    ).toBeNull();
  });
});
