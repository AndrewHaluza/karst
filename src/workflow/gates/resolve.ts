import type { BlockerKind } from '../../model/types.js';
import type { ScriptProbe } from './probe.js';

export type GateKind = 'script' | 'command';

/**
 * What `resolveGates` needs from one declared gate — deliberately NOT named
 * `GateDef`: the manifest's `GateDef` (`manifest/types.ts`, shared by
 * `UatGateDef` and `ReviewConfig.gates`) is the config-authored shape and
 * additionally carries `repo` (and, for UAT, `report`); a caller filters and
 * strips those manifest-only fields before reaching this module
 * (`declaredGatesFor`/`declaredReviewGatesFor` already resolve `repo` scoping
 * down to "does this gate apply here"), so what lands here is a narrower,
 * resolution-only shape. The manifest type is still assignable straight
 * through without conversion — it is a structural superset of this one — but
 * the two describe different questions ("what did the author declare" vs
 * "what does resolution need") and having them share a name was a
 * maintenance trap once review's manifest type stopped being hypothetical.
 */
export interface DeclaredGate {
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

function resolveDeclared(gate: DeclaredGate): ResolvedGate {
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
  declared: readonly DeclaredGate[],
  probeList: readonly string[],
  debug?: (message: string) => void,
): GateResolution {
  // Explicit gates always win — checked before the probe result matters at
  // all, so a set of declared gates that are all `kind: 'command'` (needing no
  // package.json) is never blocked by an unreadable or malformed one.
  if (declared.length > 0) {
    debug?.(
      `[gate] resolve: ${declared.length} declared gate(s) win before the probe — ` +
        declared.map((g) => g.name).join(', '),
    );
    return { kind: 'gates', gates: declared.map(resolveDeclared) };
  }

  // Nothing declared: only now does the probe result matter, since with no
  // explicit config the probe outcome IS the question.

  // Environmental: an agent cannot chmod its way out of an unreadable repo.
  if (probe.kind === 'io-error') {
    debug?.(`[gate] resolve: probe io-error — blocking (${probe.message})`);
    return {
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: `cannot read package.json: ${probe.message}`,
    };
  }

  // A repository defect an agent CAN fix, so it must reach a verdict rather than
  // a block — an empty required set makes the aggregate fail it by name.
  if (probe.kind === 'malformed') {
    debug?.(`[gate] resolve: probe malformed — empty required gate set (${probe.message})`);
    return { kind: 'gates', gates: [] };
  }

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
    // Auto-discovery is npm-script-shaped, so this is where every non-Node
    // repository lands. The escape hatch is one branch up — declared gates win
    // before the probe is read, and a `kind: command` gate needs no
    // package.json at all — but a reason that named only the Node path taught
    // the opposite, and projects wrote package.json-shaped shim scripts to work
    // around a limit karst does not have. So the blocker says what to do next.
    const found =
      probe.kind === 'absent'
        ? 'this repository has no package.json'
        : `package.json defines none of: ${probeList.join(', ')}`;
    debug?.(`[gate] resolve: nothing discovered (${found}) — nothing-to-run`);
    return {
      kind: 'unavailable',
      blocker: 'nothing-to-run',
      reason:
        `no gates configured and ${found}. For a non-Node toolchain, declare ` +
        `"kind: command" gates under uat.gates / review.gates in karst.yml ` +
        `(e.g. command: pytest) — a command gate runs no npm script and needs ` +
        `no package.json.`,
    };
  }
  debug?.(
    `[gate] resolve: discovered ${discovered.length} gate(s) from probe — ` +
      discovered.map((g) => g.name).join(', '),
  );
  return { kind: 'gates', gates: discovered };
}
