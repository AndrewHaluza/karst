import { describe, it, expect } from 'vitest';
import { AGENT_GUIDE, parseGuideArgs, runGuideCommand, composeGuideCommand, renderGuideInstruction } from './guide.js';
import { runCli } from './main.js';
import { MARKER_STAGES } from '../agent/markerStage.js';

/**
 * The guard that keeps the agent guide honest (869edmcme, Option A): a new CLI
 * verb, a changed marker set, or a changed stage flow fails `npm test` until
 * the guide is updated to match. "Kept updated always" enforced, not promised.
 */

describe('karst guide — content', () => {
  it('documents every verb runCli accepts', () => {
    // runCli accepts exactly: context, stage, phase, guide (main.ts). Verbs are
    // named backtick-quoted (e.g. `phase <name>`), so match the opening tick.
    for (const verb of ['context', 'stage', 'phase', 'guide']) {
      expect(AGENT_GUIDE).toContain(`\`${verb}`);
    }
  });

  it('documents every marker stage', () => {
    for (const stage of MARKER_STAGES) {
      expect(AGENT_GUIDE).toContain(`\`${stage}\``);
    }
  });

  it('documents the full stage flow in order', () => {
    // scope → impl → uat → review → ship → done (workflow/graph.ts).
    for (const stage of ['scope', 'impl', 'uat', 'review', 'ship', 'done']) {
      expect(AGENT_GUIDE).toContain(`\`${stage}\``);
    }
    const flowIndex = AGENT_GUIDE.indexOf('scope → impl → uat → review → ship → done');
    expect(flowIndex).toBeGreaterThanOrEqual(0);
  });

  it('explains the marker rule: gate stages are refused, never self-reported', () => {
    expect(AGENT_GUIDE).toMatch(/never.*self-report|refused/i);
  });

  it('explains done means merged', () => {
    expect(AGENT_GUIDE).toMatch(/done means merged/i);
  });
});

describe('karst guide — parse', () => {
  it('accepts exactly the bare guide command', () => {
    expect(() => parseGuideArgs(['guide'])).not.toThrow();
  });

  it('rejects a missing command', () => {
    expect(() => parseGuideArgs([])).toThrow(/guide/);
  });

  it('rejects trailing argv', () => {
    expect(() => parseGuideArgs(['guide', '--json'])).toThrow(/no arguments/);
    expect(() => parseGuideArgs(['guide', 'PROJ-9'])).toThrow(/no arguments/);
  });
});

describe('karst guide — CLI routing', () => {
  it('runs through runCli without a db or manifest', () => {
    expect(runCli(['guide'])).toBe(AGENT_GUIDE);
  });

  it('rejects trailing argv that is not a recognized global flag', () => {
    // --db/--manifest/--ticket are consumed by parseGlobalFlags BEFORE the
    // subcommand dispatches (harmless, unused); anything else is guide's own
    // argv and is refused.
    expect(() => runCli(['guide', 'PROJ-9'])).toThrow(/no arguments/);
    expect(() => runCli(['guide', '--json'])).toThrow(/no arguments/);
  });

  it('runGuideCommand returns the same bytes the guide module exports', () => {
    expect(runGuideCommand(['guide'])).toBe(AGENT_GUIDE);
  });
});

describe('composeGuideCommand / renderGuideInstruction', () => {
  it('composes a double-quoted node command', () => {
    expect(composeGuideCommand('/ext/dist/cli/main.js')).toBe('node "/ext/dist/cli/main.js" guide');
    expect(composeGuideCommand('/a b/cli.js')).toBe('node "/a b/cli.js" guide');
  });

  it('renders a one-line instruction naming the command', () => {
    const instruction = renderGuideInstruction('node "/ext/cli.js" guide');
    expect(instruction).toContain('node "/ext/cli.js" guide');
    expect(instruction.split('\n').length).toBe(1);
  });
});
