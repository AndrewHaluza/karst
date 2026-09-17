import { describe, it, expect } from 'vitest';
import { AGENT_GUIDE, parseGuideArgs, runGuideCommand, composeGuideCommand, renderGuideInstruction } from './guide.js';
import { composeTestCommand } from './test/main.js';
import { runCli } from './main.js';
import { MARKER_STAGES } from '../agent/markerStage.js';
import { renderTestSkill, TEST_SKILL_NAME, TEST_SKILL_DESCRIPTION } from '../agent/testSkill.js';
import { GENERATED_STAMP } from '../agent/generatedArtifact.js';
import { SERVERS_VIA_CLI_RULE } from '../agent/promptText.js';

/**
 * The guard that keeps the agent guide honest (869edmcme, Option A): a new CLI
 * verb, a changed marker set, or a changed stage flow fails `npm test` until
 * the guide is updated to match. "Kept updated always" enforced, not promised.
 */

describe('karst guide — content', () => {
  it('documents every verb runCli accepts', () => {
    // runCli accepts exactly: context, stats, stage, phase, graph, node, test, guide,
    // compact, fix-brief, conflict-brief (main.ts unknown-verb message); servers and env
    // are intercepted by runCliAsync.
    // Verbs are named backtick-quoted (e.g. `phase <name>`), so match the
    // opening tick.
    for (const verb of ['context', 'stats', 'stage', 'phase', 'graph', 'node', 'test', 'guide', 'compact', 'fix-brief', 'conflict-brief', 'servers', 'env']) {
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

  it('documents test create-ticket with its --project flag', () => {
    expect(AGENT_GUIDE).toContain('create-ticket');
    expect(AGENT_GUIDE).toContain('--project');
  });

  it('explains create-ticket idempotency and project scoping', () => {
    expect(AGENT_GUIDE).toMatch(/idempotent/i);
    expect(AGENT_GUIDE).toMatch(/project/i);
  });

  it('binds the agent to the CLI for running services', () => {
    expect(AGENT_GUIDE).toContain(SERVERS_VIA_CLI_RULE);
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

describe('composeTestCommand', () => {
  it('composes a double-quoted node command with --db', () => {
    expect(composeTestCommand('/ext/dist/cli/main.js', '/db/path')).toBe(
      'node "/ext/dist/cli/main.js" test --db "/db/path"',
    );
  });

  it('includes --manifest when provided', () => {
    expect(composeTestCommand('/ext/cli.js', '/db', '/manifest.yml')).toBe(
      'node "/ext/cli.js" test --db "/db" --manifest "/manifest.yml"',
    );
  });

  it('handles paths with spaces', () => {
    expect(composeTestCommand('/a b/cli.js', '/a b/db')).toBe(
      'node "/a b/cli.js" test --db "/a b/db"',
    );
  });
});

describe('test skill — anti-drift', () => {
  const skill = renderTestSkill('node "/ext/cli.js" test --db "/db"');

  it('starts with YAML frontmatter containing name and description', () => {
    expect(skill).toMatch(/^---\nname: karst-test\n/);
    expect(skill).toMatch(/description: /);
  });

  it('description matches the exported constant', () => {
    expect(skill).toContain(TEST_SKILL_DESCRIPTION);
    expect(TEST_SKILL_NAME).toBe('karst-test');
  });

  it('includes the generated stamp so writeGeneratedArtifact will overwrite on relaunch', () => {
    expect(skill).toContain(GENERATED_STAMP);
  });

  it('documents every test subcommand the CLI accepts', () => {
    for (const sub of [
      'create-ticket', 'set-stage', 'advance', 'run-gate', 'simulate-hook',
      'open-pr', 'merge-pr', 'get-state', 'get-stage', 'get-logs', 'get-hooks',
      'assert', 'pause', 'unpause', 'reset',
    ]) {
      expect(skill).toContain(sub);
    }
  });

  it('matches the guide description of the test driver', () => {
    // The guide describes test as a DEVELOPMENT tool that bypasses gate verdicts
    expect(skill).toMatch(/development tool/i);
    expect(skill).toMatch(/bypasses gate verdicts/i);
    // The guide warns that test advance can move a stage no real gate ran
    expect(skill).toMatch(/test advance --verdict passed/);
    // The guide warns that test reset wipes a registry
    expect(skill).toMatch(/test reset/);
  });

  it('embeds the resolved CLI prefix', () => {
    expect(skill).toContain('node "/ext/cli.js" test --db "/db"');
  });
});
