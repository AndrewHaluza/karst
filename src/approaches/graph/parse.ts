/**
 * Pure parser for the generated graph document (Slice 2 Task 3).
 *
 * The planner's output is untrusted data; this parser is the closed boundary
 * every High-severity injection and coercion class lands on. Unknown object
 * fields are rejected, never ignored; every numeric value is a finite safe
 * integer inside its field's explicit inclusive min/max; document, collection,
 * and string sizes are bounded; node/artifact/edge/profile/repository/command
 * ids use the bounded safe identifier grammar, with `$planner` and `$entry`
 * reserved; artifact and resource paths normalize through `normalizeGraphPath`.
 *
 * This module is pure: it imports no store, no vscode, no provider.
 */

import { canonicalRepoId } from '../../runtime/repoId.js';
import { normalizeGraphPath } from './paths.js';

export const GRAPH_DOCUMENT_VERSION = 1;

/** Bounds for every parser-visible quantity (design, "Node IDs and paths" and
 *  "Ceiling rationale"). All are inclusive. */
export const GRAPH_LIMITS = {
  maxDocumentBytes: 1024 * 1024,
  maxIdentifierLength: 64,
  maxBoundedStringLength: 200,
  maxEntries: 20,
  maxArtifacts: 200,
  maxNodes: 200,
  maxEdges: 1000,
  maxList: 20,
  maxOutcomes: 4,
  maxPredicateDepth: 6,
  maxPredicateCollection: 20,
  maxLineageDepth: 64,
  minMaxVisits: 1,
  maxMaxVisits: 20,
  minMaxNodeRuns: 1,
  maxMaxNodeRuns: 200,
  minMaxExpertRuns: 0,
  maxMaxExpertRuns: 10,
  minMaxReplans: 0,
  maxMaxReplans: 5,
  minMaxBytes: 1,
  maxMaxBytes: 100 * 1024 * 1024,
  minPredicateValue: 0,
  maxPredicateValue: 1000,
} as const;

export type AgentOutcome = 'complete' | 'blocked' | 'replan';
export type CommandOutcome = 'passed' | 'failed' | 'infrastructure-error';
export type GateOutcome = 'matched' | 'not-matched';
export type JoinOutcome = 'complete';
export type ComparisonOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export type GatePredicateKind =
  | 'node-visits'
  | 'node-outcomes'
  | 'expert-runs'
  | 'artifact-exists'
  | 'all'
  | 'any';
export type MediaType = 'text/markdown' | 'application/json' | 'text/plain';

export type GatePredicate =
  | { kind: 'node-visits'; node: string; op: ComparisonOperator; value: number }
  | { kind: 'node-outcomes'; node: string; outcome: string; op: ComparisonOperator; value: number }
  | { kind: 'expert-runs'; op: ComparisonOperator; value: number }
  | { kind: 'artifact-exists'; artifact: string }
  | { kind: 'all'; predicates: GatePredicate[] }
  | { kind: 'any'; predicates: GatePredicate[] };

export interface PathClaim {
  repo: string;
  paths: string[];
}

export interface ResourceClaims {
  reads: PathClaim[];
  writes: PathClaim[];
}

export interface NodeBudget {
  maxVisits: number;
}

export interface ArtifactDef {
  id: string;
  path: string;
  producer: '$planner' | string;
  consumers: string[];
  mediaType: MediaType;
  maxBytes: number;
  required: boolean;
}

export interface AgentNode {
  id: string;
  kind: 'agent';
  label: string;
  profile: string;
  instructionsArtifact: string;
  inputs: string[];
  outputs: string[];
  resources: ResourceClaims;
  outcomes: AgentOutcome[];
  budget: NodeBudget;
}

export interface CommandNode {
  id: string;
  kind: 'command';
  label: string;
  command: string;
  repositories: string[];
  outcomes: CommandOutcome[];
  budget: NodeBudget;
}

export interface GateNode {
  id: string;
  kind: 'gate';
  label: string;
  policy: GatePredicate;
  outcomes: GateOutcome[];
  budget: NodeBudget;
}

