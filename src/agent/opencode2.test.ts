import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Opencode2Adapter,
  buildOpencode2ConfigContent,
  describeOpencode2ErrorEvent,
  parseOpencode2Export,
  parseOpencode2Jsonl,
  parseOpencode2JsonlUsage,
  OPENCODE2_MIN_READINESS_MS,
  type SpawnHeadless,
} from './opencode2.js';
import {
  configureOpencode2,
  isSupportedOpencode2Version,
  opencode2Availability,
  opencode2IsolationEnv,
  parseOpencode2Version,
  resetOpencode2Config,
} from './opencode2Binary.js';
import type { HeadlessSpawnOptions } from './headlessSpawn.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/opencode-v2/${name}`, import.meta.url)), 'utf8');

const RUN_TEXT = fixture('run-text.ndjson');
const RUN_TEXT_2 = fixture('run-text-2.ndjson');
const RUN_TOOL_AUTO = fixture('run-tool-auto.ndjson');
const RUN_TOOL_NOAUTO = fixture('run-tool-noauto.ndjson');
const RUN_ERROR_AUTH = fixture('run-error-provider-auth.ndjson');
const RUN_ERROR_VARIANT = fixture('run-error-variant-unavailable.ndjson');
const SESSION_EXPORT = fixture('session-export.json');

type Call = { command: string; args: string[]; cwd: string; opts?: HeadlessSpawnOptions };

/** A spawn fake: routes `session export` and `run` to their own answers. */
function fakeSpawn(options: {
  run?: { stdout: string; stderr?: string; exitCode: number };
  export?: { stdout: string; stderr?: string; exitCode: number };
  onCall?: (call: Call) => void;
}): { spawn: SpawnHeadless; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: SpawnHeadless = async (command, args, cwd, opts) => {
    const call = { command, args, cwd, opts };
    calls.push(call);
    options.onCall?.(call);
    const isExport = args[0] === 'session';
    const answer = isExport ? options.export : options.run;
    if (!answer) throw new Error(`no fake answer for ${args.join(' ')}`);
    return { stdout: answer.stdout, stderr: answer.stderr ?? '', exitCode: answer.exitCode };
  };
  return { spawn, calls };
}

beforeEach(() => {
  configureOpencode2({ binaryPath: '/opt/opencode2', home: '/gs/opencode2' });
});

afterEach(() => {
  resetOpencode2Config();
});

describe('opencode2 binary + version', () => {
  it('parses a version from the --version line', () => {
    expect(parseOpencode2Version('opencode v2.0.24')).toBe('2.0.24');
    expect(parseOpencode2Version('2.0.30')).toBe('2.0.30');
    expect(parseOpencode2Version('nope')).toBeNull();
  });

  it('accepts >=2.0.24 <3 and refuses v1 and v3', () => {
    expect(isSupportedOpencode2Version('2.0.24')).toBe(true);
    expect(isSupportedOpencode2Version('2.5.0')).toBe(true);
    expect(isSupportedOpencode2Version('1.18.32')).toBe(false);
    expect(isSupportedOpencode2Version('3.0.0')).toBe(false);
  });

  it('reports unset, missing, unsupported and ok with reasons', () => {
    expect(opencode2Availability('', '', 0).state).toBe('unset');
    expect(opencode2Availability('/x', '', 1).state).toBe('missing');
    const v1 = opencode2Availability('/x', 'opencode v1.18.32', 0);
    expect(v1.state).toBe('unsupported');
    const ok = opencode2Availability('/x', 'opencode v2.0.24', 0);
    expect(ok).toMatchObject({ state: 'ok', version: '2.0.24', newerThanFixture: false });
    expect(opencode2Availability('/x', 'opencode v2.1.0', 0)).toMatchObject({
      state: 'ok',
      newerThanFixture: true,
    });
  });

  it('isolates every XDG dir under the karst home and disables autoupdate', () => {
    const env = opencode2IsolationEnv('/gs/opencode2');
    expect(env.XDG_DATA_HOME).toBe('/gs/opencode2/data');
    expect(env.XDG_CONFIG_HOME).toBe('/gs/opencode2/config');
    expect(env.XDG_CACHE_HOME).toBe('/gs/opencode2/cache');
    expect(env.XDG_STATE_HOME).toBe('/gs/opencode2/state');
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(opencode2IsolationEnv('')).toEqual({});
  });

  it('documents a readiness floor of at least 20s for the TUI first token', () => {
    expect(OPENCODE2_MIN_READINESS_MS).toBeGreaterThanOrEqual(20_000);
  });
});

describe('buildOpencode2ConfigContent', () => {
  it('adds the model with the #effort suffix', () => {
    expect(JSON.parse(buildOpencode2ConfigContent({ model: 'opencode-go/mimo-v2.5', headless: false })))
      .toEqual({ model: 'opencode-go/mimo-v2.5' });
    expect(
      JSON.parse(
        buildOpencode2ConfigContent({
          model: 'opencode-go/mimo-v2.5',
          effort: 'high',
          headless: false,
        }),
      ),
    ).toEqual({ model: 'opencode-go/mimo-v2.5#high' });
  });

  it('sets snapshot:false for headless only', () => {
    expect(JSON.parse(buildOpencode2ConfigContent({ headless: true }))).toEqual({ snapshot: false });
    expect(JSON.parse(buildOpencode2ConfigContent({ headless: false }))).toEqual({});
  });
});

