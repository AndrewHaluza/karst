import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifestText } from '../../manifest/load.js';
import { createSetupProposalOps, defaultSetupProposalFs, type SetupProposalFs, type SetupVerifyWiring } from './setupProposalOps.js';
import type { ProposalResult } from '../../setup/ledger.js';
import { BASE_YAML, fakeVerifyDeps } from '../../setup/verify/verify.testutil.js';
import type { VerifyRecord } from '../../setup/verify/types.js';
import { MAX_SETUP_PROPOSAL_BYTES, type ManifestProposal, type ChangeProposal } from '../../setup/proposal.js';

const VALID_YAML = `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: main\nrepositories:\n  web:\n    repoPath: ../web\n`;

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

function manifestProposal(): ManifestProposal {
  return { kind: 'manifest', targetPath: '/w/.karst/karst.yml', yaml: VALID_YAML, summary: 'discovered web' };
}

const PENDING = { code: 'test.pending', message: 'a pending test item' };

/** Real loader; a load with a created-file overlay (a patch result) clears one test item. */
function verifyWiring(text: string | undefined, records: VerifyRecord[] = []): SetupVerifyWiring {
  const base = fakeVerifyDeps({ text });
  return {
    deps: {
      ...base,
      loadText: (t, o) => {
        const r = base.loadText(t, o);
        return r.ok && o === undefined ? { ...r, codedWarnings: [...r.codedWarnings, PENDING] } : r;
      },
    },
    recheck: vi.fn(async (ids: readonly string[]) => ids.map((id) => ({ id, status: 'ok' as const, detail: '' }))),
    writeRecord: (r) => void records.push(r),
  };
}

function deps(files: Record<string, string>, text?: string) {
  const fs = fakeFs(files);
  const records: VerifyRecord[] = [];
  const verify = verifyWiring(text, records);
  const applyManifest = vi.fn((_applied: unknown, _scratch: string) => 'sha-1');
  const runCommand = vi.fn(async () => {});
  const applyPatch = vi.fn(async () => {});
  const confirm = vi.fn(async (_d: { message: string; detail: string; startCommandsChanged: boolean }) => true);
  return {
    fs,
    records,
    verify,
    applyManifest,
    runCommand,
    applyPatch,
    confirm,
    deps: {
      verify: () => verify,
      resolveDir: (c: ChangeProposal) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
      outboxes: () => ['/s/1'],
      readCurrentManifest: () => undefined,
      confirm,
      applyManifest,
      runCommand,
      applyPatch,
      notify: { info: vi.fn(), warn: vi.fn() } as never,
      fs,
    },
  };
}

describe('createSetupProposalOps.scan', () => {
  it('applies a manifest proposal only after approval', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.applyManifest).toHaveBeenCalledOnce();
    const [applied] = f.applyManifest.mock.calls[0]!;
    expect(Object.keys((applied as { repositories: object }).repositories)).toEqual(['web']);
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  });

  it('does not apply when the user declines', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    f.confirm.mockResolvedValue(false);
    await createSetupProposalOps(f.deps).scan();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  });

  it('rejects an invalid manifest proposal without prompting', async () => {
    const bad = { ...manifestProposal(), yaml: 'host: x\nportRange: [1, 2]\nbaselineBranch: main\nrepositories: {}\n' };
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(bad) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  });

  it('runs an approved change command and applies an approved patch', async () => {
    const command: ChangeProposal = { kind: 'change', repo: 'web', reason: 'deps', command: 'npm ci' };
    const patch: ChangeProposal = { kind: 'change', repo: 'api', reason: 'env', patch: '+++ b/.env\n' };
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(command), '/s/1/outbox/b.json': JSON.stringify(patch) }, BASE_YAML);
    await createSetupProposalOps(f.deps).scan();
    expect(f.runCommand).toHaveBeenCalledWith('/w/web', 'npm ci');
    expect(f.applyPatch).toHaveBeenCalledWith('/w/api', '+++ b/.env\n');
    expect(f.fs.removed.sort()).toEqual(['/s/1/outbox/a.json', '/s/1/outbox/b.json']);
  });

  it('runs a change in the resolved path, and the modal names that directory', async () => {
    const change: ChangeProposal = { kind: 'change', repo: 'macos_iot', reason: 'init', command: 'git init', path: '.' };
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm.mock.calls[0]![0].detail).toContain('Directory: /w/.');
    expect(f.runCommand).toHaveBeenCalledWith('/w/.', 'git init');
  });

  it('marks a change whose path escapes the root invalid without prompting', async () => {
    const warns: string[] = [];
    const change: ChangeProposal = { kind: 'change', repo: 'web', reason: 'r', command: 'ls', path: '../x' };
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
    const resolveDir = () => ({ ok: false as const, reason: 'path "../x" is outside the workspace root /w' });
    await createSetupProposalOps({ ...f.deps, resolveDir, notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never }).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
    expect(f.fs.results[0]).toMatchObject({ kind: 'change', status: 'invalid', reason: expect.stringContaining('outside the workspace root') });
    expect(warns).toEqual(['Karst: could not apply the change for "web" (path "../x" is outside the workspace root /w).']);
  });

  it('records a declined change and an applied change in the ledger', async () => {
    const change: ChangeProposal = { kind: 'change', repo: 'web', reason: 'deps', command: 'npm ci' };
    const declined = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
    declined.confirm.mockResolvedValue(false);
    await createSetupProposalOps(declined.deps).scan();
    expect(declined.runCommand).not.toHaveBeenCalled();
    expect(declined.fs.results[0]).toMatchObject({ kind: 'change', status: 'declined', reason: 'declined by the user' });
    const applied = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
    await createSetupProposalOps(applied.deps).scan();
    expect(applied.fs.results[0]).toMatchObject({ kind: 'change', status: 'verified' });
  });

  it('drops an invalid proposal with a warning and ignores non-json', async () => {
    const f = deps({ '/s/1/outbox/a.json': '{"kind":"nope"}', '/s/1/outbox/notes.txt': 'hi' });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  });

  it('reports an unparseable proposal and drops it', async () => {
    const f = deps({ '/s/1/outbox/a.json': 'not json' });
    await createSetupProposalOps(f.deps).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  });

  it('warns when applying a manifest or a change fails, and still removes the file', async () => {
    const warns: string[] = [];
    const f = deps({
      '/s/1/outbox/a.json': JSON.stringify(manifestProposal()),
      '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' }),
    });
    f.applyManifest.mockImplementation(() => { throw new Error('disk full'); });
    f.runCommand.mockRejectedValue(new Error('npm missing'));
    await createSetupProposalOps({ ...f.deps, notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never }).scan();
    expect(warns.some((m) => /could not apply the manifest proposal \(disk full\)/.test(m))).toBe(true);
    expect(warns.some((m) => /could not apply the change for "web" \(npm missing\)/.test(m))).toBe(true);
    expect(f.fs.removed.sort()).toEqual(['/s/1/outbox/a.json', '/s/1/outbox/b.json']);
  });

  it('warns for an invalid manifest proposal naming the loader error', async () => {
    const warns: string[] = [];
    const bad = { ...manifestProposal(), yaml: 'repositories: {}\n' };
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(bad) });
    await createSetupProposalOps({ ...f.deps, notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never }).scan();
    expect(warns.some((m) => /proposed an invalid manifest/.test(m))).toBe(true);
  });

  it('reports an invalid setup proposal reason', async () => {
    const warns: string[] = [];
    const f = deps({ '/s/1/outbox/a.json': '{"kind":"nope"}' });
    await createSetupProposalOps({ ...f.deps, notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never }).scan();
    expect(warns.some((m) => /ignored an invalid setup proposal/.test(m))).toBe(true);
  });
});

