import { describe, expect, it } from 'vitest';
import {
  insidePreviewFixtures,
  PREVIEW_REPO_COUNTS,
  PREVIEW_SCENARIOS,
  type InsidePreviewFixture,
} from './insideFixtures.js';
import { EVIDENCE_KINDS } from '../../model/inside/types.js';

/**
 * Task 9 / Finding 1: the checked-in fixture matrix is the data contract of the
 * development-only Inside preview. These tests pin the deterministic identity
 * of every fixture, the per-stage process-count invariant, the exact bounded
 * remainder rows (the "+N more" markers must match the production reducers'
 * own bounds), the coverage of every evidence kind and scenario, and the
 * presence of long untrusted labels/paths the renderer must escape.
 *
 * The matrix is built ONLY from production shapes (InsideStageView,
 * InsideProcessView, evidence, token, execution, typed-action): no SQLite
 * reads, no real worktrees, and no executable action targets (every action id
 * is a `fixture:`-prefixed inert capability the host registry can never
 * resolve).
 */

const STAGE_FOR_SCENARIO: Readonly<Record<InsidePreviewFixture['scenario'], string>> = {
  pending: 'scope',
  running: 'impl',
  passed: 'done',
  failed: 'review',
  waiting: 'ship',
  exhausted: 'uat',
};

/** The closed action vocabulary, mirrored from InsideActionKind (types.ts). */
const CLOSED_ACTION_KINDS = [
  'open-pr',
  'open-commit',
  'open-file',
  'open-stage-log',
  'resume-stage',
  'open-full-evidence',
] as const;

function rowsOf(fixture: InsidePreviewFixture, processId: string) {
  const process = fixture.view.processes.find((p) => p.id === processId);
  if (!process || !process.evidence) throw new Error(`no evidence for ${processId}`);
  return process.evidence.rows;
}

