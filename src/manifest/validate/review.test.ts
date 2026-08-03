import { describe, it, expect } from 'vitest';
import { validateReview } from './review.js';

describe('validateReview', () => {
  it('returns undefined for an absent block', () => {
    expect(validateReview(undefined, [])).toBeUndefined();
  });

  it('defaults every field, including the findings lane ON at high severity', () => {
    expect(validateReview({}, [])).toEqual({
      maxFixAttempts: 3,
      requireIndependentSignal: true,
      findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      repositories: {},
    });
  });

  it('parses a script gate and a shell-free command gate', () => {
    const config = validateReview(
      {
        gates: [
          { name: 'lint', kind: 'script', script: 'lint' },
          { name: 'govet', kind: 'command', command: 'go', args: ['vet', './...'], repo: 'api' },
        ],
      },
      ['api'],
    );
    expect(config?.gates).toEqual([
      { name: 'lint', kind: 'script', script: 'lint' },
      { name: 'govet', kind: 'command', command: 'go', args: ['vet', './...'], repo: 'api' },
    ]);
  });

  it('refuses a script gate with no script and a command gate with no command', () => {
    expect(() => validateReview({ gates: [{ name: 'x', kind: 'script' }] }, [])).toThrow(/script/);
    expect(() => validateReview({ gates: [{ name: 'x', kind: 'command' }] }, [])).toThrow(/command/);
  });

  // The field named in the message is what makes this validation useful — an
  // author editing `review.gates[0]` must not be told about `uat.gates`.
  it('refuses a gate kind it does not know, naming the review field', () => {
    expect(() =>
      validateReview({ gates: [{ name: 'x', kind: 'shell', command: 'sh' }] }, []),
    ).toThrow(/review.gates "x".kind must be one of: script, command/);
  });

  it('refuses review.gates when it is not a list', () => {
    expect(() => validateReview({ gates: { name: 'x' } }, [])).toThrow(/review.gates must be a list/);
  });

  it('refuses a non-positive maxFixAttempts', () => {
    expect(() => validateReview({ maxFixAttempts: 0 }, [])).toThrow(/review.maxFixAttempts/);
    expect(() => validateReview({ maxFixAttempts: 1.5 }, [])).toThrow(/review.maxFixAttempts/);
  });

  it('refuses a non-boolean requireIndependentSignal', () => {
    expect(() => validateReview({ requireIndependentSignal: 'yes' }, [])).toThrow(
      /review.requireIndependentSignal must be a boolean/,
    );
  });

  it('accepts requireIndependentSignal: false as the configured escape hatch', () => {
    expect(validateReview({ requireIndependentSignal: false }, [])?.requireIndependentSignal).toBe(
      false,
    );
  });

  it('never carries an approval key — human approval in review was dropped entirely', () => {
    const config = validateReview({ approval: 'human' }, []) as unknown as Record<string, unknown>;
    expect(config.approval).toBeUndefined();
  });

  describe('review.repositories', () => {
    it('parses per-repository gate overrides for a declared repository', () => {
      const config = validateReview(
        { repositories: { web: { gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }] } } },
        ['web'],
      );
      expect(config?.repositories).toEqual({
        web: { gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }] },
      });
    });

    // Unlike `uat.repositories` (which accepts any key), review's IS
    // cross-checked against the manifest's own declared repositories — an
    // unknown name is a typo the author should hear about at load time.
    it('refuses a repository name that is not declared in the manifest', () => {
      expect(() =>
        validateReview({ repositories: { app: { gates: [] } } }, ['web', 'api']),
      ).toThrow(/review.repositories "app" is not a declared repository/);
    });

    it('refuses review.repositories when it is not a mapping', () => {
      expect(() => validateReview({ repositories: ['web'] }, ['web'])).toThrow(
        /review.repositories must be a mapping/,
      );
    });
  });

  describe('review.findings', () => {
    it('refuses a non-mapping findings block', () => {
      expect(() => validateReview({ findings: 'on' }, [])).toThrow(/review.findings must be a mapping/);
    });

    it('refuses an unknown blockingSeverity', () => {
      expect(() => validateReview({ findings: { blockingSeverity: 'urgent' } }, [])).toThrow(
        /review.findings.blockingSeverity must be one of: critical, high, medium, low, info, none/,
      );
    });

    it('accepts every closed severity plus none', () => {
      for (const sev of ['critical', 'high', 'medium', 'low', 'info', 'none']) {
        expect(validateReview({ findings: { blockingSeverity: sev } }, [])?.findings.blockingSeverity).toBe(
          sev,
        );
      }
    });

    it('refuses a non-positive maxFindings', () => {
      expect(() => validateReview({ findings: { maxFindings: 0 } }, [])).toThrow(
        /review.findings.maxFindings/,
      );
    });

    // `findings.agent` was dead configuration — nothing in the findings lane
    // ever read it (the lane's adapter is resolved the same way as every
    // other AI call site, not from this key). Deleted rather than validated:
    // an unknown key is silently ignored, same as any other manifest surface
    // that has not declared it, and setting it does nothing rather than
    // throwing.
    it('ignores a findings.agent key rather than reading it into config', () => {
      const config = validateReview({ findings: { enabled: false, agent: 'reviewer' } }, []);
      expect(config?.findings).toEqual({
        enabled: false,
        blockingSeverity: 'high',
        maxFindings: 50,
      });
      expect(config?.findings).not.toHaveProperty('agent');
    });
  });
});
