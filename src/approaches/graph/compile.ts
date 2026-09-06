/**
 * Pure compiler, canonicalizer, and fingerprint for the generated graph
 * document (Slice 2 Task 4).
 *
 * The planner output is untrusted data; compilation is the second closed
 * boundary after the parser. It validates topology (edges, reachability,
 * fork/join structure), reference integrity (profiles, commands,
 * repositories, artifacts), budget arithmetic (project maxima and the exact
 * expert-budget rule), and records all resource overlaps for scheduler
 * serialization. Compilation produces an immutable canonical document and
 * SHA-256 fingerprint.
 *
 * This module is pure: it imports no store, no vscode, no provider, and no
 * stage machine. Physical resource domains are resolved by the store/
 * scheduler layer and injected through `CompileContext` (Decision 29).
 */

import { canonicalFingerprint, canonicalJson } from './canonicalize.js';
import type {
  AgentNode,
  ApproachEdge,
  ApproachNode,
  ArtifactDef,
  CommandNode,
  GateNode,
  GatePredicate,
  GraphDocument,
  JoinNode,
} from './parse.js';
import { GRAPH_LIMITS } from './parse.js';

export type ProfileTier = 'worker' | 'expert';

/** A trusted command definition (manifest allowlist), pinned at compile. */
export interface CommandDefinition {
  id: string;
  /** Fingerprint of executable path, fixed argv, cwd policy, environment
   *  allowlist, access, timeout, and definition version. */
  fingerprint: string;
  access: 'read' | 'write';
  timeoutSeconds: number;
  /** Repositories the trusted definition permits the planner to select. */
  permittedRepositories: readonly string[];
}

/** A resolved repository: physical domain facts owned by the store layer. */
export interface ResolvedRepository {
  id: string;
  /** Normalized path of the repository root within the worktree ('' = the
   *  worktree root). */
  root: string;
  /** Physical scheduling/integration domain: canonical worktree realpath
   *  plus Git common-directory identity — never the manifest repository
   *  name, because multiple entries may share one repoPath. */
  domain: string;
}

export interface CompileContext {
  profiles: ReadonlyMap<string, ProfileTier>;
  commands: ReadonlyMap<string, CommandDefinition>;
  repositories: ReadonlyMap<string, ResolvedRepository>;
  /** True when a planner-produced artifact's file exists on disk. */
  artifactFileExists: (artifactId: string) => boolean;
  /** Graph-run-scoped counters for the expert-budget rule; failing the rule
   *  is a compile error, re-checked at replan compile against these. */
  expertSpend: {
    spentPlannerRuns: number;
    /** Replans the RUN still permits. The reserve actually charged is this
     *  capped by the document's own `budgets.maxReplans`: a planner cannot see
     *  the project maximum, so charging it would make a document declaring
     *  fewer replans impossible to satisfy. */
    permittedReplans: number;
    bootstrapUnspent: boolean;
  };
  /** Project-configured maxima (never above the product hard ceilings). */
  projectMaxima: { maxNodeRuns: number; maxExpertRuns: number; maxReplans: number };
}

export type CompileDiagnosticCode =
  | 'duplicate-node-id'
  | 'duplicate-artifact-id'
  | 'duplicate-edge-id'
  | 'empty-entries'
  | 'unknown-entry'
  | 'unknown-edge-source'
  | 'unknown-edge-destination'
  | 'edge-outcome-undeclared'
  | 'missing-normal-edge'
  | 'no-end-path'
  | 'unreachable-node'
  | 'unknown-artifact'
  | 'unknown-artifact-producer'
  | 'unknown-consumer'
  | 'undeliverable-output'
  | 'unreferenced-artifact'
  | 'planner-artifact-missing'
  | 'unknown-profile'
  | 'unknown-command'
  | 'unknown-command-repository'
  | 'command-repository-not-permitted'
  | 'unknown-repository'
  | 'no-repository-claim'
  | 'unknown-gate-node'
  | 'unknown-gate-outcome'
  | 'unknown-gate-artifact'
  | 'expert-budget-exceeded'
  | 'budget-exceeds-project-maximum'
  | 'join-unknown-fork'
  | 'join-unknown-branch'
  | 'join-fork-not-dominating'
  | 'join-not-post-dominating'
  | 'join-conditional-branch'
  | 'join-conditional-arrival'
  | 'join-branch-fanout'
  | 'join-predecessor-mismatch'
  | 'join-region-in-scc'
  | 'ambiguous-join-region'
  | 'join-budget-below-fork-multiplicity'
  | 'lineage-depth-exceeded'
  | 'warn-serialized-plan';

export interface CompileDiagnostic {
  code: CompileDiagnosticCode;
  where: string;
  message: string;
  severity: 'error' | 'warning';
}

