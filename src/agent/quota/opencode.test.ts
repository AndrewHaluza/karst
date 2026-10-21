import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  opencodeAuthPath,
  opencodeQuotaReader,
  parseOpencodeUsage,
  readOpencodeQuota,
  resolveOpencodeKey,
  serverErrorMessage,
} from './opencode.js';

const NOW = new Date('2026-10-21T00:05:00.000Z');

const LIVE_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 3, resetsAt: '2026-10-21T01:15:02.000Z' },
    weekly: { status: 'ok', percent: 9, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 82, resetsAt: '2026-11-06T10:04:02.000Z' },
  },
};

const OK_WINDOWS = [
  { label: '5-hour', usedPct: 3, resetsAt: '2026-10-21T01:15:02.000Z' },
  { label: 'Weekly', usedPct: 9, resetsAt: '2026-10-26T00:00:00.000Z' },
  { label: 'Monthly', usedPct: 82, resetsAt: '2026-11-06T10:04:02.000Z' },
];

let home: string;
let authPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'karst-opencode-quota-'));
  authPath = join(home, 'auth.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeAuth(entries: Record<string, unknown>): void {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(authPath, JSON.stringify(entries));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okFetch(payload: unknown = LIVE_USAGE): typeof fetch {
  return vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
}

function deps(overrides: Partial<Parameters<typeof readOpencodeQuota>[0]> = {}) {
  writeAuth({ 'opencode-go': { type: 'api', key: 'go-key' } });
  return {
    core: 'opencode' as const,
    authPath,
    env: {},
    now: () => NOW,
    ...overrides,
  };
}

describe('opencodeAuthPath', () => {
  it('uses XDG_DATA_HOME when set, else ~/.local/share', () => {
    expect(opencodeAuthPath({ XDG_DATA_HOME: '/xdg' }, '/home/u')).toBe(
      '/xdg/opencode/auth.json',
    );
    expect(opencodeAuthPath({}, '/home/u')).toBe('/home/u/.local/share/opencode/auth.json');
  });
});

describe('resolveOpencodeKey', () => {
  it('prefers OPENCODE_API_KEY over the auth file', async () => {
    writeAuth({ 'opencode-go': { key: 'file-key' } });
    expect(await resolveOpencodeKey(authPath, { OPENCODE_API_KEY: 'env-key' })).toBe('env-key');
  });

  it('reads the opencode-go entry, then the opencode entry', async () => {
    writeAuth({ 'opencode-go': { key: 'go-key' }, opencode: { key: 'plain-key' } });
    expect(await resolveOpencodeKey(authPath, {})).toBe('go-key');
    writeAuth({ opencode: { key: 'plain-key' } });
    expect(await resolveOpencodeKey(authPath, {})).toBe('plain-key');
  });

  it('returns null for a missing, unparseable or keyless auth file', async () => {
    expect(await resolveOpencodeKey(join(home, 'missing.json'), {})).toBeNull();
    writeFileSync(authPath, 'not json');
    expect(await resolveOpencodeKey(authPath, {})).toBeNull();
    writeAuth({ 'opencode-go': { type: 'oauth' } });
    expect(await resolveOpencodeKey(authPath, {})).toBeNull();
    writeAuth({});
    expect(await resolveOpencodeKey(authPath, {})).toBeNull();
  });
});

describe('parseOpencodeUsage', () => {
  it('maps rolling/weekly/monthly with the live labels and percents', () => {
    expect(parseOpencodeUsage(LIVE_USAGE)).toEqual(OK_WINDOWS);
  });

  it('accepts a bare object without the usage wrapper', () => {
    expect(parseOpencodeUsage(LIVE_USAGE.usage)).toEqual(OK_WINDOWS);
  });

  it('yields two windows when monthly is absent', () => {
    expect(parseOpencodeUsage({ usage: { rolling: LIVE_USAGE.usage.rolling, weekly: LIVE_USAGE.usage.weekly } }))
      .toHaveLength(2);
  });

  it('clamps percent to 0..100', () => {
    expect(parseOpencodeUsage({ rolling: { percent: 140 }, weekly: { percent: -5 } })).toEqual([
      { label: '5-hour', usedPct: 100, resetsAt: null },
      { label: 'Weekly', usedPct: 0, resetsAt: null },
    ]);
  });

  it('accepts ISO and epoch-second resets, and resets_at as well as resetsAt', () => {
    expect(
      parseOpencodeUsage({
        rolling: { percent: 1, resetsAt: '2026-10-21T01:15:02.000Z' },
        weekly: { percent: 2, resetsAt: 1794000000 },
        monthly: { percent: 3, resets_at: 1794000001 },
      }),
    ).toEqual([
      { label: '5-hour', usedPct: 1, resetsAt: '2026-10-21T01:15:02.000Z' },
      { label: 'Weekly', usedPct: 2, resetsAt: new Date(1794000000 * 1000).toISOString() },
      { label: 'Monthly', usedPct: 3, resetsAt: new Date(1794000001 * 1000).toISOString() },
    ]);
  });

  it('drops an unusable window and rejects non-objects', () => {
    expect(parseOpencodeUsage({ rolling: { percent: 'x' }, weekly: { percent: 4 } })).toEqual([
      { label: 'Weekly', usedPct: 4, resetsAt: null },
    ]);
    expect(parseOpencodeUsage(null)).toEqual([]);
    expect(parseOpencodeUsage([])).toEqual([]);
  });
});

