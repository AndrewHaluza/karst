import type { Step, WaitCondition } from './steps.js';
import { DEFAULT_STEP_TIMEOUT_MS } from './steps.js';
import type { LaunchRecord } from '../launchRecord.js';

export interface TicketEvidence {
  key: string;
  title: string;
  stage: string;
  stages: Array<{ stage: string; status: string; blockedKind: string | null }>;
}
export interface Snapshot {
  tickets: TicketEvidence[];
  sidebar: { lastMessage: unknown };
  webviews: Array<{ id: string; viewType: string; title: string; messageCount: number; lastMessage: unknown }>;
  notifications: Array<{ level: string; message: string }>;
  logTail: string[];
  launches: LaunchRecord[];
}
/** A wait that cannot change from a ticket/stage row must not read the store every poll. */
export interface SnapshotScope {
  tickets?: boolean;
  launches?: boolean;
}
export interface ProbeHost {
  execute(command: string, args: unknown[]): Promise<unknown>;
  /** No scope means the full snapshot (evidence); `tickets: false` skips the store read. */
  snapshot(scope?: SnapshotScope): Snapshot;
}
export type StepStatus = 'pass' | 'fail' | 'timeout';
export interface StepResult {
  index: number;
  type: Step['type'];
  status: StepStatus;
  detail?: string;
}
export interface RunOptions {
  host: ProbeHost;
  /** Persist one step's evidence; the runner never touches the filesystem. May be async. */
  writeEvidence(index: number, evidence: unknown): void | Promise<void>;
  /** Hard cap for the whole script, so a wedged host can never hang the run. */
  totalTimeoutMs?: number;
  pollMs?: number;
}

const stringify = (v: unknown): string => JSON.stringify(v) ?? '';

export function conditionMet(c: WaitCondition, s: Snapshot): boolean {
  if ('ticketStage' in c) {
    return s.tickets.some((t) => t.key === c.ticketStage.key && t.stage === c.ticketStage.stage);
  }
  if ('notification' in c) return s.notifications.some((n) => n.message.includes(c.notification));
  if ('log' in c) return s.logTail.some((l) => l.includes(c.log));
  if ('launch' in c) return s.launches.some((l) => c.launch.provider === undefined || l.provider === c.launch.provider);
  return s.webviews.some((w) => stringify(w.lastMessage).includes(c.webviewMessage))
    || stringify(s.sidebar.lastMessage).includes(c.webviewMessage);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves 'timeout' instead of rejecting so a hung command is a reported result. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ timedOut: true } | { value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((r) => { timer = setTimeout(() => r({ timedOut: true }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStep(step: Step, opts: RunOptions, budgetMs: number): Promise<Omit<StepResult, 'index' | 'type'>> {
  const timeoutMs = Math.min(budgetMs, 'timeoutMs' in step && step.timeoutMs ? step.timeoutMs : DEFAULT_STEP_TIMEOUT_MS);
  if (step.type === 'snapshot') return { status: 'pass' };
  if (step.type === 'command') {
    try {
      const r = await withTimeout(opts.host.execute(step.command, step.args ?? []), timeoutMs);
      return 'timedOut' in r ? { status: 'timeout', detail: `${step.command} exceeded ${timeoutMs}ms` } : { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const deadline = Date.now() + timeoutMs;
  // Only a ticketStage wait can be moved by the store, so only it pays for the read.
  const scope: SnapshotScope = { tickets: 'ticketStage' in step.for, launches: 'launch' in step.for };
  for (;;) {
    if (conditionMet(step.for, opts.host.snapshot(scope))) return { status: 'pass' };
    if (Date.now() >= deadline) return { status: 'timeout', detail: `wait ${stringify(step.for)} not met in ${timeoutMs}ms` };
    await sleep(opts.pollMs ?? 100);
  }
}

/** Runs steps in order, writes evidence after each, stops at the first non-pass. */
export async function runSteps(steps: Step[], opts: RunOptions): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const end = Date.now() + (opts.totalTimeoutMs ?? 120_000);
  for (const [index, step] of steps.entries()) {
    const budget = end - Date.now();
    const outcome = budget <= 0
      ? { status: 'timeout' as const, detail: 'script total timeout exceeded' }
      : await runStep(step, opts, budget);
    const result: StepResult = { index, type: step.type, ...outcome };
    await opts.writeEvidence(index, { step, result, snapshot: opts.host.snapshot() });
    results.push(result);
    if (result.status !== 'pass') break;
  }
  return results;
}
