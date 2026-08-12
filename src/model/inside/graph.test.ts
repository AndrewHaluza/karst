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
      'revision',
      '<script>alert(1)</script>red alert(2) x plain',
      'edge-outcome-undeclared',
      '<script>alert(1)</script>red alert(2) x plain',
    ]);
    expect(rows[0]!.status).toBe('run');
    expect(rows[0]!.detail).toContain('run 7');
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
});
