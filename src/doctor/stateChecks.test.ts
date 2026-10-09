import { describe, it, expect, vi } from 'vitest';
import { checkState, type StateProbes } from './stateChecks.js';
import type { DoctorCheck } from './types.js';

const STARTED_AT = '2026-10-09 12:00:00';
const STARTED_MS = Date.parse('2026-10-09T12:00:00Z');

function probes(over: Partial<StateProbes> = {}): StateProbes {
  return {
    worktrees: [],
    servers: [],
    pathExists: () => true,
    branchExists: () => true,
    unrecordedWorktreeDirs: [],
    pidAlive: () => false,
    pidStartedAtMs: () => undefined,
    worktreeState: () => 'clean',
    dbSchemaVersion: 80,
    extensionSchemaVersion: 80,
    walBytes: 0,
    walLimitBytes: 100,
    staleOutboxFiles: [],
    ...over,
  };
}

function wt(over: Partial<StateProbes['worktrees'][number]> = {}): StateProbes['worktrees'][number] {
  return {
    ticketId: 1,
    ticketKey: 'PROJ-1',
    ticketStage: 'impl',
    repo: 'api',
    path: '/wt/api',
    branch: 'karst/proj-1',
    ...over,
  };
}

function srv(over: Partial<StateProbes['servers'][number]> = {}): StateProbes['servers'][number] {
  return {
    id: 7,
    ticketId: 1,
    ticketStage: 'done',
    repo: 'api',
    port: 3000,
    pid: 4242,
    status: 'running',
    startedAt: STARTED_AT,
    kind: 'service',
    ...over,
  };
}

function byId(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((c) => c.id === id);
}

function idsStartingWith(checks: DoctorCheck[], prefix: string): string[] {
  return checks.map((c) => c.id).filter((id) => id.startsWith(prefix));
}

describe('checkState: healthy baseline', () => {
  it('emits only ok summaries and passing schema/wal checks when nothing is found', () => {
    const checks = checkState(probes());
    expect(byId(checks, 'state.worktrees')?.status).toBe('ok');
    expect(byId(checks, 'state.servers')?.status).toBe('ok');
    expect(byId(checks, 'state.schema')?.status).toBe('ok');
    expect(byId(checks, 'state.wal')?.status).toBe('ok');
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
  });

  it('tags every check with area state and a state. id', () => {
    const checks = checkState(
      probes({
        worktrees: [wt({ path: '/gone' })],
        servers: [srv({ pid: null })],
        staleOutboxFiles: ['/o/a.json'],
        dbSchemaVersion: 1,
        extensionSchemaVersion: 2,
      }),
    );
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(c.area).toBe('state');
      expect(c.id.startsWith('state.')).toBe(true);
    }
  });

  it('does not emit the ok summaries when findings exist', () => {
    const checks = checkState(probes({ worktrees: [wt({ path: '/gone' })], pathExists: () => false }));
    expect(idsStartingWith(checks, 'state.worktree-missing').length).toBeGreaterThan(0);
    expect(byId(checks, 'state.worktrees')).toBeUndefined();
  });
});

describe('checkState: worktree rows', () => {
  it('warns with a report fix when the recorded path is missing', () => {
    const checks = checkState(probes({ worktrees: [wt({ path: '/gone' })], pathExists: () => false }));
    const c = byId(checks, 'state.worktree-missing.PROJ-1.api');
    expect(c?.status).toBe('warn');
    expect(c?.fix?.tier).toBe('report');
    if (c?.fix?.tier === 'report') {
      expect(c.fix.nextStep).toMatch(/re-cut|archive/i);
    }
  });

  it('does not check the branch when the path is already missing', () => {
    const branchExists = vi.fn(() => false);
    checkState(probes({ worktrees: [wt()], pathExists: () => false, branchExists }));
    expect(branchExists).not.toHaveBeenCalled();
  });

  it('warns with a report fix when a recorded branch is absent', () => {
    const checks = checkState(probes({ worktrees: [wt()], branchExists: () => false }));
    const c = byId(checks, 'state.worktree-branch-missing.PROJ-1.api');
    expect(c?.status).toBe('warn');
    expect(c?.fix?.tier).toBe('report');
  });

  it('skips the branch check when the recorded branch is null', () => {
    const branchExists = vi.fn(() => false);
    const checks = checkState(probes({ worktrees: [wt({ branch: null })], branchExists }));
    expect(branchExists).not.toHaveBeenCalled();
    expect(idsStartingWith(checks, 'state.worktree-branch-missing')).toEqual([]);
  });

  it('warns for each unrecorded worktree directory', () => {
    const checks = checkState(probes({ unrecordedWorktreeDirs: ['/wt/x', '/wt/y'] }));
    const first = byId(checks, 'state.worktree-unrecorded.0');
    const second = byId(checks, 'state.worktree-unrecorded.1');
    expect(first?.status).toBe('warn');
    expect(first?.fix?.tier).toBe('report');
    expect(first?.detail).toContain('/wt/x');
    expect(second?.detail).toContain('/wt/y');
  });

  it('emits no unrecorded checks when the list is empty', () => {
    const checks = checkState(probes());
    expect(idsStartingWith(checks, 'state.worktree-unrecorded')).toEqual([]);
  });
});

