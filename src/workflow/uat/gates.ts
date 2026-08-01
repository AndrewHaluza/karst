import type { BlockerKind } from '../../model/types.js';
import type { UatConfig, UatGateDef } from '../../manifest/types.js';
import type { ScriptProbe } from '../gates/probe.js';
import type { GateResult } from '../gates/result.js';
import { runProcess } from '../gates/run.js';
import { nowIso } from '../../model/time.js';

/**
 * The scripts karst looks for when `uat.gates` is absent, cheapest first.
 *
 * Ordering is a cost argument: `test` (seconds) → integration (tens of seconds) →
 * e2e (minutes), so the cheapest signal fails fastest. Most repositories need no
 * configuration at all, which is the whole point — an explicit list always wins.
 */
export const PROBE_SCRIPTS: readonly string[] = [
  'test',
  'test:integration',
  'e2e',
  'test:e2e',
  'cypress',
  'playwright',
];

export interface ResolvedGate {
  name: string;
  command: string;
  args: readonly string[];
  /** The package.json script this needs, or null for a command gate. */
  script: string | null;
  /**
   * True when the user NAMED this gate. A configured gate whose script is absent
   * is a failure — the config names a question the repo cannot answer. A
   * discovered one that is absent is simply not there, and says nothing.
   */
  required: boolean;
}

export type GateResolution =
  | { kind: 'gates'; gates: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

function resolveDeclared(gate: UatGateDef): ResolvedGate {
  if (gate.kind === 'command') {
    // Spawned without a shell, so there is no quoting surface to get wrong.
    return {
      name: gate.name,
      command: gate.command!,
      args: gate.args ?? [],
      script: null,
      required: true,
    };
  }
  const script = gate.script!;
  return {
    name: gate.name,
    command: 'npm',
    args: script === 'test' ? ['test'] : ['run', script],
    script,
    required: true,
  };
}

/**
 * The declared gates targeting one repository.
 *
 * `uat.repositories.<name>.gates`, when present and non-empty, REPLACES the
 * global `uat.gates` list for that repository — it is an override, not an
 * addition. Absent (or explicitly empty, which is indistinguishable from "no
 * override" the same way an empty top-level `uat.gates` is indistinguishable
 * from "no config" below), falls back to the global list filtered by each
 * gate's own optional `repo:` scope.
 */
function declaredGatesFor(
  config: UatConfig | undefined,
  repoName: string | null,
): UatGateDef[] {
  const override =
    config !== undefined && repoName !== null ? config.repositories[repoName]?.gates : undefined;
  if (override !== undefined && override.length > 0) return override;

  return (config?.gates ?? []).filter(
    (g) => g.repo === undefined || repoName === null || g.repo === repoName,
  );
}

/**
 * Which gates UAT will run against one repository.
 *
 * `null` at the per-gate level and `blocked` at the resolution level are different
 * answers: a gate that never ran says nothing about the ticket, while a repository
 * karst cannot ask ANY question of is not a pass — it is karst reporting that it
 * had nothing to ask, which the aggregate must never convert into green.
 */
export function resolveUatGates(
  probe: ScriptProbe,
  config: UatConfig | undefined,
  repoName: string | null,
): GateResolution {
  // Explicit gates always win — checked before the probe result matters at
  // all, so a repo whose declared gates are all `kind: 'command'` (needing no
  // package.json) is never blocked by an unreadable or malformed one.
  const declared = declaredGatesFor(config, repoName);
  if (declared.length > 0) return { kind: 'gates', gates: declared.map(resolveDeclared) };

  // Nothing declared for this repo: only now does the probe result matter,
  // since with no explicit config the probe outcome IS the question.

  // Environmental: an agent cannot chmod its way out of an unreadable repo.
  if (probe.kind === 'io-error') {
    return {
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: `cannot read package.json: ${probe.message}`,
    };
  }

  // A repository defect an agent CAN fix, so it must reach a verdict rather than
  // a block — an empty required set makes the aggregate fail it by name.
  if (probe.kind === 'malformed') return { kind: 'gates', gates: [] };

  const scripts = probe.kind === 'ok' ? probe.scripts : {};
  const discovered = PROBE_SCRIPTS.filter((s) => scripts[s] !== undefined).map<ResolvedGate>(
    (script) => ({
      name: script,
      command: 'npm',
      args: script === 'test' ? ['test'] : ['run', script],
      script,
      required: false,
    }),
  );
  if (discovered.length === 0) {
    return {
      kind: 'unavailable',
      blocker: 'nothing-to-run',
      reason:
        `no uat.gates configured and package.json defines none of: ${PROBE_SCRIPTS.join(', ')}`,
    };
  }
  return { kind: 'gates', gates: discovered };
}

/**
 * Run the gates sequentially in one worktree.
 *
 * Sequential, not `Promise.all`: several npm scripts racing in one worktree fight
 * over the same node_modules and build output, and their interleaved text lands in
 * one unreadable artifact. Each still runs async, so the extension host keeps
 * serving hooks and webviews throughout.
 *
 * No short-circuit on the first failure. The attempt cap makes complete
 * information per attempt worth more than saved minutes: an agent that learns
 * about the unit failure only, fixes it, re-enters and THEN hits the integration
 * failure has spent two of three attempts to learn what one could have told it.
 *
 * `stopped` still carries `results` for whichever gates completed before the
 * abort landed (empty when none did). `gate_runs` is the project's only
 * append-only evidence table — a `stopped` outcome that discarded its partial
 * results would make the work those gates already did unrecoverable by any
 * caller, even though it happened.
 */
export interface RunGatesOptions {
  signal?: AbortSignal;
  now?: () => string;
  /** Whether the repository defines a given package.json script. */
  scriptsAvailable?: (script: string) => boolean;
}

export async function runUatGates(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped'; results: GateResult[] }> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  for (const gate of gates) {
    if (opts.signal?.aborted) return { kind: 'stopped', results };
    const startedAt = now();

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script) === false) {
      // The config named a question this repo cannot answer. A failure, not null —
      // and agent-fixable, because both the config and the missing script are in
      // the repository. Caught here rather than by spawning `npm run`, whose
      // "Missing script" exit 1 would read as a verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: 1,
        output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define`,
        startedAt,
        endedAt: now(),
      });
      continue;
    }

    const outcome = await runProcess(gate.command, gate.args, cwd, { signal: opts.signal });

    if (outcome.kind === 'aborted') return { kind: 'stopped', results };
    if (outcome.kind === 'spawnFailed' && !gate.required && gate.script !== null) {
      // A discovered script whose binary vanished between probe and spawn: karst
      // had no question to ask after all, so it stays null rather than becoming a
      // verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: null,
        output: `no "${gate.script}" script available — nothing to run`,
      });
      continue;
    }
    results.push({
      name: gate.name,
      exitCode: outcome.kind === 'completed' ? outcome.exitCode : 1,
      output: outcome.output,
      startedAt,
      endedAt: now(),
    });
  }
  return { kind: 'ran', results };
}