/** One recorded overlap between two nodes' resource claims. */
export interface WriteOverlap {
  a: string;
  b: string;
  domain: string;
  path: string;
}

export interface CompiledGraph {
  document: GraphDocument;
  /** RFC 8785 canonical bytes (as a string), authoritative on reload. */
  canonicalJson: string;
  /** SHA-256 over the canonical UTF-8 bytes. */
  fingerprint: string;
  /** Pinned command fingerprints for every command id the graph uses. */
  commandFingerprints: Record<string, string>;
  /** Edges grouped by source node id. */
  outgoing: Record<string, ApproachEdge[]>;
  /** Source node ids grouped by destination node id. */
  incoming: Record<string, string[]>;
  /** Every pairwise claim overlap, for scheduler serialization. */
  overlaps: WriteOverlap[];
  warnings: CompileDiagnostic[];
}

export type CompileResult =
  | { ok: true; compiled: CompiledGraph }
  | { ok: false; diagnostics: CompileDiagnostic[] };

/** Reserved control/fault outcomes: no edge is required for them; an edge
 *  on them is legal and routes control rather than a normal success. */
const RESERVED_OUTCOMES = new Set(['blocked', 'replan', 'infrastructure-error']);

const ENTRY = '$entry';
const END = 'END';

interface Claim {
  node: string;
  domain: string;
  path: string;
  mode: 'read' | 'write';
}

/** All graph nodes plus the synthetic entry and END. */
function graphNodes(document: GraphDocument): Set<string> {
  const ids = new Set<string>([ENTRY, END]);
  for (const node of document.nodes) ids.add(node.id);
  return ids;
}

/** Adjacency (successor ids) per node over declared edges. */
function adjacency(document: GraphDocument): Map<string, string[]> {
  const cfg = new Map<string, string[]>();
  for (const id of graphNodes(document)) cfg.set(id, []);
  for (const entry of document.entries) cfg.get(ENTRY)!.push(entry);
  for (const edge of document.edges) {
    cfg.get(edge.from)?.push(edge.to === END ? END : edge.to);
  }
  return cfg;
}

function reachableFrom(start: string, cfg: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of cfg.get(node) ?? []) stack.push(next);
  }
  return seen;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function computeDominators(start: string, cfg: Map<string, string[]>): Map<string, Set<string>> {
  const all = new Set(cfg.keys());
  const dom = new Map<string, Set<string>>();
  for (const id of all) dom.set(id, id === start ? new Set([start]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of all) {
      if (id === start) continue;
      const preds = [...cfg.entries()]
        .filter(([, next]) => next.includes(id))
        .map(([from]) => from);
      let intersection: Set<string> | null = null;
      for (const pred of preds) {
        const d = dom.get(pred);
        if (!d) continue;
        if (intersection === null) {
          intersection = new Set(d);
        } else {
          const narrowed: string[] = [];
          for (const x of intersection) {
            if (d.has(x)) narrowed.push(x);
          }
          intersection = new Set(narrowed);
        }
      }
      const next = intersection ?? new Set<string>();
      next.add(id);
      const current = dom.get(id)!;
      if (!setsEqual(next, current)) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** Nodes on at least one path from `from` to `to` (exclusive of both). */
function onSomePath(from: string, to: string, cfg: Map<string, string[]>): Set<string> {
  const fwd = reachableFrom(from, cfg);
  const rev = new Map<string, string[]>();
  for (const [id, next] of cfg) {
    for (const n of next) {
      if (!rev.has(n)) rev.set(n, []);
      rev.get(n)!.push(id);
    }
  }
  const bwd = reachableFrom(to, rev);
  const onPath = new Set([...fwd].filter((n) => bwd.has(n)));
  onPath.delete(from);
  onPath.delete(to);
  return onPath;
}

/** A node is conditional when its outgoing edges use ≥2 distinct outcomes. */
function isConditional(nodeId: string, edges: ApproachEdge[]): boolean {
  const outcomes = new Set<string>();
  for (const edge of edges) {
    if (edge.from === nodeId) outcomes.add(edge.on);
  }
  return outcomes.size > 1;
}

/** Tarjan SCC; returns every non-trivial component (size > 1 or self-loop). */
function nonTrivialSccs(cfg: Map<string, string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const inScc = new Set<string>();
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of cfg.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = new Set<string>();
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.add(w);
      } while (w !== v);
      if (component.size > 1) {
        for (const member of component) inScc.add(member);
      } else {
        const self = cfg.get(v) ?? [];
        if (self.includes(v)) inScc.add(v);
      }
    }
  };
  for (const id of cfg.keys()) {
    if (!index.has(id)) visit(id);
  }
  return inScc;
}

/** Agent-node claims (read/write) resolved against injected repository
 *  facts; command nodes claim repository-wide per their trusted access. */
