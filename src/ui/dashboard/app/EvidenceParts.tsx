/**
 * The parts every evidence body draws with. An evidence row's status is the GLYPH, not a word: the word repeated
 * what the row's own detail already said on every row of every expanded body. It survives as the glyph's accessible
 * name, so nothing that cannot see colour loses the status (UI-R28b).
 *
 * The glyph LEADS the row and the timing TRAILS it, in two separate cells: a verdict read after the prose is a
 * verdict read last. Both always emit exactly ONE grid item, empty when the row has no status, so a statusless row
 * keeps the grid's column alignment.
 */
import type { EvidenceRow } from '../../../model/inside/types.js';
import { InsideActionButton } from './InsideParts.js';
import { statusWord } from './insideText.js';

export function EvGlyph({ r }: { readonly r: Pick<EvidenceRow, 'status'> }) {
  return <span className="ev-glyph">{r.status ? <span className={`glyph ${r.status}`} role="img" aria-label={statusWord(r.status)} /> : null}</span>;
}

export function EvTiming({ r, cls }: { readonly r: EvidenceRow; readonly cls: string }) {
  // Two fixed columns, always both emitted (empty when absent), so every row of a level lines up (UI-R41).
  return (
    <span className={r.status ? `${cls} ${r.status}` : cls}>
      <span className="ev-time" title={r.status && r.time ? `started ${r.time}` : undefined}>
        {r.status ? r.time || null : null}
      </span>
      <span className="ev-dur" title={(r.status && [r.durationExact, r.time ? `started ${r.time}` : ''].filter(Boolean).join(' · ')) || undefined}>
        {r.status ? r.duration || null : null}
      </span>
    </span>
  );
}

export function EvAction({ r }: { readonly r: EvidenceRow }) {
  return <span className="ev-tail">{r.action ? <InsideActionButton action={r.action} /> : null}</span>;
}

/** The bounded remainder of a RICH body. The host owns both the count copy and the continuation's label; the webview counts nothing (UI-R31). */
export function Overflow({ o }: { readonly o: EvidenceRow | undefined }) {
  if (!o) return null;
  return (
    <div className="overflow-note">
      <span>{o.detail || o.label || ''}</span>
      {o.action ? <InsideActionButton action={o.action} /> : null}
    </div>
  );
}

/** The PR's state chip, shared by the merge rows and the delivery lines. */
export function PrState({ state }: { readonly state: string | undefined }) {
  return state ? <span className={`pr-status ${state}`}>{state}</span> : null;
}
