import { describe, it, expect } from 'vitest';
import {
  PROCESS_KEYS,
  PROCESS_ROLES,
  validateProcessAssignments,
} from './processAssignments.js';
import type { AgentDef } from '../types.js';

const AGENTS: Record<string, AgentDef> = {
  'uat-author': { role: 'uat' },
  reviewer: { role: 'review' },
};

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
      AGENTS,
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
    const result = validateProcessAssignments({ uatFix: {} }, AGENTS);
    expect(result?.uatFix).toEqual({ enabled: true });
  });

  it('returns undefined when the block is absent', () => {
    expect(validateProcessAssignments(undefined, AGENTS)).toBeUndefined();
  });

  it('rejects a non-mapping processes block', () => {
    expect(() => validateProcessAssignments([], AGENTS)).toThrow('processes must be a mapping');
  });

  it('rejects an unknown process key, naming it and the closed vocabulary', () => {
    expect(() => validateProcessAssignments({ wibble: {} }, AGENTS)).toThrow(
      /processes "wibble" is not a known inside process.*uatTester.*uatFix.*review.*reviewFix.*prDescription.*ticketAnalysis/,
    );
  });

  it('rejects a malformed assignment (non-mapping)', () => {
    expect(() => validateProcessAssignments({ uatTester: 'codex' }, AGENTS)).toThrow(
      'processes.uatTester must be a mapping',
    );
  });

  it('rejects an unknown provider, naming the field and the closed list', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { provider: 'copilot' } }, AGENTS),
    ).toThrow(/processes\.uatTester\.provider must be one of: claude, codex, antigravity, opencode/);
  });

  it('rejects an undeclared agent reference, naming agent and field', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { agent: 'no-such-agent' } }, AGENTS),
    ).toThrow(/processes\.uatTester\.agent references undeclared agent "no-such-agent"/);
  });

  it('rejects a non-string agentName', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { agentName: 42 } }, AGENTS),
    ).toThrow('processes.uatTester.agentName must be a string');
  });

  it('rejects a non-string model', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { model: ['sol'] } }, AGENTS),
    ).toThrow('processes.uatTester.model must be a string');
  });

  it('rejects a non-boolean enabled', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { enabled: 'yes' } }, AGENTS),
    ).toThrow('processes.uatTester.enabled must be a boolean');
  });

  it('normalizes a blank agentName to unset rather than rejecting it', () => {
    const result = validateProcessAssignments({ uatTester: { agentName: '  ' } }, AGENTS);
    expect(result?.uatTester).toEqual({ enabled: true });
  });

  it('normalizes a blank model to unset, like defaultModel', () => {
    const result = validateProcessAssignments({ uatTester: { model: '' } }, AGENTS);
    expect(result?.uatTester).toEqual({ enabled: true });
  });

  it('accepts an agent declared in the agents block', () => {
    const result = validateProcessAssignments({ reviewFix: { agent: 'reviewer' } }, AGENTS);
    expect(result?.reviewFix?.agent).toBe('reviewer');
  });

  it('exposes the six closed vocabulary keys and their kebab roles in one place', () => {
    expect(PROCESS_KEYS).toEqual(['uatTester', 'uatFix', 'review', 'reviewFix', 'prDescription', 'ticketAnalysis']);
    expect(PROCESS_ROLES).toEqual(['uat-tester', 'uat-fix', 'review', 'review-fix', 'pr-description', 'ticket-analysis']);
  });
});
