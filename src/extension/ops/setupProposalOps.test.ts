import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupProposalOps, defaultSetupProposalFs, type SetupProposalFs, type SetupVerifyWiring } from './setupProposalOps.js';
import type { ProposalResult } from '../../setup/ledger.js';
import { BASE_YAML, fakeVerifyDeps } from '../../setup/verify/verify.testutil.js';
import type { VerifyRecord } from '../../setup/verify/types.js';
import { MAX_SETUP_PROPOSAL_BYTES, type ChangeProposal } from '../../setup/proposal.js';

const A = '/s/1/outbox/a.json';
const RUN = { kind: 'run', repo: 'web', purpose: 'install-deps', command: 'npm ci' };

function fakeFs(files: Record<string, string>): SetupProposalFs & { removed: string[]; results: ProposalResult[] } {
  const removed: string[] = [];
  const results: ProposalResult[] = [];
  let tick = 0;
  return {
    removed,
    results,
    mtime: () => ++tick,
    writeResult: (_dir, r) => void results.push(r),
    readdir: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1)),
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    },
    remove: (p) => {
      removed.push(p);
      delete files[p];
    },
    exists: (p) => p in files,
  };
}

function verifyWiring(text: string | undefined, records: VerifyRecord[] = []): SetupVerifyWiring {
  return {
    deps: fakeVerifyDeps({ text }),
    recheck: vi.fn(async (ids: readonly string[]) => ids.map((id) => ({ id, status: 'ok' as const, detail: '' }))),
    writeRecord: (r) => void records.push(r),
  };
}

function deps(files: Record<string, string>, text: string | undefined = BASE_YAML) {
  const fs = fakeFs(files);
  const records: VerifyRecord[] = [];
  const verify = verifyWiring(text, records);
  const runCommand = vi.fn(async (_cwd: string, _command: string) => {});
  const applyPatch = vi.fn(async (_cwd: string, _patch: string) => {});
  const confirm = vi.fn(async (_d: { message: string; detail: string; startCommandsChanged: boolean }) => true);
  const warn = vi.fn();
  return {
    fs,
    records,
    verify,
    runCommand,
    applyPatch,
    confirm,
    warn,
    deps: {
      verify: () => verify,
      resolveDir: (c: ChangeProposal) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
      outboxes: () => ['/s/1'],
      readCurrentManifest: () => undefined,
      confirm,
      runCommand,
      applyPatch,
      notify: { info: vi.fn(), warn } as never,
      fs,
    },
  };
}

