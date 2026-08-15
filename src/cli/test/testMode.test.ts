import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { getTicket, getTicketByKey, listTickets } from '../../store/tickets.js';
import { getProjectBySlug, upsertProject } from '../../store/projects.js';
import { transition } from '../../workflow/machine.js';
import { runCli } from '../main.js';
import { parseTestArgs, runTestCommand } from './main.js';
import { parseCreateTicketArgs, runCreateTicket } from './createTicket.js';
import { parseSetStageArgs, runSetStage } from './setStage.js';
import { parseAdvanceArgs, runAdvance } from './advance.js';
import { parseRunGateArgs, runRunGate } from './runGate.js';
import { parseSimulateHookArgs, runSimulateHook } from './simulateHook.js';
import { parseOpenPrArgs, runOpenPr } from './openPr.js';
import { parseMergePrArgs, runMergePr } from './mergePr.js';
import { runGetState } from './getState.js';
import { parseGetStageArgs, runGetStage } from './getStage.js';
import { parseGetLogsArgs, runGetLogs, parseSince } from './getLogs.js';
import { runGetHooks } from './getHooks.js';
import { parseAssertArgs, runAssert, AssertionMismatchError } from './assert.js';
import { runReset } from './reset.js';
import { listTestHooks, listTestLogs, recordTestLog } from './testMode.js';
import { SCHEMA_VERSION } from '../../store/migrations.js';

/**
 * The agent test driver's own tests (Phase 1 acceptance: "All subcommands have
 * tests that pass under vitest"). The driver tests itself with its own
 * infrastructure — an in-memory store for the unit-level subcommand runs, and a
 * scratch-file DB for the `runCli`-end-to-end and `reset` cases (reset needs a
 * real path: it opens the file before the schema exists).
 */

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
});

function createTicketJson(key: string, title = 'demo'): { id: number; key: string } {
  return JSON.parse(runCreateTicket(store, parseCreateTicketArgs(['--title', title, '--key', key])));
}

describe('parseTestArgs — the `test` verb parser', () => {
  it('accepts every subcommand', () => {
    const subcommands = [
      'create-ticket',
      'set-stage',
      'advance',
      'run-gate',
      'simulate-hook',
      'open-pr',
      'merge-pr',
      'get-state',
      'get-stage',
      'get-logs',
      'get-hooks',
      'assert',
      'reset',
    ];
    for (const sub of subcommands) {
      expect(parseTestArgs(['test', sub]).subcommand).toBe(sub);
    }
  });

  it('rejects a missing or unknown subcommand', () => {
    expect(() => parseTestArgs(['test'])).toThrow(/subcommand/);
    expect(() => parseTestArgs(['test', 'bogus'])).toThrow(/unknown test subcommand 'bogus'/);
    expect(() => parseTestArgs(['context', 'x'])).toThrow(/expected 'test'/);
  });
});

