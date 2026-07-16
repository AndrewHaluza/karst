import { describe, it, expect } from 'vitest';
import {
  renderWorkflowCommand,
  renderDoneMarkerInstruction,
  buildWorkflowInvocation,
  orchestratorCommandBasename,
  KARST_PLUGIN_NAME,
} from './workflowCommand.js';
import type { WorkflowPhase } from '../manifest/types.js';

const rpiPhases: WorkflowPhase[] = [
  { name: 'describe' },
  { name: 'research', command: '/rpi:research' },
  { name: 'plan', command: '/rpi:plan' },
  { name: 'implement', command: '/rpi:implement' },
];

describe('renderWorkflowCommand', () => {
  it('titles the command /karst:<id>', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'Research, Plan, Implement', phases: rpiPhases });
    expect(body).toContain('/karst:rpi');
    expect(body).not.toContain('/rpi:karst');
    expect(body).toContain('Research, Plan, Implement');
  });
  it('still lists each native phase command in backticks', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases });
    expect(body).toContain('`/rpi:research`');
    expect(body).toContain('`/rpi:plan`');
    expect(body).toContain('`/rpi:implement`');
  });
  it('references $ARGUMENTS', () => {
    expect(renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases })).toContain('$ARGUMENTS');
  });
  it('embeds a concrete loader step when a contextCommand is given', () => {
    const body = renderWorkflowCommand({
      id: 'rpi',
      label: 'RPI',
      phases: rpiPhases,
      contextCommand: 'node "/ext/dist/cli/main.js" context --db "/x.db" --manifest "/k.yml"',
    });
    expect(body).toContain('node "/ext/dist/cli/main.js" context --db "/x.db" --manifest "/k.yml" $ARGUMENTS');
    expect(body).toContain('refresh');
  });
  it('falls back to the generic read instruction without a contextCommand', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases });
    expect(body).toContain('read and describe the ticket');
    expect(body).not.toContain('--db');
  });
  it('appends the done-marker step when a stageCommand is given', () => {
    const body = renderWorkflowCommand({
      id: 'rpi',
      label: 'RPI',
      phases: rpiPhases,
      stageCommand: 'node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket',
    });
    expect(body).toContain('node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket $ARGUMENTS');
    expect(body).toContain('done marker');
  });
  it('omits the marker step without a stageCommand', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases });
    expect(body).not.toContain('stage impl pass');
  });
});

describe('renderDoneMarkerInstruction', () => {
  it('renders the marker command with the given ticket arg', () => {
    const s = renderDoneMarkerInstruction(
      'node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket',
      'PROJ-9',
    );
    expect(s).toContain('node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket PROJ-9');
    expect(s).toContain('done marker');
    // trigger must cover no-code tickets (research/confirmation), not only "implementation complete"
    expect(s.toLowerCase()).toContain('research');
    expect(s.toLowerCase()).toContain('confirmation');
    // a session ending is not a verdict (§5.4) — the agent must fire the marker itself
    expect(s.toLowerCase()).toContain('session ending does not advance');
  });

  it('names no stage of its own — the stage is already baked into the command', () => {
    // The same text seeds a fix resume (`stage fix pass`), so naming "UAT" here
    // would tell a fixing agent the wrong thing about where it is going.
    const s = renderDoneMarkerInstruction(
      'node "/ext/cli.js" stage fix pass --db "/x.db" --ticket',
      'PROJ-9',
    );
    expect(s.toLowerCase()).not.toContain('uat');
    expect(s.toLowerCase()).not.toContain('implementation');
  });

  it('is the same text the workflow command embeds (arg = $ARGUMENTS)', () => {
    const cmd = 'node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket';
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, stageCommand: cmd });
    expect(body).toContain(renderDoneMarkerInstruction(cmd, '$ARGUMENTS'));
  });
});

describe('buildWorkflowInvocation', () => {
  it('builds /karst:<id> <key>', () => {
    expect(buildWorkflowInvocation('rpi', 'PROJ-9')).toBe('/karst:rpi PROJ-9');
    expect(buildWorkflowInvocation('rpi', 'PROJ-9')).toContain(`/${KARST_PLUGIN_NAME}:rpi`);
  });
  it('trims to just the command when the ticket key is empty', () => {
    expect(buildWorkflowInvocation('rpi', '')).toBe('/karst:rpi');
  });
});

describe('orchestratorCommandBasename', () => {
  it('is the approach id (registers as /karst:<id> under the karst plugin)', () => {
    expect(orchestratorCommandBasename('rpi')).toBe('rpi');
  });
  it('no drift: invocation command equals /<KARST_PLUGIN_NAME>:<basename>', () => {
    const id = 'rpi';
    const inv = buildWorkflowInvocation(id, 'K').split(' ')[0];
    expect(inv).toBe(`/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)}`);
  });
});
