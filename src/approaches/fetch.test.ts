import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installApproach,
  ApproachInstallError,
  type FetchLike,
  type RunCommand,
} from './fetch.js';
import { readApproachPackage, readArtifactBody } from './pkg.js';
import type { ApproachDef } from '../manifest/types.js';

const dirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-fetch-'));
  dirs.push(dir);
  return dir;
}

const noopRunCommand: RunCommand = () => ({ code: 0, out: '' });

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** GitHub contents-API entry shape used in canned fixtures. */
interface FixtureEntry {
  name: string;
  type: 'file' | 'dir';
  download_url?: string;
}

function contentsResponse(entries: FixtureEntry[]): Response {
  return new Response(JSON.stringify(entries));
}

describe('installApproach — git source', () => {
  it('installs a git source with one include dir (two .md files + one skipped)', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'tdd-approach',
      label: 'TDD Approach',
      description: 'Write tests first',
      entrypoint: 'main',
      source: {
        type: 'git',
        repo: 'acme/prompts',
        ref: 'main',
        include: ['prompts'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/prompts/contents/prompts?ref=main') {
        return contentsResponse([
          {
            name: 'main.md',
            type: 'file',
            download_url: 'https://raw.example.com/prompts/main.md',
          },
          {
            name: 'sub.md',
            type: 'file',
            download_url: 'https://raw.example.com/prompts/sub.md',
          },
          { name: 'notes.txt', type: 'file', download_url: 'https://raw.example.com/notes.txt' },
        ]);
      }
      if (u === 'https://raw.example.com/prompts/main.md') {
        return new Response('# Main prompt');
      }
      if (u === 'https://raw.example.com/prompts/sub.md') {
        return new Response('# Sub prompt');
      }
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });

    expect(pkg.id).toBe('tdd-approach');
    expect(pkg.label).toBe('TDD Approach');
    expect(pkg.description).toBe('Write tests first');
    expect(pkg.entrypoint).toBe('main');
    expect(pkg.prompts.sort()).toEqual(['main.md', 'sub.md']);

    const readBack = readApproachPackage(base, 'tdd-approach');
    expect(readBack).not.toBeNull();
    expect(readBack?.prompts.sort()).toEqual(['main.md', 'sub.md']);
  });

  it('persists the authored workflow into the written package', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'rpi',
      label: 'RPI',
      entrypoint: 'research',
      workflow: [
        { name: 'describe' },
        { name: 'research', command: '/rpi:research', description: 'Investigate the ticket' },
      ],
      source: {
        type: 'git',
        repo: 'acme/rpi',
        ref: 'main',
        include: ['.claude/commands'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/rpi/contents/.claude/commands?ref=main') {
        return contentsResponse([
          {
            name: 'research.md',
            type: 'file',
            download_url: 'https://raw.example.com/commands/research.md',
          },
        ]);
      }
      if (u === 'https://raw.example.com/commands/research.md') {
        return new Response('# Research command');
      }
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    expect(pkg.workflow).toEqual(def.workflow);

    const readBack = readApproachPackage(base, 'rpi');
    expect(readBack?.workflow).toEqual(def.workflow);
  });

  it('throws ApproachInstallError when entrypoint does not match any collected prompt', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'dangling',
      label: 'Dangling',
      entrypoint: 'research', // no research.md in the collected set → dangling
      source: { type: 'git', repo: 'acme/prompts', ref: 'main', include: ['prompts'] },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/prompts/contents/prompts?ref=main') {
        return contentsResponse([
          { name: 'other.md', type: 'file', download_url: 'https://raw.example.com/other.md' },
        ]);
      }
      if (u === 'https://raw.example.com/other.md') return new Response('# Other');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    await expect(
      installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand }),
    ).rejects.toThrow(ApproachInstallError);
    // Nothing half-installed: the package dir must not be left behind.
    expect(readApproachPackage(base, 'dangling')).toBeNull();
  });

  it('recurses into a nested subdirectory', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'nested-approach',
      label: 'Nested Approach',
      source: {
        type: 'git',
        repo: 'acme/prompts',
        ref: 'main',
        include: ['prompts'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/prompts/contents/prompts?ref=main') {
        return contentsResponse([
          { name: 'top.md', type: 'file', download_url: 'https://raw.example.com/top.md' },
          { name: 'sub', type: 'dir' },
        ]);
      }
      if (u === 'https://api.github.com/repos/acme/prompts/contents/prompts/sub?ref=main') {
        return contentsResponse([
          {
            name: 'nested.md',
            type: 'file',
            download_url: 'https://raw.example.com/nested.md',
          },
        ]);
      }
      if (u === 'https://raw.example.com/top.md') {
        return new Response('# Top');
      }
      if (u === 'https://raw.example.com/nested.md') {
        return new Response('# Nested');
      }
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    expect(pkg.prompts.sort()).toEqual(['nested.md', 'top.md']);
  });

  it('throws ApproachInstallError when def.source is undefined', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = { id: 'no-source', label: 'No Source' };
    const fetchFn: FetchLike = (async () => {
      throw new Error('should not be called');
    }) as FetchLike;

    await expect(installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand })).rejects.toThrow(
      ApproachInstallError,
    );
  });

  it('throws ApproachInstallError when def has no source', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'no-source',
      label: 'No Source',
      // no `source`: a built-in approach cannot be installed
    };
    const fetchFn: FetchLike = (async () => {
      throw new Error('should not be called');
    }) as FetchLike;

    await expect(installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand })).rejects.toThrow(
      ApproachInstallError,
    );
  });

  it('throws ApproachInstallError when fetchFn throws', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'network-fail',
      label: 'Network Fail',
      source: { type: 'git', repo: 'acme/prompts', ref: 'main', include: ['prompts'] },
    };
    const fetchFn: FetchLike = (async () => {
      throw new Error('network down');
    }) as FetchLike;

    await expect(installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand })).rejects.toThrow(
      ApproachInstallError,
    );
  });

  it('throws ApproachInstallError on a 404 status from the contents API', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'not-found',
      label: 'Not Found',
      source: { type: 'git', repo: 'acme/prompts', ref: 'main', include: ['missing'] },
    };
    const fetchFn: FetchLike = (async () => {
      return new Response('not found', { status: 404 });
    }) as FetchLike;

    await expect(installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand })).rejects.toThrow(
      ApproachInstallError,
    );
  });

  it('throws ApproachInstallError on invalid JSON from the contents API', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'bad-json',
      label: 'Bad JSON',
      source: { type: 'git', repo: 'acme/prompts', ref: 'main', include: ['prompts'] },
    };
    const fetchFn: FetchLike = (async () => {
      return new Response('not json {{{');
    }) as FetchLike;

    await expect(installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand })).rejects.toThrow(
      ApproachInstallError,
    );
  });

  it('de-dupes basename collisions across include paths by prefixing a counter', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'collision-approach',
      label: 'Collision Approach',
      source: {
        type: 'git',
        repo: 'acme/prompts',
        ref: 'main',
        include: ['a', 'b'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/prompts/contents/a?ref=main') {
        return contentsResponse([
          { name: 'main.md', type: 'file', download_url: 'https://raw.example.com/a/main.md' },
        ]);
      }
      if (u === 'https://api.github.com/repos/acme/prompts/contents/b?ref=main') {
        return contentsResponse([
          { name: 'main.md', type: 'file', download_url: 'https://raw.example.com/b/main.md' },
        ]);
      }
      if (u === 'https://raw.example.com/a/main.md') {
        return new Response('# A main');
      }
      if (u === 'https://raw.example.com/b/main.md') {
        return new Response('# B main');
      }
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    expect(pkg.prompts).toHaveLength(2);
    expect(pkg.prompts).toContain('main.md');
    expect(pkg.prompts.some((n) => n !== 'main.md')).toBe(true);
  });
});