export interface JoinNode {
  id: string;
  kind: 'join';
  label: string;
  forkFrom: '$entry' | string;
  waitFor: string[];
  mode: 'all';
  outcomes: JoinOutcome[];
  budget: NodeBudget;
}

export type ApproachNode = AgentNode | CommandNode | GateNode | JoinNode;

export interface ApproachEdge {
  id: string;
  from: string;
  on: string;
  to: string | 'END';
}

export interface GraphBudgets {
  maxNodeRuns: number;
  maxExpertRuns: number;
  maxReplans: number;
}

export interface GraphDocument {
  version: typeof GRAPH_DOCUMENT_VERSION;
  title: string;
  rationaleArtifact: string;
  entries: string[];
  artifacts: ArtifactDef[];
  nodes: ApproachNode[];
  edges: ApproachEdge[];
  budgets: GraphBudgets;
}

export type GraphParseDiagnosticCode =
  | 'unknown-field'
  | 'invalid-identifier'
  | 'reserved-identifier'
  | 'invalid-number'
  | 'number-out-of-range'
  | 'collection-too-large'
  | 'string-too-long'
  | 'invalid-string'
  | 'predicate-depth-exceeded'
  | 'predicate-collection-too-large'
  | 'invalid-policy-kind'
  | 'invalid-kind'
  | 'invalid-outcome'
  | 'invalid-mode'
  | 'generated-config-forbidden'
  | 'root-not-object'
  | 'document-too-large'
  | 'invalid-json'
  | 'unsupported-version'
  | 'missing-field'
  | 'invalid-media-type'
  | 'invalid-boolean'
  | 'invalid-path'
  | 'windows-path-alias'
  | 'glob-path'
  | 'invalid-operator';

export interface GraphParseDiagnostic {
  code: GraphParseDiagnosticCode;
  where: string;
  message: string;
}

export type GraphParseResult =
  | { ok: true; document: GraphDocument }
  | { ok: false; diagnostics: GraphParseDiagnostic[] };

const IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Repository claims alone accept the manifest's own casing (`BE`, `DBGW`) and
 *  canonicalize; every other identifier stays lowercase-only. */
const REPO_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const RESERVED_IDS = new Set(['$planner', '$entry']);
const MEDIA_TYPES = new Set<MediaType>(['text/markdown', 'application/json', 'text/plain']);
const OPERATORS = new Set<ComparisonOperator>(['lt', 'lte', 'eq', 'gte', 'gt']);

const AGENT_OUTCOMES = new Set<AgentOutcome>(['complete', 'blocked', 'replan']);
const COMMAND_OUTCOMES = new Set<CommandOutcome>([
  'passed',
  'failed',
  'infrastructure-error',
]);
const GATE_OUTCOMES = new Set<GateOutcome>(['matched', 'not-matched']);
const JOIN_OUTCOMES = new Set<JoinOutcome>(['complete']);

const NODE_KINDS = new Set(['agent', 'command', 'gate', 'join']);
const FORBIDDEN_NODE_FIELDS = ['provider', 'model', 'effort'] as const;

type DiagSink = { diagnostics: GraphParseDiagnostic[] };

