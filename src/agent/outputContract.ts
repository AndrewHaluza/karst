/**
 * The machine-readable half of the shared output contract (Prompt 09).
 *
 * `promptText.ts`'s `OUTPUT_RULES_BASE` states the findings/output shape in
 * prose — a chat-tuned core is *asked* to conform and often does not, which is
 * why `review/findings.ts` carries the whole salvage ladder. Cores that expose a
 * native structured-output flag (`AdapterSurfaces.structuredOutput` supported:
 * claude `--json-schema`, codex `--output-schema`) let the CLI ENFORCE that same
 * shape, so the final message arrives as a clean JSON document the parser reads
 * at its cheapest tier instead of coercing one out of prose.
 *
 * This module is the machine counterpart of `OUTPUT_RULES_BASE`: it builds the
 * JSON Schema whose element shape must stay equal to what the prose describes.
 * `outputContract.test.ts` pins that equality, so a re-worded prose line and a
 * drifted schema cannot slip past each other. `OUTPUT_RULES_BASE` is NOT deleted
 * — it remains the fallback contract for cores that declare `structuredOutput`
 * unsupported (opencode `--format json`, agy `-p`), and the schema is passed
 * ONLY on cores that can enforce it (the lanes gate on the surface).
 *
 * Pure data — no store, no filesystem, no `vscode`. Host-agnostic.
 */

import type { JsonSchemaDocument } from './adapter.js';
import type { Severity } from '../manifest/types.js';

/** The closed severity vocabulary of a finding/observation element, in the
 *  canonical display order. This is the single source the JSON-Schema `enum`
 *  draws from; `outputContract.test.ts` pins it to the union listed in
 *  `OUTPUT_RULES_BASE`'s element line so prose and schema cannot drift. */
export const FINDING_SEVERITIES: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/**
 * The element schema for one finding/observation — the machine shape of the
 * `OUTPUT_RULES_BASE` element line: `{severity, title, detail, file?, line?}`.
 * `criterion` is added ONLY by the UAT-tester variant (Prompt 17) so a
 * structured Tester response can key each observation to the done-when
 * criterion it exercised; it is schema-only for now (dropped at parse — the
 * shared `uat_findings` row has no such column), not persisted.
 */
export function findingElementSchema(opts: { criterion?: boolean } = {}): JsonSchemaDocument {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['severity', 'title', 'detail'],
    properties: {
      severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
      title: { type: 'string', minLength: 1 },
      detail: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'integer', minimum: 1 },
      ...(opts.criterion ? { criterion: { type: 'string' } } : {}),
    },
  };
}

/** The review findings lane's output schema: a top-level JSON array of the
 *  base finding element, matching the `OUTPUT_RULES_BASE` "Output ONLY a JSON
 *  array" instruction and the bare-array shape `parseFindings` accepts. */
export const REVIEW_OUTPUT_SCHEMA: JsonSchemaDocument = {
  type: 'array',
  items: findingElementSchema(),
};

/** The UAT Tester's output schema: a top-level array of the finding element
 *  plus an optional `criterion` key, so a structured Tester response can carry
 *  which done-when criterion each observation exercised (Prompt 17). */
export const TESTER_OUTPUT_SCHEMA: JsonSchemaDocument = {
  type: 'array',
  items: findingElementSchema({ criterion: true }),
};