import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupCommand } from './setupCommand.js';
import { writeProposalResult } from '../setup/ledger.js';
import { writeVerifyRecord } from '../setup/verify/record.js';
import type { DiscoveryProbe } from '../setup/discover.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-setup-cmd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeProbe(): DiscoveryProbe {
  return {
    readFile: (p) => (p === '/w/web/package.json' ? JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '^5' } }) : undefined),
    listDir: (p) => (p === '/w' ? ['web'] : []),
    exists: (p) => p === '/w' || p === '/w/web' || p === '/w/web/.git',
    git: () => undefined,
  };
}

describe('runSetupCommand discover', () => {
  it('reports fits for a repository whose karst.yml entry already has a graphWorkspace block', () => {
    const manifestPath = join(dir, 'karst.yml');
    const yaml = (extra: string): string =>
      `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nrepositories:\n  WEB:\n    repoPath: ../web\n${extra}`;
    const gap = () => ({ status: 'gap' as const, reason: 'no default' });
    const run = (): { graphDeps: unknown } =>
      JSON.parse(runSetupCommand(['setup', 'discover', '--root', '/w'], { probe: fakeProbe(), graphDeps: gap, manifestPath })).repos[0];
    writeFileSync(manifestPath, yaml('    graphWorkspace:\n      link: [.venv]\n'));
    expect(run().graphDeps).toEqual({ status: 'fits', reason: 'graphWorkspace is already set in karst.yml' });
    writeFileSync(manifestPath, yaml('    graphWorkspace: {}\n'));
    expect(run().graphDeps).toEqual({ status: 'gap', reason: 'no default' });
    writeFileSync(manifestPath, yaml(''));
    expect(run().graphDeps).toEqual({ status: 'gap', reason: 'no default' });
    writeFileSync(manifestPath, 'not: [valid');
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(run().graphDeps).toEqual({ status: 'gap', reason: 'no default' });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('could not read the manifest'));
    err.mockRestore();
  });

  it('adds the graph-deps verdict of each repository', () => {
    const out = JSON.parse(
      runSetupCommand(['setup', 'discover', '--root', '/w'], {
        probe: fakeProbe(),
        graphDeps: (path) => ({ status: 'gap', reason: `gap at ${path}` }),
      }),
    );
    expect(out.repos[0].graphDeps).toEqual({ status: 'gap', reason: `gap at ${out.repos[0].path}` });
  });

  it('prints the deterministic discovery result', () => {
    const out = JSON.parse(
      runSetupCommand(['setup', 'discover', '--root', '/w', '--default-branch', 'main'], { probe: fakeProbe() }),
    );
    expect(out.empty).toBe(false);
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toMatchObject({ name: 'web', baselineBranch: 'main', baselineBranchSource: 'default' });
    expect(out.repos[0].service.start).toBe('npm run dev');
  });

  it('rejects unknown args and a missing root value', () => {
    expect(() => runSetupCommand(['setup', 'discover', '--nope'], { probe: fakeProbe() })).toThrow(/unknown argument/);
    expect(() => runSetupCommand(['setup', 'discover', '--root'], { probe: fakeProbe() })).toThrow(/--root needs a path/);
  });

  it('refuses a --root that does not exist rather than reporting an empty workspace', () => {
    expect(() => runSetupCommand(['setup', 'discover', '--root', '/missing'], { probe: fakeProbe() })).toThrow(
      /--root \/missing does not exist/,
    );
  });
});

describe('runSetupCommand removed propose-change', () => {
  it('no longer knows propose-change', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });
    expect(() =>
      runSetupCommand(['setup', 'propose-change'], {
        outboxEnv: outbox,
        readStdin: () => JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'c' }),
      }),
    ).toThrow(/unknown subcommand 'propose-change'/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runSetupCommand(['setup', 'nope'])).toThrow(/unknown subcommand/);
  });
});

describe('runSetupCommand status shows the host verify record', () => {
  const result = (id: string, status: 'verified' | 'applied') => ({
    id, kind: 'change' as const, status, dropped: [], at: '2026-01-01T00:00:00.000Z',
  });
  it('shows the host record, and does not trust a forged verified in the outbox', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'setup-out-'));
    const host = mkdtempSync(join(tmpdir(), 'setup-host-'));
    try {
      writeProposalResult(outbox, result('real', 'verified'));
      writeProposalResult(outbox, result('forged', 'verified'));
      writeVerifyRecord(host, {
        id: 'real', kind: 'change', status: 'verified', steps: [], changes: [{ id: 'x', kind: 'cleared' }],
        pinnedSha256: null, at: '',
      });
      const out = JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: outbox, verifyDirEnv: host }));
      const byId = Object.fromEntries(out.proposals.map((p: { id: string }) => [p.id, p]));
      expect(byId.real).toMatchObject({ status: 'verified', verification: { status: 'verified', changes: [{ id: 'x' }] } });
      expect(byId.forged).toMatchObject({ status: 'applied' });
      expect(byId.forged.verification).toBeUndefined();
    } finally {
      rmSync(outbox, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });
  it('shows an unverified host record on an applied proposal', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'setup-out-'));
    const host = mkdtempSync(join(tmpdir(), 'setup-host-'));
    try {
      writeProposalResult(outbox, result('u', 'applied'));
      writeVerifyRecord(host, { id: 'u', kind: 'change', status: 'unverified', steps: [], changes: [], pinnedSha256: null, at: '' });
      const out = JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: outbox, verifyDirEnv: host }));
      expect(out.proposals[0]).toMatchObject({ status: 'applied', verification: { status: 'unverified' } });
    } finally {
      rmSync(outbox, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });
});

