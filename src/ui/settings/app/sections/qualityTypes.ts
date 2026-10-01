/**
 * `Severity | 'none'` — the vocabulary a `blockingSeverity` control offers.
 *
 * `manifest/types.ts` names the two halves (`Severity`, and `'none'` appearing
 * inline in `UatTesterObservationsConfig` / `ReviewFindingsConfig`). This alias
 * exists so a section does not restate that union at every use site, which is
 * the mirroring R-X1 forbids.
 */
import type { Severity } from '../../../../manifest/types.js';

export type BlockingSeverity = Severity | 'none';
