import { describe, expect, it } from 'vitest';
import type { UatHarnessDef } from '../../manifest/types.js';
import {
  HarnessStartError,
  checkHarnessEvidence,
  harnessPromptLines,
  harnessReaskPrefix,
  matchHarnessTarget,
  parseStartEnv,
  startHarness,
  stopHarnesses,
  type HarnessExec,
  type StartedHarness,
} from './harness.js';
import type { EvidenceFs } from './testerEvidence.js';

const def: UatHarnessDef = {
  name: 'sbx',
  whenChanged: ['src/sbx/**'],
  start: 'go',
  stop: 'halt',
  evidence: '.karst/uat-scratch/out/sbx/**/summary.json',
  startTimeoutSeconds: 7,
};
const target = { repo: '/r', worktreePath: '/wt', changed: ['src/sbx/a.ts'] };
const ok = (stdout = ''): Awaited<ReturnType<HarnessExec>> => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

describe('parseStartEnv', () => {
  it('reads the last JSON line', () => {
    expect(parseStartEnv('log\n{"env":{"A":"1"}}\n')).toEqual({ A: '1' });
  });
  it('is empty without a JSON line or env', () => {
    expect(parseStartEnv('just text')).toEqual({});
    expect(parseStartEnv('{"x":1}')).toEqual({});
  });
  it.each([
    ['{bad', 'not valid JSON'],
    ['{"env":[1]}', 'must be a mapping'],
    ['{"env":{"A":1}}', '"A" must be a string'],
  ])('rejects %s', (text, message) => {
    expect(() => parseStartEnv(text)).toThrow(message);
  });
});

describe('matchHarnessTarget', () => {
  it('matches a non-test path only, and never when git cannot say', () => {
    expect(matchHarnessTarget(def, [target])).toBe(target);
    expect(matchHarnessTarget(def, [{ ...target, changed: ['src/sbx/a.test.ts'] }])).toBeUndefined();
    expect(matchHarnessTarget(def, [{ ...target, changed: null }])).toBeUndefined();
  });
});

describe('startHarness', () => {
  it('registers before the command, passes the ticket env and the timeout, and returns the env', async () => {
    const seen: unknown[] = [];
    const registered: string[] = [];
    const started = await startHarness(def, target, 5, async (cmd, o) => {
      seen.push([cmd, o.cwd, o.env, o.timeoutMs, registered.length]);
      return ok('{"env":{"N":"x"}}');
    }, (h) => registered.push(h.name));
    expect(seen).toEqual([['go', '/wt', { KARST_TICKET_ID: '5', KARST_HARNESS_NAME: 'sbx' }, 7000, 1]]);
    expect(started).toMatchObject({ name: 'sbx', repo: '/r', env: { N: 'x' }, stop: 'halt' });
  });
  it('defaults the timeout to 120 s', async () => {
    let ms = 0;
    await startHarness({ ...def, startTimeoutSeconds: undefined }, target, 1, async (_c, o) => { ms = o.timeoutMs; return ok(); }, () => {});
    expect(ms).toBe(120_000);
  });
  it('throws with the output on a non-zero exit, a timeout and a bad env line', async () => {
    const fail = (r: Partial<Awaited<ReturnType<HarnessExec>>>): Promise<StartedHarness> =>
      startHarness(def, target, 1, async () => ({ ...ok(), ...r }), () => {});
    await expect(fail({ exitCode: 2, stderr: 'E!' })).rejects.toThrow(/exited 2[\s\S]*E!/);
    await expect(fail({ exitCode: null, timedOut: true })).rejects.toThrow('did not start within 7s');
    await expect(fail({ stdout: '{bad' })).rejects.toBeInstanceOf(HarnessStartError);
  });
});

describe('stopHarnesses', () => {
  const h = (name: string): StartedHarness => ({ name, repo: 'r', worktreePath: '/wt', evidence: 'e', env: {}, stop: `stop-${name}` });
  it('stops in reverse order and continues after a failing stop', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    await stopHarnesses([h('a'), h('b')], 1, async (cmd) => {
      order.push(cmd);
      if (cmd === 'stop-b') throw new Error('nope');
      return ok();
    }, (m) => logs.push(m));
    expect(order).toEqual(['stop-b', 'stop-a']);
    expect(logs.join('\n')).toContain('stopping harness b failed: nope');
  });
});

describe('harnessPromptLines', () => {
  it('is empty without a harness and lists name, description, env and runner otherwise', () => {
    expect(harnessPromptLines(undefined)).toEqual([]);
    expect(harnessPromptLines([])).toEqual([]);
    const text = harnessPromptLines([
      { name: 'sbx', repo: 'r', worktreePath: '/wt', description: 'real\nsandbox', evidence: 'ev/**', env: { A: 'x\ny' }, stop: 's' },
    ]).join('\n');
    expect(text).toContain('## Harnesses');
    expect(text).toContain('- sbx: real sandbox');
    expect(text).toContain('env: A=x y');
    expect(text).toContain("harnessRunner.mjs' --harness sbx --check <id> -- <command...>");
    expect(text).toContain('`ev/**`');
  });
});

describe('checkHarnessEvidence', () => {
  const harness: StartedHarness = { name: 'sbx', repo: 'r', worktreePath: '/wt', evidence: 'out/sbx/**/summary.json', env: {}, stop: 's' };
  const fsWith = (files: { rel: string; mtimeMs: number }[]): EvidenceFs => ({ list: async () => files, read: async () => '' });
  it('accepts a fresh matching file only', async () => {
    expect(await checkHarnessEvidence(harness, 100, fsWith([{ rel: 'out/sbx/c1/summary.json', mtimeMs: 100 }]))).toBeNull();
    expect(await checkHarnessEvidence(harness, 100, fsWith([{ rel: 'out/sbx/c1/summary.json', mtimeMs: 99 }]))).toContain('harness "sbx"');
    // A UAT-host probe summary does not match the harness glob.
    expect(await checkHarnessEvidence(harness, 0, fsWith([{ rel: 'out/probe-1/summary.json', mtimeMs: 500 }]))).toContain('no file matching');
  });
  it('treats a failing walk as missing evidence', async () => {
    const broken: EvidenceFs = { list: async () => { throw new Error('too many'); }, read: async () => '' };
    expect(await checkHarnessEvidence(harness, 0, broken)).toContain('too many');
  });
});

describe('harnessReaskPrefix', () => {
  it('names the detail and the harness block', () => {
    expect(harnessReaskPrefix('D')).toContain('(D)');
    expect(harnessReaskPrefix('D')).toContain('Harnesses block');
  });
});