describe('the host refuses the old proposal kinds', () => {
  it.each([
    ['manifest', { kind: 'manifest', targetPath: '/w/.karst/karst.yml', yaml: 'host: x\n', summary: 's' }],
    ['change', { kind: 'change', repo: 'web', reason: 'deps', command: 'npm ci' }],
  ])('records a hand-written %s outbox file as invalid and never asks', async (_kind, body) => {
    const f = deps({ [A]: JSON.stringify(body) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual([A]);
    expect(f.fs.results).toHaveLength(1);
    expect(f.fs.results[0]).toMatchObject({ id: 'a', kind: 'unknown', status: 'invalid', reason: 'use the typed setup tools' });
    expect(f.warn).toHaveBeenCalledWith('Karst: ignored an invalid setup proposal (use the typed setup tools).');
  });

  it('drops an unknown kind and unparseable text, and ignores a non-json name', async () => {
    const f = deps({ [A]: '{"kind":"nope"}', '/s/1/outbox/b.json': 'not json', '/s/1/outbox/notes.txt': 'hi' });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.fs.removed.sort()).toEqual([A, '/s/1/outbox/b.json']);
    expect(f.fs.results.map((r) => r.status)).toEqual(['invalid', 'invalid']);
    expect(f.fs.results.find((r) => r.id === 'b')!.reason).toMatch(/^unreadable: /);
  });
});

describe('run proposal', () => {
  it('shows the purpose, the exact command and "not dry-run", then runs it on consent', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    const logs: string[] = [];
    await createSetupProposalOps({ ...f.deps, debug: (m) => void logs.push(m) }).scan();
    const shown = f.confirm.mock.calls[0]![0];
    expect(shown.message).toBe('Run this command for "web"?');
    expect(shown.detail).toContain('Directory: /w/web');
    expect(shown.detail).toContain('Purpose: install-deps');
    expect(shown.detail).toContain('Command: npm ci');
    expect(shown.detail).toContain('not dry-run');
    expect(shown.detail).toContain('Host checks (all passed):');
    expect(f.runCommand).toHaveBeenCalledWith('/w/web', 'npm ci');
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual([A]);
    expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'run', status: 'verified' });
    expect(f.fs.results.at(-1)).not.toHaveProperty('reason');
    expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'verified' });
    expect(logs).toContain(`[setup] applied proposal ${A}`);
  });

  it('runs a path run in the resolved directory', async () => {
    const run = { kind: 'run', path: '.', purpose: 'git-init', command: 'git init' };
    const f = deps({ [A]: JSON.stringify(run) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm.mock.calls[0]![0].detail).toContain('Directory: /w/.');
    expect(f.runCommand).toHaveBeenCalledWith('/w/.', 'git init');
  });

  it('marks a run whose directory cannot resolve invalid, without asking', async () => {
    const f = deps({ [A]: JSON.stringify({ ...RUN, repo: undefined, path: '../x' }) });
    const resolveDir = () => ({ ok: false as const, reason: 'path "../x" is outside the workspace root /w' });
    await createSetupProposalOps({ ...f.deps, resolveDir }).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual([A]);
    expect(f.fs.results[0]).toMatchObject({ kind: 'run', status: 'invalid', reason: expect.stringContaining('outside the workspace root') });
    expect(f.warn).toHaveBeenCalledWith('Karst: could not apply the change for "../x" (path "../x" is outside the workspace root /w).');
  });

  it('records a declined run and runs nothing', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.confirm.mockResolvedValue(false);
    const logs: string[] = [];
    await createSetupProposalOps({ ...f.deps, debug: (m) => void logs.push(m) }).scan();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual([A]);
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'declined', reason: 'declined by the user' });
    expect(logs).toContain(`[setup] user declined proposal ${A}`);
  });

  it('records a run withdrawn during consent and runs nothing', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.confirm.mockImplementation(async () => {
      f.fs.remove(A);
      return true;
    });
    await createSetupProposalOps(f.deps).scan();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'withdrawn', reason: 'withdrawn while awaiting consent' });
  });

  it('refuses the run when karst.yml changed between the popup and the run', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    let text = BASE_YAML;
    f.verify.deps.readCurrentText = () => text;
    f.confirm.mockImplementation(async () => {
      text = 'host: other\n';
      return true;
    });
    await createSetupProposalOps(f.deps).scan();
    const reason = 'karst.yml changed after the host checks ran; ask again';
    expect(f.warn).toHaveBeenCalledWith(`Karst: could not apply the change for "web" (${reason}).`);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'invalid', reason: `apply failed: ${reason}` });
    expect(f.records.at(-1)).toMatchObject({ kind: 'change', status: 'refused' });
    expect(f.fs.removed).toEqual([A]);
  });

  it('records unverified, with the reason and a warning, when the post-apply record cannot be saved', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.verify.writeRecord = () => {
      throw new Error('record disk');
    };
    await createSetupProposalOps(f.deps).scan();
    const last = f.fs.results.at(-1)!;
    expect(last).toMatchObject({ id: 'a', kind: 'run', status: 'unverified', dropped: [] });
    expect(last.reason).toMatch(/^A3 /);
    expect(f.warn).toHaveBeenCalledWith(`Karst: the setup proposal was applied but did not verify (${last.reason}).`);
  });

  it('records a failed command as invalid and the host record as unverified', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.runCommand.mockRejectedValue(new Error('boom'));
    await createSetupProposalOps(f.deps).scan();
    expect(f.warn).toHaveBeenCalledWith('Karst: could not apply the change for "web" (boom).');
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'invalid', reason: 'apply failed: boom' });
    expect(f.records.at(-1)).toMatchObject({ status: 'unverified' });
    const a1 = f.records.at(-1)!.steps.find((st) => st.id === 'A1')!;
    expect(a1.status).toBe('fail');
    expect(a1.detail).toContain('boom');
    expect(f.fs.removed).toEqual([A]);
  });

  it('records an applied run as A1 ok', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.records.at(-1)!.steps.find((st) => st.id === 'A1')!.status).toBe('ok');
  });

  it('names a path-only run by its path and gives resolveDir the placeholder repo', async () => {
    const f = deps({ [A]: JSON.stringify({ kind: 'run', path: 'sub', purpose: 'git-init', command: 'git init' }) });
    const resolveDir = vi.fn((c: ChangeProposal) => ({ ok: true as const, dir: `/w/${c.path}` }));
    await createSetupProposalOps({ ...f.deps, resolveDir }).scan();
    expect(resolveDir).toHaveBeenCalledWith({ kind: 'change', repo: 'path-run', reason: 'run: git-init', command: 'git init', path: 'sub' });
    expect(f.confirm.mock.calls[0]![0].message).toBe('Run this command in "sub"?');
  });
});

