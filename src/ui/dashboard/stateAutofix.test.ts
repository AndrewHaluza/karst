import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setAutopilotOverride, setAutopilotPaused, setAutopilotStopped, setAutopilotStopAfter, takeAutopilotAttempt, markConflictRound } from '../../store/autopilot.js';
import { postAgentNote } from '../../store/bulletinNotes.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { autofixInputOf, readAutofix } from './stateAutofix.js';
import type { AutofixFacts } from '../../model/inside/autofix.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';

const CONFIG: AutopilotConfig = {
  enabled: true,
  ci: { policy: 'auto', maxAttempts: 3, checks: ['lint'] },
  conflicts: { policy: 'auto', maxRounds: 2 },
};

function setup() {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'T-1', title: 't', source: 'manual' });
  return { store, id: t.id };
}

const park = (store: ReturnType<typeof openStore>, id: number, reason: string): void =>
  parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason, runAt: 'x', gates: [] });

describe('readAutofix stop head', () => {
  const REASON = 'auto-fix stopped: ci round made no change';

  it('adds the head a stop applies to when the ticket holds newer commits, and keeps the stop kind', () => {
    const { store, id } = setup();
    park(store, id, REASON);
    setAutopilotStopped(store, id, REASON, '952a97b54aaa');
    const moved = readAutofix(store, id, CONFIG, undefined, true);
    expect(moved.input.parked).toEqual({ kind: 'ci', reason: `${REASON} (autopilot stopped at 952a97b; the head moved since)` });
    expect(readAutofix(store, id, CONFIG).input.parked).toEqual({ kind: 'ci', reason: REASON });
  });

  it('leaves a stop without a recorded head unchanged', () => {
    const { store, id } = setup();
    park(store, id, REASON);
    setAutopilotStopped(store, id, REASON);
    expect(readAutofix(store, id, CONFIG, undefined, true).input.parked).toEqual({ kind: 'ci', reason: REASON });
  });
});

