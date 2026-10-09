import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, setStageCurrent } from './tickets.js';
import { addRelation } from './ticketRelations.js';
import { setStage } from './stages.js';
import { listInbox } from './ticketMessages.js';
import { postAgentNote } from './bulletinNotes.js';
import { openWritableStore } from '../cli/writableStore.js';
import { runCli } from '../cli/main.js';
import { renderTicketContext, buildTicketContext } from '../context/ticketContext.js';
import { buildSessionSeed } from '../agent/seed.js';

/**
 * Landing a blocker through the CLI's node:sqlite store hands its outcome to the
 * dependent's inbox, and `karst context` / the launch seed show it afterwards.
 */
describe('blocker results reach the dependent', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('delivers an event on landing and shows the outcome in context and the seed', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-blk-'));
    const path = join(dir, 'karst.db');
    const host = openStore(path);
    const projectId = upsertProject(host, { slug: 'p' }).id;
    const blocker = createTicket(host, { key: 'B-1', title: 'Widget API', projectId }).id;
    const dependent = createTicket(host, { key: 'D-1', title: 'Use widget', projectId }).id;
    host.db.prepare('UPDATE tickets SET brief = ? WHERE id = ?').run('Add the widget API.', blocker);
    addRelation(host, { ticketId: dependent, kind: 'blocked-by', targetTicketId: blocker, source: 'user' });
    postAgentNote(host, { projectId, fromTicketId: blocker, title: 'gotcha', body: 'use the v2 client' });
    host.close();

    const cli = openWritableStore(path);
    try {
      setStage(cli, blocker, 'done', { status: 'passed' });
      setStageCurrent(cli, blocker, 'done');
    } finally {
      cli.close();
    }

    const check = openStore(path);
    try {
      const rows = listInbox(check, dependent, { unreadOnly: false });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'event', fromTicketId: null });
      expect(rows[0]?.body).toContain('B-1 landed: Widget API');
      expect(rows[0]?.body).toContain('use the v2 client');

      const json = JSON.parse(runCli(['context', 'D-1', '--db', path, '--json'])) as {
        blockers: Array<{ key: string; brief: string }>;
      };
      expect(json.blockers.map((b) => b.key)).toEqual(['B-1']);
      expect(json.blockers[0]?.brief).toBe('Add the widget API.');

      // A launch after landing: the narrative half rides the kickoff.
      const authored = renderTicketContext(buildTicketContext(check, undefined, dependent), undefined, {
        sections: 'narrative',
      });
      const seed = buildSessionSeed({ authoredContext: authored, invocation: '/karst:rpi D-1' });
      expect(seed.kickoff).toContain('## Blockers');
      expect(seed.kickoff).toContain('B-1 landed: Widget API');
    } finally {
      check.close();
    }
  });
});
