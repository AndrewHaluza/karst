/**
 * The k-tooltip delegate now lives in `src/ui/shared/kTooltip.ts` (T1396) because the sidebar mounts it too.
 * Dashboard imports and `kTooltip.test.ts` keep this path.
 */
export { TOOLTIP_ID, installTooltip } from '../../shared/kTooltip.js';
