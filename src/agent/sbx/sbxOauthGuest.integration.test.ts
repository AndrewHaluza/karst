import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVAL_KEY_ENV, approvalExecArgs } from './sbxOauthGuest.js';

const KEY = 'k'.repeat(23) + 'ABCDEFGHIJKLMNOPQRST';

describe('the guest approval script', () => {
  it('writes the last 20 characters of the key into ~/.claude.json and keeps other settings', () => {
    const home = mkdtempSync(join(tmpdir(), 'karst-approval-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ theme: 'dark', customApiKeyResponses: { approved: ['old'], rejected: [KEY.slice(-20)] } }));
    const script = approvalExecArgs('sb').at(-1)!;
    execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home, [APPROVAL_KEY_ENV]: KEY } });
    const out = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(out.theme).toBe('dark');
    expect(out.customApiKeyResponses.approved).toEqual(['old', KEY.slice(-20)]);
    expect(out.customApiKeyResponses.rejected).toEqual([]);
  });

  it('creates ~/.claude.json when it is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'karst-approval-'));
    execFileSync('sh', ['-c', approvalExecArgs('sb').at(-1)!], { env: { ...process.env, HOME: home, [APPROVAL_KEY_ENV]: KEY } });
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).customApiKeyResponses.approved).toEqual([KEY.slice(-20)]);
  });
});
