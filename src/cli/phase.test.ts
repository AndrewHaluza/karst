import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The phase marker records an EVENT; it must never be able to move the machine.
// Spying on the real `transition` (rather than stubbing it) lets the seeding in
// beforeEach still drive the ticket to impl while the assertions below can prove
// the phase path never reached it.
vi.mock('../workflow/machine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow/machine.js')>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

import { transition } from '../workflow/machine.js';
import { parsePhaseArgs, runPhaseCommand, PHASE_MARK_STAGE } from './phase.js';
import { runCli } from './main.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { setStage } from '../store/stages.js';
import { listPhaseMarks } from '../store/phaseMarks.js';
import { openImplementationRun } from '../store/implementationRuns.js';

describe('parsePhaseArgs', () => {
  it('parses "phase research" into a bare phase name', () => {
    expect(parsePhaseArgs(['phase', 'research'])).toEqual({ phaseName: 'research' });
  });

  it('rejects argv whose command is not "phase"', () => {
    expect(() => parsePhaseArgs(['stage', 'impl', 'pass'])).toThrow(/phase/);
  });

  // A phase mark is an observation, never a verdict. If this shape ever grew a
  // `verdict` field, `stage ship pass`-class forgery would be reachable through
  // a parse path that deliberately has no stage narrowing of its own.
  it('cannot produce a verdict — the parsed shape carries the name and nothing else', () => {
    const parsed = parsePhaseArgs(['phase', 'research']);
    expect(Object.keys(parsed)).toEqual(['phaseName']);
    expect(parsed).not.toHaveProperty('verdict');
    expect(parsed).not.toHaveProperty('stage');
  });

  it.each(['describe', 'research', 'plan', 'implement', 'a', 'a-b_c9', 'Phase3', 'a'.repeat(64)])(
    'accepts the safe phase name "%s"',
    (name) => {
      expect(parsePhaseArgs(['phase', name])).toEqual({ phaseName: name });
    },
  );

  // argv is attacker-reachable: the invoking agent read ticket content it did
  // not author. Re-validate on receipt, exactly as install-time validation does.
  it.each([
    'x; rm -rf ~',
    'a b',
    '$(whoami)',
    '`id`',
    'a|b',
    'a&b',
    '../etc',
    '-leading-dash',
    '_leading-underscore',
    'a"b',
    "a'b",
    'a\nb',
    'a'.repeat(65),
  ])('rejects the unsafe phase name %j', (name) => {
    expect(() => parsePhaseArgs(['phase', name])).toThrow(/letters, digits/);
  });

  it('rejects a missing phase name', () => {
    expect(() => parsePhaseArgs(['phase'])).toThrow();
  });

  it('rejects a blank phase name', () => {
    expect(() => parsePhaseArgs(['phase', '   '])).toThrow();
  });

  // The timestamp is server-generated. Refusing trailing argv is what stops a
  // future caller (or a prompt-injected agent) from smuggling one in.
  it('rejects trailing argv so nothing extra can be smuggled in', () => {
    expect(() => parsePhaseArgs(['phase', 'research', '2001-01-01T00:00:00.000Z'])).toThrow(
      /unexpected/i,
    );
  });
});

