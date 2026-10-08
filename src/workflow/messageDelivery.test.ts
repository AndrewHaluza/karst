import { describe, expect, it, vi } from 'vitest';
import {
  mailPointer,
  notesPointer,
  makeRoutedDelivery,
  makeTerminalDelivery,
  messagePointer,
  type MessageDelivery,
  type MessageRoute,
} from './messageDelivery.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

describe('messagePointer', () => {
  it('uses env refs when the session exported them, with no ticket key', () => {
    const p = messagePointer(mailPointer(3), 42, { cli: true, manifest: true, ticket: true }, LITERAL);
    expect(p).toBe(
      'karst: 3 new message(s) - run node "$KARST_CLI" inbox --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket "$KARST_TICKET"',
    );
  });

  it('falls back to literal paths and the numeric ticket id', () => {
    const p = messagePointer(mailPointer(1), 42, undefined, LITERAL);
    expect(p).toBe(
      'karst: 1 new message(s) - run node "/ext/dist/cli.js" inbox --db "/g/karst.db" --manifest "/w/karst.yml" --ticket 42',
    );
  });

  it('contains only printable ASCII, even from a hostile path', () => {
    const p = messagePointer(mailPointer(2), 7, undefined, { cli: '/a\u001b[31m\nrm -rf /x', db: '/d\u0007b' });
    expect(p).toMatch(/^[\x20-\x7e]+$/);
    expect(p).not.toContain('\n');
  });

  it.each(['/a"b', '/a$b', '/a`b', '/a\\b', "/a'b"])('refuses a literal path with shell metacharacters (%s)', (bad) => {
    expect(messagePointer(mailPointer(1), 7, undefined, { ...LITERAL, db: bad })).toBeNull();
    expect(messagePointer(mailPointer(1), 7, undefined, { ...LITERAL, manifest: bad })).toBeNull();
  });

  it('env refs make an unsafe literal irrelevant', () => {
    expect(messagePointer(mailPointer(1), 7, { cli: true, manifest: true, ticket: true }, { cli: '/a"b', db: '/x$' })).not.toBeNull();
  });

  it('carries digits only for the count and id', () => {
    expect(() => messagePointer(mailPointer(-1), 7, undefined, LITERAL)).toThrow();
    expect(() => messagePointer(mailPointer(1.5), 7, undefined, LITERAL)).toThrow();
    expect(() => messagePointer(mailPointer(1), 0, undefined, LITERAL)).toThrow();
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
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('delivered');
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(mailPointer(2), 5, undefined, LITERAL));
  });

  it('defers when not live in this window', () => {
    const d = deps({ isLive: vi.fn(() => false) });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('defers a graph-owned recipient', () => {
    const d = deps({ graphOwned: vi.fn(() => true) });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('defers a busy agy recipient and types nothing', () => {
    const d = deps({ agyBusy: vi.fn(() => true) });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('delivers once the agy session reports idle', () => {
    const d = deps({ agyBusy: vi.fn(() => false) });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('delivered');
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(mailPointer(2), 5, undefined, LITERAL));
  });

  it('defers (types nothing) when a literal path is unsafe', () => {
    const d = deps({ literal: () => ({ ...LITERAL, cli: '/x/$(rm)/cli.js' }) });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(1))).toBe('deferred');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('defers when the nudge finds no terminal', () => {
    expect(makeTerminalDelivery(deps({ nudge: vi.fn(() => false) })).deliver(5, mailPointer(1))).toBe('deferred');
  });
});

describe('messagePointer — notes kind', () => {
  it('renders the notes pointer with the notes command and env refs', () => {
    const p = messagePointer(notesPointer(2), 42, { cli: true, manifest: true, ticket: true }, LITERAL);
    expect(p).toBe(
      'karst: 2 new project note(s) - run node "$KARST_CLI" notes --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket "$KARST_TICKET"',
    );
  });

  it('falls back to literal paths and the numeric ticket id', () => {
    expect(messagePointer(notesPointer(1), 42, undefined, LITERAL)).toBe(
      'karst: 1 new project note(s) - run node "/ext/dist/cli.js" notes --db "/g/karst.db" --manifest "/w/karst.yml" --ticket 42',
    );
  });

  it('never names a body, title or ticket key', () => {
    const p = messagePointer(notesPointer(3), 42, undefined, LITERAL);
    expect(p).not.toMatch(/P-1|title|body/i);
  });

  it('refuses an unsafe literal path just like mail', () => {
    expect(messagePointer(notesPointer(1), 7, undefined, { ...LITERAL, db: '/x$y' })).toBeNull();
  });

  it('makeTerminalDelivery nudges the notes pointer', () => {
    const nudge = vi.fn(() => true);
    const d = makeTerminalDelivery({
      isLive: () => true,
      graphOwned: () => false,
      nudge,
      sessionCliEnv: () => undefined,
      literal: () => LITERAL,
    });
    expect(d.deliver(5, notesPointer(2))).toBe('delivered');
    expect(nudge).toHaveBeenCalledWith(5, messagePointer(notesPointer(2), 5, undefined, LITERAL));
  });
});