describe('readAutofix', () => {
  it('reports the project default and an inherit override', () => {
    const { store, id } = setup();
    const r = readAutofix(store, id, CONFIG);
    expect(r.slice).toMatchObject({ override: 'inherit', projectDefault: true, effective: true, banner: null });
    expect(r.row).toBeNull();
  });

  it('treats an absent manifest block as off', () => {
    const { store, id } = setup();
    expect(readAutofix(store, id, undefined).slice).toMatchObject({ projectDefault: false, effective: false });
  });

  it('keeps a live round running (Merge all stays off) when the ticket override turns auto-fix off', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'b', 2);
    markConflictRound(store, id, Date.now());
    expect(readAutofix(store, id, CONFIG).slice.roundRunning).toBe(true);
    setAutopilotOverride(store, id, 'off');
    expect(readAutofix(store, id, CONFIG).slice).toMatchObject({ roundRunning: true, effective: false });
  });

  it('follows the ticket override over the project default', () => {
    const { store, id } = setup();
    setAutopilotOverride(store, id, 'off');
    expect(readAutofix(store, id, CONFIG).slice).toMatchObject({ override: 'off', projectDefault: true, effective: false });
  });

  it('reads a paused reason as the Merge row and a banner', () => {
    const { store, id } = setup();
    setAutopilotPaused(store, id, 'auto-fix paused: sandbox is read-only');
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'paused', message: 'paused: sandbox is read-only' });
    expect(r.slice.banner).toMatchObject({ state: 'paused', primary: { act: 'autopilot-retry' } });
  });

  it('reads an armed conflict round as running with the budget counter', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'base1', 2);
    markConflictRound(store, id, Date.now());
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'running', message: expect.stringContaining('round 1 of 2') });
  });

  it('flags roundActive while a conflict round is armed, and not otherwise', () => {
    const { store, id } = setup();
    expect(readAutofix(store, id, CONFIG).slice.roundActive).toBe(false);
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'base1', 2);
    markConflictRound(store, id, Date.now());
    expect(readAutofix(store, id, CONFIG).slice.roundActive).toBe(true);
  });

  it('keeps the stop-after request on a running round', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'base1', 2);
    markConflictRound(store, id, Date.now());
    setAutopilotStopAfter(store, id);
    expect(readAutofix(store, id, CONFIG).row?.stopAfterRequested).toBe(true);
  });

  it('reads the autopilot round notes as attempts, oldest first, and ignores other notes', () => {
    const { store, id } = setup();
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: ci round 1/3', body: 'a' });
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Unrelated', body: 'b' });
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: ci round 2/3', body: 'c' });
    park(store, id, 'auto-fix stopped: ci 3/3');
    const attempts = readAutofix(store, id, CONFIG).row?.attempts ?? [];
    expect(attempts.map((a) => a.label)).toEqual(['attempt 1', 'attempt 2']);
  });

  it('reports CI as open only for an open PR with failing or pending checks', () => {
    const { store, id } = setup();
    expect(readAutofix(store, id, CONFIG).ciOpen).toBe(false);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'lint', url: 'https://x/run' }], failedShown: 1 }));
    expect(readAutofix(store, id, CONFIG).ciOpen).toBe(true);
  });

  it('picks the spent budget of the kind the park names, not the first spent budget', () => {
    const { store, id } = setup();
    for (let i = 0; i < 2; i += 1) takeAutopilotAttempt(store, id, 'web', 'conflicts', 'b', 2);
    for (let i = 0; i < 3; i += 1) takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'lint', url: 'https://x/run' }], failedShown: 1 }));
    park(store, id, 'auto-fix stopped: ci 3/3');
    const r = readAutofix(store, id, CONFIG);
    expect(r.slice.banner?.primary).toMatchObject({ act: 'autopilot-approve-one', repo: 'api', kind: 'ci' });
  });

  it('still names the repo of the kind when the limit was raised after the park', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    park(store, id, 'auto-fix stopped: ci 3/3');
    expect(readAutofix(store, id, CONFIG).slice.banner?.primary).toMatchObject({ repo: 'api', kind: 'ci' });
  });

  it('reads an open PR without a stored CI rollup as unknown, never as a pass', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'api', 88, 'https://x/88', 'open')").run(id);
    expect(readAutofix(store, id, CONFIG).row).toMatchObject({ state: 'unknown', message: 'CI status unknown for api #88. Auto-fix waits; not counted as pass.' });
  });

  it('reads a pending CI rollup into pendingCi, not unknownCi, and a passing one as nothing', () => {
    const { store, id } = setup();
    const rollup = (state: string, pending: number) => JSON.stringify({ state, total: 14, passed: 14 - pending, failed: 0, pending, failing: [], failedShown: 0 });
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, rollup('pending', 4));
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'pending', message: 'CI running for api #88 (4 of 14 pending). Auto-fix waits.' });
    expect(r.input).toMatchObject({ unknownCi: false, pendingCi: true });
    store.db.prepare('UPDATE prs SET checks = ?').run(rollup('passing', 0));
    expect(readAutofix(store, id, CONFIG).row).toBeNull();
  });

  it('reads a null rollup and an unparseable one into unknownCi', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 1, 'https://x/1', 'open', NULL)").run(id);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'web', 2, 'https://x/2', 'open', 'not json')").run(id);
    expect(readAutofix(store, id, CONFIG).row).toMatchObject({ state: 'unknown', message: 'CI status unknown for api #1, web #2. Auto-fix waits; not counted as pass.' });
  });

  it('labels a PR with the manifest repo name and falls back to the raw path', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, '/work/karst', 1056, 'https://x/1', 'open')").run(id);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, '/work/other', 7, 'https://x/7', 'open')").run(id);
    const names = (repo: string): string | undefined => (repo === '/work/karst' ? 'extention' : undefined);
    expect(readAutofix(store, id, CONFIG, names).row?.message).toBe('CI status unknown for extention #1056, /work/other #7. Auto-fix waits; not counted as pass.');
  });

  it('names the manifest repo on a running round and a park target, but keeps the path in the Approve action', () => {
    const { store, id } = setup();
    const names = (repo: string): string | undefined => (repo === '/work/karst' ? 'extention' : undefined);
    takeAutopilotAttempt(store, id, '/work/karst', 'conflicts', 'b', 2);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, '/work/karst', 5, 'https://x/5', 'open')").run(id);
    markConflictRound(store, id, Date.now());
    expect(readAutofix(store, id, CONFIG, names).row?.message).toBe('conflict on extention #5 · round 1 of 2');
    // The PR panel matches the round to its PR by the recorded path, never by the display name.
    expect(readAutofix(store, id, CONFIG, names).input.running?.repo).toBe('/work/karst');
    takeAutopilotAttempt(store, id, '/work/karst', 'ci', 'lint', 3);
    park(store, id, 'auto-fix stopped: ci 3/3');
    const r = readAutofix(store, id, CONFIG, names);
    expect(r.slice.banner?.titleSuffix).toContain('extention #5');
    expect(r.slice.banner?.primary).toMatchObject({ repo: '/work/karst' });
  });

  it('says nothing about unknown CI when auto-fix is off for the ticket', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'api', 88, 'https://x/88', 'open')").run(id);
    setAutopilotOverride(store, id, 'off');
    expect(readAutofix(store, id, CONFIG).row).toBeNull();
  });

  it('ignores a remembered stop reason once the park block is gone', () => {
    const { store, id } = setup();
    setAutopilotStopped(store, id, 'auto-fix stopped: ci 3/3');
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toBeNull();
    expect(r.slice.banner).toBeNull();
  });

  it('names the repo of a running conflict round only when one conflicts budget exists', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'b', 2);
    markConflictRound(store, id, Date.now());
    expect(readAutofix(store, id, CONFIG).row?.message).toBe('conflict on web · round 1 of 2');
    takeAutopilotAttempt(store, id, 'docs', 'conflicts', 'b', 2);
    expect(readAutofix(store, id, CONFIG).row?.message).toBe('conflict · round 1 of 2');
  });

  it('shows a CI attempt as running while the ticket is out of ship and its budget matches the failing checks', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'lint', url: 'https://x/run' }], failedShown: 1 }));
    takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: ci round 1/3', body: 'a' });
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'running', message: 'CI lint on api #88 · attempt 1 of 3' });
  });

  it('fills the banner history from the round notes of the parked kind, oldest first', () => {
    const { store, id } = setup();
    for (const t of ['Autopilot: ci round 1/3', 'Autopilot: conflicts round 1/2', 'Autopilot: ci round 2/3', 'Autopilot: ci round 3/3']) postAgentNote(store, { projectId: null, fromTicketId: id, title: t, body: 'x' });
    park(store, id, 'auto-fix stopped: ci 3/3');
    expect(readAutofix(store, id, CONFIG).slice.banner?.history).toEqual(['ci round 1/3', 'ci round 2/3', 'ci round 3/3']);
  });

  it('keeps the CI round running after Stop after this round posts its note', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'lint', url: 'https://x/run' }], failedShown: 1 }));
    takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: ci round 1/3', body: 'a' });
    setAutopilotStopAfter(store, id);
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: stopped after this round', body: 'b' });
    expect(readAutofix(store, id, CONFIG).row).toMatchObject({ state: 'running', stopAfterRequested: true });
  });

  it('shows no CI round after a manual send-back that left no round note', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'lint', url: 'https://x/run' }], failedShown: 1 }));
    takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    expect(readAutofix(store, id, CONFIG).row).toBeNull();
  });

  it('shows no CI round when the failing checks differ from the budget signature', () => {
    const { store, id } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, 'api', 88, 'https://x/88', 'open', ?)").run(id, JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failing: [{ name: 'typecheck', url: 'https://x/run' }], failedShown: 1 }));
    takeAutopilotAttempt(store, id, 'api', 'ci', 'lint', 3);
    expect(readAutofix(store, id, CONFIG).row).toBeNull();
  });
});

