import { describe, expect, it } from 'vitest';
import { MAX_BRIDGE_LINE_BYTES, verifyBridgeLine, type BridgeExpectation } from './bridgeVerifier.js';

const expectOf = (over: Partial<BridgeExpectation> = {}): BridgeExpectation => ({
  ticketId: 7,
  worktreePath: '/wt/t7',
  launchId: 'L1',
  stage: () => 'impl',
  sessionId: () => undefined,
  sessionLaunchId: () => undefined,
  ...over,
});
const hook = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: 'hook', ticket: 7, payload: { hook_event_name: 'Notification', message: 'permission_prompt', session_id: 's1', cwd: '/sandbox/repo', ...o } });
const marker = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: 'marker', ticket: 7, stage: 'impl', ...o });

describe('verifyBridgeLine', () => {
  it('accepts an own-ticket hook and rebuilds cwd + launchId from host facts', () => {
    const r = verifyBridgeLine(hook({ launchId: 'FORGED' }), expectOf());
    expect(r).toEqual({
      ok: true,
      event: { kind: 'hook', payload: { hook_event_name: 'Notification', message: 'permission_prompt', session_id: 's1', cwd: '/wt/t7', launchId: 'L1' } },
    });
  });
  it('omits launchId when the session has none', () => {
    const r = verifyBridgeLine(hook(), expectOf({ launchId: undefined }));
    expect(r.ok && r.event.kind === 'hook' && 'launchId' in r.event.payload).toBe(false);
  });
  it('accepts the own-stage marker', () => {
    expect(verifyBridgeLine(marker(), expectOf())).toEqual({ ok: true, event: { kind: 'marker', stage: 'impl' } });
  });
  it('rejects another ticket (hook and marker)', () => {
    expect(verifyBridgeLine(hook({}).replace('"ticket":7', '"ticket":8'), expectOf())).toEqual({ ok: false, reason: 'ticket 8 != 7' });
    expect(verifyBridgeLine(marker({ ticket: 8 }), expectOf())).toEqual({ ok: false, reason: 'ticket 8 != 7' });
  });
  it('rejects a marker for another stage', () => {
    expect(verifyBridgeLine(marker({ stage: 'fix' }), expectOf())).toEqual({ ok: false, reason: 'stage fix != impl' });
  });
  it('rejects a marker while the ticket has no markable stage', () => {
    expect(verifyBridgeLine(marker(), expectOf({ stage: () => 'review' }))).toEqual({ ok: false, reason: 'stage impl != review' });
  });
  it('rejects a non-markable stage name (a gate verdict can never ride the bridge)', () => {
    expect(verifyBridgeLine(marker({ stage: 'ship' }), expectOf({ stage: () => 'ship' }))).toEqual({ ok: false, reason: 'stage ship is not markable' });
  });
  it('rejects a hook from another agent session once one is bound', () => {
    expect(verifyBridgeLine(hook({ session_id: 's2' }), expectOf({ sessionId: () => 's1' }))).toEqual({ ok: false, reason: 'session s2 != s1' });
    expect(verifyBridgeLine(hook({ session_id: 's1' }), expectOf({ sessionId: () => 's1' })).ok).toBe(true);
  });
  describe('relaunch re-bind (bound session from an older launch)', () => {
    const start = (o: Record<string, unknown> = {}) => hook({ hook_event_name: 'SessionStart', session_id: 's2', ...o });
    const older = { sessionId: () => 's1', sessionLaunchId: () => 'L0' };
    it('accepts a new-launch SessionStart with a different id', () => {
      expect(verifyBridgeLine(start(), expectOf(older)).ok).toBe(true);
      expect(verifyBridgeLine(start(), expectOf({ sessionId: () => 's1' })).ok).toBe(true); // unknown launch = older
    });
    it('accepts later lines of the new id once re-bound', () => {
      expect(verifyBridgeLine(hook({ session_id: 's2' }), expectOf({ sessionId: () => 's2', sessionLaunchId: () => 'L1' })).ok).toBe(true);
    });
    it('still rejects a different id while the bound id is of the current launch', () => {
      const cur = { sessionId: () => 's1', sessionLaunchId: () => 'L1' };
      expect(verifyBridgeLine(start(), expectOf(cur))).toEqual({ ok: false, reason: 'session s2 != s1' });
    });
    it('rejects non-SessionStart lines of a new id until the SessionStart re-binds', () => {
      expect(verifyBridgeLine(hook({ session_id: 's2' }), expectOf(older)).ok).toBe(false);
    });
    it('never re-binds without a host launch id', () => {
      expect(verifyBridgeLine(start(), expectOf({ ...older, launchId: undefined })).ok).toBe(false);
    });
  });
  it('rejects malformed JSON, wrong version, unknown kind, non-object, bad ticket type', () => {
    for (const line of ['{not json', '[]', '"x"', JSON.stringify({ v: 2, kind: 'hook', ticket: 7 }), JSON.stringify({ v: 1, kind: 'verdict', ticket: 7 }), JSON.stringify({ v: 1, kind: 'hook', ticket: '7', payload: {} })]) {
      const r = verifyBridgeLine(line, expectOf());
      expect(r.ok).toBe(false);
    }
  });
  it('rejects a hook whose payload lacks a string hook_event_name or session_id', () => {
    expect(verifyBridgeLine(hook({ hook_event_name: 5 }), expectOf()).ok).toBe(false);
    expect(verifyBridgeLine(hook({ session_id: undefined }), expectOf()).ok).toBe(false);
  });
  it('rejects an oversized line without parsing it', () => {
    const big = hook({ message: 'x'.repeat(MAX_BRIDGE_LINE_BYTES) });
    expect(verifyBridgeLine(big, expectOf())).toEqual({ ok: false, reason: 'line too large' });
  });
  it('drops unknown payload fields (only the allowlist survives)', () => {
    const r = verifyBridgeLine(hook({ evil: 'x', ticketId: 99 }), expectOf());
    expect(r.ok && r.event.kind === 'hook' && 'evil' in r.event.payload).toBe(false);
  });

  describe('ack lines (F10)', () => {
    const ack = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'ack', ticket: 7, ref: 'fix-12', ...o });
    it('accepts an own-ticket ack with a token ref', () => {
      expect(verifyBridgeLine(ack(), expectOf())).toEqual({ ok: true, event: { kind: 'ack', ref: 'fix-12' } });
    });
    it('rejects a foreign ticket and a ref that is not a token', () => {
      expect(verifyBridgeLine(ack({ ticket: 8 }), expectOf())).toEqual({ ok: false, reason: 'ticket 8 != 7' });
      for (const ref of ['../x', 'a b', '', 'x'.repeat(65), 12, undefined]) {
        expect(verifyBridgeLine(ack({ ref }), expectOf())).toEqual({ ok: false, reason: 'ack ref is not a token' });
      }
    });
  });
});
