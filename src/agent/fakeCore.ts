import type {
  AgentAdapter,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  RunHeadlessOpts,
} from './adapter.js';

/** Env flag that swaps every real agent core for `FakeAdapter` (UAT host harness). */
export const FAKE_CORE_ENV = 'KARST_FAKE_CORE';

/** Deterministic stand-in core: no process, no network, no tokens. */
export class FakeAdapter implements AgentAdapter {
  readonly requiredBinary = 'node';
  readonly capabilities = { lifecycleEvents: false, resume: false };

  async runHeadless(_opts?: RunHeadlessOpts): Promise<HeadlessResult> {
    return { sessionId: 'fake-session', verdict: null, raw: 'fake core: no LLM call' };
  }

  buildInteractiveCommand(_opts?: InteractiveCommandOpts): InteractiveCommand {
    return { command: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], env: {} };
  }
}