describe('create-ticket', () => {
  it('creates a ticket at scope with all options', () => {
    const out = runCreateTicket(
      store,
      parseCreateTicketArgs(['--title', 'Fix login bug', '--key', 'LOGIN-42', '--type', 'fix', '--approach', 'direct']),
    );
    const parsed = JSON.parse(out) as { id: number; key: string; stageCurrent: string; createdAt: string };
    expect(parsed).toMatchObject({ key: 'LOGIN-42', stageCurrent: 'scope' });
    expect(typeof parsed.id).toBe('number');
    expect(parsed.createdAt).toBeTruthy();

    const ticket = getTicket(store, parsed.id);
    expect(ticket.type).toBe('fix');
    expect(ticket.approach).toBe('direct');
    expect(ticket.stages).toHaveLength(7);
  });

  it('is idempotent by key', () => {
    const first = JSON.parse(runCreateTicket(store, parseCreateTicketArgs(['--title', 'A', '--key', 'T-1']))) as { id: number };
    const second = JSON.parse(runCreateTicket(store, parseCreateTicketArgs(['--title', 'A', '--key', 'T-1']))) as { id: number };
    expect(second.id).toBe(first.id);
  });

  it('requires a title', () => {
    expect(() => runCreateTicket(store, parseCreateTicketArgs(['--key', 'K-1']))).toThrow(/title/);
  });

  it('rejects an unknown ticket type', () => {
    expect(() =>
      runCreateTicket(store, parseCreateTicketArgs(['--title', 'A', '--key', 'T-1', '--type', 'nope'])),
    ).toThrow(/unknown ticket type/);
  });

  it('scopes the ticket to --project <slug> so it appears on that board', () => {
    const project = upsertProject(store, { slug: 'acme' });
    const out = runCreateTicket(
      store,
      parseCreateTicketArgs(['--title', 'Scoped', '--key', 'SCOPED-1', '--project', 'acme']),
    );
    const parsed = JSON.parse(out) as { id: number; projectId: number | null; project: string | null };
    expect(parsed.projectId).toBe(project.id);
    expect(parsed.project).toBe('acme');

    const ticket = getTicket(store, parsed.id);
    expect(ticket.projectId).toBe(project.id);
    // The whole point: the ticket is visible on the project's board.
    expect(listTickets(store, { projectId: project.id }).map((t) => t.key)).toContain('SCOPED-1');
  });

  it('creates the project row on first sight when --project names an unknown slug', () => {
    const out = runCreateTicket(
      store,
      parseCreateTicketArgs(['--title', 'Fresh', '--key', 'FRESH-1', '--project', 'brand-new']),
    );
    const parsed = JSON.parse(out) as { id: number; projectId: number | null };
    expect(parsed.projectId).not.toBeNull();
    const project = getProjectBySlug(store, 'brand-new');
    expect(project).toBeDefined();
    expect(parsed.projectId).toBe(project!.id);
    expect(listTickets(store, { projectId: project!.id }).map((t) => t.key)).toContain('FRESH-1');
  });

  it('uses the manifest-derived projectSlug as a fallback when --project is absent', () => {
    const project = upsertProject(store, { slug: 'acme' });
    const out = runTestCommand(store, undefined, 'acme', [
      'test',
      'create-ticket',
      '--title',
      'Fallback',
      '--key',
      'FALLBACK-1',
    ]);
    const parsed = JSON.parse(out) as { projectId: number | null };
    expect(parsed.projectId).toBe(project.id);
  });

  it('lets an explicit --project flag win over the manifest-derived slug', () => {
    upsertProject(store, { slug: 'from-manifest' });
    const explicit = upsertProject(store, { slug: 'explicit' });
    const out = runTestCommand(store, undefined, 'from-manifest', [
      'test',
      'create-ticket',
      '--title',
      'Wins',
      '--key',
      'WINS-1',
      '--project',
      'explicit',
    ]);
    const parsed = JSON.parse(out) as { projectId: number | null };
    expect(parsed.projectId).toBe(explicit.id);
  });

  it('keeps idempotency per project: the same key in two projects is two tickets', () => {
    const a = upsertProject(store, { slug: 'pa' });
    const b = upsertProject(store, { slug: 'pb' });
    const first = JSON.parse(
      runCreateTicket(store, parseCreateTicketArgs(['--title', 'A', '--key', 'T-1', '--project', 'pa'])),
    ) as { id: number };
    const second = JSON.parse(
      runCreateTicket(store, parseCreateTicketArgs(['--title', 'A', '--key', 'T-1', '--project', 'pb'])),
    ) as { id: number };
    expect(second.id).not.toBe(first.id);
    expect(getTicketByKey(store, 'T-1', { projectId: a.id })?.id).toBe(first.id);
    expect(getTicketByKey(store, 'T-1', { projectId: b.id })?.id).toBe(second.id);
  });
});

describe('set-stage', () => {
  it('moves a ticket directly and validates stage keys', () => {
    const t = createTicketJson('T-1');
    const out = runSetStage(store, t.id, parseSetStageArgs(['--stage', 'uat', '--status', 'running']));
    expect(JSON.parse(out)).toEqual({ stageKey: 'uat', status: 'running', block: null });
    expect(getTicket(store, t.id).stageCurrent).toBe('uat');
    expect(getTicket(store, t.id).stages.find((s) => s.stageKey === 'uat')?.status).toBe('running');
  });

  it('refuses done', () => {
    const t = createTicketJson('T-1');
    expect(() => runSetStage(store, t.id, parseSetStageArgs(['--stage', 'done', '--status', 'passed']))).toThrow(
      /done/,
    );
  });

  it('refuses an unknown stage or status', () => {
    const t = createTicketJson('T-1');
    expect(() => runSetStage(store, t.id, parseSetStageArgs(['--stage', 'bogus', '--status', 'running']))).toThrow(/unknown stage/);
    expect(() => runSetStage(store, t.id, parseSetStageArgs(['--stage', 'uat', '--status', 'bogus']))).toThrow(/unknown stage status/);
  });

  it('seeds an awaiting-merge block so the merge gate can settle a ship', () => {
    const t = createTicketJson('T-1');
    runSetStage(
      store,
      t.id,
      parseSetStageArgs([
        '--stage', 'ship', '--status', 'passed',
        '--block', 'awaiting-merge', '--block-reason', 'blocked: PR open',
      ]),
    );
    const stage = getTicket(store, t.id).stages.find((s) => s.stageKey === 'ship')!;
    expect(stage.status).toBe('passed');
    expect(stage.blockedKind).toBe('awaiting-merge');
    expect(stage.blockedReason).toBe('blocked: PR open');
  });

  it('requires --block-reason when --block is given', () => {
    const t = createTicketJson('T-1');
    expect(() => runSetStage(store, t.id, parseSetStageArgs(['--stage', 'ship', '--status', 'passed', '--block', 'awaiting-merge']))).toThrow(
      /--block-reason/,
    );
  });
});

