/**
 * Graph-run agent identity (T1258, @arch:GRAPHRUN): the bootstrap snapshots the
 * resolved identity per role, and every planner, replan and node launch of the
 * run reads the snapshot, not the live manifest. A switch replaces the
 * snapshot; a run with no snapshot resolves live.
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Manifest } from '../../manifest/types.js';
import {
  bootstrapAndLaunchPlanner,
  driveReadyNodeRuns,
  parkLaunchFailure,
  launchReplanPlanner,
  relaunchBootstrapPlanner,
  sha256Hex,
} from './driver.js';
import { NOW, gateGraphJson, harness, plannerRunIdFor, runningGraphRun, testManifest, type Harness } from './driverHarness.js';
import { graphRunById, createGraphRun, graphRunAgentIdentity, setGraphRunAgentIdentity } from '../../store/graph/graphRuns.js';
import { createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import {
  parseRunIdentities,
  resolveRunIdentities,
  serializeRunIdentities,
} from './runIdentity.js';

function presetManifest(active: 'p1' | 'p2'): Manifest {
  return testManifest({
    activeAgentPreset: active,
    agentPresets: {
      p1: {
        label: 'One',
        slots: {
          graphExpert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
          graphWorker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
        },
      },
      p2: {
        label: 'Two',
        slots: {
          graphExpert: { provider: 'codex', model: 'gpt-5.6', effort: 'medium' },
          graphWorker: { provider: 'codex', model: 'gpt-5.6-mini' },
        },
      },
    },
  });
}

type Start = { adapterProvider?: string; interactive: { model?: string; effort?: string } };

/** Deps over `h` with a chosen manifest and an adapterFor that records each provider it is asked for. */
function depsWith(h: Harness, manifest: Manifest): { deps: Harness['deps']; providers: string[] } {
  const providers: string[] = [];
  const deps = {
    ...h.deps,
    manifest,
    adapterFor: (provider: string) => {
      providers.push(provider);
      return h.deps.adapterFor(provider);
    },
  };
  return { deps, providers };
}

const input = (h: Harness) => ({
  ticketId: h.ticketId,
  stageAttempt: 0,
  approachId: 'karst-graph-engineering',
  projectSlug: 'acme',
});

async function bootstrap(h: Harness, manifest: Manifest): Promise<number> {
  const result = await bootstrapAndLaunchPlanner({ ...h.deps, manifest }, input(h));
  if (result.kind !== 'launched') throw new Error(`bootstrap: ${result.kind}`);
  h.starts.length = 0;
  return result.graphRunId;
}

const modelOf = (h: Harness, i = 0): string | undefined => (h.starts[i] as unknown as Start).interactive.model;

describe('bootstrap snapshot', () => {
  it('stores the resolved identity of each graph role on the new run', async () => {
    const h = harness();
    const graphRunId = await bootstrap(h, presetManifest('p1'));
    const snap = parseRunIdentities(graphRunAgentIdentity(h.db, graphRunId));
    expect(snap?.roles.expert).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high', source: 'preset' });
    expect(snap?.roles.worker?.model).toBe('claude-sonnet-5');
    expect(snap?.roles.fast?.source).toBe('config');
  });

  it('launches the first planner with the snapshot identity', async () => {
    const h = harness();
    const result = await bootstrapAndLaunchPlanner({ ...h.deps, manifest: presetManifest('p2') }, input(h));
    expect(result.kind).toBe('launched');
    expect(modelOf(h)).toBe('gpt-5.6');
  });
});

