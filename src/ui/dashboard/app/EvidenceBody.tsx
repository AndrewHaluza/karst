/**
 * Kind to body. The closed `ProcessEvidenceView` union is dispatched here, one body per kind. An unknown kind (a
 * future host, an older snapshot) falls back to the generic rows body: forward compatibility, never a throw.
 */
import type { InsideProcessView, ProcessEvidenceView } from '../../../model/inside/types.js';
import { EvidenceReceipt } from './EvidenceReceipt.js';
import { EvidenceFindings, EvidenceGates, EvidenceRecovery, EvidenceRows } from './EvidenceRows.js';
import { EvidenceCommits, EvidencePrs } from './EvidenceShip.js';
import { EvidenceTimeline } from './EvidenceTimeline.js';

export function EvidenceBody({ ev, p, stageKey }: { readonly ev: ProcessEvidenceView; readonly p: InsideProcessView; readonly stageKey: string }) {
  switch (ev.kind) {
    case 'gates':
      return <EvidenceGates ev={ev} />;
    case 'findings':
      return <EvidenceFindings ev={ev} p={p} stageKey={stageKey} />;
    case 'timeline':
      return <EvidenceTimeline rows={ev.rows} stage={stageKey} id={p.id} />;
    case 'commits':
      return <EvidenceCommits ev={ev} />;
    case 'prs':
      return <EvidencePrs ev={ev} />;
    case 'recovery':
      return <EvidenceRecovery ev={ev} />;
    case 'receipt':
      return <EvidenceReceipt ev={ev} />;
    default:
      return <EvidenceRows ev={ev} />;
  }
}
