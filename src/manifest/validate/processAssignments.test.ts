import { describe, it, expect } from 'vitest';
import {
  PROCESS_KEYS,
  PROCESS_ROLES,
  validateProcessAssignments,
} from './processAssignments.js';

describe('validateProcessAssignments', () => {
  it('parses a valid processes block into the typed config', () => {
    const result = validateProcessAssignments(
      {
        uatTester: {
          agent: 'uat-author',
          agentName: 'My UAT Agent',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          enabled: false,
        },
        review: { provider: 'antigravity' },
        ticketAnalysis: { provider: 'opencode', model: 'gemini-2.5-pro' },
      },
    );
    expect(result).toEqual({
      uatTester: {
        agent: 'uat-author',
        agentName: 'My UAT Agent',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        enabled: false,
      },
      review: { provider: 'antigravity', enabled: true },
      ticketAnalysis: { provider: 'opencode', model: 'gemini-2.5-pro', enabled: true },
    });
  });

  it('defaults enabled to true like every other def block', () => {
    const result = validateProcessAssignments({ uatFix: {} });
    expect(result?.uatFix).toEqual({ enabled: true });
  });

  it('returns undefined when the block is absent', () => {
    expect(validateProcessAssignments(undefined)).toBeUndefined();
  });

  it('rejects a non-mapping processes block', () => {
    expect(() => validateProcessAssignments([])).toThrow('processes must be a mapping');
  });

  it('rejects an unknown process key, naming it and the closed vocabulary', () => {
    expect(() => validateProcessAssignments({ wibble: {} })).toThrow(
      /processes "wibble" is not a known inside process.*uatTester.*uatFix.*review.*reviewFix.*prDescription.*ticketAnalysis/,
    );
  });

  it('rejects a malformed assignment (non-mapping)', () => {
    expect(() => validateProcessAssignments({ uatTester: 'codex' })).toThrow(
      'processes.uatTester must be a mapping',
    );
  });

  it('rejects an unknown provider, naming the field and the closed list', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { provider: 'copilot' } }),
    ).toThrow(/processes\.uatTester\.provider must be one of: claude, codex, antigravity, opencode/);
  });

  it('accepts an agent reference not declared in the agents block (a pool/file agent)', () => {
    const result = validateProcessAssignments({ uatTester: { agent: 'no-such-agent' } });
    expect(result?.uatTester?.agent).toBe('no-such-agent');
  });

  it('rejects a non-string agentName', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { agentName: 42 } }),
    ).toThrow('processes.uatTester.agentName must be a string');
  });

  it('rejects a non-string model', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { model: ['sol'] } }),
    ).toThrow('processes.uatTester.model must be a string');
  });

  it('rejects a non-boolean enabled', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { enabled: 'yes' } }),
    ).toThrow('processes.uatTester.enabled must be a boolean');
  });

  it('normalizes a blank agentName to unset rather than rejecting it', () => {
    const result = validateProcessAssignments({ uatTester: { agentName: '  ' } });
    expect(result?.uatTester).toEqual({ enabled: true });
  });

  it('normalizes a blank model to unset, like defaultModel', () => {
    const result = validateProcessAssignments({ uatTester: { model: '' } });
    expect(result?.uatTester).toEqual({ enabled: true });
  });

  // RETIRED: the profile named by `agent` carries the prompt. A file that
  // still declares one must LOAD (nobody's config breaks on an upgrade) with
  // the value DROPPED — carrying it would give the manifest a second prompt
  // source able to outrank the profile shown in Settings.
  it('drops a legacy instructions value instead of failing the load', () => {
    const result = validateProcessAssignments({
      uatTester: { instructions: 'Focus on API endpoint behavior.', provider: 'codex' },
      review: { instructions: ['not even a string'] },
    });
    expect(result?.uatTester).toEqual({ provider: 'codex', enabled: true });
    expect(result?.review).toEqual({ enabled: true });
  });

  it('parses a plain agent reference verbatim (never guessed at)', () => {
    const result = validateProcessAssignments({ reviewFix: { agent: 'reviewer' } });
    expect(result?.reviewFix?.agent).toBe('reviewer');
  });

  it('exposes the six closed vocabulary keys and their kebab roles in one place', () => {
    expect(PROCESS_KEYS).toEqual(['uatTester', 'uatFix', 'review', 'reviewFix', 'prDescription', 'ticketAnalysis']);
    expect(PROCESS_ROLES).toEqual(['uat-tester', 'uat-fix', 'review', 'review-fix', 'pr-description', 'ticket-analysis']);
  });
});
