/**
 * Read-only Inside graph projection (Slice 2 Task 10).
 *
 * An injection fixture — a planner-authored title containing HTML, ANSI, and a
 * `javascript:` URL — renders escaped and bounded; the projection is a pure
 * function of persisted rows and ships inert behind the feature flag.
 */

import { describe, it, expect } from 'vitest';
import {
  graphInsideProcess,
  sanitizeGraphText,
  type GraphInsideInput,
} from './graph.js';

/** The injection fixture: planner-authored text with HTML, ANSI, and an
 *  unsafe link scheme. */
const INJECTED =
  '<script>alert(1)</script>\u001b[31mred\u001b[0m javascript:alert(2)  data:x   plain';

function input(overrides?: Partial<GraphInsideInput>): GraphInsideInput {
  return {
    enabled: true,
    graphRun: {
      id: 7,
      status: 'running',
      approachId: 'karst-graph-engineering',
      stageAttempt: 0,
      createdAt: '2026-08-11T00:00:00.000Z',
    },
    plannerRuns: [
      {
        plannerRunNumber: 1,
        kind: 'bootstrap',
        status: 'submitted',
        compileAttempt: 2,
        reason: INJECTED,
      },
    ],
    revision: {
      revisionNumber: 1,
      status: 'active',
      fingerprint: 'aa5fe61e0657cd6bfa26e9463319fc45879469777cde056f08d96b37d2866e34',
    },
    diagnostics: [
      { code: INJECTED, where: INJECTED, message: INJECTED },
      { code: 'edge-outcome-undeclared', where: 'edges[0]', message: 'bad outcome' },
    ],
    artifacts: [
      {
        artifactId: INJECTED,
        byteSize: 2048,
        mediaType: 'text/markdown',
        createdAt: '2026-08-11T00:00:00.000Z',
      },
    ],
    nodeRuns: [
      {
        nodeRunId: 11,
        nodeId: 'implement',
        nodeKind: 'agent',
        visitNumber: 1,
        status: 'running',
        outcome: null,
        reason: null,
        provider: 'codex',
        model: 'sol',
        effort: 'high',
        profile: 'default',
        launchAttempt: 2,
      },
    ],
    deferrals: [],
    execution: { maxParallel: 1, maxNodeRuns: 40 },
    liveSessions: [{ kind: 'node', runId: 11 }],
    attach: (target) => ({ actionId: 'snapshot-1:action-1', kind: target.kind }),
    now: '2026-08-11T01:00:00.000Z',
    ...overrides,
  };
}

describe('sanitizeGraphText', () => {
  it('removes ANSI/control sequences and unsafe link schemes', () => {
    const out = sanitizeGraphText(INJECTED);
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u001b[31m');
    expect(out).not.toContain('\u001b[0m');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/data:/i);
    expect(out).not.toContain('\n');
  });

  it('collapses whitespace and bounds the result', () => {
    const out = sanitizeGraphText('a'.repeat(500) + '  b');
    expect(out).toHaveLength(200);
    const spaced = sanitizeGraphText('x   y\t z');
    expect(spaced).toBe('x y z');
  });
});

