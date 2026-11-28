/**
 * The channel map is the single source the Channels tab renders
 * (`@arch:CHANNEL-MAP`). These tests read the REAL adapters and the REAL
 * delivery/CLI constants: if an adapter surface changes, its cell must change
 * here, and a copied per-core table would fail.
 */
import { describe, expect, it } from 'vitest';
import { resolveAdapter } from '../../agent/registry.js';
import { IMPLEMENTED_PROVIDERS } from '../../agent/provider.js';
import { PLANNING_VERBS } from '../../cli/planningVerbs.js';
import { messageRouteFor } from '../../extension/ops/messageDeliveryOps.js';
import { CODEX_STOP_BLOCK_SUPPORTED } from '../../extension/ops/mailDeliveryWiring.js';
import { buildChannelMap, type ChannelMapView, type SessionKind } from './channelMap.js';

const map = buildChannelMap(IMPLEMENTED_PROVIDERS);

function coreOf(view: ChannelMapView, core: (typeof IMPLEMENTED_PROVIDERS)[number]) {
  const found = view.cores.find((entry) => entry.core === core);
  if (found === undefined) throw new Error(`no map entry for ${core}`);
  return found;
}

function rowOf(view: ChannelMapView, core: (typeof IMPLEMENTED_PROVIDERS)[number], kind: SessionKind) {
  const row = coreOf(view, core).rows.find((entry) => entry.kind === kind);
  if (row === undefined) throw new Error(`no ${kind} row for ${core}`);
  return row;
}

describe('buildChannelMap — every implemented core', () => {
  it('lists one entry per provider, in the given order, with all six session kinds', () => {
    expect(map.cores.map((entry) => entry.core)).toEqual([...IMPLEMENTED_PROVIDERS]);
    for (const entry of map.cores) {
      expect(entry.rows.map((row) => row.kind)).toEqual(['ticket', 'sandbox', 'planning', 'setup', 'graph', 'headless']);
    }
  });

  it.each(IMPLEMENTED_PROVIDERS)('ticket MCP follows the adapter surface for %s', (core) => {
    const surface = resolveAdapter(core).surfaces!.mcpConfigInteractive;
    const cell = rowOf(map, core, 'ticket').cells.mcp;
    expect(cell.state).toBe(surface.supported ? 'yes' : 'no');
    expect(cell.value).toBe(surface.supported ? 'Yes' : 'No');
    if (!surface.supported) expect(cell.reason).toBe(surface.reason);
  });

  it.each(IMPLEMENTED_PROVIDERS)('ticket hooks follow the adapter surface for %s', (core) => {
    const surface = resolveAdapter(core).surfaces!.hookChannel;
    const cell = rowOf(map, core, 'ticket').cells.hooks;
    expect(cell.state).toBe(surface.supported ? 'yes' : 'no');
    expect(cell.value).toBe(surface.supported ? 'Yes' : 'No');
    if (!surface.supported) expect(cell.reason).toBe(surface.reason);
  });

  it.each(IMPLEMENTED_PROVIDERS)('ticket mail follows messageRouteFor for %s', (core) => {
    const route = messageRouteFor(core, CODEX_STOP_BLOCK_SUPPORTED);
    const cell = rowOf(map, core, 'ticket').cells.mail;
    expect(cell.value).toBe(
      route === 'hook-block' ? 'Stop-hook reply' : route === 'plugin-idle' ? 'Plugin on idle' : 'Typed',
    );
    expect(cell.state).toBe(route === 'typed' ? 'partial' : 'yes');
  });

  it.each(IMPLEMENTED_PROVIDERS)('ticket instructions follow the instruction delivery for %s', (core) => {
    const delivery = resolveAdapter(core).instructions!;
    const cell = rowOf(map, core, 'ticket').cells.instructions;
    if (delivery.interactive === 'native-file') {
      expect(cell).toMatchObject({ state: 'yes', value: 'System prompt' });
    } else {
      expect(cell).toMatchObject({ state: 'partial', value: 'Pointer' });
      expect(cell.reason).toBe(delivery.soloFallback === true ? 'inlined for a solo agent' : undefined);
    }
  });

  it('setup MCP follows the same adapter surface', () => {
    const agy = rowOf(map, 'antigravity', 'setup').cells.mcp;
    expect(agy.state).toBe('no');
    expect(agy.reason).toContain('karst mcp install');
    const claude = rowOf(map, 'claude', 'setup').cells.mcp;
    expect(claude).toEqual({ state: 'yes', value: 'Yes', reason: '+ setup-* tools' });
  });
});

describe('buildChannelMap — the fixed rows and the acceptance facts', () => {
  it('planning commands names every PLANNING_VERB in order', () => {
    const reason = rowOf(map, 'claude', 'planning').cells.commands.reason ?? '';
    let at = -1;
    for (const verb of PLANNING_VERBS) {
      const next = reason.indexOf(verb, at + 1);
      expect(next, `"${verb}" out of order in "${reason}"`).toBeGreaterThan(at);
      at = next;
    }
    expect(reason).toContain('notes read');
  });

  it('reads exactly the Claude ticket row the ticket promises', () => {
    const cells = rowOf(map, 'claude', 'ticket').cells;
    expect(cells.commands).toMatchObject({ state: 'yes', value: 'CLI + env' });
    expect(cells.mcp).toMatchObject({ state: 'yes', value: 'Yes' });
    expect(cells.hooks).toMatchObject({ state: 'yes', value: 'Yes' });
    expect(cells.instructions).toMatchObject({ state: 'yes', value: 'System prompt' });
    expect(cells.guide).toMatchObject({ state: 'yes', value: 'Fresh launch' });
    expect(cells.mail).toMatchObject({ state: 'yes', value: 'Stop-hook reply' });
    expect(cells.parentMail).toMatchObject({ state: 'yes', value: 'Yes' });
  });

  it('reads Antigravity MCP and hooks as No with the surface reasons', () => {
    const cells = rowOf(map, 'antigravity', 'ticket').cells;
    expect(cells.mcp.state).toBe('no');
    expect(cells.mcp.reason).toContain('karst mcp install');
    expect(cells.hooks.state).toBe('no');
    expect(cells.hooks.reason).toContain('conversation DB');
  });

  it('gives every cell a value and a known state', () => {
    for (const entry of map.cores) {
      for (const row of entry.rows) {
        for (const cell of Object.values(row.cells)) {
          expect(['yes', 'no', 'partial']).toContain(cell.state);
          expect(cell.value.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
