import type {
  AgentAdapter,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  RunHeadlessOpts,
} from './adapter.js';
import type { TokenUsage } from './tokenUsage.js';

/** Env flag that swaps every real agent core for `FakeAdapter` (UAT host harness). */
export const FAKE_CORE_ENV = 'KARST_FAKE_CORE';

/** Env var that names the fixture file whose `fakeCore` script the fake core plays (UAT host harness). */
export const FAKE_CORE_SCRIPT_ENV = 'KARST_FAKE_CORE_SCRIPT';

/** One scripted headless answer. `raw` is returned verbatim, so the real parsers run on it. */
export interface FakeAnswer { raw: string; verdict?: unknown; usage?: TokenUsage }
/** The first rule whose `promptIncludes` is a substring of the prompt answers; its answers are used in order. */
export interface FakeHeadlessRule { promptIncludes: string; answers: FakeAnswer[] }
export interface FakeCoreScript { headless: FakeHeadlessRule[] }
/** Which rule and which of its answers replied. Indexes only: never prompt text. */
export interface FakeCoreHit { rule: number; answer: number }

/** Deterministic stand-in core: no process, no network, no tokens. */
export class FakeAdapter implements AgentAdapter {
  readonly requiredBinary = 'node';
  readonly capabilities = { lifecycleEvents: false, resume: false };
  private readonly calls = new Map<number, number>();

  constructor(
    private readonly script?: FakeCoreScript,
    private readonly onHit?: (hit: FakeCoreHit) => void,
  ) {}

  async runHeadless(opts?: RunHeadlessOpts): Promise<HeadlessResult> {
    const rule = this.script?.headless.findIndex((r) => opts?.prompt.includes(r.promptIncludes)) ?? -1;
    if (!this.script || rule < 0) return { sessionId: 'fake-session', verdict: null, raw: 'fake core: no LLM call' };
    const { answers } = this.script.headless[rule]!;
    const answer = Math.min(this.calls.get(rule) ?? 0, answers.length - 1);
    this.calls.set(rule, answer + 1);
    this.onHit?.({ rule, answer });
    const { raw, verdict, usage } = answers[answer]!;
    return { sessionId: 'fake-session', verdict: verdict ?? null, raw, ...(usage ? { usage } : {}) };
  }

  buildInteractiveCommand(_opts?: InteractiveCommandOpts): InteractiveCommand {
    return { command: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], env: {} };
  }
}