function diag(
  sink: DiagSink,
  code: GraphParseDiagnosticCode,
  where: string,
  message: string,
): void {
  sink.diagnostics.push({ code, where, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownFields(
  sink: DiagSink,
  value: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  const knownSet = new Set(known);
  for (const key of Object.keys(value)) {
    if (!knownSet.has(key)) {
      diag(sink, 'unknown-field', where, `unknown field "${key}"`);
    }
  }
}

/** Bounded safe-identifier check; `$planner`/`$entry` are reserved sentinels. */
function checkIdentifier(sink: DiagSink, value: unknown, where: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > GRAPH_LIMITS.maxIdentifierLength) {
    diag(sink, 'invalid-identifier', where, 'expected a safe identifier');
    return undefined;
  }
  if (RESERVED_IDS.has(value)) {
    diag(sink, 'reserved-identifier', where, `"${value}" is a reserved sentinel`);
    return undefined;
  }
  if (!IDENTIFIER_RE.test(value)) {
    diag(sink, 'invalid-identifier', where, 'expected lowercase letters, digits, hyphens');
    return undefined;
  }
  return value;
}

/**
 * A repository claim: the bounded safe-identifier grammar widened to the
 * manifest's own casing, returned in canonical (case-folded) form. The
 * compile context keys its repository map the same way, so `BE`, `be` and
 * `Be` all resolve to the one manifest entry — the two halves of the
 * identifier can no longer disagree (see `runtime/repoId.ts`).
 */
function checkRepoIdentifier(sink: DiagSink, value: unknown, where: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > GRAPH_LIMITS.maxIdentifierLength) {
    diag(sink, 'invalid-identifier', where, 'expected a safe identifier');
    return undefined;
  }
  // Belt-and-braces: the sentinels start with `$`, which the grammar below
  // already rejects. Kept so the reserved set stays enforced here if the
  // grammar ever widens, not because a sentinel can reach it today.
  if (RESERVED_IDS.has(value)) {
    diag(sink, 'reserved-identifier', where, `"${value}" is a reserved sentinel`);
    return undefined;
  }
  if (!REPO_IDENTIFIER_RE.test(value)) {
    diag(sink, 'invalid-identifier', where, 'expected letters, digits, hyphens');
    return undefined;
  }
  return canonicalRepoId(value);
}

/** Bounded string check. */
function checkBoundedString(
  sink: DiagSink,
  value: unknown,
  where: string,
  maxLength: number = GRAPH_LIMITS.maxBoundedStringLength,
): string | undefined {
  if (typeof value !== 'string') {
    diag(sink, 'invalid-string', where, 'expected a string');
    return undefined;
  }
  if (value.length > maxLength) {
    diag(sink, 'string-too-long', where, `string exceeds ${maxLength} characters`);
    return undefined;
  }
  return value;
}

/** Finite safe integer inside [min, max]; never coerced. */
function checkNumber(
  sink: DiagSink,
  value: unknown,
  where: string,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    diag(sink, 'invalid-number', where, 'expected a finite safe integer');
    return undefined;
  }
  if (value < min || value > max) {
    diag(sink, 'number-out-of-range', where, `expected an integer in [${min}, ${max}]`);
    return undefined;
  }
  return value;
}

function checkPath(sink: DiagSink, value: unknown, where: string): string | undefined {
  if (typeof value !== 'string') {
    diag(sink, 'invalid-path', where, 'expected a relative path string');
    return undefined;
  }
  const result = normalizeGraphPath(value);
  if (!result.ok) {
    diag(sink, result.code, where, `path rejected: ${result.code}`);
    return undefined;
  }
  return result.value;
}

function checkList(
  sink: DiagSink,
  value: unknown,
  where: string,
  max: number = GRAPH_LIMITS.maxList,
): unknown[] | undefined {
  if (value === undefined) {
    diag(sink, 'missing-field', where, 'missing field');
    return undefined;
  }
  if (!Array.isArray(value)) {
    diag(sink, 'invalid-string', where, 'expected an array');
    return undefined;
  }
  if (value.length > max) {
    diag(sink, 'collection-too-large', where, `array exceeds ${max} elements`);
    return undefined;
  }
  return value;
}

function checkOutcomes(
  sink: DiagSink,
  value: unknown,
  where: string,
  allowed: ReadonlySet<string>,
): string[] | undefined {
  const list = checkList(sink, value, where, GRAPH_LIMITS.maxOutcomes);
  if (!list) return undefined;
  const outcomes: string[] = [];
  list.forEach((item, index) => {
    if (typeof item !== 'string' || !allowed.has(item)) {
      diag(sink, 'invalid-outcome', `${where}[${index}]`, 'outcome not in the closed set');
    } else {
      outcomes.push(item);
    }
  });
  return outcomes;
}

