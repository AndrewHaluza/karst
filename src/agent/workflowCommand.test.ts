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
  it('uses a provider-neutral title', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'Research, Plan, Implement', phases: rpiPhases });
    expect(body).toContain('# Research, Plan, Implement');
    expect(body).not.toContain('/karst:rpi');
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
  it('adds one guide clause when a guideCommand is given', () => {
    const body = renderWorkflowCommand({
      id: 'rpi',
      label: 'RPI',
      phases: rpiPhases,
      guideCommand: 'node "/ext/dist/cli/main.js" guide',
    });
    expect(body).toContain('node "/ext/dist/cli/main.js" guide');
    expect(body).toContain('To understand how Karst works');
  });
  it('omits the guide clause without a guideCommand', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases });
    expect(body).not.toContain(' guide`');
    expect(body).not.toContain('To understand how Karst works');
  });

  describe('phase markers', () => {
    const phaseCommand = (name: string): string =>
      `node "/ext/dist/cli/main.js" phase ${name} --db "/x.db" --manifest "/k.yml" --ticket`;

    it('carries one marker call per phase, each naming its own phase', () => {
      const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, phaseCommand });
      expect(body).toContain('request approval');
      expect(body).toContain('outside the workspace sandbox');
      for (const p of rpiPhases) {
        expect(body).toContain(
          `node "/ext/dist/cli/main.js" phase ${p.name} --db "/x.db" --manifest "/k.yml" --ticket $ARGUMENTS`,
        );
      }
    });

    it('emits exactly one marker call per declared phase, in declared order', () => {
      const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, phaseCommand });
      const marked = [...body.matchAll(/main\.js" phase (\S+) /g)].map((m) => m[1]);
      expect(marked).toEqual(['describe', 'research', 'plan', 'implement']);
    });

    it('attaches the marker to the step for its own phase, not a neighbour', () => {
      const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, phaseCommand });
      const steps = body.split('\n').filter((l) => /^\d+\. /.test(l));
      expect(steps).toHaveLength(4);
      steps.forEach((line, i) => {
        expect(line).toContain(`**${rpiPhases[i]!.name}**`);
        expect(line).toContain(`phase ${rpiPhases[i]!.name} --db`);
      });
    });

    it('puts the marker before the phase work, so reading order is execution order', () => {
      // The marker is the clause an agent most easily skips, and a skipped
      // marker is the failure mode that makes this feature record nothing. It
      // must not sit after the instruction it is supposed to precede — saying
      // "first" in text printed last fights the reading order.
      const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, phaseCommand });
      const steps = body.split('\n').filter((l) => /^\d+\. /.test(l));
      for (const line of steps) {
        const marker = line.indexOf('main.js" phase ');
        const work = line.indexOf('slash command');
        expect(marker).toBeGreaterThan(-1);
        if (work > -1) expect(marker).toBeLessThan(work);
      }
    });

    it('words the marker as reporting entry, never as completing the phase', () => {
      const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases, phaseCommand });
      expect(body.toLowerCase()).toContain('report');
      const steps = body.split('\n').filter((l) => /^\d+\. /.test(l));
      for (const line of steps) {
        expect(line.toLowerCase()).not.toContain('completed');
        expect(line.toLowerCase()).not.toContain('finished');
      }
    });

    it('renders byte-identically to today when no phaseCommand is given', () => {
      const body = renderWorkflowCommand({
        id: 'rpi',
        label: 'Research, Plan, Implement',
        phases: rpiPhases,
      });
      expect(body).toBe(
        [
          '# Research, Plan, Implement',
          '',
          'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
            'First, read and describe the ticket identified by `$ARGUMENTS` so you understand ' +
            'what is being asked before proceeding.',
          '',
          'Then work through the following phases in order:',
          '',
          '1. **describe** — Handle this step manually (no native slash command for this phase).',
          '2. **research** — Run the `/rpi:research` slash command.',
          '3. **plan** — Run the `/rpi:plan` slash command.',
          '4. **implement** — Run the `/rpi:implement` slash command.',
        ].join('\n'),
      );
      expect(body).not.toContain('--ticket');
    });
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
    expect(s).toContain('request approval');
    expect(s).toContain('outside the workspace sandbox');
  });

  it('warns against firing the marker while waiting for user input', () => {
    const s = renderDoneMarkerInstruction(
      'node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket',
      'PROJ-9',
    );
    expect(s.toLowerCase()).toContain('waiting');
    expect(s.toLowerCase()).toContain('answer a question');
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
  it('slugs a namespaced approach id (colons are command-name separators)', () => {
    // `superpowers:writing-plans` is a legal approach id, but the `:` breaks the
    // generated slash command on every core (UNKNOWN-COMMAND-ISSUE). It must be
    // slugged into kebab so `/karst:superpowers:writing-plans` becomes the valid
    // `/karst:superpowers-writing-plans`.
    expect(orchestratorCommandBasename('superpowers:writing-plans')).toBe(
      'superpowers-writing-plans',
    );
    expect(buildWorkflowInvocation('superpowers:writing-plans', 'KEY-1')).toBe(
      '/karst:superpowers-writing-plans KEY-1',
    );
  });
});