describe('a settings change during the run', () => {
  it('Keep: a relaunched bootstrap planner keeps the start identity', async () => {
    const h = harness();
    const graphRunId = await bootstrap(h, presetManifest('p1'));
    const { deps, providers } = depsWith(h, presetManifest('p2'));
    const result = await relaunchBootstrapPlanner(deps, { graphRunId });
    expect(result.kind).toBe('launched');
    expect(modelOf(h)).toBe('claude-opus-5');
    expect(providers).toEqual(['claude']);
  });

  it('Keep: a replan planner keeps the start identity', async () => {
    const h = harness();
    const graphRunId = await bootstrap(h, presetManifest('p1'));
    h.db
      .prepare("INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 2, 'replan', 'ready')")
      .run(graphRunId);
    const plannerRunId = (h.db.prepare("SELECT id FROM approach_planner_runs WHERE kind = 'replan'").get() as { id: number }).id;
    const result = await launchReplanPlanner(
      { ...h.deps, manifest: presetManifest('p2') },
      { graphRunId, plannerRunId, generation: '', capability: '', prompt: '# replan', cwd: join(h.root, 'wt'), repo: 'api' },
    );
    expect(result.kind).toBe('launched');
    expect(modelOf(h)).toBe('claude-opus-5');
  });

  it('Switch: the next planner launch uses the replaced snapshot', async () => {
    const h = harness();
    const graphRunId = await bootstrap(h, presetManifest('p1'));
    const next = resolveRunIdentities(presetManifest('p2'), h.config);
    expect(setGraphRunAgentIdentity(h.db, graphRunId, serializeRunIdentities(next), NOW)).toBe(true);
    const result = await relaunchBootstrapPlanner({ ...h.deps, manifest: presetManifest('p1') }, { graphRunId });
    expect(result.kind).toBe('launched');
    expect(modelOf(h)).toBe('gpt-5.6');
  });

  it('a pre-migration run (null snapshot) resolves live', async () => {
    const h = harness();
    const graphRunId = await bootstrap(h, presetManifest('p1'));
    h.db.prepare('UPDATE approach_graph_runs SET agent_identity = NULL WHERE id = ?').run(graphRunId);
    const result = await relaunchBootstrapPlanner({ ...h.deps, manifest: presetManifest('p2') }, { graphRunId });
    expect(result.kind).toBe('launched');
    expect(modelOf(h)).toBe('gpt-5.6');
  });
});

/** A graph run in `running` with one claimed `ready` worker agent node. */
function readyWorkerNode(h: Harness, snapshot: string | null): number {
  const graphRunId = createGraphRun(h.db, { ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', now: NOW });
  if (snapshot !== null) setGraphRunAgentIdentity(h.db, graphRunId, snapshot, NOW);
  runningGraphRun(h, graphRunId);
  h.db
    .prepare(
      `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
       VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
    )
    .run(graphRunId, NOW);
  const artifact = (id: string, consumers: string[]) => ({
    id, path: `artifacts/${id}.md`, producer: '$planner', consumers, mediaType: 'text/markdown', maxBytes: 1000, required: true,
  });
  const doc = gateGraphJson({
    entries: ['impl'],
    artifacts: [artifact('plan', ['impl']), artifact('task', ['impl'])],
    nodes: [
      {
        id: 'impl', kind: 'agent', label: 'Implement', profile: 'worker', instructionsArtifact: 'task', inputs: ['plan'], outputs: [],
        resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
        outcomes: ['complete', 'blocked', 'replan'], budget: { maxVisits: 1 },
      },
    ],
    edges: [
      { id: 'e1', from: 'impl', on: 'complete', to: 'END' },
      { id: 'e2', from: 'impl', on: 'blocked', to: 'END' },
    ],
  });
  const revisionId = createRevision(h.db, { graphRunId, revisionNumber: 1, canonicalGraph: doc, fingerprint: 'fp', status: 'active', now: NOW });
  const [tokenId] = insertEntryTokens(h.db, revisionId, [{ edgeId: 'entry-impl', destinationNodeId: 'impl', destinationEnd: false }], NOW);
  const nodeRunId = Number(
    h.db
      .prepare(
        `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, 'impl', 'agent', 1, 'ready')`,
      )
      .run(graphRunId, revisionId).lastInsertRowid,
  );
  h.db.prepare("UPDATE approach_graph_tokens SET status = 'claimed', claiming_node_run_id = ? WHERE id = ?").run(nodeRunId, tokenId);
  const artRoot = h.deps.artifactRootOf(graphRunId);
  mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
  const plannerRunId = plannerRunIdFor(h.db, graphRunId);
  for (const id of ['plan', 'task']) {
    writeFileSync(join(artRoot, 'artifacts', `${id}.md`), `# ${id}`);
    const bytes = h.deps.readBytes(graphRunId, `artifacts/${id}.md`)!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, id, plannerRunId, `artifacts/${id}.md`, sha256Hex(bytes), bytes.length, NOW);
  }
  return graphRunId;
}