describe('checkState: worktree prune', () => {
  it('auto-prunes a done ticket whose worktree is clean', () => {
    const checks = checkState(
      probes({ worktrees: [wt({ ticketStage: 'done', path: '/wt/api', branch: 'karst/proj-1' })] }),
    );
    const c = byId(checks, 'state.worktree-prune.PROJ-1.api');
    expect(c?.status).toBe('warn');
    expect(c?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: {
        kind: 'prune-worktree',
        ticketId: 1,
        repo: 'api',
        path: '/wt/api',
        branch: 'karst/proj-1',
      },
    });
  });

  it('never auto-prunes a dirty worktree; reports instead', () => {
    const checks = checkState(
      probes({ worktrees: [wt({ ticketStage: 'done' })], worktreeState: () => 'dirty' }),
    );
    const c = byId(checks, 'state.worktree-prune.PROJ-1.api');
    expect(c?.status).toBe('warn');
    expect(c?.fix?.tier).toBe('report');
  });

  it('never auto-prunes an unknown-state worktree; reports instead', () => {
    const checks = checkState(
      probes({ worktrees: [wt({ ticketStage: 'done' })], worktreeState: () => 'unknown' }),
    );
    const c = byId(checks, 'state.worktree-prune.PROJ-1.api');
    expect(c?.fix?.tier).toBe('report');
  });

  it('emits no prune check for a ticket that is not done', () => {
    const worktreeState = vi.fn(() => 'clean' as const);
    const checks = checkState(
      probes({ worktrees: [wt({ ticketStage: 'impl' }), wt({ ticketStage: null, repo: 'web', path: '/wt/web' })], worktreeState }),
    );
    expect(idsStartingWith(checks, 'state.worktree-prune')).toEqual([]);
    expect(worktreeState).not.toHaveBeenCalled();
  });

  it('emits no prune check for a done ticket whose path is missing', () => {
    const checks = checkState(
      probes({ worktrees: [wt({ ticketStage: 'done' })], pathExists: () => false }),
    );
    expect(idsStartingWith(checks, 'state.worktree-prune')).toEqual([]);
    expect(byId(checks, 'state.worktree-missing.PROJ-1.api')).toBeDefined();
  });
});

describe('checkState: server dead', () => {
  it('auto-marks a running server stopped when its pid is null', () => {
    const checks = checkState(probes({ servers: [srv({ pid: null })] }));
    const c = byId(checks, 'state.server-dead.7');
    expect(c?.status).toBe('warn');
    expect(c?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'mark-server-stopped', serverId: 7, pid: null },
    });
  });

  it('auto-marks a running server stopped when its pid is not alive', () => {
    const checks = checkState(probes({ servers: [srv({ ticketStage: 'impl' })], pidAlive: () => false }));
    const c = byId(checks, 'state.server-dead.7');
    expect(c?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'mark-server-stopped', serverId: 7, pid: 4242 },
    });
  });

  it('applies the dead check to servers with no ticket', () => {
    const checks = checkState(probes({ servers: [srv({ ticketId: null, ticketStage: null, pid: null })] }));
    expect(byId(checks, 'state.server-dead.7')?.fix?.tier).toBe('auto');
  });

  it('ignores servers that are not running', () => {
    const checks = checkState(probes({ servers: [srv({ status: 'stopped', pid: null })] }));
    expect(idsStartingWith(checks, 'state.server-')).toEqual([]);
    expect(byId(checks, 'state.servers')?.status).toBe('ok');
  });
});

