import { describe, expect, it } from 'vitest';
import {
  implementationPrototypeFixture,
  renderFixtures,
  RENDER_REPO_COUNTS,
  RENDER_SCENARIOS,
  renderStateFor,
  populatedStateFor,
  type InsideRenderFixture,
} from './renderFixtures.js';
import { EVIDENCE_KINDS } from '../../model/inside/types.js';

/**
 * The checked-in render fixture matrix is the data contract of the dashboard
 * webview's render tests. These tests pin the deterministic identity of every
 * fixture, the per-stage process-count invariant, the exact bounded remainder
 * rows (the "+N more" markers must match the production reducers' own bounds),
 * the coverage of every evidence kind and scenario, and the presence of long
 * untrusted labels/paths the renderer must escape.
 *
 * The matrix is built ONLY from production shapes (InsideStageView,
 * InsideProcessView, evidence, token, execution, typed-action): no SQLite
 * reads, no real worktrees, and no executable action targets (every action id
 * is a `fixture:`-prefixed inert capability the host registry can never
 * resolve).
 */

const STAGE_FOR_SCENARIO: Readonly<Record<InsideRenderFixture['scenario'], string>> = {
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
  'open-bounded-evidence',
] as const;

function rowsOf(fixture: InsideRenderFixture, processId: string) {
  const process = fixture.view.processes.find((p) => p.id === processId);
  if (!process || !process.evidence) throw new Error(`no evidence for ${processId}`);
  return process.evidence.rows;
}

