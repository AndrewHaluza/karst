/**
 * Deterministic conflict rules and the scheduler admission (Slice 5 Task 3).
 *
 * The conflict decision is a PURE function over path claims plus the injected
 * physical-domain map — read/read may run together, write/write and write/read
 * overlap conflict, directory claims overlap descendants, repository-wide
 * claims overlap every path, and aliased repository entries (two names, one
 * worktree) resolve to one domain so they serialize. Trusted commands inherit
 * their access from the pinned allowlist, never planner prose. A
 * dependency-waiting node is NOT ready and is never reported as
 * resource-blocked. Ready ordering is created-at then token id, with bounded
 * aging so a wide-resource node cannot starve behind regenerated narrow loop
 * work.
 */

import { describe, it, expect } from 'vitest';
import {
  claimsConflict,
  activationDomainKeys,
  domainsConflict,
  schedulerReady,
  agingPriority,
  AGING_THRESHOLD_MS,
  type ConflictClaim,
  type SchedulerGroup,
  type SchedulerLease,
  type SchedulerState,
  type AllowlistCommandAccess,
} from './conflicts.js';

const claim = (repo: string, paths: readonly string[], mode: 'read' | 'write'): ConflictClaim => ({
  repo,
  paths,
  mode,
});

describe('claimsConflict — the conflict rule set', () => {
  it('read/read on the same path may run together', () => {
    expect(claimsConflict(claim('api', ['src/'], 'read'), claim('api', ['src/'], 'read'))).toBe(false);
  });

  it('write/write overlap conflicts', () => {
    expect(claimsConflict(claim('api', ['src/a.ts'], 'write'), claim('api', ['src/a.ts'], 'write'))).toBe(true);
  });

  it('write/read overlap conflicts', () => {
    expect(claimsConflict(claim('api', ['src/'], 'write'), claim('api', ['src/'], 'read'))).toBe(true);
  });

  it('write/write on disjoint paths does not conflict', () => {
    expect(claimsConflict(claim('api', ['src/a.ts'], 'write'), claim('api', ['lib/b.ts'], 'write'))).toBe(false);
  });

  it('directory claims overlap descendants', () => {
    expect(claimsConflict(claim('api', ['src/'], 'write'), claim('api', ['src/lib/x.ts'], 'read'))).toBe(true);
    expect(claimsConflict(claim('api', ['src/deep/nested/'], 'read'), claim('api', ['src/'], 'write'))).toBe(true);
  });

  it('a sibling directory does not overlap — the separator is load-bearing', () => {
    // `src` must not match `src-other`: only `src/` (a separator) is a parent.
    expect(claimsConflict(claim('api', ['src-other/'], 'write'), claim('api', ['src/'], 'read'))).toBe(false);
  });

  it('repository-wide claims (empty path list) overlap every path in that repository', () => {
    expect(claimsConflict(claim('api', [], 'write'), claim('api', ['anything/deep.txt'], 'read'))).toBe(true);
    expect(claimsConflict(claim('api', ['x'], 'write'), claim('api', [], 'read'))).toBe(true);
  });

  it('different repositories never conflict', () => {
    expect(claimsConflict(claim('api', [], 'write'), claim('web', [], 'write'))).toBe(false);
  });
});