function buildClaims(
  document: GraphDocument,
  context: CompileContext,
): Claim[] {
  const claims: Claim[] = [];
  for (const node of document.nodes) {
    if (node.kind === 'agent') {
      for (const claim of node.resources.reads) {
        const repo = context.repositories.get(claim.repo);
        if (!repo) continue;
        for (const path of claim.paths) {
          claims.push({
            node: node.id,
            domain: repo.domain,
            path: repo.root === '' ? path : `${repo.root}/${path}`,
            mode: 'read',
          });
        }
      }
      for (const claim of node.resources.writes) {
        const repo = context.repositories.get(claim.repo);
        if (!repo) continue;
        for (const path of claim.paths) {
          claims.push({
            node: node.id,
            domain: repo.domain,
            path: repo.root === '' ? path : `${repo.root}/${path}`,
            mode: 'write',
          });
        }
      }
    } else if (node.kind === 'command') {
      const def = context.commands.get(node.command);
      if (!def) continue;
      for (const repoId of node.repositories) {
        const repo = context.repositories.get(repoId);
        if (!repo) continue;
        claims.push({
          node: node.id,
          domain: repo.domain,
          path: '',
          mode: def.access,
        });
      }
    }
  }
  return claims;
}

function claimsOverlap(a: Claim, b: Claim): boolean {
  if (a.domain !== b.domain) return false;
  if (a.mode === 'read' && b.mode === 'read') return false;
  const p = a.path;
  const q = b.path;
  return (
    p === '' ||
    q === '' ||
    p === q ||
    p.startsWith(`${q}/`) ||
    q.startsWith(`${p}/`)
  );
}

function checkGatePredicate(
  predicate: GatePredicate,
  nodes: Map<string, ApproachNode>,
  artifacts: Map<string, ArtifactDef>,
  diags: CompileDiagnostic[],
): void {
  if (predicate.kind === 'node-visits') {
    if (!nodes.has(predicate.node)) {
      diags.push({
        code: 'unknown-gate-node',
        where: predicate.node,
        message: `gate policy references unknown node "${predicate.node}"`,
        severity: 'error',
      });
    }
  } else if (predicate.kind === 'node-outcomes') {
    if (!nodes.has(predicate.node)) {
      diags.push({
        code: 'unknown-gate-node',
        where: predicate.node,
        message: `gate policy references unknown node "${predicate.node}"`,
        severity: 'error',
      });
    } else {
      const outcomes: readonly string[] = nodes.get(predicate.node)!.outcomes;
      if (!outcomes.includes(predicate.outcome)) {
        diags.push({
          code: 'unknown-gate-outcome',
          where: `${predicate.node}.${predicate.outcome}`,
          message: `gate policy references outcome "${predicate.outcome}" not declared by node "${predicate.node}"`,
          severity: 'error',
        });
      }
    }
  } else if (predicate.kind === 'artifact-exists') {
    if (!artifacts.has(predicate.artifact)) {
      diags.push({
        code: 'unknown-gate-artifact',
        where: predicate.artifact,
        message: `gate policy references unknown artifact "${predicate.artifact}"`,
        severity: 'error',
      });
    }
  } else if (predicate.kind === 'all' || predicate.kind === 'any') {
    for (const child of predicate.predicates) checkGatePredicate(child, nodes, artifacts, diags);
  }
}

