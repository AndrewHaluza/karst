import { describe, it, expect } from 'vitest';
import {
  GRAPH_NODE_LABEL_MAX,
  graphSessionTerminalName,
  sanitizeGraphNodeLabel,
} from './sessionNaming.js';

describe('sanitizeGraphNodeLabel', () => {
  it('keeps a plain node id', () => {
    expect(sanitizeGraphNodeLabel('api-schema')).toBe('api-schema');
  });

  it('removes C0, DEL and C1 control characters', () => {
    expect(sanitizeGraphNodeLabel('a\u0000b\u001bc\u007fd\u0085e\u009ff')).toBe('abcdef');
  });

  it('removes bidi override and zero-width format characters', () => {
    expect(sanitizeGraphNodeLabel('ab‮cd​ef⁦gh﻿')).toBe('abcdefgh');
  });

  it('collapses whitespace runs, tabs and newlines to one space and trims', () => {
    expect(sanitizeGraphNodeLabel('  a \t\n b   c  ')).toBe('a b c');
  });

  it('returns undefined when nothing is left', () => {
    expect(sanitizeGraphNodeLabel('')).toBeUndefined();
    expect(sanitizeGraphNodeLabel(' \u0000‮​ \n')).toBeUndefined();
  });

  it('keeps a label at the maximum length', () => {
    const exact = 'x'.repeat(GRAPH_NODE_LABEL_MAX);
    expect(sanitizeGraphNodeLabel(exact)).toBe(exact);
  });

  it('cuts a longer label to the maximum length and adds an ellipsis', () => {
    const out = sanitizeGraphNodeLabel('y'.repeat(GRAPH_NODE_LABEL_MAX + 10))!;
    expect(out).toBe(`${'y'.repeat(GRAPH_NODE_LABEL_MAX - 1)}…`);
    expect([...out]).toHaveLength(GRAPH_NODE_LABEL_MAX);
  });

  it('does not split a surrogate pair at the cut', () => {
    const out = sanitizeGraphNodeLabel('😀'.repeat(GRAPH_NODE_LABEL_MAX + 5))!;
    expect(out).toBe(`${'😀'.repeat(GRAPH_NODE_LABEL_MAX - 1)}…`);
  });

  it('trims the space that a cut leaves before the ellipsis', () => {
    const raw = `${'a'.repeat(GRAPH_NODE_LABEL_MAX - 2)} bbbbbb`;
    expect(sanitizeGraphNodeLabel(raw)).toBe(`${'a'.repeat(GRAPH_NODE_LABEL_MAX - 2)}…`);
  });
});

describe('graphSessionTerminalName', () => {
  const ticketName = 'Karst: T42 — title';

  it('names a planner terminal', () => {
    expect(graphSessionTerminalName({ ticketName, kind: 'planner', runId: 4 })).toBe(
      'Karst: T42 — title · planner',
    );
  });

  it('names a node terminal by its node id', () => {
    expect(
      graphSessionTerminalName({ ticketName, kind: 'node', runId: 7, nodeId: 'api-schema' }),
    ).toBe('Karst: T42 — title · api-schema');
  });

  it('falls back to the node run id when the node id is missing or empty after the sanitize', () => {
    expect(graphSessionTerminalName({ ticketName, kind: 'node', runId: 7 })).toBe(
      'Karst: T42 — title · node 7',
    );
    expect(
      graphSessionTerminalName({ ticketName, kind: 'node', runId: 7, nodeId: '‮\u0000' }),
    ).toBe('Karst: T42 — title · node 7');
  });

  it('sanitizes a hostile node id', () => {
    expect(
      graphSessionTerminalName({ ticketName, kind: 'node', runId: 7, nodeId: 'ok‮\nevil' }),
    ).toBe('Karst: T42 — title · ok evil');
  });

  it('adds a relaunch suffix only when the launch attempt is above 1', () => {
    const base = { ticketName, kind: 'node', runId: 7, nodeId: 'n1' } as const;
    expect(graphSessionTerminalName({ ...base, launchAttempt: 0 })).toBe('Karst: T42 — title · n1');
    expect(graphSessionTerminalName({ ...base, launchAttempt: 1 })).toBe('Karst: T42 — title · n1');
    expect(graphSessionTerminalName({ ...base, launchAttempt: 2 })).toBe('Karst: T42 — title · n1 #2');
    expect(
      graphSessionTerminalName({ ticketName, kind: 'planner', runId: 4, launchAttempt: 3 }),
    ).toBe('Karst: T42 — title · planner #3');
  });
});