describe('createSetupProposalOps .karst guard for a run', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-ops-guard-'));
    mkdirSync(join(root, '.karst'));
    writeFileSync(join(root, '.karst', 'karst.yml'), 'host: a\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const guarded = (f: ReturnType<typeof deps>) => ({
    ...f.deps,
    resolveDir: () => ({ ok: true as const, dir: root }),
    karstRoots: () => [root],
  });

  it('restores karst.yml that a command wrote, warns, and records the run invalid', async () => {
    const file = join(root, '.karst', 'karst.yml');
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.runCommand.mockImplementation(async () => {
      writeFileSync(file, 'host: evil\n');
    });
    await createSetupProposalOps(guarded(f)).scan();
    expect(readFileSync(file, 'utf8')).toBe('host: a\n');
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'invalid', reason: 'invalid: command wrote .karst/karst.yml' });
    expect(f.warn.mock.calls[0]![0]).toMatch(/command wrote \.karst\/karst\.yml; the host restored it\. Use the typed setup tools/);
    expect(f.fs.removed).toEqual([A]);
  });

  it('restores the file even when the command then fails', async () => {
    const file = join(root, '.karst', 'karst.yml');
    const f = deps({ [A]: JSON.stringify(RUN) });
    f.runCommand.mockImplementation(async () => {
      writeFileSync(file, 'x');
      throw new Error('late failure');
    });
    await createSetupProposalOps(guarded(f)).scan();
    expect(readFileSync(file, 'utf8')).toBe('host: a\n');
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
  });

  it('guards karst.yml in every root and names each restored file', async () => {
    const other = mkdtempSync(join(tmpdir(), 'karst-ops-guard2-'));
    try {
      mkdirSync(join(other, '.karst'));
      writeFileSync(join(other, '.karst', 'karst.yml'), 'host: b\n');
      const f = deps({ [A]: JSON.stringify(RUN) });
      f.runCommand.mockImplementation(async () => {
        writeFileSync(join(root, '.karst', 'karst.yml'), 'x');
        writeFileSync(join(other, '.karst', 'karst.yml'), 'y');
      });
      await createSetupProposalOps({ ...guarded(f), karstRoots: () => [other] }).scan();
      expect(readFileSync(join(root, '.karst', 'karst.yml'), 'utf8')).toBe('host: a\n');
      expect(readFileSync(join(other, '.karst', 'karst.yml'), 'utf8')).toBe('host: b\n');
      expect(f.fs.results.at(-1)!.reason).toBe('invalid: command wrote .karst/karst.yml, .karst/karst.yml');
      expect(f.warn.mock.calls[0]![0]).toContain('command wrote .karst/karst.yml, .karst/karst.yml; the host');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('does not run the command when the .karst copy cannot be read', async () => {
    mkdirSync(join(root, '.karst', 'karst.yml.d'));
    rmSync(join(root, '.karst', 'karst.yml'));
    mkdirSync(join(root, '.karst', 'karst.yml'));
    const f = deps({ [A]: JSON.stringify(RUN) });
    await createSetupProposalOps(guarded(f)).scan();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'invalid' });
    expect(f.fs.removed).toEqual([A]);
  });

  it('applies a command that leaves karst.yml alone', async () => {
    const f = deps({ [A]: JSON.stringify(RUN) });
    await createSetupProposalOps(guarded(f)).scan();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'run', status: 'verified' });
  });
});

