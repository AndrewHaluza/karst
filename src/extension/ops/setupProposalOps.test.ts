import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupProposalOps, defaultSetupProposalFs, type SetupProposalFs } from './setupProposalOps.js';
import { MAX_SETUP_PROPOSAL_BYTES, type ManifestProposal, type ChangeProposal } from '../../setup/proposal.js';

const VALID_YAML = `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: main\nrepositories:\n  web:\n    repoPath: ../web\n`;

function fakeFs(files: Record<string, string>): SetupProposalFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
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

function deps(files: Record<string, string>) {
  const fs = fakeFs(files);
  const applyManifest = vi.fn();
  const runCommand = vi.fn(async () => {});
  const applyPatch = vi.fn(async () => {});
  const confirm = vi.fn(async () => true);
  return {
    fs,
    applyManifest,
    runCommand,
    applyPatch,
    confirm,
    deps: {
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
    const [proposal, proposed] = f.applyManifest.mock.calls[0]!;
    expect((proposal as ManifestProposal).kind).toBe('manifest');
    expect(Object.keys((proposed as { repositories: object }).repositories)).toEqual(['web']);
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
    const f = deps({ '/s/1/outbox/a.json': JSON.stringify(command), '/s/1/outbox/b.json': JSON.stringify(patch) });
    await createSetupProposalOps(f.deps).scan();
    expect(f.runCommand).toHaveBeenCalledWith('web', 'npm ci');
    expect(f.applyPatch).toHaveBeenCalledWith('api', '+++ b/.env\n');
    expect(f.fs.removed.sort()).toEqual(['/s/1/outbox/a.json', '/s/1/outbox/b.json']);
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

describe('createSetupProposalOps with the real fs (defaultFs coverage)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-setup-outbox-'));
    mkdirSync(join(root, 'outbox'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function realDeps(confirm = true) {
    return {
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
    expect(readdirSync(join(root, 'outbox'))).toEqual([]);
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
    expect(confirm).toHaveBeenCalledOnce();
    release(true);
    await Promise.all([first, second]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(applyManifest).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'outbox'))).toEqual([]);
  });

  it('drops an oversize proposal without parsing or prompting', async () => {
    writeFileSync(join(root, 'outbox', 'big.json'), 'x'.repeat(MAX_SETUP_PROPOSAL_BYTES + 1));
    const d = realDeps();
    await createSetupProposalOps(d).scan();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'outbox'))).toEqual([]);
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
    };
    return {
      removed,
      deps: {
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
    expect(d.runCommand).toHaveBeenCalledWith('web', 'npm ci');
    expect(d.applyPatch).toHaveBeenCalledWith('api', '+++ b/.env\n');
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
