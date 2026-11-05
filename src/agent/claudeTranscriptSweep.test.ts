import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { recordSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import { dispatchHook } from '../hooks/dispatch.js';
import type { HookPayload } from '../hooks/dispatch.js';
import { claudeTranscriptLocation, encodeClaudeProjectDir, type ClaudeWatchState } from './claudeTranscriptWatch.js';
import { sweepClaudeTranscript } from './claudeTranscriptSweep.js';

const WT = '/repo/.karst/worktrees/x';
const CLONE = '/repo/.karst/sbx-clones/karst-1-claude';
const SESSION = 'sess-sbx';
const LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'm-1',
  message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
});

let store: Store;
let dir: string;
beforeEach(() => {
  store = openStore(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'karst-sweep-'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedTicket(): number {
  const t = createTicket(store, { key: 'S', title: 'sbx usage' });
  store.db
    .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`)
    .run(t.id, WT);
  recordSessionLaunchIntent(store, {
    ticketId: t.id, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
    reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
  });
  dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: SESSION, launchId: 'l1' }, undefined, () => true, () => 'claude');
  return t.id;
}

function deps(over: Partial<Parameters<typeof sweepClaudeTranscript>[0]> = {}) {
  const logs: string[] = [];
  const transcripts: string[] = [];
  return {
    logs,
    transcripts,
    d: {
      stat, readFile: (p: string) => readFile(p, 'utf8'),
      debug: (m: string) => logs.push(m),
      onError: () => undefined,
      onTranscript: (_t: number, _s: string, text: string) => transcripts.push(text),
      dispatch: (p: HookPayload) => dispatchHook(store, p, undefined, () => true, () => 'claude'),
      ...over,
    },
  };
}

describe('sweepClaudeTranscript — sandboxed ticket', () => {
  it('records interactive_usage_samples from a transcript in the bridge directory', async () => {
    const id = seedTicket();
    const bridgeDir = join(dir, 'events', String(id));
    const file = claudeTranscriptLocation({
      placement: { backend: 'sbx' }, hostProjectsDir: join(dir, 'host'), worktreePath: WT,
      sessionId: SESSION, bridgeDir, sandboxCwd: CLONE,
    })!;
    mkdirSync(join(bridgeDir, 'claude-projects', encodeClaudeProjectDir(CLONE)), { recursive: true });
    writeFileSync(file, `${LINE}\n`);
    const { d, transcripts } = deps();
    const state: ClaudeWatchState = { transcriptPath: null, eventId: null, fingerprint: null };

    const outcome = await sweepClaudeTranscript(d, { ticketId: id, sessionId: SESSION, transcriptPath: file, cwd: WT, launchId: 'l1', state });

    expect(outcome).toBe('swept');
    const n = (store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get() as { n: number }).n;
    expect(n).toBe(1);
    // The usage-limit read receives the same sandboxed transcript.
    expect(transcripts).toEqual([`${LINE}\n`]);
  });

  it('logs a [claude] debug line when the transcript is missing', async () => {
    const { d, logs } = deps();
    const state: ClaudeWatchState = { transcriptPath: null, eventId: null, fingerprint: null };
    const outcome = await sweepClaudeTranscript(d, { ticketId: 3, sessionId: 's', transcriptPath: join(dir, 'none.jsonl'), cwd: WT, state });
    expect(outcome).toBe('missing');
    expect(logs.some((l) => l.startsWith('[claude] ticket 3: transcript missing:'))).toBe(true);
  });

  it('skips an unchanged transcript on the next sweep', async () => {
    const id = seedTicket();
    const file = join(dir, 't.jsonl');
    writeFileSync(file, `${LINE}\n`);
    const { d } = deps();
    const state: ClaudeWatchState = { transcriptPath: null, eventId: null, fingerprint: null };
    const input = { ticketId: id, sessionId: SESSION, transcriptPath: file, cwd: WT, launchId: 'l1', state };
    await sweepClaudeTranscript(d, input);
    expect(await sweepClaudeTranscript(d, input)).toBe('unchanged');
  });
});
