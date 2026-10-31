import { STAGE_KEYS } from '../model/types.js';
import type { BlockerKind, StageKey, StageStatus } from '../model/types.js';
import { KNOWN_AGENT_PROVIDERS } from '../model/agentProviders.js';
import type {
  FixtureSpec, GateRunSeed, RepoBinding, TaskGate, TaskRepo, ProcessRunSeed, RecoveryRoundSeed, RowSeeds, StageRunSeed, StageSeed, TicketSeed,
} from './fixtures.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const STAGE_STATUSES: readonly StageStatus[] = ['pending', 'running', 'passed', 'failed', 'skipped', 'bypassed'];
const STAGE_RUN_STATUSES = ['running', 'finished'] as const;
const STAGE_RUN_OUTCOMES = ['advanced', 'blocked', 'stopped'] as const;
const PROCESS_RUN_STATUSES = ['running', 'passed', 'failed', 'interrupted'] as const;
const ROUND_STAGES = ['uat', 'review', 'ship'] as const;
const ROUND_PROCESSES = ['gates', 'tester', 'review', 'pr-review'] as const;
const ROUND_TRIGGERS = [
  'gate-failure', 'tester-verifier-failure', 'blocking-tester-observations',
  'blocking-review-findings', 'upstream-changes-requested', 'usage-limit-dismissed',
] as const;
const STARTED = '2026-01-01T00:00:00.000Z';

/** Refuses unknown keys, so a typo or an attempt at raw SQL fails loud instead of being ignored. */
function checkKeys(o: Obj, allowed: readonly string[], at: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${at}: unknown key "${extra[0]}"`);
}
function obj(v: unknown, at: string): Obj {
  if (!isObj(v)) throw new Error(`${at}: must be an object`);
  return v;
}
function str(o: Obj, k: string, at: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') throw new Error(`${at}: ${k} needs a non-empty string`);
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[], at: string): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`${at}: ${k} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}
function int(o: Obj, k: string, at: string, fallback?: number): number {
  const v = o[k] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${at}: ${k} must be a positive integer`);
  return v;
}
function list(o: Obj, k: string, at: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new Error(`${at}: ${k} must be an array`);
  return v;
}
function bool(o: Obj, k: string, at: string): boolean | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${at}: ${k} must be a boolean`);
  return v;
}
const stageKey = (o: Obj, at: string): StageKey => oneOf(o, 'stageKey', STAGE_KEYS, at);
/** A run link is an index into the same ticket's stageRuns, so it must point at one. */
function runLink(o: Obj, count: number, at: string): number | undefined {
  if (o['stageRun'] === undefined) return undefined;
  const i = o['stageRun'];
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count) {
    throw new Error(`${at}: stageRun must index an entry of this ticket's stageRuns`);
  }
  return i;
}

function parseStage(raw: unknown, at: string): StageSeed {
  const o = obj(raw, at);
  checkKeys(o, ['stageKey', 'attempt', 'status', 'blockedKind', 'blockedReason'], at);
  const blockedKind = o['blockedKind'] === undefined ? undefined : (str(o, 'blockedKind', at) as BlockerKind);
  const blockedReason = o['blockedReason'] === undefined ? undefined : str(o, 'blockedReason', at);
  return {
    stageKey: stageKey(o, at),
    patch: {
      status: oneOf(o, 'status', STAGE_STATUSES, at),
      attempt: int(o, 'attempt', at, 1),
      ...(o['status'] === 'running' ? { startedAt: STARTED } : {}),
      ...(blockedKind ? { blockedKind, blockedReason: blockedReason ?? 'fixture block' } : {}),
    },
  };
}

function parseStageRun(raw: unknown, at: string): StageRunSeed {
  const o = obj(raw, at);
  checkKeys(o, ['stageKey', 'attempt', 'status', 'outcome'], at);
  const status = oneOf(o, 'status', STAGE_RUN_STATUSES, at);
  const outcome = o['outcome'] === undefined ? undefined : oneOf(o, 'outcome', STAGE_RUN_OUTCOMES, at);
  if (status === 'finished' && !outcome) throw new Error(`${at}: a finished stage run needs an outcome`);
  return { stageKey: stageKey(o, at), attempt: int(o, 'attempt', at, 1), status, ...(outcome ? { outcome } : {}) };
}

function parseProcessRun(raw: unknown, at: string, stageRuns: number): ProcessRunSeed {
  const o = obj(raw, at);
  checkKeys(o, ['stageKey', 'processId', 'attempt', 'status', 'stageRun'], at);
  const link = runLink(o, stageRuns, at);
  return {
    stageKey: stageKey(o, at),
    processId: str(o, 'processId', at),
    attempt: int(o, 'attempt', at, 1),
    status: oneOf(o, 'status', PROCESS_RUN_STATUSES, at),
    ...(link === undefined ? {} : { stageRun: link }),
  };
}

function parseGateRun(raw: unknown, at: string, stageRuns: number): GateRunSeed {
  const o = obj(raw, at);
  checkKeys(o, ['stageKey', 'attempt', 'gateName', 'exitCode', 'stageRun'], at);
  const exit = o['exitCode'];
  if (exit !== null && typeof exit !== 'number') throw new Error(`${at}: exitCode must be a number or null`);
  const link = runLink(o, stageRuns, at);
  return {
    stageKey: stageKey(o, at),
    attempt: int(o, 'attempt', at, 1),
    gateName: str(o, 'gateName', at),
    exitCode: exit,
    ...(link === undefined ? {} : { stageRun: link }),
  };
}

