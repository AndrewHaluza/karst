import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from '../hooks/dispatch.js';
import { encodeClaudeProjectDir, type ClaudeWatchState } from './claudeTranscriptWatch.js';
import { sweepGraphClaudeSessions, type GraphClaudeSession } from './graphClaudeSweep.js';

const PLANNER_CWD = '/repo/.karst/worktrees/x';
const SESSION = '3f2b6c1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c';
const LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'm-1',
  message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 52_800 } },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-graph-sweep-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeTranscript(cwd: string, sessionId: string, text: string): void {
  const projectDir = join(dir, encodeClaudeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), text);
}

const GEN = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';

function planner(over: Partial<GraphClaudeSession> = {}): GraphClaudeSession {
  return {
    ticketId: 1368,
    graphRunId: 81,
    runId: 121,
    role: 'planner',
    cwd: PLANNER_CWD,
    provider: 'claude',
    providerSessionId: SESSION,
    generation: GEN,
    placement: 'host',
    ...over,
  };
}

function harness() {
  const posted: HookPayload[] = [];
  const logs: string[] = [];
  const projectsDirs: string[] = [];
  return {
    posted,
    logs,
    projectsDirs,
    deps: {
      stat,
      readFile: (p: string) => readFile(p, 'utf8'),
      debug: (m: string) => logs.push(m),
      onError: () => undefined,
      onTranscript: () => undefined,
      dispatch: (p: HookPayload) => posted.push(p),
      projectsDirFor: (sessionId: string) => {
        projectsDirs.push(sessionId);
        return dir;
      },
    },
  };
}

describe('sweepGraphClaudeSessions (T1370)', () => {
  it('posts one UsageUpdate with the planner cwd and the graph launch id', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    const states = new Map<string, ClaudeWatchState>();
    expect(await sweepGraphClaudeSessions(h.deps, [planner()], states)).toBe(1);
    expect(h.posted).toEqual([
      {
        hook_event_name: 'UsageUpdate',
        cwd: PLANNER_CWD,
        session_id: SESSION,
        launchId: `graph-81-planner-121-${GEN}`,
        usage: { event_id: 'm-1', input: 10, output: 5, cache_read: 2, cache_write: 52_800 },
      },
    ]);
    expect(h.projectsDirs).toEqual([SESSION]);
    expect([...states.keys()]).toEqual([`graph-81-planner-121-${GEN}`]);
  });

  it('posts nothing again for an unchanged transcript', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    const states = new Map<string, ClaudeWatchState>();
    await sweepGraphClaudeSessions(h.deps, [planner()], states);
    await sweepGraphClaudeSessions(h.deps, [planner()], states);
    expect(h.posted).toHaveLength(1);
  });

  it('locates a node transcript under the node workspace cwd with the node launch id', async () => {
    const ws = '/data/graph/81/workspaces/146/app';
    writeTranscript(ws, SESSION, `${LINE}\n`);
    const h = harness();
    await sweepGraphClaudeSessions(h.deps, [planner({ role: 'node', runId: 146, cwd: ws })], new Map());
    expect(h.posted).toMatchObject([{ cwd: ws, launchId: `graph-81-node-146-${GEN}` }]);
  });

  it('posts nothing for a session with no provider session id', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    const states = new Map<string, ClaudeWatchState>();
    expect(await sweepGraphClaudeSessions(h.deps, [planner({ providerSessionId: null })], states)).toBe(0);
    expect(h.posted).toEqual([]);
    expect(states.size).toBe(0);
    expect(h.logs.some((m) => m.includes('no provider session id'))).toBe(true);
  });

  it.each([['opencode2'], [null], [undefined]])('skips a session whose provider is %s', async (provider) => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    await sweepGraphClaudeSessions(h.deps, [planner({ provider })], new Map());
    expect(h.posted).toEqual([]);
  });

  it('skips a sandboxed session with a debug line', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    await sweepGraphClaudeSessions(h.deps, [planner({ placement: 'sandbox' })], new Map());
    expect(h.posted).toEqual([]);
    expect(h.logs.some((m) => m.includes('sandbox placement'))).toBe(true);
    expect(h.logs.some((m) => m.includes(GEN))).toBe(false);
  });

  it('skips a session whose generation is not a UUID with a debug line', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    expect(await sweepGraphClaudeSessions(h.deps, [planner({ generation: 'gen-1' })], new Map())).toBe(0);
    expect(h.posted).toEqual([]);
    expect(h.logs.some((m) => m.includes('not a UUID'))).toBe(true);
  });

  it('posts nothing while the transcript does not exist yet', async () => {
    const h = harness();
    expect(await sweepGraphClaudeSessions(h.deps, [planner()], new Map())).toBe(0);
    expect(h.posted).toEqual([]);
  });

  it('removes the state of a session that is no longer live', async () => {
    writeTranscript(PLANNER_CWD, SESSION, `${LINE}\n`);
    const h = harness();
    const states = new Map<string, ClaudeWatchState>();
    await sweepGraphClaudeSessions(h.deps, [planner()], states);
    expect(states.size).toBe(1);
    await sweepGraphClaudeSessions(h.deps, [], states);
    expect(states.size).toBe(0);
  });
});
