import type { BlockerKind } from '../../model/types.js';
import type { ScriptProbe } from './probe.js';

export type GateKind = 'script' | 'command';

/**
 * The shared shape of one declared gate. Both UAT's `UatGateDef`
 * (`manifest/types.ts`) and review's future declared-gate type describe this same
 * thing plus their own scoping fields (`repo`, `report`); `resolveGates` only
 * needs this much, so callers pass their manifest type straight through rather
 * than converting it.
 */
export interface GateDef {
  name: string;
  kind: GateKind;
  script?: string; // kind: 'script' — the package.json script
  command?: string; // kind: 'command' — the binary, spawned without a shell
  args?: string[]; // kind: 'command'
}

export interface ResolvedGate {
  name: string;
  command: string;
  args: readonly string[];
  /** The package.json script this needs, or null for a command gate. */
  script: string | null;
  /**
   * True when the caller NAMED this gate. A configured gate whose script is
   * absent is a failure — the config names a question the repo cannot answer. A
   * discovered one that is absent is simply not there, and says nothing.
   */
  required: boolean;
}

export type GateResolution =
  | { kind: 'gates'; gates: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

function resolveDeclared(gate: GateDef): ResolvedGate {
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
 * Which gates a stage will run against one repository.
 *
 * `null` at the per-gate level and `blocked` at the resolution level are different
 * answers: a gate that never ran says nothing about the ticket, while a repository
 * karst cannot ask ANY question of is not a pass — it is karst reporting that it
 * had nothing to ask, which the aggregate must never convert into green.
 *
 * `probeList` is the caller's own set of scripts to look for when nothing is
 * declared, cheapest first — a parameter rather than a constant, because UAT and
 * review probe for different things and both share this resolution logic.
 */
export function resolveGates(
  probe: ScriptProbe,
  declared: readonly GateDef[],
  probeList: readonly string[],
): GateResolution {
  // Explicit gates always win — checked before the probe result matters at
  // all, so a set of declared gates that are all `kind: 'command'` (needing no
  // package.json) is never blocked by an unreadable or malformed one.
  if (declared.length > 0) return { kind: 'gates', gates: declared.map(resolveDeclared) };

  // Nothing declared: only now does the probe result matter, since with no
  // explicit config the probe outcome IS the question.

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
  const discovered = probeList.filter((s) => scripts[s] !== undefined).map<ResolvedGate>(
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
      reason: `no gates configured and package.json defines none of: ${probeList.join(', ')}`,
    };
  }
  return { kind: 'gates', gates: discovered };
}