describe('createSetupProposalOps no-change and written sections', () => {
  const CURRENT_YAML = `${VALID_YAML}archiveDoneAfterDays: 3\n`;
  const PROTECTED_ONLY = { ...manifestProposal(), yaml: `${VALID_YAML}archiveDoneAfterDays: 9\n` };

  it('writes nothing, offers no Apply and records no-change when only protected fields differ', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(PROTECTED_ONLY) });
    await createSetupProposalOps({
      ...f.deps,
      readCurrentManifest: () => parseManifestText(CURRENT_YAML).manifest,
    }).scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
    expect(f.fs.results).toHaveLength(1);
    expect(f.fs.results[0]).toMatchObject({ status: 'no-change', dropped: ['archiveDoneAfterDays'] });
    expect(f.fs.results[0]!.reason).toMatch(/Settings/);
  });

  it('names the sections the write changes in the consent detail', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    const writtenSections = vi.fn(() => ['approaches', 'repositories']);
    await createSetupProposalOps({ ...f.deps, writtenSections }).scan();
    expect(f.confirm.mock.calls[0]![0].detail).toContain('approaches, repositories');
  });

  it('still asks for consent when the section preview throws', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    await createSetupProposalOps({
      ...f.deps,
      writtenSections: () => {
        throw new Error('boom');
      },
    }).scan();
    expect(f.confirm).toHaveBeenCalledOnce();
  });
});

describe('createSetupProposalOps with the real fs (defaultFs coverage)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-setup-outbox-'));
    mkdirSync(join(root, 'outbox'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function realDeps(confirm = true) {
    return {
      verify: (() => { const w = verifyWiring(undefined); return () => w; })(),
      resolveDir: (c: { repo: string; path?: string }) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
      outboxes: () => [root],
      readCurrentManifest: () => undefined,
      confirm: vi.fn(async () => confirm),
      applyManifest: vi.fn(),
      runCommand: vi.fn(async () => {}),
      applyPatch: vi.fn(async () => {}),
      notify: { info: vi.fn(), warn: vi.fn() } as never,
      debug: vi.fn(),
    };
  }

  it('scans a real outbox, applies an approved proposal and removes the file', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(manifestProposal()));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.applyManifest).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'outbox'))).toEqual(['results']);
  });

  it('ignores a non-file entry and a missing outbox without throwing', async () => {
    const d = realDeps();
    await createSetupProposalOps({ ...d, outboxes: () => [join(root, 'nope')] }).scan();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('skips a non-json entry and logs the applied/declined/unparseable steps', async () => {
    writeFileSync(join(root, 'outbox', 'notes.txt'), 'hi');
    writeFileSync(join(root, 'outbox', 'bad.json'), 'not json');
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(manifestProposal()));
    const debug = vi.fn();
    const d = { ...realDeps(), debug };
    await createSetupProposalOps(d).scan();
    const lines = debug.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('skipped unreadable proposal bad.json'))).toBe(true);
    expect(lines.some((l) => l.includes('applied manifest proposal'))).toBe(true);
    // notes.txt is not a .json file, so it is never even considered.
    expect(d.confirm).toHaveBeenCalledOnce();
  });

  it('logs a declined proposal and removes it without applying', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(manifestProposal()));
    const debug = vi.fn();
    const d = { ...realDeps(false), debug };
    await createSetupProposalOps(d).scan();
    expect(d.applyManifest).not.toHaveBeenCalled();
    expect(debug.mock.calls.some((c) => String(c[0]).includes('user declined manifest proposal'))).toBe(true);
  });

  it('coalesces concurrent scans so an open modal cannot double-apply a proposal', async () => {
    writeFileSync(join(root, 'outbox', 'a.json'), JSON.stringify(manifestProposal()));
    let release!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const applyManifest = vi.fn();
    const d = { ...realDeps(), confirm, applyManifest };
    const ops = createSetupProposalOps(d);
    const first = ops.scan();
    const second = ops.scan(); // an fs event during the open modal
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    release(true);
    await Promise.all([first, second]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(applyManifest).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'outbox'))).toEqual(['results']);
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
});