describe('runPhaseCommand', () => {
  it('records the mark and returns the phase name', () => {
    const record = vi.fn();
    const store = {} as Store;
    const out = runPhaseCommand(store, 7, ['phase', 'research'], {
      record,
      attemptOf: () => 4,
      now: () => '2026-01-02T03:04:05.000Z',
    });
    expect(record).toHaveBeenCalledWith(store, {
      ticketId: 7,
      stageKey: PHASE_MARK_STAGE,
      attempt: 4,
      phaseName: 'research',
      markedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(out).toBe('research');
  });

  it('records NOTHING when the name fails the charset', () => {
    const record = vi.fn();
    expect(() =>
      runPhaseCommand({} as Store, 7, ['phase', 'x; rm -rf ~'], {
        record,
        attemptOf: () => 4,
        now: () => 'T',
      }),
    ).toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('runCli — phase marker', () => {
  let dir: string;
  let dbPath: string;
  let manifestPath: string;

  /** A ticket at `impl` in project `slug`; returns its id. */
  function seedTicket(seed: Store, slug: string, key: string): number {
    const project = upsertProject(seed, { slug });
    const t = createTicket(seed, { key, title: 'demo', projectId: project.id });
    transition(seed, t.id, 'scope', { kind: 'passed' }); // -> impl
    return t.id;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-phase-'));
    dbPath = join(dir, 'karst.db');
    manifestPath = join(dir, 'karst.yml');
    writeFileSync(
      manifestPath,
      'id: proj-b\n' +
        'host: localhost\n' +
        'portRange: [4000, 4999]\n' +
        'baselineBranch: develop\n' +
        'services:\n' +
        '  api:\n' +
        '    repoPath: ../api\n' +
        '    start: npm run dev\n' +
        '    ports:\n' +
        '      - { name: http, env: PORT, default: 3000 }\n' +
        '    dependsOn: []\n',
    );
    const seed = openStore(dbPath);
    seedTicket(seed, 'proj-a', 'K-1'); // id 1 — the OTHER project's ticket, same key
    const b = seedTicket(seed, 'proj-b', 'K-1'); // id 2 — the manifest's project
    setStage(seed, b, 'impl', { attempt: 3 });
    seed.close();
    vi.mocked(transition).mockClear();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Every mark in the DB, across tickets. */
  function marksFor(ticketId: number) {
    const check = openStore(dbPath);
    try {
      return listPhaseMarks(check, ticketId);
    } finally {
      check.close();
    }
  }

  it('records a reported phase and echoes it', () => {
    const out = runCli([
      'phase',
      'research',
      '--db',
      dbPath,
      '--manifest',
      manifestPath,
      '--ticket',
      'K-1',
    ]);
    expect(out.trim()).toBe('research');

    const marks = marksFor(2);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.phaseName).toBe('research');
    expect(marks[0]!.stageKey).toBe(PHASE_MARK_STAGE);
  });

  // §8: a key two projects share must mark the board the manifest names.
  it('scopes to the manifest’s project, not to whichever row is older', () => {
    runCli(['phase', 'research', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'K-1']);
    expect(marksFor(2)).toHaveLength(1);
    expect(marksFor(1)).toHaveLength(0);
  });

  it('falls back to an unscoped lookup without --manifest, as the stage marker does', () => {
    const out = runCli(['phase', 'research', '--db', dbPath, '--ticket', 'K-1']);
    expect(out.trim()).toBe('research');
    expect(marksFor(1)).toHaveLength(1);
  });

  it('carries the stage’s attempt at the moment the mark landed', () => {
    runCli(['phase', 'plan', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'K-1']);
    expect(marksFor(2)[0]!.attempt).toBe(3);
  });

  it('attributes a phase mark to the ticket’s open implementation run', () => {
    // Resolved server-side in the store writer, never from argv: the timeline
    // filter (model/inside/agent.ts) reads this column, so an unattributed mark
    // would leak the previous run's phases into the current timeline.
    const seed = openStore(dbPath);
    const run = openImplementationRun(seed, {
      ticketId: 2,
      attempt: 3,
      provider: 'claude',
      model: null,
      startedAt: '2026-07-20T12:00:00.000Z',
    });
    seed.close();
    runCli(['phase', 'research', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'K-1']);
    expect(marksFor(2)[0]!.implementationRunId).toBe(run.id);
  });

  it('timestamps server-side, near now', () => {
    const before = Date.now();
    runCli(['phase', 'plan', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'K-1']);
    const markedAt = marksFor(2)[0]!.markedAt;
    expect(markedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    const t = Date.parse(markedAt);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('does not let argv supply the timestamp', () => {
    expect(() =>
      runCli([
        'phase',
        'research',
        '1999-01-01T00:00:00.000Z',
        '--db',
        dbPath,
        '--manifest',
        manifestPath,
        '--ticket',
        'K-1',
      ]),
    ).toThrow();
    expect(marksFor(2)).toHaveLength(0);
  });

  // The whole point of a separate parse path: a phase mark is not a verdict and
  // must never reach the stage machine.
  it('never calls transition and leaves the ticket where it was', () => {
    runCli(['phase', 'research', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'K-1']);
    expect(vi.mocked(transition)).not.toHaveBeenCalled();

    const check = openStore(dbPath);
    const row = check.db
      .prepare('SELECT stage_current FROM tickets WHERE id = ?')
      .get(2) as { stage_current: string };
    check.close();
    expect(row.stage_current).toBe('impl');
  });

  it('rejects a hostile phase name and records nothing', () => {
    expect(() =>
      runCli([
        'phase',
        'x; rm -rf ~',
        '--db',
        dbPath,
        '--manifest',
        manifestPath,
        '--ticket',
        'K-1',
      ]),
    ).toThrow(/letters, digits/);
    expect(marksFor(2)).toHaveLength(0);
    expect(marksFor(1)).toHaveLength(0);
  });

  it('fails loudly on an unknown ticket key, as the stage marker does', () => {
    expect(() =>
      runCli(['phase', 'research', '--db', dbPath, '--manifest', manifestPath, '--ticket', 'NOPE']),
    ).toThrow(/NOPE/);
  });

  it('requires --ticket', () => {
    expect(() => runCli(['phase', 'research', '--db', dbPath])).toThrow(/ticket/);
  });

  it('requires --db', () => {
    expect(() => runCli(['phase', 'research', '--ticket', 'K-1'])).toThrow(/db/);
  });
});
