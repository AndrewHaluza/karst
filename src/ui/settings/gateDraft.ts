import type { GateDef, GateKind } from '../../manifest/types.js';

/**
 * Pure helpers over one declared gate, shared by the UAT and review editors
 * (decision S2). `uat.gates` and `review.gates` are the same shape and already
 * share `validateGate` on the manifest side; two UI implementations would fork
 * on validation and copy and never remerge.
 *
 * Every helper returns a NEW object — the settings draft is edited immutably.
 */

export function emptyGate(): GateDef {
  return { name: '', kind: 'script', script: '' };
}

/** `gate` as `kind`, dropping the fields belonging to the kind it left. */
export function setGateKind(gate: GateDef, kind: GateKind): GateDef {
  if (kind === 'script') {
    const { command, args, ...rest } = gate;
    void command;
    void args;
    return { ...rest, kind: 'script', script: '' };
  }
  const { script, ...rest } = gate;
  void script;
  return { ...rest, kind: 'command', command: '', args: [] };
}

/** null when the gate would validate; otherwise the reason, in the UI's voice. */
export function validateGateDraft(gate: GateDef): string | null {
  if (!gate.name || gate.name.trim().length === 0) return 'Gate needs a name.';
  if (gate.kind === 'script') {
    if (!gate.script || gate.script.trim().length === 0) {
      return `Gate "${gate.name}" needs a package.json script.`;
    }
    return null;
  }
  if (!gate.command || gate.command.trim().length === 0) {
    return `Gate "${gate.name}" needs a command.`;
  }
  return null;
}

/** One-line display form: what this gate will actually run. */
export function gateSummary(gate: GateDef): string {
  if (gate.kind === 'script') return `npm run ${gate.script ?? ''}`.trim();
  return [gate.command ?? '', ...(gate.args ?? [])].join(' ').trim();
}
