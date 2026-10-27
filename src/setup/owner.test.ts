import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupProposalOps } from '../extension/ops/setupProposalOps.js';
import { ownedScratches, readSetupOwner, writeSetupOwner } from './owner.js';

const PROPOSAL = JSON.stringify({ kind: 'change', repo: 'web', command: 'echo hi', reason: 'r' });

describe('setup scratch ownership', () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'karst-owner-'))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function scratchWithProposal(id: string, ws: string | undefined): string {
    const scratch = join(root, id);
    mkdirSync(join(scratch, 'outbox'), { recursive: true });
    if (ws) writeSetupOwner(scratch, { workspaceRoot: ws, manifestPath: `${ws}/karst.yml` });
    writeFileSync(join(scratch, 'outbox', 'p.json'), PROPOSAL);
    return join(scratch, 'outbox', 'p.json');
  }

  function windowFor(ws: string) {
    const confirm = vi.fn(async () => false);
    const debug = vi.fn();
    const ops = createSetupProposalOps({
      resolveDir: (c: { repo: string; path?: string }) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` }),
      outboxes: () => ownedScratches(root, ws, debug),
      readCurrentManifest: () => undefined,
      confirm,
      applyManifest: vi.fn(),
      runCommand: vi.fn(),
      applyPatch: vi.fn(),
      notify: { warn: vi.fn(), info: vi.fn() } as never,
    });
    return { ops, confirm, debug };
  }

  it('round-trips the owner marker', () => {
    writeSetupOwner(join(root, 'x'), { workspaceRoot: '/ws', manifestPath: '/ws/k.yml' });
    expect(readSetupOwner(join(root, 'x'))).toEqual({ workspaceRoot: '/ws', manifestPath: '/ws/k.yml' });
  });

  it('only the owning window confirms; the other never reads or removes the file', async () => {
    const file = scratchWithProposal('a1', '/ws/a');
    const a = windowFor('/ws/a');
    const b = windowFor('/ws/b');
    await b.ops.scan();
    expect(b.confirm).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    await a.ops.scan();
    expect(a.confirm).toHaveBeenCalledOnce();
  });

  it('normalizes the workspace path compare', () => {
    scratchWithProposal('a1', '/ws/a/');
    expect(ownedScratches(root, '/ws/a')).toHaveLength(1);
  });

  it('ignores a legacy scratch without a marker and logs it', async () => {
    const file = scratchWithProposal('old', undefined);
    const a = windowFor('/ws/a');
    await a.ops.scan();
    expect(a.confirm).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    expect(a.debug).toHaveBeenCalledWith(expect.stringContaining('[setup] skipped scratch old'));
  });
});