function checkJoins(
  document: GraphDocument,
  cfg: Map<string, string[]>,
  edges: ApproachEdge[],
  diags: CompileDiagnostic[],
): void {
  const nodes = new Map(document.nodes.map((n) => [n.id, n]));
  const dom = computeDominators(ENTRY, cfg);
  const revCfg = new Map<string, string[]>();
  for (const [id, next] of cfg) {
    for (const n of next) {
      if (!revCfg.has(n)) revCfg.set(n, []);
      revCfg.get(n)!.push(id);
    }
  }
  const postDom = computeDominators(END, revCfg);
  const scc = nonTrivialSccs(cfg);
  const branchOwner = new Map<string, string>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.to === END) continue;
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge.from);
  }

  for (const join of document.nodes) {
    if (join.kind !== 'join') continue;
    const forkFrom = join.forkFrom;
    if (forkFrom !== ENTRY && !nodes.has(forkFrom)) {
      diags.push({
        code: 'join-unknown-fork',
        where: join.id,
        message: `join "${join.id}" references unknown fork "${forkFrom}"`,
        severity: 'error',
      });
      continue;
    }
    for (const branch of join.waitFor) {
      if (!nodes.has(branch)) {
        diags.push({
          code: 'join-unknown-branch',
          where: join.id,
          message: `join "${join.id}" waits for unknown node "${branch}"`,
          severity: 'error',
        });
      } else if (branchOwner.has(branch) && branchOwner.get(branch) !== join.id) {
        diags.push({
          code: 'ambiguous-join-region',
          where: branch,
          message: `node "${branch}" is a declared branch of two joins`,
          severity: 'error',
        });
      } else {
        branchOwner.set(branch, join.id);
      }
    }

    for (const branch of join.waitFor) {
      if (!nodes.has(branch)) continue;
      // Fork dominance: every path from an entry to the branch passes the fork.
      if (forkFrom !== ENTRY && !(dom.get(branch)?.has(forkFrom) ?? false)) {
        diags.push({
          code: 'join-fork-not-dominating',
          where: join.id,
          message: `fork "${forkFrom}" does not dominate branch "${branch}" of join "${join.id}"`,
          severity: 'error',
        });
      }
      // Join post-dominance: every path from the branch to END passes the join.
      if (!(postDom.get(branch)?.has(join.id) ?? false)) {
        diags.push({
          code: 'join-not-post-dominating',
          where: join.id,
          message: `join "${join.id}" does not post-dominate branch "${branch}"`,
          severity: 'error',
        });
      }
      // Branch completeness: no conditional node on any path from fork to branch.
      for (const middle of onSomePath(forkFrom, branch, cfg)) {
        if (isConditional(middle, edges)) {
          diags.push({
            code: 'join-conditional-branch',
            where: join.id,
            message: `path from fork "${forkFrom}" to branch "${branch}" passes conditional node "${middle}"`,
            severity: 'error',
          });
          break;
        }
      }
      // Conditional arrival: every normal outcome of the branch routes to the join.
      const branchEdges = edges.filter((e) => e.from === branch);
      for (const edge of branchEdges) {
        if (!RESERVED_OUTCOMES.has(edge.on) && edge.to !== join.id) {
          diags.push({
            code: 'join-conditional-arrival',
            where: join.id,
            message: `outcome "${edge.on}" of branch "${branch}" routes to "${edge.to}", not the join`,
            severity: 'error',
          });
        }
      }
      const perOutcomeToJoin = new Map<string, number>();
      for (const edge of branchEdges) {
        if (edge.to === join.id) {
          perOutcomeToJoin.set(edge.on, (perOutcomeToJoin.get(edge.on) ?? 0) + 1);
        }
      }
      for (const [outcome, count] of perOutcomeToJoin) {
        if (count > 1) {
          diags.push({
            code: 'join-branch-fanout',
            where: join.id,
            message: `branch "${branch}" sends ${count} arrivals to the join on outcome "${outcome}"`,
            severity: 'error',
          });
        }
      }
      // Join regions are acyclic: neither the join nor a branch may sit in a
      // non-trivial strongly connected component.
      if (scc.has(join.id) || scc.has(branch)) {
        diags.push({
          code: 'join-region-in-scc',
          where: join.id,
          message: `join "${join.id}" region sits inside a strongly connected component`,
          severity: 'error',
        });
      }
    }

    // Predecessor equality: incoming edges are exactly the declared branches.
    const preds = new Set(incoming.get(join.id) ?? []);
    const declared = new Set(join.waitFor);
    if (
      preds.size !== declared.size ||
      [...declared].some((b) => !preds.has(b))
    ) {
      diags.push({
        code: 'join-predecessor-mismatch',
        where: join.id,
        message: `join "${join.id}" incoming edges do not match its declared branches`,
        severity: 'error',
      });
    }

    // Fork multiplicity: the join must be able to fire once per fork
    // execution; a join budgeted below its fork's multiplicity strands the
    // later instances (design, "Graph Compilation and Validation").
    const multiplicity =
      forkFrom === ENTRY ? 1 : (nodes.get(forkFrom)!.budget.maxVisits ?? 0);
    if (join.budget.maxVisits < multiplicity) {
      diags.push({
        code: 'join-budget-below-fork-multiplicity',
        where: join.id,
        message: `join "${join.id}" maxVisits ${join.budget.maxVisits} is below fork "${forkFrom}" multiplicity ${multiplicity}`,
        severity: 'error',
      });
    }
  }
}

/**
 * The maximum fork-lineage depth the graph can produce along any execution
 * path (Slice 5 Task 4). Lineage grows ONLY on self-loop traversals — one
 * segment per traversal — and a node's self-loop can be traversed at most
 * `maxVisits - 1` times (its visit budget caps the traversals). The value is
 * the longest weighted path through the SCC condensation: each SCC weighs the
 * self-loop contributions of its members, and a condensation path visits each
 * SCC once, so independent loops do not sum. The `1` is the root segment.
 */
