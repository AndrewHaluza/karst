/** Test support: run a raw manifest through the validator and through the section schemas. */

import { ManifestError } from '../../../manifest/error.js';
import { validateManifest } from '../../../manifest/schema.js';
import { validateManifestSections } from '../index.js';

/** The validator's refusal message, or `null` when it accepts. */
export function validatorError(raw: unknown): string | null {
  try {
    validateManifest(raw);
    return null;
  } catch (e) {
    if (e instanceof ManifestError) return e.message;
    throw e;
  }
}

/** The first section schema's refusal (`section: error`), or `null` when every schema accepts. */
export function schemaError(raw: unknown): string | null {
  const found = validateManifestSections(raw);
  return found === null ? null : `${found.section}: ${found.error}`;
}
