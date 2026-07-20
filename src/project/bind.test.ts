import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, listTickets } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { bindProject, type OnceFlag } from './bind.js';

/** In-memory stand-in for the host's persisted "adoption already ran" flag. */
function fakeFlag(initial = false): OnceFlag & { value: boolean } {
  return {
    value: initial,
    done() {
      return this.value;
    },
    markDone() {
      this.value = true;
    },
  };
}

const INPUT = { slug: 'karst', name: 'karst', rootPath: '/w/karst' };

describe('bindProject', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('registers the project and returns it', () => {
    const { project } = bindProject(store, INPUT, fakeFlag());
    expect(project.slug).toBe('karst');
    expect(project.rootPath).toBe('/w/karst');
  });

  it('adopts legacy tickets on the first bind of a fresh install', () => {
    createTicket(store, { key: 'OLD-1', title: 'legacy' });
    const flag = fakeFlag();

    const { project, adopted } = bindProject(store, INPUT, flag);

    expect(adopted).toBe(1);
    expect(flag.value).toBe(true); // marked, so it never runs again
    expect(listTickets(store, { projectId: project.id })).toHaveLength(1);
  });

  it('does not adopt again once the flag is set', () => {
    createTicket(store, { key: 'OLD-1', title: 'legacy' });
    const flag = fakeFlag(true);
    expect(bindProject(store, INPUT, flag).adopted).toBe(0);
  });

  it('never adopts when another project already exists', () => {
    // The dangerous case: a *second* project's window is the first to bind
    // after the upgrade. Its tickets are not ours to claim.
    upsertProject(store, { slug: 'other', name: 'other', rootPath: '/w/other' });
    createTicket(store, { key: 'OLD-1', title: 'legacy' });

    const flag = fakeFlag();
    const { adopted } = bindProject(store, INPUT, flag);

    expect(adopted).toBe(0);
    expect(flag.value).toBe(true); // still burned — adoption is a one-shot, not a retry loop
  });

  it('is idempotent across repeated binds in one session', () => {
    createTicket(store, { key: 'OLD-1', title: 'legacy' });
    const flag = fakeFlag();
    const first = bindProject(store, INPUT, flag);
    const second = bindProject(store, INPUT, flag);
    expect(second.project.id).toBe(first.project.id);
    expect(second.adopted).toBe(0);
  });

  it('reports zero adopted when there is no legacy ticket', () => {
    expect(bindProject(store, INPUT, fakeFlag()).adopted).toBe(0);
  });
});