describe('render fixtures', () => {
  const fixtures = renderFixtures();

  it('is deterministic: unique, in repo-then-scenario order', () => {
    const identities = fixtures.map((f) => `${f.repositoryCount}:${f.scenario}`);
    expect(identities).toEqual(
      RENDER_REPO_COUNTS.flatMap((n) => RENDER_SCENARIOS.map((s) => `${n}:${s}`)),
    );
    expect(new Set(identities).size).toBe(fixtures.length);
    // Two calls produce byte-identical data — no clock, no randomness.
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(renderFixtures()));
  });

  it('covers every repository count and every scenario exactly once each', () => {
    expect(fixtures).toHaveLength(RENDER_REPO_COUNTS.length * RENDER_SCENARIOS.length);
    for (const n of RENDER_REPO_COUNTS) {
      for (const s of RENDER_SCENARIOS) {
        expect(
          fixtures.some((f) => f.repositoryCount === n && f.scenario === s),
          `missing fixture: ${n} repos / ${s}`,
        ).toBe(true);
      }
    }
  });

  it('maps every scenario to its canonical stage', () => {
    for (const f of fixtures) {
      expect(f.stage, `${f.repositoryCount} repos / ${f.scenario} stage`).toBe(
        STAGE_FOR_SCENARIO[f.scenario],
      );
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
    // (worktrees 8, gates 8, ship per-repo processes 6), so a render test sees
    // exactly what a real 20-repo ticket renders.
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
      action: {
        actionId: expect.stringMatching(/^fixture:/),
        kind: 'open-bounded-evidence',
        // The count-bearing continuation label the host ships (handoff §10).
        label: 'Show 14 more',
      },
    });
    const ship5 = fixtures.find((x) => x.repositoryCount === 5 && x.scenario === 'waiting')!;
    expect(rowsOf(ship5, 'commit').at(-1)?.label).not.toBe('more');

    for (const n of [10, 15, 20] as const) {
      const ship = fixtures.find((x) => x.repositoryCount === n && x.scenario === 'waiting')!;
      for (const processId of ['commit', 'push', 'pr', 'merge']) {
        const rows = rowsOf(ship, processId);
        expect(rows).toHaveLength(7);
        expect(rows.at(-1)).toMatchObject({
          label: 'more',
          detail: `+${n - 6} more`,
          action: { kind: 'open-bounded-evidence' },
        });
      }
    }

    for (const n of [10, 15, 20] as const) {
      const done = fixtures.find((x) => x.repositoryCount === n && x.scenario === 'passed')!;
      const rows = rowsOf(done, 'delivery-receipt');
      expect(rows.filter((row) => row.label === 'merged')).toHaveLength(6);
      expect(rows).toHaveLength(10);
      expect(rows[6]).toMatchObject({
        label: 'more',
        detail: `+${n - 6} more`,
        action: { kind: 'open-bounded-evidence' },
      });
      expect(rows.find((row) => row.label === 'commits')).toBeDefined();
      expect(rows.find((row) => row.label === 'validated')).toBeDefined();
      expect(rows.find((row) => row.label === 'recovery')).toBeDefined();
    }

    // uat gates carry 2n rows, bounded at 8.
    const uat20 = fixtures.find((x) => x.repositoryCount === 20 && x.scenario === 'exhausted')!;
    const uatGates = rowsOf(uat20, 'gates');
    expect(uatGates[uatGates.length - 1]).toEqual({
      status: 'note',
      label: 'more',
      detail: '+32 more',
    });
  });

  it('keeps non-Ship/Done remainder rows passive while Ship/Done remain actionable', () => {
    const scope = fixtures.find((f) => f.repositoryCount === 20 && f.scenario === 'pending')!;
    expect(rowsOf(scope, 'worktrees').at(-1)).not.toHaveProperty('action');

    const uat = fixtures.find((f) => f.repositoryCount === 20 && f.scenario === 'exhausted')!;
    expect(rowsOf(uat, 'gates').at(-1)).not.toHaveProperty('action');

    const ship = fixtures.find((f) => f.repositoryCount === 20 && f.scenario === 'waiting')!;
    expect(rowsOf(ship, 'commit').at(-1)?.action).toMatchObject({ kind: 'open-bounded-evidence' });

    const done = fixtures.find((f) => f.repositoryCount === 20 && f.scenario === 'passed')!;
    expect(rowsOf(done, 'delivery-receipt')[6]?.action).toMatchObject({ kind: 'open-bounded-evidence' });
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
    expect(new Set(fixtures.map((f) => f.scenario))).toEqual(new Set(RENDER_SCENARIOS));
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

  it('uses only closed action kinds and inert ids', () => {
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

  it('models the approved completed implementation session', () => {
    const fixture = implementationPrototypeFixture();
    const session = fixture.view.processes[0]!;

    expect(fixture.view).toMatchObject({
      stageKey: 'impl',
      title: 'Implementation',
      processes: [{ id: 'session', label: 'Session', status: 'pass' }],
    });
    expect(session.evidence).toMatchObject({
      kind: 'timeline',
      rows: [
        { label: 'started with', detail: 'Claude Code · Opus' },
        { label: 'Understand' },
        { label: 'Plan' },
        { label: 'switched core + model', detail: 'Codex · Sol', connector: 'switch' },
        { label: 'Implement' },
        { label: 'switched core + model', detail: 'Claude Code · Sonnet', connector: 'switch' },
        { label: 'Tests' },
        { label: 'Done' },
      ],
    });
  });

  it('places the causal Fix directly after its UAT trigger (Task 5)', () => {
    // The plan's acceptance: Gates → causal Fix → Services → Tester. The fix
    // is inserted immediately after the process whose evidence opened the
    // recovery round — here the gates, whose failure every round records —
    // never at the bottom as an unrelated retry meter (handoff §5.5).
    const uat = fixtures.find((f) => f.scenario === 'exhausted' && f.repositoryCount === 2)!;
    expect(uat.view.processes.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'tester']);
    const rounds = rowsOf(uat, 'fix').filter((r) => r.label !== 'more');
    expect(rounds.map((r) => r.detail)).toEqual([
      'gate test failed — max 3',
      'gate test failed again — max 3',
      'gate test failed again — max 3 — no fix attempts left',
    ]);
  });

  it('keeps Review Gates → Services → Review and Ship Commit → Push → PR → Merge (Task 5)', () => {
    // Review has no recovery round in this matrix, so no Fix row appears —
    // the acceptance's fix-after-trigger rule applies where a Fix exists (uat).
    const review = fixtures.find((f) => f.scenario === 'failed' && f.repositoryCount === 2)!;
    expect(review.view.processes.map((p) => p.id)).toEqual(['gates', 'services', 'review']);
    const ship = fixtures.find((f) => f.scenario === 'waiting' && f.repositoryCount === 2)!;
    expect(ship.view.processes.map((p) => p.id)).toEqual(['commit', 'push', 'pr', 'merge']);
  });

  it('renders merge conflicts as waiting, never failed (Task 5)', () => {
    // A conflicted branch is a WAIT that names what the user must do — it
    // must never read as a failure of the ship's own work (handoff §5).
    for (const f of fixtures.filter((x) => x.scenario === 'waiting')) {
      const merge = rowsOf(f, 'merge').filter((r) => r.label !== 'more');
      expect(merge.some((r) => r.label === 'conflict'), `${f.repositoryCount} repos`).toBe(true);
      for (const r of merge) expect(r.status).toBe('wait');
      expect(merge.some((r) => r.status === 'fail')).toBe(false);
    }
  });

  it('keeps the delivery receipt free of executable controls (Task 5)', () => {
    // The receipt is delivered facts (handoff §6 done): the ONLY action any
    // receipt row may carry is the passive bounded continuation — never a
    // resume/restart/ship control.
    for (const f of fixtures.filter((x) => x.scenario === 'passed')) {
      for (const r of rowsOf(f, 'delivery-receipt')) {
        if (!r.action) continue;
        expect(r.action.kind).toBe('open-bounded-evidence');
      }
    }
  });
});

describe('populatedStateFor (dashboard envelope)', () => {
  /**
   * `renderStateFor` is deliberately neutral — empty rail, no stepper, no
   * servers — because the Inside render tests exercise one component. That
   * neutrality is why the visual sweep's dashboard baselines rendered a
   * header reading `#undefined (untitled)` over three empty panels.
   *
   * `populatedStateFor` fills the envelope AROUND the same inside view, so a
   * dashboard baseline pins the whole surface rather than its middle third.
   */
  it('names the ticket, so the header is not "#undefined (untitled)"', () => {
    const s = populatedStateFor('impl');
    expect(s.key).toBeTruthy();
    expect(s.title).toBeTruthy();
  });

  it('fills the three panels the neutral envelope leaves empty', () => {
    const s = populatedStateFor('impl');
    expect(s.servers.length).toBeGreaterThan(0);
    expect(s.worktrees.length).toBeGreaterThan(0);
    expect(s.prs.length).toBeGreaterThan(0);
  });

  it('carries a stepper and a rail for the requested stage', () => {
    const s = populatedStateFor('impl');
    expect(s.stepper.length).toBeGreaterThan(0);
    expect(s.rail.main.length).toBeGreaterThan(0);
    expect(s.stageCurrent).toBe('impl');
  });

  it('keeps the inside view the neutral builder would have produced', () => {
    const neutral = renderStateFor('impl');
    const populated = populatedStateFor('impl');
    expect(populated.insideViews).toEqual(neutral.insideViews);
  });
});