describe('createSetupProposalOps branches', () => {
  function fakeDeps(files: Record<string, string>, names: string[]) {
    const removed: string[] = [];
    const fs: SetupProposalFs = {
      readdir: () => names,
      readFile: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
      remove: (p) => void removed.push(p),
      exists: (p) => p in files,
      mtime: () => 0,
      writeResult: () => {},
    };
    return {
      removed,
      deps: {
        verify: (() => { const w = verifyWiring(BASE_YAML); return () => w; })(),
        resolveDir: (c: { repo: string; path?: string }) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
        outboxes: () => ['/s/1'],
        readCurrentManifest: () => undefined,
        confirm: vi.fn(async () => true),
        applyManifest: vi.fn(),
        runCommand: vi.fn(async () => {}),
        applyPatch: vi.fn(async () => {}),
        notify: { info: vi.fn(), warn: vi.fn() } as never,
        fs,
      },
    };
  }

  it('skips a listed name whose file does not exist', async () => {
    const { deps: d, removed } = fakeDeps({}, ['ghost.json']);
    await createSetupProposalOps(d).scan();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });

  it('runs a command change without touching the patch path, and a patch change without a command', async () => {
    const command = { kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' };
    const patch = { kind: 'change', repo: 'api', reason: 'r', patch: '+++ b/.env\n' };
    const { deps: d } = fakeDeps(
      { '/s/1/outbox/a.json': JSON.stringify(command), '/s/1/outbox/b.json': JSON.stringify(patch) },
      ['a.json', 'b.json'],
    );
    await createSetupProposalOps(d).scan();
    expect(d.runCommand).toHaveBeenCalledWith('/w/web', 'npm ci');
    expect(d.applyPatch).toHaveBeenCalledWith('/w/api', '+++ b/.env\n');
  });

  it('declines a change proposal without applying it', async () => {
    const { deps: d, removed } = fakeDeps(
      { '/s/1/outbox/a.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'c' }) },
      ['a.json'],
    );
    d.confirm.mockResolvedValue(false);
    await createSetupProposalOps(d).scan();
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(removed).toEqual(['/s/1/outbox/a.json']);
  });
});

describe('proposal ledger', () => {
  const A = '/s/1/outbox/a.json';
  const B = '/s/1/outbox/b.json';
  const last = (f: ReturnType<typeof deps>) => f.fs.results[f.fs.results.length - 1]!;

  it('records applied with the file hash', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    await createSetupProposalOps(f.deps).scan();
    expect(last(f)).toMatchObject({ id: 'a', kind: 'manifest', status: 'verified', sha256: 'sha-1' });
  });

  it('records declined', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    f.confirm.mockResolvedValue(false);
    await createSetupProposalOps(f.deps).scan();
    expect(last(f)).toMatchObject({ id: 'a', status: 'declined' });
  });

  it('records invalid for a bad manifest, a bad shape and an apply failure', async () => {
    const bad = { ...manifestProposal(), yaml: 'repositories: {}\n' };
    const f = deps({ [A]: JSON.stringify(bad), [B]: '{"kind":"nope"}' });
    await createSetupProposalOps(f.deps).scan();
    expect(f.fs.results.map((r) => [r.id, r.status]).sort()).toEqual([['a', 'invalid'], ['b', 'invalid']]);
    expect(f.fs.results.every((r) => r.reason)).toBe(true);

    const g = deps({ [A]: JSON.stringify(manifestProposal()) });
    g.applyManifest.mockImplementation(() => { throw new Error('disk full'); });
    await createSetupProposalOps(g.deps).scan();
    expect(last(g)).toMatchObject({ status: 'invalid', reason: 'apply failed: disk full' });
  });

  it('supersedes older pending manifest proposals and applies only the newest', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()), [B]: JSON.stringify(manifestProposal()) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.applyManifest).toHaveBeenCalledOnce();
    expect(f.fs.results.map((r) => [r.id, r.status])).toEqual([['a', 'superseded'], ['b', 'verified']]);
    expect(f.fs.results[0]!.reason).toBe('superseded by b');
    expect(f.fs.removed).toContain(A);
  });

  it('does not supersede a change proposal', async () => {
    const change = { kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' };
    const f = deps({ [A]: JSON.stringify(manifestProposal()), [B]: JSON.stringify(change) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.fs.results.map((r) => r.status)).toEqual(['verified', 'verified']);
  });

  it('records withdrawn and skips the apply when the file vanishes during consent', async () => {
    const files: Record<string, string> = { [A]: JSON.stringify(manifestProposal()) };
    const f = deps(files);
    f.confirm.mockImplementation(async () => { delete files[A]; return true; });
    await createSetupProposalOps(f.deps).scan();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(last(f)).toMatchObject({ id: 'a', status: 'withdrawn' });
  });

  it('records change outcomes', async () => {
    const change = { kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' };
    const f = deps({ [A]: JSON.stringify(change) });
    f.runCommand.mockRejectedValue(new Error('npm missing'));
    await createSetupProposalOps(f.deps).scan();
    expect(last(f)).toMatchObject({ kind: 'change', status: 'invalid', reason: 'apply failed: npm missing' });
  });

  it('survives a ledger write failure', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    f.fs.writeResult = () => { throw new Error('ro'); };
    await createSetupProposalOps(f.deps).scan();
    expect(f.applyManifest).toHaveBeenCalledOnce();
  });
});

