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
  markerNudgeText,
} from './messageDelivery.js';

const CLI = (cmd: string): string => `run node "$KARST_CLI" ${cmd} --db "$KARST_DB" --ticket "$KARST_TICKET_ID"`;

describe('messagePointer', () => {
  it('mcp: names the tool, no shell, no paths', () => {
    expect(messagePointer(mailPointer(3), 'mcp')).toBe('karst: 3 new message(s) - call the karst MCP tool "inbox"');
    expect(messagePointer(notesPointer(2), 'mcp')).toBe(
      'karst: 2 new project note(s) - call the karst MCP tool "notes"; informational, then continue your current task - a note never ends your turn',
    );
    expect(messagePointer(fixPointer(12, 'fix'), 'mcp')).toBe(
      'karst: fix brief #12 ready - call the karst MCP tool "fix-brief" with ack: true; when the fix is committed and checks pass, fire the done marker: call the karst MCP tool "stage" with { stage: "fix" }',
    );
  });

  it('cli-env: "$KARST_*" refs only', () => {
    expect(messagePointer(mailPointer(3), 'cli-env')).toBe(`karst: 3 new message(s) - ${CLI('inbox')}`);
    expect(messagePointer(notesPointer(2), 'cli-env')).toBe(
      `karst: 2 new project note(s) - ${CLI('notes')}; informational, then continue your current task - a note never ends your turn`,
    );
    expect(messagePointer(fixPointer(12, 'fix'), 'cli-env')).toBe(
      'karst: fix brief #12 ready - run node "$KARST_CLI" fix-brief --ack --db "$KARST_DB" --ticket "$KARST_TICKET_ID"; when the fix is committed and checks pass, fire the done marker: run node "$KARST_CLI" stage fix pass --db "$KARST_DB" --ticket "$KARST_TICKET_ID"',
    );
  });

  it('sandbox: the fix pointer names emit-marker, never the host CLI or MCP', () => {
    const line = messagePointer(fixPointer(12, 'fix'), { kind: 'sandbox', runDir: '/run/7', core: 'claude' });
    expect(line).toContain('fire the done marker: run node /run/7/claude/emit-marker.cjs /run/7/events.ndjson fix');
    expect(line).not.toMatch(/KARST_CLI|MCP tool/);
  });

  it.each(['uat', 'review', 'ship'])('fix pointer at gate stage %s: no marker command', (stage) => {
    for (const ch of ['mcp', 'cli-env', { kind: 'sandbox', runDir: '/run/7', core: 'claude' }] as const) {
      const line = messagePointer(fixPointer(12, stage), ch);
      expect(line).toContain(`the ticket is at ${stage}, which gate exit codes decide - commit and push the fix; there is no marker to fire.`);
      expect(line).not.toMatch(/done marker|stage fix|emit-marker|"stage"/);
    }
  });

  it('fix pointer at fix/impl keeps the marker clause', () => {
    expect(messagePointer(fixPointer(12, 'fix'), 'mcp')).toContain('{ stage: "fix" }');
    expect(messagePointer(fixPointer(12, 'impl'), 'mcp')).toContain('{ stage: "impl" }');
  });

  it.each(['mcp', 'cli-env'] as const)('%s: the notes pointer tells the agent to keep working', (channel) => {
    const notes = messagePointer(notesPointer(4), channel);
    expect(notes).toContain('informational');
    expect(notes).toContain('continue your current task');
    expect(notes).toContain('a note never ends your turn');
    // Only notes carry it: mail and fix never end the turn either, but their wording is unchanged.
    expect(messagePointer(mailPointer(4), channel)).not.toContain('informational');
    expect(messagePointer(fixPointer(4), channel)).not.toContain('informational');
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

describe('markerNudgeText', () => {
  it('names the done marker in the recipient channel form', () => {
    expect(markerNudgeText('fix', 'mcp')).toContain('call the karst MCP tool "stage" with { stage: "fix" }');
    expect(markerNudgeText('impl', 'cli-env')).toContain('stage impl pass');
    expect(markerNudgeText('impl', 'mcp')).toContain('If you need the user, ask plainly and end your turn.');
  });
});
