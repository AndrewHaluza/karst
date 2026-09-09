import { describe, it, expect } from 'vitest';
import { launchSections, composeResumeSeed, composeConflictSeed } from './entrySeed.js';

describe('launchSections', () => {
  it('returns narrative when an invocation is present', () => {
    expect(launchSections(true)).toBe('narrative');
  });

  it('returns all when no invocation is present', () => {
    expect(launchSections(false)).toBe('all');
  });
});

describe('composeResumeSeed', () => {
  it('returns invocation-first string when given an invocation', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Continue the in-progress work.',
      invocation: '/karst:resume',
    });
    expect(result).toBe('/karst:resume PROJ-9\n\nContinue the in-progress work.');
  });

  it('omits the marker when no marker instruction is given', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Fix the failing gate.',
      invocation: '/karst:resume',
    });
    expect(result).toBe('/karst:resume PROJ-9\n\nFix the failing gate.');
  });

  it('includes the marker when an invocation is given', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Fix the failing gate.',
      invocation: '/karst:resume',
      markerInstruction: 'RUN THE MARKER',
    });
    expect(result).toContain('RUN THE MARKER');
    expect(result).toContain('/karst:resume PROJ-9');
  });

  it('returns brief with marker when no invocation is given', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Continue the in-progress work on ticket PROJ-9.',
      markerInstruction: 'RUN THE MARKER',
    });
    expect(result).toBe(
      'Continue the in-progress work on ticket PROJ-9.\n\nRUN THE MARKER',
    );
  });

  it('returns brief only when neither invocation nor marker is given', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Continue the in-progress work on ticket PROJ-9.',
    });
    expect(result).toBe('Continue the in-progress work on ticket PROJ-9.');
  });

  it('uses fix invocation when provided', () => {
    const result = composeResumeSeed({
      ticketKey: 'PROJ-9',
      resumeBrief: 'Gate X failed: ...',
      invocation: '/karst:fix',
    });
    expect(result).toBe('/karst:fix PROJ-9\n\nGate X failed: ...');
  });

  it('composes from structured input rather than a hand-built string', () => {
    const ticketKey = 'PROJ-42';
    const resumeBrief = 'Re-read live state and continue.';
    const invocation = '/karst:resume';
    const markerInstruction = 'Run `karst stage impl pass --ticket PROJ-42` when done.';
    const result = composeResumeSeed({ ticketKey, resumeBrief, invocation, markerInstruction });
    expect(result).toBe(
      '/karst:resume PROJ-42\n\nRe-read live state and continue.\n\nRun `karst stage impl pass --ticket PROJ-42` when done.',
    );
  });
});

describe('composeConflictSeed', () => {
  it('prepends exactly one invocation line and one blank line', () => {
    const result = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict in repo frontend.',
      invocation: '/karst:resolve-conflict',
    });
    expect(result).toBe(
      '/karst:resolve-conflict PROJ-9\n\nResolve merge conflict in repo frontend.',
    );
  });

  it('returns the brief unchanged when no invocation is given', () => {
    const brief = 'Resolve merge conflict in repo frontend.';
    const result = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: brief,
    });
    expect(result).toBe(brief);
  });

  it('ignores markerInstruction (conflict seeds have no separate marker)', () => {
    const result = composeConflictSeed({
      ticketKey: 'PROJ-9',
      conflictBrief: 'Resolve merge conflict.',
      invocation: '/karst:resolve-conflict',
      markerInstruction: 'RUN THE MARKER',
    });
    expect(result).not.toContain('RUN THE MARKER');
    expect(result).toBe(
      '/karst:resolve-conflict PROJ-9\n\nResolve merge conflict.',
    );
  });
});
