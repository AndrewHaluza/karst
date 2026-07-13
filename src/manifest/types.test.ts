import { describe, it, expect } from 'vitest';
import type { ApproachDef, ApproachSource } from './types.js';

describe('ApproachDef and ApproachSource types', () => {
  it('should allow a fully-populated ApproachDef with git source', () => {
    const gitSource: ApproachSource = {
      type: 'git',
      repo: 'https://github.com/example/approach',
      ref: 'main',
      include: ['prompts/', 'approach.yml'],
    };

    const def: ApproachDef = {
      id: 'my-approach',
      label: 'My Approach',
      description: 'A custom approach for development',
      entrypoint: 'research',
      source: gitSource,
      recommended: true,
    };

    expect(def.id).toBe('my-approach');
  });

  it('should allow a fully-populated ApproachDef with npm source', () => {
    const npmSource: ApproachSource = {
      type: 'npm',
      package: '@org/my-approach',
      command: 'npm install',
      collect: ['dist/prompts/', 'dist/approach.yml'],
    };

    const def: ApproachDef = {
      id: 'npm-approach',
      label: 'NPM Approach',
      description: 'An approach distributed via npm',
      entrypoint: 'plan',
      source: npmSource,
      recommended: false,
    };

    expect(def.id).toBe('npm-approach');
  });

  it('should allow a minimal ApproachDef (id + label only)', () => {
    const def: ApproachDef = {
      id: 'basic',
      label: 'Basic Approach',
    };

    expect(def.id).toBe('basic');
    expect(def.description).toBeUndefined();
    expect(def.entrypoint).toBeUndefined();
    expect(def.source).toBeUndefined();
    expect(def.recommended).toBeUndefined();
  });
});