describe('runSetupCommand status and withdraw', () => {
  it('prints proposal ids, lists status and withdraws a pending proposal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-status-'));
    try {
      const out = JSON.parse(
        runSetupCommand(['setup', 'run'], {
          outboxEnv: dir,
          uuid: () => 'abc',
          readStdin: () => JSON.stringify({ repo: 'web', purpose: 'install-deps', command: 'npm ci' }),
          edit: { sessionEnv: 's1' },
        }),
      );
      expect(out.id).toBe('abc');
      const status = JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: dir }));
      expect(status.proposals).toMatchObject([{ id: 'abc', status: 'pending' }]);
      expect(JSON.parse(runSetupCommand(['setup', 'withdraw', 'abc'], { outboxEnv: dir }))).toMatchObject({ status: 'withdrawn' });
      expect(JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: dir })).proposals).toMatchObject([
        { id: 'abc', status: 'withdrawn' },
      ]);
      expect(() => runSetupCommand(['setup', 'withdraw', 'abc'], { outboxEnv: dir })).toThrow(/no pending proposal/);
      expect(() => runSetupCommand(['setup', 'withdraw'], { outboxEnv: dir })).toThrow(/usage/);
      expect(() => runSetupCommand(['setup', 'status', 'x'], { outboxEnv: dir })).toThrow(/no arguments/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSetupCommand typed edit tools', () => {
  const manifestText = 'id: demo\nhost: 127.0.0.1\nportRange: [4000, 4100]\nbaselineBranch: develop\nrepositories:\n  web:\n    repoPath: .\n    enabled: true\n';
  const outbox = (): string => {
    const o = join(dir, 'outbox');
    mkdirSync(o, { recursive: true });
    return realpathSync(o);
  };

  it('routes a set tool, lists the op in status and withdraws it by id', () => {
    const manifestPath = join(dir, 'karst.yml');
    writeFileSync(manifestPath, manifestText);
    const o = outbox();
    const deps = { outboxEnv: o, manifestPath, readStdin: () => '{"baselineBranch":"main"}', edit: { sessionEnv: 's', scaffold: () => undefined } };
    const added = JSON.parse(runSetupCommand(['setup', 'set-general'], deps));
    expect(added.ok).toBe(true);
    const status = JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: o }));
    expect(status.edits.map((e: { id: string }) => e.id)).toEqual([added.id]);
    expect(JSON.parse(runSetupCommand(['setup', 'withdraw', added.id], { outboxEnv: o }))).toMatchObject({ ok: true, status: 'withdrawn' });
    expect(JSON.parse(runSetupCommand(['setup', 'status'], { outboxEnv: o })).edits).toEqual([]);
  });

  it('refuses an edit tool outside a setup session', () => {
    expect(() => runSetupCommand(['setup', 'set-general'], { outboxEnv: outbox(), readStdin: () => '{}' })).toThrow(/setup session/);
  });
});

describe('runSetupCommand skip', () => {
  const outboxOf = (): string => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });
    return outbox;
  };

  it('files a skip REQUEST in the outbox and records nothing as skipped', () => {
    const outbox = outboxOf();
    const out = JSON.parse(
      runSetupCommand(['setup', 'skip'], {
        outboxEnv: outbox,
        uuid: () => 'skip-1',
        readStdin: () => JSON.stringify({ subcommand: 'skip', code: 'git.conventions', reason: 'none yet' }),
      }),
    );
    expect(out).toMatchObject({ ok: true, kind: 'skip', id: 'skip-1', status: 'requested' });
    expect(JSON.parse(readFileSync(join(outbox, 'skips', 'skip-1.json'), 'utf8'))).toEqual({ code: 'git.conventions', reason: 'none yet' });
  });

  it('refuses an unknown code, a missing reason and extra arguments', () => {
    const outbox = outboxOf();
    const run = (body: unknown, args: string[] = []) =>
      runSetupCommand(['setup', 'skip', ...args], { outboxEnv: outbox, readStdin: () => JSON.stringify(body) });
    expect(() => run({ code: 'nope', reason: 'x' })).toThrow(/code must be one of/);
    expect(() => run({ code: 'git.conventions' })).toThrow(/reason/);
    expect(() => run({ code: 'git.conventions', reason: 'x' }, ['--force'])).toThrow(/takes no arguments/);
  });

  it('has no flag or path that records a skip: the host alone does', () => {
    const outbox = outboxOf();
    expect(() => runSetupCommand(['setup', 'skip', '--approved'], { outboxEnv: outbox, readStdin: () => '{}' })).toThrow();
  });
});
