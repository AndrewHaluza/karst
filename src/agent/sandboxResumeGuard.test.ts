import { describe, expect, it } from 'vitest';
import { assertNoSandboxResumeOnHost, SandboxResumeOnHostError } from './sandboxResumeGuard.js';

describe('assertNoSandboxResumeOnHost', () => {
  const base = { ticketId: 7, resume: 'ses_1', runner: 'host' as const, hasSandbox: true };
  it('refuses a host resume of a ticket that has a sandbox', () => {
    expect(() => assertNoSandboxResumeOnHost(base)).toThrow(SandboxResumeOnHostError);
  });
  it.each([
    ['a fresh session', { resume: undefined }],
    ['a sandbox runner', { runner: 'docker' as const }],
    ['a ticket with no sandbox', { hasSandbox: false }],
  ])('allows %s', (_name, over) => {
    expect(() => assertNoSandboxResumeOnHost({ ...base, ...over })).not.toThrow();
  });
});