describe('autofixInputOf', () => {
  const facts = (over: Partial<AutofixFacts>): AutofixFacts => ({
    override: 'inherit', projectDefault: true, effective: true, reason: null, round: null,
    stopAfter: false, unknownCi: [], pendingCi: [], target: null, ...over,
  });

  it('reads a running round with its repo and counter; an empty repo is null', () => {
    expect(autofixInputOf(facts({ round: { kind: 'ci', repo: 'api', used: 1, max: 3 } as AutofixFacts['round'] })).running).toEqual({ kind: 'ci', repo: 'api', round: '1/3' });
    expect(autofixInputOf(facts({ round: { kind: 'conflicts', repo: '', used: 2, max: 2 } as AutofixFacts['round'] })).running?.repo).toBeNull();
  });

  it('reads a park by the kind its reason names, and a CI read failure as CI', () => {
    const parked = autofixInputOf(facts({ reason: 'auto-fix paused: CI could not be read' }));
    expect(parked.parked).toEqual({ kind: 'ci', reason: 'auto-fix paused: CI could not be read' });
    expect(parked.running).toBeNull();
  });

  it('lets a running round win over a park, drops a park that names no kind, and flags unknown CI', () => {
    const both = autofixInputOf(facts({ reason: 'auto-fix paused: CI x', round: { kind: 'ci', repo: 'api', used: 1, max: 3 } as AutofixFacts['round'] }));
    expect(both.parked).toBeNull();
    expect(autofixInputOf(facts({ reason: 'auto-fix stopped by you' })).parked).toBeNull();
    expect(autofixInputOf(facts({ unknownCi: ['api #1'], effective: false }))).toMatchObject({ unknownCi: true, effective: false });
    expect(autofixInputOf(facts({ pendingCi: [{ label: 'api #1', pending: 1, total: 2 }] }))).toMatchObject({ unknownCi: false, pendingCi: true });
    expect(autofixInputOf(facts({})).unknownCi).toBe(false);
  });
});