describe('installApproach — structured artifacts (kind mapping + relPath preserved)', () => {
  it('classifies .claude/agents and .claude/commands and preserves subtree relPaths', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'rpi',
      label: 'RPI',
      entrypoint: 'research-agent',
      source: {
        type: 'git',
        repo: 'acme/rpi',
        ref: 'main',
        include: ['.claude/agents', '.claude/commands'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/rpi/contents/.claude/agents?ref=main') {
        return contentsResponse([
          {
            name: 'research-agent.md',
            type: 'file',
            download_url: 'https://raw.example.com/agents/research-agent.md',
          },
        ]);
      }
      if (u === 'https://api.github.com/repos/acme/rpi/contents/.claude/commands?ref=main') {
        return contentsResponse([
          { name: 'plan.md', type: 'file', download_url: 'https://raw.example.com/commands/plan.md' },
        ]);
      }
      if (u === 'https://raw.example.com/agents/research-agent.md') return new Response('# agent');
      if (u === 'https://raw.example.com/commands/plan.md') return new Response('# command');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });

    expect(pkg.artifacts).toEqual([
      { kind: 'agent', relPath: 'agents/research-agent.md' },
      { kind: 'command', relPath: 'commands/plan.md' },
    ]);

    const readBack = readApproachPackage(base, 'rpi');
    expect(readBack?.artifacts).toEqual([
      { kind: 'agent', relPath: 'agents/research-agent.md' },
      { kind: 'command', relPath: 'commands/plan.md' },
    ]);
  });

  it('classifies a skills include and preserves the skill folder (SKILL.md + siblings)', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'superpowers-tdd',
      label: 'TDD',
      entrypoint: 'test-driven-development',
      source: {
        type: 'git',
        repo: 'obra/superpowers',
        ref: 'main',
        include: ['skills/test-driven-development'],
      },
    };

    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (
        u ===
        'https://api.github.com/repos/obra/superpowers/contents/skills/test-driven-development?ref=main'
      ) {
        return contentsResponse([
          { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example.com/skill.md' },
          { name: 'ref.md', type: 'file', download_url: 'https://raw.example.com/ref.md' },
        ]);
      }
      if (u === 'https://raw.example.com/skill.md') return new Response('# tdd skill');
      if (u === 'https://raw.example.com/ref.md') return new Response('# reference');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });

    // The whole skill folder is mirrored under skills/<name>/; the skill artifact
    // points at its SKILL.md (the skill identity), siblings ride along.
    expect(pkg.artifacts).toContainEqual({
      kind: 'skill',
      relPath: 'skills/test-driven-development/SKILL.md',
    });
    expect(readArtifactBody(base, 'superpowers-tdd', 'skills/test-driven-development/ref.md')).toBe(
      '# reference',
    );
  });

  it('rejects when a workflow phase command resolves to no fetched command', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'wf-dangling',
      label: 'WF Dangling',
      // entrypoint omitted so ONLY the workflow-command guard can fail
      workflow: [{ name: 'research', command: '/wf-dangling:missing' }],
      source: { type: 'git', repo: 'acme/wf', ref: 'main', include: ['.claude/commands'] },
    };
    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/wf/contents/.claude/commands?ref=main') {
        return contentsResponse([
          { name: 'plan.md', type: 'file', download_url: 'https://raw.example.com/plan.md' },
        ]);
      }
      if (u === 'https://raw.example.com/plan.md') return new Response('# plan');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    await expect(
      installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand }),
    ).rejects.toThrow(ApproachInstallError);
    // Nothing half-installed.
    expect(readApproachPackage(base, 'wf-dangling')).toBeNull();
  });

  it('installs when every workflow phase command resolves to a fetched command', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'wf-ok',
      label: 'WF OK',
      workflow: [
        { name: 'describe' }, // no command — not checked
        { name: 'research', command: '/wf-ok:research' },
      ],
      source: { type: 'git', repo: 'acme/wf', ref: 'main', include: ['.claude/commands'] },
    };
    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/wf/contents/.claude/commands?ref=main') {
        return contentsResponse([
          { name: 'research.md', type: 'file', download_url: 'https://raw.example.com/research.md' },
        ]);
      }
      if (u === 'https://raw.example.com/research.md') return new Response('# research');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    expect(pkg.workflow).toEqual(def.workflow);
    expect(pkg.artifacts).toContainEqual({ kind: 'command', relPath: 'commands/research.md' });
  });

  it('resolves an entrypoint against a skill name (not just <entrypoint>.md)', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'sp-plans',
      label: 'Plans',
      entrypoint: 'writing-plans', // a skill folder name, no writing-plans.md exists
      source: {
        type: 'git',
        repo: 'obra/superpowers',
        ref: 'main',
        include: ['skills/writing-plans'],
      },
    };
    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (
        u === 'https://api.github.com/repos/obra/superpowers/contents/skills/writing-plans?ref=main'
      ) {
        return contentsResponse([
          { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example.com/wp.md' },
        ]);
      }
      if (u === 'https://raw.example.com/wp.md') return new Response('# writing plans');
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    const pkg = await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    expect(pkg.artifacts).toContainEqual({
      kind: 'skill',
      relPath: 'skills/writing-plans/SKILL.md',
    });
  });
});