describe('advance', () => {
  it('injects a verdict and returns {from, next}', () => {
    const t = createTicketJson('T-1');
    const out = runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed']));
    expect(JSON.parse(out)).toEqual({ from: 'scope', next: 'impl', stageCurrent: 'impl' });
    expect(getTicket(store, t.id).stages.find((s) => s.stageKey === 'scope')?.status).toBe('passed');
    expect(getTicket(store, t.id).stages.find((s) => s.stageKey === 'impl')?.status).toBe('running');
  });

  it('records a failure reason and routes uat → fix', () => {
    const t = createTicketJson('T-1');
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // scope→impl
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // impl→uat
    const out = runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'failed', '--reason', 'gate failed']));
    expect(JSON.parse(out)).toMatchObject({ from: 'uat', next: 'fix', stageCurrent: 'fix' });
    const uat = getTicket(store, t.id).stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.status).toBe('failed');
    expect(uat.verdict).toBe('gate failed');
  });

  it('rejects an unknown verdict', () => {
    const t = createTicketJson('T-1');
    expect(() => runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'maybe']))).toThrow(/unknown verdict/);
  });

  it('throws when the machine has no edge for the verdict (fail at ship)', () => {
    const t = createTicketJson('T-1');
    for (const stage of ['scope', 'impl', 'uat', 'review'] as const) {
      transition(store, t.id, stage, { kind: 'passed' });
    }
    // now at ship
    expect(() => runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'failed']))).toThrow(/no failed edge/);
  });
});

describe('run-gate', () => {
  it('writes a gate_runs row under the current attempt', () => {
    const t = createTicketJson('T-1');
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed']));
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // impl→uat
    const out = runRunGate(store, t.id, parseRunGateArgs(['--stage', 'uat', '--gate', 'npm test', '--exit-code', '0']));
    const parsed = JSON.parse(out) as { stage: string; gate: string; exitCode: number; attempt: number };
    expect(parsed).toMatchObject({ stage: 'uat', gate: 'npm test', exitCode: 0, attempt: 0 });

    const row = store.db
      .prepare('SELECT stage_key, gate_name, exit_code, attempt FROM gate_runs WHERE ticket_id = ?')
      .get(t.id) as { stage_key: string; gate_name: string; exit_code: number; attempt: number };
    expect(row).toEqual({ stage_key: 'uat', gate_name: 'npm test', exit_code: 0, attempt: 0 });
  });

  it('honors an explicit --attempt and stores stdout/stderr as a gate test-log', () => {
    const t = createTicketJson('T-1');
    runRunGate(
      store,
      t.id,
      parseRunGateArgs(['--stage', 'uat', '--gate', 'lint', '--exit-code', '1', '--attempt', '2', '--stdout', 'oops', '--stderr', 'lint error']),
    );
    const row = store.db
      .prepare('SELECT exit_code, attempt FROM gate_runs WHERE gate_name = ?')
      .get('lint') as { exit_code: number; attempt: number };
    expect(row).toEqual({ exit_code: 1, attempt: 2 });

    const logs = listTestLogs(store, { ticketId: t.id });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.module).toBe('[gate]');
    expect(logs[0]!.meta).toMatchObject({ gate: 'lint', exitCode: 1, stdout: 'oops', stderr: 'lint error' });
  });

  it('rejects a non-gate stage or a non-integer exit code', () => {
    const t = createTicketJson('T-1');
    expect(() => runRunGate(store, t.id, parseRunGateArgs(['--stage', 'impl', '--gate', 'x', '--exit-code', '0']))).toThrow(
      /stage must be one of uat, review/,
    );
    expect(() => runRunGate(store, t.id, parseRunGateArgs(['--stage', 'uat', '--gate', 'x', '--exit-code', 'abc']))).toThrow(
      /integer/,
    );
  });
});

