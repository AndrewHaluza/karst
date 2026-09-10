/**
 * The SECOND decorator on the agent seam — retry transient failures on the same
 * model, advance the model chain on a rejection, and surface the hop to the
 * host. Composed OUTSIDE `instrumentAdapter` (K6) so each retried or fallback
 * attempt passes through the meter on its own and lands its own `token_usage`
 * row. Wraps `runHeadless` only; every other adapter surface is delegated
 * verbatim.
 *
 * A same-model retry is silent (K9); a model HOP is reported via `notify` so
 * the user is never surprised by a model swap that makes the token-usage stats
 * unexplainable.
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  MaterializeOpts,
  Materialized,
  RunHeadlessOpts,
} from './adapter.js';
import { classifyFailure, type FailureClass } from './failureClass.js';

/** What the host is told when a call moves to a different model (K9/K10). */
export interface ModelFallbackEvent {
  callSite: string;
  ticketId: number | null;
  /** The model that failed. `null` means the CLI's own default. */
  fromModel: string | null;
  /** The model about to be tried. `null` means the CLI's own default. */
  toModel: string | null;
  failureClass: FailureClass;
}

export interface ResilienceOptions {
  /** Extra attempts on the same model after a transient failure. */
  retries: number;
  /** Base backoff in ms; doubled per attempt, ±20% jitter. */
  backoffMs: number;
  /**
   * The ordered chain for THIS call, resolved by the host from the call's
   * provider and the manifest (`resolveModelChain`). A getter, not a value:
   * `opts.model` differs per call.
   */
  chain: (model: string | undefined) => readonly (string | undefined)[];
  /**
   * Called ONCE per model hop, before the next model is tried. The host
   * surfaces it (log + notification). Never called for a same-model retry.
   * Must not throw; the decorator does not guard it beyond a try/catch.
   */
  notify?: (event: ModelFallbackEvent) => void;
  /** § debug logging, prefixed `[agent]`. Absent → silent. */
  debug?: (message: string) => void;
  /** Injected for tests (K11). Default: a real, abort-aware timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests (K12). Default: `Math.random`. */
  random?: () => number;
}

function abortError(): Error & { name: 'AbortError' } {
  return Object.assign(new Error('headless agent run aborted'), { name: 'AbortError' as const });
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `baseMs * 2^(attempt-1)`, jittered ±20%, floored at 0 and capped at 60s.
 * `attempt` is 1-based: the delay BEFORE the 2nd attempt is the base.
 */
export function backoffDelay(baseMs: number, attempt: number, random: () => number): number {
  const raw = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = 1 + (random() - 0.5) * 0.4;
  return Math.max(0, Math.min(60_000, Math.round(raw * jitter)));
}

export function resilientAdapter(
  inner: AgentAdapter,
  options: ResilienceOptions,
): AgentAdapter {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  const adapter: AgentAdapter = {
    requiredBinary: inner.requiredBinary,
    capabilities: inner.capabilities,
    ...(inner.surfaces ? { surfaces: inner.surfaces } : {}),

    buildInteractiveCommand: (opts: InteractiveCommandOpts): InteractiveCommand =>
      inner.buildInteractiveCommand(opts),

    async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
      const chain = options.chain(opts.model);
      let lastError: unknown = new Error('resilient agent call made no attempt');

      for (let i = 0; i < chain.length; i++) {
        const model = chain[i];

        // Announce the HOP before the first attempt on a non-first chain entry.
        if (i > 0) {
          options.debug?.(
            `[agent] resilient: model ${chain[i - 1] ?? '<cli default>'} exhausted (${classifyFailure(lastError)}) — falling back to ${model ?? '<cli default>'}`,
          );
          try {
            options.notify?.({
              callSite: opts.tracking?.callSite ?? 'unknown',
              ticketId: opts.tracking?.ticketId ?? null,
              fromModel: chain[i - 1] ?? null,
              toModel: model ?? null,
              failureClass: classifyFailure(lastError),
            });
          } catch { /* a reporting fault must never break the AI call */ }
        }

        for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
          const { model: _dropped, ...rest } = opts;
          const callOpts = model === undefined ? rest : { ...rest, model };

          try {
            return await inner.runHeadless(callOpts);
          } catch (error) {
            lastError = error;
            const cls = classifyFailure(error);

            if (cls === 'aborted' || cls === 'fatal') {
              options.debug?.(`[agent] resilient: ${cls} failure — not retrying`);
              throw error;
            }
            if (cls === 'model-rejected') {
              options.debug?.(
                `[agent] resilient: ${cls} failure on ${model ?? '<cli default>'} — advancing chain`,
              );
              break; // next model (K4)
            }
            if (attempt > options.retries) {
              options.debug?.(
                `[agent] resilient: ${cls} failure on ${model ?? '<cli default>'} — retries exhausted`,
              );
              break; // same model exhausted
            }
            const delay = backoffDelay(options.backoffMs, attempt, random);
            options.debug?.(
              `[agent] resilient: transient failure on ${model ?? '<cli default>'} (attempt ${attempt}/${options.retries + 1}) — retrying in ${delay}ms`,
            );
            await sleep(delay, opts.signal);
          }
        }
      }

      options.debug?.(
        `[agent] resilient: chain exhausted after ${chain.length} model(s) — rethrowing the last failure`,
      );
      throw lastError;
    },
  };

  // Absent on the wrapped adapter means "no notion of loadable approaches" and
  // must stay absent here — present-but-empty would turn a bare launch into a
  // materialization the core never asked for.
  if (inner.materializeApproach) {
    adapter.materializeApproach = (opts: MaterializeOpts): Materialized =>
      inner.materializeApproach!(opts);
  }

  return adapter;
}
