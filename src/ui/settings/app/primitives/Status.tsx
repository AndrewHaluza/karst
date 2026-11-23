/**
 * Settings' status marker is the shared renderer now (SB-1). This re-export
 * keeps the Settings app's import path stable while the one implementation —
 * and the `.k-status` CSS it depends on — lives in `ui/shared/Status.tsx`.
 */
export { Status, type StatusKind, type StatusProps } from '../../../shared/Status.js';