describe('first setup vs established manifest', () => {
  const A = '/s/1/outbox/a.json';
  const yaml = `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: main\nconventions:\n  commitStyle: x\nrepositories:\n  web:\n    repoPath: ../web\n  api:\n    repoPath: ../api\n`;
  const prop = { ...manifestProposal(), yaml };

  it('takes protected fields from the proposal when the current manifest is a scaffold, naming them in the modal', async () => {
    const files = { [A]: JSON.stringify(prop) };
    const f = deps(files, VALID_YAML.replace('main', 'develop'));
    const scaffold = parseManifestText(VALID_YAML.replace('main', 'develop'), 'x').manifest;
    const d = { ...f.deps, readCurrentManifest: () => scaffold, isScaffold: () => true };
    await createSetupProposalOps(d).scan();
    const [applied] = f.applyManifest.mock.calls[0]!;
    expect((applied as { baselineBranch: string }).baselineBranch).toBe('main');
    expect(f.confirm.mock.calls[0]![0].detail).toMatch(/First setup: .*protected fields/);
    expect(last(f)).toMatchObject({ status: 'verified', dropped: [] });
  });

  it('keeps protection on an established manifest and reports each dropped field', async () => {
    const f = deps({ [A]: JSON.stringify(prop) }, VALID_YAML.replace('main', 'develop'));
    const current = parseManifestText(VALID_YAML.replace('main', 'develop'), 'x').manifest;
    const d = { ...f.deps, readCurrentManifest: () => current, isScaffold: () => false };
    await createSetupProposalOps(d).scan();
    const [applied] = f.applyManifest.mock.calls[0]!;
    expect((applied as { baselineBranch: string }).baselineBranch).toBe('develop');
    const dropped = last(f).dropped;
    expect(dropped).toContain('baselineBranch');
    expect(f.confirm.mock.calls[0]![0].detail).toMatch(/Protected fields NOT applied .*baselineBranch/);
  });

  it('treats an established manifest as protected when no scaffold detector is injected', async () => {
    const f = deps({ [A]: JSON.stringify(prop) }, VALID_YAML.replace('main', 'develop'));
    const current = parseManifestText(VALID_YAML.replace('main', 'develop'), 'x').manifest;
    await createSetupProposalOps({ ...f.deps, readCurrentManifest: () => current }).scan();
    const [applied] = f.applyManifest.mock.calls[0]!;
    expect((applied as { baselineBranch: string }).baselineBranch).toBe('develop');
  });

  function last(f: ReturnType<typeof deps>): ProposalResult {
    return f.fs.results[f.fs.results.length - 1]!;
  }
});

describe('ledger details', () => {
  const A = '/s/1/outbox/a.json';
  const B = '/s/1/outbox/b.json';

  it('supersedes by modification time, not file name', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()), [B]: JSON.stringify(manifestProposal()) });
    f.fs.mtime = (p) => (p === A ? 2 : 1);
    await createSetupProposalOps(f.deps).scan();
    expect(f.fs.results.map((r) => [r.id, r.status])).toEqual([['b', 'superseded'], ['a', 'verified']]);
    expect(f.fs.results[0]!.reason).toBe('superseded by a');
  });

  it('records reasons for decline, withdrawal and an unreadable file', async () => {
    const files: Record<string, string> = { [A]: JSON.stringify({ kind: 'change', repo: 'w', reason: 'r', command: 'x' }), [B]: 'not json' };
    const f = deps(files);
    f.confirm.mockImplementation(async () => false);
    await createSetupProposalOps(f.deps).scan();
    const byId = Object.fromEntries(f.fs.results.map((r) => [r.id, r]));
    expect(byId.a).toMatchObject({ status: 'declined', reason: 'declined by the user' });
    expect(byId.b!.reason).toMatch(/^unreadable: /);

    const g = deps({ [A]: JSON.stringify({ kind: 'change', repo: 'w', reason: 'r', command: 'x' }) });
    g.confirm.mockImplementation(async () => { g.fs.remove(A); return true; });
    await createSetupProposalOps(g.deps).scan();
    expect(g.fs.results.at(-1)).toMatchObject({ status: 'withdrawn', reason: 'withdrawn while awaiting consent' });
  });

  it('declined manifest keeps the dropped list and a withdrawn manifest has the reason', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    f.confirm.mockImplementation(async () => { f.fs.remove(A); return true; });
    await createSetupProposalOps(f.deps).scan();
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'withdrawn', reason: 'withdrawn while awaiting consent' });
  });
});

describe('consent-window races', () => {
  const A = '/s/1/outbox/a.json';

  it('refuses to apply when first-setup status flipped during consent', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    const established = parseManifestText(VALID_YAML.replace('main', 'develop'), 'x').manifest;
    let calls = 0;
    const ops = createSetupProposalOps({
      ...f.deps,
      readCurrentManifest: () => (calls++ === 0 ? undefined : established),
    });
    await ops.scan();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
    expect(f.fs.results.at(-1)!.reason).toMatch(/changed while awaiting consent/);
  });

  it('keeps superseded (not withdrawn) when the superseded file is gone after its modal', async () => {
    const B = '/s/1/outbox/b.json';
    const f = deps({ [A]: JSON.stringify(manifestProposal()), [B]: JSON.stringify(manifestProposal()) });
    f.fs.mtime = (p) => (p === A ? 1 : 2);
    await createSetupProposalOps(f.deps).scan();
    const a = f.fs.results.filter((r) => r.id === 'a');
    expect(a.map((r) => r.status)).toEqual(['superseded']);
  });
});

