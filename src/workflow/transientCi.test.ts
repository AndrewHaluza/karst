import { describe, expect, it } from 'vitest';
import { classifyTransientLog, MAX_CI_LOG_CHARS, parseCheckUrl, TRANSIENT_CI_PATTERNS } from './transientCi.js';

const ts = '2026-11-08T10:00:00.1234567Z ';

/** One positive step-level line per pattern id. */
const POSITIVE: Record<string, string> = {
  'http-5xx-response': '##[error]Unable to download and extract CodeQL CLI: Unexpected HTTP response: 504',
  'http-5xx-status': 'npm error HTTP status code: 502',
  'request-timed-out': 'prebuild-install warn install Request timed out',
  etimedout: 'npm ERR! code ETIMEDOUT',
  econnreset: 'npm error code ECONNRESET',
  eai_again: 'npm error code EAI_AGAIN',
  'socket-hang-up': 'npm ERR! network request to https://registry.npmjs.org/x failed, reason: socket hang up',
  'codeql-download': '##[error]Failed to download and extract CodeQL bundle',
  'dns-temporary-failure': "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/x.deb  Temporary failure resolving 'azure.archive.ubuntu.com'",
  'dns-could-not-resolve-host': 'curl: (6) Could not resolve host: github.com',
  'runner-shutdown': '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.',
};

describe('TRANSIENT_CI_PATTERNS', () => {
  it('has one positive case for every pattern', () => {
    expect(Object.keys(POSITIVE).sort()).toEqual(TRANSIENT_CI_PATTERNS.map((p) => p.id).sort());
  });

  it.each(Object.entries(POSITIVE))('matches %s on a step-level line', (id, line) => {
    expect(classifyTransientLog(`${ts}${line}\n`)).toBe(id);
  });

  it.each(Object.entries(POSITIVE))('does not match %s inside test output', (_id, line) => {
    // Same text, but as a plain test-output line (no runner or tool prefix).
    const plain = line.replace(/^(##\[error\]|E: |curl: |npm ERR! |npm error |prebuild-install warn install )/, '');
    expect(classifyTransientLog(`${ts}  ✗ api client: ${plain}\n${ts}FAIL src/api.test.ts\n`)).toBeNull();
  });
});

describe('classifyTransientLog', () => {
  const aptLine = "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/x.deb  Temporary failure resolving 'azure.archive.ubuntu.com'";
  it('reads the apt DNS fault of 2026-11-11 as transient, with and without the runner timestamp', () => {
    const tail = ['Failed to install browsers', 'Error: Installation process exited with code: 100'];
    expect(classifyTransientLog([aptLine, ...tail].join('\n'))).toBe('dns-temporary-failure');
    expect(classifyTransientLog([`${ts}${aptLine}`, ...tail.map((l) => ts + l)].join('\n'))).toBe('dns-temporary-failure');
  });

  it('is not transient for an apt E: line with no network text', () => {
    expect(classifyTransientLog(`${ts}E: Unable to locate package foo\n`)).toBeNull();
  });

  it('is not transient for an indented apt continuation line without a prefix', () => {
    expect(classifyTransientLog(`${ts}  Temporary failure resolving 'azure.archive.ubuntu.com'\n`)).toBeNull();
  });

  it('is not transient for a real test failure that prints "timed out"', () => {
    const log = [
      `${ts}FAIL src/net.test.ts > fetch retries`,
      `${ts}AssertionError: Request timed out after 5000ms (expected 200)`,
      `${ts}  Test timed out in 5000ms`,
      `${ts}##[error]Process completed with exit code 1.`,
    ].join('\n');
    expect(classifyTransientLog(log)).toBeNull();
  });

  it('is not transient for an empty or unrelated log', () => {
    expect(classifyTransientLog('')).toBeNull();
    expect(classifyTransientLog(`${ts}##[error]Process completed with exit code 1.\n`)).toBeNull();
  });

  it('reads the real prebuild log of T1013 as transient', () => {
    const log = `${ts}prebuild-install warn install Request timed out\n${ts}gyp ERR! not found: make\n`;
    expect(classifyTransientLog(log)).toBe('request-timed-out');
  });

  it('matches only an HTTP 5xx, not a 4xx', () => {
    expect(classifyTransientLog(`${ts}##[error]Unexpected HTTP response: 404\n`)).toBeNull();
  });

  it('reads only the tail of a log longer than the bound', () => {
    const filler = `${ts}plain line\n`.repeat(Math.ceil(MAX_CI_LOG_CHARS / 20));
    expect(classifyTransientLog(`${ts}##[error]socket hang up\n${filler}`)).toBeNull();
    expect(classifyTransientLog(`${filler}${ts}##[error]socket hang up\n`)).toBe('socket-hang-up');
  });
});

describe('parseCheckUrl', () => {
  it('reads owner, repo, run and job from a job url', () => {
    expect(parseCheckUrl('https://github.com/acme/app/actions/runs/42471424175/job/123456')).toEqual({
      owner: 'acme', repo: 'app', runId: '42471424175', jobId: '123456',
    });
  });

  it.each([
    null,
    '',
    'https://example.com/acme/app/actions/runs/1/job/2',
    'https://github.com/acme/app/actions/runs/1',
    'https://github.com/acme/app/runs/55',
    'https://github.com/acme/app/actions/runs/1/job/x; rm',
  ])('refuses %s', (url) => {
    expect(parseCheckUrl(url)).toBeNull();
  });
});

describe('classifyTransientLog size bound', () => {
  const line = '##[error]socket hang up\n';
  it('reads a log of exactly the limit in full', () => {
    const log = line + 'x'.repeat(MAX_CI_LOG_CHARS - line.length);
    expect(log.length).toBe(MAX_CI_LOG_CHARS);
    expect(classifyTransientLog(log)).toBe('socket-hang-up');
  });
  it('drops the head of a log that is one character over the limit', () => {
    const log = line + 'x'.repeat(MAX_CI_LOG_CHARS - line.length + 1);
    expect(classifyTransientLog(log)).toBeNull();
  });
});
