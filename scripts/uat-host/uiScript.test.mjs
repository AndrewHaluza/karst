import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_CDP_PORT, diffLines, scriptHasUiStep, uiHostPlan } from './uiScript.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('scriptHasUiStep', () => {
  it.each(['click', 'type', 'press', 'read'])('is true for a %s step', (type) => {
    expect(scriptHasUiStep({ steps: [{ type: 'snapshot' }, { type }] })).toBe(true);
    expect(scriptHasUiStep([{ type }])).toBe(true);
  });
  it.each([
    [{ steps: [{ type: 'command', command: 'x' }, { type: 'wait', for: { log: 'a' } }, { type: 'snapshot' }, { type: 'restart' }] }],
    [[]], [{}], [null], ['click'], [{ steps: [null, 'read', 1] }],
  ])('is false for %j', (json) => {
    expect(scriptHasUiStep(json)).toBe(false);
  });
  it('is false for every shipped non-UI sample', () => {
    for (const f of ['smoke.json', 'launch.json', 'stranded-uat.steps.json']) {
      expect(scriptHasUiStep(JSON.parse(readFileSync(join(here, 'samples', f), 'utf8')))).toBe(false);
    }
  });
  it('is true for the shipped UI samples', () => {
    for (const f of ['ui-subtask.json', 'ui-resume.json', 'ui-hidden.json']) {
      expect(scriptHasUiStep(JSON.parse(readFileSync(join(here, 'samples', f), 'utf8')))).toBe(true);
    }
  });
});

describe('uiHostPlan: the CDP port opens only for a UI script', () => {
  it('adds no flag, no env and no driver without a UI step', () => {
    expect(uiHostPlan(false, '/s.sock')).toEqual({ enabled: false, launchArgs: [], testsEnv: {} });
  });
  it('adds the debugging port and the channel for a UI script', () => {
    expect(uiHostPlan(true, '/s.sock')).toEqual({
      enabled: true,
      launchArgs: [`--remote-debugging-port=${UI_CDP_PORT}`],
      testsEnv: { UAT_UI_SOCKET: '/s.sock' },
    });
  });
  it('run.mjs takes both from the plan, and docker.mjs publishes no port', () => {
    const run = readFileSync(join(here, 'run.mjs'), 'utf8');
    expect(run).toContain('scriptHasUiStep(');
    expect(run).toContain('...uiPlan.launchArgs');
    expect(run).toContain('...uiPlan.testsEnv');
    expect(run).not.toMatch(/remote-debugging-port/);
    expect(readFileSync(join(here, 'docker.mjs'), 'utf8')).not.toMatch(/'-p'|'--publish'|--network/);
  });
});

describe('diffLines', () => {
  it('reports added and removed lines, keeping order and dropping duplicates', () => {
    expect(diffLines(['a', 'b', 'c'], ['b', 'd', 'd', 'e'])).toEqual({ textAdded: ['d', 'e'], textRemoved: ['a', 'c'] });
  });
  it('reports nothing for equal text', () => {
    expect(diffLines(['a'], ['a'])).toEqual({ textAdded: [], textRemoved: [] });
  });
});