describe('default fs ledger seam', () => {
  it('reads mtime (0 when missing) and writes a result file', () => {
    const root = mkdtempSync(join(tmpdir(), 'spo-'));
    try {
      writeFileSync(join(root, 'a.json'), 'x');
      expect(defaultSetupProposalFs.mtime(join(root, 'a.json'))).toBeGreaterThan(0);
      expect(defaultSetupProposalFs.mtime(join(root, 'missing'))).toBe(0);
      defaultSetupProposalFs.writeResult(root, { id: 'a', kind: 'change', status: 'verified', dropped: [], at: 't' });
      expect(readdirSync(join(root, 'results'))).toEqual(['a.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createSetupProposalOps raw delta', () => {
  it('asks for consent when the proposal equals the current manifest but the write removes a key', async () => {
    const retiredText = `${VALID_YAML}approaches:\n  - id: g\n    label: G\n    graph:\n      limits:\n        confirmGeneratedGraph: true\n`;
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) }, retiredText);
    await createSetupProposalOps({
      ...f.deps,
      readCurrentManifest: () => parseManifestText(VALID_YAML).manifest,
      removedKeys: () => ['approaches[0].graph.limits.confirmGeneratedGraph'],
    }).scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm.mock.calls[0]![0].detail).toContain('approaches[0].graph.limits.confirmGeneratedGraph');
    expect(f.applyManifest).toHaveBeenCalledOnce();
    expect(f.fs.results[0]).toMatchObject({ status: 'verified' });
  });
});

describe('createSetupProposalOps removed-key preview', () => {
  it('passes the effective manifest and scratch to the preview and still asks when it throws', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    const removedKeys = vi.fn((_m: unknown, _s: string): string[] => {
      throw new Error('boom');
    });
    await createSetupProposalOps({ ...f.deps, removedKeys }).scan();
    expect(removedKeys).toHaveBeenCalledWith(expect.objectContaining({ repositories: expect.anything() }), '/s/1');
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm.mock.calls[0]![0].detail).not.toContain('Retired or legacy keys');
  });

  it('logs a failed preview, and logs nothing when the preview seams are absent', async () => {
    const debug = vi.fn();
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    await createSetupProposalOps({ ...f.deps, debug }).scan();
    expect(debug.mock.calls.some((c) => /could not preview/.test(String(c[0])))).toBe(false);
    const g = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    await createSetupProposalOps({
      ...g.deps,
      debug,
      removedKeys: () => {
        throw new Error('boom');
      },
    }).scan();
    expect(debug).toHaveBeenCalledWith('[setup] could not preview written sections: boom');
  });

  it('names the removed keys in the consent detail', async () => {
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(manifestProposal()) });
    await createSetupProposalOps({ ...f.deps, removedKeys: () => ['a.b', 'c'] }).scan();
    expect(f.confirm.mock.calls[0]![0].detail).toContain('Retired or legacy keys that this write removes from karst.yml: a.b, c.');
  });
});

