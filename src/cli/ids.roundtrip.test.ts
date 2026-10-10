import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';
import { parseId } from '../model/entityId.js';
import { validateProposal } from '../planning/proposal.js';
import { resolveTicketByKey } from './resolveTicket.js';
import { runDraftCommand } from './draftCommand.js';

const SLUG = 'rt';

describe('ticket ids agents are shown resolve back', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('the facts self-line T<n> resolves to the same ticket', () => {
    const project = upsertProject(store, { slug: SLUG });
    const t = createTicket(store, { key: 'RT-1', title: 'Round trip', projectId: project.id });
    const facts = renderTicketContext(buildTicketContext(store, undefined, t.id), undefined, { sections: 'facts' });
    const shown = /\bT\d+\b/.exec(facts.split('\n')[0]!)?.[0];
    expect(shown).toBe(`T${t.id}`);
    expect(resolveTicketByKey(store, shown!, SLUG)?.id).toBe(t.id);
  });

  it('a parent Sub-tasks row resolves to the child, bare and as the full label', () => {
    const project = upsertProject(store, { slug: SLUG });
    const parent = createTicket(store, { key: 'RT-2', title: 'Parent', projectId: project.id });
    const child = createTicket(store, {
      key: 'RT-2-s1',
      title: 'Child',
      projectId: project.id,
      subtaskParentId: parent.id,
    });
    const md = renderTicketContext(buildTicketContext(store, undefined, parent.id));
    const row = /^- (T\d+) · (RT-2-s1):/m.exec(md);
    expect(row).not.toBeNull();
    expect(resolveTicketByKey(store, row![1]!, SLUG)?.id).toBe(child.id);
    expect(resolveTicketByKey(store, `${row![1]} · ${row![2]}`, SLUG)?.id).toBe(child.id);
  });

  it('rejects the wrong kind with messages naming the expected prefix', () => {
    const project = upsertProject(store, { slug: SLUG });
    createTicket(store, { key: 'RT-3', title: 'x', projectId: project.id });
    expect(() => resolveTicketByKey(store, 'D5', SLUG)).toThrow(/T<n>/);
    const bad = validateProposal({ title: 'a', description: 'b', summary: 'c', repos: ['api'], dependsOn: ['T5'] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/D<n>/);
    expect(() => parseId('D5', 'ticket')).toThrow(/T<n>/);
  });
});

describe('draft refs agents are shown feed back as dependsOn', () => {
  let dir: string;
  let outbox: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-idrt-')));
    outbox = join(dir, 'outbox');
    mkdirSync(outbox);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = { title: 'Add auth', description: 'JWT', summary: 'Decided', repos: ['api'] };
  const run = (argv: string[], stdin: string, assignId?: number): string =>
    runDraftCommand(argv, {
      outboxEnv: outbox,
      readStdin: () => stdin,
      timeoutMs: assignId === undefined ? 0 : 10_000,
      now: () => 0,
      sleep: () => {
        const uuid = readdirSync(outbox).find((f) => f.endsWith('.json'))!.replace(/\.json$/, '');
        writeFileSync(
          join(dir, 'proposals.json'),
          JSON.stringify([{ id: assignId, uuid, title: 'Add auth', status: 'pending', updatedAt: 'now' }]),
        );
      },
    });

  it('accepts D<existing>, then the printed ref as dependsOn, and lists the same ref', () => {
    const first = JSON.parse(run(['draft', 'propose'], JSON.stringify({ ...base, dependsOn: ['D3'] }), 7));
    expect(first).toMatchObject({ ok: true, id: 7, ref: 'D7' });
    const second = JSON.parse(run(['draft', 'propose'], JSON.stringify({ ...base, dependsOn: [first.ref] })));
    expect(second.ok).toBe(true);
    const listed = JSON.parse(run(['draft', 'list'], ''));
    expect(listed.map((d: { ref: string }) => d.ref)).toContain(first.ref);
  });
});
