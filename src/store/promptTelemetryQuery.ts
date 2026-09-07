import type { Store } from './db.js';

/**
 * Aggregate reads over the append-only evidence that answer the
 * prompt-effectiveness metric set (`docs/arch/prompt-metrics.md`). Every number
 * here is DERIVED from stored rows — never from an agent's self-report, and
 * never a metric that is invented when its evidence is absent (an unmeasured
 * rate comes back NULL, not zero, so a baseline can say "pending" honestly).
 *
 * This module is the SINGLE read path for both the committed baseline (ticket
 * 05) and the `karst stats --prompts` surface (ticket 433), so the two can never
 * drift apart. Every query is project-scoped the way the shared registry demands
 * (the DB is read by every IDE window); pass `projectId = null` for a cross-
 * project read (the baseline over the whole Cursor store).
 *
 * SQL answers via GROUP BY, mirroring `store/tokenUsage.ts`; the only in-memory
 * reduce is the seed-size percentile, over a bounded scalar column.
 */

/** A pull of the guide relative to the sessions that were seeded with its pointer. */
export interface GuidePullByCore {
  pulls: number;
  sessionsSeeded: number;
  /** `pulls / sessionsSeeded`; NULL when nothing was seeded (no denominator). */
  rate: number | null;
}

/** impl/fix stage runs by how they ended — the marker-fired vs silent signal. */
export interface MarkerCompliance {
  advanced: number;
  blocked: number;
  stopped: number;
  /** Finished runs (advanced + blocked + stopped); the rate's denominator. */
  finished: number;
  /** `advanced / finished`; NULL when no run finished (never 0 on no data). */
  rate: number | null;
}

/** The recorded composed-seed length, as a bounded distribution. */
export interface SeedSizeChars {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
}

/** How deep the fix loop ran (the fix brief's effectiveness). */
export interface FixLoopDepth {
  /** Tickets that entered `fix` at least once. */
  tickets: number;
  avg: number | null;
  max: number | null;
}

export interface TokensPerStagePass {
  /** Measured tokens spent on runs of this core that ended `passed`. */
  tokens: number;
  /** Passed process runs of this core. */
  passes: number;
  avgPerPass: number | null;
}

/** Tester runs and how often their targets needed the silence re-ask. */
export interface TesterReAsk {
  runs: number;
  totalNudges: number;
}

export interface PromptMetrics {
  markerCompliance: MarkerCompliance;
  /** Per-target winning extraction tier, summed across review runs. */
  findingsParseTiers: Record<string, number>;
  testerReAsk: TesterReAsk;
  /** Deterministic wrong-checkout observations recorded (orientation-block signal). */
  wrongCheckout: { observations: number };
  guidePullByCore: Record<string, GuidePullByCore>;
  seedSizeChars: SeedSizeChars;
  fixLoopDepth: FixLoopDepth;
  tokensPerStagePass: Record<string, TokensPerStagePass>;
}

/** The ticket-scope join + clause for a table aliased `pr`/`sr`/`st` joined to tickets. */
function scope(
  projectId: number | null,
  ticketJoinAlias = 'pr',
): { join: string; clause: string; params: number[] } {
  const join = `JOIN tickets tk ON tk.id = ${ticketJoinAlias}.ticket_id`;
  if (projectId === null) return { join, clause: '', params: [] };
  return { join, clause: ' AND tk.project_id = ?', params: [projectId] };
}

function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function queryMarkerCompliance(store: Store, projectId: number | null): MarkerCompliance {
  const s = scope(projectId, 'sr');
  const rows = store.db
    .prepare(
      `SELECT sr.outcome AS outcome, COUNT(*) AS n
         FROM stage_runs sr ${s.join}
        WHERE sr.stage_key IN ('impl','fix') AND sr.status = 'finished' ${s.clause}
        GROUP BY sr.outcome`,
    )
    .all(...s.params) as { outcome: string | null; n: number }[];
  let advanced = 0;
  let blocked = 0;
  let stopped = 0;
  for (const r of rows) {
    if (r.outcome === 'advanced') advanced = r.n;
    else if (r.outcome === 'blocked') blocked = r.n;
    else if (r.outcome === 'stopped') stopped = r.n;
  }
  const finished = advanced + blocked + stopped;
  return { advanced, blocked, stopped, finished, rate: rateOrNull(advanced, finished) };
}

/** Nearest-rank percentile over an ASC-sorted numeric array; null on empty. */
function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct));
  return sorted[idx] ?? null;
}

function querySeedSize(store: Store, projectId: number | null): SeedSizeChars {
  const s = scope(projectId);
  const rows = store.db
    .prepare(
      `SELECT json_extract(pr.prompt_telemetry, '$.seedChars') AS c
         FROM process_runs pr ${s.join}
        WHERE pr.process_id = 'session'
          AND json_extract(pr.prompt_telemetry, '$.seedChars') IS NOT NULL ${s.clause}
        ORDER BY c ASC`,
    )
    .all(...s.params) as { c: number }[];
  const values = rows.map((r) => r.c).filter((c) => Number.isFinite(c));
  if (values.length === 0) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p90: null };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    avg: Math.round(sum / values.length),
    min: values[0] ?? null,
    max: values[values.length - 1] ?? null,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}

