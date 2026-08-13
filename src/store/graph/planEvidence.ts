/**
 * Graph-plan evidence read for the artifacts shelf's Plan artifact.
 *
 * The graph runtime IS the ticket's plan: the planner writes a canonical
 * graph document (the plan), revisions track accepted plan versions, node
 * runs track each node's progress, and planner runs record the planning
 * sessions. The Plan artifact is a READ over these rows — the same rows the
 * graph Inside projection already renders, re-derived here so the shelf and
 * the strip can never describe one plan from two different reads.
 *
 * Driver-agnostic (positional `?` only) — the CLI opens the same store.
 */
import type { GraphDb } from './transitions.js';

export interface GraphPlanRunRow {
  id: number;
  status: string;
  approach_id: string;
  created_at: string;
}

export interface GraphPlanRevisionRow {
  revision_number: number;
  canonical_graph: string;
  status: string;
  created_at: string;
}

export interface GraphPlanNodeRunRow {
  id: number;
  node_id: string;
  node_kind: string;
  revision_id: number;
  visit_number: number;
  status: string;
  ended_at: string | null;
}

export interface GraphPlanPlannerRunRow {
  kind: 'bootstrap' | 'replan';
  status: string;
  provider: string | null;
}

export interface GraphPlanArtifactRow {
  snapshot_path: string;
  media_type: string;
  byte_size: number;
}

/** The plan evidence of the ticket's LATEST graph run, or null when none. */
export interface GraphPlanEvidence {
  graphRun: GraphPlanRunRow | null;
  revisions: GraphPlanRevisionRow[];
  nodeRuns: GraphPlanNodeRunRow[];
  plannerRuns: GraphPlanPlannerRunRow[];
  plannerArtifacts: GraphPlanArtifactRow[];
}

export function listGraphPlanEvidence(db: GraphDb, ticketId: number): GraphPlanEvidence {
  const graphRun = db
    .prepare(
      `SELECT id, status, approach_id, created_at
         FROM approach_graph_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as GraphPlanRunRow | undefined;
  if (!graphRun) {
    return { graphRun: null, revisions: [], nodeRuns: [], plannerRuns: [], plannerArtifacts: [] };
  }

  const revisions = db
    .prepare(
      `SELECT revision_number, canonical_graph, status, created_at
         FROM approach_graph_revisions WHERE graph_run_id = ? ORDER BY revision_number`,
    )
    .all(graphRun.id) as GraphPlanRevisionRow[];

  const nodeRuns = db
    .prepare(
      `SELECT id, node_id, node_kind, revision_id, visit_number, status, ended_at
         FROM approach_node_runs WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(graphRun.id) as GraphPlanNodeRunRow[];

  const plannerRuns = db
    .prepare(
      `SELECT kind, status, provider
         FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(graphRun.id) as GraphPlanPlannerRunRow[];

  // The plan's underlying files are the PLANNER-produced artifacts (the
  // plan/task documents the planner wrote into the graph run's root).
  const plannerArtifacts = db
    .prepare(
      `SELECT snapshot_path, media_type, byte_size
         FROM approach_artifact_instances
        WHERE graph_run_id = ? AND producer_planner_run_id IS NOT NULL
        ORDER BY id`,
    )
    .all(graphRun.id) as GraphPlanArtifactRow[];

  return { graphRun, revisions, nodeRuns, plannerRuns, plannerArtifacts };
}
