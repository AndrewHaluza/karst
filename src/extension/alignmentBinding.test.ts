import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunHeadlessOpts } from '../agent/adapter.js';
import type { DriveProcessBundle } from '../agent/processAssignment.js';
import type { RevisionInput } from '../artifacts/store.js';
import type { Manifest } from '../manifest/types.js';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { listInbox } from '../store/ticketMessages.js';
import { updateTicketFields } from '../store/tickets.js';
import { ALIGNMENT_DEBOUNCE_MS } from '../workflow/artifacts/alignmentTrigger.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { makeAlignmentTrigger } from './alignmentBinding.js';

// Only the debounce timer is faked: the report write and the temp cwd use real fs I/O.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

const FINDING = '[{"severity":"high","title":"Scenario 2 not planned","detail":"d"}]';

function setup(opts: { own?: boolean; fallback?: boolean; approaches?: unknown[]; noManifest?: boolean; bareManifest?: boolean; process?: 'off' | 'on'; raw?: string } = {}) {
  const registry: Store = openStore(':memory:');
  const own = upsertProject(registry, { slug: 'own' }).id;
  const other = upsertProject(registry, { slug: 'other' }).id;
  const id = createTicketFlow(registry, { key: 'T-1', title: 't' }).id;
  updateTicketFields(registry, id, { intent: 'I', approach: 'mine' });
  if (opts.own) registry.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(own, id);
  const commits: { input: RevisionInput; body: string }[] = [];
  const opened: { artifactsRoot: string; projectId: number }[] = [];
  const runs: RunHeadlessOpts[] = [];
  const bundle: DriveProcessBundle = {
    assignment: { provider: 'claude', model: 'm-1', effort: 'low' },
    adapter: {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used');
      },
      runHeadless: async (o) => {
        runs.push(o);
        return { sessionId: '', verdict: null, raw: opts.raw ?? FINDING };
      },
    },
  };
  const debug: string[] = [];
  const trigger = makeAlignmentTrigger({
    registry,
    artifactsRoot: '/root',
    manifest: () =>
      opts.noManifest
        ? undefined
        : (opts.bareManifest ? {} : { approaches: opts.approaches ?? [{ id: 'mine', label: 'M' }] }) as unknown as Manifest,
    fallbackProjectId: () => (opts.fallback ? other : undefined),
    reviewProcess: () => (opts.process === 'off' ? null : bundle),
    debug: (m) => debug.push(m),
    createStore: (o) => {
      opened.push(o);
      return {
        listArtifacts: async () => [{ path: 'app/plan.md', revisions: 1, latestSha: 'sha1' }],
        history: async () => [{ sha: 'sha1', at: '', trailers: { kind: 'plan' } }],
        show: async () => Buffer.from('PLANBODY'),
        commitRevision: async (input: RevisionInput) => {
          commits.push({ input, body: await readFile(input.sourcePath!, 'utf8') });
          return 'c1';
        },
      };
    },
  });
  /** Fire the debounce, then wait (real clock, 5 s cap) for the real-I/O tail: the report commit and its message. */
  const fire = async (done: () => boolean = () =>
    commits.length > 0 && (opts.raw === '[]' || listInbox(registry, id, { unreadOnly: false }).length > 0)) => {
    trigger.onRevision({ ticketId: id, kind: 'plan' });
    await vi.advanceTimersByTimeAsync(ALIGNMENT_DEBOUNCE_MS);
    const deadline = Date.now() + 5000;
    while (!done() && Date.now() < deadline) await new Promise((r) => setImmediate(r));
    // Negative cases (nothing is expected) settle on a short fixed tail.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  return { registry, id, own, other, trigger, commits, opened, runs, debug, fire };
}

describe('makeAlignmentTrigger', () => {
  it('checks the plan against the intent with the review process, stores the report and posts one message', async () => {
    const t = setup({ own: true });
    await t.fire();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ model: 'm-1', effort: 'low' });
    expect(t.runs[0]!.prompt).toContain('PLANBODY');
    expect(t.opened.every((o) => o.artifactsRoot === '/root' && o.projectId === t.own)).toBe(true);
    expect(t.commits).toHaveLength(1);
    expect(t.commits[0]!.input).toMatchObject({ ticketId: t.id, repo: '_karst', relPath: 'alignment/intent-plan.md' });
    expect(t.commits[0]!.body).toContain('Scenario 2 not planned');
    const inbox = listInbox(t.registry, t.id, { unreadOnly: false });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ projectId: t.own, fromTicketId: null, kind: 'message' });
    expect(inbox[0]!.body).toMatch(/intent-plan.*1 issue/);
    t.trigger.dispose();
  });
  it('uses the current project when the ticket has none', async () => {
    const t = setup({ fallback: true });
    await t.fire();
    expect(t.opened.every((o) => o.projectId === t.other)).toBe(true);
    expect(listInbox(t.registry, t.id, { unreadOnly: false })[0]!.projectId).toBe(t.other);
    t.trigger.dispose();
  });
  it('no project anywhere → nothing runs, the failure is logged', async () => {
    const t = setup();
    await t.fire(() => true);
    expect(t.runs).toEqual([]);
    expect(t.commits).toEqual([]);
    expect(t.debug.join('\n')).toMatch(/no project/);
    t.trigger.dispose();
  });
  it('a disabled review process skips the check and records nothing', async () => {
    const t = setup({ own: true, process: 'off' });
    await t.fire(() => true);
    expect(t.runs).toEqual([]);
    expect(t.commits).toEqual([]);
    expect(listInbox(t.registry, t.id, { unreadOnly: false })).toEqual([]);
    expect(t.debug.join('\n')).toMatch(/review process disabled/);
    t.trigger.dispose();
  });
  it('an edge the ticket approach checks itself is skipped', async () => {
    const t = setup({ own: true, approaches: [{ id: 'mine', label: 'M', checks: ['intent-plan'] }] });
    await t.fire(() => true);
    expect(t.runs).toEqual([]);
    t.trigger.dispose();
  });
  it('a clean report is stored without a message', async () => {
    const t = setup({ own: true, raw: '[]' });
    await t.fire();
    expect(t.commits).toHaveLength(1);
    expect(t.commits[0]!.body).toMatch(/aligned/i);
    expect(listInbox(t.registry, t.id, { unreadOnly: false })).toEqual([]);
    t.trigger.dispose();
  });
  it('a missing manifest still runs the check', async () => {
    const t = setup({ own: true, approaches: undefined, noManifest: true });
    await t.fire();
    expect(t.runs).toHaveLength(1);
    t.trigger.dispose();
  });
  it('a manifest without approaches still runs the check', async () => {
    const t = setup({ own: true, bareManifest: true });
    await t.fire();
    expect(t.runs).toHaveLength(1);
    t.trigger.dispose();
  });
});