describe('checkState: server leaked', () => {
  it('auto-kills a live pid whose start time matches the server record', () => {
    const checks = checkState(
      probes({
        servers: [srv()],
        pidAlive: () => true,
        pidStartedAtMs: () => STARTED_MS + 1000,
      }),
    );
    const c = byId(checks, 'state.server-leaked.7');
    expect(c?.status).toBe('warn');
    expect(c?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'kill-process', serverId: 7, pid: 4242, startedAt: STARTED_AT },
    });
  });

  it('accepts a process started exactly 5000ms after the record', () => {
    const checks = checkState(
      probes({ servers: [srv()], pidAlive: () => true, pidStartedAtMs: () => STARTED_MS + 5000 }),
    );
    expect(byId(checks, 'state.server-leaked.7')?.fix?.tier).toBe('auto');
  });

  it('never auto-kills a reused pid started well after the record', () => {
    const checks = checkState(
      probes({ servers: [srv()], pidAlive: () => true, pidStartedAtMs: () => STARTED_MS + 60_000 }),
    );
    const c = byId(checks, 'state.server-leaked.7');
    expect(c?.status).toBe('warn');
    expect(c?.fix?.tier).toBe('report');
  });

  it('never auto-kills when the process start time is unknown', () => {
    const checks = checkState(
      probes({ servers: [srv()], pidAlive: () => true, pidStartedAtMs: () => undefined }),
    );
    expect(byId(checks, 'state.server-leaked.7')?.fix?.tier).toBe('report');
  });

  it('never auto-kills when the recorded startedAt cannot be parsed', () => {
    const checks = checkState(
      probes({
        servers: [srv({ startedAt: 'not-a-date' })],
        pidAlive: () => true,
        pidStartedAtMs: () => STARTED_MS,
      }),
    );
    expect(byId(checks, 'state.server-leaked.7')?.fix?.tier).toBe('report');
  });

  it('accepts an ISO startedAt that already carries a zone', () => {
    const checks = checkState(
      probes({
        servers: [srv({ startedAt: '2026-10-09T12:00:00Z' })],
        pidAlive: () => true,
        pidStartedAtMs: () => STARTED_MS,
      }),
    );
    expect(byId(checks, 'state.server-leaked.7')?.fix?.tier).toBe('auto');
  });

  it('ignores live servers with no ticket', () => {
    const pidStartedAtMs = vi.fn(() => STARTED_MS);
    const checks = checkState(
      probes({ servers: [srv({ ticketId: null, ticketStage: null })], pidAlive: () => true, pidStartedAtMs }),
    );
    expect(idsStartingWith(checks, 'state.server-leaked')).toEqual([]);
    expect(pidStartedAtMs).not.toHaveBeenCalled();
  });

  it('ignores live servers whose ticket is not done', () => {
    const checks = checkState(
      probes({
        servers: [srv({ ticketStage: 'impl' })],
        pidAlive: () => true,
        pidStartedAtMs: () => STARTED_MS,
      }),
    );
    expect(idsStartingWith(checks, 'state.server-leaked')).toEqual([]);
  });
});

describe('checkState: schema and wal', () => {
  it('fails with a report fix when the database schema differs from the extension', () => {
    const checks = checkState(probes({ dbSchemaVersion: 81, extensionSchemaVersion: 80 }));
    const c = byId(checks, 'state.schema');
    expect(c?.status).toBe('fail');
    expect(c?.fix?.tier).toBe('report');
  });

  it('is ok when schema versions match', () => {
    expect(byId(checkState(probes()), 'state.schema')?.status).toBe('ok');
  });

  it('warns with a report fix when the WAL exceeds its limit', () => {
    const checks = checkState(probes({ walBytes: 101, walLimitBytes: 100 }));
    const c = byId(checks, 'state.wal');
    expect(c?.status).toBe('warn');
    expect(c?.fix?.tier).toBe('report');
    if (c?.fix?.tier === 'report') {
      expect(c.fix.nextStep).toMatch(/closing all karst windows/i);
    }
  });

  it('is ok when the WAL is at or below its limit', () => {
    expect(byId(checkState(probes({ walBytes: 100, walLimitBytes: 100 })), 'state.wal')?.status).toBe('ok');
  });
});

describe('checkState: outbox', () => {
  it('auto-quarantines each stale outbox file', () => {
    const checks = checkState(probes({ staleOutboxFiles: ['/o/a.json', '/o/b.json'] }));
    const first = byId(checks, 'state.outbox.0');
    const second = byId(checks, 'state.outbox.1');
    expect(first?.status).toBe('warn');
    expect(first?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'quarantine-outbox', path: '/o/a.json' },
    });
    expect(second?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'quarantine-outbox', path: '/o/b.json' },
    });
  });

  it('emits nothing when there are no stale outbox files', () => {
    expect(idsStartingWith(checkState(probes()), 'state.outbox')).toEqual([]);
  });
});
