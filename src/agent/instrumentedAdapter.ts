import type {
  AgentAdapter,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  MaterializeOpts,
  Materialized,
  RunHeadlessOpts,
  UsageTracking,
} from './adapter.js';
import type { TokenUsageEntry } from '../store/tokenUsage.js';
import { UNKNOWN_CALL_SITE } from './aiCallSites.js';
import { estimateTokenUsage, usageFromError, type TokenUsage } from './tokenUsage.js';

/**
 * The ONE place an AI call is measured (§ token consumption stats).
 *
 * Instrumentation is a decorator on `AgentAdapter` rather than a line at each
 * call site, because every AI invocation in karst already goes through the one
 * agent-execution seam (§2.6). Wrapping it means a NEW integration is counted
 * the moment it is written: the only thing its author adds is
 * `tracking.callSite`, and forgetting even that files the call under
 * `unknown` instead of losing it. There is no second path to keep in sync.
 *
 * Three rules make the measurement safe to leave switched on:
 *
 * - **Recording never breaks the call.** The store write is wrapped; a locked
 *   database, a missing table, any fault at all is logged and swallowed. A
 *   bookkeeping failure that surfaced as a failed PR description would make the
 *   feature strictly worse than not having it.
 * - **Failed calls are still recorded.** A 429 arrives AFTER the provider
 *   counted the input, and a `ship` run that dies mid-stream burned real tokens.
 *   The adapters attach whatever they parsed to the thrown error
 *   (`attachUsage`), the wrapper reads it back, records `outcome: 'error'`, and
 *   rethrows the ORIGINAL error untouched.
 * - **An estimate is marked as one.** Only when the core reported nothing does
 *   the wrapper fall back to `estimateTokenUsage`, and the `estimated` flag rides
 *   all the way to the dashboard.
 *
 * No prompt or completion text is ever put on the entry — only counts and
 * metadata. The text is right there in `opts.prompt` and `result.raw`, which is
 * exactly why the rule is stated at the one place that could break it.
 */

/** Where a store write goes. Injected so this module never imports a driver. */
export interface UsageSink {
  record(entry: TokenUsageEntry): void;
}

export interface InstrumentOptions {
  sink: UsageSink;
  /** Agent core making the call (`claude` | `codex` | …), for the by-model view. */
  provider?: string;
  /** The bound project, read live — the DB is shared by every IDE window. */
  projectId?: () => number | null;
  /** Report a swallowed tracking fault to the Karst output channel. */
  logError?: (message: string, error: unknown) => void;
  /**
   * Verbose decision-point logging (§ debug logging). Injected into every
   * headless call's `RunHeadlessOpts.debug`, so the ADAPTER's debug lines are
   * bound exactly once here — the same seam that instruments token usage. The
   * host binds it to `Logger.debug` (a no-op unless the manifest's `debug`
   * flag is on).
   */
  debug?: (message: string) => void;
  /**
   * Live-pid registry hook (the resource monitor). Injected into every headless
   * call's `RunHeadlessOpts.onSpawned` at the same seam as `debug`, with the
   * call's own `tracking` bound — so a new adapter gets pid registration by
   * construction, and the registration's ticket/label come from the call that
   * spawned it. The host binds it to `ResourceMonitor.registerPid`.
   */
  onSpawned?: (pid: number, tracking?: UsageTracking) => (() => void) | void;
  /** Injected clock, for tests. */
  now?: () => string;
}

/**
 * Resolve the counts to store. The provider's numbers win; the launch model
 * fills in a model the envelope did not name (the core was told which one to
 * use, so this is a fact, not a guess). Nothing reported at all → a marked
 * estimate from the text lengths.
 */
function resolveUsage(
  reported: TokenUsage | null | undefined,
  prompt: string,
  completion: string,
  launchModel: string | undefined,
): TokenUsage {
  const usage = reported ?? estimateTokenUsage(prompt, completion);
  return usage.model === null && launchModel ? { ...usage, model: launchModel } : usage;
}

export function instrumentAdapter(
  adapter: AgentAdapter,
  options: InstrumentOptions,
): AgentAdapter {
  const now = options.now ?? (() => new Date().toISOString());
  const logError = options.logError ?? ((m: string, e: unknown) => console.error(m, e));

  function record(
    opts: RunHeadlessOpts,
    usage: TokenUsage,
    outcome: 'ok' | 'error',
  ): void {
    try {
      options.sink.record({
        projectId: options.projectId?.() ?? null,
        ticketId: opts.tracking?.ticketId ?? null,
        processRunId: opts.tracking?.processRunId ?? null,
        approachPlannerRunId: opts.tracking?.approachPlannerRunId ?? null,
        approachNodeRunId: opts.tracking?.approachNodeRunId ?? null,
        callSite: opts.tracking?.callSite ?? UNKNOWN_CALL_SITE,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        usage,
        outcome,
        recordedAt: now(),
      });
    } catch (error) {
      // Swallowed on purpose: see the module doc. The AI call already
      // succeeded (or already failed on its own terms) and must not be
      // re-judged by the ledger.
      logError('failed to record token usage', error);
    }
  }

  const instrumented: AgentAdapter = {
    requiredBinary: adapter.requiredBinary,
    capabilities: adapter.capabilities,
    // The wrapped core's declared seam positions (869ej1zpv R1) must survive
    // instrumentation: `extension.ts` wraps at both `resolveAdapter` sites, so
    // dropping it here would make every runtime adapter read as undeclared.
    ...(adapter.surfaces ? { surfaces: adapter.surfaces } : {}),

    buildInteractiveCommand: (opts: InteractiveCommandOpts): InteractiveCommand =>
      adapter.buildInteractiveCommand(opts),

    async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
      options.debug?.(
        `[agent] instrumented runHeadless (${opts.tracking?.callSite ?? 'unknown'} for ticket ${opts.tracking?.ticketId ?? '?'})`,
      );
      let result: HeadlessResult;
      try {
        result = await adapter.runHeadless({
          ...opts,
          debug: options.debug,
          ...(options.onSpawned
            ? { onSpawned: (pid: number) => options.onSpawned!(pid, opts.tracking) }
            : {}),
        });
      } catch (error) {
        options.debug?.(
          `[agent] instrumented runHeadless (${opts.tracking?.callSite ?? 'unknown'}): call failed — recording usage as error`,
        );
        // A failure after the provider counted the input is still spend. When
        // it reported nothing, the prompt was sent regardless — estimate the
        // input and claim no output, since none came back.
        record(opts, resolveUsage(usageFromError(error), opts.prompt, '', opts.model), 'error');
        throw error;
      }
      options.debug?.(
        `[agent] instrumented runHeadless (${opts.tracking?.callSite ?? 'unknown'}): call returned — recording usage as ok`,
      );
      record(opts, resolveUsage(result.usage, opts.prompt, result.raw, opts.model), 'ok');
      return result;
    },
  };

  // Absent on the wrapped adapter means "no notion of loadable approaches" and
  // must stay absent here — present-but-empty would turn a bare launch into a
  // materialization the core never asked for.
  if (adapter.materializeApproach) {
    instrumented.materializeApproach = (opts: MaterializeOpts): Materialized =>
      adapter.materializeApproach!(opts);
  }

  return instrumented;
}
