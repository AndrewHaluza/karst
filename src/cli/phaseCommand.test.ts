import { describe, it, expect } from 'vitest';
import { composePhaseCommand } from './phaseCommand.js';

describe('composePhaseCommand', () => {
  it('bakes in the phase name and quotes paths, leaving the ticket key for $ARGUMENTS', () => {
    expect(composePhaseCommand('/ext/dist/cli/main.js', '/store/karst.db', 'research')).toBe(
      'node "/ext/dist/cli/main.js" phase research --db "/store/karst.db" --ticket',
    );
  });

  it('quotes paths containing spaces', () => {
    expect(composePhaseCommand('/a b/cli.js', '/c d/x.db', 'plan')).toBe(
      'node "/a b/cli.js" phase plan --db "/c d/x.db" --ticket',
    );
  });

  it('carries the manifest so the mark lands on the right project board', () => {
    expect(
      composePhaseCommand('/ext/cli.js', '/store/karst.db', 'plan', '/repo/.karst/karst.yml'),
    ).toBe(
      'node "/ext/cli.js" phase plan --db "/store/karst.db" --manifest "/repo/.karst/karst.yml" --ticket',
    );
  });

  it('omits the manifest flag when no path is given', () => {
    expect(composePhaseCommand('/ext/cli.js', '/db.db', 'plan')).not.toContain('--manifest');
  });

  it('refuses a phase name that never passed install-time validation', () => {
    // Same charset as install (`phaseName.ts`) — a name that could not be safely
    // interpolated must never reach a command line, whatever the caller claims.
    expect(() => composePhaseCommand('/ext/cli.js', '/db.db', 'x"; rm -rf ~ #')).toThrow(
      /letters, digits/,
    );
  });
});
