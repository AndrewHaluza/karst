import { describe, expect, it } from 'vitest';
import type { RunningServerRow, TicketLifecycle } from '../store/runningServers.js';
import type { TreeCost } from './procTreeCost.js';
import type { AttributedRow, Inventory, UnattributedRow } from './resourceInventory.js';
import { describeWaste, findWaste, type DirectoryProbe } from './wasteFindings.js';

function cost(rssBytes: number): TreeCost {
  return { pid: 0, rssBytes, cpuPct: null, procCount: 1, startedMs: null };
}

function attr(row: Partial<AttributedRow>): AttributedRow {
  return {
    pid: 100,
    kind: 'server',
    ticketId: 7,
    label: 'web',
    serverId: 1,
    attribution: 'attributable',
    cost: cost(1_000),
    cwd: '/wt/abc',
    comm: 'p100',
    ...row,
  };
}

function unattributed(row: Partial<UnattributedRow>): UnattributedRow {
  return {
    pid: 300,
    comm: 'node',
    cost: cost(500),
    cwd: '/wt/orphan',
    cwdDeleted: false,
    ...row,
  };
}

function inv(attributed: AttributedRow[], unattributedRows: UnattributedRow[]): Inventory {
  return {
    takenMs: 0,
    attributed,
    unattributed: unattributedRows,
    totals: { rssBytes: 0, cpuPct: null },
  };
}

function server(row: Partial<RunningServerRow>): RunningServerRow {
  return {
    id: 1,
    ticketId: 7,
    repo: 'web',
    pid: 100,
    cwd: '/wt/abc',
    startedAt: '2026-08-12T10:00:00.000Z',
    host: 'localhost',
    port: 5173,
    ...row,
  };
}

function lifecycle(overrides: Partial<TicketLifecycle>): TicketLifecycle {
  return { id: 7, key: 'A', title: 'a', stageCurrent: 'impl', archived: false, ...overrides };
}

function dirs(existing: string[]): DirectoryProbe {
  const set = new Set(existing);
  return { exists: (p) => set.has(p) };
}

describe('findWaste — worktree-gone', () => {
  it('flags a deleted worktree with a surviving parent, killable', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('worktree-gone');
    expect(findings[0]!.killable).toBe(true);
    expect(findings[0]!.serverId).toBe(1);
    expect(findings[0]!.reason).toContain('web server still running in a worktree that no longer exists');
  });

  it('yields NOTHING when the parent is also gone (unmounted volume regression)', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs([]),
    });
    expect(findings).toHaveLength(0);
  });

  it('never flags a baseline server (ticket_id NULL)', () => {
    const findings = findWaste({
      inventory: inv([attr({ ticketId: null })], []),
      servers: [server({ ticketId: null, pid: 100 })],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(0);
  });

  it('never flags a foreign attribution', () => {
    const findings = findWaste({
      inventory: inv([attr({ attribution: 'foreign' })], []),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(0);
  });
});

describe('findWaste — ticket-finished', () => {
  it('flags a server of a done ticket, killable', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map([[7, lifecycle({ stageCurrent: 'done' })]]),
      worktreeRoots: [],
      dirs: dirs(['/wt', '/wt/abc']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('ticket-finished');
    expect(findings[0]!.killable).toBe(true);
    expect(findings[0]!.reason).toContain('a completed ticket A');
  });

  it('flags a server of an archived ticket', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map([[7, lifecycle({ stageCurrent: 'impl', archived: true })]]),
      worktreeRoots: [],
      dirs: dirs(['/wt', '/wt/abc']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('ticket-finished');
    expect(findings[0]!.reason).toContain('an archived ticket A');
  });

  it('does not flag a ticket with no lifecycle entry (unknown is not finished)', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs(['/wt', '/wt/abc']),
    });
    expect(findings).toHaveLength(0);
  });
});

describe('findWaste — orphan-worktree-process', () => {
  it('flags an unattributed process under a worktree root with a confirmed cwd, not killable', () => {
    const findings = findWaste({
      inventory: inv([], [unattributed({ pid: 300, cwd: '/wt/orphan' })]),
      servers: [],
      lifecycle: new Map(),
      worktreeRoots: ['/wt'],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('orphan-worktree-process');
    expect(findings[0]!.killable).toBe(false);
    expect(findings[0]!.serverId).toBeNull();
    expect(findings[0]!.reason).toContain('unattributed node (pid 300)');
  });

  it('produces nothing for an unattributed process whose cwd was never confirmed', () => {
    const findings = findWaste({
      inventory: inv([], [unattributed({ cwd: null })]),
      servers: [],
      lifecycle: new Map(),
      worktreeRoots: ['/wt'],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(0);
  });

  it('does not report a sibling path under a shorter root (…/abc-2 vs …/abc)', () => {
    const findings = findWaste({
      inventory: inv([], [unattributed({ pid: 300, cwd: '/wt/abc-2/orphan' })]),
      servers: [],
      lifecycle: new Map(),
      worktreeRoots: ['/wt/abc'],
      dirs: dirs(['/wt/abc', '/wt/abc-2']),
    });
    expect(findings).toHaveLength(0);
  });

  it('skips an unattributed process whose pid matches a running server', () => {
    const findings = findWaste({
      inventory: inv([], [unattributed({ pid: 100, cwd: '/wt/orphan' })]),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: ['/wt'],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(0);
  });
});

describe('findWaste — precedence and shape', () => {
  it('produces exactly one finding for a pid qualifying for two kinds (worktree-gone wins)', () => {
    const findings = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map([[7, lifecycle({ stageCurrent: 'done' })]]),
      worktreeRoots: [],
      dirs: dirs(['/wt']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('worktree-gone');
  });

  it('a pid may never produce more than one finding across the whole rule', () => {
    const findings = findWaste({
      inventory: inv(
        [attr({})],
        [unattributed({ pid: 300, cwd: '/wt/orphan' })],
      ),
      servers: [server({})],
      lifecycle: new Map([[7, lifecycle({ stageCurrent: 'done' })]]),
      worktreeRoots: ['/wt'],
      dirs: dirs(['/wt', '/wt/abc']),
    });
    const pids = findings.map((f) => f.pid);
    expect(new Set(pids).size).toBe(pids.length);
    expect(findings).toHaveLength(2);
  });
});

describe('describeWaste', () => {
  it('renders reason with a byte-formatted size', () => {
    const f = findWaste({
      inventory: inv([attr({})], []),
      servers: [server({})],
      lifecycle: new Map(),
      worktreeRoots: [],
      dirs: dirs(['/wt']),
    })[0]!;
    const text = describeWaste(f);
    expect(text).toContain('1.0 KB');
  });
});
