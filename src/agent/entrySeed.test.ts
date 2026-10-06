import { describe, it, expect } from 'vitest';
import {
  launchInvocation,
  launchSections,
  composeResumeSeed,
  composeConflictSeed,
} from './entrySeed.js';

describe('launchInvocation', () => {
  it('returns the orchestrator when present and no entry invocations', () => {
    expect(launchInvocation({ orchestratorInvocation: '/karst:rpi' })).toBe('/karst:rpi');
  });

  it('returns the orchestrator when both orchestrator and start-task are present', () => {
    expect(
      launchInvocation({
        orchestratorInvocation: '/karst:rpi',
        entryInvocations: { 'start-task': '/karst:start-task' },
      }),
    ).toBe('/karst:rpi');
  });

  it('returns start-task when no orchestrator and start-task is present', () => {
    expect(
      launchInvocation({ entryInvocations: { 'start-task': '/karst:start-task' } }),
    ).toBe('/karst:start-task');
  });

  it('returns the correct start-task for all four cores', () => {
    expect(
      launchInvocation({ entryInvocations: { 'start-task': '/karst:start-task' } }),
    ).toBe('/karst:start-task');
    expect(
      launchInvocation({ entryInvocations: { 'start-task': '/karst-start-task' } }),
    ).toBe('/karst-start-task');
    expect(
      launchInvocation({ entryInvocations: { 'start-task': '$karst-start-task' } }),
    ).toBe('$karst-start-task');
    expect(
      launchInvocation({ entryInvocations: { 'start-task': '$start-task' } }),
    ).toBe('$start-task');
  });

  it('returns null when neither is present', () => {
    expect(launchInvocation({})).toBeNull();
  });

  it('falls through to start-task when orchestrator is whitespace', () => {
    expect(
      launchInvocation({
        orchestratorInvocation: '   ',
        entryInvocations: { 'start-task': '/karst:start-task' },
      }),
    ).toBe('/karst:start-task');
  });
});

describe('launchSections', () => {
  it('returns narrative when an invocation is present', () => {
    expect(launchSections(true)).toBe('narrative');
  });

  it('returns all when no invocation is present', () => {
    expect(launchSections(false)).toBe('all');
  });
});

describe('composeResumeSeed', () => {
  const FACTS = '## Current stage\n- stage: fix (running)';

  it('puts the invocation first and the short brief in the kickoff', () => {
    const seed = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Gate X failed: ...',
      invocation: '/karst:resume',
    });
    expect(seed.kickoff.split('\n')[0]).toBe('/karst:resume PROJ-9');
    expect(seed.kickoff).toContain('Gate X failed: ...');
  });

  it('regenerates the instructions (facts + servers + marker) and never repeats them in the kickoff', () => {
    const seed = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Re-read live state and continue.',
      invocation: '/karst:resume',
      markerInstruction: 'RUN THE MARKER',
      serversInstruction: '## Services\n\nRULE',
      factsContext: FACTS,
    });
    expect(seed.instructions).toContain('## Current stage');
    expect(seed.instructions).toContain('## Services');
    expect(seed.instructions).toContain('RUN THE MARKER');
    // No duplication: the kickoff is just invocation + brief.
    expect(seed.kickoff).not.toContain('## Current stage');
    expect(seed.kickoff).not.toContain('## Services');
    expect(seed.kickoff).not.toContain('RUN THE MARKER');
    expect(seed.kickoff).toBe('/karst:resume PROJ-9\n\nRe-read live state and continue.');
  });

  it('does not regenerate the guide pointer on a resume (fresh-launch denominator only)', () => {
    const seed = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Continue.',
      invocation: '/karst:resume',
      markerInstruction: 'RUN THE MARKER',
      serversInstruction: '## Services\n\nRULE',
      factsContext: FACTS,
    });
    expect(seed.instructions).not.toContain('To understand how Karst works');
  });

  it('stays self-contained inline when no invocation was materialized', () => {
    const seed = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Continue the in-progress work on ticket PROJ-9.',
      markerInstruction: 'RUN THE MARKER',
      serversInstruction: '## Services\n\nRULE',
      factsContext: FACTS,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff).toBe(
      `Continue the in-progress work on ticket PROJ-9.\n\n${FACTS}\n\n## Services\n\nRULE\n\nRUN THE MARKER`,
    );
  });

  it('inlines everything on a solo fallback core even with an invocation', () => {
    const seed = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Fix the failing gate.',
      invocation: '/karst:fix',
      markerInstruction: 'RUN THE MARKER',
      inlineInstructions: true,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff.split('\n')[0]).toBe('/karst:fix PROJ-9');
    expect(seed.kickoff).toContain('RUN THE MARKER');
  });

  it('returns an empty kickoff when there is nothing to say', () => {
    const seed = composeResumeSeed({ ticketKey: 'PROJ-9', resumeBrief: '   ' });
    expect(seed).toEqual({ instructions: null, kickoff: '' });
  });
});

describe('composeConflictSeed', () => {
  const FACTS = '## Worktrees & branches\n- frontend: `feat/x`';

  it('prepends exactly the invocation and keeps the conflict brief short in the kickoff', () => {
    const seed = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict in repo frontend.',
      invocation: '/karst:resolve-conflict',
      markerInstruction: 'RUN THE MARKER',
      factsContext: FACTS,
    });
    expect(seed.kickoff).toBe(
      '/karst:resolve-conflict PROJ-9\n\nResolve merge conflict in repo frontend.',
    );
    expect(seed.instructions).toContain('## Worktrees & branches');
    expect(seed.instructions).toContain('RUN THE MARKER');
    // Conflict resolution runs no services — no servers rule is attached.
    expect(seed.instructions ?? '').not.toContain('## Services');
  });

  it('inlines into the kickoff when no invocation is materialized', () => {
    const seed = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict.',
      markerInstruction: 'RUN THE MARKER',
      factsContext: FACTS,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff).toBe(
      `Resolve merge conflict.\n\n${FACTS}\n\nRUN THE MARKER`,
    );
  });

  it('inlines into the kickoff on a solo fallback core', () => {
    const seed = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict.',
      invocation: '/karst:resolve-conflict',
      markerInstruction: 'RUN THE MARKER',
      inlineInstructions: true,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff.split('\n')[0]).toBe('/karst:resolve-conflict PROJ-9');
    expect(seed.kickoff).toContain('RUN THE MARKER');
  });

  it('keeps the slash command as the first token of the kickoff', () => {
    const seed = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict.',
      invocation: '/karst:resolve-conflict',
    });
    expect(seed.kickoff.startsWith('/karst:resolve-conflict PROJ-9')).toBe(true);
  });
});
