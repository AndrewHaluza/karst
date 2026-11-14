import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { cli, isLayoutShard, LAYOUT_BOOKENDS, SHARDS, shardArgs, shardWeights } from './visual-shards.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The project names of playwright.config.ts (the screenshot projects use a helper). */
function configProjects() {
  const text = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
  const body = text.slice(text.indexOf('projects: ['));
  return [
    ...[...body.matchAll(/screenshotProject\('([^']+)'/g)].map((m) => m[1]),
    ...[...body.matchAll(/^\s+name: '([^']+)',$/gm)].map((m) => m[1]),
  ];
}

describe('shardArgs', () => {
  it('splits dark in three and the layout tests in two, without the layout bookends', () => {
    expect(shardArgs(1)).toEqual(['--project=dark', '--fully-parallel', '--shard=1/3']);
    expect(shardArgs(2)).toEqual(['--project=dark', '--fully-parallel', '--shard=2/3']);
    expect(shardArgs(3)).toEqual(['--project=dark', '--fully-parallel', '--shard=3/3']);
    expect(shardArgs(4)).toEqual(['--project=layout', '--no-deps', '--fully-parallel', '--shard=1/2']);
    expect(shardArgs(5)).toEqual(['--project=layout', '--no-deps', '--fully-parallel', '--shard=2/2']);
    expect(shardArgs(6)).toEqual([
      '--project=light',
      '--project=hc',
      '--project=dark-grayscale',
      '--project=dark-reduced-motion',
      '--project=catalog',
    ]);
  });

  it('refuses a shard number outside the plan', () => {
    for (const n of [0, SHARDS.length + 1, 1.5, Number.NaN]) {
      expect(() => shardArgs(n)).toThrow(/shard number/);
      expect(() => shardWeights(n)).toThrow(/shard number/);
      expect(() => isLayoutShard(n)).toThrow(/shard number/);
    }
  });
});

describe('shardWeights', () => {
  it('gives each split shard the measured part sizes of its group, and an unsplit shard none', () => {
    expect(shardWeights(1)).toMatch(/^\d+:\d+:\d+$/);
    expect(shardWeights(4)).toMatch(/^\d+:\d+$/);
    expect(shardWeights(6)).toBe('');
  });

  it('holds one positive weight for each part of the split', () => {
    for (const s of SHARDS.filter((x) => x.split)) {
      expect(s.weights).toHaveLength(s.split[1]);
      expect(s.weights.every((w) => Number.isInteger(w) && w > 0)).toBe(true);
    }
  });
});

describe('isLayoutShard', () => {
  it('is true only for the shards that run layout tests', () => {
    expect(SHARDS.map((_, i) => isLayoutShard(i + 1))).toEqual([false, false, false, true, true, false]);
  });
});

describe('SHARDS', () => {
  it('selects every project of playwright.config.ts (the layout bookends come with layout)', () => {
    const selected = new Set(SHARDS.flatMap((s) => s.projects));
    const expected = configProjects().filter((p) => !LAYOUT_BOOKENDS.includes(p));
    expect(expected.length).toBeGreaterThan(0);
    expect([...selected].sort()).toEqual([...expected].sort());
  });

  it('gives each project to one group of shards, and each split group every part', () => {
    const groups = new Map();
    for (const s of SHARDS) {
      const key = s.projects.join(',');
      groups.set(key, [...(groups.get(key) ?? []), s.split ?? [1, 1]]);
    }
    const projects = [...groups.keys()].flatMap((k) => k.split(','));
    expect(new Set(projects).size).toBe(projects.length);
    for (const parts of groups.values()) {
      const total = parts[0][1];
      expect(parts.map((p) => p[1])).toEqual(parts.map(() => total));
      expect(parts.map((p) => p[0]).sort()).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    }
  });

  it('keeps the layout project alone in its shards, each with --no-deps (the visual job runs the verdict once)', () => {
    const layout = SHARDS.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => s.projects.includes('layout'));
    expect(layout.length).toBeGreaterThan(0);
    for (const { s, n } of layout) {
      expect(s.projects).toEqual(['layout']);
      expect(shardArgs(n)).toContain('--no-deps');
    }
    const others = SHARDS.map((_, i) => i + 1).filter((n) => !SHARDS[n - 1].projects.includes('layout'));
    expect(others.every((n) => !shardArgs(n).includes('--no-deps'))).toBe(true);
  });
});