function checkOperator(
  sink: DiagSink,
  value: unknown,
  where: string,
): ComparisonOperator | undefined {
  if (typeof value !== 'string' || !OPERATORS.has(value as ComparisonOperator)) {
    diag(sink, 'invalid-operator', where, 'expected lt, lte, eq, gte, or gt');
    return undefined;
  }
  return value as ComparisonOperator;
}

function checkGatePredicate(
  sink: DiagSink,
  value: unknown,
  where: string,
  depth: number,
): GatePredicate | undefined {
  if (!isRecord(value)) {
    diag(sink, 'invalid-policy-kind', where, 'expected a predicate object');
    return undefined;
  }
  const kind = value['kind'];
  if (
    typeof kind !== 'string' ||
    !(NODE_PREDICATE_KINDS as ReadonlySet<string>).has(kind)
  ) {
    diag(sink, 'invalid-policy-kind', where, 'unsupported predicate kind');
    return undefined;
  }
  if (kind === 'all' || kind === 'any') {
    unknownFields(sink, value, ['kind', 'predicates'], where);
    const predicates = value['predicates'];
    if (!Array.isArray(predicates)) {
      diag(sink, 'invalid-string', where, 'expected a predicates array');
      return undefined;
    }
    if (predicates.length > GRAPH_LIMITS.maxPredicateCollection) {
      diag(sink, 'predicate-collection-too-large', where, `composite predicate collection exceeds ${GRAPH_LIMITS.maxPredicateCollection}`);
      return undefined;
    }
    if (depth + 1 > GRAPH_LIMITS.maxPredicateDepth) {
      diag(sink, 'predicate-depth-exceeded', where, 'composite predicate nesting too deep');
      return undefined;
    }
    const resolved: GatePredicate[] = [];
    predicates.forEach((item, index) => {
      const child = checkGatePredicate(sink, item, where, depth + 1);
      if (child) resolved.push(child);
    });
    return { kind, predicates: resolved } as GatePredicate;
  }
  if (kind === 'node-visits') {
    unknownFields(sink, value, ['kind', 'node', 'op', 'value'], where);
    const node = checkIdentifier(sink, value['node'], `${where}.node`);
    const op = checkOperator(sink, value['op'], `${where}.op`);
    const num = checkNumber(
      sink,
      value['value'],
      `${where}.value`,
      GRAPH_LIMITS.minPredicateValue,
      GRAPH_LIMITS.maxPredicateValue,
    );
    if (node === undefined || op === undefined || num === undefined) return undefined;
    return { kind: 'node-visits', node, op, value: num };
  }
  if (kind === 'node-outcomes') {
    unknownFields(sink, value, ['kind', 'node', 'outcome', 'op', 'value'], where);
    const node = checkIdentifier(sink, value['node'], `${where}.node`);
    const outcome = checkBoundedString(sink, value['outcome'], `${where}.outcome`);
    const op = checkOperator(sink, value['op'], `${where}.op`);
    const num = checkNumber(
      sink,
      value['value'],
      `${where}.value`,
      GRAPH_LIMITS.minPredicateValue,
      GRAPH_LIMITS.maxPredicateValue,
    );
    if (node === undefined || outcome === undefined || op === undefined || num === undefined) {
      return undefined;
    }
    return { kind: 'node-outcomes', node, outcome, op, value: num };
  }
  if (kind === 'expert-runs') {
    unknownFields(sink, value, ['kind', 'op', 'value'], where);
    const op = checkOperator(sink, value['op'], `${where}.op`);
    const num = checkNumber(
      sink,
      value['value'],
      `${where}.value`,
      GRAPH_LIMITS.minPredicateValue,
      GRAPH_LIMITS.maxPredicateValue,
    );
    if (op === undefined || num === undefined) return undefined;
    return { kind: 'expert-runs', op, value: num };
  }
  // artifact-exists
  unknownFields(sink, value, ['kind', 'artifact'], where);
  const artifact = checkIdentifier(sink, value['artifact'], `${where}.artifact`);
  if (artifact === undefined) return undefined;
  return { kind: 'artifact-exists', artifact };
}

