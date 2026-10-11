import { describe, expect, it, vi } from 'vitest';
import {
  mailPointer,
  notesPointer,
  fixPointer,
  makeRoutedDelivery,
  makeTerminalDelivery,
  messagePointer,
  type MessageDelivery,
  type MessageRoute,
} from './messageDelivery.js';

const CLI = (cmd: string): string => `run node "$KARST_CLI" ${cmd} --db "$KARST_DB" --ticket "$KARST_TICKET_ID"`;

describe('messagePointer', () => {
  it('mcp: names the tool, no shell, no paths', () => {
    expect(messagePointer(mailPointer(3), 'mcp')).toBe('karst: 3 new message(s) - call the karst MCP tool "inbox"');
    expect(messagePointer(notesPointer(2), 'mcp')).toBe('karst: 2 new project note(s) - call the karst MCP tool "notes"');
    expect(messagePointer(fixPointer(12), 'mcp')).toBe(
      'karst: fix brief #12 ready - call the karst MCP tool "fix-brief" with ack: true',
    );
  });

  it('cli-env: "$KARST_*" refs only', () => {
    expect(messagePointer(mailPointer(3), 'cli-env')).toBe(`karst: 3 new message(s) - ${CLI('inbox')}`);
    expect(messagePointer(notesPointer(2), 'cli-env')).toBe(`karst: 2 new project note(s) - ${CLI('notes')}`);
    expect(messagePointer(fixPointer(12), 'cli-env')).toBe(
      'karst: fix brief #12 ready - run node "$KARST_CLI" fix-brief --ack --db "$KARST_DB" --ticket "$KARST_TICKET_ID"',
    );
  });

  it.each(['mcp', 'cli-env'] as const)('%s: never carries a host path, body, title or ticket key', (channel) => {
    for (const p of [mailPointer(1), notesPointer(1), fixPointer(1)]) {
      const line = messagePointer(p, channel);
      expect(line).not.toMatch(/\/(Users|home)\/|\.js|\.db|\.yml|title|body|NDL-/i);
      expect(line).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('carries digits only for the count and id', () => {
    expect(() => messagePointer(mailPointer(-1), 'mcp')).toThrow();
    expect(() => messagePointer(mailPointer(1.5), 'cli-env')).toThrow();
    expect(() => messagePointer(fixPointer(0), 'mcp')).toThrow(/delivery id/);
    expect(() => messagePointer(fixPointer(1.5), 'cli-env')).toThrow();
  });
});

describe('makeTerminalDelivery', () => {
  function deps(over: Partial<Parameters<typeof makeTerminalDelivery>[0]> = {}) {
    return {
      isLive: vi.fn(() => true),
      graphOwned: vi.fn(() => false),
      nudge: vi.fn(() => true),
      sessionChannel: vi.fn((): 'mcp' | 'cli-env' => 'cli-env'),
      ...over,
    };
  }

  it('nudges a live, non-graph recipient with the pointer', () => {
    const d = deps();
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('delivered');
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(mailPointer(2), 'cli-env'));
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
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(mailPointer(2), 'cli-env'));
  });

  it('types the MCP pointer into a session that registered the karst MCP server', () => {
    const d = deps({ sessionChannel: vi.fn((): 'mcp' | 'cli-env' => 'mcp') });
    expect(makeTerminalDelivery(d).deliver(5, mailPointer(2))).toBe('delivered');
    expect(d.nudge).toHaveBeenCalledWith(5, messagePointer(mailPointer(2), 'mcp'));
    expect(d.sessionChannel).toHaveBeenCalledWith(5);
  });

  it('defers when the nudge finds no terminal', () => {
    expect(makeTerminalDelivery(deps({ nudge: vi.fn(() => false) })).deliver(5, mailPointer(1))).toBe('deferred');
  });
});

describe('makeTerminalDelivery — notes kind', () => {
  it('nudges the notes pointer', () => {
    const nudge = vi.fn(() => true);
    const d = makeTerminalDelivery({
      isLive: () => true,
      graphOwned: () => false,
      nudge,
      sessionChannel: () => 'mcp',
    });
    expect(d.deliver(5, notesPointer(2))).toBe('delivered');
    expect(nudge).toHaveBeenCalledWith(5, messagePointer(notesPointer(2), 'mcp'));
  });
});
