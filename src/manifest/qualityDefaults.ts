/**
 * Browser-safe home of the Quality tab's defaults and vocabularies.
 *
 * The Settings React app renders the same `uat` / `review` defaults the manifest
 * validator applies when a key is absent, and it cannot import from
 * `manifest/validate/review.ts` or `validate/uat.ts`: those reach the rest of the
 * validator tree, which pulls in js-yaml and the graph/graphConfig modules —
 * host-only and not bundleable into a webview asset. So the shared values live
 * here, dependency-free, and the validators import them — one definition, two
 * importers, and no mirrored literal in the webview (UI-R34 / NDL-126 R-X1,
 * "import, never mirror"). This is the same split `startDefaults.ts` and
 * `model/agentProviders.ts` make.
 *
 * The invariant this file protects is the one the Quality tab's SPREAD rule rests
 * on: what the host defaults is what the tab must show. A tab that showed `0`
 * where the validator fills `3` would offer an invalid draft on a clean manifest.
 *
 * This module must stay dependency-free: it is imported from the settings
 * bundle, so anything it pulls in ends up there too.
 */
import type { Severity } from './types.js';

/** Every severity the manifest vocabulary defines, in rank order. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * What a `blockingSeverity` select offers: the severities plus `none`, which
 * makes observations/findings ADVISORY rather than failing the stage.
 */
export const BLOCKING_SEVERITIES: readonly (Severity | 'none')[] = [...SEVERITIES, 'none'];

/** `uat.maxFixAttempts` when the manifest declares none. */
export const UAT_MAX_FIX_ATTEMPTS = 3;

/** `review.maxFixAttempts` when the manifest declares none. */
export const REVIEW_MAX_FIX_ATTEMPTS = 3;

/** `uat.testerObservations.blockingSeverity` when the block declares none. */
export const UAT_TESTER_BLOCKING_SEVERITY: Severity | 'none' = 'none';

/**
 * Default `review.findings` — the human-decided ON / `'high'` default.
 *
 * Deep-merged by the Quality tab's `updateFindings`, so editing one findings
 * field can never drop a sibling key that the tab does not render.
 */
export const REVIEW_FINDINGS_DEFAULTS: Readonly<{
  enabled: boolean;
  blockingSeverity: Severity | 'none';
  maxFindings: number;
}> = { enabled: true, blockingSeverity: 'high', maxFindings: 50 };

/** `review.requireIndependentSignal` when the manifest declares none. */
export const REVIEW_REQUIRE_INDEPENDENT_SIGNAL = true;

/** `review.openChanges` when the manifest declares none. */
export const REVIEW_OPEN_CHANGES = false;
