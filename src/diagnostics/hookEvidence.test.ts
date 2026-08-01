import { describe, expect, it } from 'vitest'
import { createHookChannelRecorder, normalizeHookEventName } from './hookChannel.js'
import { parseHookFailures, readHookFailureLog } from './hookEvidence.js'
import { hookFailureLogPath } from '../agent/hookFailureLog.js'

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`
}

describe('hook channel counters', () => {
  it('counts outcomes and events and bounds the window', () => {
    let tick = 0
    const recorder = createHookChannelRecorder(
      () => new Date(Date.UTC(2026, 7, 1, 0, 0, tick++)),
    )
    recorder.record('accepted', 'PostToolUse')
    recorder.record('accepted', 'PostToolUse')
    recorder.record('not-found', 'PostToolUse')
    const snapshot = recorder.snapshot()
    expect(snapshot.total).toBe(3)
    expect(snapshot.outcomes).toEqual({ accepted: 2, 'not-found': 1 })
    expect(snapshot.events).toEqual({ PostToolUse: 3 })
    expect(snapshot.firstAt).toBe('2026-08-01T00:00:00.000Z')
    expect(snapshot.lastAt).toBe('2026-08-01T00:00:02.000Z')
  })

  it('collapses an unbounded agent event name to a fixed key', () => {
    // The event name is agent-authored; it must never become a report key.
    expect(normalizeHookEventName('PostToolUse')).toBe('PostToolUse')
    expect(normalizeHookEventName('x'.repeat(64))).toBe('other')
    expect(normalizeHookEventName(undefined)).toBe('absent')
  })

  it('snapshots are detached from later recording', () => {
    const recorder = createHookChannelRecorder()
    const before = recorder.snapshot()
    recorder.record('timeout')
    expect(before.total).toBe(0)
    expect(before.outcomes).toEqual({})
  })
})

describe('codex bridge failure log', () => {
  it('names the file both sides agree on', () => {
    expect(hookFailureLogPath('/storage')).toBe('/storage/codex/hook-failures.jsonl')
  })

  it('totals every failure while capping the verbatim entries', () => {
    const text = [
      line({ at: '2026-08-01T10:00:00.000Z', event: 'PostToolUse', outcome: 'http-error' }),
      line({ at: '2026-08-01T10:00:01.000Z', event: 'PostToolUse', outcome: 'http-error' }),
      line({ at: '2026-08-01T10:00:02.000Z', event: 'Stop', outcome: 'invalid-input' }),
    ].join('')
    const evidence = parseHookFailures(text, 2)
    expect(evidence.byOutcome).toEqual({ 'http-error': 2, 'invalid-input': 1 })
    expect(evidence.byEvent).toEqual({ PostToolUse: 2, Stop: 1 })
    expect(evidence.entries).toHaveLength(2)
    expect(evidence.omitted).toBe(1)
    expect(evidence.oldestAt).toBe('2026-08-01T10:00:00.000Z')
    expect(evidence.newestAt).toBe('2026-08-01T10:00:02.000Z')
  })

  it('refuses unbounded prose from an outcome or event field', () => {
    const evidence = parseHookFailures(
      line({
        at: '2026-08-01T10:00:00.000Z',
        event: 'Bearer sk-live-0123456789abcdef',
        outcome: 'Error: connect ECONNREFUSED 127.0.0.1:9999',
      }),
      10,
    )
    expect(evidence.entries).toEqual([
      { at: '2026-08-01T10:00:00.000Z', event: 'other', outcome: 'unknown' },
    ])
  })

  it('counts lines it cannot attribute to the bridge instead of dropping them silently', () => {
    const evidence = parseHookFailures(
      `not json\n${line({ event: 'Stop', outcome: 'http-error' })}${line({ at: 'nope' })}`,
      10,
    )
    expect(evidence.entries).toEqual([])
    expect(evidence.unparsedLines).toBe(3)
  })

  it('treats a missing log as absence, not as a failure', () => {
    const result = readHookFailureLog('/nowhere/hook-failures.jsonl', 10, () => {
      throw new Error('ENOENT')
    })
    expect(result.present).toBe(false)
    expect(result.evidence.entries).toEqual([])
  })

  it('trusts only the tail when the file is larger than the bridge would ever write', () => {
    const filler = `${'x'.repeat(64 * 1024)}\n`
    const result = readHookFailureLog(
      '/log',
      10,
      () => filler + line({ at: '2026-08-01T10:00:00.000Z', event: 'Stop', outcome: 'http-error' }),
    )
    expect(result.present).toBe(true)
    expect(result.evidence.entries).toHaveLength(1)
    expect(result.evidence.byOutcome).toEqual({ 'http-error': 1 })
  })
})
