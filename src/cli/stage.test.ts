import { describe, it, expect, vi } from 'vitest';
import { parseStageArgs, runStageCommand, composeStageCommand } from './stage.js';
import type { Store } from '../store/db.js';

describe('composeStageCommand', () => {
  it('bakes in the impl-done marker and quotes paths, leaving the ticket key for $ARGUMENTS', () => {
    expect(composeStageCommand('/ext/dist/cli/main.js', '/store/karst.db')).toBe(
      'node "/ext/dist/cli/main.js" stage impl pass --db "/store/karst.db" --ticket',
    );
  });

  it('quotes paths containing spaces', () => {
    expect(composeStageCommand('/a b/cli.js', '/c d/x.db')).toBe(
      'node "/a b/cli.js" stage impl pass --db "/c d/x.db" --ticket',
    );
  });

  it('bakes in whichever stage the ticket sits at, so a fix resume fires "fix pass"', () => {
    expect(composeStageCommand('/ext/cli.js', '/store/karst.db', 'fix')).toBe(
      'node "/ext/cli.js" stage fix pass --db "/store/karst.db" --ticket',
    );
  });

  it('carries the manifest so the marker lands on the right project board', () => {
    expect(
      composeStageCommand('/ext/cli.js', '/store/karst.db', 'impl', '/repo/.karst/karst.yml'),
    ).toBe(
      'node "/ext/cli.js" stage impl pass --db "/store/karst.db" --manifest "/repo/.karst/karst.yml" --ticket',
    );
  });

  it('omits the manifest flag when no path is given', () => {
    expect(composeStageCommand('/ext/cli.js', '/db.db', 'impl')).not.toContain('--manifest');
  });
});

describe('parseStageArgs', () => {
  it('parses "stage impl pass" into a passed verdict', () => {
    expect(parseStageArgs(['stage', 'impl', 'pass'])).toEqual({
      stage: 'impl',
      verdict: { kind: 'passed' },
    });
  });

  it('parses "stage fix pass" — the resume boundary', () => {
    expect(parseStageArgs(['stage', 'fix', 'pass'])).toEqual({
      stage: 'fix',
      verdict: { kind: 'passed' },
    });
  });

  // The marker CLI exists for the two boundaries an agent works at (§5.4). A gate
  // verdict must come from an exit code, never from the agent saying so — the CLI
  // refusing gate keys is what makes that structural rather than conventional.
  it.each(['uat', 'review', 'ship', 'scope', 'done'])('rejects the gated stage "%s"', (stage) => {
    expect(() => parseStageArgs(['stage', stage, 'pass'])).toThrow(/impl, fix/);
  });

  it('names the rejected key so a misfired marker is diagnosable', () => {
    expect(() => parseStageArgs(['stage', 'ship', 'pass'])).toThrow(/ship/);
  });

  it('rejects an unknown stage key', () => {
    expect(() => parseStageArgs(['stage', 'nope', 'pass'])).toThrow();
  });

  // Neither marker stage has a `failed` edge, so every `fail` that parsed would
  // throw in the machine anyway. Rejecting here names the mistake, not the graph.
  it('rejects "fail" — the marker CLI records passes only', () => {
    expect(() => parseStageArgs(['stage', 'impl', 'fail'])).toThrow(/pass/);
  });

  it('rejects "fail" with a reason', () => {
    expect(() => parseStageArgs(['stage', 'fix', 'fail', 'lint broke'])).toThrow(/pass/);
  });

  it('rejects an unknown verdict word', () => {
    expect(() => parseStageArgs(['stage', 'impl', 'maybe'])).toThrow();
  });

  it('rejects a missing verdict', () => {
    expect(() => parseStageArgs(['stage', 'impl'])).toThrow();
  });
});

describe('runStageCommand', () => {
  it('calls transition with the parsed stage + verdict', () => {
    const transition = vi.fn().mockReturnValue('uat');
    const store = {} as Store;
    const next = runStageCommand(store, 42, ['stage', 'impl', 'pass'], transition);
    expect(transition).toHaveBeenCalledWith(store, 42, 'impl', { kind: 'passed' });
    expect(next).toBe('uat');
  });
});