describe('createSetupProposalOps .karst guard', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-ops-guard-'));
    mkdirSync(join(root, '.karst'));
    mkdirSync(join(root, 'web'));
    writeFileSync(join(root, '.karst', 'karst.yml'), 'host: a\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const patchOn = (path: string): string =>
    `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-host: a\n+host: b\n`;
  const run = async (change: Record<string, unknown>) => {
    const f = deps({ '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', ...change }) }, BASE_YAML);
    await createSetupProposalOps({
      ...f.deps,
      resolveDir: (c: ChangeProposal) => ({ ok: true as const, dir: c.path === undefined ? root : join(root, c.path) }),
      karstRoots: () => [root],
    }).scan();
    return f;
  };

  it.each([
    ['.karst/karst.yml', '.karst/karst.yml'],
    ['.KARST/karst.yml', '.KARST/karst.yml'],
  ])('refuses a patch on %s', async (_n, path) => {
    const f = await run({ patch: patchOn(path) });
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ kind: 'change', status: 'invalid' });
    expect(f.fs.results[0]!.reason).toMatch(/manifest propose/);
  });

  it('refuses a patch through a symlink', async () => {
    symlinkSync(join(root, '.karst'), join(root, 'web', 'link'));
    const f = await run({ path: 'web', patch: patchOn('link/karst.yml') });
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ status: 'invalid' });
  });

  it('refuses a patch whose rename to targets .karst', async () => {
    const f = await run({ patch: 'diff --git a/x b/.karst/karst.yml\nrename from x\nrename to .karst/karst.yml\n' });
    expect(f.applyPatch).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ status: 'invalid' });
  });

  it('restores karst.yml that a command wrote and records it invalid', async () => {
    const file = join(root, '.karst', 'karst.yml');
    const f = deps({ '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'sh x' }) }, BASE_YAML);
    f.runCommand.mockImplementation(async () => {
      writeFileSync(file, 'host: evil\n');
    });
    await createSetupProposalOps({
      ...f.deps,
      resolveDir: () => ({ ok: true as const, dir: root }),
      karstRoots: () => [root],
    }).scan();
    expect(readFileSync(file, 'utf8')).toBe('host: a\n');
    expect(f.fs.results[0]).toMatchObject({ status: 'invalid', reason: 'invalid: command wrote .karst/karst.yml' });
  });

  it('warns, removes the file and records the reason for a refused patch', async () => {
    const warns: string[] = [];
    const f = deps({ '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', patch: patchOn('.karst/karst.yml') }) });
    await createSetupProposalOps({
      ...f.deps,
      notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never,
      resolveDir: () => ({ ok: true as const, dir: root }),
    }).scan();
    expect(warns).toEqual([expect.stringMatching(/^Karst: refused the change for "web" \(.*\.karst\/karst\.yml.*manifest propose.*\)\.$/)]);
    expect(f.fs.removed).toEqual(['/s/1/outbox/b.json']);
    expect(f.fs.results[0]!.reason).toMatch(/under \.karst\/; use `manifest propose`/);
  });

  it('warns about a restored command and removes the file', async () => {
    const warns: string[] = [];
    const file = join(root, '.karst', 'karst.yml');
    const f = deps({ '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'sh x' }) }, BASE_YAML);
    f.runCommand.mockImplementation(async () => {
      writeFileSync(file, 'x');
      throw new Error('late failure');
    });
    await createSetupProposalOps({
      ...f.deps,
      notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never,
      resolveDir: () => ({ ok: true as const, dir: root }),
    }).scan();
    expect(readFileSync(file, 'utf8')).toBe('host: a\n');
    expect(warns[0]).toMatch(/command wrote \.karst\/karst\.yml; the host restored it\. Use `manifest propose`/);
    expect(f.fs.removed).toEqual(['/s/1/outbox/b.json']);
  });

  it('takes no snapshot for a patch: it runs applyPatch only', async () => {
    const f = await run({ patch: patchOn('a.txt') });
    expect(f.applyPatch).toHaveBeenCalledWith(root, patchOn('a.txt'));
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results[0]).toMatchObject({ status: 'verified' });
  });

  it('does not restore a file for a patch, since the patch guard runs before it', async () => {
    const file = join(root, '.karst', 'karst.yml');
    const f = deps({ '/s/1/outbox/b.json': JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', patch: patchOn('a.txt') }) }, BASE_YAML);
    f.applyPatch.mockImplementation(async () => {
      writeFileSync(file, 'changed by patch\n');
    });
    await createSetupProposalOps({ ...f.deps, resolveDir: () => ({ ok: true as const, dir: root }), karstRoots: () => [root] }).scan();
    expect(readFileSync(file, 'utf8')).toBe('changed by patch\n');
    expect(f.fs.results[0]).toMatchObject({ status: 'verified' });
  });

  it('applies a command that leaves karst.yml alone', async () => {
    const f = await run({ command: 'npm ci' });
    expect(f.fs.results[0]).toMatchObject({ status: 'verified' });
  });
});

describe('createSetupProposalOps host verification', () => {
  const A = '/s/1/outbox/a.json';
  const RETIRED =
    `${VALID_YAML}approaches:\n  - id: g\n    label: G\n    graph:\n      limits:\n        confirmGeneratedGraph: true\n`;
  const FIXED = { ...manifestProposal(), yaml: `${VALID_YAML}approaches:\n  - id: g\n    label: G\n` };
  const scanWith = async (f: ReturnType<typeof deps>, over: Record<string, unknown> = {}) =>
    createSetupProposalOps({
      ...f.deps,
      readCurrentManifest: () => parseManifestText(RETIRED).manifest,
      removedKeys: () => ['approaches[0].graph.limits.confirmGeneratedGraph'],
      ...over,
    }).scan();

  it('shows the host checks and the computed item in the popup, and records verified on the host side', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    await scanWith(f);
    const detail = f.confirm.mock.calls[0]![0].detail;
    expect(detail).toContain('Host checks (all passed):');
    expect(detail).toContain('cleared manifest.retired-key.confirmGeneratedGraph');
    expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'verified' });
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'verified' });
  });

  it('refuses a forged outbox file that the checklist fails, without asking', async () => {
    const forged = { ...FIXED, clears: ['manifest.legacy-services'] };
    const f = deps({ [A]: JSON.stringify(forged) }, RETIRED);
    await scanWith(f);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
    expect(f.fs.results.at(-1)!.reason).toMatch(/P6/);
    expect(f.records.at(-1)).toMatchObject({ status: 'refused' });
    expect(f.fs.removed).toEqual([A]);
  });

  it('refuses a forged file with a bad shape the same way', async () => {
    const f = deps({ [A]: JSON.stringify({ kind: 'manifest', yaml: 5 }) }, RETIRED);
    await scanWith(f);
    expect(f.applyManifest).not.toHaveBeenCalled();
  });

  it('refuses the apply when karst.yml changed between the popup and the apply', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    let text = RETIRED;
    f.verify.deps.readCurrentText = () => text;
    f.confirm.mockImplementation(async () => {
      text = `${RETIRED}# edited\n`;
      return true;
    });
    await scanWith(f);
    expect(f.applyManifest).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
    expect(f.fs.results.at(-1)!.reason).toMatch(/changed after the host checks/);
    expect(f.records.at(-1)).toMatchObject({ status: 'refused' });
  });

  it('records unverified when the readiness item still fails after the apply', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    vi.mocked(f.verify.recheck).mockResolvedValue([{ id: 'manifest.retired-key.confirmGeneratedGraph', status: 'fail', detail: 'x' }]);
    await scanWith(f);
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'unverified' });
    expect(f.records.at(-1)).toMatchObject({ status: 'unverified' });
  });

  it('refuses a change when karst.yml changed between the popup and the run', async () => {
    const change = { kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' };
    const f = deps({ [A]: JSON.stringify(change) }, RETIRED);
    let text = RETIRED;
    f.verify.deps.readCurrentText = () => text;
    f.confirm.mockImplementation(async () => {
      text = 'host: other\n';
      return true;
    });
    await scanWith(f);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
  });

  it('still verifies when the host record write fails', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    f.verify.writeRecord = () => {
      throw new Error('disk');
    };
    await scanWith(f);
    expect(f.applyManifest).toHaveBeenCalledOnce();
  });
});

