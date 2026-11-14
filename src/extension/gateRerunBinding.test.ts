import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createTicketFlow } from '../workflow/stages/create.js';
import { manifest, repo, uat } from '../manifest/fixtures.js';
import { openStore } from '../store/db.js';
import type { GateProcessRunner } from '../workflow/gates/run.js';
import { bindGateRerunDeps, type GateRerunHost } from './gateRerunBinding.js';

const host = (over: Partial<GateRerunHost> = {}): GateRerunHost => ({
  store: openStore(':memory:'),
  manifest: () => undefined,
  runProcess: vi.fn() as unknown as GateProcessRunner,
  gateProcessFor: () => undefined,
  hostGateFor: () => undefined,
  onGateOutput: vi.fn(),
  onGateSpawned: vi.fn(),
  debug: vi.fn(),
  ...over,
});

describe('bindGateRerunDeps', () => {
  it('runs a host ticket on the host runner and a sandboxed ticket on its own runner', () => {
    const sandbox = vi.fn() as unknown as GateProcessRunner;
    const h = host({ gateProcessFor: (id) => (id === 2 ? sandbox : undefined) });
    const deps = bindGateRerunDeps(h);
    expect(deps.runnerFor(1)).toBe(h.runProcess);
    expect(deps.runnerFor(2)).toBe(sandbox);
    expect(deps.sandboxedFor?.(1)).toBe(false);
    expect(deps.sandboxedFor?.(2)).toBe(true);
  });

  it('takes a fresh host runner for a sandbox: host gate', () => {
    const fresh = vi.fn() as unknown as GateProcessRunner;
    const deps = bindGateRerunDeps(host({ hostGateFor: () => () => fresh }));
    expect(deps.hostGateFor?.(1)).toBe(fresh);
    expect(bindGateRerunDeps(host()).hostGateFor?.(1)).toBeUndefined();
  });

  it('has no base ref, no repo names and no regenerate spec without a manifest', () => {
    const deps = bindGateRerunDeps(host());
    expect(deps.baseRefFor?.(1, '/repo/web')).toBeUndefined();
    expect(deps.regenerateFor?.('web')).toBeUndefined();
  });

  it('forwards the live log and pid callbacks', () => {
    const h = host();
    const deps = bindGateRerunDeps(h);
    expect(deps.onGateOutput).toBe(h.onGateOutput);
    expect(deps.onGateSpawned).toBe(h.onGateSpawned);
  });

  const withManifest = () =>
    manifest(
      { web: repo({ repoPath: '/repo/web', ship: { regenerate: ['npm run gen'], exclude: ['dist'] } } as never) },
      { uat: uat({ probeWhenAllDisabled: true }), review: { gates: [{ name: 'lint', command: 'npm', args: ['run', 'lint'] }], repositories: {} } as never },
    );

  it('reads the regenerate spec of a repo key from the manifest', () => {
    const deps = bindGateRerunDeps(host({ manifest: withManifest }));
    expect(deps.regenerateFor?.('web')).toEqual({ repo: 'web', commands: ['npm run gen'], exclude: ['dist'] });
    expect(deps.regenerateFor?.('other')).toBeUndefined();
  });

  it('reads the stored base ref of a repo path, with a manifest', () => {
    const h = host({ manifest: withManifest });
    const id = createTicketFlow(h.store, { key: 'T-1', title: 't' }).id;
    h.store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)').run(id, '/repo/web', '/wt/web', 'b', 'origin/feat');
    expect(bindGateRerunDeps(h).baseRefFor?.(id, '/repo/web')).toBe('origin/feat');
  });

  it('resolves the gates of UAT and of review from the manifest, with the host debug', () => {
    const h = host({ manifest: withManifest });
    const id = createTicketFlow(h.store, { key: 'T-1', title: 't' }).id;
    const wt = mkdtempSync(join(tmpdir(), 'karst-bind-wt-'));
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint' } }));
    const deps = bindGateRerunDeps(h);
    expect(deps.gatesFor?.(id, '/repo/web', wt, 'uat')?.map((g) => g.name)).toEqual(['test']);
    expect(deps.gatesFor?.(id, '/repo/web', wt, 'review')?.map((g) => g.name)).toEqual(['lint']);
    expect(deps.debug).toBe(h.debug);
  });

  it('has no gates without a manifest, and borrows the host runner for a host gate', () => {
    const h = host();
    const id = createTicketFlow(h.store, { key: 'T-1', title: 't' }).id;
    const deps = bindGateRerunDeps(h);
    expect(deps.hostRunner).toBe(h.runProcess);
    expect(deps.store).toBe(h.store);
    expect(deps.gatesFor?.(id, '/repo/web', mkdtempSync(join(tmpdir(), 'karst-bind-none-')), 'uat')).toBeUndefined();
  });
});