const NODE_PREDICATE_KINDS = new Set<GatePredicateKind>([
  'node-visits',
  'node-outcomes',
  'expert-runs',
  'artifact-exists',
  'all',
  'any',
]);

function checkClaim(
  sink: DiagSink,
  value: unknown,
  where: string,
): PathClaim | undefined {
  if (!isRecord(value)) {
    diag(sink, 'invalid-string', where, 'expected a claim object');
    return undefined;
  }
  unknownFields(sink, value, ['repo', 'paths'], where);
  const repo = checkRepoIdentifier(sink, value['repo'], `${where}.repo`);
  const pathsRaw = checkList(sink, value['paths'], `${where}.paths`);
  const paths: string[] = [];
  if (pathsRaw) {
    pathsRaw.forEach((item, index) => {
      const path = checkPath(sink, item, `${where}.paths[${index}]`);
      if (path !== undefined) paths.push(path);
    });
  }
  if (repo === undefined || pathsRaw === undefined) return undefined;
  return { repo, paths };
}

function checkResources(
  sink: DiagSink,
  value: unknown,
  where: string,
): ResourceClaims | undefined {
  if (!isRecord(value)) {
    diag(sink, 'missing-field', where, 'expected a resources object');
    return undefined;
  }
  unknownFields(sink, value, ['reads', 'writes'], where);
  const reads = checkList(sink, value['reads'], `${where}.reads`);
  const writes = checkList(sink, value['writes'], `${where}.writes`);
  const readClaims: PathClaim[] = [];
  const writeClaims: PathClaim[] = [];
  if (reads) {
    reads.forEach((item, index) => {
      const claim = checkClaim(sink, item, `${where}.reads[${index}]`);
      if (claim) readClaims.push(claim);
    });
  }
  if (writes) {
    writes.forEach((item, index) => {
      const claim = checkClaim(sink, item, `${where}.writes[${index}]`);
      if (claim) writeClaims.push(claim);
    });
  }
  if (reads === undefined || writes === undefined) return undefined;
  return { reads: readClaims, writes: writeClaims };
}

