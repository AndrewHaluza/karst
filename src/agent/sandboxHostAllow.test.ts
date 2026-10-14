import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../manifest/types.js';
import { openStore } from '../store/db.js';
import { allowBaselineHostPorts, baselineHostPorts, ticketBaselineKeys } from './sandboxHostAllow.js';

const manifest = {
  repositories: {
    db: { repoPath: '/r/db', service: { start: 'x', ports: [{ name: 'pg', default: 5432 }] } },
    cache: { repoPath: '/r/cache', service: { start: 'x', ports: [{ name: 'redis', default: 6379 }, { name: 'admin', default: 5432 }] } },
    web: { repoPath: '/r/web', service: { start: 'x', ports: [{ name: 'http', default: 3000 }] } },
  },
} as unknown as Manifest;

describe('sandboxHostAllow (arch:AC-32)', () => {
  it('allows only the declared ports of the baseline services, deduped and sorted', () => {
    expect(baselineHostPorts(manifest, ['cache', 'db'])).toEqual([5432, 6379]);
    expect(baselineHostPorts(manifest, ['gone'])).toEqual([]);
    expect(baselineHostPorts(manifest, [])).toEqual([]);
  });

  it('reads the ticket baseline references', () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO baseline_refs (ticket_id, repo) VALUES (7, 'db'), (8, 'cache')").run();
    expect(ticketBaselineKeys(store, 7)).toEqual(['db']);
  });

  it('applies the rule only when there are ports and the runner can', async () => {
    const allowHostPorts = vi.fn(() => Promise.resolve({ ok: true as const }));
    await expect(allowBaselineHostPorts({ allowHostPorts }, [])).resolves.toEqual({ ok: true });
    await expect(allowBaselineHostPorts({}, [5432])).resolves.toEqual({ ok: true });
    expect(allowHostPorts).not.toHaveBeenCalled();
    await allowBaselineHostPorts({ allowHostPorts }, [5432]);
    expect(allowHostPorts).toHaveBeenCalledWith([5432]);
  });
});