describe('activationDomainKeys', () => {
  const commands: AllowlistCommandAccess = new Map([
    ['test', 'write'],
    ['lint', 'read'],
  ]);
  const physicalDomainOf = (repo: string): string | null =>
    repo === 'api' || repo === 'api-alias' ? 'dom-api' : repo === 'web' ? 'dom-web' : null;

  it('reduces agent reads/writes to one domain, write winning, paths unioned', () => {
    const domains = activationDomainKeys(
      {
        kind: 'agent',
        reads: [{ repo: 'api', paths: ['src/'] }],
        writes: [{ repo: 'api', paths: ['lib/'] }],
      },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([
      { physicalDomain: 'dom-api', accessMode: 'write', paths: ['lib/', 'src/'] },
    ]);
  });

  it('agent claims with an empty path list contribute no domain (no repo-wide agents)', () => {
    const domains = activationDomainKeys(
      { kind: 'agent', reads: [{ repo: 'api', paths: [] }], writes: [] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([]);
  });

  it('aliased repository entries sharing a worktree resolve to ONE domain', () => {
    const domains = activationDomainKeys(
      { kind: 'agent', reads: [], writes: [{ repo: 'api', paths: ['a'] }, { repo: 'api-alias', paths: ['b'] }] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([{ physicalDomain: 'dom-api', accessMode: 'write', paths: ['a', 'b'] }]);
  });

  it('a read-only agent keeps read access on its domain', () => {
    const domains = activationDomainKeys(
      { kind: 'agent', reads: [{ repo: 'web', paths: ['src/'] }], writes: [] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([{ physicalDomain: 'dom-web', accessMode: 'read', paths: ['src/'] }]);
  });

  it('a command inherits repository-wide access from the pinned allowlist', () => {
    const domains = activationDomainKeys(
      { kind: 'command', command: 'test', repositories: ['api', 'web'] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([
      { physicalDomain: 'dom-api', accessMode: 'write', paths: [] },
      { physicalDomain: 'dom-web', accessMode: 'write', paths: [] },
    ]);
  });

  it('a read command claims read domains', () => {
    const domains = activationDomainKeys(
      { kind: 'command', command: 'lint', repositories: ['web'] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([{ physicalDomain: 'dom-web', accessMode: 'read', paths: [] }]);
  });

  it('an unknown command is not trusted — it claims no domains', () => {
    const domains = activationDomainKeys(
      { kind: 'command', command: 'zzz', repositories: ['web'] },
      commands,
      physicalDomainOf,
    );
    expect(domains).toEqual([]);
  });

  it('a gate has no node claims', () => {
    expect(
      activationDomainKeys({ kind: 'agent', reads: [], writes: [] }, commands, physicalDomainOf),
    ).toEqual([]);
  });
});

describe('domainsConflict', () => {
  it('read/read on the same domain may coexist', () => {
    expect(
      domainsConflict(
        { physicalDomain: 'd', accessMode: 'read', paths: ['src/'] },
        { physicalDomain: 'd', accessMode: 'read', paths: ['src/'] },
      ),
    ).toBe(false);
  });

  it('any write on the same domain conflicts when paths overlap', () => {
    expect(
      domainsConflict(
        { physicalDomain: 'd', accessMode: 'write', paths: ['src/'] },
        { physicalDomain: 'd', accessMode: 'read', paths: ['src/'] },
      ),
    ).toBe(true);
  });

  it('path-disjoint writes on the same domain do not conflict', () => {
    expect(
      domainsConflict(
        { physicalDomain: 'd', accessMode: 'write', paths: ['src/'] },
        { physicalDomain: 'd', accessMode: 'write', paths: ['lib/'] },
      ),
    ).toBe(false);
  });

  it('a repository-wide lease overlaps every path', () => {
    expect(
      domainsConflict(
        { physicalDomain: 'd', accessMode: 'write', paths: [] },
        { physicalDomain: 'd', accessMode: 'read', paths: ['x'] },
      ),
    ).toBe(true);
  });

  it('different domains never conflict', () => {
    expect(
      domainsConflict(
        { physicalDomain: 'd1', accessMode: 'write', paths: [] },
        { physicalDomain: 'd2', accessMode: 'write', paths: [] },
      ),
    ).toBe(false);
  });
});

describe('schedulerReady', () => {
  const group = (over: Partial<SchedulerGroup> = {}): SchedulerGroup => ({
    destination: 'n',
    nodeKind: 'agent',
    domains: [{ physicalDomain: 'd', accessMode: 'write', paths: [] }],
    created: '2026-08-12T00:00:00.000Z',
    tokenId: 1,
    forkInstance: 0,
    dependencyWaiting: false,
    ...over,
  });
  const state = (over: Partial<SchedulerState> = {}): SchedulerState => ({
    heldLeases: [],
    activeProcesses: 0,
    maxParallel: 4,
    ...over,
  });

  it('a dependency-waiting node is NOT ready and never labeled resource-blocked', () => {
    const decisions = schedulerReady(
      [group({ destination: 'j', nodeKind: 'join', dependencyWaiting: true })],
      state(),
    );
    expect(decisions[0]).toMatchObject({ admitted: false, refused: { reason: 'dependency-waiting' } });
  });

  it('a ready node with no held leases and room under the ceiling is admitted', () => {
    const decisions = schedulerReady([group()], state());
    expect(decisions[0]).toMatchObject({ admitted: true });
  });

  it('two path-disjoint agents are admitted concurrently', () => {
    const decisions = schedulerReady(
      [
        group({ destination: 'a', domains: [{ physicalDomain: 'd', accessMode: 'write', paths: ['src/'] }] }),
        group({ destination: 'b', domains: [{ physicalDomain: 'd', accessMode: 'write', paths: ['lib/'] }] }),
      ],
      state(),
    );
    expect(decisions.map((d) => d.admitted)).toEqual([true, true]);
  });

  it('two overlapping writers are not admitted together — the second defers', () => {
    const decisions = schedulerReady(
      [
        group({ destination: 'a', domains: [{ physicalDomain: 'd', accessMode: 'write', paths: [] }] }),
        group({ destination: 'b', domains: [{ physicalDomain: 'd', accessMode: 'write', paths: [] }] }),
      ],
      state(),
    );
    expect(decisions.map((d) => d.admitted)).toEqual([true, false]);
    expect(decisions[1]!.refused!.reason).toBe('resource-conflict');
  });

  it('repository aliases sharing a repoPath conflict correctly (one domain)', () => {
    // Two manifest entries — api and api-alias — resolve to ONE domain key, so
    // their repository-wide claims overlap even though the repo names differ.
    const decisions = schedulerReady(
      [
        group({ destination: 'a', domains: [{ physicalDomain: 'dom-x', accessMode: 'write', paths: [] }] }),
        group({ destination: 'b', domains: [{ physicalDomain: 'dom-x', accessMode: 'write', paths: [] }] }),
      ],
      state(),
    );
    expect(decisions.map((d) => d.admitted)).toEqual([true, false]);
  });

  it('a held write lease blocks a read; a held read lease blocks only writes', () => {
    const held: SchedulerLease[] = [
      { physicalDomain: 'd', accessMode: 'write', ambiguous: false, paths: [] },
    ];
    expect(
      schedulerReady([group({ destination: 'a' })], state({ heldLeases: held }))[0]!.admitted,
    ).toBe(false);

    const heldRead: SchedulerLease[] = [
      { physicalDomain: 'd', accessMode: 'read', ambiguous: false, paths: ['src/'] },
    ];
    // A reader may share a read-held domain…
    expect(
      schedulerReady(
        [group({ destination: 'a', domains: [{ physicalDomain: 'd', accessMode: 'read', paths: ['src/'] }] })],
        state({ heldLeases: heldRead }),
      )[0]!.admitted,
    ).toBe(true);
    // …but a writer on that domain cannot.
    expect(
      schedulerReady([group({ destination: 'a' })], state({ heldLeases: heldRead }))[0]!.admitted,
    ).toBe(false);
  });

  it('an ambiguous-process lease blocks every activation on that domain', () => {
    const held: SchedulerLease[] = [
      { physicalDomain: 'd', accessMode: 'read', ambiguous: true, paths: [] },
    ];
    const decisions = schedulerReady(
      [group({ destination: 'a', domains: [{ physicalDomain: 'd', accessMode: 'read', paths: [] }] })],
      state({ heldLeases: held }),
    );
    expect(decisions[0]).toMatchObject({ admitted: false, refused: { reason: 'resource-conflict' } });
  });

  it('agent and command activations count against the process ceiling', () => {
    const decisions = schedulerReady(
      [
        group({ destination: 'a', nodeKind: 'agent', domains: [{ physicalDomain: 'd1', accessMode: 'write', paths: [] }] }),
        group({ destination: 'c', nodeKind: 'command', domains: [{ physicalDomain: 'd2', accessMode: 'write', paths: [] }] }),
        group({ destination: 'b', nodeKind: 'agent', domains: [{ physicalDomain: 'd3', accessMode: 'write', paths: [] }] }),
      ],
      state({ activeProcesses: 0, maxParallel: 2 }),
    );
    expect(decisions.map((d) => d.admitted)).toEqual([true, true, false]);
    expect(decisions[2]!.refused!.reason).toBe('parallel-slot-busy');
  });

  it('gates and joins consume no process slot', () => {
    const decisions = schedulerReady(
      [
        group({ destination: 'a', nodeKind: 'agent', domains: [{ physicalDomain: 'd1', accessMode: 'write', paths: [] }] }),
        group({ destination: 'g', nodeKind: 'gate', domains: [{ physicalDomain: 'd2', accessMode: 'write', paths: [] }] }),
        group({ destination: 'j', nodeKind: 'join', domains: [{ physicalDomain: 'd3', accessMode: 'write', paths: [] }] }),
      ],
      state({ activeProcesses: 0, maxParallel: 1 }),
    );
    expect(decisions.map((d) => d.admitted)).toEqual([true, true, true]);
  });

  it('a pre-existing active process count is honored across ticks', () => {
    const decisions = schedulerReady([group({ destination: 'a' })], state({ activeProcesses: 4, maxParallel: 4 }));
    expect(decisions[0]).toMatchObject({ admitted: false, refused: { reason: 'parallel-slot-busy' } });
  });
});

describe('agingPriority', () => {
  const NOW = '2026-08-12T01:00:00.000Z';
  const g = (over: Partial<SchedulerGroup>): SchedulerGroup => ({
    destination: 'n',
    nodeKind: 'agent',
    domains: [],
    created: '2026-08-12T00:00:00.000Z',
    tokenId: 1,
    forkInstance: 0,
    dependencyWaiting: false,
    ...over,
  });

  it('orders by creation time, token id breaking millisecond ties', () => {
    const a = g({ destination: 'a', created: '2026-08-12T00:00:01.000Z', tokenId: 2 });
    const b = g({ destination: 'b', created: '2026-08-12T00:00:01.000Z', tokenId: 1 });
    const c = g({ destination: 'c', created: '2026-08-12T00:00:00.000Z', tokenId: 5 });
    expect(agingPriority([a, b, c], NOW, () => null).map((x) => x.destination)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('below the threshold an aged group keeps creation-time order', () => {
    const aged = g({ destination: 'aged', created: '2026-08-12T00:59:40.000Z', tokenId: 2 });
    const fresh = g({ destination: 'fresh', created: '2026-08-12T00:59:50.000Z', tokenId: 1 });
    // 20s < 60s threshold: creation order wins.
    expect(agingPriority([fresh, aged], NOW, () => '2026-08-12T00:59:40.000Z').map((x) => x.destination)).toEqual([
      'aged',
      'fresh',
    ]);
  });

  it('past the threshold an aged group is preferred over newer narrow work', () => {
    const aged = g({ destination: 'aged', created: '2026-08-12T00:59:40.000Z', tokenId: 2 });
    const fresh = g({ destination: 'fresh', created: '2026-08-12T00:59:50.000Z', tokenId: 1 });
    // Only `aged` has been waiting (80s); `fresh` never became blocked.
    const waitSinceOf = (d: string): string | null =>
      d === 'aged' ? '2026-08-12T00:58:40.000Z' : null;
    expect(agingPriority([fresh, aged], NOW, waitSinceOf).map((x) => x.destination)).toEqual([
      'aged',
      'fresh',
    ]);
  });

  it('aged groups order by their own wait_since, oldest waiter first', () => {
    const longWaiter = g({ destination: 'long', created: NOW, tokenId: 1 });
    const shortWaiter = g({ destination: 'short', created: NOW, tokenId: 2 });
    expect(
      agingPriority([shortWaiter, longWaiter], NOW, (d) =>
        d === 'long' ? '2026-08-12T00:00:00.000Z' : '2026-08-12T00:30:00.000Z',
      ).map((x) => x.destination),
    ).toEqual(['long', 'short']);
  });

  it('a group with no deferral is never aged', () => {
    const a = g({ destination: 'a', created: '2026-08-12T00:59:50.000Z', tokenId: 1 });
    const b = g({ destination: 'b', created: '2026-08-12T00:59:40.000Z', tokenId: 2 });
    expect(agingPriority([a, b], NOW, () => null).map((x) => x.destination)).toEqual(['b', 'a']);
  });

  it('the documented threshold is the configured bound', () => {
    expect(AGING_THRESHOLD_MS).toBe(60_000);
  });
});