describe('ci.yml', () => {
  const ci = load(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

  const shardSteps = ci.jobs['visual-shard'].steps;
  const visualSteps = ci.jobs.visual.steps;
  const runOf = (steps, name) => steps.find((s) => s.name === name)?.run ?? '';

  it('runs one matrix entry per planned shard', () => {
    expect(ci.jobs['visual-shard'].strategy.matrix.shard).toEqual(SHARDS.map((_, i) => i + 1));
    expect(ci.jobs['visual-shard'].name).toContain(`/${SHARDS.length})`);
  });

  it('uploads the layout shard files from each layout shard, and fails when there are none', () => {
    const upload = shardSteps.find((s) => s.name === "Upload the shard's layout files");
    expect(upload.if).toContain("outputs.layout == 'true'");
    expect(upload.with).toMatchObject({ path: 'tests/visual/.layout-shards/', 'if-no-files-found': 'error', 'include-hidden-files': true });
  });

  it('downloads every layout shard file set and runs the bookends once, in merge mode', () => {
    const download = visualSteps.find((s) => s.name === 'Download the layout shard files');
    expect(download.with).toMatchObject({ pattern: 'visual-layout-*', path: 'tests/visual/.layout-shards', 'merge-multiple': true });
    const verdict = visualSteps.find((s) => s.name === 'Run the layout ledger verdict over every layout shard');
    expect(verdict.env.KARST_LAYOUT_MERGE).toBe('1');
    expect(verdict.run).toContain('--project=layout-setup');
    expect(visualSteps.indexOf(download)).toBeLessThan(visualSteps.indexOf(verdict));
    expect(visualSteps.indexOf(verdict)).toBeLessThan(visualSteps.findIndex((s) => s.name === 'Merge the shard reports and run the gate'));
  });

  it('passes the shard weights to playwright and restores the npm cache in every visual job', () => {
    expect(runOf(shardSteps, 'Run the visual shard')).toContain('PWTEST_SHARD_WEIGHTS');
    for (const steps of [shardSteps, visualSteps]) {
      const cache = steps.find((s) => s.uses?.startsWith('actions/cache@'));
      expect(cache?.with?.key).toContain("hashFiles('package-lock.json')");
      expect(steps.some((s) => s.run?.includes('npm ci --prefer-offline'))).toBe(true);
    }
  });

  it('keeps the required check name on the job that needs the shards', () => {
    expect(ci.jobs.visual.name).toBe('Visual regression (blocks new breaks)');
    expect(ci.jobs.visual.needs).toBe('visual-shard');
  });
});

describe('cli', () => {
  it('prints the arguments of one shard', () => {
    expect(cli(['6'])).toEqual({
      code: 0,
      out: '--project=light --project=hc --project=dark-grayscale --project=dark-reduced-motion --project=catalog',
    });
  });

  it('prints the weights or the layout flag of one shard', () => {
    expect(cli(['4', 'weights'])).toEqual({ code: 0, out: shardWeights(4) });
    expect(cli(['4', 'layout'])).toEqual({ code: 0, out: 'true' });
    expect(cli(['1', 'layout'])).toEqual({ code: 0, out: 'false' });
  });

  it('fails on an unknown field', () => {
    const result = cli(['1', 'nope']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/field/);
  });

  it('fails on a bad shard number', () => {
    const result = cli(['9']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/shard number/);
  });
});