describe('serverErrorMessage', () => {
  it('reads a capped error.message from a JSON body', () => {
    const long = 'x'.repeat(300);
    const message = serverErrorMessage(JSON.stringify({ error: { message: long } }));
    expect(message).toBe('x'.repeat(200));
    expect(serverErrorMessage(JSON.stringify({ message: ' plain ' }))).toBe('plain');
  });

  it('returns null for a non-JSON body or a missing message', () => {
    expect(serverErrorMessage('not json')).toBeNull();
    expect(serverErrorMessage(JSON.stringify({ error: { code: 'api_key_expired' } }))).toBeNull();
    expect(serverErrorMessage(JSON.stringify({ error: { message: '  ' } }))).toBeNull();
  });
});

describe('readOpencodeQuota', () => {
  it('reports the live 200 payload with provenance and readAt = now', async () => {
    const fetchImpl = okFetch();
    const snap = await readOpencodeQuota(deps({ fetchImpl }));
    expect(snap).toEqual({
      core: 'opencode',
      state: 'ok',
      windows: OK_WINDOWS,
      source: 'OpenCode Go usage API',
      readAt: NOW.toISOString(),
    });
  });

  it('serves opencode2 through the same factory and reads its injected auth path', async () => {
    const fetchImpl = okFetch();
    const reader = opencodeQuotaReader(deps({ core: 'opencode2', fetchImpl }));
    expect(reader.core).toBe('opencode2');
    await expect(reader.read()).resolves.toMatchObject({ core: 'opencode2', state: 'ok' });
  });

  it('sends Accept, a Bearer key, redirect:error and a timeout signal — once', async () => {
    const fetchImpl = okFetch();
    await readOpencodeQuota(deps({ fetchImpl }));
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: 'Bearer go-key' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses OPENCODE_API_KEY when the auth file has none, without reading it', async () => {
    const fetchImpl = okFetch();
    const snap = await readOpencodeQuota(
      deps({ authPath: join(home, 'missing.json'), env: { OPENCODE_API_KEY: 'env-key' }, fetchImpl }),
    );
    expect(snap.state).toBe('ok');
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(init.headers.Authorization).toBe('Bearer env-key');
  });

  it('reports unknown with the auth path when there is no key, without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const snap = await readOpencodeQuota(
      deps({ authPath: join(home, 'missing.json'), fetchImpl }),
    );
    expect(snap).toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: `no OpenCode Go key in ${join(home, 'missing.json')}`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('explains a rejected key (401) and caps the server message', async () => {
    const message = 'x'.repeat(300);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { type: 'authentication_error', code: 'api_key_expired', message } }, 401),
    ) as unknown as typeof fetch;
    const snap = await readOpencodeQuota(deps({ fetchImpl }));
    expect(snap.state).toBe('unknown');
    const reason = snap.state === 'unknown' ? snap.reason : '';
    expect(reason).toContain('OpenCode Go key rejected — create a new key in OpenCode Console');
    expect(reason).toContain('x'.repeat(200));
    expect(reason).not.toContain('x'.repeat(201));
    expect(reason).not.toContain('go-key');
  });

  it('explains a rejected key on 403 too', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'forbidden' } }, 403),
    ) as unknown as typeof fetch;
    const snap = await readOpencodeQuota(deps({ fetchImpl }));
    expect(snap).toEqual({
      core: 'opencode',
      state: 'unknown',
      reason:
        'OpenCode Go key rejected — create a new key in OpenCode Console (forbidden)',
    });
  });

  it('says the account has no Go plan on 404', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;
    await expect(readOpencodeQuota(deps({ fetchImpl }))).resolves.toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: 'this OpenCode account has no Go plan',
    });
  });

  it('reports a network failure as a usage request failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(readOpencodeQuota(deps({ fetchImpl }))).resolves.toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: 'usage request failed: ECONNREFUSED',
    });
  });

  it('reports a timeout as a usage request failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const snap = await readOpencodeQuota(deps({ fetchImpl }));
    expect(snap).toMatchObject({ state: 'unknown' });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/usage request failed: .*timeout/);
  });

  it('reports invalid JSON and other HTTP failures without retrying', async () => {
    const badJson = vi.fn(async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch;
    await expect(readOpencodeQuota(deps({ fetchImpl: badJson }))).resolves.toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: 'usage request failed: invalid JSON response',
    });
    const serverError = vi.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    await expect(readOpencodeQuota(deps({ fetchImpl: serverError }))).resolves.toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: 'usage request failed: HTTP 500',
    });
    expect(serverError).toHaveBeenCalledTimes(1);
  });

  it('reports an empty-but-valid payload as no usable window', async () => {
    const fetchImpl = okFetch({});
    await expect(readOpencodeQuota(deps({ fetchImpl }))).resolves.toEqual({
      core: 'opencode',
      state: 'unknown',
      reason: 'the usage response carried no usable window',
    });
  });
});