function maxGraphLineageDepth(
  document: GraphDocument,
  cfg: Map<string, string[]>,
): number {
  const selfLoop = new Set<string>();
  for (const edge of document.edges) {
    if (edge.from === edge.to) selfLoop.add(edge.from);
  }
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));

  // Tarjan SCCs over the CFG.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of cfg.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const id = components.length;
      for (const member of comp) componentOf.set(member, id);
      components.push(comp);
    }
  };
  for (const id of cfg.keys()) {
    if (!index.has(id)) visit(id);
  }

  // Condensation DAG.
  const dag = new Map<number, number[]>();
  for (let i = 0; i < components.length; i++) dag.set(i, []);
  for (const [u, next] of cfg) {
    const cu = componentOf.get(u)!;
    for (const v of next) {
      const cv = componentOf.get(v)!;
      if (cu !== cv && !dag.get(cu)!.includes(cv)) dag.get(cu)!.push(cv);
    }
  }

  const weight = new Map<number, number>();
  for (let i = 0; i < components.length; i++) {
    let w = 0;
    for (const member of components[i]!) {
      const node = nodesById.get(member);
      if (node && selfLoop.has(member)) w += node.budget.maxVisits - 1;
    }
    weight.set(i, w);
  }

  const memo = new Map<number, number>();
  const longest = (compId: number): number => {
    const cached = memo.get(compId);
    if (cached !== undefined) return cached;
    let best = 0;
    for (const next of dag.get(compId) ?? []) best = Math.max(best, longest(next));
    const result = (weight.get(compId) ?? 0) + best;
    memo.set(compId, result);
    return result;
  };

  return 1 + longest(componentOf.get(ENTRY)!);
}

/** Reject a graph whose loop chain's lineage depth exceeds the hard bound. */
function checkLineageDepth(
  document: GraphDocument,
  cfg: Map<string, string[]>,
  error: (code: CompileDiagnosticCode, where: string, message: string) => void,
): void {
  const depth = maxGraphLineageDepth(document, cfg);
  if (depth > GRAPH_LIMITS.maxLineageDepth) {
    error(
      'lineage-depth-exceeded',
      'fork lineage',
      `deepest loop chain reaches a fork-lineage depth of ${depth}, beyond the bound ${GRAPH_LIMITS.maxLineageDepth}`,
    );
  }
}

function toPlainDocument(document: GraphDocument): Record<string, unknown> {
  const plainNode = (node: ApproachNode): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      budget: { maxVisits: node.budget.maxVisits },
    };
    if (node.kind === 'agent') {
      base['profile'] = node.profile;
      base['instructionsArtifact'] = node.instructionsArtifact;
      base['inputs'] = node.inputs;
      base['outputs'] = node.outputs;
      base['resources'] = {
        reads: node.resources.reads.map((c) => ({ repo: c.repo, paths: c.paths })),
        writes: node.resources.writes.map((c) => ({ repo: c.repo, paths: c.paths })),
      };
      base['outcomes'] = node.outcomes;
    } else if (node.kind === 'command') {
      base['command'] = node.command;
      base['repositories'] = node.repositories;
      base['outcomes'] = node.outcomes;
    } else if (node.kind === 'gate') {
      base['policy'] = plainPredicate(node.policy);
      base['outcomes'] = node.outcomes;
    } else {
      base['forkFrom'] = node.forkFrom;
      base['waitFor'] = node.waitFor;
      base['mode'] = node.mode;
      base['outcomes'] = node.outcomes;
    }
    return base;
  };
  const plainPredicate = (p: GatePredicate): Record<string, unknown> => {
    if (p.kind === 'node-visits') return { kind: p.kind, node: p.node, op: p.op, value: p.value };
    if (p.kind === 'node-outcomes') {
      return { kind: p.kind, node: p.node, outcome: p.outcome, op: p.op, value: p.value };
    }
    if (p.kind === 'expert-runs') return { kind: p.kind, op: p.op, value: p.value };
    if (p.kind === 'artifact-exists') return { kind: p.kind, artifact: p.artifact };
    return { kind: p.kind, predicates: p.predicates.map(plainPredicate) };
  };
  return {
    version: document.version,
    title: document.title,
    rationaleArtifact: document.rationaleArtifact,
    entries: document.entries,
    artifacts: document.artifacts.map((a) => ({
      id: a.id,
      path: a.path,
      producer: a.producer,
      consumers: a.consumers,
      mediaType: a.mediaType,
      maxBytes: a.maxBytes,
      required: a.required,
    })),
    nodes: document.nodes.map(plainNode),
    edges: document.edges.map((e) => ({ id: e.id, from: e.from, on: e.on, to: e.to })),
    budgets: {
      maxNodeRuns: document.budgets.maxNodeRuns,
      maxExpertRuns: document.budgets.maxExpertRuns,
      maxReplans: document.budgets.maxReplans,
    },
  };
}

