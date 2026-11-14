import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { cli, LAYOUT_BOOKENDS, SHARDS, shardArgs } from './visual-shards.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The project names of playwright.config.ts, in config order. */
function configProjects() {
  const text = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
  const body = text.slice(text.indexOf('projects: ['));
  return [...body.matchAll(/^\s+name: '([^']+)',$/gm)].map((m) => m[1]);
}

describe('shardArgs', () => {
  it('splits the dark project in two and keeps the layout chain whole', () => {
    expect(shardArgs(1)).toEqual(['--project=dark', '--fully-parallel', '--shard=1/2']);
    expect(shardArgs(2)).toEqual(['--project=dark', '--fully-parallel', '--shard=2/2']);
    expect(shardArgs(3)).toEqual(['--project=layout']);
    expect(shardArgs(4)).toEqual([
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
    }
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

  it('never splits the layout chain: its teardown verdict must see every route', () => {
    const layout = SHARDS.filter((s) => s.projects.includes('layout'));
    expect(layout).toHaveLength(1);
    expect(layout[0].split).toBeUndefined();
  });
});

describe('ci.yml', () => {
  const ci = load(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

  it('runs one matrix entry per planned shard', () => {
    expect(ci.jobs['visual-shard'].strategy.matrix.shard).toEqual(SHARDS.map((_, i) => i + 1));
  });

  it('keeps the required check name on the job that needs the shards', () => {
    expect(ci.jobs.visual.name).toBe('Visual regression (blocks new breaks)');
    expect(ci.jobs.visual.needs).toBe('visual-shard');
  });
});

describe('cli', () => {
  it('prints the arguments of one shard', () => {
    expect(cli(['3'])).toEqual({ code: 0, out: '--project=layout' });
  });

  it('fails on a bad shard number', () => {
    const result = cli(['9']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/shard number/);
  });
});