describe('write-file proposal', () => {
  let repo: string;
  let outside: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'karst-wf-repo-'));
    outside = mkdtempSync(join(tmpdir(), 'karst-wf-out-'));
    mkdirSync(join(repo, '.karst'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const write = (path: string, content = 'A=1\n') => ({ kind: 'write-file', repo: 'web', path, content });
  const wired = (body: unknown) => {
    const f = deps({ [A]: JSON.stringify(body) });
    return { f, d: { ...f.deps, resolveDir: () => ({ ok: true as const, dir: repo }), karstRoots: () => [repo] } };
  };

  it('builds the patch itself, shows the diff, and applies it on consent', async () => {
    const { f, d } = wired(write('config/.env.example'));
    await createSetupProposalOps(d).scan();
    const shown = f.confirm.mock.calls[0]![0];
    expect(shown.message).toBe('Write "config/.env.example" in "web"?');
    expect(shown.detail).toContain('Diff built by the host:');
    expect(shown.detail).toContain('+A=1');
    expect(f.applyPatch).toHaveBeenCalledOnce();
    const [cwd, patch] = f.applyPatch.mock.calls[0]!;
    expect(cwd).toBe(repo);
    expect(patch).toContain('config/.env.example');
    expect(patch).toContain('+A=1');
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'write-file', status: 'verified' });
    expect(f.fs.removed).toEqual([A]);
  });

  it('records a declined write and applies nothing', async () => {
    const { f, d } = wired(write('a.txt'));
    f.confirm.mockResolvedValue(false);
    await createSetupProposalOps(d).scan();
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'write-file', status: 'declined' });
  });

  it.each([
    ['a path outside the repo', '../escape.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a path under .karst/', '.karst/karst.yml'],
    ['a path under .KARST/', '.KARST/karst.yml'],
    ['a path under .git/', '.git/hooks/pre-commit'],
  ])('refuses %s without asking', async (_why, path) => {
    const { f, d } = wired(write(path));
    await createSetupProposalOps(d).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ status: 'invalid' });
    expect(f.fs.removed).toEqual([A]);
  });

  it('refuses a path through a symlink that leaves the repo', async () => {
    symlinkSync(outside, join(repo, 'link'));
    const { f, d } = wired(write('link/x.txt'));
    await createSetupProposalOps(d).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ kind: 'write-file', status: 'invalid' });
    expect(readdirSync(outside)).toEqual([]);
    expect(f.warn.mock.calls[0]![0]).toMatch(/^Karst: refused the change for "web" \(/);
  });

  it('refuses a symlink path with its own reason, and writes no host record', async () => {
    symlinkSync(outside, join(repo, 'link'));
    const { f, d } = wired(write('link/x.txt'));
    await createSetupProposalOps(d).scan();
    const reason = f.fs.results[0]!.reason!;
    expect(reason).toMatch(/symlink/i);
    expect(f.warn).toHaveBeenCalledWith(`Karst: refused the change for "web" (${reason}).`);
    expect(f.records).toHaveLength(0);
    expect(f.fs.removed).toEqual([A]);
  });

  it('refuses a write that the host P2 check rejects, with the exact reason and a refused record', async () => {
    const { f, d } = wired(write('karst.yml', 'host: x\n'));
    const logs: string[] = [];
    f.verify.deps.manifestPath = join(repo, 'karst.yml');
    f.verify.writeRecord = (r) => {
      f.records.push(r);
      throw new Error('record disk');
    };
    await createSetupProposalOps({ ...d, debug: (m) => void logs.push(m) }).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    const reason = f.fs.results[0]!.reason!;
    expect(reason).toMatch(/^P2 /);
    expect(f.fs.results[0]).toMatchObject({ kind: 'write-file', status: 'invalid' });
    expect(f.warn).toHaveBeenCalledWith(`Karst: refused the change for "web" (${reason}).`);
    expect(f.records.at(-1)).toMatchObject({ kind: 'change', status: 'refused' });
    expect(logs.some((m) => m.startsWith('[setup] could not write the verify record for ') && m.includes('record disk'))).toBe(true);
    expect(f.fs.removed).toEqual([A]);
  });

  it('gives resolveDir the host-built target', async () => {
    const { f, d } = wired(write('a.txt'));
    const resolveDir = vi.fn(() => ({ ok: true as const, dir: repo }));
    await createSetupProposalOps({ ...d, resolveDir }).scan();
    expect(resolveDir).toHaveBeenCalledWith({ kind: 'change', repo: 'web', reason: 'write-file', patch: '' });
    expect(f.applyPatch).toHaveBeenCalled();
  });

  it('refuses a path through a symlink that points into .karst/', async () => {
    symlinkSync(join(repo, '.karst'), join(repo, 'link'));
    const { f, d } = wired(write('link/karst.yml', 'host: evil\n'));
    await createSetupProposalOps(d).scan();
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ status: 'invalid' });
  });

  it('records a failed apply as invalid', async () => {
    const { f, d } = wired(write('a.txt'));
    f.applyPatch.mockRejectedValue(new Error('git apply exited 1'));
    await createSetupProposalOps(d).scan();
    expect(f.fs.results.at(-1)).toMatchObject({ kind: 'write-file', status: 'invalid', reason: 'apply failed: git apply exited 1' });
  });

  it('refuses a write that the host git apply check rejects', async () => {
    const { f, d } = wired(write('a.txt'));
    f.verify.deps.gitApplyCheck = async () => ({ ok: false, error: 'does not apply' });
    await createSetupProposalOps(d).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.fs.results[0]!.reason).toMatch(/^P3 /);
    expect(f.records.at(-1)).toMatchObject({ status: 'refused' });
  });
});

