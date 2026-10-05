import { describe, expect, it, vi } from 'vitest';
import { classifyStageEvent, makeTerminalDelivery, messagePointer } from './messageDelivery.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

describe('messagePointer', () => {
  it('uses env refs when the session exported them, with no ticket key', () => {
    const p = messagePointer(3, 42, { cli: true, manifest: true, ticket: true }, LITERAL);
    expect(p).toBe(
      'karst: 3 new message(s) - run node "$KARST_CLI" inbox --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket "$KARST_TICKET"',
    );
  });

  it('falls back to literal paths and the numeric ticket id', () => {
    const p = messagePointer(1, 42, undefined, LITERAL);
    expect(p).toBe(
      'karst: 1 new message(s) - run node "/ext/dist/cli.js" inbox --db "/g/karst.db" --manifest "/w/karst.yml" --ticket 42',
    );
  });

  it('contains only printable ASCII, even from a hostile path', () => {
    const p = messagePointer(2, 7, undefined, { cli: '/a\u001b[31m\nrm -rf /x', db: '/d\u0007b' });
    expect(p).toMatch(/^[\x20-\x7e]+$/);
    expect(p).not.toContain('\n');
  });

  it('carries digits only for the count and id', () => {
    expect(() => messagePointer(-1, 7, undefined, LITERAL)).toThrow();
    expect(() => messagePointer(1.5, 7, undefined, LITERAL)).toThrow();
    expect(() => messagePointer(1, 0, undefined, LITERAL)).toThrow();
  });
});

describe('classifyStageEvent', () => {
  it('reads landed and blocked bodies; anything else is other', () => {
    expect(classifyStageEvent('P-1-s1 landed (done)')).toBe('landed');
    expect(classifyStageEvent('P-1-s1 blocked at impl: needs creds')).toBe('blocked');
    expect(classifyStageEvent('P-1-s1 autostart failed: x (stayed at scope)')).toBe('other');
    expect(classifyStageEvent('evil landed (done) blocked at impl: x')).toBe('other');
  });
});

describe('makeTerminalDelivery', () => {
  function deps(over: Partial<Parameters<typeof makeTerminalDelivery>[0]> = {}) {
    return {
      isLive: vi.fn(() => true),
      graphOwned: vi.fn(() => false),
      nudge: vi.fn(() => true),
      sessionCliEnv: vi.fn(() => undefined),
      literal: () => LITERAL,
      ...over,
    };
  }

  it('nudges a live, non-graph recipient with the pointer', () => {
    const d = deps();
    expect(makeTerminalDelivery(d).deliver(5, 2)).toBe('delivered');
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(2, 5, undefined, LITERAL));
  });

  it('defers when not live in this window', () => {
    const d = deps({ isLive: vi.fn(() => false) });
    expect(makeTerminalDelivery(d).deliver(5, 2)).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('defers a graph-owned recipient', () => {
    const d = deps({ graphOwned: vi.fn(() => true) });
    expect(makeTerminalDelivery(d).deliver(5, 2)).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('defers when the nudge finds no terminal', () => {
    expect(makeTerminalDelivery(deps({ nudge: vi.fn(() => false) })).deliver(5, 1)).toBe('deferred');
  });
});