function checkNode(sink: DiagSink, value: unknown, where: string): ApproachNode | undefined {
  if (!isRecord(value)) {
    diag(sink, 'invalid-kind', where, 'expected a node object');
    return undefined;
  }
  for (const field of FORBIDDEN_NODE_FIELDS) {
    if (field in value) {
      diag(sink, 'generated-config-forbidden', `${where}.${field}`, 'generated nodes cannot carry provider/model/effort');
    }
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !NODE_KINDS.has(kind)) {
    unknownFields(sink, value, COMMON_NODE_KEYS, where);
    diag(sink, 'invalid-kind', `${where}.kind`, 'unsupported node kind');
    return undefined;
  }
  const id = checkIdentifier(sink, value['id'], `${where}.id`);
  const label = checkBoundedString(sink, value['label'], `${where}.label`);
  const budgetRaw = value['budget'];
  const budgetWhere = `${where}.budget`;
  let budget: NodeBudget | undefined;
  if (budgetRaw === undefined) {
    diag(sink, 'missing-field', budgetWhere, 'missing node budget');
  } else if (isRecord(budgetRaw)) {
    unknownFields(sink, budgetRaw, ['maxVisits'], budgetWhere);
    const maxVisits = checkNumber(
      sink,
      budgetRaw['maxVisits'],
      `${budgetWhere}.maxVisits`,
      GRAPH_LIMITS.minMaxVisits,
      GRAPH_LIMITS.maxMaxVisits,
    );
    if (maxVisits !== undefined) budget = { maxVisits };
  }

  if (kind === 'agent') {
    unknownFields(
      sink,
      value,
      ['id', 'kind', 'label', 'profile', 'instructionsArtifact', 'inputs', 'outputs', 'resources', 'outcomes', 'budget'],
      where,
    );
    const profile = checkIdentifier(sink, value['profile'], `${where}.profile`);
    const instructionsArtifact = checkIdentifier(sink, value['instructionsArtifact'], `${where}.instructionsArtifact`);
    const inputs = checkIdentifierList(sink, value['inputs'], `${where}.inputs`);
    const outputs = checkIdentifierList(sink, value['outputs'], `${where}.outputs`);
    const resources = checkResources(sink, value['resources'], `${where}.resources`);
    const outcomes = checkOutcomes(sink, value['outcomes'], `${where}.outcomes`, AGENT_OUTCOMES);
    if (
      id === undefined || label === undefined || budget === undefined || profile === undefined ||
      instructionsArtifact === undefined || inputs === undefined || outputs === undefined ||
      resources === undefined || outcomes === undefined
    ) {
      return undefined;
    }
    return { id, kind: 'agent', label, profile, instructionsArtifact, inputs, outputs, resources, outcomes: outcomes as AgentOutcome[], budget };
  }
  if (kind === 'command') {
    unknownFields(sink, value, ['id', 'kind', 'label', 'command', 'repositories', 'outcomes', 'budget'], where);
    const command = checkIdentifier(sink, value['command'], `${where}.command`);
    const repositories = checkRepoIdentifierList(sink, value['repositories'], `${where}.repositories`);
    const outcomes = checkOutcomes(sink, value['outcomes'], `${where}.outcomes`, COMMAND_OUTCOMES);
    if (id === undefined || label === undefined || budget === undefined || command === undefined || repositories === undefined || outcomes === undefined) {
      return undefined;
    }
    return { id, kind: 'command', label, command, repositories, outcomes: outcomes as CommandOutcome[], budget };
  }
  if (kind === 'gate') {
    unknownFields(sink, value, ['id', 'kind', 'label', 'policy', 'outcomes', 'budget'], where);
    const policy = checkGatePredicate(sink, value['policy'], `${where}.policy`, 1);
    const outcomes = checkOutcomes(sink, value['outcomes'], `${where}.outcomes`, GATE_OUTCOMES);
    if (id === undefined || label === undefined || budget === undefined || policy === undefined || outcomes === undefined) {
      return undefined;
    }
    return { id, kind: 'gate', label, policy, outcomes: outcomes as GateOutcome[], budget };
  }
  // join
  unknownFields(sink, value, ['id', 'kind', 'label', 'forkFrom', 'waitFor', 'mode', 'outcomes', 'budget'], where);
  const forkFromRaw = value['forkFrom'];
  let forkFrom: '$entry' | string | undefined;
  if (forkFromRaw === '$entry') {
    forkFrom = '$entry';
  } else {
    forkFrom = checkIdentifier(sink, forkFromRaw, `${where}.forkFrom`);
  }
  const waitFor = checkIdentifierList(sink, value['waitFor'], `${where}.waitFor`);
  const modeRaw = value['mode'];
  let mode: 'all' | undefined;
  if (modeRaw !== 'all') {
    diag(sink, 'invalid-mode', `${where}.mode`, 'only mode "all" is supported');
  } else {
    mode = 'all';
  }
  const outcomes = checkOutcomes(sink, value['outcomes'], `${where}.outcomes`, JOIN_OUTCOMES);
  if (id === undefined || label === undefined || budget === undefined || forkFrom === undefined || waitFor === undefined || mode === undefined || outcomes === undefined) {
    return undefined;
  }
  return { id, kind: 'join', label, forkFrom: forkFrom as '$entry' | string, waitFor, mode, outcomes: outcomes as JoinOutcome[], budget };
}

const COMMON_NODE_KEYS = [
  'id', 'kind', 'label', 'budget', 'profile', 'instructionsArtifact', 'inputs',
  'outputs', 'resources', 'outcomes', 'command', 'repositories', 'policy',
  'forkFrom', 'waitFor', 'mode',
];

function checkIdentifierList(
  sink: DiagSink,
  value: unknown,
  where: string,
): string[] | undefined {
  const list = checkList(sink, value, where);
  if (!list) return undefined;
  const ids: string[] = [];
  list.forEach((item, index) => {
    const id = checkIdentifier(sink, item, `${where}[${index}]`);
    if (id !== undefined) ids.push(id);
  });
  return ids;
}