describe('installApproach — sanitizes dangerous frontmatter at install', () => {
  it('strips permissionMode: bypassPermissions from a fetched agent before writing', async () => {
    const base = makeBaseDir();
    const def: ApproachDef = {
      id: 'unsafe',
      label: 'Unsafe',
      entrypoint: 'agent',
      source: { type: 'git', repo: 'acme/x', ref: 'main', include: ['.claude/agents'] },
    };
    const fetchFn: FetchLike = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/acme/x/contents/.claude/agents?ref=main') {
        return contentsResponse([
          { name: 'agent.md', type: 'file', download_url: 'https://raw.example.com/agent.md' },
        ]);
      }
      if (u === 'https://raw.example.com/agent.md') {
        return new Response('---\nname: agent\npermissionMode: bypassPermissions\n---\n# do work');
      }
      throw new Error(`unexpected url in test: ${u}`);
    }) as FetchLike;

    await installApproach(def, { fetchFn, baseDir: base, runCommand: noopRunCommand });
    const body = readArtifactBody(base, 'unsafe', 'agents/agent.md');
    expect(body).not.toMatch(/bypassPermissions/);
    expect(body).toContain('name: agent');
    expect(body).toContain('# do work');
  });
});

const throwingFetch: FetchLike = (async () => {
  throw new Error('should not be called for npm sources');
}) as FetchLike;

