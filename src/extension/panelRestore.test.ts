import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RESTORED_VIEW_TYPES, RestoreGate, UNRESTORED_VIEW_TYPES } from './panelRestore.js';
import { liveTicket, makeRestorers, registerRestoreSerializers } from './panelRestoreBinding.js';
import { openStore } from '../store/db.js';
import { archiveTicket, createTicket } from '../store/tickets.js';
import { restoredTicketId } from '../ui/shared/restoredPanel.js';

const raw = () => ({ dispose: vi.fn() });

describe('RestoreGate', () => {
  it('holds a restore until the managers exist, then runs the view type restorer', async () => {
    const gate = new RestoreGate();
    const restorer = vi.fn();
    const panel = raw();
    const done = gate.restore('karst.dashboard', panel, { a: 1 });
    await Promise.resolve();
    expect(restorer).not.toHaveBeenCalled();
    gate.open({ 'karst.dashboard': restorer });
    await done;
    expect(restorer).toHaveBeenCalledWith(panel, { a: 1 });
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it('closes the tab and logs when the view type has no restorer', async () => {
    const debug = vi.fn();
    const gate = new RestoreGate(debug);
    gate.open({});
    const panel = raw();
    await gate.restore('karst.settings', panel, undefined);
    expect(panel.dispose).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('[restore] karst.settings: no restorer, tab closed');
  });

  it('closes every waiting tab when activation fails', async () => {
    const gate = new RestoreGate();
    const a = raw();
    const b = raw();
    const pending = [gate.restore('karst.dashboard', a, null), gate.restore('karst.changes', b, null)];
    gate.fail();
    await Promise.all(pending);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('closes the tab, reports the error, and does not reject when a restorer throws', async () => {
    const logError = vi.fn();
    const gate = new RestoreGate(undefined, logError);
    const boom = new Error('boom');
    gate.open({ karstDoctor: () => Promise.reject(boom) });
    const panel = raw();
    await expect(gate.restore('karstDoctor', panel, null)).resolves.toBeUndefined();
    expect(panel.dispose).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('karst: restoring karstDoctor failed', boom);
  });
});

describe('restoredTicketId', () => {
  it('reads the ticket id from the karstPanel key', () => {
    expect(restoredTicketId({ karstPanel: { ticketId: 12 }, other: 1 })).toBe(12);
  });

  it.each([
    [undefined],
    [null],
    ['text'],
    [{}],
    [{ karstPanel: null }],
    [{ karstPanel: 5 }],
    [{ karstPanel: {} }],
    [{ karstPanel: { ticketId: '7' } }],
    [{ karstPanel: { ticketId: 0 } }],
    [{ karstPanel: { ticketId: -3 } }],
    [{ karstPanel: { ticketId: 1.5 } }],
  ])('reads %j as no ticket id', (state) => {
    expect(restoredTicketId(state)).toBeUndefined();
  });
});

describe('restore conformance', () => {
  const root = process.cwd();
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const read = (path: string): string => readFileSync(path, 'utf8');

  /** Every view type a `src/ui` module opens as a panel. */
  const openedViewTypes = (): Set<string> => {
    const found = new Set<string>();
    for (const file of sources(join(root, 'src/ui'))) {
      const text = read(file);
      for (const m of text.matchAll(/createWebviewPanel\(\s*'([^']+)'/g)) found.add(m[1]!);
      for (const m of text.matchAll(/makeSimplePanelHost(?:<[^>]*>)?\(\s*[^,]+,\s*[^,]+,\s*'([^']+)'/g)) found.add(m[1]!);
      for (const m of text.matchAll(/DOCTOR_VIEW_TYPE\s*=\s*'([^']+)'/g)) found.add(m[1]!);
    }
    return found;
  };

  const restored = new Set<string>(RESTORED_VIEW_TYPES);

  it('finds the view types it is meant to guard', () => {
    const opened = openedViewTypes();
    for (const type of RESTORED_VIEW_TYPES) expect(opened).toContain(type);
    expect(opened).toContain('karst.ticketForm');
  });

  it('restores or explicitly exempts every panel view type opened in src/ui', () => {
    for (const type of openedViewTypes()) {
      expect(restored.has(type) || type in UNRESTORED_VIEW_TYPES, `${type} has no serializer and no exemption`).toBe(true);
    }
  });

  it('keeps the exemption list free of restored types', () => {
    for (const type of Object.keys(UNRESTORED_VIEW_TYPES)) expect(restored.has(type)).toBe(false);
  });

  it('declares an onWebviewPanel activation event for every restored view type', () => {
    const pkg = JSON.parse(read(join(root, 'package.json'))) as { activationEvents: string[] };
    for (const type of RESTORED_VIEW_TYPES) expect(pkg.activationEvents).toContain(`onWebviewPanel:${type}`);
    for (const event of pkg.activationEvents.filter((e) => e.startsWith('onWebviewPanel:'))) {
      expect(restored.has(event.slice('onWebviewPanel:'.length)), `${event} is not a restored type`).toBe(true);
    }
  });

  it('wires the activation to the binding that registers a serializer and a restorer per type', () => {
    const ext = read(join(root, 'src/extension.ts'));
    expect(ext).toContain('registerRestoreSerializers(vscode.window, restoreGate)');
    expect(ext).toContain('restoreGate.open(makeRestorers<vscode.WebviewPanel>(');
  });

  it('registers one serializer per restored view type', () => {
    const registered: string[] = [];
    registerRestoreSerializers({ registerWebviewPanelSerializer: (type) => void registered.push(type) }, new RestoreGate());
    expect(registered).toEqual([...RESTORED_VIEW_TYPES]);
  });

  it('builds a restorer for every restored view type', () => {
    const host = { restore: () => ({ wrap: () => ({}), dispose: () => {} }) };
    const manager = { adopt: () => true, adoptDashboard: () => true };
    const restorers = makeRestorers({
      store: {} as never, dashboard: manager, dashboardHost: host, changes: manager, changesHost: host, settings: manager,
      settingsHost: host, gettingStarted: manager, gettingStartedHost: host, doctor: { restore: async () => {} },
      usage: manager, usageHost: host, resources: manager, resourcesHost: host,
    });
    expect(Object.keys(restorers).sort()).toEqual([...RESTORED_VIEW_TYPES].sort());
  });
});

describe('liveTicket', () => {
  it('is true for a live ticket, false for an archived one and for a missing one', () => {
    const store = openStore(':memory:');
    const live = createTicket(store, { key: 'K-1', title: 't' });
    const gone = createTicket(store, { key: 'K-2', title: 't' });
    archiveTicket(store, gone.id);
    expect(liveTicket(store, live.id)).toBe(true);
    expect(liveTicket(store, gone.id)).toBe(false);
    expect(liveTicket(store, 9999)).toBe(false);
  });
});