function parseRound(raw: unknown, at: string): RecoveryRoundSeed {
  const o = obj(raw, at);
  checkKeys(o, ['sourceStage', 'sourceProcessId', 'triggerKind', 'triggerDetail', 'maxRounds'], at);
  return {
    sourceStage: oneOf(o, 'sourceStage', ROUND_STAGES, at),
    sourceProcessId: oneOf(o, 'sourceProcessId', ROUND_PROCESSES, at),
    triggerKind: oneOf(o, 'triggerKind', ROUND_TRIGGERS, at),
    triggerDetail: str(o, 'triggerDetail', at),
    maxRounds: int(o, 'maxRounds', at, 3),
  };
}

function parseRows(raw: unknown, at: string): Partial<RowSeeds> {
  const o = obj(raw, at);
  checkKeys(o, ['stage_runs', 'process_runs', 'gate_runs', 'recovery_rounds'], at);
  const each = <T>(k: string, parse: (r: unknown, a: string) => T): T[] | undefined =>
    o[k] === undefined ? undefined : list(o, k, at).map((r, i) => parse(r, `${at}.${k}[${i}]`));
  const stageRuns = each('stage_runs', parseStageRun);
  const count = stageRuns?.length ?? 0;
  const processRuns = each('process_runs', (r, a) => parseProcessRun(r, a, count));
  const gateRuns = each('gate_runs', (r, a) => parseGateRun(r, a, count));
  const recoveryRounds = each('recovery_rounds', parseRound);
  return {
    ...(stageRuns ? { stageRuns } : {}),
    ...(processRuns ? { processRuns } : {}),
    ...(gateRuns ? { gateRuns } : {}),
    ...(recoveryRounds ? { recoveryRounds } : {}),
  };
}

const GATE_NAMES = ['test', 'typecheck'] as const;

function parseBinding(raw: unknown, at: string): RepoBinding {
  const o = obj(raw, at);
  checkKeys(o, ['repoPath', 'baseRef', 'worktreePath'], at);
  return { repoPath: str(o, 'repoPath', at), baseRef: str(o, 'baseRef', at), worktreePath: str(o, 'worktreePath', at) };
}

function parseGate(raw: unknown, at: string): TaskGate {
  const o = obj(raw, at);
  checkKeys(o, ['name', 'command', 'args'], at);
  const args = o['args'] === undefined ? [] : list(o, 'args', at);
  if (!args.every((a) => typeof a === 'string')) throw new Error(`${at}: args must be strings`);
  return { name: oneOf(o, 'name', GATE_NAMES, at), command: str(o, 'command', at), args: args as string[] };
}

function parseTaskRepo(raw: unknown, at: string): TaskRepo {
  const o = obj(raw, at);
  checkKeys(o, ['name', 'repoPath', 'baseRef', 'gates'], at);
  const gates = o['gates'] === undefined ? [] : list(o, 'gates', at).map((g, i) => parseGate(g, `${at}.gates[${i}]`));
  const names = gates.map((g) => g.name);
  if (new Set(names).size !== names.length) throw new Error(`${at}: gate names must be unique`);
  const name = str(o, 'name', at);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${at}: name must be letters, digits, _ or -`);
  return { name, repoPath: str(o, 'repoPath', at), baseRef: str(o, 'baseRef', at), gates };
}

function parseTicket(raw: unknown, at: string): TicketSeed {
  const o = obj(raw, at);
  checkKeys(o, ['key', 'title', 'description', 'repo', 'stageCurrent', 'stages', 'archived', 'worktree', 'rows'], at);
  const stages = o['stages'] === undefined ? [] : list(o, 'stages', at).map((s, i) => parseStage(s, `${at}.stages[${i}]`));
  const archived = bool(o, 'archived', at);
  const worktree = bool(o, 'worktree', at);
  return {
    key: str(o, 'key', at),
    title: str(o, 'title', at),
    ...(o['description'] === undefined ? {} : { description: str(o, 'description', at) }),
    ...(o['repo'] === undefined ? {} : { repo: parseBinding(o['repo'], `${at}.repo`) }),
    stageCurrent: oneOf(o, 'stageCurrent', STAGE_KEYS, at),
    stages,
    ...(archived ? { archived } : {}),
    ...(worktree ? { worktree } : {}),
    ...(o['rows'] === undefined ? {} : { rows: parseRows(o['rows'], `${at}.rows`) }),
  };
}

/** A fixture file is data, never code: every field is validated and unknown keys are refused. */
export function parseFixtureFile(json: unknown, name = 'fixture-file'): FixtureSpec {
  const o = obj(json, 'fixture file');
  checkKeys(o, ['tickets', 'provider', 'taskRepo'], 'fixture file');
  const tickets = list(o, 'tickets', 'fixture file').map((t, i) => parseTicket(t, `ticket ${i}`));
  const keys = tickets.map((t) => t.key);
  if (new Set(keys).size !== keys.length) throw new Error('fixture file: ticket keys must be unique');
  const provider = o['provider'] === undefined ? undefined : oneOf(o, 'provider', KNOWN_AGENT_PROVIDERS, 'fixture file');
  const taskRepo = o['taskRepo'] === undefined ? undefined : parseTaskRepo(o['taskRepo'], 'taskRepo');
  return { name, tickets, ...(provider ? { provider } : {}), ...(taskRepo ? { taskRepo } : {}) };
}
