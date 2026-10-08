import { describe, it, expect } from 'vitest';
import { AGENT_GUIDE, parseGuideArgs, runGuideCommand, composeGuideCommand, renderGuideInstruction } from './guide.js';
import { composeTestCommand } from './test/main.js';
import { runCli } from './main.js';
import { MARKER_STAGES } from '../agent/markerStage.js';
import { renderTestSkill, TEST_SKILL_NAME, TEST_SKILL_DESCRIPTION } from '../agent/testSkill.js';
import { GENERATED_STAMP } from '../agent/generatedArtifact.js';
import { SERVERS_VIA_CLI_RULE, MCP_TOOLS_PREFERRED } from '../agent/promptText.js';

/**
 * The guard that keeps the agent guide honest (869edmcme, Option A): a new CLI
 * verb, a changed marker set, or a changed stage flow fails `npm test` until
 * the guide is updated to match. "Kept updated always" enforced, not promised.
 */

describe('karst guide — content', () => {
  it('documents every verb runCli accepts', () => {
    // runCli accepts exactly: context, stats, stage, phase, graph, node, test, guide,
    // compact, subtask, fix-brief, conflict-brief (main.ts unknown-verb message); servers
    // and env are intercepted by runCliAsync.
    // Verbs are named backtick-quoted (e.g. `phase <name>`), so match the
    // opening tick.
    for (const verb of ['context', 'stats', 'stage', 'phase', 'graph', 'node', 'test', 'guide', 'compact', 'subtask', 'draft', 'fix-brief', 'conflict-brief', 'servers', 'env', 'schema', 'mcp', 'manifest', 'setup']) {
      expect(AGENT_GUIDE).toContain(`\`${verb}`);
    }
  });

  it('prefers the MCP tools when present, falling back to the CLI', () => {
    expect(AGENT_GUIDE).toContain(MCP_TOOLS_PREFERRED);
    expect(AGENT_GUIDE).toMatch(/mcp serve/);
  });

  it('documents structured input and the schema discovery verb', () => {
    expect(AGENT_GUIDE).toContain('--file');
    expect(AGENT_GUIDE).toContain('--stdin');
    expect(AGENT_GUIDE).toMatch(/schema/);
  });

  it('documents draft propose for planning sessions: stdin JSON into the outbox, a human confirms', () => {
    expect(AGENT_GUIDE).toContain('draft propose');
    expect(AGENT_GUIDE).not.toContain('draft create');
    expect(AGENT_GUIDE).not.toContain('--description-file');
    for (const key of ['title', 'description', 'summary', 'repos', 'KARST_OUTBOX']) {
      expect(AGENT_GUIDE).toContain(key);
    }
    expect(AGENT_GUIDE).toMatch(/planning session/);
    expect(AGENT_GUIDE).toMatch(/confirm/);
  });

  it('documents the subtask create flags', () => {
    for (const flag of ['--title', '--description', '--blocking', '--repos']) {
      expect(AGENT_GUIDE).toContain(flag);
    }
    expect(AGENT_GUIDE).toMatch(/sub-task/);
  });

  it('documents the mailbox verbs and the sub-task start opt-out', () => {
    for (const verb of ['message send', 'inbox']) {
      expect(AGENT_GUIDE).toContain(`\`${verb}`);
    }
    for (const flag of ['--to', '--body', '--all', '--no-start']) {
      expect(AGENT_GUIDE).toContain(flag);
    }
    expect(AGENT_GUIDE).toMatch(/untrusted/i);
    // A parent checks its mailbox before the done marker; a child reports blockers up.
    expect(AGENT_GUIDE).toMatch(/inbox[^.]*before[^.]*stage impl pass/is);
    expect(AGENT_GUIDE).toMatch(/--to parent/);
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