describe('node launch identity', () => {
  const snapshotOf = (h: Harness, preset: 'p1' | 'p2'): string =>
    serializeRunIdentities(resolveRunIdentities(presetManifest(preset), h.config));

  it('Keep: a node launches on the snapshot even after the active preset changed', async () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, snapshotOf(h, 'p1'));
    const { deps, providers } = depsWith(h, presetManifest('p2'));
    const result = await driveReadyNodeRuns(deps, graphRunId);
    expect(result.launched).toBe(1);
    expect(modelOf(h)).toBe('claude-sonnet-5');
    expect(providers).toContain('claude');
    expect(providers).not.toContain('codex');
  });

  it('Switch: the next node launches on the replaced snapshot', async () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, snapshotOf(h, 'p1'));
    setGraphRunAgentIdentity(h.db, graphRunId, snapshotOf(h, 'p2'), NOW);
    const result = await driveReadyNodeRuns({ ...h.deps, manifest: presetManifest('p1') }, graphRunId);
    expect(result.launched).toBe(1);
    expect(modelOf(h)).toBe('gpt-5.6-mini');
  });

  it('a pre-migration run resolves the node live', async () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, null);
    const result = await driveReadyNodeRuns({ ...h.deps, manifest: presetManifest('p2') }, graphRunId);
    expect(result.launched).toBe(1);
    expect(modelOf(h)).toBe('gpt-5.6-mini');
  });
});


describe('a failed-to-launch park names a model difference', () => {
  const parked = (h: Harness, graphRunId: number): string => {
    const nodeRunId = (h.db.prepare("SELECT id FROM approach_node_runs WHERE graph_run_id = ?").get(graphRunId) as { id: number }).id;
    parkLaunchFailure(h.deps, graphRunId, nodeRunId, 'launch failed before the session started');
    return graphRunById(h.db, graphRunId)!.blocked_reason ?? '';
  };

  it('appends the difference and the Switch models hint when the snapshot differs', () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, serializeRunIdentities(resolveRunIdentities(presetManifest('p1'), h.config)));
    const reason = parked({ ...h, deps: { ...h.deps, manifest: presetManifest('p2') } }, graphRunId);
    expect(reason).toMatch(/^failed-to-launch: node run \d+/);
    expect(reason).toContain('worker: claude/claude-sonnet-5 (low) → codex/gpt-5.6-mini');
    expect(reason).toContain('Switch models');
  });

  it('adds nothing when the snapshot matches the settings', () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, serializeRunIdentities(resolveRunIdentities(presetManifest('p1'), h.config)));
    const reason = parked({ ...h, deps: { ...h.deps, manifest: presetManifest('p1') } }, graphRunId);
    expect(reason).not.toContain('Switch models');
  });

  it('still parks and blocks the run with the plain reason when the difference lookup throws', () => {
    const h = harness();
    const graphRunId = readyWorkerNode(h, serializeRunIdentities(resolveRunIdentities(presetManifest('p1'), h.config)));
    const debug = vi.fn();
    const throwing = (): never => {
      throw new Error('config read failed');
    };
    const reason = parked({ ...h, deps: { ...h.deps, debug, graphConfigOf: throwing } }, graphRunId);
    expect(graphRunById(h.db, graphRunId)!.status).toBe('blocked');
    expect(reason).toMatch(/^failed-to-launch: node run \d+/);
    expect(reason).not.toContain('Switch models');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[driver] model difference lookup failed'));
  });
});