describe('installApproach — npm source', () => {
  it('runs the command in the temp cwd and collects .md files from the collect paths', async () => {
    const base = makeBaseDir();
    const seenCwds: string[] = [];
    const seenCommands: string[] = [];

    const runCommand: RunCommand = (cmd, cwd) => {
      seenCommands.push(cmd);
      seenCwds.push(cwd);
      const docsDir = join(cwd, 'docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'main.md'), '# Main');
      writeFileSync(join(docsDir, 'notes.txt'), 'not markdown');
      const nestedDir = join(docsDir, 'nested');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, 'nested.md'), '# Nested');
      return { code: 0, out: 'ok' };
    };

    const def: ApproachDef = {
      id: 'npm-approach',
      label: 'NPM Approach',
      description: 'Runs a generator',
      entrypoint: 'main',
      source: {
        type: 'npm',
        package: 'get-shit-done',
        command: 'npx get-shit-done init',
        collect: ['docs'],
      },
    };

    const pkg = await installApproach(def, { fetchFn: throwingFetch, baseDir: base, runCommand });

    expect(seenCommands).toEqual(['npx get-shit-done init']);
    expect(seenCwds).toHaveLength(1);
    expect(seenCwds[0]).toMatch(/karst-approach-/);

    expect(pkg.id).toBe('npm-approach');
    expect(pkg.label).toBe('NPM Approach');
    expect(pkg.prompts.sort()).toEqual(['main.md', 'nested.md']);

    const readBack = readApproachPackage(base, 'npm-approach');
    expect(readBack).not.toBeNull();
    expect(readBack?.prompts.sort()).toEqual(['main.md', 'nested.md']);
  });

  it('throws ApproachInstallError when entrypoint does not match any collected prompt', async () => {
    const base = makeBaseDir();
    const runCommand: RunCommand = (_cmd, cwd) => {
      const docsDir = join(cwd, 'docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'other.md'), '# Other');
      return { code: 0, out: 'ok' };
    };
    const def: ApproachDef = {
      id: 'npm-dangling',
      label: 'NPM Dangling',
      entrypoint: 'plan-phase', // no plan-phase.md collected → dangling
      source: {
        type: 'npm',
        package: 'gen',
        command: 'npx gen init',
        collect: ['docs'],
      },
    };

    await expect(
      installApproach(def, { fetchFn: throwingFetch, baseDir: base, runCommand }),
    ).rejects.toThrow(ApproachInstallError);
    expect(readApproachPackage(base, 'npm-dangling')).toBeNull();
  });

  it('throws ApproachInstallError when the command exits non-zero', async () => {
    const base = makeBaseDir();
    const runCommand: RunCommand = () => ({ code: 1, out: 'boom' });

    const def: ApproachDef = {
      id: 'npm-fail',
      label: 'NPM Fail',
      source: {
        type: 'npm',
        package: 'broken-pkg',
        command: 'npx broken-pkg init',
        collect: ['docs'],
      },
    };

    await expect(
      installApproach(def, { fetchFn: throwingFetch, baseDir: base, runCommand }),
    ).rejects.toThrow(ApproachInstallError);
  });

  it('throws ApproachInstallError when a collect path contains ".."', async () => {
    const base = makeBaseDir();
    const runCommand: RunCommand = () => ({ code: 0, out: 'ok' });

    const def: ApproachDef = {
      id: 'npm-traversal',
      label: 'NPM Traversal',
      source: {
        type: 'npm',
        package: 'some-pkg',
        command: 'npx some-pkg init',
        collect: ['../escape'],
      },
    };

    await expect(
      installApproach(def, { fetchFn: throwingFetch, baseDir: base, runCommand }),
    ).rejects.toThrow(ApproachInstallError);
  });

  it('throws ApproachInstallError when a collect path is absolute', async () => {
    const base = makeBaseDir();
    const runCommand: RunCommand = () => ({ code: 0, out: 'ok' });

    const def: ApproachDef = {
      id: 'npm-absolute',
      label: 'NPM Absolute',
      source: {
        type: 'npm',
        package: 'some-pkg',
        command: 'npx some-pkg init',
        collect: ['/etc/passwd'],
      },
    };

    await expect(
      installApproach(def, { fetchFn: throwingFetch, baseDir: base, runCommand }),
    ).rejects.toThrow(ApproachInstallError);
  });
});