function queryGuidePull(store: Store, projectId: number | null): Record<string, GuidePullByCore> {
  const s = scope(projectId);
  const pulls = store.db
    .prepare(
      `SELECT pr.provider AS provider, COUNT(*) AS n
         FROM process_runs pr ${s.join}
        WHERE pr.process_id = 'guide-pull' AND pr.provider IS NOT NULL ${s.clause}
        GROUP BY pr.provider`,
    )
    .all(...s.params) as { provider: string | null; n: number }[];
  const seeded = store.db
    .prepare(
      `SELECT pr.provider AS provider, COUNT(*) AS n
         FROM process_runs pr ${s.join}
        WHERE pr.process_id = 'session'
          AND json_extract(pr.prompt_telemetry, '$.guidePointer') = 1
          AND pr.provider IS NOT NULL ${s.clause}
        GROUP BY pr.provider`,
    )
    .all(...s.params) as { provider: string | null; n: number }[];

  const out: Record<string, GuidePullByCore> = {};
  for (const r of pulls) {
    if (r.provider === null) continue;
    out[r.provider] = { pulls: r.n, sessionsSeeded: 0, rate: null };
  }
  for (const r of seeded) {
    if (r.provider === null) continue;
    const slot = (out[r.provider] ??= { pulls: 0, sessionsSeeded: 0, rate: null });
    slot.sessionsSeeded = r.n;
  }
  for (const key of Object.keys(out)) {
    const entry = out[key]!;
    entry.rate = rateOrNull(entry.pulls, entry.sessionsSeeded);
  }
  return out;
}

function queryFindingsTiers(store: Store, projectId: number | null): Record<string, number> {
  const s = scope(projectId);
  const rows = store.db
    .prepare(
      `SELECT json_extract(pr.prompt_telemetry, '$.parseTiers') AS tiers
         FROM process_runs pr ${s.join}
        WHERE pr.process_id = 'review'
          AND json_extract(pr.prompt_telemetry, '$.parseTiers') IS NOT NULL ${s.clause}`,
    )
    .all(...s.params) as { tiers: string | null }[];
  const hist: Record<string, number> = {};
  for (const row of rows) {
    if (row.tiers === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.tiers);
    } catch {
      continue; // a corrupt telemetry blob contributes nothing — never crashes the read
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [tier, count] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof count === 'number') hist[tier] = (hist[tier] ?? 0) + count;
      }
    }
  }
  return hist;
}

function queryTesterReAsk(store: Store, projectId: number | null): TesterReAsk {
  const s = scope(projectId);
  const rows = store.db
    .prepare(
      `SELECT json_extract(pr.prompt_telemetry, '$.silenceNudges') AS nudges
         FROM process_runs pr ${s.join}
        WHERE pr.process_id = 'tester'
          AND json_extract(pr.prompt_telemetry, '$.silenceNudges') IS NOT NULL ${s.clause}`,
    )
    .all(...s.params) as { nudges: number | null }[];
  let totalNudges = 0;
  for (const r of rows) totalNudges += r.nudges ?? 0;
  return { runs: rows.length, totalNudges };
}

function queryWrongCheckout(store: Store, projectId: number | null): { observations: number } {
  const s = scope(projectId, 'uf');
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM uat_findings uf ${s.join}
        WHERE uf.title LIKE 'UAT skipped: checkout is on%' ${s.clause}`,
    )
    .get(...s.params) as { n: number };
  return { observations: row.n };
}

function queryFixLoopDepth(store: Store, projectId: number | null): FixLoopDepth {
  const s = scope(projectId, 'st');
  const rows = store.db
    .prepare(
      `SELECT st.ticket_id AS ticket_id, MAX(st.attempt) AS a
         FROM stages st ${s.join}
        WHERE st.stage_key = 'fix' ${s.clause}
        GROUP BY st.ticket_id`,
    )
    .all(...s.params) as { ticket_id: number; a: number }[];
  if (rows.length === 0) return { tickets: 0, avg: null, max: null };
  const attempts = rows.map((r) => r.a);
  const sum = attempts.reduce((x, y) => x + y, 0);
  return {
    tickets: rows.length,
    avg: Math.round((sum / attempts.length) * 100) / 100,
    max: Math.max(...attempts),
  };
}

function queryTokensPerStagePass(
  store: Store,
  projectId: number | null,
): Record<string, TokensPerStagePass> {
  const s = scope(projectId);
  const rows = store.db
    .prepare(
      `SELECT pr.provider AS provider,
              COALESCE(SUM(t.total_tokens), 0) AS tokens,
              COUNT(DISTINCT pr.id) AS passes
         FROM token_usage t
         JOIN process_runs pr ON pr.id = t.process_run_id
         ${s.join}
        WHERE pr.status = 'passed' AND t.estimated = 0 AND pr.provider IS NOT NULL ${s.clause}
        GROUP BY pr.provider`,
    )
    .all(...s.params) as { provider: string | null; tokens: number; passes: number }[];
  const out: Record<string, TokensPerStagePass> = {};
  for (const r of rows) {
    if (r.provider === null) continue;
    out[r.provider] = {
      tokens: r.tokens,
      passes: r.passes,
      avgPerPass: r.passes === 0 ? null : Math.round(r.tokens / r.passes),
    };
  }
  return out;
}

/**
 * The whole prompt-effectiveness rollup. Every field is derived from stored
 * evidence; a metric with no rows comes back NULL/empty, never a fabricated 0 —
 * the baseline must be able to say a number is PENDING because it was never
 * measured, which is exactly the state ticket 12 is gated on.
 */
export function queryPromptMetrics(store: Store, projectId: number | null): PromptMetrics {
  return {
    markerCompliance: queryMarkerCompliance(store, projectId),
    findingsParseTiers: queryFindingsTiers(store, projectId),
    testerReAsk: queryTesterReAsk(store, projectId),
    wrongCheckout: queryWrongCheckout(store, projectId),
    guidePullByCore: queryGuidePull(store, projectId),
    seedSizeChars: querySeedSize(store, projectId),
    fixLoopDepth: queryFixLoopDepth(store, projectId),
    tokensPerStagePass: queryTokensPerStagePass(store, projectId),
  };
}