describe('inside preview fixtures', () => {
  const fixtures = insidePreviewFixtures();

  it('is deterministic: stable ids, unique, in repo-then-scenario order', () => {
    expect(fixtures.map((f) => f.id)).toEqual(
      PREVIEW_REPO_COUNTS.flatMap((n) =>
        PREVIEW_SCENARIOS.map((s) => `inside-preview-${n}-${s}`),
      ),
    );
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    // Two calls produce byte-identical data — no clock, no randomness.
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(insidePreviewFixtures()));
  });

  it('covers every repository count and every scenario exactly once each', () => {
    expect(fixtures).toHaveLength(PREVIEW_REPO_COUNTS.length * PREVIEW_SCENARIOS.length);
    for (const n of PREVIEW_REPO_COUNTS) {
      for (const s of PREVIEW_SCENARIOS) {
        expect(
          fixtures.some((f) => f.repositoryCount === n && f.scenario === s),
          `missing fixture: ${n} repos / ${s}`,
        ).toBe(true);
      }
    }
  });

  it('maps every scenario to its canonical stage', () => {
    for (const f of fixtures) {
      expect(f.stage, `${f.id} stage`).toBe(STAGE_FOR_SCENARIO[f.scenario]);
    }
  });

  it('keeps top-level process counts constant per stage across repo counts', () => {
    // Only evidence ROWS scale with the repository count; the process roster
    // of a stage must not — the webview lays the roster out as rows, so a
    // per-repo process would break the six-stage contract.
    const counts = new Map<string, Set<number>>();
    for (const f of fixtures) {
      const seen = counts.get(f.stage) ?? new Set<number>();
      seen.add(f.view.processes.length);
      counts.set(f.stage, seen);
    }
    for (const [stage, seen] of counts) {
      expect(seen.size, `stage ${stage} process count varies with repo count`).toBe(1);
    }
    expect(Object.fromEntries([...counts].map(([k, v]) => [k, [...v][0]]))).toEqual({
      scope: 2,
      impl: 1,
      uat: 4,
      review: 3,
      ship: 4,
      done: 1,
    });
  });

  it('states the exact bounded remainder rows at every repository count', () => {
    // The "+N more" marker must match the production reducers' own bounds
    // (worktrees 8, gates 8, ship per-repo processes 6), so a reviewer of the
    // preview sees exactly what a real 20-repo ticket renders.
    const worktreesRemainder = (n: number): string | undefined => {
      const f = fixtures.find((x) => x.repositoryCount === n && x.scenario === 'pending')!;
      const rows = rowsOf(f, 'worktrees');
      const last = rows[rows.length - 1];
      return last && last.label === 'more' ? last.detail : undefined;
    };
    expect(worktreesRemainder(2)).toBeUndefined();
    expect(worktreesRemainder(5)).toBeUndefined();
    expect(worktreesRemainder(10)).toBe('+2 more');
    expect(worktreesRemainder(15)).toBe('+7 more');
    expect(worktreesRemainder(20)).toBe('+12 more');

    // review gates carry 2n+1 rows (lint + test per repo, plus one skipped
    // gate), bounded at 8.
    const gatesRemainder = (n: number): string | undefined => {
      const f = fixtures.find((x) => x.repositoryCount === n && x.scenario === 'failed')!;
      const rows = rowsOf(f, 'gates');
      const last = rows[rows.length - 1];
      return last && last.label === 'more' ? last.detail : undefined;
    };
    expect(gatesRemainder(2)).toBeUndefined();
    expect(gatesRemainder(5)).toBe('+3 more');
    expect(gatesRemainder(10)).toBe('+13 more');
    expect(gatesRemainder(15)).toBe('+23 more');
    expect(gatesRemainder(20)).toBe('+33 more');

    // ship's per-repo processes (commit/push/pr) bound at 6 rows each.
    const ship20 = fixtures.find((x) => x.repositoryCount === 20 && x.scenario === 'waiting')!;
    const commitRows = rowsOf(ship20, 'commit');
    expect(commitRows[commitRows.length - 1]).toEqual({
      status: 'note',
      label: 'more',
      detail: '+14 more',
    });
    const ship5 = fixtures.find((x) => x.repositoryCount === 5 && x.scenario === 'waiting')!;
    expect(rowsOf(ship5, 'commit').at(-1)?.label).not.toBe('more');

    // uat gates carry 2n rows, bounded at 8.
    const uat20 = fixtures.find((x) => x.repositoryCount === 20 && x.scenario === 'exhausted')!;
    const uatGates = rowsOf(uat20, 'gates');
    expect(uatGates[uatGates.length - 1]).toEqual({
      status: 'note',
      label: 'more',
      detail: '+32 more',
    });
  });

  it('covers every evidence kind and every scenario', () => {
    const kinds = new Set<string>();
    for (const f of fixtures) {
      for (const p of f.view.processes) {
        if (p.evidence) kinds.add(p.evidence.kind);
      }
    }
    for (const kind of EVIDENCE_KINDS) {
      expect(kinds.has(kind), `missing evidence kind: ${kind}`).toBe(true);
    }
    expect(new Set(fixtures.map((f) => f.scenario))).toEqual(new Set(PREVIEW_SCENARIOS));
    // Both live and error states are represented (Finding 1).
    expect(fixtures.some((f) => f.scenario === 'running')).toBe(true);
    expect(fixtures.some((f) => f.scenario === 'failed')).toBe(true);
  });

  it('carries long untrusted labels and paths the renderer must escape', () => {
    const text = fixtures
      .flatMap((f) => f.view.processes.flatMap((p) => p.evidence?.rows ?? []))
      .map((r) => `${r.label} ${r.detail ?? ''}`)
      .join('\n');
    // Hostile markup survives the matrix so the escaping assertion has teeth.
    expect(text).toContain('<script>');
    expect(text).toContain('&');
    expect(text).toContain('"');
    // Long paths: a real deep file path must not be truncated in the DATA (the
    // renderer ellipsises the display; the fixture must carry the full value).
    expect(text.length).toBeGreaterThan(4000);
    for (const f of fixtures) {
      for (const p of f.view.processes) {
        if (p.detail) expect(p.detail.length).toBeLessThan(2000);
        for (const r of p.evidence?.rows ?? []) {
          expect(r.detail?.length ?? 0).toBeLessThan(2000);
        }
      }
    }
  });

  it('uses only closed action kinds and inert fixture-scoped ids', () => {
    const kinds = new Set<string>();
    for (const f of fixtures) {
      for (const p of f.view.processes) {
        if (p.action) {
          kinds.add(p.action.kind);
          // Inert by construction: the host registry mints `snapshot-<n>:…`
          // ids; a `fixture:` id is un-resolvable, so no fixture action can
          // ever dispatch an executable target (Finding 1).
          expect(p.action.actionId).toMatch(/^fixture:/);
        }
        for (const r of p.evidence?.rows ?? []) {
          if (r.action) {
            kinds.add(r.action.kind);
            expect(r.action.actionId).toMatch(/^fixture:/);
          }
        }
      }
    }
    for (const kind of kinds) {
      expect(CLOSED_ACTION_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('keeps stage views free of any store/worktree identity', () => {
    // Fixtures are pure presentation data: no ticket id, no worktree path,
    // no PR number the host would have to resolve — every value is a stable
    // synthetic label.
    for (const f of fixtures) {
      const json = JSON.stringify(f.view);
      expect(json).not.toMatch(/\/Users\/|\/workspace\/|\.git\/|worktrees\//);
    }
  });
});