describe('simulate-hook', () => {
  it('dispatches SessionStart → running and records the event', () => {
    const t = getTicketByKey(store, createTicketJson('H-1').key)!;
    const out = runSimulateHook(
      store,
      t,
      parseSimulateHookArgs(['--event', 'SessionStart', '--session-id', 'sess_abc']),
    );
    expect(JSON.parse(out)).toEqual({ agentState: 'running', hooksRecorded: 1 });
    expect(getTicket(store, t.id).agentState).toBe('running');

    const hooks = listTestHooks(store, t.id);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: 'SessionStart', sessionId: 'sess_abc', agentStateAfter: 'running' });
  });

  it('SessionEnd → idle, and PostToolUse flips a wait back to running', () => {
    const t = getTicketByKey(store, createTicketJson('H-1').key)!;
    runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'SessionStart']));
    const end = runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'SessionEnd']));
    expect(JSON.parse(end)).toMatchObject({ agentState: 'idle' });

    runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'PostToolUse']));
    expect(getTicket(store, t.id).agentState).toBe('running');
  });

  it('Notification with a waiting kind → waiting (the amber signal)', () => {
    const t = getTicketByKey(store, createTicketJson('H-1').key)!;
    const out = runSimulateHook(
      store,
      t,
      parseSimulateHookArgs(['--event', 'Notification', '--notification-type', 'permission_prompt']),
    );
    expect(JSON.parse(out)).toMatchObject({ agentState: 'waiting' });
  });

  it('rejects an unknown event', () => {
    const t = getTicketByKey(store, createTicketJson('H-1').key)!;
    expect(() => runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'Bogus']))).toThrow(/unknown hook event/);
  });
});

describe('open-pr / merge-pr', () => {
  it('open-pr inserts a PR row with a derived URL', () => {
    const t = createTicketJson('P-1');
    const out = runOpenPr(store, t.id, parseOpenPrArgs(['--repo', 'app', '--number', '100', '--head', 'karst/fix', '--base', 'main', '--status', 'open']));
    expect(JSON.parse(out)).toMatchObject({ repo: 'app', number: 100, status: 'open' });

    const row = store.db
      .prepare('SELECT repo, number, status, head_ref, base_ref FROM prs WHERE ticket_id = ?')
      .get(t.id) as { repo: string; number: number; status: string; head_ref: string; base_ref: string };
    expect(row).toEqual({ repo: 'app', number: 100, status: 'open', head_ref: 'karst/fix', base_ref: 'main' });
  });

  it('merge-pr merges the PR and lands a parked ship → done', () => {
    const t = createTicketJson('P-1');
    // drive to ship
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // scope→impl
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // impl→uat
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // uat→review
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // review→ship
    runOpenPr(store, t.id, parseOpenPrArgs(['--repo', 'app', '--number', '7']));
    // park the ship awaiting-merge, exactly like a real ship's tail
    runSetStage(
      store,
      t.id,
      parseSetStageArgs(['--stage', 'ship', '--status', 'passed', '--block', 'awaiting-merge', '--block-reason', 'waiting']),
    );

    const out = runMergePr(store, t.id, parseMergePrArgs(['--repo', 'app']));
    expect(JSON.parse(out)).toMatchObject({ repo: 'app', number: 7, status: 'merged', advanced: true });
    expect(getTicket(store, t.id).stageCurrent).toBe('done');
    const ship = getTicket(store, t.id).stages.find((s) => s.stageKey === 'ship')!;
    expect(ship.blockedKind).toBeNull(); // block cleared on landing
  });

  it('merge-pr throws when no PR row exists for the repo', () => {
    const t = createTicketJson('P-1');
    expect(() => runMergePr(store, t.id, parseMergePrArgs(['--repo', 'app']))).toThrow(/open one first/);
  });
});

