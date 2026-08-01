import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installApproach, type FetchLike, type RunCommand } from './fetch.js';
import { readApproachPackage, uninstallApproach, listInstalled } from './pkg.js';
import { resolveApproachPrompt } from './resolve.js';
import { ClaudeAdapter } from '../agent/claude.js';
import type { ApproachDef } from '../manifest/types.js';

/**
 * The install → uninstall → reinstall cycle for the exact approach that
 * reported the stale warning (869eckp0x): `superpowers:writing-plans`, a git
 * source whose entrypoint is a SKILL FOLDER name, so `prompts/<entrypoint>.md`
 * legitimately does not exist and the launch's only evidence of a working
 * approach is what `materializeApproach` produces. A cycle that leaves the
 * package half-written is therefore invisible until a session opens.
 */

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const noopRunCommand: RunCommand = async () => ({ code: 0, out: '' });

const DEF: ApproachDef = {
  id: 'superpowers:writing-plans',
  label: 'Write a plan first',
  entrypoint: 'writing-plans',
  enabled: true,
  source: {
    type: 'git',
    repo: 'obra/superpowers',
    ref: 'main',
    include: ['skills/writing-plans'],
  },
};

const CONTENTS_URL =
  'https://api.github.com/repos/obra/superpowers/contents/skills/writing-plans?ref=main';

/** Canned GitHub contents API for the skill folder, with a per-call body. */
function fetchSkill(body: string): FetchLike {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === CONTENTS_URL) {
      return new Response(
        JSON.stringify([
          { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example.com/skill.md' },
          { name: 'reviewer.md', type: 'file', download_url: 'https://raw.example.com/rev.md' },
        ]),
      );
    }
    if (u === 'https://raw.example.com/skill.md') return new Response(body);
    if (u === 'https://raw.example.com/rev.md') return new Response('# reviewer');
    throw new Error(`unexpected url in test: ${u}`);
  }) as FetchLike;
}

/**
 * What the launcher actually decides with (`extension.ts` § approach warning):
 * a method prompt, or materialized launch artifacts. Neither → the ticket opens
 * with context only and the warning fires.
 */
function launchContribution(baseDir: string, id: string) {
  const prompt = resolveApproachPrompt(baseDir, [DEF], id);
  const pkg = readApproachPackage(baseDir, id);
  const materialized = pkg
    ? new ClaudeAdapter().materializeApproach({
        pkg,
        baseDir,
        sessionDir: makeDir('karst-session-'),
      })
    : { extraArgs: [] as string[], ownedPaths: [] as string[] };
  return { prompt, pkg, extraArgs: materialized.extraArgs };
}

describe('approach install → uninstall → reinstall cycle', () => {
  it('a fresh install resolves its entrypoint and contributes launch artifacts', async () => {
    const base = makeDir('karst-approaches-');
    await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });

    const { pkg, extraArgs } = launchContribution(base, DEF.id);
    expect(pkg?.entrypoint).toBe('writing-plans');
    expect(pkg?.artifacts).toContainEqual({
      kind: 'skill',
      relPath: 'skills/writing-plans/SKILL.md',
    });
    // A skill-entrypoint approach has no `prompts/<entrypoint>.md` by design, so
    // the launch's whole contribution is the materialized plugin dir.
    expect(extraArgs).toContain('--plugin-dir');
  });

  it('uninstall leaves no file and no package behind', async () => {
    const base = makeDir('karst-approaches-');
    await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });

    expect(uninstallApproach(base, DEF.id)).toBe(true);
    expect(existsSync(join(base, DEF.id))).toBe(false);
    expect(readdirSync(base)).toEqual([]);
    expect(listInstalled(base)).toEqual([]);
    expect(readApproachPackage(base, DEF.id)).toBeNull();
  });

  it('uninstall is idempotent — a repeat removes nothing and does not throw', async () => {
    const base = makeDir('karst-approaches-');
    await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });
    expect(uninstallApproach(base, DEF.id)).toBe(true);
    expect(uninstallApproach(base, DEF.id)).toBe(false);
  });

  it('a reinstall after an uninstall restores a resolvable, launchable package', async () => {
    const base = makeDir('karst-approaches-');
    await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });
    uninstallApproach(base, DEF.id);

    // Nothing contributes while it is uninstalled — this IS the warning state.
    const gone = launchContribution(base, DEF.id);
    expect(gone.prompt).toBeNull();
    expect(gone.pkg).toBeNull();
    expect(gone.extraArgs).toEqual([]);

    await installApproach(DEF, { fetchFn: fetchSkill('# v2'), baseDir: base, runCommand: noopRunCommand });

    const back = launchContribution(base, DEF.id);
    expect(back.pkg?.entrypoint).toBe('writing-plans');
    expect(back.extraArgs).toContain('--plugin-dir');
  });

  it('repeat cycles converge — the package after N cycles equals the package after one', async () => {
    const base = makeDir('karst-approaches-');
    await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });
    const first = readApproachPackage(base, DEF.id);
    const firstFiles = readdirSync(join(base, DEF.id), { recursive: true }).sort();

    for (let i = 0; i < 3; i++) {
      uninstallApproach(base, DEF.id);
      await installApproach(DEF, { fetchFn: fetchSkill('# v1'), baseDir: base, runCommand: noopRunCommand });
    }

    expect(readApproachPackage(base, DEF.id)).toEqual(first);
    expect(readdirSync(join(base, DEF.id), { recursive: true }).sort()).toEqual(firstFiles);
  });
});