describe('createSetupProposalOps with the real fs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-setup-outbox-'));
    mkdirSync(join(root, 'outbox'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function realDeps(confirm = true) {
    const w = verifyWiring(BASE_YAML);
    return {
      verify: () => w,
      resolveDir: (c: ChangeProposal) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
      outboxes: () => [root],
      readCurrentManifest: () => undefined,
      confirm: vi.fn(async () => confirm),
      runCommand: vi.fn(async () => {}),
      applyPatch: vi.fn(async () => {}),
      notify: { info: vi.fn(), warn: vi.fn() } as never,
      debug: vi.fn(),
    };
  }

  it('runs an approved proposal and removes the file, keeping only the ledger', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(RUN));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.runCommand).toHaveBeenCalledWith('/w/web', 'npm ci');
    expect(readdirSync(join(root, 'outbox'))).toEqual(['results']);
  });

  it('ignores a missing outbox without throwing', async () => {
    const d = realDeps();
    await createSetupProposalOps({ ...d, outboxes: () => [join(root, 'nope')] }).scan();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('logs an unreadable file and skips a non-json entry', async () => {
    writeFileSync(join(root, 'outbox', 'notes.txt'), 'hi');
    writeFileSync(join(root, 'outbox', 'bad.json'), 'not json');
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(RUN));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.debug.mock.calls.some((c) => String(c[0]).includes('skipped unreadable proposal bad.json'))).toBe(true);
    expect(d.confirm).toHaveBeenCalledOnce();
  });

  it('removes a declined proposal without running it', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(RUN));
    const d = realDeps(false);
    await createSetupProposalOps(d).scan();
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'outbox'))).toEqual(['results']);
  });

  it('coalesces concurrent scans so an open modal cannot run a proposal twice', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(RUN));
    let release!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const d = { ...realDeps(), confirm };
    const ops = createSetupProposalOps(d);
    const first = ops.scan();
    const second = ops.scan();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    release(true);
    await Promise.all([first, second]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(d.runCommand).toHaveBeenCalledOnce();
  });

  it('reads a proposal of exactly the size cap', async () => {
    const body = JSON.stringify(RUN);
    writeFileSync(join(root, 'outbox', 'a.json'), body + ' '.repeat(MAX_SETUP_PROPOSAL_BYTES - body.length));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.runCommand).toHaveBeenCalledOnce();
  });

  it('ignores a dot file and a listed file that is already gone', async () => {
    writeFileSync(join(root, 'outbox', '.a.json'), JSON.stringify(RUN));
    const d = realDeps();
    const fs = { ...defaultSetupProposalFs, readdir: () => ['gone.json'], exists: () => false };
    await createSetupProposalOps({ ...d, fs }).scan();
    await createSetupProposalOps(d).scan();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'outbox')).sort()).toEqual(['.a.json']);
  });

  it('records a rejected and an unreadable file as unknown, and logs the rejection', async () => {
    writeFileSync(join(root, 'outbox', 'bad.json'), 'not json');
    writeFileSync(join(root, 'outbox', 'old.json'), JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'x' }));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    const results = readdirSync(join(root, 'outbox', 'results')).map((n) => JSON.parse(readFileSync(join(root, 'outbox', 'results', n), 'utf8')));
    expect(results.map((r) => r.kind)).toEqual(['unknown', 'unknown']);
    expect(results.find((r) => r.id === 'bad').reason).toMatch(/^unreadable: .+/);
    expect(d.debug.mock.calls.map((c) => String(c[0]))).toContain('[setup] rejected proposal old.json: use the typed setup tools');
  });

  it('scans again when a scan was requested while one ran', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(RUN));
    const releases: Array<(v: boolean) => void> = [];
    const confirm = vi.fn(() => new Promise<boolean>((r) => void releases.push(r)));
    const d = { ...realDeps(), confirm };
    const ops = createSetupProposalOps(d);
    const first = ops.scan();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const second = ops.scan();
    writeFileSync(join(root, 'outbox', 'b.json'), JSON.stringify({ ...RUN, repo: 'api' }));
    releases[0]!(true);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    releases[1]!(true);
    await Promise.all([first, second]);
    expect(d.runCommand).toHaveBeenCalledTimes(2);
  });

  it('drops an oversize proposal without parsing or prompting', async () => {
    writeFileSync(join(root, 'outbox', 'big.json'), 'x'.repeat(MAX_SETUP_PROPOSAL_BYTES + 1));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'outbox'))).toEqual(['results']);
  });
});