describe('get-state / get-stage', () => {
  it('get-state returns the full snapshot', () => {
    const t = createTicketJson('S-1');
    runRunGate(store, t.id, parseRunGateArgs(['--stage', 'uat', '--gate', 'lint', '--exit-code', '0']));
    runOpenPr(store, t.id, parseOpenPrArgs(['--repo', 'app', '--number', '3']));

    const state = JSON.parse(runGetState(store, t.id)) as {
      ticket: { key: string; stageCurrent: string };
      stages: unknown[];
      gateRuns: unknown[];
      prs: unknown[];
      hookEvents: unknown[];
      blocks: unknown[];
    };
    expect(state.ticket).toMatchObject({ key: 'S-1', stageCurrent: 'scope' });
    expect(state.stages).toHaveLength(7);
    expect(state.gateRuns).toHaveLength(1);
    expect(state.prs).toHaveLength(1);
    expect(state.hookEvents).toEqual([]);
    expect(state.blocks).toEqual([]);
  });

  it('get-stage returns the stage row plus its gate runs and findings', () => {
    const t = createTicketJson('S-1');
    runRunGate(store, t.id, parseRunGateArgs(['--stage', 'uat', '--gate', 'lint', '--exit-code', '0']));
    const out = JSON.parse(runGetStage(store, t.id, parseGetStageArgs(['--stage', 'uat']))) as {
      stageKey: string;
      gateRuns: unknown[];
      findings: unknown[];
    };
    expect(out.stageKey).toBe('uat');
    expect(out.gateRuns).toHaveLength(1);
    expect(out.findings).toEqual([]);
  });

  it('get-stage rejects an unknown stage', () => {
    const t = createTicketJson('S-1');
    expect(() => runGetStage(store, t.id, parseGetStageArgs(['--stage', 'bogus']))).toThrow(/unknown stage/);
  });
});

describe('get-logs / get-hooks', () => {
  it('filters by level, pattern and ticket', () => {
    const t = createTicketJson('L-1');
    recordTestLog(store, { ticketId: t.id, level: 'error', module: '[gate]', message: 'gate failed: lint', meta: { exit: 1 } });
    recordTestLog(store, { ticketId: t.id, level: 'info', module: '[driver]', message: 'created ticket' });
    recordTestLog(store, { level: 'info', module: '[driver]', message: 'untagged' });

    expect(runGetLogs(store, null, parseGetLogsArgs(['--level', 'error']))).toContain('gate failed: lint');
    const info = JSON.parse(runGetLogs(store, t.id, parseGetLogsArgs(['--level', 'info']))) as { message: string }[];
    expect(info).toHaveLength(1);
    expect(info[0]!.message).toBe('created ticket');
    const pattern = JSON.parse(runGetLogs(store, t.id, parseGetLogsArgs(['--pattern', 'gate']))) as { message: string }[];
    expect(pattern).toHaveLength(1);
  });

  it('filters --since as a duration cutoff', () => {
    const t = createTicketJson('L-1');
    recordTestLog(store, { ticketId: t.id, level: 'info', module: '[driver]', message: 'recent' });
    const cutoff = parseSince('5m', new Date());
    const rows = JSON.parse(runGetLogs(store, t.id, parseGetLogsArgs(['--since', '5m']))) as { message: string }[];
    expect(rows.map((r) => r.message)).toContain('recent');
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => parseSince('soon')).toThrow(/invalid --since/);
  });

  it('get-hooks returns dispatched events in order', () => {
    const t = getTicketByKey(store, createTicketJson('L-1').key)!;
    runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'SessionStart', '--session-id', 's1']));
    runSimulateHook(store, t, parseSimulateHookArgs(['--event', 'PostToolUse']));
    const hooks = JSON.parse(runGetHooks(store, t.id)) as { event: string; agentState: string }[];
    expect(hooks.map((h) => h.event)).toEqual(['SessionStart', 'PostToolUse']);
    expect(hooks[0]!.agentState).toBe('running');
  });
});