describe('parseOpencode2Jsonl', () => {
  it('reads a text-only turn with NO step_finish and no usage', () => {
    const parsed = parseOpencode2Jsonl(RUN_TEXT);
    expect(parsed.sessionId).toBe('ses_eeec175c3ffeBlyB85eTaBi4cN');
    expect(parsed.raw).toBe('pong');
    expect(parsed.usage).toBeUndefined();
  });

  it('reads a second text turn verbatim', () => {
    const parsed = parseOpencode2Jsonl(RUN_TEXT_2);
    expect(parsed.raw).toBe('Hi! 👋');
  });

  it('reads a shell tool turn and derives usage with no tokens.total', () => {
    const parsed = parseOpencode2Jsonl(RUN_TOOL_AUTO);
    expect(parsed.raw).toBe('The command echoed `karst-probe` as its output.');
    expect(parsed.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 23,
      reasoningTokens: 25,
      cacheReadTokens: 16960,
      cacheWriteTokens: 0,
      estimated: false,
    });
    expect(parsed.usage?.totalTokens).toBe(50 + 23 + 25 + 16960);
  });

  it('reads the no-auto shell turn too', () => {
    expect(parseOpencode2Jsonl(RUN_TOOL_NOAUTO).usage).toMatchObject({
      inputTokens: 50,
      reasoningTokens: 1694,
    });
  });

  it('throws a clear launch error for a variant-unavailable event', () => {
    expect(() => parseOpencode2Jsonl(RUN_ERROR_VARIANT)).toThrow(/variant unavailable/i);
  });

  it('maps an auth error event to an actionable message', () => {
    expect(() => parseOpencode2Jsonl(RUN_ERROR_AUTH)).toThrow(/not authenticated/i);
  });

  it('stays a hard failure when no session id is present', () => {
    expect(() =>
      parseOpencode2Jsonl(JSON.stringify({ type: 'text', part: { type: 'text', text: 'x' } })),
    ).toThrow(/session id/);
  });

  it('treats a silent run as an empty answer, not a parse failure', () => {
    expect(
      parseOpencode2Jsonl(JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })).raw,
    ).toBe('');
  });

  it('reads partial usage from a failed run', () => {
    expect(parseOpencode2JsonlUsage(RUN_TOOL_AUTO)).toMatchObject({ outputTokens: 23 });
  });
});

describe('parseOpencode2Export', () => {
  it('reads the cumulative tally from info.tokens', () => {
    expect(parseOpencode2Export(SESSION_EXPORT)).toMatchObject({
      inputTokens: 1350,
      outputTokens: 18,
      reasoningTokens: 25,
      cacheReadTokens: 16384,
      cacheWriteTokens: 0,
    });
  });

  it('returns null for a missing-session export (stderr, not JSON)', () => {
    expect(parseOpencode2Export('Session not found: ses_nope')).toBeNull();
  });
});

describe('describeOpencode2ErrorEvent', () => {
  it('names the variant and the auth case', () => {
    expect(
      describeOpencode2ErrorEvent({
        type: 'provider.no-route',
        message: 'Variant unavailable for a/b: high',
      }).message,
    ).toMatch(/variant unavailable/i);
    expect(
      describeOpencode2ErrorEvent({ type: 'provider.auth', message: 'Missing Authentication header' })
        .message,
    ).toMatch(/not authenticated/i);
  });
});

