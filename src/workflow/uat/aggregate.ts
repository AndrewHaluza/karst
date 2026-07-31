import type { BlockerKind, Verdict } from '../../model/types.js';
import type { GateResult } from '../gates/result.js';

/**
 * What a gate invocation actually was — the tuple that decides whether UAT asked
 * a question review does not.
 *
 * Repository is part of it: the same `npm test` in two repositories is two
 * questions, and dropping the repo would make a monorepo's second service look
 * like a duplicate.
 */
export interface GateIdentity {
  repo: string;
  command: string;
  args: readonly string[];
}

export interface AggregateEntry {
  result: GateResult;
  identity: GateIdentity;
}

export type AggregateOutcome =
  | { kind: 'verdict'; verdict: Exclude<Verdict, null>; warnings: string[] }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string };

export function sameIdentity(a: GateIdentity, b: GateIdentity): boolean {
  return (
    a.repo === b.repo &&
    a.command === b.command &&
    a.args.length === b.args.length &&
    a.args.every((arg, i) => arg === b.args[i])
  );
}

function render(identity: GateIdentity): string {
  return `${identity.command} ${identity.args.join(' ')}`.trim();
}

/**
 * Reduce a run's gates to one outcome. **This is the only place the pass
 * condition is stated.**
 *
 * UAT passes iff:
 *   (a) every gate that RAN exits 0, and
 *   (b) at least one gate ran.
 *
 * The third condition — at least one EFFECTIVE gate identity absent from review's
 * set — is recorded as a warning in Phase 1 and becomes blocking in Phase 2, when
 * authored steps give a human a way out. Effective, not declared: a static check
 * over the configured list passes for a repo that defines only `test`, every other
 * probe records null, and the stage reports green having asked nothing new.
 */
export function aggregateUat(
  entries: readonly AggregateEntry[],
  reviewIdentities: readonly GateIdentity[],
): AggregateOutcome {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  // Not a pass. "Nothing ran" means the stage asked nothing, and converting that
  // into green is the bug this whole design exists to close.
  if (ran.length === 0) {
    return {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason:
        entries.length === 0
          ? 'no gates resolved for this ticket'
          : `no gate ran: ${entries.map((e) => e.result.name).join(', ')}`,
    };
  }

  const failing = ran.filter((e) => e.result.exitCode !== 0);
  if (failing.length > 0) {
    return {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: `gates failed: ${failing.map((e) => e.result.name).join(', ')}` },
      warnings: [],
    };
  }

  const independent = ran.filter(
    (e) => !reviewIdentities.some((identity) => sameIdentity(identity, e.identity)),
  );
  const warnings =
    independent.length > 0
      ? []
      : [
          'uat asked no question review does not: every gate that ran was ' +
            `${ran.map((e) => render(e.identity)).join(', ')}, which review runs too. ` +
            'Add a uat.gates entry the review stage does not run.',
        ];

  return { kind: 'verdict', verdict: { kind: 'passed' }, warnings };
}