describe('createSetupProposalOps host verification messages and records', () => {
  const A = '/s/1/outbox/a.json';
  const RETIRED =
    `${VALID_YAML}approaches:\n  - id: g\n    label: G\n    graph:\n      limits:\n        confirmGeneratedGraph: true\n`;
  const FIXED = { ...manifestProposal(), yaml: `${VALID_YAML}approaches:\n  - id: g\n    label: G\n` };
  const FORGED = { ...FIXED, clears: ['manifest.legacy-services'] };
  const wire = (f: ReturnType<typeof deps>, logs: string[], over: Record<string, unknown> = {}) =>
    createSetupProposalOps({
      ...f.deps,
      debug: (m: string) => void logs.push(m),
      readCurrentManifest: () => parseManifestText(RETIRED).manifest,
      removedKeys: () => ['approaches[0].graph.limits.confirmGeneratedGraph'],
      ...over,
    });
  const warns = (f: ReturnType<typeof deps>): string[] => (f.deps.notify as unknown as { warn: ReturnType<typeof vi.fn> }).warn.mock.calls.map((c: unknown[]) => String(c[0]));

  it('names the failed step in the warning, the log, the ledger and the host record of a refused manifest', async () => {
    const f = deps({ [A]: JSON.stringify(FORGED) }, RETIRED);
    const logs: string[] = [];
    await wire(f, logs).scan();
    const reason = f.fs.results.at(-1)!.reason!;
    expect(reason).toMatch(/^P6 /);
    expect(warns(f)).toEqual([`Karst: the setup agent's manifest proposal failed the host checks (${reason}); ignored.`]);
    expect(logs).toContain(`[setup] refused manifest proposal ${A}: ${reason}`);
    expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'invalid', dropped: ['approaches'] });
    const rec = f.records.at(-1)!;
    expect(rec).toMatchObject({ id: 'a', kind: 'manifest', status: 'refused' });
    expect(rec.steps.some((s) => s.status === 'fail')).toBe(true);
    expect(rec.pinnedSha256).toHaveLength(64);
  });

  it('logs a failed host record write with the file and the cause', async () => {
    const f = deps({ [A]: JSON.stringify(FORGED) }, RETIRED);
    f.verify.writeRecord = () => {
      throw new Error('disk');
    };
    const logs: string[] = [];
    await wire(f, logs).scan();
    expect(logs).toContain(`[setup] could not write the verify record for ${A}: disk`);
    expect(f.fs.results.at(-1)).toMatchObject({ status: 'invalid' });
  });

  it('logs a failed ledger write with the status, the file and the cause', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    f.fs.writeResult = () => {
      throw new Error('ro');
    };
    const logs: string[] = [];
    await wire(f, logs).scan();
    expect(logs).toContain(`[setup] could not record verified result for ${A}: ro`);
    expect(f.applyManifest).toHaveBeenCalledOnce();
  });

  it('records a verified ledger entry without a reason, and the host record with the id, kind and steps', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    const logs: string[] = [];
    await wire(f, logs).scan();
    const ledger = f.fs.results.at(-1)!;
    expect(ledger).toMatchObject({ id: 'a', kind: 'manifest', status: 'verified', dropped: ['approaches'], sha256: 'sha-1' });
    expect(ledger).not.toHaveProperty('reason');
    expect(warns(f)).toEqual([]);
    expect(logs).toContain(`[setup] applied manifest proposal ${A}`);
    const rec = f.records.at(-1)!;
    expect(rec).toMatchObject({ id: 'a', kind: 'manifest', status: 'verified' });
    expect(rec.steps.map((s) => s.id)).toContain('A2');
    expect(rec.changes).toEqual([{ id: 'manifest.retired-key.confirmGeneratedGraph', kind: 'cleared' }]);
  });

  it('warns with the failed step and records the reason when the re-run leaves the item failing', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    vi.mocked(f.verify.recheck).mockResolvedValue([{ id: 'manifest.retired-key.confirmGeneratedGraph', status: 'fail', detail: 'x' }]);
    await wire(f, []).scan();
    const reason = f.fs.results.at(-1)!.reason!;
    expect(reason).toMatch(/^A2 /);
    expect(warns(f)).toEqual([`Karst: the setup proposal was applied but did not verify (${reason}).`]);
    expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'unverified' });
    expect(f.fs.results.at(-1)).toMatchObject({ sha256: 'sha-1', dropped: ['approaches'] });
  });

  it('records the exact reason and message for a manifest that equals the current one', async () => {
    const f = deps({ [A]: JSON.stringify(manifestProposal()) });
    const logs: string[] = [];
    await wire(f, logs, { readCurrentManifest: () => parseManifestText(VALID_YAML).manifest, removedKeys: () => [] }).scan();
    expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'no-change', reason: 'no effective change', dropped: [] });
    expect(warns(f)).toEqual(['Karst: the setup proposal changes nothing (no effective change).']);
    expect(logs).toContain(`[setup] manifest proposal ${A} has no effective change`);
  });

  it('names the dropped protected fields in the no-change reason', async () => {
    const protectedOnly = { ...manifestProposal(), yaml: `${VALID_YAML}archiveDoneAfterDays: 9\n` };
    const f = deps({ [A]: JSON.stringify(protectedOnly) });
    await wire(f, [], { readCurrentManifest: () => parseManifestText(`${VALID_YAML}archiveDoneAfterDays: 3\n`).manifest, removedKeys: () => [] }).scan();
    expect(f.fs.results.at(-1)!.reason).toBe(
      'no effective change; protected fields not applied: archiveDoneAfterDays. The user changes them in Settings.',
    );
    expect(f.fs.results.at(-1)).toMatchObject({ dropped: ['archiveDoneAfterDays'] });
  });

  it('refuses the apply when the dropped protected fields differ from what the popup showed', async () => {
    const proposal = { ...manifestProposal(), yaml: `${VALID_YAML}archiveDoneAfterDays: 9\nsettleTimeoutSeconds: 5\n` };
    const f = deps({ [A]: JSON.stringify(proposal) }, `${VALID_YAML}archiveDoneAfterDays: 3\n`);
    const first = parseManifestText(`${VALID_YAML}archiveDoneAfterDays: 3\n`).manifest;
    const second = parseManifestText(`${VALID_YAML}archiveDoneAfterDays: 9\n`).manifest;
    let calls = 0;
    await wire(f, [], { readCurrentManifest: () => (calls++ === 0 ? first : second), removedKeys: () => [] }).scan();
    if (f.confirm.mock.calls.length > 0) {
      expect(f.applyManifest).not.toHaveBeenCalled();
      expect(f.fs.results.at(-1)!.reason).toMatch(/protected fields differ/);
    }
  });

  it('does not record withdrawn for a superseded manifest and logs the withdrawal', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    const logs: string[] = [];
    f.confirm.mockImplementation(async () => {
      f.fs.remove(A);
      return true;
    });
    await wire(f, logs).scan();
    expect(logs).toContain(`[setup] manifest proposal ${A} was withdrawn while its consent was open`);
    expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'withdrawn', reason: 'withdrawn while awaiting consent' });
    expect(f.applyManifest).not.toHaveBeenCalled();
  });

  it('records the decline of a manifest with its reason and dropped list', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    f.confirm.mockResolvedValue(false);
    await wire(f, []).scan();
    expect(f.fs.results.at(-1)).toEqual(
      expect.objectContaining({ id: 'a', kind: 'manifest', status: 'declined', reason: 'declined by the user', dropped: ['approaches'] }),
    );
  });

  it('records the exact reason of a failed manifest apply and the refused host record', async () => {
    const f = deps({ [A]: JSON.stringify(FIXED) }, RETIRED);
    f.applyManifest.mockImplementation(() => {
      throw new Error('disk full');
    });
    await wire(f, []).scan();
    expect(warns(f)).toEqual(['Karst: could not apply the manifest proposal (disk full).']);
    expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'invalid', reason: 'apply failed: disk full', dropped: ['approaches'] });
    expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'manifest', status: 'refused' });
    expect(f.fs.removed).toEqual([A]);
  });

  describe('change proposals', () => {
    const command = { kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' };
    const patch = { kind: 'change', repo: 'web', reason: 'r', patch: '+++ b/.env\n' };

    it('names the failed step when the checklist refuses a change', async () => {
      const f = deps({ [A]: JSON.stringify(command) }, undefined);
      f.verify.deps.readCurrentText = () => undefined;
      const f2 = deps({ [A]: JSON.stringify(patch) }, BASE_YAML);
      f2.verify.deps.gitApplyCheck = async () => ({ ok: false, error: 'does not apply' });
      await wire(f2, [], { readCurrentManifest: () => undefined, removedKeys: undefined }).scan();
      const reason = f2.fs.results.at(-1)!.reason!;
      expect(reason).toMatch(/^P3 /);
      expect(warns(f2)).toEqual([`Karst: refused the change for "web" (${reason}).`]);
      expect(f2.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'invalid' });
      expect(f2.records.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'refused' });
      expect(f2.fs.removed).toEqual([A]);
      expect(f2.confirm).not.toHaveBeenCalled();
      expect(f).toBeDefined();
    });

    it('records the withdrawal and the decline of a change with exact reasons', async () => {
      const gone = deps({ [A]: JSON.stringify(command) }, BASE_YAML);
      gone.confirm.mockImplementation(async () => {
        gone.fs.remove(A);
        return true;
      });
      await wire(gone, []).scan();
      expect(gone.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'withdrawn', reason: 'withdrawn while awaiting consent' });
      const no = deps({ [A]: JSON.stringify(command) }, BASE_YAML);
      no.confirm.mockResolvedValue(false);
      const logs: string[] = [];
      await wire(no, logs).scan();
      expect(logs).toContain(`[setup] user declined change proposal ${A}`);
      expect(no.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'declined', reason: 'declined by the user' });
    });

    it('refuses with the exact reason when karst.yml moved between the popup and the run', async () => {
      const f = deps({ [A]: JSON.stringify(command) }, BASE_YAML);
      let text = BASE_YAML;
      f.verify.deps.readCurrentText = () => text;
      f.confirm.mockImplementation(async () => {
        text = 'host: other\n';
        return true;
      });
      await wire(f, []).scan();
      const reason = 'karst.yml changed after the host checks ran; propose again';
      expect(warns(f)).toEqual([`Karst: could not apply the change for "web" (${reason}).`]);
      expect(f.fs.results.at(-1)).toMatchObject({ kind: 'change', status: 'invalid', reason: `apply failed: ${reason}` });
      expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'refused' });
      expect(f.fs.removed).toEqual([A]);
      expect(f.runCommand).not.toHaveBeenCalled();
    });

    it('records a failed command as invalid and unverified, with the exact messages', async () => {
      const f = deps({ [A]: JSON.stringify(command) }, BASE_YAML);
      f.runCommand.mockRejectedValue(new Error('boom'));
      const logs: string[] = [];
      await wire(f, logs).scan();
      expect(warns(f)[0]).toBe('Karst: could not apply the change for "web" (boom).');
      expect(f.fs.results.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'invalid', reason: 'apply failed: boom' });
      expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'unverified' });
      expect(logs.some((m) => m.startsWith('applied change proposal'))).toBe(false);
    });

    it('logs an applied change and records verified with no reason', async () => {
      const f = deps({ [A]: JSON.stringify(command) }, BASE_YAML);
      const logs: string[] = [];
      await wire(f, logs).scan();
      expect(logs).toContain(`[setup] applied change proposal ${A}`);
      expect(warns(f)).toEqual([]);
      expect(f.fs.results.at(-1)).not.toHaveProperty('reason');
      expect(f.records.at(-1)).toMatchObject({ id: 'a', kind: 'change', status: 'verified' });
    });

    it('applies a patch through applyPatch only and never runs a command', async () => {
      const f = deps({ [A]: JSON.stringify(patch) }, BASE_YAML);
      await wire(f, []).scan();
      expect(f.applyPatch).toHaveBeenCalledOnce();
      expect(f.runCommand).not.toHaveBeenCalled();
    });
  });
});