/** `checkRepoIdentifier` over a list — the command node's `repositories`. */
function checkRepoIdentifierList(
  sink: DiagSink,
  value: unknown,
  where: string,
): string[] | undefined {
  const list = checkList(sink, value, where);
  if (!list) return undefined;
  const ids: string[] = [];
  list.forEach((item, index) => {
    const id = checkRepoIdentifier(sink, item, `${where}[${index}]`);
    if (id !== undefined) ids.push(id);
  });
  return ids;
}

function checkArtifact(sink: DiagSink, value: unknown, where: string): ArtifactDef | undefined {
  if (!isRecord(value)) {
    diag(sink, 'invalid-string', where, 'expected an artifact object');
    return undefined;
  }
  unknownFields(sink, value, ['id', 'path', 'producer', 'consumers', 'mediaType', 'maxBytes', 'required'], where);
  const id = checkIdentifier(sink, value['id'], `${where}.id`);
  const path = checkPath(sink, value['path'], `${where}.path`);
  const producerRaw = value['producer'];
  let producer: '$planner' | string | undefined;
  if (producerRaw === undefined) {
    diag(sink, 'missing-field', `${where}.producer`, 'missing producer');
  } else if (producerRaw === '$planner') {
    producer = '$planner';
  } else {
    producer = checkIdentifier(sink, producerRaw, `${where}.producer`);
  }
  const consumers = checkIdentifierList(sink, value['consumers'], `${where}.consumers`);
  const mediaTypeRaw = value['mediaType'];
  let mediaType: MediaType | undefined;
  if (typeof mediaTypeRaw !== 'string' || !MEDIA_TYPES.has(mediaTypeRaw as MediaType)) {
    diag(sink, 'invalid-media-type', `${where}.mediaType`, 'unsupported media type');
  } else {
    mediaType = mediaTypeRaw as MediaType;
  }
  const maxBytes = checkNumber(
    sink,
    value['maxBytes'],
    `${where}.maxBytes`,
    GRAPH_LIMITS.minMaxBytes,
    GRAPH_LIMITS.maxMaxBytes,
  );
  const requiredRaw = value['required'];
  let required: boolean | undefined;
  if (typeof requiredRaw !== 'boolean') {
    diag(sink, 'invalid-boolean', `${where}.required`, 'expected a boolean');
  } else {
    required = requiredRaw;
  }
  if (
    id === undefined || path === undefined || producer === undefined || consumers === undefined ||
    mediaType === undefined || maxBytes === undefined || required === undefined
  ) {
    return undefined;
  }
  return { id, path, producer, consumers, mediaType, maxBytes, required };
}

function checkEdge(sink: DiagSink, value: unknown, where: string): ApproachEdge | undefined {
  if (!isRecord(value)) {
    diag(sink, 'invalid-string', where, 'expected an edge object');
    return undefined;
  }
  unknownFields(sink, value, ['id', 'from', 'on', 'to'], where);
  const id = checkIdentifier(sink, value['id'], `${where}.id`);
  const from = checkIdentifier(sink, value['from'], `${where}.from`);
  const on = checkBoundedString(sink, value['on'], `${where}.on`);
  const toRaw = value['to'];
  let to: string | 'END' | undefined;
  if (toRaw === 'END') {
    to = 'END';
  } else {
    to = checkIdentifier(sink, toRaw, `${where}.to`);
  }
  if (id === undefined || from === undefined || on === undefined || to === undefined) {
    return undefined;
  }
  return { id, from, on, to };
}

