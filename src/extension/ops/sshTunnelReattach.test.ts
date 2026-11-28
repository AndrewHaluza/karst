import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import type { TicketPlacement } from '../../store/placement.js';
import { hasRunningSandboxService, sshTunnelReattachTickets } from './sshTunnelReattach.js';

const SSH: TicketPlacement = { backend: 'ssh', core: 'claude', sandboxName: 'devbox/p-1-claude', reason: null };
const SBX: TicketPlacement = { backend: 'sbx', core: 'claude', sandboxName: 'sbx-1', reason: null };

function input(over: Partial<Parameters<typeof sshTunnelReattachTickets>[0]> = {}): Parameters<typeof sshTunnelReattachTickets>[0] {
  return {
    tickets: [1, 2, 3],
    adopted: new Set<number>(),
    recovering: new Set<number>(),
    placementOf: () => SSH,
    hasRunningService: () => false,
    ...over,
  };
}

describe('sshTunnelReattachTickets (D823: re-open tunnels after a reload)', () => {
  it('picks an ssh ticket whose live session this window adopted', () => {
    expect(sshTunnelReattachTickets(input({ adopted: new Set([2]) }))).toEqual([2]);
  });

  it('picks an ssh ticket with a kept sandboxed stack and no session', () => {
    expect(sshTunnelReattachTickets(input({ hasRunningService: (id) => id === 3 }))).toEqual([3]);
  });

  it('skips a ticket that recovery re-launches: its launch re-opens the tunnels', () => {
    expect(sshTunnelReattachTickets(input({ adopted: new Set([1]), recovering: new Set([1]) }))).toEqual([]);
  });

  it('skips a ticket that is not placed on ssh', () => {
    expect(sshTunnelReattachTickets(input({ adopted: new Set([1]), placementOf: () => SBX }))).toEqual([]);
    expect(sshTunnelReattachTickets(input({ adopted: new Set([1]), placementOf: () => undefined }))).toEqual([]);
  });

  it('skips an ssh ticket with no adopted session and no running service', () => {
    expect(sshTunnelReattachTickets(input())).toEqual([]);
  });

  it('keeps the ticket order and lists a ticket once', () => {
    expect(sshTunnelReattachTickets(input({ adopted: new Set([3, 1]), hasRunningService: () => true }))).toEqual([1, 2, 3]);
  });
});

describe('hasRunningSandboxService', () => {
  it('is true only for a running row inside a sandbox', () => {
    const store = openStore(':memory:');
    const add = store.db.prepare('INSERT INTO servers (ticket_id, repo, host, port, status, sandbox) VALUES (?, ?, ?, ?, ?, ?)');
    add.run(1, 'api', '127.0.0.1', 4100, 'running', 'ssh:devbox:4100');
    add.run(2, 'api', '127.0.0.1', 4101, 'stopped', 'ssh:devbox:4101');
    add.run(3, 'api', '127.0.0.1', 4102, 'running', null);
    expect([1, 2, 3, 4].map((id) => hasRunningSandboxService(store, id))).toEqual([true, false, false, false]);
  });
});
