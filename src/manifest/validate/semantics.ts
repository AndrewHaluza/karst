import { ManifestError } from '../error.js';
import type { GateDef, Manifest } from '../types.js';

/** `where` is the field path; repo refs match repository keys case-insensitively (@arch:KEYCASE). */
function unknownRef(known: ReadonlySet<string>, ref: string | undefined, where: string): string[] {
  if (ref === undefined || known.has(ref.toLowerCase())) return [];
  return [`${where}: no repository '${ref}' — name a key under repositories`];
}

function gateRefs(known: ReadonlySet<string>, gates: GateDef[] | undefined, where: string): string[] {
  return (gates ?? []).flatMap((g, i) => unknownRef(known, g.repo, `${where}[${i}].repo`));
}

function hasReviewGates(review: NonNullable<Manifest['review']>): boolean {
  return (
    (review.gates ?? []).length > 0 ||
    Object.values(review.repositories).some((r) => (r.gates ?? []).length > 0)
  );
}

/**
 * Internal-reference checks the field-by-field validators cannot make: they see
 * one block at a time, so a gate or `uat.repositories` key naming a repository
 * that does not exist passed `validate` and failed later in UAT/review. Always
 * wrong, so an error — never an environment fact.
 *
 * `reviewGatesWrittenEmpty`: absent `review.gates` is legitimate (the default
 * pipeline probes package.json, which only the env warning can judge), so the
 * empty-gates ERROR applies to a manifest that wrote `gates: []` itself.
 */
export function assertReferencesResolve(manifest: Manifest, reviewGatesWrittenEmpty: boolean): void {
  const known = new Set(Object.keys(manifest.repositories).map((k) => k.toLowerCase()));
  const { uat, review } = manifest;
  const problems: string[] = [];

  if (uat) {
    for (const key of Object.keys(uat.repositories)) {
      problems.push(...unknownRef(known, key, `uat.repositories.${key}`));
    }
    problems.push(...gateRefs(known, uat.gates, 'uat.gates'));
    for (const [key, o] of Object.entries(uat.repositories)) {
      problems.push(...gateRefs(known, o.gates, `uat.repositories.${key}.gates`));
    }
    if (uat.testerVerifier) {
      problems.push(...unknownRef(known, uat.testerVerifier.repo, 'uat.testerVerifier.repo'));
    }
  }
  if (review) {
    problems.push(...gateRefs(known, review.gates, 'review.gates'));
    for (const [key, o] of Object.entries(review.repositories)) {
      problems.push(...gateRefs(known, o.gates, `review.repositories.${key}.gates`));
    }
    if (reviewGatesWrittenEmpty && review.requireIndependentSignal && !hasReviewGates(review)) {
      problems.push(
        'review.gates: empty while review.requireIndependentSignal is true — declare a review gate or set requireIndependentSignal: false',
      );
    }
  }

  if (problems.length > 0) throw new ManifestError(problems.join('; '));
}