function checkBudgets(sink: DiagSink, value: unknown): GraphBudgets | undefined {
  const where = 'budgets';
  if (!isRecord(value)) {
    diag(sink, 'missing-field', where, 'missing budgets block');
    return undefined;
  }
  unknownFields(sink, value, ['maxNodeRuns', 'maxExpertRuns', 'maxReplans'], where);
  const maxNodeRuns = checkNumber(
    sink,
    value['maxNodeRuns'],
    `${where}.maxNodeRuns`,
    GRAPH_LIMITS.minMaxNodeRuns,
    GRAPH_LIMITS.maxMaxNodeRuns,
  );
  const maxExpertRuns = checkNumber(
    sink,
    value['maxExpertRuns'],
    `${where}.maxExpertRuns`,
    GRAPH_LIMITS.minMaxExpertRuns,
    GRAPH_LIMITS.maxMaxExpertRuns,
  );
  const maxReplans = checkNumber(
    sink,
    value['maxReplans'],
    `${where}.maxReplans`,
    GRAPH_LIMITS.minMaxReplans,
    GRAPH_LIMITS.maxMaxReplans,
  );
  if (maxNodeRuns === undefined || maxExpertRuns === undefined || maxReplans === undefined) {
    return undefined;
  }
  return { maxNodeRuns, maxExpertRuns, maxReplans };
}

export function parseGraphDocument(input: string): GraphParseResult {
  const sink: DiagSink = { diagnostics: [] };

  if (input.length > GRAPH_LIMITS.maxDocumentBytes) {
    diag(sink, 'document-too-large', '', `document exceeds ${GRAPH_LIMITS.maxDocumentBytes} bytes`);
    return { ok: false, diagnostics: sink.diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    diag(sink, 'invalid-json', '', 'document is not valid JSON');
    return { ok: false, diagnostics: sink.diagnostics };
  }

  if (!isRecord(parsed)) {
    diag(sink, 'root-not-object', '', 'document root must be an object');
    return { ok: false, diagnostics: sink.diagnostics };
  }

  unknownFields(sink, parsed, ['version', 'title', 'rationaleArtifact', 'entries', 'artifacts', 'nodes', 'edges', 'budgets'], '');

  const versionRaw = parsed['version'];
  if (versionRaw === undefined) {
    diag(sink, 'missing-field', 'version', 'missing document version');
  } else if (versionRaw !== GRAPH_DOCUMENT_VERSION) {
    diag(sink, 'unsupported-version', 'version', `only version ${GRAPH_DOCUMENT_VERSION} is supported`);
  }

  const title = checkBoundedString(sink, parsed['title'], 'title');
  const rationaleArtifact = checkIdentifier(sink, parsed['rationaleArtifact'], 'rationaleArtifact');
  const entries = checkIdentifierList(sink, parsed['entries'], 'entries');

  const artifacts: ArtifactDef[] = [];
  const artifactsRaw = checkList(sink, parsed['artifacts'], 'artifacts', GRAPH_LIMITS.maxArtifacts);
  if (artifactsRaw) {
    artifactsRaw.forEach((item, index) => {
      const artifact = checkArtifact(sink, item, `artifacts[${index}]`);
      if (artifact) artifacts.push(artifact);
    });
  }

  const nodes: ApproachNode[] = [];
  const nodesRaw = checkList(sink, parsed['nodes'], 'nodes', GRAPH_LIMITS.maxNodes);
  if (nodesRaw) {
    nodesRaw.forEach((item, index) => {
      const node = checkNode(sink, item, `nodes[${index}]`);
      if (node) nodes.push(node);
    });
  }

  const edges: ApproachEdge[] = [];
  const edgesRaw = checkList(sink, parsed['edges'], 'edges', GRAPH_LIMITS.maxEdges);
  if (edgesRaw) {
    edgesRaw.forEach((item, index) => {
      const edge = checkEdge(sink, item, `edges[${index}]`);
      if (edge) edges.push(edge);
    });
  }

  const budgets = checkBudgets(sink, parsed['budgets']);

  if (sink.diagnostics.length > 0) {
    return { ok: false, diagnostics: sink.diagnostics };
  }

  return {
    ok: true,
    document: {
      version: GRAPH_DOCUMENT_VERSION,
      title: title!,
      rationaleArtifact: rationaleArtifact!,
      entries: entries!,
      artifacts,
      nodes,
      edges,
      budgets: budgets!,
    },
  };
}
