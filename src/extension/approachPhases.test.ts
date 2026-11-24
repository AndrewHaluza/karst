import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import type { Manifest } from '../manifest/types.js';
import { makePhasesOf } from './approachPhases.js';

/**
 * A ticket's phases are a JOIN of two declarations, never a guess:
 *
 *  - the installed package gives the names and their ORDER — the same list the
 *    stepper and the agent see;
 *  - the manifest's phase with the same name gives `evidence.outputKind`.
 *
 * A phase the approach never declares can therefore never be marked by the host.
 */
describe('makePhasesOf', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const manifestOf = (name: string, outputKind?: 'plan' | 'research' | 'spec'): Manifest =>
    ({
      approaches: [{ id: 'rpi', label: 'RPI', workflow: [{ name, ...(outputKind ? { evidence: { outputKind } } : {}) }] }],
    }) as Manifest;

  const phasesOf = (overrides: {
    manifest?: () => Manifest | undefined;
    packageOf?: (id: string) => { workflow?: readonly { name: string }[] } | null | undefined;
  } = {}) =>
    makePhasesOf({
      store,
      manifest: overrides.manifest ?? (() => manifestOf('plan', 'plan')),
      packageOf: overrides.packageOf ?? (() => ({ workflow: [{ name: 'research' }, { name: 'plan' }] })),
      debug: () => {},
    });

  it('takes the names and the order from the package', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf()(t.id).map((p) => p.name)).toEqual(['research', 'plan']);
  });

  it('takes outputKind from the manifest phase with the same name', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf()(t.id)).toEqual([{ name: 'research' }, { name: 'plan', outputKind: 'plan' }]);
  });

  it('gives names only when there is no manifest', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf({ manifest: () => undefined })(t.id)).toEqual([
      { name: 'research' },
      { name: 'plan' },
    ]);
  });

  it('omits the outputKind key of a phase that declares no evidence', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf()(t.id)).toStrictEqual([{ name: 'research' }, { name: 'plan', outputKind: 'plan' }]);
  });

  it('reads the evidence of the approach with the ticket approach id, not the first one', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    const manifest = {
      approaches: [
        { id: 'other', label: 'O', workflow: [{ name: 'plan', evidence: { outputKind: 'spec' } }] },
        { id: 'rpi', label: 'RPI', workflow: [{ name: 'plan', evidence: { outputKind: 'plan' } }] },
      ],
    } as Manifest;

    expect(phasesOf({ manifest: () => manifest })(t.id)).toStrictEqual([
      { name: 'research' },
      { name: 'plan', outputKind: 'plan' },
    ]);
  });

  it('gives names only when the manifest has no approaches, no such approach, or no workflow', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    const names = [{ name: 'research' }, { name: 'plan' }];
    const manifests = [
      {},
      { approaches: [{ id: 'other', label: 'O', workflow: [{ name: 'plan', evidence: { outputKind: 'plan' } }] }] },
      { approaches: [{ id: 'rpi', label: 'RPI' }] },
    ] as unknown as Manifest[];

    for (const manifest of manifests) {
      expect(phasesOf({ manifest: () => manifest })(t.id)).toStrictEqual(names);
    }
  });

  it('keeps every phase when a manifest phase carries no evidence', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf({ manifest: () => manifestOf('plan') })(t.id)).toStrictEqual([
      { name: 'research' },
      { name: 'plan' },
    ]);
  });

  it('gives nothing for a ticket with no approach', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });

    expect(phasesOf()(t.id)).toEqual([]);
  });

  it('gives nothing when the package is missing', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf({ packageOf: () => null })(t.id)).toEqual([]);
  });

  it('gives nothing for a blank approach id', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: '' });

    expect(phasesOf()(t.id)).toEqual([]);
  });

  it('gives nothing when the package declares no workflow', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });

    expect(phasesOf({ packageOf: () => ({}) })(t.id)).toEqual([]);
    expect(phasesOf({ packageOf: () => ({ workflow: [] }) })(t.id)).toEqual([]);
  });

  it('gives nothing for an unknown ticket', () => {
    expect(phasesOf()(9999)).toEqual([]);
  });

  it('gives nothing and debugs once when the package reader throws', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    const lines: string[] = [];

    const resolved = makePhasesOf({
      store,
      manifest: () => manifestOf('plan', 'plan'),
      packageOf: () => {
        throw new Error('package unreadable');
      },
      debug: (m) => lines.push(m),
    })(t.id);

    expect(resolved).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('package unreadable');
  });

  it('gives nothing and debugs once when the manifest reader throws', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    const lines: string[] = [];

    const resolved = makePhasesOf({
      store,
      manifest: () => {
        throw new Error('manifest unreadable');
      },
      packageOf: () => ({ workflow: [{ name: 'plan' }] }),
      debug: (m) => lines.push(m),
    })(t.id);

    expect(resolved).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('manifest unreadable');
  });
});