describe('graphInsideProcess', () => {
  it('is null when the feature flag is off', () => {
    expect(graphInsideProcess(input({ enabled: false }))).toBeNull();
  });

  it('is null when no graph run exists', () => {
    expect(graphInsideProcess(input({ graphRun: null }))).toBeNull();
  });

  it('is null for a null input', () => {
    expect(graphInsideProcess(null)).toBeNull();
    expect(graphInsideProcess(undefined)).toBeNull();
  });

  it('renders the run, planner, revision, diagnostics, and artifact evidence rows', () => {
    const process = graphInsideProcess(input())!;
    expect(process.id).toBe('graph');
    expect(process.kind).toBe('graph');
    expect(process.status).toBe('run');
    expect(process.aggregate).toBe('running');
    expect(process.evidence?.kind).toBe('rows');
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.map((r) => r.label)).toEqual([
      'graph',
      'planner 1',
      'node implement',
      'revision',
      '<script>alert(1)</script>red alert(2) x plain',
      'edge-outcome-undeclared',
      '<script>alert(1)</script>red alert(2) x plain',
    ]);
    expect(rows[0]!.status).toBe('run');
    expect(rows[0]!.detail).toContain('run 7');
  });

  it('shows the node identity, visit count and budget, and its live session action', () => {
    const process = graphInsideProcess(input())!;
    if (process.evidence?.kind !== 'rows') return;
    const node = process.evidence.rows.find((r) => r.label === 'node implement')!;
    expect(node.detail).toContain('agent · running');
    expect(node.detail).toContain('codex');
    expect(node.detail).toContain('sol');
    expect(node.detail).toContain('high');
    expect(node.detail).toContain('profile default');
    expect(node.detail).toContain('visit 1/40');
    expect(node.action).toMatchObject({ kind: 'graph-open-session' });
  });

  it('explains the serialization reason for a ready node — never a scheduler defect', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 12,
            nodeId: 'ready-node',
            nodeKind: 'agent',
            visitNumber: 1,
            status: 'ready',
            outcome: null,
            reason: null,
            provider: 'claude',
            model: null,
            effort: null,
            profile: 'expert',
            launchAttempt: 0,
          },
        ],
        liveSessions: [],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.map((r) => r.label)).toContain('node ready-node');
    const reason = rows.find((r) => r.label === 'serialized');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('maxParallel');
    // A ready node with no live session gets no open-session action — Open
    // reveals a terminal, it never spawns one.
    const node = rows.find((r) => r.label === 'node ready-node')!;
    expect(node.action).toBeUndefined();
  });

  it('attaches the stop action to a running graph run and none once it is closed', () => {
    const running = graphInsideProcess(input())!;
    if (running.evidence?.kind !== 'rows') return;
    expect(running.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-stop' });
    const closed = graphInsideProcess(
      input({ graphRun: { id: 7, status: 'completed-awaiting-impl-marker', approachId: 'g', stageAttempt: 0, createdAt: '2026-08-11T00:00:00.000Z' } }),
    )!;
    if (closed.evidence?.kind !== 'rows') return;
    expect(closed.evidence.rows[0]!.action).toBeUndefined();
  });

  it('attaches the discard exit to an ambiguous node run and Open to a live one, never both', () => {
    const ambiguous = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 21,
            nodeId: 'stuck',
            nodeKind: 'agent',
            visitNumber: 1,
            status: 'termination-unknown',
            outcome: null,
            reason: null,
            provider: null,
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
        ],
        liveSessions: [],
      }),
    )!;
    if (ambiguous.evidence?.kind !== 'rows') return;
    const stuck = ambiguous.evidence.rows.find((r) => r.label === 'node stuck')!;
    expect(stuck.action).toMatchObject({ kind: 'graph-discard-node' });
    expect(stuck.detail).toContain('termination-unknown');

    const live = graphInsideProcess(input())!;
    if (live.evidence?.kind !== 'rows') return;
    const running = live.evidence.rows.find((r) => r.label === 'node implement')!;
    expect(running.action).toMatchObject({ kind: 'graph-open-session' });
    expect(running.action?.kind).not.toBe('graph-discard-node');
  });

  it('attaches the discard exit for a launch-unknown node too', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 22,
            nodeId: 'half',
            nodeKind: 'agent',
            visitNumber: 1,
            status: 'launch-unknown',
            outcome: null,
            reason: null,
            provider: null,
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
        ],
        liveSessions: [],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const half = process.evidence.rows.find((r) => r.label === 'node half')!;
    expect(half.action).toMatchObject({ kind: 'graph-discard-node' });
  });

  it('a non-ambiguous node with no live session carries no action', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 23,
            nodeId: 'idle',
            nodeKind: 'command',
            visitNumber: 1,
            status: 'completed',
            outcome: 'complete',
            reason: null,
            provider: null,
            model: null,
            effort: null,
            profile: null,
            launchAttempt: 0,
          },
        ],
        liveSessions: [],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const idle = process.evidence.rows.find((r) => r.label === 'node idle')!;
    expect(idle.action).toBeUndefined();
  });

  it('renders every graph-derived string with ANSI/controls and unsafe schemes removed, bounded', () => {
    const process = graphInsideProcess(input())!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    for (const row of rows) {
      expect(row.detail).not.toContain('\u001b');
      expect(row.detail).not.toMatch(/javascript:/i);
      expect(row.detail).not.toMatch(/data:/i);
      expect(row.detail?.length ?? 0).toBeLessThanOrEqual(300);
      expect(row.label.length).toBeLessThanOrEqual(300);
    }
    // The fixture's ANSI escape markup and unsafe URL schemes are gone from
    // every row, including the diagnostic code/where/message and the artifact
    // name; the payload text between them survives as inert TEXT.
    const all = rows.map((r) => `${r.label} ${r.detail ?? ''}`).join(' ');
    expect(all).not.toContain('\u001b[31m');
    expect(all).not.toContain('\u001b[0m');
    expect(all).not.toMatch(/javascript:/i);
    expect(all).not.toMatch(/data:/i);
    // HTML is rendered as TEXT: the model neutralizes the carriage (ANSI,
    // controls, schemes); the webview's one audited `esc` plus the CSP render
    // any remaining angle brackets inert (F9).
    expect(all).toContain('<script>');
  });

  it('bounds the diagnostics and artifact lists with a remainder row', () => {
    const many = input({
      diagnostics: Array.from({ length: 12 }, (_, i) => ({
        code: `d-${i}`,
        where: 'x',
        message: 'm',
      })),
      artifacts: Array.from({ length: 10 }, (_, i) => ({
        artifactId: `a-${i}`,
        byteSize: 1,
        mediaType: 'text/plain',
        createdAt: '2026-08-11T00:00:00.000Z',
      })),
    });
    const process = graphInsideProcess(many)!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.filter((r) => r.label === 'diagnostics')).toEqual([
      { label: 'diagnostics', detail: '+4 more', status: 'note' },
    ]);
    expect(rows.filter((r) => r.label === 'artifacts')).toEqual([
      { label: 'artifacts', detail: '+2 more', status: 'note' },
    ]);
  });

  it('renders one row per deferred node with its persisted reason and wait duration (Slice 5 T3)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [],
        deferrals: [
          {
            nodeId: 'write-all',
            reason: 'resource-conflict: physical domain dom-api is held write by another node run',
            waitSince: '2026-08-11T00:30:00.000Z',
          },
          {
            nodeId: 'lint',
            reason: 'parallel-slot-busy: active process ceiling reached (maxParallel 1)',
            waitSince: '2026-08-11T00:00:00.000Z',
          },
        ],
        now: '2026-08-11T01:00:00.000Z',
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.filter((r) => r.label === 'deferred write-all')).toEqual([
      {
        label: 'deferred write-all',
        detail: 'resource-conflict: physical domain dom-api is held write by another node run · waiting 1800s',
        status: 'wait',
      },
    ]);
    expect(rows.filter((r) => r.label === 'deferred lint')).toEqual([
      {
        label: 'deferred lint',
        detail: 'parallel-slot-busy: active process ceiling reached (maxParallel 1) · waiting 3600s',
        status: 'wait',
      },
    ]);
  });

  it('a deferral reason is rendered as inert text — never markup (Slice 5 T3)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [],
        deferrals: [
          { nodeId: 'n', reason: INJECTED, waitSince: '2026-08-11T00:00:00.000Z' },
        ],
        now: '2026-08-11T01:00:00.000Z',
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const row = process.evidence.rows.find((r) => r.label === 'deferred n')!;
    expect(row.detail).not.toContain('\u001b');
    expect(row.detail).not.toMatch(/javascript:/i);
    expect(row.detail).not.toContain('\n');
    expect(row.detail!.length).toBeLessThanOrEqual(300);
  });

  it('bounds the deferred list with a remainder row', () => {
    const many = input({
      nodeRuns: [],
      deferrals: Array.from({ length: 12 }, (_, i) => ({
        nodeId: `w-${i}`,
        reason: `reason-${i}`,
        waitSince: '2026-08-11T00:00:00.000Z',
      })),
      now: '2026-08-11T01:00:00.000Z',
    });
    const process = graphInsideProcess(many)!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.filter((r) => r.label.startsWith('deferred w-'))).toHaveLength(8);
    expect(rows.filter((r) => r.label === 'deferred nodes')).toEqual([
      { label: 'deferred nodes', detail: '+4 more', status: 'note' },
    ]);
  });
});
