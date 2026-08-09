import { describe, it, expect } from 'vitest';
import { STAGE_KEYS } from '../types.js';
import {
  INSIDE_PROCESSES,
  evidenceKindForProcess,
  insideStageForRuntimeStage,
} from './registry.js';
import { EVIDENCE_KINDS } from './types.js';

describe('INSIDE_PROCESSES', () => {
  it('fixes the ship roster: commit, push, pr, merge', () => {
    expect(INSIDE_PROCESSES.ship).toEqual(['commit', 'push', 'pr', 'merge']);
  });

  it('fixes the done roster: a single delivery receipt', () => {
    expect(INSIDE_PROCESSES.done).toEqual(['delivery-receipt']);
  });

  it('names exactly the six inside stages, in work order', () => {
    expect(Object.keys(INSIDE_PROCESSES)).toEqual([
      'scope',
      'impl',
      'uat',
      'review',
      'ship',
      'done',
    ]);
  });

  it('gives every stage a non-empty roster with no duplicate within a stage', () => {
    for (const [stage, ids] of Object.entries(INSIDE_PROCESSES)) {
      expect(ids.length, `${stage} has an empty roster`).toBeGreaterThan(0);
      expect(new Set(ids).size, `${stage} lists a process twice`).toBe(ids.length);
    }
  });
});

describe('insideStageForRuntimeStage', () => {
  it('projects fix onto the stage the fix is causally attached to', () => {
    expect(insideStageForRuntimeStage('fix', 'review')).toBe('review');
    expect(insideStageForRuntimeStage('fix', 'uat')).toBe('uat');
  });

  it('maps every other runtime stage onto the same-named inside stage', () => {
    for (const key of STAGE_KEYS) {
      if (key === 'fix') continue;
      expect(insideStageForRuntimeStage(key, 'uat')).toBe(key);
    }
  });
});

describe('evidenceKindForProcess', () => {
  it('assigns every registered process a kind from the closed union', () => {
    for (const ids of Object.values(INSIDE_PROCESSES)) {
      for (const id of ids) {
        expect(EVIDENCE_KINDS, `no kind for process ${id}`).toContain(
          evidenceKindForProcess(id),
        );
      }
    }
  });

  it('assigns the specialized renderers to the processes that own one', () => {
    expect(evidenceKindForProcess('session')).toBe('timeline');
    expect(evidenceKindForProcess('gates')).toBe('gates');
    expect(evidenceKindForProcess('review')).toBe('findings');
    expect(evidenceKindForProcess('commit')).toBe('commits');
    expect(evidenceKindForProcess('pr')).toBe('prs');
    expect(evidenceKindForProcess('delivery-receipt')).toBe('receipt');
  });

  it('renders plain processes with the generic rows renderer', () => {
    for (const id of ['hot-set', 'worktrees', 'services', 'tester', 'push', 'merge']) {
      expect(evidenceKindForProcess(id)).toBe('rows');
    }
  });

  it('renders an unknown process id with the generic rows renderer', () => {
    expect(evidenceKindForProcess('not-a-registered-process')).toBe('rows');
  });
});
