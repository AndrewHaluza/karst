import { describe, expect, it } from 'vitest';
import { blockedHostsFromOutput, blockedSuffix, failedTail, npmDebugLogPath, quoteLine, SETUP_FAILED_LOG_LINES } from './sandboxSetupDiagnose.js';

/** The shape of the real failure: a native build behind the proxy, npm's trailer last. */
const B4 = [
  'npm warn deprecated inflight@1.0.6: leaks memory',
  'gyp http GET https://nodejs.org/download/release/v20.11.0/node-v20.11.0-headers.tar.gz',
  'gyp WARN download NOT FOUND',
  'gyp ERR! configure error',
  'gyp ERR! stack Error: Request was cancelled',
  'gyp ERR! stack     at ClientRequest.<anonymous> (/usr/lib/node_modules/npm/node_modules/node-gyp/lib/download.js:20:9)',
  'gyp ERR! System Linux 6.5.0',
  'npm error code 1',
  'npm error path /clone/node_modules/better-sqlite3',
  'npm error command failed',
  'npm error command sh -c prebuild-install || node-gyp rebuild',
  'npm error A complete log of this run can be found in: /home/node/.npm/_logs/2026-10-23T10_00_00_000Z-debug-0.log',
].join('\n');

describe('quoteLine', () => {
  it('skips the npm trailer and quotes the gyp stack error', () => {
    expect(quoteLine(B4)).toBe('gyp ERR! stack Error: Request was cancelled');
  });

  it('prefers an Error: line that carries a message over a bare one', () => {
    expect(quoteLine('npm error Error:\nnpm error Error: ENOSPC: no space left\nnpm error code 1')).toBe('npm error Error: ENOSPC: no space left');
  });

  it('without an Error: line quotes the first non-boilerplate npm error line', () => {
    const body = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope\nnpm error 404 more\nnpm error A complete log of this run can be found in: /x/.npm/_logs/a.log';
    expect(quoteLine(body)).toBe('npm error 404 Not Found - GET https://registry.npmjs.org/nope');
  });

  it('drops a trailer-only npm error body', () => {
    expect(quoteLine('npm error code 1\nnpm error path /x\nnpm error A complete log of this run can be found in: /x.log')).toBe('');
  });

  it('falls back to the last non-warning line, and drops warnings-only output', () => {
    expect(quoteLine('npm warn a\nsomething broke\nlast line')).toBe('last line');
    expect(quoteLine('npm warn deprecated x\nnpm warn deprecated y')).toBe('');
  });
});

describe('blockedHostsFromOutput', () => {
  it('keeps the DNS patterns', () => {
    expect(blockedHostsFromOutput('npm ERR! code ENOTFOUND evil.example.com')).toEqual(['evil.example.com']);
    expect(blockedHostsFromOutput('getaddrinfo EAI_AGAIN registry.npmjs.org')).toEqual(['registry.npmjs.org']);
  });

  it('names the host of the nearest preceding URL for a cancelled request', () => {
    expect(blockedHostsFromOutput(B4)).toEqual(['nodejs.org']);
  });

  it('reads tunnel 403 failures', () => {
    const out = 'prebuild-install info begin Prebuild-install version 7.1.1\nprebuild-install http request GET https://github.com/x/releases/download/v1/p.tar.gz\nprebuild-install ERR! tunneling socket could not be established, statusCode=403';
    expect(blockedHostsFromOutput(out)).toEqual(['github.com']);
    expect(blockedHostsFromOutput('GET https://release-assets.githubusercontent.com/a\nCONNECT tunnel failed, response 403')).toEqual(['release-assets.githubusercontent.com']);
    expect(blockedHostsFromOutput('GET https://objects.githubusercontent.com/a\nProxy error: 403 Forbidden')).toEqual(['objects.githubusercontent.com']);
    expect(blockedHostsFromOutput('GET https://nodejs.org/a\ncode: UND_ERR_SOCKET')).toEqual(['nodejs.org']);
  });

  it('lists every distinct host once, at most five', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'a'].flatMap((h) => [`GET https://${h}.example.com/x`, 'statusCode=403']);
    expect(blockedHostsFromOutput(lines.join('\n'))).toEqual(['a', 'b', 'c', 'd', 'e'].map((h) => `${h}.example.com`));
  });

  it('is empty for ordinary failures and ignores a successful fetch', () => {
    expect(blockedHostsFromOutput('npm error code 1\nsh: 1: tsc: not found')).toEqual([]);
    expect(blockedHostsFromOutput('npm http fetch GET 200 https://registry.npmjs.org/x 12ms\nnpm error build failed with statusCode=403')).toEqual([]);
  });
});

describe('blockedSuffix', () => {
  it('merges proxy-denied and output hosts, drops open ones, caps at five', () => {
    expect(blockedSuffix(['nodejs.org', 'a.io'], ['nodejs.org', 'b.io'], [])).toBe(', blocked host(s) nodejs.org, a.io, b.io (add to sandbox.setupHosts)');
    expect(blockedSuffix(['registry.npmjs.org', 'x.github.com', 'y.io'], [], ['registry.npmjs.org', '*.github.com'])).toBe(', blocked host(s) y.io (add to sandbox.setupHosts)');
    expect(blockedSuffix(['1', '2', '3', '4', '5', '6', '7'].map((h) => `${h}.io`), [], [])).toContain('5.io (add');
    expect(blockedSuffix(['1', '2', '3', '4', '5', '6', '7'].map((h) => `${h}.io`), [], [])).not.toContain('6.io');
  });

  it('is empty when nothing is blocked', () => {
    expect(blockedSuffix([], [], [])).toBe('');
    expect(blockedSuffix(['a.io'], [], ['a.io'])).toBe('');
  });
});

describe('npmDebugLogPath', () => {
  it('finds the sandbox-side npm debug log', () => {
    expect(npmDebugLogPath(B4)).toBe('/home/node/.npm/_logs/2026-10-23T10_00_00_000Z-debug-0.log');
    expect(npmDebugLogPath('nothing here')).toBeUndefined();
  });
});

describe('failedTail', () => {
  it('keeps the last lines without silly / http fetch noise', () => {
    const body = ['npm silly a', 'npm http fetch GET 200 https://r/x', 'gyp ERR! stack Error: boom', '', 'npm error code 1'].join('\n');
    expect(failedTail(body)).toBe('gyp ERR! stack Error: boom\nnpm error code 1');
    const many = Array.from({ length: SETUP_FAILED_LOG_LINES + 30 }, (_, i) => `line ${i}`).join('\n');
    expect(failedTail(many).split('\n')).toHaveLength(SETUP_FAILED_LOG_LINES);
  });
});