describe('Opencode2Adapter headless argv/env', () => {
  it('spawns run with --standalone, no rejected flags, and the prompt on stdin', async () => {
    const { spawn, calls } = fakeSpawn({
      run: { stdout: RUN_TEXT, exitCode: 0 },
      export: { stdout: SESSION_EXPORT, exitCode: 0 },
    });
    const adapter = new Opencode2Adapter(spawn);
    const result = await adapter.runHeadless({ prompt: 'hello world', cwd: '/wt' });

    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.command).toBe('/opt/opencode2');
    expect(run.args).toContain('--standalone');
    expect(run.args).not.toContain('--pure');
    expect(run.args).not.toContain('--dir');
    expect(run.args).not.toContain('--variant');
    expect(run.args).not.toContain('hello world');
    expect(run.opts?.stdin).toBe('hello world');
    // The cumulative usage comes from session export, not the stream.
    expect(result.usage).toMatchObject({ inputTokens: 1350 });
    expect(result.raw).toBe('pong');
  });

  it('sets the model as <id>#<effort> and --auto on bypass', async () => {
    const { spawn, calls } = fakeSpawn({
      run: { stdout: RUN_TEXT, exitCode: 0 },
      export: { stdout: SESSION_EXPORT, exitCode: 0 },
    });
    const adapter = new Opencode2Adapter(spawn);
    await adapter.runHeadless({
      prompt: 'go',
      cwd: '/wt',
      model: 'opencode-go/mimo-v2.5',
      effort: 'high',
      permissionMode: 'bypassPermissions',
    });
    const run = calls.find((c) => c.args[0] === 'run')!;
    const i = run.args.indexOf('--model');
    expect(run.args[i + 1]).toBe('opencode-go/mimo-v2.5#high');
    expect(run.args).toContain('--auto');
  });

  it('sets all four XDG vars + autoupdate disable as the isolation env', async () => {
    const { spawn, calls } = fakeSpawn({
      run: { stdout: RUN_TEXT, exitCode: 0 },
      export: { stdout: SESSION_EXPORT, exitCode: 0 },
    });
    const adapter = new Opencode2Adapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt' });
    const run = calls[0]!;
    expect(run.opts?.isolationEnv).toMatchObject({
      XDG_DATA_HOME: '/gs/opencode2/data',
      XDG_CONFIG_HOME: '/gs/opencode2/config',
      XDG_CACHE_HOME: '/gs/opencode2/cache',
      XDG_STATE_HOME: '/gs/opencode2/state',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // Headless-only config: snapshot:false removes the shadow-git cost.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ snapshot: false }),
    });
  });

  it('drops a resume id the pre-check reports missing and launches fresh', async () => {
    const logs: string[] = [];
    const { spawn, calls } = fakeSpawn({
      run: { stdout: RUN_TEXT, exitCode: 0 },
      // First export (the pre-check) is a missing session; the post-run one too.
      export: { stdout: '', stderr: 'Session not found: ses_gone', exitCode: 1 },
      onCall: (c) => {
        if (c.args[0] === 'session') logs.push('probe');
      },
    });
    const adapter = new Opencode2Adapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt', resume: 'ses_gone', debug: (m) => logs.push(m) });
    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).not.toContain('--session');
    expect(run.args).not.toContain('ses_gone');
    expect(logs.some((l) => l.includes('resume id ses_gone not found on opencode2 → fresh launch'))).toBe(true);
  });

  it('keeps a resume id when the pre-check cannot determine (fail-open)', async () => {
    const { spawn, calls } = fakeSpawn({
      run: { stdout: RUN_TEXT, exitCode: 0 },
      export: { stdout: 'not json', exitCode: 0 },
    });
    const adapter = new Opencode2Adapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt', resume: 'ses_live' });
    const run = calls.find((c) => c.args[0] === 'run')!;
    const i = run.args.indexOf('--session');
    expect(run.args[i + 1]).toBe('ses_live');
  });

  it('surfaces a structured error event on a nonzero exit, not raw JSON', async () => {
    const { spawn } = fakeSpawn({
      run: { stdout: RUN_ERROR_VARIANT, exitCode: 1 },
    });
    const adapter = new Opencode2Adapter(spawn);
    await expect(adapter.runHeadless({ prompt: 'go', cwd: '/wt' })).rejects.toThrow(
      /variant unavailable/i,
    );
  });

  it('resolveResume drops a missing id and keeps a live one', async () => {
    const missing = fakeSpawn({
      export: { stdout: '', stderr: 'Session not found: ses_gone', exitCode: 1 },
    });
    const a1 = new Opencode2Adapter(missing.spawn);
    expect(await a1.resolveResume('ses_gone', { cwd: '/wt' })).toBeUndefined();

    const live = fakeSpawn({ export: { stdout: SESSION_EXPORT, exitCode: 0 } });
    const a2 = new Opencode2Adapter(live.spawn);
    expect(await a2.resolveResume('ses_live', { cwd: '/wt' })).toBe('ses_live');
  });
});

describe('Opencode2Adapter interactive argv/env', () => {
  it('launches --standalone with --prompt, no --model, and the config blob', () => {
    const adapter = new Opencode2Adapter(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      model: 'opencode-go/space-bunny',
      effort: 'high',
      initialPrompt: 'kick off',
    });
    expect(cmd.command).toBe('/opt/opencode2');
    expect(cmd.args).toContain('--standalone');
    expect(cmd.args).not.toContain('--model');
    const i = cmd.args.indexOf('--prompt');
    expect(cmd.args[i + 1]).toBe('kick off');
    expect(JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: 'opencode-go/space-bunny#high',
    });
    expect(cmd.env.XDG_DATA_HOME).toBe('/gs/opencode2/data');
  });

  it('adds --session on resume and never inlines the instruction body', () => {
    const adapter = new Opencode2Adapter(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      resume: 'ses_prev',
      initialPrompt: 'go',
      instructions: { path: '/x/karst-instructions.md', body: 'NEVER-INLINE-THIS-BODY' },
    });
    const i = cmd.args.indexOf('--session');
    expect(cmd.args[i + 1]).toBe('ses_prev');
    expect(cmd.args.join(' ')).not.toContain('NEVER-INLINE-THIS-BODY');
    expect(cmd.args.join(' ')).toContain('KARST_INSTRUCTIONS');
  });
});
