import { describe, expect, it } from 'vitest';
import { RING_CAPACITY } from '../../runtime/resourceMonitor.js';
import {
  fixtureMessages,
  resourcesRenderFixtures,
  RESOURCES_SCENARIOS,
} from './renderFixtures.js';

describe('resources render fixtures', () => {
  const fixtures = resourcesRenderFixtures();

  it('is deterministic: one fixture per scenario, no duplicates', () => {
    expect(fixtures).toHaveLength(RESOURCES_SCENARIOS.length);
    expect(new Set(fixtures.map((f) => f.scenario)).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(resourcesRenderFixtures()));
  });

  it('unsupported has supported === false and every other scenario true', () => {
    for (const f of fixtures) {
      expect(f.state.supported, f.scenario).toBe(f.scenario !== 'unsupported');
    }
  });

  it('wasteCount === waste.length', () => {
    for (const f of fixtures) {
      expect(f.state.wasteCount, f.scenario).toBe(f.state.waste.length);
    }
  });

  it('unattributedShown === unknown.length', () => {
    for (const f of fixtures) {
      expect(f.state.unattributedShown, f.scenario).toBe(f.state.unknown.length);
    }
  });

  it('busy history length equals historyMax', () => {
    const busy = fixtures.find((f) => f.scenario === 'busy')!;
    expect(busy.state.history.length).toBe(busy.state.historyMax);
  });

  it('every serverId in the reserved band 900001–999999 or null', () => {
    for (const f of fixtures) {
      for (const row of f.state.rows) {
        expect(row.pid, `${f.scenario} pid`).toBeGreaterThanOrEqual(900001);
      }
      for (const w of f.state.waste) {
        if (w.serverId !== null) {
          expect(w.serverId, `${f.scenario} waste serverId`).toBeGreaterThanOrEqual(900001);
        }
      }
    }
  });

  it('hostile contains the required untrusted strings', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = [
      ...hostile.state.rows.map((r) => `${r.label} ${r.ticketTitle}`),
      ...hostile.state.waste.map((w) => w.reason),
      ...hostile.state.facts.map((f) => `${f.label} ${f.value}`),
    ].join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText).toContain('A & B "quoted" <b>');
  });

  describe('servers scenarios', () => {
    const servers = fixtures.filter((f) => f.scenario.startsWith('servers-'));
    const byName = (name: string) => fixtures.find((f) => f.scenario === name)!.servers!;

    it('covers shared / tickets / done / archived / idle / empty / unavailable / hostile', () => {
      expect(servers.map((f) => f.scenario)).toEqual([
        'servers-mixed', 'servers-shared-only', 'servers-tickets-only', 'servers-done',
        'servers-archived', 'servers-idle', 'servers-none', 'servers-unavailable', 'servers-hostile',
      ]);
    });

    it('every servers scenario opens on the Servers tab and pushes state, servers, show-tab in order', () => {
      for (const f of servers) {
        expect(f.tab, f.scenario).toBe('servers');
        expect(fixtureMessages(f).map((m) => m.type), f.scenario).toEqual(['state', 'servers', 'show-tab']);
      }
    });

    it('a resources scenario pushes only its state', () => {
      const busy = fixtures.find((f) => f.scenario === 'busy')!;
      expect(fixtureMessages(busy).map((m) => m.type)).toEqual(['state']);
      expect(busy.servers).toBeUndefined();
    });

    it('mixed carries a pinned+running row, a stopped row, a done group and a dependency-down group', () => {
      const s = byName('servers-mixed');
      expect(s.shared.some((r) => r.keptRunning)).toBe(true);
      expect(s.shared.some((r) => r.status === 'stopped')).toBe(true);
      expect(s.groups.some((g) => g.doneStillRunning)).toBe(true);
      expect(s.groups.some((g) => g.downServices.length > 0)).toBe(true);
      expect(s.shared.flatMap((r) => r.dependents).some((d) => d.done)).toBe(true);
    });

    it('idle makes Stop idle available and shared-only/tickets-only/none hit their empty flags', () => {
      expect(byName('servers-idle').stopIdle.count).toBe(2);
      expect(byName('servers-shared-only').empty).toBe('shared-only');
      expect(byName('servers-tickets-only').empty).toBe('tickets-only');
      expect(byName('servers-none').empty).toBe('none');
      expect(byName('servers-unavailable').available).toBe(false);
    });

    it('archived marks clean-up and done marks the finished-with-servers state', () => {
      expect(byName('servers-archived').groups[0]).toMatchObject({ cleanUp: true, doneStillRunning: false });
      expect(byName('servers-done').groups[0]).toMatchObject({ doneStillRunning: true, cleanUp: false });
    });

    it('every server id is in the reserved band 900001–999999', () => {
      for (const f of servers) {
        const ids = [...f.servers!.shared.map((r) => r.serverId), ...f.servers!.groups.flatMap((g) => [g.ticketId, ...g.servers.map((r) => r.serverId)])];
        for (const id of ids) expect(id, f.scenario).toBeGreaterThanOrEqual(900001);
      }
    });

    it('hostile carries untrusted and over-long names', () => {
      const text = JSON.stringify(byName('servers-hostile'));
      expect(text).toContain('<script>alert(1)</script>');
      expect(text).toContain('Z'.repeat(100));
    });
  });
});
