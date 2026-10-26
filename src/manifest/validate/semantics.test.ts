import { describe, it, expect } from 'vitest';
import { manifest, repo, uat, review } from '../fixtures.js';
import { ManifestError } from '../error.js';
import { assertReferencesResolve } from './semantics.js';

const gate = (over: Record<string, unknown> = {}) => ({
  name: 'g', kind: 'command' as const, command: 'npm', ...over,
});

describe('assertReferencesResolve', () => {
  it('accepts a manifest whose refs all resolve', () => {
    const m = manifest({ backend: repo() }, { review: review({ gates: [gate({ repo: 'backend' })] }) });
    expect(() => assertReferencesResolve(m, true)).not.toThrow();
  });

  it('refuses uat.repositories.frontend when no repository frontend exists', () => {
    const m = manifest({ backend: repo() }, { uat: uat({ repositories: { frontend: {} } }) });
    expect(() => assertReferencesResolve(m, false)).toThrow(ManifestError);
    expect(() => assertReferencesResolve(m, false)).toThrow(
      "uat.repositories.frontend: no repository 'frontend'",
    );
  });

  it('matches repository keys case-insensitively', () => {
    const m = manifest({ Frontend: repo() }, { uat: uat({ repositories: { frontend: {} } }) });
    expect(() => assertReferencesResolve(m, false)).not.toThrow();
  });

  it('refuses a uat gate repo: that names no repository', () => {
    const m = manifest({ backend: repo() }, { uat: uat({ gates: [gate({ repo: 'web' })] }) });
    expect(() => assertReferencesResolve(m, false)).toThrow("uat.gates[0].repo: no repository 'web'");
  });

  it('refuses a review gate repo: that names no repository', () => {
    const m = manifest({ backend: repo() }, { review: review({ gates: [gate({ repo: 'web' })] }) });
    expect(() => assertReferencesResolve(m, true)).toThrow("review.gates[0].repo: no repository 'web'");
  });

  it('refuses a per-repository gate repo: that names no repository', () => {
    const m = manifest(
      { backend: repo() },
      { review: review({ repositories: { backend: { gates: [gate({ repo: 'web' })] } } }) },
    );
    expect(() => assertReferencesResolve(m, true)).toThrow(
      "review.repositories.backend.gates[0].repo: no repository 'web'",
    );
  });

  it('refuses a uat.testerVerifier repo: that names no repository', () => {
    const m = manifest({ backend: repo() }, { uat: uat({ testerVerifier: gate({ repo: 'web' }) }) });
    expect(() => assertReferencesResolve(m, false)).toThrow("uat.testerVerifier.repo: no repository 'web'");
  });

  it('refuses requireIndependentSignal with review gates written as an empty list', () => {
    const m = manifest({ backend: repo() }, { review: review({ requireIndependentSignal: true }) });
    expect(() => assertReferencesResolve(m, true)).toThrow(/review\.gates: .*requireIndependentSignal/);
  });

  it('does not demand review gates when review.gates was not written', () => {
    const m = manifest({ backend: repo() }, { review: review({ requireIndependentSignal: true }) });
    expect(() => assertReferencesResolve(m, false)).not.toThrow();
  });

  it('accepts requireIndependentSignal when only a per-repository override declares gates', () => {
    const m = manifest(
      { backend: repo() },
      { review: review({ repositories: { backend: { gates: [gate()] } } }) },
    );
    expect(() => assertReferencesResolve(m, true)).not.toThrow();
  });

  it('accepts empty review gates when requireIndependentSignal is false', () => {
    const m = manifest({ backend: repo() }, { review: review({ requireIndependentSignal: false }) });
    expect(() => assertReferencesResolve(m, true)).not.toThrow();
  });

  it('reports every problem in one message', () => {
    const m = manifest(
      { backend: repo() },
      { uat: uat({ repositories: { a: {}, b: {} } }) },
    );
    expect(() => assertReferencesResolve(m, false)).toThrow(/'a'[\s\S]*'b'/);
  });
});