describe('defaultSetupProposalFs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-setup-fs-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads a directory, returns [] for a missing one, and reads a file', () => {
    writeFileSync(join(root, 'a.json'), '{"x":1}');
    expect(defaultSetupProposalFs.readdir(root)).toEqual(['a.json']);
    expect(defaultSetupProposalFs.readdir(join(root, 'missing'))).toEqual([]);
    expect(defaultSetupProposalFs.readFile(join(root, 'a.json'))).toBe('{"x":1}');
  });

  it('refuses to read a file over the size cap', () => {
    const big = join(root, 'big.json');
    writeFileSync(big, 'x'.repeat(MAX_SETUP_PROPOSAL_BYTES + 1));
    expect(() => defaultSetupProposalFs.readFile(big)).toThrow(/over the \d+-byte cap/);
  });

  it('reports a file as existing and a directory or missing path as not', () => {
    writeFileSync(join(root, 'a.json'), 'x');
    expect(defaultSetupProposalFs.exists(join(root, 'a.json'))).toBe(true);
    expect(defaultSetupProposalFs.exists(root)).toBe(false);
    expect(defaultSetupProposalFs.exists(join(root, 'missing'))).toBe(false);
  });

  it('removes a file and tolerates a missing one', () => {
    writeFileSync(join(root, 'a.json'), 'x');
    defaultSetupProposalFs.remove(join(root, 'a.json'));
    expect(defaultSetupProposalFs.exists(join(root, 'a.json'))).toBe(false);
    expect(() => defaultSetupProposalFs.remove(join(root, 'missing'))).not.toThrow();
  });

  it('reads mtime (0 when missing) and writes a result file', () => {
    writeFileSync(join(root, 'a.json'), 'x');
    expect(defaultSetupProposalFs.mtime(join(root, 'a.json'))).toBeGreaterThan(0);
    expect(defaultSetupProposalFs.mtime(join(root, 'missing'))).toBe(0);
    defaultSetupProposalFs.writeResult(root, { id: 'a', kind: 'run', status: 'verified', dropped: [], at: '2026-01-01T00:00:00.000Z' });
    expect(readdirSync(join(root, 'results'))).toHaveLength(1);
  });
});