describe('assert', () => {
  it('passes on a match and returns {ok:true}', () => {
    const t = createTicketJson('A-1');
    const out = runAssert(store, t.id, parseAssertArgs(['--expect', '{"stageCurrent":"scope","agentState":"none"}']));
    expect(out).toBe(JSON.stringify({ ok: true }));
  });

  it('throws AssertionMismatchError with a leaf diff on mismatch', () => {
    const t = createTicketJson('A-1');
    try {
      runAssert(store, t.id, parseAssertArgs(['--expect', '{"stageCurrent":"done","agentState":"idle"}']));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionMismatchError);
      expect((e as AssertionMismatchError).diff).toEqual({
        stageCurrent: { expected: 'done', actual: 'scope' },
        agentState: { expected: 'idle', actual: 'none' },
      });
    }
  });

  it('compares nested stages', () => {
    const t = createTicketJson('A-1');
    runAdvance(store, t.id, parseAdvanceArgs(['--verdict', 'passed'])); // impl running
    const out = runAssert(store, t.id, parseAssertArgs(['--expect', '{"stages":{"scope":"passed","impl":"running"}}']));
    expect(out).toBe(JSON.stringify({ ok: true }));
  });

  it('rejects non-object JSON', () => {
    const t = createTicketJson('A-1');
    expect(() => runAssert(store, t.id, parseAssertArgs(['--expect', '"str"']))).toThrow(/JSON object/);
    expect(() => runAssert(store, t.id, parseAssertArgs(['--expect', '{bad']))).toThrow(/JSON object/);
  });
});

