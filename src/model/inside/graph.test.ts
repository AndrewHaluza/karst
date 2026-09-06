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
  graphRunStatusLabel,
  sanitizeGraphText,
  type GraphActionTarget,
  type GraphInsideInput,
  type GraphRunStatus,
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
      runNumber: 7,
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
        revisionId: 1,
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
    overrides: [],
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
    expect(process.aggregate).toBe('Running');
    expect(process.aggregateTitle).toBe('running');
    expect(process.evidence?.kind).toBe('rows');
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    expect(rows.map((r) => r.label)).toEqual([
      'graph',
      'planner 1',
      'revision',
      '<script>alert(1)</script>red alert(2) x plain',
      'edge-outcome-undeclared',
      '<script>alert(1)</script>red alert(2) x plain',
    ]);
    expect(rows[0]!.status).toBe('run');
    expect(rows[0]!.detail).toContain('run 7');
    // The node run moved to the structured node list (Slice 6 T4).
    expect(process.evidence.nodes).toHaveLength(1);
  });

  it('renders the per-ticket run ordinal, never the global run id', () => {
    const view = graphInsideProcess(
      input({ graphRun: { ...input({}).graphRun!, id: 99, runNumber: 2 } }),
    )!;
    if (view.evidence?.kind !== 'rows') return;
    expect(view.evidence.rows[0]!.detail).toContain('run 2');
    expect(view.evidence.rows[0]!.detail).not.toContain('run 99');
  });

  it('clamps a still-submitted planner and still-active revision to the run outcome once the run is closed', () => {
    // The planner/revision rows are durable historical facts — nothing ever
    // rewrites 'submitted'/'active' once the parent run stops mutating — so
    // rendering them blind to the run reads as an eternal spinner beside a
    // closed run (#352: the graph closed via the impl marker while its
    // bootstrap planner and revision still showed 'run').
    const closed = graphInsideProcess(
      input({ graphRun: { id: 7, runNumber: 7, status: 'closed', approachId: 'g', stageAttempt: 0, createdAt: '2026-08-11T00:00:00.000Z' } }),
    )!;
    if (closed.evidence?.kind !== 'rows') return;
    const planner = closed.evidence.rows.find((r) => r.label === 'planner 1')!;
    const revision = closed.evidence.rows.find((r) => r.label === 'revision')!;
    expect(planner.status).toBe('pass');
    expect(revision.status).toBe('pass');
    // Not every terminal outcome confirms the row: a run that never landed
    // must not read as a pass either.
    const cancelled = graphInsideProcess(
      input({ graphRun: { id: 7, runNumber: 7, status: 'cancelled', approachId: 'g', stageAttempt: 0, createdAt: '2026-08-11T00:00:00.000Z' } }),
    )!;
    if (cancelled.evidence?.kind !== 'rows') return;
    expect(cancelled.evidence.rows.find((r) => r.label === 'planner 1')!.status).toBe('note');
    expect(cancelled.evidence.rows.find((r) => r.label === 'revision')!.status).toBe('note');
  });

  it('shows the node identity, visit count and budget, and its live session action', () => {
    const process = graphInsideProcess(input())!;
    if (process.evidence?.kind !== 'rows') return;
    const node = process.evidence.nodes![0]!;
    expect(node.nodeId).toBe('implement');
    expect(node.status).toBe('running');
    expect(node.group).toBe('active');
    expect(node.identity).toContain('codex');
    expect(node.identity).toContain('sol');
    expect(node.identity).toContain('high');
    expect(node.identity).toContain('profile default');
    expect(node.visit).toBe('visit 1/40');
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
            revisionId: 1,
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
    const reason = rows.find((r) => r.label === 'serialized');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('maxParallel');
    // A ready node with no live session gets no open-session action — Open
    // reveals a terminal, it never spawns one. It IS editable, so the
    // override-edit control takes its place (Slice 6 T4).
    const node = process.evidence.nodes!.find((n) => n.nodeId === 'ready-node')!;
    expect(node.group).toBe('ready');
    expect(node.action).toMatchObject({ kind: 'graph-edit-override' });
  });

  it('a run completed-awaiting-impl-marker reads as waiting, not passed — the graph is done but the marker has not been fired (869 completed-awaiting-impl-marker green bug)', () => {
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'completed-awaiting-impl-marker',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      }),
    )!;
    // The run itself is done, but nothing advances until a human or agent
    // fires `karst stage impl pass` — that is a wait, exactly like the
    // `awaiting-merge` ship precedent, never the same green bucket as `closed`.
    expect(process.status).toBe('wait');
    if (process.evidence?.kind !== 'rows') return;
    expect(process.evidence.rows[0]!.status).toBe('wait');
    // `closed` is a genuine pass and must stay green.
    const closed = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'closed',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      }),
    )!;
    expect(closed.status).toBe('pass');
  });

  it('H2: a Stop-drained run (no replan planner) carries the restart control', () => {
    const targets: GraphActionTarget[] = [];
    const view = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'draining',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        // A Stop drains the run without electing a replan: the bootstrap
        // planner has long since submitted, and no replan planner exists.
        plannerRuns: [
          { plannerRunNumber: 1, kind: 'bootstrap', status: 'submitted', compileAttempt: 0, reason: null },
        ],
        attach: (target) => {
          targets.push(target);
          return { actionId: 'snapshot-1:action-1', kind: target.kind };
        },
      }),
    )!;
    if (view.evidence?.kind !== 'rows') return;
    expect(view.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-restart' });
    expect(targets).toContainEqual({ kind: 'graph-restart', graphRunId: 7 });
  });

  it('H2: a run draining for a LIVE replan planner carries no restart control', () => {
    const targets: GraphActionTarget[] = [];
    const view = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'draining',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        plannerRuns: [
          { plannerRunNumber: 1, kind: 'bootstrap', status: 'submitted', compileAttempt: 0, reason: null },
          { plannerRunNumber: 2, kind: 'replan', status: 'running', compileAttempt: 0, reason: null },
        ],
        attach: (target) => {
          targets.push(target);
          return { actionId: 'snapshot-1:action-1', kind: target.kind };
        },
      }),
    )!;
    if (view.evidence?.kind !== 'rows') return;
    expect(view.evidence.rows[0]!.action).toBeUndefined();
    expect(targets).not.toContainEqual({ kind: 'graph-restart', graphRunId: 7 });
  });

  it('attaches the stop action to a running or blocked graph run and none once it is closed', () => {
    const runningTargets: GraphActionTarget[] = [];
    const running = graphInsideProcess(
      input({
        attach: (target) => {
          runningTargets.push(target);
          return { actionId: 'snapshot-1:action-1', kind: target.kind };
        },
      }),
    )!;
    if (running.evidence?.kind !== 'rows') return;
    expect(running.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-stop' });
    expect(runningTargets).toContainEqual({ kind: 'graph-stop', graphRunId: 7 });
    const blockedTargets: GraphActionTarget[] = [];
    const blocked = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'blocked',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        attach: (target) => {
          blockedTargets.push(target);
          return { actionId: 'snapshot-1:action-1', kind: target.kind };
        },
      }),
    )!;
    if (blocked.evidence?.kind !== 'rows') return;
    expect(blocked.evidence.rows.find((row) => row.label === 'stop graph')!.action).toMatchObject({
      kind: 'graph-stop',
    });
    expect(blockedTargets).toContainEqual({ kind: 'graph-stop', graphRunId: 7 });
    // Awaiting the impl marker is not actionless: it carries its own
    // mark-impl control (asserted in its own test below) — never the
    // 'stop graph' action a still-live run carries.
    const awaitingMarker = graphInsideProcess(
      input({ graphRun: { id: 7, runNumber: 7, status: 'completed-awaiting-impl-marker', approachId: 'g', stageAttempt: 0, createdAt: '2026-08-11T00:00:00.000Z' } }),
    )!;
    if (awaitingMarker.evidence?.kind !== 'rows') return;
    expect(awaitingMarker.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-mark-impl' });
  });

  it('words the raw completed-awaiting-impl-marker status for both the aggregate chip and the graph row detail, keeping the raw key only as the aggregate title', () => {
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'completed-awaiting-impl-marker',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      }),
    )!;
    expect(process.aggregate).toBe('Completed — awaiting implementation marker');
    expect(process.aggregate).not.toContain('completed-awaiting-impl-marker');
    expect(process.aggregateTitle).toBe('completed-awaiting-impl-marker');
    if (process.evidence?.kind !== 'rows') return;
    expect(process.evidence.rows[0]!.detail).not.toContain('completed-awaiting-impl-marker');
    expect(process.evidence.rows[0]!.detail).toContain(
      'Completed — awaiting implementation marker',
    );
  });

  it('covers every closed graph-run status with host-worded copy (exhaustive)', () => {
    const statuses: GraphRunStatus[] = [
      'planning',
      'awaiting-confirmation',
      'running',
      'draining',
      'blocked',
      'completed-awaiting-impl-marker',
      'closed',
      'stale',
      'cancelled',
    ];
    for (const status of statuses) {
      const label = graphRunStatusLabel(status);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      // The label is host-worded prose, never the raw hyphenated store key.
      expect(label).not.toBe(status);
    }
  });

  it('attaches a persistent confirm action while the accepted graph awaits confirmation', () => {
    const targets: GraphActionTarget[] = [];
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'awaiting-confirmation',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        attach: (value) => {
          targets.push(value);
          return { actionId: 'snapshot-1:action-1', kind: value.kind };
        },
      }),
    )!;
    expect(process.evidence?.kind).toBe('rows');
    if (process.evidence?.kind !== 'rows') return;
    expect(targets).toContainEqual({
      kind: 'graph-confirm',
      graphRunId: 7,
    });
    expect(process.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-confirm' });
  });

  it('attaches explicit resume and replan controls for a blocked graph run', () => {
    const targets: GraphActionTarget[] = [];
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'blocked',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        attach: (target) => {
          targets.push(target);
          return { actionId: `snapshot-1:action-${targets.length}`, kind: target.kind };
        },
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    expect(targets).toContainEqual({ kind: 'graph-resume', graphRunId: 7 });
    expect(targets).toContainEqual({ kind: 'graph-replan', graphRunId: 7 });
    expect(process.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-resume' });
    expect(process.evidence.rows.find((row) => row.label === 'replan')!.action).toMatchObject({
      kind: 'graph-replan',
    });
  });

  it('attaches a mark-impl control to a run awaiting the implementation marker', () => {
    const targets: GraphActionTarget[] = [];
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 9,
          runNumber: 7,
          status: 'completed-awaiting-impl-marker',
          approachId: 'g',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        attach: (target) => {
          targets.push(target);
          return { actionId: `snapshot-1:action-${targets.length}`, kind: target.kind };
        },
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    expect(targets).toContainEqual({ kind: 'graph-mark-impl', graphRunId: 9 });
    expect(process.evidence.rows[0]!.action).toMatchObject({ kind: 'graph-mark-impl' });
  });

  it('attaches the discard exit to an ambiguous node run and Open to a live one, never both', () => {
    const ambiguous = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 21,
            nodeId: 'stuck',
            nodeKind: 'agent',
            revisionId: 1,
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
    const stuck = ambiguous.evidence.nodes!.find((n) => n.nodeId === 'stuck')!;
    expect(stuck.action).toMatchObject({ kind: 'graph-discard-node' });
    expect(stuck.status).toBe('termination-unknown');
    expect(stuck.group).toBe('other');

    const live = graphInsideProcess(input())!;
    if (live.evidence?.kind !== 'rows') return;
    const running = live.evidence.nodes!.find((n) => n.nodeId === 'implement')!;
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
            revisionId: 1,
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
    const half = process.evidence.nodes!.find((n) => n.nodeId === 'half')!;
    expect(half.action).toMatchObject({ kind: 'graph-discard-node' });
  });

  it('a non-ambiguous node with no live session and a non-editable status carries no action', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 23,
            nodeId: 'idle',
            nodeKind: 'command',
            revisionId: 1,
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
    const idle = process.evidence.nodes!.find((n) => n.nodeId === 'idle')!;
    expect(idle.action).toBeUndefined();
    expect(idle.group).toBe('completed');
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

  it('lists EVERY blocking node run when multiple faults block simultaneously (Slice 5 T6)', () => {
    const process = graphInsideProcess(
      input({
        graphRun: {
          id: 7,
          runNumber: 7,
          status: 'blocked',
          approachId: 'karst-graph-engineering',
          stageAttempt: 0,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
        nodeRuns: [
          {
            nodeRunId: 5,
            nodeId: 'a',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'blocked',
            outcome: 'blocked',
            reason: 'integration-conflict: b.ts',
            provider: 'codex',
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
          {
            nodeRunId: 6,
            nodeId: 'b',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'failed-to-launch',
            outcome: null,
            reason: 'spawn refused',
            provider: null,
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
          {
            nodeRunId: 7,
            nodeId: 'c',
            nodeKind: 'command',
            revisionId: 1,
            visitNumber: 1,
            status: 'blocked',
            outcome: 'failed',
            reason: 'node 7 fault',
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
    const nodes = process.evidence.nodes!;
    // The projection NEVER drops a blocking node run: each of the three
    // concurrent faults renders its own structured row carrying its status AND
    // reason.
    const a = nodes.find((n) => n.nodeId === 'a')!;
    const b = nodes.find((n) => n.nodeId === 'b')!;
    const c = nodes.find((n) => n.nodeId === 'c')!;
    expect(a.displayStatus).toBe('wait');
    expect(a.status).toBe('blocked');
    expect(a.reason).toContain('integration-conflict: b.ts');
    expect(b.displayStatus).toBe('wait');
    expect(b.status).toBe('failed-to-launch');
    expect(b.reason).toContain('spawn refused');
    expect(c.displayStatus).toBe('wait');
    expect(c.status).toBe('blocked');
    expect(c.reason).toContain('node 7 fault');
    expect(nodes).toHaveLength(3);
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
        detail: 'resource-conflict: physical domain dom-api is held write by another node run · waiting 30m',
        status: 'wait',
      },
    ]);
    expect(rows.filter((r) => r.label === 'deferred lint')).toEqual([
      {
        label: 'deferred lint',
        detail: 'parallel-slot-busy: active process ceiling reached (maxParallel 1) · waiting 1h',
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

  // Slice 6 Task 3 — the "Copy diagnostic" / "Open log" surface. The lines are
  // bounded and redacted at the SOURCE (the diagnostics module runs every line
  // through the redaction pipeline before it is captured); the projection's
  // job is to re-escape and bound them, so a capability, prompt/completion
  // text, secret, or unredacted command output can never ride a copied line.
  it('renders the bounded diagnostic log as escaped text rows (Slice 6 T3)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [],
        diagnosticLog: [
          `[graph:claim] project=acme ticket=T-1 attempt=2 graph=7 revision=3 planner=null node=9 gen=null node claimed\u001b[31mred\u001b[0m`,
          'line two javascript:alert(1)\twith \u0001control',
        ],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    const log = rows.filter((r) => r.label === 'log');
    expect(log).toHaveLength(2);
    expect(log[0]!.detail).toContain('node claimedred');
    expect(log[0]!.detail).not.toContain('\u001b');
    expect(log[1]!.detail).toContain('line two alert(1)with control');
    expect(log[1]!.detail).not.toContain('\u0001');
    expect(log[1]!.detail).not.toMatch(/javascript:/i);
    expect(log[1]!.detail).not.toContain('\n');
    expect(log.every((r) => r.status === 'note')).toBe(true);
  });

  it('bounds each diagnostic log line and the section size (Slice 6 T3)', () => {
    const longLine = `[graph:block] project=p ticket=t attempt=0 graph=7 revision=null planner=null node=null gen=null ${'x'.repeat(500)}`;
    const many = Array.from({ length: 12 }, (_, i) => `line ${i} ${'y'.repeat(50)}`);
    const process = graphInsideProcess(
      input({ nodeRuns: [], diagnosticLog: [longLine, ...many] }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const rows = process.evidence.rows;
    const shown = rows.filter(
      (r) => r.label === 'log' && !/^\+\d+ more$/.test(r.detail ?? ''),
    );
    expect(shown).toHaveLength(8);
    expect(shown.every((r) => (r.detail?.length ?? 0) <= 200)).toBe(true);
    expect(rows.filter((r) => r.label === 'log' && r.detail === '+5 more')).toEqual([
      { label: 'log', detail: '+5 more', status: 'note' },
    ]);
  });

  it('renders no log section when the diagnostic log is absent', () => {
    const process = graphInsideProcess(input({ nodeRuns: [] }))!;
    if (process.evidence?.kind !== 'rows') return;
    expect(process.evidence.rows.filter((r) => r.label === 'log')).toEqual([]);
  });

  // ── Slice 6 Task 4 — the richer graph projection ─────────────────────────
  it('renders the node list ordered by status group with the override marker (Slice 6 T4)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 1,
            nodeId: 'write-all',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'waiting-resource',
            outcome: null,
            reason: 'resource-conflict: dom-api held write',
            provider: 'claude',
            model: null,
            effort: null,
            profile: 'expert',
            launchAttempt: 0,
          },
          {
            nodeRunId: 2,
            nodeId: 'lint',
            nodeKind: 'command',
            revisionId: 1,
            visitNumber: 2,
            status: 'completed',
            outcome: 'complete',
            reason: null,
            provider: null,
            model: null,
            effort: null,
            profile: null,
            launchAttempt: 0,
          },
          {
            nodeRunId: 3,
            nodeId: 'implement',
            nodeKind: 'agent',
            revisionId: 1,
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
          {
            nodeRunId: 4,
            nodeId: 'review',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'cancelled',
            outcome: 'cancelled',
            reason: 'superseded by replan',
            provider: null,
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 0,
          },
        ],
        overrides: [
          { revisionId: 1, nodeId: 'write-all', kinds: ['profile', 'provider'] },
          // A REPLANNED revision's override must NOT mark revision 1's run.
          { revisionId: 2, nodeId: 'write-all', kinds: ['effort'] },
        ],
        liveSessions: [],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const nodes = process.evidence.nodes!;
    // Display order is the group order: active, ready, resource-waiting,
    // completed, blocked, stale, cancelled, other.
    expect(nodes.map((n) => n.group)).toEqual([
      'active',
      'resource-waiting',
      'completed',
      'cancelled',
    ]);
    // The override marker matches the run's OWN (revision, node) — revision 2's
    // override never marks revision 1's run.
    const writeAll = nodes.find((n) => n.nodeId === 'write-all')!;
    expect(writeAll.override).toBe('override profile,provider');
    const lint = nodes.find((n) => n.nodeId === 'lint')!;
    expect(lint.override).toBeUndefined();
    // Each node carries its identity, visit budget and reason verbatim.
    expect(nodes.find((n) => n.nodeId === 'implement')!.identity).toBe(
      'codex · sol · high · profile default',
    );
    expect(lint.visit).toBe('visit 2/40');
    expect(writeAll.reason).toContain('resource-conflict');
  });

  it('an override edit control is present for an editable agent node and absent for an active node (Slice 6 T4)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 1,
            nodeId: 'blocked-agent',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'blocked',
            outcome: 'blocked',
            reason: 'integration-conflict',
            provider: 'codex',
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
          {
            nodeRunId: 2,
            nodeId: 'failed-agent',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'failed-to-launch',
            outcome: null,
            reason: 'spawn refused',
            provider: null,
            model: null,
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
          {
            nodeRunId: 3,
            nodeId: 'running-agent',
            nodeKind: 'agent',
            revisionId: 1,
            visitNumber: 1,
            status: 'running',
            outcome: null,
            reason: null,
            provider: 'codex',
            model: 'sol',
            effort: null,
            profile: 'default',
            launchAttempt: 1,
          },
          {
            nodeRunId: 4,
            nodeId: 'blocked-command',
            nodeKind: 'command',
            revisionId: 1,
            visitNumber: 1,
            status: 'blocked',
            outcome: 'failed',
            reason: 'node 4 fault',
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
    const byId = new Map(process.evidence.nodes!.map((n) => [n.nodeId, n]));
    // The override-edit control is present on ready/blocked/failed-to-launch
    // AGENT nodes — the store's claim gate accepts a write for exactly these.
    expect(byId.get('blocked-agent')!.action).toMatchObject({ kind: 'graph-edit-override' });
    expect(byId.get('failed-agent')!.action).toMatchObject({ kind: 'graph-edit-override' });
    // An ACTIVE node is never editable — its control (if any) is Open, never
    // the override edit.
    expect(byId.get('running-agent')!.action?.kind).not.toBe('graph-edit-override');
    // A blocked COMMAND node is not an agent node — no override surface.
    expect(byId.get('blocked-command')!.action).toBeUndefined();
  });

  it('the projection is a pure function of persisted rows — it mutates nothing and writes nothing', () => {
    const source = input();
    // A structured snapshot (the `attach` closure is a function, so a generic
    // clone would throw) to prove the projection leaves every persisted row
    // byte-identical.
    const snapshot = {
      ...source,
      plannerRuns: source.plannerRuns.map((p) => ({ ...p })),
      nodeRuns: source.nodeRuns.map((n) => ({ ...n })),
      overrides: source.overrides.map((o) => ({ ...o, kinds: [...o.kinds] })),
      diagnostics: source.diagnostics.map((d) => ({ ...d })),
      artifacts: source.artifacts.map((a) => ({ ...a })),
      deferrals: source.deferrals.map((d) => ({ ...d })),
      liveSessions: source.liveSessions.map((s) => ({ ...s })),
    };
    const first = graphInsideProcess(source)!;
    const second = graphInsideProcess(source)!;
    // The input is untouched: node runs, overrides, planner runs all read
    // identically before and after.
    expect(source).toEqual(snapshot);
    // Two calls over the same rows return equal-but-distinct views — the
    // projection allocates fresh output and never caches or records.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // The node list is an immutable snapshot of the input rows: mutating the
    // input AFTER projection never reaches an already-rendered view.
    if (second.evidence?.kind !== 'rows') return;
    source.nodeRuns.push({
      nodeRunId: 99,
      nodeId: 'late',
      nodeKind: 'agent',
      revisionId: 1,
      visitNumber: 1,
      status: 'ready',
      outcome: null,
      reason: null,
      provider: null,
      model: null,
      effort: null,
      profile: null,
      launchAttempt: 0,
    });
    expect(second.evidence.nodes!.some((n) => n.nodeId === 'late')).toBe(false);
  });

  it('escapes the injection fixture at every new node-list surface (Slice 6 T4)', () => {
    const process = graphInsideProcess(
      input({
        nodeRuns: [
          {
            nodeRunId: 31,
            nodeId: INJECTED,
            nodeKind: INJECTED,
            revisionId: 1,
            visitNumber: 1,
            status: 'blocked',
            outcome: INJECTED,
            reason: INJECTED,
            provider: INJECTED,
            model: INJECTED,
            effort: INJECTED,
            profile: INJECTED,
            launchAttempt: 0,
          },
        ],
        overrides: [
          { revisionId: 1, nodeId: INJECTED, kinds: ['profile', INJECTED] },
        ],
        liveSessions: [],
      }),
    )!;
    if (process.evidence?.kind !== 'rows') return;
    const node = process.evidence.nodes![0]!;
    for (const field of ['nodeId', 'nodeKind', 'identity', 'override', 'outcome', 'reason'] as const) {
      const value = String(node[field] ?? '');
      expect(value, `${field} carries ANSI`).not.toContain('\u001b');
      expect(value, `${field} carries an unsafe scheme`).not.toMatch(/javascript:|data:/i);
      expect(value, `${field} carries a control char`).not.toContain('\n');
      expect(value.length, `${field} is unbounded`).toBeLessThanOrEqual(200);
    }
    // The override marker joins the CLOSED kinds present on the node's own
    // (revision, node) — the injected kind string is NOT a marker member, and
    // the marker's own prose is sanitized like every other surface (HTML stays
    // inert TEXT, never markup).
    expect(node.override).toContain('profile');
    expect(node.override).not.toMatch(/javascript:|data:/i);
  });
});

/**
 * Timestamps on the run rows. A durable row outlives the window reading it, so
 * "is this process new or stale" is the first question a stuck graph raises —
 * and until these ages existed, every row answered it identically.
 */
describe('graph run ages', () => {
  it('ages the graph run row from its creation', () => {
    const view = graphInsideProcess(input())!;
    const row = view.evidence!.rows.find((r) => r.label === 'graph')!;
    expect(row.detail).toContain('started 1h ago');
  });

  it('reports how long a submitted planner has owed the compiler an answer', () => {
    const view = graphInsideProcess(
      input({
        plannerRuns: [
          {
            plannerRunNumber: 1,
            kind: 'bootstrap',
            status: 'submitted',
            compileAttempt: 2,
            reason: null,
            startedAt: '2026-08-11T00:10:00.000Z',
            submittedAt: '2026-08-11T00:30:00.000Z',
            endedAt: null,
          },
        ],
      }),
    )!;
    const row = view.evidence!.rows.find((r) => r.label === 'planner 1')!;
    expect(row.detail).toContain('submitted 30m ago');
  });

  it('names a live planner that never recorded a start', () => {
    const view = graphInsideProcess(
      input({
        plannerRuns: [
          { plannerRunNumber: 1, kind: 'bootstrap', status: 'running', compileAttempt: 0, reason: null },
        ],
      }),
    )!;
    const row = view.evidence!.rows.find((r) => r.label === 'planner 1')!;
    expect(row.detail).toContain('never started');
  });

  it('reports how long a running planner has been running', () => {
    const view = graphInsideProcess(
      input({
        plannerRuns: [
          {
            plannerRunNumber: 1,
            kind: 'replan',
            status: 'running',
            compileAttempt: 0,
            reason: null,
            startedAt: '2026-08-11T00:45:00.000Z',
          },
        ],
      }),
    )!;
    const row = view.evidence!.rows.find((r) => r.label === 'planner 1')!;
    expect(row.detail).toContain('running 15m');
  });

  it('ages a node run and reports how long a finished one took', () => {
    const node = {
      nodeRunId: 11,
      nodeId: 'implement',
      nodeKind: 'agent',
      revisionId: 1,
      visitNumber: 1,
      outcome: null,
      reason: null,
      provider: null,
      model: null,
      effort: null,
      profile: null,
      launchAttempt: 0,
    };
    const view = graphInsideProcess(
      input({
        nodeRuns: [
          { ...node, status: 'running', startedAt: '2026-08-11T00:50:00.000Z', endedAt: null },
          {
            ...node,
            nodeRunId: 12,
            nodeId: 'review',
            status: 'completed',
            startedAt: '2026-08-11T00:00:00.000Z',
            endedAt: '2026-08-11T00:05:00.000Z',
          },
        ],
      }),
    )!;
    if (view.evidence?.kind !== 'rows') throw new Error('expected graph rows evidence');
    const nodes = view.evidence.nodes!;
    expect(nodes.find((n) => n.nodeId === 'implement')!.age).toBe('running 10m');
    expect(nodes.find((n) => n.nodeId === 'review')!.age).toBe('ran 5m');
  });
});
