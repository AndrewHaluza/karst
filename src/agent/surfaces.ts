/**
 * What each agent core DOES with every optional field of the agent seam
 * (869ej1zpv, rule R1).
 *
 * `RunHeadlessOpts` / `InteractiveCommandOpts` are optional-heavy: an adapter
 * that ignores a field compiles clean, so "this core's CLI has no such flag"
 * and "this adapter forgot the flag" were the same absence. They are not the
 * same fact, and the difference was expensive: `--model` was pinned on three
 * cores and silently missing on antigravity's headless path, so every agy
 * headless call billed at the CLI's default model — the exact defect 869ef1e6x
 * fixed for claude alone.
 *
 * So each adapter DECLARES a position on every surface. `supported` means the
 * adapter translates the field to the core's own flag; `unsupported` carries a
 * one-line reason that is the drop-site comment. The declaration is what the
 * cross-adapter conformance suite checks against real argv
 * (`adapterConformance.test.ts`) — a claim is never taken on trust, and a new
 * core cannot pass the suite without stating every position.
 *
 * Declared on the adapter as an optional member so the many test fakes that
 * implement `AgentAdapter` keep compiling; the conformance suite REQUIRES it of
 * every adapter `registry.ts` can resolve, which is the population that matters.
 */

/** One surface's position: translated, or deliberately dropped with a reason. */
export type SurfaceSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export const SUPPORTED: SurfaceSupport = { supported: true };

/** Declare a dropped surface. The reason is required — an unexplained drop is the bug. */
export function unsupported(reason: string): SurfaceSupport {
  return { supported: false, reason };
}

/**
 * Every optional surface of the agent seam that an adapter may translate.
 *
 * Adding a field here is deliberately a compile error in all four adapters:
 * that is the point — a new seam surface must be answered by every core, not
 * by whichever one the author had open.
 */
export interface AdapterSurfaces {
  /**
   * The adapter pins the requested model exactly for interactive launches, so
   * a graph agent node can prove which model ran and avoid core-level
   * fallback.
   */
  readonly exactModel: SurfaceSupport;
  /** `RunHeadlessOpts.model` / `InteractiveCommandOpts.model` → the core's model flag. */
  readonly model: SurfaceSupport;
  /** `effort` → the core's reasoning-effort flag, headless. */
  readonly effortHeadless: SurfaceSupport;
  /** `effort` → the core's reasoning-effort flag, interactive. */
  readonly effortInteractive: SurfaceSupport;
  /** `allowedTools` → the core's tool-narrowing flag. */
  readonly allowedTools: SurfaceSupport;
  /** `permissionMode` → the core's permission/sandbox policy flags. */
  readonly permissionMode: SurfaceSupport;
  /** `resume` → the core's session-continuation flag. */
  readonly resume: SurfaceSupport;
  /** `sessionName` → the core's launch-time session-naming flag. */
  readonly sessionName: SurfaceSupport;
  /**
   * Structured stdout that `consoleFormat.ts` can render into readable console
   * text. This may be an event stream or a buffered final document. `unsupported`
   * means the core emits plain prose, so the raw text is forwarded unchanged.
   */
  readonly consoleStream: SurfaceSupport;
  /**
   * `RunHeadlessOpts.outputSchema` → the core's native structured-output request:
   * the CLI itself enforces that the FINAL response conforms to a JSON Schema,
   * so karst does not have to coax the shape out of prose. `supported` means the
   * core's headless CLI accepts a JSON Schema and returns a schema-conforming
   * final document (claude `--json-schema`, codex `--output-schema`).
   * `unsupported` means the CLI only ever returns the final assistant message as
   * prose or an event envelope (opencode `--format json`, agy `-p`), so the
   * prose output contract + `review/findings.ts`'s salvage parse stay the only
   * path — see `promptText.ts`'s output rules.
   */
  readonly structuredOutput: SurfaceSupport;
  /**
   * An executable hook channel the launch can install (a bridge script, a
   * settings file). `unsupported` means lifecycle signals are WATCHED instead
   * (agy's conversation DB) — see `docs/agent-cores/HOOK-CONTRACT.md`.
   */
  readonly hookChannel: SurfaceSupport;
  /**
   * The hook channel re-resolves the extension's CURRENT endpoint when its
   * launch-time URL is gone. A VS Code reload rebinds an ephemeral port, so
   * without this a session that survives the reload posts into a dead port
   * forever. `unsupported` must name why the channel cannot re-read it.
   */
  readonly endpointRebind: SurfaceSupport;
  /**
   * Whether the core can discover and auto-invoke skills by matching their
   * frontmatter `description` against the current task context. `supported`
   * means the core routes to a skill when its description matches, without
   * the agent having to remember to run it. `unsupported` means skill
   * bodies load on demand but the core does not route to them automatically
   * — the user or agent must invoke them explicitly. This is the compliance
   * property that separates a skill from a guide: the harness does the
   * routing instead of relying on agent initiative.
   */
  readonly skillDiscovery: SurfaceSupport;
}