describe('reset', () => {
  it('drops and recreates all tables on a scratch file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-test-driver-'));
    try {
      const dbPath = join(dir, 'karst.db');
      const seeded = openStore(dbPath);
      createTicketJsonHelper(seeded, 'KEEP-1');
      seeded.close();

      expect(runReset(dbPath)).toBe(JSON.stringify({ ok: true }));

      const reopened = openStore(dbPath);
      const tables = reopened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.some((t) => t.name === 'tickets')).toBe(true);
      expect(tables.some((t) => t.name === 'test_logs')).toBe(true);
      expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a fresh registry when the file does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-test-driver-'));
    try {
      const dbPath = join(dir, 'brand-new.db');
      expect(runReset(dbPath)).toBe(JSON.stringify({ ok: true }));
      const store2 = openStore(dbPath);
      expect(store2.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('end-to-end via runCli', () => {
  it('runs the full workflow the ticket ships', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-test-driver-'));
    try {
      const db = join(dir, 'karst.db');

      expect(runCli(['test', 'reset', '--db', db])).toBe(JSON.stringify({ ok: true }));

      const created = JSON.parse(
        runCli(['test', 'create-ticket', '--db', db, '--title', 'Fix login', '--key', 'LOGIN-1', '--type', 'fix']),
      ) as { id: number; key: string; stageCurrent: string };
      expect(created).toMatchObject({ key: 'LOGIN-1', stageCurrent: 'scope' });

      const advance1 = JSON.parse(runCli(['test', 'advance', '--db', db, '--ticket', 'LOGIN-1', '--verdict', 'passed']));
      expect(advance1).toMatchObject({ from: 'scope', next: 'impl' });

      const started = JSON.parse(runCli(['test', 'simulate-hook', '--db', db, '--ticket', 'LOGIN-1', '--event', 'SessionStart', '--session-id', 'sess1']));
      expect(started).toMatchObject({ agentState: 'running' });
      const ended = JSON.parse(runCli(['test', 'simulate-hook', '--db', db, '--ticket', 'LOGIN-1', '--event', 'SessionEnd']));
      expect(ended).toMatchObject({ agentState: 'idle' });

      expect(runCli(['test', 'assert', '--db', db, '--ticket', 'LOGIN-1', '--expect', '{"agentState":"idle"}'])).toBe(
        JSON.stringify({ ok: true }),
      );

      // impl marker (the real agent verb) → uat
      expect(runCli(['stage', 'impl', 'pass', '--db', db, '--ticket', 'LOGIN-1']).trim()).toBe('uat');

      // uat gate passes → review → ship
      runCli(['test', 'run-gate', '--db', db, '--ticket', 'LOGIN-1', '--stage', 'uat', '--gate', 'npm test', '--exit-code', '0', '--stdout', '1 passed']);
      runCli(['test', 'advance', '--db', db, '--ticket', 'LOGIN-1', '--verdict', 'passed']);
      runCli(['test', 'advance', '--db', db, '--ticket', 'LOGIN-1', '--verdict', 'passed']);

      // ship: open a PR, park awaiting-merge, land it
      runCli(['test', 'open-pr', '--db', db, '--ticket', 'LOGIN-1', '--repo', 'app', '--number', '100', '--status', 'open']);
      runCli([
        'test', 'set-stage', '--db', db, '--ticket', 'LOGIN-1',
        '--stage', 'ship', '--status', 'passed',
        '--block', 'awaiting-merge', '--block-reason', 'waiting',
      ]);
      const merged = JSON.parse(runCli(['test', 'merge-pr', '--db', db, '--ticket', 'LOGIN-1', '--repo', 'app']));
      expect(merged).toMatchObject({ status: 'merged', advanced: true });

      expect(runCli(['test', 'assert', '--db', db, '--ticket', 'LOGIN-1', '--expect', '{"stageCurrent":"done","agentState":"idle"}'])).toBe(
        JSON.stringify({ ok: true }),
      );

      // get-state / get-hooks / get-logs read the assembled evidence
      const state = JSON.parse(runCli(['test', 'get-state', '--db', db, '--ticket', 'LOGIN-1', '--json'])) as {
        ticket: { stageCurrent: string };
        gateRuns: unknown[];
        prs: unknown[];
        hookEvents: unknown[];
      };
      expect(state.ticket.stageCurrent).toBe('done');
      expect(state.gateRuns).toHaveLength(1);
      expect(state.prs).toHaveLength(1);
      expect(state.hookEvents).toHaveLength(2);

      const hooks = JSON.parse(runCli(['test', 'get-hooks', '--db', db, '--ticket', 'LOGIN-1', '--json'])) as { event: string }[];
      expect(hooks.map((h) => h.event)).toEqual(['SessionStart', 'SessionEnd']);

      const logs = JSON.parse(runCli(['test', 'get-logs', '--db', db, '--ticket', 'LOGIN-1', '--level', 'info', '--json'])) as { message: string }[];
      expect(logs.some((l) => l.message.includes('npm test'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assert exits as a mismatch through runCli (throws with the diff)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-test-driver-'));
    try {
      const db = join(dir, 'karst.db');
      runCli(['test', 'reset', '--db', db]);
      runCli(['test', 'create-ticket', '--db', db, '--title', 'A', '--key', 'A-1']);
      try {
        runCli(['test', 'assert', '--db', db, '--ticket', 'A-1', '--expect', '{"stageCurrent":"done"}']);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AssertionMismatchError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown subcommand and requires --db', () => {
    expect(() => runCli(['test', 'bogus', '--db', 'x.db'])).toThrow(/unknown test subcommand/);
    expect(() => runCli(['test', 'get-state', '--ticket', 'A-1'])).toThrow(/db/);
  });

  it('create-ticket falls back to the manifest project slug through runCli', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-test-driver-'));
    try {
      const db = join(dir, 'karst.db');
      const manifestPath = join(dir, 'karst.yml');
      writeFileSync(
        manifestPath,
        'id: proj-cli\n' +
          'host: localhost\n' +
          'portRange: [4000, 4999]\n' +
          'baselineBranch: develop\n' +
          'repositories:\n' +
          '  api:\n' +
          '    repoPath: ../api\n',
      );
      runCli(['test', 'reset', '--db', db]);

      const created = JSON.parse(
        runCli([
          'test',
          'create-ticket',
          '--db',
          db,
          '--manifest',
          manifestPath,
          '--title',
          'Via manifest',
          '--key',
          'MANIFEST-1',
        ]),
      ) as { id: number; projectId: number | null };
      expect(created.projectId).not.toBeNull();

      const check = openStore(db);
      try {
        const project = getProjectBySlug(check, 'proj-cli');
        expect(project).toBeDefined();
        expect(created.projectId).toBe(project!.id);
        expect(listTickets(check, { projectId: project!.id }).map((t) => t.key)).toContain(
          'MANIFEST-1',
        );
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Helpers kept local to this suite so the unit tests above can share the exact
// create helper the reset test needs without widening the module surface.
function createTicketJsonHelper(store2: Store, key: string): void {
  JSON.parse(runCreateTicket(store2, parseCreateTicketArgs(['--title', 'seed', '--key', key])));
}

// The dispatcher is exercised end-to-end through runCli above; a couple of
// direct checks pin the not-found-ticket path.
describe('runTestCommand dispatch', () => {
  it('fails with a clear message for an unknown ticket key', () => {
    expect(() => runTestCommand(store, 'NOPE', undefined, ['test', 'get-state'])).toThrow(/no ticket found for key 'NOPE'/);
  });

  it('requires --ticket for subcommands that target one', () => {
    expect(() => runTestCommand(store, undefined, undefined, ['test', 'get-state'])).toThrow(/--ticket/);
  });
});