export function compileGraphDocument(
  document: GraphDocument,
  context: CompileContext,
  debug?: (message: string) => void,
): CompileResult {
  debug?.(
    `[graph] compile: ${document.nodes.length} node(s), ${document.edges.length} edge(s), ` +
      `${document.entries.length} entr(ies), ${document.artifacts.length} artifact(s) against ` +
      `${context.repositories.size} repositor(ies)`,
  );
  const diags: CompileDiagnostic[] = [];
  const error = (code: CompileDiagnosticCode, where: string, message: string): void => {
    diags.push({ code, where, message, severity: 'error' });
  };

  // Unique ids.
  const seenNode = new Set<string>();
  for (const node of document.nodes) {
    if (seenNode.has(node.id)) {
      error('duplicate-node-id', node.id, `duplicate node id "${node.id}"`);
    }
    seenNode.add(node.id);
  }
  const seenArtifact = new Set<string>();
  for (const artifact of document.artifacts) {
    if (seenArtifact.has(artifact.id)) {
      error('duplicate-artifact-id', artifact.id, `duplicate artifact id "${artifact.id}"`);
    }
    seenArtifact.add(artifact.id);
  }
  const seenEdge = new Set<string>();
  for (const edge of document.edges) {
    if (seenEdge.has(edge.id)) {
      error('duplicate-edge-id', edge.id, `duplicate edge id "${edge.id}"`);
    }
    seenEdge.add(edge.id);
  }

  const nodes = new Map(document.nodes.map((n) => [n.id, n]));
  const artifacts = new Map(document.artifacts.map((a) => [a.id, a]));
  const cfg = adjacency(document);

  // Entries.
  if (document.entries.length === 0) {
    error('empty-entries', 'entries', 'graph declares no entries');
  }
  for (const entry of document.entries) {
    if (!nodes.has(entry)) {
      error('unknown-entry', entry, `entry "${entry}" is not a node`);
    }
  }

  // Edges: sources, destinations, declared outcomes.
  for (const edge of document.edges) {
    const source = nodes.get(edge.from);
    if (!source) {
      error('unknown-edge-source', edge.id, `edge "${edge.id}" has unknown source "${edge.from}"`);
      continue;
    }
    const sourceOutcomes: readonly string[] = source.outcomes;
    if (!sourceOutcomes.includes(edge.on)) {
      error(
        'edge-outcome-undeclared',
        edge.id,
        `edge "${edge.id}" fires outcome "${edge.on}" not declared by node "${edge.from}"`,
      );
    }
    if (edge.to !== END && !nodes.has(edge.to)) {
      error('unknown-edge-destination', edge.id, `edge "${edge.id}" has unknown destination "${edge.to}"`);
    }
  }

  // Every normal outcome of every node must have at least one edge. Agent
  // `blocked`/`replan` and command `infrastructure-error` are reserved
  // control/fault outcomes and need none.
  for (const node of document.nodes) {
    for (const outcome of node.outcomes) {
      if (RESERVED_OUTCOMES.has(outcome)) continue;
      const hasEdge = document.edges.some((e) => e.from === node.id && e.on === outcome);
      if (!hasEdge) {
        error(
          'missing-normal-edge',
          node.id,
          `node "${node.id}" outcome "${outcome}" has no outgoing edge`,
        );
      }
    }
  }

  // Reachability: at least one END path; every node reachable from entries.
  const reachable = reachableFrom(ENTRY, cfg);
  if (!reachable.has(END)) {
    error('no-end-path', '', 'graph has no path from entries to END');
  }
  for (const node of document.nodes) {
    if (!reachable.has(node.id)) {
      error('unreachable-node', node.id, `node "${node.id}" is unreachable from entries`);
    }
  }

  // Artifacts: references exist; outputs have one safe destination; nothing
  // is unreferenced; planner-produced files exist at compile time.
  const referencedArtifacts = new Set<string>([document.rationaleArtifact]);
  for (const node of document.nodes) {
    if (node.kind === 'agent') {
      for (const id of [node.instructionsArtifact, ...node.inputs, ...node.outputs]) {
        referencedArtifacts.add(id);
        if (!artifacts.has(id)) {
          error('unknown-artifact', node.id, `node "${node.id}" references unknown artifact "${id}"`);
        }
      }
      for (const id of node.outputs) {
        const artifact = artifacts.get(id);
        if (artifact && artifact.producer !== node.id) {
          error(
            'undeliverable-output',
            node.id,
            `node "${node.id}" output "${id}" is produced by "${artifact.producer}"`,
          );
        }
      }
    }
  }
  for (const artifact of document.artifacts) {
    if (artifact.producer !== '$planner' && !nodes.has(artifact.producer)) {
      error(
        'unknown-artifact-producer',
        artifact.id,
        `artifact "${artifact.id}" produced by unknown node "${artifact.producer}"`,
      );
    }
    for (const consumer of artifact.consumers) {
      if (!nodes.has(consumer)) {
        error('unknown-consumer', artifact.id, `artifact "${artifact.id}" lists unknown consumer "${consumer}"`);
      }
    }
    if (artifact.producer === '$planner' && !context.artifactFileExists(artifact.id)) {
      error(
        'planner-artifact-missing',
        artifact.id,
        `planner-produced artifact "${artifact.id}" has no file at compile time`,
      );
    }
  }
  for (const artifact of document.artifacts) {
    if (!referencedArtifacts.has(artifact.id)) {
      error('unreferenced-artifact', artifact.id, `artifact "${artifact.id}" is referenced by no node`);
    }
  }

  // Profiles, commands, repositories.
  for (const node of document.nodes) {
    if (node.kind === 'agent') {
      if (!context.profiles.has(node.profile)) {
        error('unknown-profile', node.id, `node "${node.id}" references unknown profile "${node.profile}"`);
      }
    } else if (node.kind === 'command') {
      const def = context.commands.get(node.command);
      if (!def) {
        error('unknown-command', node.id, `node "${node.id}" references unknown command "${node.command}"`);
        continue;
      }
      for (const repo of node.repositories) {
        if (!context.repositories.has(repo)) {
          error('unknown-command-repository', node.id, `node "${node.id}" references unknown repository "${repo}"`);
        } else if (!def.permittedRepositories.includes(repo)) {
          error(
            'command-repository-not-permitted',
            node.id,
            `command "${node.command}" is not permitted for repository "${repo}"`,
          );
        }
      }
    }
    if (node.kind === 'agent') {
      // Every agent node runs in an isolated clone of the repositories it
      // claims, so a node claiming none has no workspace to run in. Reject it
      // here, where the diagnostic feeds the submit/replan loop, instead of
      // parking the node — and the whole run — at launch time.
      if (node.resources.reads.length === 0 && node.resources.writes.length === 0) {
        error(
          'no-repository-claim',
          node.id,
          `node "${node.id}" claims no repository; an agent node must claim at least one repository to have a workspace`,
        );
      }
      for (const claim of [...node.resources.reads, ...node.resources.writes]) {
        if (!context.repositories.has(claim.repo)) {
          error('unknown-repository', node.id, `node "${node.id}" claims unknown repository "${claim.repo}"`);
        }
      }
    }
  }

  // Gate policies reference valid nodes/artifacts/outcomes.
  for (const node of document.nodes) {
    if (node.kind === 'gate') {
      checkGatePredicate(node.policy, nodes, artifacts, diags);
      collectPredicateArtifacts(node.policy, referencedArtifacts);
    }
  }

  // Aggregate budgets within project maxima.
  const maxima: Array<[keyof typeof document.budgets, string]> = [
    ['maxNodeRuns', 'maxNodeRuns'],
    ['maxExpertRuns', 'maxExpertRuns'],
    ['maxReplans', 'maxReplans'],
  ];
  for (const [key] of maxima) {
    const declared = document.budgets[key];
    const project = context.projectMaxima[key];
    if (declared > project) {
      error(
        'budget-exceeds-project-maximum',
        `budgets.${key}`,
        `declared ${key} ${declared} exceeds the project maximum ${project}`,
      );
    }
  }

  // Expert-budget rule, exactly the design's formula. Failing it is a
  // compile error, not a runtime block.
  let expertVisits = 0;
  for (const node of document.nodes) {
    if (node.kind === 'agent' && context.profiles.get(node.profile) === 'expert') {
      expertVisits += node.budget.maxVisits;
    }
  }
  // The replan reserve is what THIS document permits, never the project
  // maximum: a planner cannot see `limits.maxReplans`, so charging the project
  // number leaves a document declaring fewer replans permanently unsatisfiable
  // and the planner resubmitting identical budgets until its attempts run out.
  // The run's remaining permitted replans still cap it, so a replan compile
  // never reserves more than the run can still spend.
  const replanReserve = Math.min(
    context.expertSpend.permittedReplans,
    document.budgets.maxReplans,
  );
  const bootstrapReserve = context.expertSpend.bootstrapUnspent ? 1 : 0;
  const expertTotal =
    context.expertSpend.spentPlannerRuns + replanReserve + bootstrapReserve + expertVisits;
  if (expertTotal > document.budgets.maxExpertRuns) {
    // The breakdown IS the repair instruction: the planner's next attempt can
    // only converge if the message names the minimum it must declare and the
    // terms it can change (maxReplans, expert node visits).
    error(
      'expert-budget-exceeded',
      'budgets.maxExpertRuns',
      `expert budget ${expertTotal} exceeds declared maxExpertRuns ${document.budgets.maxExpertRuns}` +
        ` — declare maxExpertRuns at least ${expertTotal}, or lower the terms:` +
        ` ${context.expertSpend.spentPlannerRuns} planner run(s) already spent` +
        ` + ${replanReserve} replan reserve (maxReplans ${document.budgets.maxReplans})` +
        ` + ${bootstrapReserve} bootstrap + ${expertVisits} expert node visit(s)`,
    );
  }

  // Fork/join structure.
  checkJoins(document, cfg, document.edges, diags);

  // Fork-lineage depth: a loop chain deeper than the hard bound is rejected
  // at compile, so the runtime stack can never overflow it (Slice 5 Task 4).
  checkLineageDepth(document, cfg, error);

  // Resource overlaps for scheduler serialization, and the serialization
  // warning (never an error).
  const claims = buildClaims(document, context);
  const overlaps: WriteOverlap[] = [];
  const seenOverlap = new Set<string>();
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.node === b.node) continue;
      if (!claimsOverlap(a, b)) continue;
      const path = a.path.length >= b.path.length ? a.path : b.path;
      const key = [a.node, b.node, a.domain, path].sort().join('\u0000');
      if (seenOverlap.has(key)) continue;
      seenOverlap.add(key);
      overlaps.push({ a: a.node, b: b.node, domain: a.domain, path });
    }
  }
  overlaps.sort((x, y) =>
    [x.a, x.b, x.path].join('\u0000') < [y.a, y.b, y.path].join('\u0000') ? -1 : 1,
  );

  const agentIds = new Set(
    document.nodes.filter((n): n is AgentNode => n.kind === 'agent').map((n) => n.id),
  );
  const agentList = [...agentIds].sort();
  let overlappingAgentPairs = 0;
  for (let i = 0; i < agentList.length; i++) {
    for (let j = i + 1; j < agentList.length; j++) {
      const pairHasWriteOverlap = overlaps.some(
        (o) =>
          (o.a === agentList[i] && o.b === agentList[j]) ||
          (o.a === agentList[j] && o.b === agentList[i]),
      );
      if (pairHasWriteOverlap) overlappingAgentPairs++;
    }
  }
  const warnings: CompileDiagnostic[] = [];
  if (agentList.length > 0 && overlappingAgentPairs / agentList.length > 0.5) {
    warnings.push({
      code: 'warn-serialized-plan',
      where: '',
      message: `${overlappingAgentPairs} overlapping agent write-claim pairs out of ${agentList.length} agent nodes — the plan serializes more than half of its agents`,
      severity: 'warning',
    });
  }

  if (diags.length > 0) {
    // The compile is the single largest producer of terminal blocks, and its
    // rejection reasons were readable only from the diagnostics FILE. Naming
    // the first two here is what makes a planner rejected three times on the
    // SAME field legible as a prompt defect rather than a flaky planner.
    debug?.(
      `[graph] compile: rejected with ${diags.length} diagnostic(s) — ` +
        diags.slice(0, 2).map((d) => `${d.code}: ${d.where}`).join('; '),
    );
    return { ok: false, diagnostics: diags };
  }

  const outgoing: Record<string, ApproachEdge[]> = {};
  const incoming: Record<string, string[]> = {};
  for (const node of document.nodes) {
    outgoing[node.id] = document.edges.filter((e) => e.from === node.id);
    incoming[node.id] = document.edges.filter((e) => e.to === node.id).map((e) => e.from);
  }
  const commandFingerprints: Record<string, string> = {};
  for (const node of document.nodes) {
    if (node.kind === 'command') {
      const def = context.commands.get(node.command);
      if (def) commandFingerprints[node.command] = def.fingerprint;
    }
  }

  const canonical = canonicalJson(toPlainDocument(document));
  debug?.(
    `[graph] compile: accepted — fingerprint ${canonicalFingerprint(canonical).slice(0, 12)}, ` +
      `${overlaps.length} write overlap(s), ${warnings.length} warning(s)`,
  );
  return {
    ok: true,
    compiled: {
      document,
      canonicalJson: canonical,
      fingerprint: canonicalFingerprint(canonical),
      commandFingerprints,
      outgoing,
      incoming,
      overlaps,
      warnings,
    },
  };
}

function collectPredicateArtifacts(
  predicate: GatePredicate,
  into: Set<string>,
): void {
  if (predicate.kind === 'artifact-exists') into.add(predicate.artifact);
  else if (predicate.kind === 'all' || predicate.kind === 'any') {
    for (const child of predicate.predicates) collectPredicateArtifacts(child, into);
  }
}

export type { AgentNode, CommandNode, GateNode, JoinNode };
